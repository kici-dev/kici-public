import { describe, it, expect, vi, afterEach } from 'vitest';
import { isOrchestratorHealthy } from './scaler.js';

describe('isOrchestratorHealthy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns true when /health responds 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(true);
  });

  it('returns false when /health is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(false);
  });

  it('returns false on a non-200 status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    expect(await isOrchestratorHealthy(4000, '/')).toBe(false);
  });

  it('honours a non-root basePath when building the probe URL', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await isOrchestratorHealthy(4000, '/kici-stg/');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/kici-stg/health',
      expect.any(Object),
    );
  });
});
