import { describe, expect, it, vi } from 'vitest';
import { buildKiciApi } from './api-types.js';

describe('buildKiciApi', () => {
  it('infrastructure.list relays the method with empty params', async () => {
    const transport = vi.fn().mockResolvedValue({ scalers: [], agents: [] });
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    await api.infrastructure.list();
    expect(transport).toHaveBeenCalledWith('infrastructure.list', {});
  });

  it('oidc.token injects the job-bound jobId and the method constant', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({ token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' });
    const api = buildKiciApi(transport, { jobId: 'job-1' });
    const res = await api.oidc.token({ audience: 'sigstore' });
    expect(res.token).toBe('eyJ.a.b');
    expect(transport).toHaveBeenCalledWith('oidc.token.request', {
      jobId: 'job-1',
      audience: 'sigstore',
    });
  });

  it('oidc.token throws a clear error when no job context is bound', async () => {
    const transport = vi.fn();
    const api = buildKiciApi(transport);
    await expect(api.oidc.token({ audience: 'sigstore' })).rejects.toThrow(
      /only available inside a running job step/i,
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
