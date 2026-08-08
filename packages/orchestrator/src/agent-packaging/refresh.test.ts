import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshAgentPackages, discoverFleetPlatforms, type RefreshStorage } from './refresh.js';
import { agentPackageKey } from './upload.js';
import type { AgentPlatform } from '@kici-dev/shared';

/** In-memory store backing the refresh: has/list/put over a key set. */
function memStore(initial: string[] = []): RefreshStorage & { keys: Set<string> } {
  const keys = new Set(initial);
  return {
    keys,
    getUrl: vi.fn(),
    get: vi.fn(),
    has: vi.fn(async (k: string) => keys.has(k)),
    put: vi.fn(async (k: string) => {
      keys.add(k);
    }),
    list: vi.fn(async (sub: string) => [...keys].filter((k) => k.startsWith(sub))),
  };
}

const workDir = mkdtempSync(path.join(tmpdir(), 'refresh-test-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** A build stub that writes a real (tiny) tarball so uploadAgentPackage can read it. */
const build = (platform: AgentPlatform, version: string) => {
  const tarballPath = path.join(workDir, `${platform}-${version}.tgz`);
  writeFileSync(tarballPath, `payload:${platform}:${version}`);
  return Promise.resolve({ tarballPath, sha256: `sha-${platform}` });
};

describe('discoverFleetPlatforms', () => {
  it('unions platforms across prior versions, excluding the target version', async () => {
    const store = memStore([
      agentPackageKey('1.0.0', 'linux-x64'),
      agentPackageKey('1.0.0', 'linux-arm64'),
      agentPackageKey('2.0.0', 'linux-x64'), // target — excluded
    ]);
    expect((await discoverFleetPlatforms(store, '2.0.0')).sort()).toEqual([
      'linux-arm64',
      'linux-x64',
    ]);
  });
});

describe('refreshAgentPackages', () => {
  it('produces + uploads the fleet platform set for the new version', async () => {
    // Prior version had linux-x64 only → preserve that arch on upgrade.
    const store = memStore([agentPackageKey('1.0.0', 'linux-x64')]);
    const res = await refreshAgentPackages(store, '2.0.0', {}, { build });
    expect(res.produced).toEqual(['linux-x64']);
    expect(res.skipped).toEqual([]);
    expect(store.keys.has(agentPackageKey('2.0.0', 'linux-x64'))).toBe(true);
    expect(store.keys.has(`${agentPackageKey('2.0.0', 'linux-x64')}.sha256`)).toBe(true);
  });

  it('is idempotent — a re-run over present payloads skips and produces nothing', async () => {
    const store = memStore([
      agentPackageKey('1.0.0', 'linux-x64'),
      agentPackageKey('2.0.0', 'linux-x64'),
      `${agentPackageKey('2.0.0', 'linux-x64')}.sha256`,
    ]);
    const builder = vi.fn(build);
    const res = await refreshAgentPackages(store, '2.0.0', {}, { build: builder });
    expect(res.produced).toEqual([]);
    expect(res.skipped).toEqual(['linux-x64']);
    expect(builder).not.toHaveBeenCalled();
  });

  it('falls back to the bootstrap default set on a fresh store', async () => {
    const store = memStore([]);
    const res = await refreshAgentPackages(store, '2.0.0', {}, { build });
    expect(res.produced.sort()).toEqual(['linux-arm64', 'linux-x64']);
  });

  it('honours an explicit platform override', async () => {
    const store = memStore([agentPackageKey('1.0.0', 'linux-x64')]);
    const res = await refreshAgentPackages(
      store,
      '2.0.0',
      { platforms: ['linux-arm64'] },
      { build },
    );
    expect(res.produced).toEqual(['linux-arm64']);
  });

  it('throws when a produced payload did not land (partial failure surfaces)', async () => {
    const store = memStore([]);
    // A put that silently drops the tarball key leaves availability unsatisfied.
    store.put = vi.fn(async () => {});
    await expect(
      refreshAgentPackages(store, '2.0.0', { platforms: ['linux-x64'] }, { build }),
    ).rejects.toThrow(/refresh incomplete/);
  });
});
