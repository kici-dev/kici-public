import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalDecision } from '@kici-dev/engine';
import {
  DirectApiUnavailableError,
  DirectRunClient,
  HoldsUnavailableError,
} from './direct-client.js';
import { AccessDeniedError, AuthenticationError, ConnectionError } from './platform-client.js';

type Call = { url: string; init: RequestInit };

/** Stub fetch with a queue of responses and record each call. */
function stubFetch(...responses: Array<Response | Error>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response('{}', { status: 200 });
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = () => new DirectRunClient({ url: 'https://ci.example.com/kici/', token: 'tok' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DirectRunClient requests', () => {
  it('keeps the base path and sends the bearer token', async () => {
    const calls = stubFetch(json({ tokenId: 't' }));
    await client().whoami();
    // fails-when: the base path is dropped or doubled ("//api")
    expect(calls[0].url).toBe('https://ci.example.com/kici/api/v1/test/whoami');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('builds the log cursor query', async () => {
    const calls = stubFetch(json({ lines: [], nextCursor: 3, done: false }));
    await client().runLogs('run-1', 3);
    expect(calls[0].url).toBe('https://ci.example.com/kici/api/v1/test/runs/run-1/logs?cursor=3');
  });
});

describe('DirectRunClient errors', () => {
  it('maps 401 to an authentication error that names the orchestrator commands', async () => {
    stubFetch(json({ error: 'Invalid or expired token' }, 401));
    const err = await client()
      .whoami()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain('kici-admin token create');
    expect((err as Error).message).toContain('kici connect');
    expect((err as Error).message).not.toContain('kici login');
  });

  it('maps 403 to access denied with the server text', async () => {
    stubFetch(json({ error: 'Permission denied: test_run.trigger required' }, 403));
    const err = await client()
      .trigger({ fixtureId: 'f', event: { type: 'push', targetBranch: 'main', payload: {} } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect((err as Error).message).toBe('Permission denied: test_run.trigger required');
  });

  it('maps a whoami 404 to the API being unavailable', async () => {
    stubFetch(new Response('404 Not Found', { status: 404 }));
    const err = await client()
      .whoami()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectApiUnavailableError);
    expect((err as Error).message).toContain('KICI_SECRET_KEY');
  });

  it('surfaces the reason of a rejected trigger', async () => {
    stubFetch(
      json({ runId: 'r', status: 'rejected', reason: 'context does not allow test runs' }, 422),
    );
    await expect(
      client().trigger({
        fixtureId: 'f',
        event: { type: 'push', targetBranch: 'main', payload: {} },
      }),
    ).rejects.toThrow('context does not allow test runs');
  });

  it('maps a transport failure to a connection error naming the URL', async () => {
    stubFetch(new TypeError('fetch failed'));
    const err = await client()
      .runStatus('r')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toContain('https://ci.example.com/kici');
  });
});

describe('DirectRunClient admin reads', () => {
  it('lists context secret key names', async () => {
    const calls = stubFetch(
      json({ contexts: [{ name: 'test', secret_keys: ['A', 'B'] }, { name: 'empty' }] }),
    );
    const out = await client().listContextSecretKeys('__default__');
    expect(calls[0].url).toBe(
      'https://ci.example.com/kici/api/v1/admin/contexts?orgId=__default__&includeSecrets=true',
    );
    expect(out).toEqual([
      { name: 'test', keys: ['A', 'B'] },
      { name: 'empty', keys: [] },
    ]);
  });

  it('turns a 409 hold listing into HoldsUnavailableError with the server text', async () => {
    stubFetch(json({ error: 'answer this hold in the dashboard' }, 409));
    const err = await client()
      .listHolds('org', 'run')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldsUnavailableError);
    expect((err as Error).message).toBe('answer this hold in the dashboard');
  });

  it('posts a hold decision and reports a refusal', async () => {
    const calls = stubFetch(json({ status: 'applied' }), json({ error: 'ineligible' }, 409));
    const c = client();
    expect(await c.decideHold('org', 'h1', ApprovalDecision.enum.approve)).toBe(true);
    expect(calls[0].url).toBe('https://ci.example.com/kici/api/v1/admin/held-runs/decision');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      customerId: 'org',
      heldRunId: 'h1',
      decision: 'approve',
    });
    expect(await c.decideHold('org', 'h2', ApprovalDecision.enum.reject, 'no')).toBe(false);
    expect(c.lastDecisionError).toBe('ineligible');
  });

  // fails-when: decideHold leaves autoApprove out of the body — the
  // orchestrator then audits a --approve-all as a manual held_run.approve.
  it('marks a --approve-all decision with autoApprove in the body', async () => {
    const calls = stubFetch(json({ status: 'released' }));
    await client().decideHold('org', 'h1', ApprovalDecision.enum.approve, undefined, true);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      customerId: 'org',
      heldRunId: 'h1',
      decision: 'approve',
      autoApprove: true,
    });
  });
});
