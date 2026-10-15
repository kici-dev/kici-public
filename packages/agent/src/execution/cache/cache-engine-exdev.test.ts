import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Injected rename-failure state. vi.hoisted, because the hoisted vi.mock factory
// would hit the temporal dead zone on a plain const.
const injected = vi.hoisted(() => ({ armed: false, code: 'EXDEV', hits: 0 }));

// ONLY the cross-device move out of the extract scratch dir fails; every other fs
// call delegates to the real module, so the test proves the fallback lands the
// bytes rather than that cp was called.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      src: Parameters<typeof actual.rename>[0],
      dest: Parameters<typeof actual.rename>[1],
    ) => {
      const s = String(src);
      const d = String(dest);
      // Only scratch -> workspace fails; same-directory renames pass through.
      if (
        injected.armed &&
        s.includes('kici-cache-extract-') &&
        !d.includes('kici-cache-extract-')
      ) {
        injected.hits++;
        const err = new Error(
          `${injected.code}: injected cross-device failure`,
        ) as NodeJS.ErrnoException;
        err.code = injected.code;
        throw err;
      }
      return actual.rename(src, dest);
    },
  };
});

// Imported AFTER the mock is registered.
const { packCachePaths, extractCacheTarball } = await import('./cache-engine.js');

beforeEach(() => {
  injected.armed = false;
  injected.code = 'EXDEV';
  injected.hits = 0;
});

describe('cache-engine EXDEV fallback', () => {
  it('lands file content when the scratch->workspace move fails with EXDEV', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exdev-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'exdev-dst-'));
    try {
      await mkdir(join(root, 'dist', 'nested'), { recursive: true });
      await writeFile(join(root, 'dist', 'a.txt'), 'hello');
      await writeFile(join(root, 'dist', 'nested', 'b.txt'), 'world');
      const { tarball, hash } = await packCachePaths(root, ['dist']);

      injected.armed = true;
      await extractCacheTarball(tarball, dest, hash);

      // Positive control: without a fired injection, green proves nothing.
      expect(injected.hits).toBeGreaterThan(0);
      expect((await readFile(join(dest, 'dist', 'a.txt'))).toString()).toBe('hello');
      expect((await readFile(join(dest, 'dist', 'nested', 'b.txt'))).toString()).toBe('world');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('clears a stale destination before the EXDEV fallback lands the cached tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exdev-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'exdev-dst-'));
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'fresh.txt'), 'fresh');
      const { tarball, hash } = await packCachePaths(root, ['dist']);

      // A stale tree the restore must replace, not merge into.
      await mkdir(join(dest, 'dist'), { recursive: true });
      await writeFile(join(dest, 'dist', 'stale.txt'), 'stale');

      injected.armed = true;
      await extractCacheTarball(tarball, dest, hash);

      expect(injected.hits).toBeGreaterThan(0);
      expect((await readFile(join(dest, 'dist', 'fresh.txt'))).toString()).toBe('fresh');
      await expect(stat(join(dest, 'dist', 'stale.txt'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('preserves symlinks as symlinks across the EXDEV fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exdev-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'exdev-dst-'));
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'target.txt'), 'target');
      await symlink('target.txt', join(root, 'dist', 'link.txt'));
      const { tarball, hash } = await packCachePaths(root, ['dist']);

      injected.armed = true;
      await extractCacheTarball(tarball, dest, hash);

      expect(injected.hits).toBeGreaterThan(0);
      const linkStat = await lstat(join(dest, 'dist', 'link.txt'));
      expect(linkStat.isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('propagates a non-EXDEV rename error instead of silently copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exdev-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'exdev-dst-'));
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'a.txt'), 'hello');
      const { tarball, hash } = await packCachePaths(root, ['dist']);

      injected.armed = true;
      injected.code = 'EPERM';
      await expect(extractCacheTarball(tarball, dest, hash)).rejects.toThrow(/EPERM/);
      expect(injected.hits).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});
