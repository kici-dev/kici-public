import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PlatformRunClient,
  AmbiguousClusterError,
  NoClusterError,
  AuthenticationError,
  AccessDeniedError,
  NotFoundError,
  ConnectionError,
} from './platform-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PlatformRunClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new PlatformRunClient({
    platformEndpoint: 'https://api.kici.dev/',
    token: 'pat-123',
  });

  it('initUpload hits the right URL with bearer auth and cluster query', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ uploadId: 'u1', signedUrl: 's3://x', publicKey: 'pk', expiresIn: 3600 }),
    );

    const res = await client.initUpload('org_a', { orchestrator: 'cluster-1' }, { sha: 'abc' });

    expect(res.uploadId).toBe('u1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.kici.dev/api/v1/orgs/org_a/test/uploads/init?orchestrator=cluster-1',
    );
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pat-123');
    expect(JSON.parse(init.body as string)).toEqual({ sha: 'abc' });
  });

  it('initUpload passes defaultCluster as a query param when set', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ uploadId: 'u1', signedUrl: 's3://x', publicKey: 'pk', expiresIn: 1 }),
    );

    await client.initUpload('org_a', { defaultCluster: 'cluster-default' }, {});

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.kici.dev/api/v1/orgs/org_a/test/uploads/init?defaultCluster=cluster-default',
    );
  });

  it('initUpload omits the cluster query when no target is given', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ uploadId: 'u1', signedUrl: 's3://x', publicKey: 'pk', expiresIn: 1 }),
    );

    await client.initUpload('org_a', {}, {});

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_a/test/uploads/init');
  });

  it('trigger posts the body and returns the run response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runId: 'run-1', status: 'accepted' }));

    const res = await client.trigger(
      'org_a',
      { orchestrator: 'c1' },
      {
        fixtureId: 'f1',
        event: { type: 'push', targetBranch: 'main', payload: {} },
        uploadId: 'u1',
      },
    );

    expect(res).toEqual({ runId: 'run-1', status: 'accepted' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_a/test/trigger?orchestrator=c1');
    expect(JSON.parse(init.body as string).fixtureId).toBe('f1');
  });

  it('runStatus GETs the run snapshot', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ runId: 'run-1', status: 'running', jobs: [], done: false }),
    );

    const res = await client.runStatus('org_a', 'run-1', { orchestrator: 'c1' });

    expect(res.done).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_a/test/runs/run-1?orchestrator=c1');
    expect(init.method).toBe('GET');
  });

  it('runLogs sends the cursor and returns the chunk', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ lines: ['a', 'b'], nextCursor: 2, done: false }));

    const res = await client.runLogs('org_a', 'run-1', 5, { orchestrator: 'c1' });

    expect(res).toEqual({ lines: ['a', 'b'], nextCursor: 2, done: false });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.kici.dev/api/v1/orgs/org_a/test/runs/run-1/logs?cursor=5&orchestrator=c1',
    );
  });

  it('cancel POSTs to the cancel route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ cancelled: true }));

    const res = await client.cancel('org_a', 'run-1');

    expect(res.cancelled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_a/test/runs/run-1/cancel');
    expect(init.method).toBe('POST');
  });

  it('parses a 422 ambiguous_cluster body into AmbiguousClusterError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'ambiguous_cluster', message: 'pick one', clusters: ['c1', 'c2'] },
        422,
      ),
    );

    const err = await client.initUpload('org_a', {}, {}).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousClusterError);
    expect((err as AmbiguousClusterError).clusters).toEqual(['c1', 'c2']);
  });

  it('parses a 422 no_cluster body into NoClusterError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'no_cluster', message: 'none' }, 422));

    await expect(client.runStatus('org_a', 'run-1')).rejects.toBeInstanceOf(NoClusterError);
  });

  it('maps 401/403/404 to typed errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401));
    await expect(client.runStatus('org_a', 'r')).rejects.toBeInstanceOf(AuthenticationError);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'denied' }, 403));
    await expect(client.runStatus('org_a', 'r')).rejects.toBeInstanceOf(AccessDeniedError);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'missing' }, 404));
    await expect(client.runStatus('org_a', 'r')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('wraps a network failure in ConnectionError', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.runStatus('org_a', 'r')).rejects.toBeInstanceOf(ConnectionError);
  });
});
