import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { packCachePaths, extractCacheTarball, resolveCachePath } from './cache-engine.js';

/**
 * Find a directory on a filesystem distinct from the OS tmpdir (where the
 * workspace dirs below are created), so a KICI_TMPDIR pointed at it forces a
 * real cross-device move. Prefers KICI_EXDEV_TEST_BASE, then /dev/shm (tmpfs on
 * Linux). Returns null when no distinct-device base is available.
 */
async function findCrossDeviceBase(): Promise<string | null> {
  const tmpDev = (await stat(tmpdir())).dev;
  const candidates = [process.env.KICI_EXDEV_TEST_BASE, '/dev/shm'].filter((c): c is string => !!c);
  for (const base of candidates) {
    try {
      if ((await stat(base)).dev !== tmpDev) return base;
    } catch {
      // candidate not present on this host; try the next
    }
  }
  return null;
}

const crossDeviceBase = await findCrossDeviceBase();

describe('cache-engine pack/extract', () => {
  it('packs paths to a gzip tar with a sha256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cache-src-'));
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'a.txt'), 'hello');
      const { tarball, hash } = await packCachePaths(root, ['dist']);
      expect(tarball.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts a tarball and round-trips file content (repo-relative path)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cache-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'cache-dst-'));
    try {
      await mkdir(join(root, 'dist', 'nested'), { recursive: true });
      await writeFile(join(root, 'dist', 'a.txt'), 'hello');
      await writeFile(join(root, 'dist', 'nested', 'b.txt'), 'world');
      const { tarball, hash } = await packCachePaths(root, ['dist']);
      await extractCacheTarball(tarball, dest, hash);
      expect((await readFile(join(dest, 'dist', 'a.txt'))).toString()).toBe('hello');
      expect((await readFile(join(dest, 'dist', 'nested', 'b.txt'))).toString()).toBe('world');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('round-trips a home-anchored (~) path to the destination homedir override', async () => {
    const srcHome = await mkdtemp(join(tmpdir(), 'cache-home-'));
    const dstHome = await mkdtemp(join(tmpdir(), 'cache-home-dst-'));
    const root = await mkdtemp(join(tmpdir(), 'cache-src-'));
    try {
      await mkdir(join(srcHome, '.cache'), { recursive: true });
      await writeFile(join(srcHome, '.cache', 'c.txt'), 'cached');
      const { tarball, hash } = await packCachePaths(root, ['~/.cache'], { home: srcHome });
      await extractCacheTarball(tarball, root, hash, { home: dstHome });
      expect((await readFile(join(dstHome, '.cache', 'c.txt'))).toString()).toBe('cached');
    } finally {
      await rm(srcHome, { recursive: true, force: true });
      await rm(dstHome, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws an actionable error on checksum mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cache-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'cache-dst-'));
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'a.txt'), 'hello');
      const { tarball } = await packCachePaths(root, ['dist']);
      await expect(extractCacheTarball(tarball, dest, 'deadbeef')).rejects.toThrow(
        /checksum|hash/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('resolves ~ against homedir and rejects path escapes', () => {
    expect(resolveCachePath('/work', '~/.cache')).toBe(join(homedir(), '.cache'));
    expect(resolveCachePath('/work', '~')).toBe(homedir());
    expect(resolveCachePath('/work', 'dist')).toBe('/work/dist');
    expect(() => resolveCachePath('/work', '../etc')).toThrow();
    expect(() => resolveCachePath('/work', '/abs/outside')).toThrow();
  });

  it('finds a cross-device base on Linux (sanity for the EXDEV test below)', () => {
    if (platform() !== 'linux') return;
    // /dev/shm is tmpfs on stock Linux, on a different device from /tmp — so the
    // real cross-device path is always exercised here and never silently skipped.
    expect(crossDeviceBase).not.toBeNull();
  });

  it.skipIf(crossDeviceBase === null)(
    'round-trips a tarball when KICI_TMPDIR is on a different filesystem from the workspace',
    async () => {
      const base = crossDeviceBase as string;
      const savedTmpdir = process.env.KICI_TMPDIR;
      const scratchBase = await mkdtemp(join(base, 'kici-exdev-'));
      const root = await mkdtemp(join(tmpdir(), 'cache-src-'));
      const dest = await mkdtemp(join(tmpdir(), 'cache-dst-'));
      try {
        process.env.KICI_TMPDIR = scratchBase;
        // Re-assert at run time that the scratch base and the destination really
        // are on different devices, so a green result can never be vacuous.
        expect((await stat(scratchBase)).dev).not.toBe((await stat(dest)).dev);
        await mkdir(join(root, 'dist', 'nested'), { recursive: true });
        await writeFile(join(root, 'dist', 'a.txt'), 'hello');
        await writeFile(join(root, 'dist', 'nested', 'b.txt'), 'world');
        const { tarball, hash } = await packCachePaths(root, ['dist']);
        await extractCacheTarball(tarball, dest, hash);
        expect((await readFile(join(dest, 'dist', 'a.txt'))).toString()).toBe('hello');
        expect((await readFile(join(dest, 'dist', 'nested', 'b.txt'))).toString()).toBe('world');
      } finally {
        if (savedTmpdir === undefined) delete process.env.KICI_TMPDIR;
        else process.env.KICI_TMPDIR = savedTmpdir;
        await rm(scratchBase, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
        await rm(dest, { recursive: true, force: true });
      }
    },
  );
});
