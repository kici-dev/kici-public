import { afterEach, describe, expect, it } from 'vitest';
import type { Stats } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { c as tarCreate, t as tarList, x as tarExtract } from 'tar';
import { singleLinkTarCaches } from './tar-single-link.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kici-tar-single-link-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

/** Drain a pack stream; resolves `'timeout'` when it has not ended after `ms`. */
async function drain(stream: AsyncIterable<unknown>, ms: number): Promise<Buffer | 'timeout'> {
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function entryTypes(tarball: Buffer, dir: string): Promise<Map<string, string>> {
  const file = path.join(dir, 'archive.tar');
  await writeFile(file, tarball);
  const types = new Map<string, string>();
  await tarList({ file, onReadEntry: (e) => types.set(e.path, e.type) });
  return types;
}

/**
 * The smallest order that stops node-tar 7.5.22: a hard-linked file read ahead
 * of the queue head is deferred, and the plain files behind it take every job
 * slot before the head can be written.
 */
const INTERLEAVED = ['a', 'b-link', 'c', 'd', 'e-twin', 'f'];

async function interleavedFixture(): Promise<string> {
  const root = await tempDir();
  await write(root, 'shared', 'shared content\n');
  for (const name of ['a', 'c', 'd', 'f']) await write(root, name, `${name}\n`);
  await link(path.join(root, 'shared'), path.join(root, 'b-link'));
  await link(path.join(root, 'shared'), path.join(root, 'e-twin'));
  return root;
}

describe('singleLinkTarCaches', () => {
  it('the interleaved hard-link fixture stops node-tar without the caches', async () => {
    // Positive control for the next test: without it, a node-tar release that
    // fixes the deferral would leave that test passing for no reason.
    const root = await interleavedFixture();
    const result = await drain(tarCreate({ cwd: root, portable: true }, INTERLEAVED), 2_000);
    expect(result).toBe('timeout');
  });

  it('packs the interleaved hard links as regular files with the caches', async () => {
    const root = await interleavedFixture();
    // fails-when: the cache keys miss node-tar's lookup, so it lstats the real
    // link count and stops exactly as in the control above
    const caches = await singleLinkTarCaches(root, INTERLEAVED);
    const result = await drain(
      tarCreate({ cwd: root, portable: true, ...caches }, INTERLEAVED),
      10_000,
    );
    expect(result).not.toBe('timeout');
    const tarball = result as Buffer;

    // breaks-if-wrong: each link must ship its own content, not a link entry
    const types = await entryTypes(tarball, await tempDir());
    expect([...types]).toEqual(INTERLEAVED.map((name) => [name, 'File']));
    const out = await tempDir();
    await writeFile(path.join(out, 'archive.tar'), tarball);
    await tarExtract({ file: path.join(out, 'archive.tar'), cwd: out });
    expect(await readFile(path.join(out, 'b-link'), 'utf-8')).toBe('shared content\n');
    expect(await readFile(path.join(out, 'e-twin'), 'utf-8')).toBe('shared content\n');
    expect(await readFile(path.join(out, 'd'), 'utf-8')).toBe('d\n');
  });

  it('keys both caches exactly as node-tar does for a directory walk', async () => {
    // No hard links here, so node-tar packs on its own and fills the maps it
    // is handed with the keys it looks up.
    const root = await tempDir();
    await write(root, 'pkg/index.js', 'x\n');
    await write(root, 'pkg/lib/deep/a.js', 'a\n');
    await write(root, 'skip/huge/file.js', 'h\n');
    await mkdir(path.join(root, 'empty'));
    await symlink('pkg', path.join(root, 'pkg-link'));
    const filter = (p: string): boolean => p !== './skip/huge';

    const own = { statCache: new Map<string, Stats>(), readdirCache: new Map<string, string[]>() };
    await drain(tarCreate({ cwd: root, portable: true, filter, ...own }, ['.']), 10_000);
    const ours = await singleLinkTarCaches(root, ['.'], { filter });

    // fails-when: a key is cwd-relative or carries a trailing separator
    expect([...ours.statCache.keys()].sort()).toEqual([...own.statCache.keys()].sort());
    expect([...ours.readdirCache.keys()].sort()).toEqual([...own.readdirCache.keys()].sort());
    // the symbolic link is recorded as a link, never followed into `pkg`
    expect(ours.statCache.get(path.join(root, 'pkg-link'))?.isSymbolicLink()).toBe(true);
    expect(ours.readdirCache.has(path.join(root, 'pkg-link'))).toBe(false);
    expect(ours.readdirCache.has(path.join(root, 'skip/huge'))).toBe(false);
  });

  it('packs a pnpm-like node_modules directory and restores identical content', async () => {
    const root = await tempDir();
    const store = await tempDir();
    const files = new Map<string, string>();
    for (let p = 0; p < 6; p++) {
      const pkg = `node_modules/.pnpm/p${p}@1.0.0/node_modules/p${p}`;
      for (let f = 0; f < 8; f++) {
        const rel = `${pkg}/f${f}.js`;
        files.set(rel, `module ${p}.${f}\n`);
        await write(root, rel, files.get(rel)!);
      }
      // Identical LICENSE files share one store inode, as pnpm installs them.
      const license = path.join(store, 'LICENSE');
      if (p === 0) await writeFile(license, 'MIT\n');
      await link(license, path.join(root, `${pkg}/LICENSE`));
      files.set(`${pkg}/LICENSE`, 'MIT\n');
      await symlink(`.pnpm/p${p}@1.0.0/node_modules/p${p}`, path.join(root, `node_modules/p${p}`));
    }

    const caches = await singleLinkTarCaches(root, ['node_modules']);
    const result = await drain(
      tarCreate({ cwd: root, gzip: true, portable: true, ...caches }, ['node_modules']),
      20_000,
    );
    expect(result).not.toBe('timeout');

    const out = await tempDir();
    await writeFile(path.join(out, 'deps.tgz'), result as Buffer);
    await tarExtract({ file: path.join(out, 'deps.tgz'), cwd: out });
    for (const [rel, content] of files) {
      expect(await readFile(path.join(out, rel), 'utf-8'), rel).toBe(content);
    }
    expect(await readlink(path.join(out, 'node_modules/p3'))).toBe(
      '.pnpm/p3@1.0.0/node_modules/p3',
    );
    expect(await readFile(path.join(out, 'node_modules/p3/f2.js'), 'utf-8')).toBe('module 3.2\n');
  });
});
