/**
 * `kici-admin cache purge-legacy` against an in-memory CacheStorage.
 *
 * The storage resolver is injected so the test never reads env or touches a
 * bucket; the command's own listing, classification, and deletion run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import type { CacheMetadata, CacheStorage } from '../../storage/types.js';
import { userCacheEntryKey } from '../../cache/user-cache.js';
import { sourceTarballKey, sourcePointerKey } from '../../cache/source-cache.js';
import { depTarballKey, depPointerKey } from '../../cache/dep-cache.js';
import { registerCacheCommands, purgeLegacyCache } from './cache.js';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

/** Minimal in-memory backend: only what the purge touches is exercised. */
class FakeStorage implements CacheStorage {
  readonly data = new Map<string, Buffer>();
  readonly deleted: string[] = [];

  async put(key: string, value: Buffer | string): Promise<void> {
    this.data.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  async get(key: string): Promise<Buffer | null> {
    return this.data.get(key) ?? null;
  }
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  async delete(key: string): Promise<boolean> {
    this.deleted.push(key);
    return this.data.delete(key);
  }
  async touch(): Promise<void> {}
  async getUrl(key: string): Promise<string | null> {
    return this.data.has(key) ? `mem://${key}` : null;
  }
  presignedGetTtlSeconds(): number {
    return 3600;
  }
  async getUploadUrl(key: string): Promise<string> {
    return `put://${key}`;
  }
  async getInternalUploadUrl(key: string): Promise<string> {
    return `put://${key}`;
  }
  async initMeta(): Promise<void> {}
  async list(subPrefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(subPrefix)).sort();
  }
  async copy(src: string, dest: string): Promise<void> {
    const v = this.data.get(src);
    if (v) this.data.set(dest, v);
  }
  async getMetadata(): Promise<CacheMetadata | null> {
    return null;
  }
  async getObjectSize(key: string): Promise<number | null> {
    return this.data.get(key)?.length ?? null;
  }
}

const CURRENT = {
  userEntry: userCacheEntryKey({ org: 'org-1', repo: 'owner/repo', scope: 'shared' }, 'deps'),
  userTemp: 'cache/org-1/owner_repo/shared/.tmp-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.tar.gz',
  sourceTarball: sourceTarballKey('org-1', HEX64_A),
  sourcePointer: sourcePointerKey('org-1', HEX64_B),
  depTarball: depTarballKey(HEX64_A, 'linux', 'x64'),
  depPointer: depPointerKey(HEX64_B, 'linux', 'x64'),
  sentinel: '.kici-cluster-id',
};

const LEGACY = {
  userEntry: 'cache/org-1/owner_repo/shared/deps.tar.gz',
  userHash: 'cache/org-1/owner_repo/shared/deps.tar.gz.hash',
  userSize: 'cache/org-1/owner_repo/shared/deps.tar.gz.size',
  otherOrgEntry: 'cache/org-2/owner_repo/iso/run-1/build.tar.gz',
  sourceTarball: `source/${HEX64_B}.tar.gz`,
  // A lockfile-named tarball with its same-stem sidecar. The sidecar's key is
  // also a valid current pointer key, so only the tarball is a purge target.
  depTarball: `deps/linux-x64/${'c'.repeat(64)}.tar.gz`,
  depSidecar: `deps/linux-x64/${'c'.repeat(64)}.hash`,
};

async function seed(): Promise<FakeStorage> {
  const storage = new FakeStorage();
  for (const key of Object.values(CURRENT)) await storage.put(key, `current:${key}`);
  for (const key of Object.values(LEGACY)) await storage.put(key, `legacy:${key}`);
  return storage;
}

function legacyTargets(): string[] {
  return Object.values(LEGACY).filter((k) => k !== LEGACY.depSidecar);
}

describe('purgeLegacyCache', () => {
  it('dry run lists per-prefix counts and bytes and deletes nothing', async () => {
    const storage = await seed();
    const before = new Set(storage.data.keys());
    const summary = await purgeLegacyCache({ storage, apply: false });

    expect(storage.deleted).toEqual([]);
    expect(new Set(storage.data.keys())).toEqual(before);
    expect(summary.applied).toBe(false);
    expect(summary.perPrefix.get('cache/')?.count).toBe(4);
    expect(summary.perPrefix.get('source/')?.count).toBe(1);
    expect(summary.perPrefix.get('deps/')?.count).toBe(1);
    expect(summary.totalCount).toBe(6);
    // Bytes come from a stat of each candidate, not from a guess.
    const expectedBytes = legacyTargets().reduce((n, k) => n + `legacy:${k}`.length, 0);
    expect(summary.totalBytes).toBe(expectedBytes);
  });

  it('with apply deletes exactly the legacy keys', async () => {
    const storage = await seed();
    const summary = await purgeLegacyCache({ storage, apply: true });

    expect(summary.applied).toBe(true);
    expect([...storage.deleted].sort()).toEqual(legacyTargets().sort());
    // fails-when: a key the current writers produce is in the deletion set.
    for (const key of Object.values(CURRENT)) {
      expect(storage.deleted).not.toContain(key);
      expect(storage.data.has(key)).toBe(true);
    }
    // The ambiguous deps sidecar is left in place; the reader treats it as a
    // dangling pointer and the next build overwrites it.
    expect(storage.data.has(LEGACY.depSidecar)).toBe(true);
    expect(summary.totalCount).toBe(6);
  });

  it('--org narrows the sweep to that org user-cache prefix', async () => {
    const storage = await seed();
    const summary = await purgeLegacyCache({ storage, apply: true, org: 'org-2' });

    expect(storage.deleted).toEqual([LEGACY.otherOrgEntry]);
    expect(summary.perPrefix.get('cache/')?.count).toBe(1);
    // fails-when: an org-less legacy layout is swept under an org filter.
    expect(summary.perPrefix.has('source/')).toBe(false);
    expect(summary.perPrefix.has('deps/')).toBe(false);
    expect(storage.data.has(LEGACY.sourceTarball)).toBe(true);
    expect(storage.data.has(LEGACY.userEntry)).toBe(true);
  });

  it('sanitizes --org the way the writer does, so a raw org id still matches', async () => {
    const storage = new FakeStorage();
    // The writer maps `/` to `_` in every segment; `--org acme/eu` must reach
    // the objects it actually wrote under `cache/acme_eu/`.
    await storage.put('cache/acme_eu/repo/shared/k.tar.gz', 'legacy');
    const summary = await purgeLegacyCache({ storage, apply: false, org: 'acme/eu' });
    expect(summary.totalCount).toBe(1);
  });

  it('reports an empty store as nothing to purge', async () => {
    const summary = await purgeLegacyCache({ storage: new FakeStorage(), apply: true });
    expect(summary.totalCount).toBe(0);
    expect(summary.totalBytes).toBe(0);
    expect(summary.perPrefix.size).toBe(0);
  });
});

describe('kici-admin cache purge-legacy (commander wiring)', () => {
  async function run(argv: string[], storage: CacheStorage): Promise<string> {
    const program = new Command();
    program.name('kici-admin');
    program.exitOverride();
    const lines: string[] = [];
    registerCacheCommands(program, {
      resolveStorage: () => storage,
      out: (line) => lines.push(line),
    });
    await program.parseAsync(['node', 'kici-admin', ...argv]);
    return lines.join('\n');
  }

  it('is a dry run by default', async () => {
    const storage = await seed();
    const out = await run(['cache', 'purge-legacy'], storage);
    expect(storage.deleted).toEqual([]);
    expect(out).toMatch(/dry run/i);
    expect(out).toContain('cache/');
    expect(out).toMatch(/--yes/);
  });

  it('deletes with --yes and prints the counts', async () => {
    const storage = await seed();
    const out = await run(['cache', 'purge-legacy', '--yes'], storage);
    expect([...storage.deleted].sort()).toEqual(legacyTargets().sort());
    expect(out).toMatch(/deleted 6 object/i);
    expect(out).not.toMatch(/dry run/i);
  });

  // fails-when: the action's catch is removed, or a listing failure is read as
  // an empty listing — either way the summary line would print over a broken
  // backend and the exit code would read as success.
  it('a storage error exits 2 and never prints the empty-store summary', async () => {
    class UnreachableStorage extends FakeStorage {
      override async list(): Promise<string[]> {
        throw new Error('bucket unreachable');
      }
    }
    const broken: CacheStorage = new UnreachableStorage();
    const program = new Command();
    program.name('kici-admin');
    program.exitOverride();
    const lines: string[] = [];
    registerCacheCommands(program, {
      resolveStorage: () => broken,
      out: (line) => lines.push(line),
    });
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(`__exit_${code ?? 0}__`);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      await expect(
        program.parseAsync(['node', 'kici-admin', 'cache', 'purge-legacy', '--yes']),
      ).rejects.toThrow('__exit_2__');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(exitCodes).toEqual([2]);
    expect(errors.join('\n')).toContain('bucket unreachable');
    expect(lines).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/No objects under the retired cache layouts/);
  });

  it('passes --org through', async () => {
    const storage = await seed();
    await run(['cache', 'purge-legacy', '--yes', '--org', 'org-2'], storage);
    expect(storage.deleted).toEqual([LEGACY.otherOrgEntry]);
  });
});
