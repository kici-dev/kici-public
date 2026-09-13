import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  derivePlatformWsUrl,
  mintOrchestratorKey,
  revokeOrchestratorKey,
  probePlatformReachable,
} from './platform-attach.js';

describe('derivePlatformWsUrl', () => {
  it('derives wss + /ws from an https prod base', () => {
    expect(derivePlatformWsUrl('https://api.kici.dev')).toBe('wss://api.kici.dev/ws');
  });
  it('derives wss + /ws from an https staging sub-path base', () => {
    expect(derivePlatformWsUrl('https://thinker1.dev.kici.dev/kici-stg')).toBe(
      'wss://thinker1.dev.kici.dev/kici-stg/ws',
    );
  });
  it('is idempotent when the base already ends in /ws', () => {
    expect(derivePlatformWsUrl('https://thinker1.dev.kici.dev/kici-stg/ws')).toBe(
      'wss://thinker1.dev.kici.dev/kici-stg/ws',
    );
  });
  it('maps http → ws', () => {
    expect(derivePlatformWsUrl('http://localhost:10142/kici-stg')).toBe(
      'ws://localhost:10142/kici-stg/ws',
    );
  });
  it('rejects a non-http(s) base', () => {
    expect(() => derivePlatformWsUrl('ftp://x')).toThrow(/http/);
  });
});

describe('mintOrchestratorKey', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the orchestrator-keys route with the PAT bearer and returns { key, keyId }', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ key: 'kici_ok_secret', id: 'key-123', keyPrefix: 'kici_ok_' }),
    });
    const res = await mintOrchestratorKey({
      apiBase: 'https://thinker1.dev.kici.dev/kici-stg',
      pat: 'kici_pat_abc',
      orgId: 'kiciStg00001',
    });
    expect(res).toEqual({ key: 'kici_ok_secret', keyId: 'key-123', keyPrefix: 'kici_ok_' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://thinker1.dev.kici.dev/kici-stg/api/v1/orgs/kiciStg00001/orchestrator-keys',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer kici_pat_abc');
  });

  it('throws a clear permission error on 403', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(
      mintOrchestratorKey({ apiBase: 'https://x', pat: 'p', orgId: 'o' }),
    ).rejects.toThrow(/api_keys:write/);
  });

  it('throws a re-auth error on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(
      mintOrchestratorKey({ apiBase: 'https://x', pat: 'p', orgId: 'o' }),
    ).rejects.toThrow(/kici login/);
  });
});

describe('revokeOrchestratorKey', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('DELETEs the key and returns true on ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const ok = await revokeOrchestratorKey({
      apiBase: 'https://x',
      pat: 'p',
      orgId: 'o',
      keyId: 'k1',
    });
    expect(ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://x/api/v1/orgs/o/orchestrator-keys/k1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('never throws on network error (returns false)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(
      revokeOrchestratorKey({ apiBase: 'https://x', pat: 'p', orgId: 'o', keyId: 'k1' }),
    ).resolves.toBe(false);
  });
});

describe('probePlatformReachable', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is true for any HTTP response (even 401)', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    await expect(probePlatformReachable('https://x')).resolves.toBe(true);
  });
  it('is false on network error / abort', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expect(probePlatformReachable('https://x')).resolves.toBe(false);
  });
});
