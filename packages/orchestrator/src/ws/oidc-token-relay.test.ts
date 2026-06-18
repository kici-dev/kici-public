import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MintRejectedError,
  MintRelayError,
  MintUnavailableError,
  createOidcTokenHandler,
  deriveHttpBaseFromWsUrl,
  requestMint,
} from './oidc-token-relay.js';

describe('deriveHttpBaseFromWsUrl', () => {
  it('maps wss/ws and strips a trailing /ws', () => {
    expect(deriveHttpBaseFromWsUrl('wss://host.example/ws')).toBe('https://host.example');
    expect(deriveHttpBaseFromWsUrl('ws://host.example:3000/ws')).toBe('http://host.example:3000');
  });
  it('preserves a basePath before /ws', () => {
    expect(deriveHttpBaseFromWsUrl('wss://host.example/kici-stg/ws')).toBe(
      'https://host.example/kici-stg',
    );
  });
  it('handles a bare host with no /ws suffix', () => {
    expect(deriveHttpBaseFromWsUrl('wss://host.example')).toBe('https://host.example');
  });
});

describe('requestMint', () => {
  afterEach(() => vi.restoreAllMocks());

  const args = {
    httpBase: 'https://host.example',
    token: 'tok',
    orchestratorId: 'orch-1',
    runId: 'run-1',
    jobId: 'job-1',
    audience: 'sigstore',
  };

  it('POSTs the mint endpoint with Bearer auth and parses the result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'eyJ.a.b', expires_in: 600, jti: 'run-1:job-1' }), {
        status: 200,
      }),
    );
    const res = await requestMint(args);
    expect(res).toEqual({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://host.example/internal/orchestrator/orch-1/mint-id-token');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      run_id: 'run-1',
      job_id: 'job-1',
      audience: 'sigstore',
    });
  });

  it('maps 404/409 to MintRejectedError, 503 to MintUnavailableError, other 5xx to MintRelayError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(requestMint(args)).rejects.toBeInstanceOf(MintRejectedError);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(requestMint(args)).rejects.toBeInstanceOf(MintRejectedError);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(requestMint(args)).rejects.toBeInstanceOf(MintUnavailableError);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(requestMint(args)).rejects.toBeInstanceOf(MintRelayError);
  });
});

describe('createOidcTokenHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  const dispatcher = {
    resolveOwnedJob: (agentId: string, jobId: string) =>
      agentId === 'agent-1' && jobId === 'job-1' ? { runId: 'run-1' } : undefined,
  };

  const handler = createOidcTokenHandler({
    dispatcher,
    platformToken: 'tok',
    platformHttpBase: 'https://host.example',
    orchestratorId: 'orch-1',
  });

  it('mints for an owned job, supplying the dispatcher-resolved runId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'eyJ.a.b', expires_in: 600, jti: 'run-1:job-1' }), {
        status: 200,
      }),
    );
    const res = await handler('agent-1', { jobId: 'job-1', audience: 'sigstore' });
    expect(res).toEqual({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      run_id: 'run-1',
      job_id: 'job-1',
      audience: 'sigstore',
    });
  });

  it('rejects a job the agent does not own without calling the Platform', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(handler('agent-1', { jobId: 'nope', audience: 'sigstore' })).rejects.toThrow(
      /not owned/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed params', async () => {
    await expect(
      handler('agent-1', { audience: 'sigstore' } as Record<string, unknown>),
    ).rejects.toBeTruthy();
  });

  it('propagates a mint error as a clean typed error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(
      handler('agent-1', { jobId: 'job-1', audience: 'sigstore' }),
    ).rejects.toBeInstanceOf(MintRejectedError);
  });
});
