/**
 * Tests for AdminApiClient.
 *
 * Mocks global fetch to verify correct HTTP method, URL, headers,
 * body serialization, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminApiClient, fetchAdminApi, firstCauseMessage } from './api-client.js';

const BASE_URL = 'http://localhost:8080';
const TOKEN = 'test-token-123';

function mockFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers({ 'content-type': contentType }),
  });
}

describe('AdminApiClient', () => {
  let client: AdminApiClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new AdminApiClient(BASE_URL, TOKEN);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends Bearer token in Authorization header', async () => {
    const fetchMock = mockFetch(200, { scopes: [] });
    globalThis.fetch = fetchMock;

    await client.listScopes('org-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  // --- Scoped secret management ---

  it('sends GET for listScopes with orgId query param', async () => {
    const fetchMock = mockFetch(200, { scopes: ['production', 'staging'] });
    globalThis.fetch = fetchMock;

    const result = await client.listScopes('org-1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/admin/secrets/scopes?orgId=org-1`);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(result).toEqual({ scopes: ['production', 'staging'] });
  });

  it('sends GET for listKeys with orgId and scope query params', async () => {
    const fetchMock = mockFetch(200, { keys: ['DB_PASSWORD', 'API_KEY'] });
    globalThis.fetch = fetchMock;

    const result = await client.listKeys('org-1', 'production');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/admin/secrets/keys?');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('scope=production');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(result).toEqual({ keys: ['DB_PASSWORD', 'API_KEY'] });
  });

  it('sends PUT for setSecret with correct URL and body', async () => {
    const fetchMock = mockFetch(204, undefined);
    globalThis.fetch = fetchMock;

    await client.setSecret('org-1', 'production', 'DB_PASSWORD', 'secret123');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/admin/secrets/org-1/production/DB_PASSWORD`);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ value: 'secret123' });
  });

  it('sends DELETE for deleteSecret with correct URL', async () => {
    const fetchMock = mockFetch(204, undefined);
    globalThis.fetch = fetchMock;

    await client.deleteSecret('org-1', 'production', 'DB_PASSWORD');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/admin/secrets/org-1/production/DB_PASSWORD`);
    expect(opts.method).toBe('DELETE');
  });

  // --- Context management ---

  it('sends POST for createContext with orgId/name/allowLocalExecution body', async () => {
    const fetchMock = mockFetch(201, { envId: 'env-1', created: true });
    globalThis.fetch = fetchMock;

    const result = await client.createContext({
      orgId: 'org-1',
      name: 'production',
      allowLocalExecution: true,
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/admin/contexts`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      orgId: 'org-1',
      name: 'production',
      allowLocalExecution: true,
    });
    expect(result).toEqual({ envId: 'env-1', created: true });
  });

  it('sends POST for bindContext to /contexts/:name/bind with scope + host body', async () => {
    const fetchMock = mockFetch(200, { bound: true });
    globalThis.fetch = fetchMock;

    await client.bindContext({
      orgId: 'org-1',
      name: 'production',
      scopePattern: 'production',
      hostPattern: '**',
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/admin/contexts/production/bind`);
    expect(opts.method).toBe('POST');
    // The name is a path segment, not part of the body.
    expect(JSON.parse(opts.body)).toEqual({
      orgId: 'org-1',
      scopePattern: 'production',
      hostPattern: '**',
    });
  });

  // --- Key rotation ---

  it('sends POST for rotateKey', async () => {
    const fetchMock = mockFetch(200, { reEncrypted: 5 });
    globalThis.fetch = fetchMock;

    const result = await client.rotateKey();

    expect(result).toEqual({ reEncrypted: 5 });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  // --- Audit ---

  it('sends GET for queryAudit with filters', async () => {
    const fetchMock = mockFetch(200, []);
    globalThis.fetch = fetchMock;

    await client.queryAudit({ contextName: 'prod', action: 'secret.read', limit: 50 });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('contextName=prod');
    expect(url).toContain('action=secret.read');
    expect(url).toContain('limit=50');
  });

  // --- Token management ---

  it('sends POST for createToken', async () => {
    const fetchMock = mockFetch(200, { token: 'tok-abc', id: 'id-123' });
    globalThis.fetch = fetchMock;

    const result = await client.createToken({ label: 'ci', role: 'admin' });

    expect(result).toEqual({ token: 'tok-abc', id: 'id-123' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ label: 'ci', role: 'admin' });
  });

  it('sends DELETE for revokeToken', async () => {
    const fetchMock = mockFetch(204, undefined);
    globalThis.fetch = fetchMock;

    await client.revokeToken('tok-id-1');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/admin/tokens/tok-id-1`);
    expect(opts.method).toBe('DELETE');
  });

  // --- Error handling ---

  it('throws on non-2xx responses with error body', async () => {
    const fetchMock = mockFetch(403, { error: 'Permission denied' });
    globalThis.fetch = fetchMock;

    await expect(client.listScopes('org-1')).rejects.toThrow('HTTP 403: Permission denied');
  });

  it('throws on non-2xx responses with text body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    globalThis.fetch = fetchMock;

    await expect(client.listScopes('org-1')).rejects.toThrow('HTTP 500: Internal Server Error');
  });

  it('throws on non-2xx responses with HTML body (reverse proxy error)', async () => {
    const htmlError = '<html><body><h1>502 Bad Gateway</h1></body></html>';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve(htmlError),
    });
    globalThis.fetch = fetchMock;

    await expect(client.listScopes('org-1')).rejects.toThrow(`HTTP 502: ${htmlError}`);
  });

  // --- URL encoding ---

  it('URL-encodes path parameters in secret URLs', async () => {
    const fetchMock = mockFetch(204, undefined);
    globalThis.fetch = fetchMock;

    await client.setSecret('org/1', 'scope/2', 'key/3', 'val');

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/api/v1/admin/secrets/org%2F1/scope%2F2/key%2F3`,
    );
  });

  it('URL-encodes orgId in listScopes', async () => {
    const fetchMock = mockFetch(200, { scopes: [] });
    globalThis.fetch = fetchMock;

    await client.listScopes('org:special');

    expect(fetchMock.mock.calls[0][0]).toContain('orgId=org%3Aspecial');
  });
});

describe('fetchAdminApi — unreachable-host diagnostics', () => {
  const BASE = 'http://127.0.0.1:4000';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The bare `TypeError: fetch failed` this replaces reads as a fault in the
   * subcommand rather than a misaddressed client. Each assertion below pins one
   * piece of information an operator needs to self-serve, and every one of them
   * can only be present if the wrapper actually ran — a plain `fetch` rejection
   * carries none of them.
   */
  it('names the address it dialled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE)).rejects.toThrow(BASE);
  });

  it('names KICI_ADMIN_URL as the knob, and KICI_ORCHESTRATOR_URL as the near-miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('KICI_ADMIN_URL');
    // The direct-DB fallback is what makes some subcommands keep working while
    // HTTP-only ones fail, which is the misleading part worth spelling out.
    expect(err.message).toContain('KICI_ORCHESTRATOR_URL');
    expect(err.message).toContain('KICI_DATABASE_URL');
  });

  it('surfaces the underlying cause detail (ECONNREFUSED and friends)', async () => {
    const inner = new TypeError('fetch failed');
    (inner as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(inner));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.cause).toBe(inner);
  });

  it('passes a reachable response straight through', async () => {
    const res = new Response('{}', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    await expect(fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE)).resolves.toBe(res);
  });
});

/**
 * `fetch` rejects with a TypeError for two unrelated situations: the transport
 * failed, and the request could never be built at all. Reporting the second as
 * the first sends an operator to check firewalls and ports when their token
 * actually contains a stray newline — the orchestrator was never dialled.
 *
 * The real shapes, measured against Node 24's undici:
 *   closed port    → TypeError('fetch failed')                       cause: Error(ECONNREFUSED)
 *   invalid header → TypeError('Headers.append: … invalid header …') cause: undefined
 *   invalid URL    → TypeError('Failed to parse URL from …')         cause: Error(ERR_INVALID_URL)
 *
 * So the discriminator is the message, NOT the presence of a cause — the
 * invalid-URL case carries one.
 */
describe('fetchAdminApi — malformed request vs unreachable host', () => {
  const BASE = 'http://127.0.0.1:4000';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not blame connectivity when the header value is invalid', async () => {
    // The exact shape a token containing a newline produces.
    const inner = new TypeError('Headers.append: "Bearer a\nb" is an invalid header value.');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(inner));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toContain('cannot reach');
    expect(err.message).toContain('invalid header value');
    expect(err.cause).toBe(inner);
  });

  it('points at the credential and the address as the usual cause', async () => {
    const inner = new TypeError('Headers.append: "Bearer a\nb" is an invalid header value.');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(inner));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('KICI_ADMIN_TOKEN');
    expect(err.message).toContain('KICI_ADMIN_URL');
  });

  it('does not blame connectivity when the URL cannot be parsed', async () => {
    // Carries a cause, so a cause-presence check would misclassify this one.
    const inner = new TypeError('Failed to parse URL from not-a-url');
    (inner as { cause?: unknown }).cause = Object.assign(new Error('Invalid URL'), {
      code: 'ERR_INVALID_URL',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(inner));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toContain('cannot reach');
    expect(err.message).toContain('Failed to parse URL');
  });

  it('still reports a genuine transport failure as unreachable', async () => {
    // Regression guard: the discriminator must not swallow the real case.
    const inner = new TypeError('fetch failed');
    (inner as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(inner));
    const err = await fetchAdminApi(`${BASE}/admin/x`, { method: 'GET' }, BASE).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('cannot reach the orchestrator admin API');
  });
});

describe('firstCauseMessage', () => {
  it('returns the cause message when present', () => {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    expect(firstCauseMessage(e)).toBe('connect ECONNREFUSED 127.0.0.1:4000');
  });

  it('digs into AggregateError.errors when the cause message is empty', () => {
    const agg = new AggregateError([new Error('connect EHOSTUNREACH ::1:4000')], '');
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = agg;
    expect(firstCauseMessage(e)).toBe('connect EHOSTUNREACH ::1:4000');
  });

  it('returns empty string when nothing useful is available', () => {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = new Error('');
    // Drives the ` ()` defect this exists to prevent: an empty detail must
    // produce no parenthetical at all.
    expect(firstCauseMessage(e)).toBe('');
    expect(firstCauseMessage(new TypeError('fetch failed'))).toBe('');
    expect(firstCauseMessage('not an error')).toBe('');
  });
});
