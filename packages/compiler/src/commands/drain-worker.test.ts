import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drainWorkerCommand } from './drain-worker.js';

describe('drainWorkerCommand', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends POST to /drain endpoint at specified URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ draining: true, activeJobs: 3 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await drainWorkerCommand({ url: 'http://worker-host:10143' });

    expect(mockFetch).toHaveBeenCalledWith('http://worker-host:10143/drain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('prints active job count on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ draining: true, activeJobs: 5 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await drainWorkerCommand({ url: 'http://worker-host:10143' });
    expect(result).toBe(true);
  });

  it('returns false and prints error on connection failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await drainWorkerCommand({ url: 'http://worker-host:10143' });
    expect(result).toBe(false);
  });

  it('returns false on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await drainWorkerCommand({ url: 'http://worker-host:10143' });
    expect(result).toBe(false);
  });
});
