import { describe, it, expect, vi } from 'vitest';
import { encrypt, deriveKey } from '@kici-dev/shared';
import { createInheritedSecretReader } from './inherited-secret.js';

const SECRET_KEY = 'a'.repeat(64);
const RUN = 'run-1';

function sealed(value: string) {
  return encrypt(value, deriveKey(SECRET_KEY), 1, `secret-output:${RUN}`).data;
}

describe('createInheritedSecretReader', () => {
  it('decrypts a secret output published by an upstream job', async () => {
    const read = createInheritedSecretReader({
      secretOutputStore: {
        getUpstreamSecretOutputs: vi
          .fn()
          .mockResolvedValue({ 'job-1': { FORGE_TOKEN: sealed('inherited-token') } }),
      } as never,
      upstreamJobIds: async () => ['job-1'],
      secretKey: SECRET_KEY,
    });
    await expect(read(RUN, 'job-2', 'FORGE_TOKEN')).resolves.toBe('inherited-token');
  });

  it('returns null when no upstream published that key', async () => {
    const read = createInheritedSecretReader({
      secretOutputStore: {
        getUpstreamSecretOutputs: vi.fn().mockResolvedValue({ 'job-1': {} }),
      } as never,
      upstreamJobIds: async () => ['job-1'],
      secretKey: SECRET_KEY,
    });
    await expect(read(RUN, 'job-2', 'ABSENT')).resolves.toBeNull();
  });

  it('returns null without touching the store when the job has no upstreams', async () => {
    const getUpstreamSecretOutputs = vi.fn();
    const read = createInheritedSecretReader({
      secretOutputStore: { getUpstreamSecretOutputs } as never,
      upstreamJobIds: async () => [],
      secretKey: SECRET_KEY,
    });
    await expect(read(RUN, 'job-2', 'X')).resolves.toBeNull();
    expect(getUpstreamSecretOutputs).not.toHaveBeenCalled();
  });

  it('searches every upstream job, not just the first', async () => {
    const read = createInheritedSecretReader({
      secretOutputStore: {
        getUpstreamSecretOutputs: vi
          .fn()
          .mockResolvedValue({ 'job-a': {}, 'job-b': { FORGE_TOKEN: sealed('from-b') } }),
      } as never,
      upstreamJobIds: async () => ['job-a', 'job-b'],
      secretKey: SECRET_KEY,
    });
    await expect(read(RUN, 'job-2', 'FORGE_TOKEN')).resolves.toBe('from-b');
  });
});
