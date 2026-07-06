import { describe, expect, it } from 'vitest';
import {
  MintRejectedError,
  MintRelayError,
  MintUnavailableError,
  createOidcTokenHandler,
  requestMint,
} from './oidc-token-relay.js';

function stubClient(response: unknown) {
  return {
    sendRequestAndAwait: async () => response,
  } as unknown as Parameters<typeof requestMint>[0]['platformClient'];
}

describe('requestMint over WS', () => {
  const base = { orchestratorId: 'orch-1', runId: 'run-1', jobId: 'job-1', audience: 'sigstore' };

  it('returns the token on a result response', async () => {
    const client = stubClient({
      type: 'oidc.mint.response',
      requestId: 'x',
      result: { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' },
    });
    await expect(requestMint({ platformClient: client, ...base })).resolves.toEqual({
      token: 'eyJ.a.b',
      expiresIn: 600,
      jti: 'run-1:job-1',
    });
  });

  it('maps error.code=rejected to MintRejectedError', async () => {
    const client = stubClient({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'rejected', message: 'no such job' },
    });
    await expect(requestMint({ platformClient: client, ...base })).rejects.toBeInstanceOf(
      MintRejectedError,
    );
  });

  it('maps error.code=unavailable to MintUnavailableError with the stable message', async () => {
    const client = stubClient({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'unavailable', message: 'whatever the platform says' },
    });
    await expect(requestMint({ platformClient: client, ...base })).rejects.toThrow(
      'provenance signing is not configured on the Platform',
    );
  });

  it('maps error.code=failed to MintRelayError', async () => {
    const client = stubClient({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'failed', message: 'boom' },
    });
    await expect(requestMint({ platformClient: client, ...base })).rejects.toBeInstanceOf(
      MintRelayError,
    );
  });

  it('wraps a transport rejection (timeout/close) as MintRelayError', async () => {
    const client = {
      sendRequestAndAwait: async () => {
        throw new Error('platform connection closed');
      },
    } as unknown as Parameters<typeof requestMint>[0]['platformClient'];
    await expect(requestMint({ platformClient: client, ...base })).rejects.toBeInstanceOf(
      MintRelayError,
    );
  });
});

describe('createOidcTokenHandler', () => {
  const dispatcher = {
    resolveOwnedJob: (agentId: string, jobId: string) =>
      agentId === 'agent-1' && jobId === 'job-1' ? { runId: 'run-1' } : undefined,
  };

  function buildHandler(
    response: unknown,
    calls?: { count: number },
    extra?: { testMode?: boolean; testMintDeferAudience?: string },
  ) {
    const platformClient = {
      sendRequestAndAwait: async (_type: string, payload: Record<string, unknown>) => {
        if (calls) calls.count++;
        // Expose the relayed payload for ownership assertions.
        (buildHandler as unknown as { lastPayload?: unknown }).lastPayload = payload;
        return response;
      },
    } as unknown as OidcTokenHandlerClient;
    return createOidcTokenHandler({
      dispatcher,
      platformClient,
      orchestratorId: 'orch-1',
      testMode: extra?.testMode ?? false,
      testMintDeferAudience: extra?.testMintDeferAudience,
    });
  }

  it('mints for an owned job, supplying the dispatcher-resolved runId', async () => {
    const handler = buildHandler({
      type: 'oidc.mint.response',
      requestId: 'x',
      result: { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' },
    });
    const res = await handler('agent-1', { jobId: 'job-1', audience: 'sigstore' });
    expect(res).toEqual({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    expect(
      (buildHandler as unknown as { lastPayload?: { runId: string } }).lastPayload,
    ).toMatchObject({ runId: 'run-1', jobId: 'job-1', audience: 'sigstore' });
  });

  it('rejects a job the agent does not own without calling the Platform', async () => {
    const calls = { count: 0 };
    const handler = buildHandler({ type: 'oidc.mint.response', requestId: 'x' }, calls);
    await expect(handler('agent-1', { jobId: 'nope', audience: 'sigstore' })).rejects.toThrow(
      /not owned/i,
    );
    expect(calls.count).toBe(0);
  });

  it('rejects malformed params', async () => {
    const handler = buildHandler({ type: 'oidc.mint.response', requestId: 'x' });
    await expect(
      handler('agent-1', { audience: 'sigstore' } as Record<string, unknown>),
    ).rejects.toBeTruthy();
  });

  it('propagates a mint error as a clean typed error', async () => {
    const handler = buildHandler({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'rejected', message: 'job not active' },
    });
    await expect(
      handler('agent-1', { jobId: 'job-1', audience: 'sigstore' }),
    ).rejects.toBeInstanceOf(MintRejectedError);
  });

  it('defers (unavailable) instead of failing when the Platform signer is down', async () => {
    const handler = buildHandler({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'unavailable', message: 'oidc_not_configured' },
    });
    await expect(handler('agent-1', { jobId: 'job-1', audience: 'sigstore' })).resolves.toEqual({
      deferred: true,
      code: 'unavailable',
    });
  });

  it('defers (failed) on a transport / relay failure', async () => {
    const handler = buildHandler({
      type: 'oidc.mint.response',
      requestId: 'x',
      error: { code: 'failed', message: 'boom' },
    });
    await expect(handler('agent-1', { jobId: 'job-1', audience: 'sigstore' })).resolves.toEqual({
      deferred: true,
      code: 'failed',
    });
  });

  describe('mint-defer fault injection (test-only)', () => {
    it('force-defers the initial mint when test-mode + audience matches the marker', async () => {
      const calls = { count: 0 };
      // A result response would normally succeed; the injection must short-circuit
      // BEFORE the Platform relay, so the client is never called.
      const handler = buildHandler(
        {
          type: 'oidc.mint.response',
          requestId: 'x',
          result: { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' },
        },
        calls,
        { testMode: true, testMintDeferAudience: 'kici-provenance' },
      );
      const res = await handler('agent-1', { jobId: 'job-1', audience: 'kici-provenance' });
      expect(res).toEqual({ deferred: true, code: 'unavailable' });
      expect(calls.count).toBe(0);
    });

    it('does NOT defer when test-mode is off even if the marker env is set', async () => {
      const handler = buildHandler(
        {
          type: 'oidc.mint.response',
          requestId: 'x',
          result: { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' },
        },
        undefined,
        { testMode: false, testMintDeferAudience: 'kici-provenance' },
      );
      const res = await handler('agent-1', { jobId: 'job-1', audience: 'kici-provenance' });
      expect(res).toEqual({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    });

    it('does NOT defer a non-matching audience under test-mode', async () => {
      const handler = buildHandler(
        {
          type: 'oidc.mint.response',
          requestId: 'x',
          result: { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' },
        },
        undefined,
        { testMode: true, testMintDeferAudience: 'kici-provenance' },
      );
      const res = await handler('agent-1', { jobId: 'job-1', audience: 'sigstore' });
      expect(res).toEqual({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    });
  });
});

type OidcTokenHandlerClient = Parameters<typeof createOidcTokenHandler>[0]['platformClient'];
