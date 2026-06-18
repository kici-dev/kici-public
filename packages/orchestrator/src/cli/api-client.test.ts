/**
 * Tests for AdminApiClient.
 *
 * Mocks global fetch to verify correct HTTP method, URL, headers,
 * body serialization, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminApiClient } from './api-client.js';

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
