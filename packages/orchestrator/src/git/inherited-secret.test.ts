import { describe, it, expect, vi } from 'vitest';
import { encrypt, deriveKey } from '@kici-dev/shared';
import { createInheritedSecretReader } from './inherited-secret.js';

const SECRET_KEY = 'a'.repeat(64);
const OLD_SECRET_KEY = 'b'.repeat(64);
const RUN = 'run-1';
const MASTER_KEYS = {
  material: SECRET_KEY,
  materialOld: undefined,
  current: deriveKey(SECRET_KEY),
  old: undefined,
};

function sealed(value: string, key = SECRET_KEY) {
  return encrypt(value, deriveKey(key), 1, `secret-output:${RUN}`).data;
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
      masterKeys: MASTER_KEYS,
    });
    await expect(read(RUN, 'job-2', 'FORGE_TOKEN')).resolves.toBe('inherited-token');
  });

  it('returns null when no upstream published that key', async () => {
    const read = createInheritedSecretReader({
      secretOutputStore: {
        getUpstreamSecretOutputs: vi.fn().mockResolvedValue({ 'job-1': {} }),
      } as never,
      upstreamJobIds: async () => ['job-1'],
      masterKeys: MASTER_KEYS,
    });
    await expect(read(RUN, 'job-2', 'ABSENT')).resolves.toBeNull();
  });

  it('returns null without touching the store when the job has no upstreams', async () => {
    const getUpstreamSecretOutputs = vi.fn();
    const read = createInheritedSecretReader({
      secretOutputStore: { getUpstreamSecretOutputs } as never,
      upstreamJobIds: async () => [],
      masterKeys: MASTER_KEYS,
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
      masterKeys: MASTER_KEYS,
    });
    await expect(read(RUN, 'job-2', 'FORGE_TOKEN')).resolves.toBe('from-b');
  });
});

describe('createInheritedSecretReader dual-key fallback', () => {
  it('reads a value still sealed under the old master key', async () => {
    const encrypted = sealed('from-old-key', OLD_SECRET_KEY);
    const store = {
      getUpstreamSecretOutputs: vi.fn().mockResolvedValue({ up: { TOKEN: encrypted } }),
    };

    // Positive control: with the current key alone the row is unreadable, so
    // the fallback below is what makes the read succeed.
    const currentOnly = createInheritedSecretReader({
      secretOutputStore: store as never,
      upstreamJobIds: async () => ['up'],
      masterKeys: MASTER_KEYS,
    });
    await expect(currentOnly(RUN, 'job-1', 'TOKEN')).rejects.toThrow();

    const withOld = createInheritedSecretReader({
      secretOutputStore: store as never,
      upstreamJobIds: async () => ['up'],
      masterKeys: {
        material: SECRET_KEY,
        materialOld: OLD_SECRET_KEY,
        current: deriveKey(SECRET_KEY),
        old: deriveKey(OLD_SECRET_KEY),
      },
    });
    expect(await withOld(RUN, 'job-1', 'TOKEN')).toBe('from-old-key');
  });
});
