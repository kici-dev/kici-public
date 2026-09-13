import { describe, it, expect, vi } from 'vitest';
import { resolveAgentPackageStore } from './store.js';
import type { AppConfig } from '../config.js';
import type { CacheStorage } from '../storage/types.js';

const cacheStorage = { getUrl: vi.fn(), get: vi.fn(), has: vi.fn() } as unknown as CacheStorage;

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    cacheTtlDays: 30,
    storage: { type: 's3', bucket: 'own', prefix: '', region: 'eu', endpoint: 'http://s3' },
    ...over,
  } as unknown as AppConfig;
}

describe('resolveAgentPackageStore', () => {
  it('defaults to the orchestrator own cache bucket (no vendor CDN)', () => {
    const store = resolveAgentPackageStore(cfg(), cacheStorage);
    // The default IS the own cache-storage instance — never a fresh external client.
    expect(store).toBe(cacheStorage);
  });

  it('returns undefined when neither cache storage nor an override is configured', () => {
    expect(resolveAgentPackageStore(cfg(), undefined)).toBeUndefined();
  });

  it('builds a distinct store for an s3:// mirror override', () => {
    const store = resolveAgentPackageStore(
      cfg({ agentBinarySource: 's3://mirror-bucket/pfx' }),
      cacheStorage,
    );
    expect(store).toBeDefined();
    expect(store).not.toBe(cacheStorage);
  });

  it('rejects a non-s3 override string', () => {
    expect(() =>
      resolveAgentPackageStore(cfg({ agentBinarySource: 'file:///x' }), cacheStorage),
    ).toThrow(/s3:\/\/bucket/);
  });

  it('rejects an s3:// override without an S3 cache backend', () => {
    expect(() =>
      resolveAgentPackageStore(
        cfg({ agentBinarySource: 's3://mirror', storage: { type: 'filesystem' } }),
        cacheStorage,
      ),
    ).toThrow(/requires an S3 cache backend/);
  });
});
