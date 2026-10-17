import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  link,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { packNodeModules } from './dep-packer.js';
import { restoreDeps } from './dep-restore.js';

/** A file:// URL for restore. */
async function tarballUrl(dir: string, tarball: Buffer): Promise<string> {
  const p = join(dir, 'deps.tar.gz');
  writeFileSync(p, tarball);
  return `file://${p}`;
}

describe('packNodeModules + restoreDeps round-trip', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-deppack-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('npm: packs .kici/node_modules repo-root-relative and restores it', async () => {
    const src = join(root, 'src');
    const kiciDir = join(src, '.kici');
    await mkdir(join(kiciDir, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(src, 'package-lock.json'), '{}'); // marks npm
    await writeFile(join(kiciDir, 'node_modules', 'foo', 'index.js'), 'module.exports=1');

    const { tarball, hash } = await packNodeModules(kiciDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Restore into a fresh work dir that only has .kici/ source.
    const dst = join(root, 'dst');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));

    const restored = await readFile(join(dst, '.kici', 'node_modules', 'foo', 'index.js'), 'utf-8');
    expect(restored).toBe('module.exports=1');
  });

  it('pnpm: packs the store + workspace siblings (transitively) and restores a resolvable graph', async () => {
    const src = join(root, 'src');
    const kiciDir = join(src, '.kici');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'pnpm-lock.yaml'), ''); // marks pnpm

    // Root virtual store with a third-party package (real file).
    const zodStore = join(src, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod');
    await mkdir(zodStore, { recursive: true });
    await writeFile(join(zodStore, 'index.js'), 'zod');

    // Two built workspace siblings; sdk links core (transitive closure).
    const sdkDir = join(src, 'packages', 'sdk');
    const coreDir = join(src, 'packages', 'core');
    await mkdir(join(sdkDir, 'dist'), { recursive: true });
    await mkdir(join(coreDir, 'dist'), { recursive: true });
    await writeFile(join(sdkDir, 'dist', 'index.js'), 'sdk');
    await writeFile(join(sdkDir, 'package.json'), '{"name":"@kici-dev/sdk"}');
    await writeFile(join(coreDir, 'dist', 'index.js'), 'core');
    await writeFile(join(coreDir, 'package.json'), '{"name":"@kici-dev/core"}');
    await mkdir(join(sdkDir, 'node_modules', '@kici-dev'), { recursive: true });
    await symlink('../../../core', join(sdkDir, 'node_modules', '@kici-dev', 'core'));

    // .kici depends on sdk via a workspace symlink.
    await mkdir(join(kiciDir, 'node_modules', '@kici-dev'), { recursive: true });
    await writeFile(
      join(kiciDir, 'package.json'),
      '{"name":"k","dependencies":{"@kici-dev/sdk":"workspace:*"}}',
    );
    await symlink('../../../packages/sdk', join(kiciDir, 'node_modules', '@kici-dev', 'sdk'));

    const { tarball } = await packNodeModules(kiciDir);

    // Restore into a fresh work dir that only has .kici/ source.
    const dst = join(root, 'dst');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));

    // The store restored as real files.
    expect(
      await readFile(
        join(dst, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod', 'index.js'),
        'utf-8',
      ),
    ).toBe('zod');
    // The .kici → sdk symlink resolves to the restored sibling dir.
    const sdkLink = join(dst, '.kici', 'node_modules', '@kici-dev', 'sdk');
    expect((await stat(sdkLink)).isDirectory()).toBe(true); // resolves through the symlink
    expect(await realpath(sdkLink)).toBe(await realpath(join(dst, 'packages', 'sdk')));
    expect(await readFile(join(dst, 'packages', 'sdk', 'dist', 'index.js'), 'utf-8')).toBe('sdk');
    // The transitive sibling (core) and its build output came along.
    expect(await readFile(join(dst, 'packages', 'core', 'dist', 'index.js'), 'utf-8')).toBe('core');
    expect(await realpath(join(dst, 'packages', 'sdk', 'node_modules', '@kici-dev', 'core'))).toBe(
      await realpath(join(dst, 'packages', 'core')),
    );
  });

  it('pnpm: packs hard-linked store files and restores identical content', async () => {
    const src = join(root, 'src-hardlinks');
    const kiciDir = join(src, '.kici');
    const pnpmStore = join(root, 'pnpm-store');
    await mkdir(pnpmStore, { recursive: true });
    await mkdir(join(kiciDir, 'node_modules'), { recursive: true });
    await writeFile(join(src, 'pnpm-lock.yaml'), '');
    await writeFile(join(pnpmStore, 'shared.d.ts'), 'export {};\n');

    // pnpm hard-links store files into the virtual store, so identical files of
    // one package share an inode. This order (plain, link, plain, plain, link,
    // plain) stops node-tar's own hard-link handling for good.
    const pkg = join(src, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod');
    await mkdir(pkg, { recursive: true });
    for (const name of ['a.js', 'c.js', 'd.js', 'f.js']) await writeFile(join(pkg, name), name);
    for (const name of ['b.d.ts', 'e.d.ts']) {
      await link(join(pnpmStore, 'shared.d.ts'), join(pkg, name));
    }
    await symlink(
      '../../node_modules/.pnpm/zod@1.0.0/node_modules/zod',
      join(kiciDir, 'node_modules', 'zod'),
    );

    // fails-when: packNodeModules hands node-tar no single-link caches, so
    // the pack never ends and this test times out
    const { tarball } = await packNodeModules(kiciDir);

    const dst = join(root, 'dst-hardlinks');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    // breaks-if-wrong: every linked path restores as a readable file with the
    // store's content, reached through the .kici symlink as Node resolves it
    const restored = join(dst, '.kici', 'node_modules', 'zod');
    for (const name of ['a.js', 'c.js', 'd.js', 'f.js']) {
      expect(await readFile(join(restored, name), 'utf-8')).toBe(name);
    }
    for (const name of ['b.d.ts', 'e.d.ts']) {
      expect(await readFile(join(restored, name), 'utf-8')).toBe('export {};\n');
    }
  }, 15_000);

  it('yarn standalone: packs .kici/node_modules + in-repo sibling and restores', async () => {
    const src = join(root, 'src-ystand');
    const kiciDir = join(src, '.kici');
    const sib = join(src, 'packages', 'sib');
    await mkdir(join(kiciDir, 'node_modules', '@t'), { recursive: true });
    await mkdir(sib, { recursive: true });
    await writeFile(join(src, 'yarn.lock'), '# yarn lockfile v1\n'); // marks yarn
    await writeFile(join(sib, 'index.js'), 'module.exports=1');
    await symlink('../../../packages/sib', join(kiciDir, 'node_modules', '@t', 'sib'));
    await writeFile(join(kiciDir, 'package.json'), '{"dependencies":{"@t/sib":"^1.0.0"}}');

    const { tarball, hash } = await packNodeModules(kiciDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const dst = join(root, 'dst-ystand');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    expect(existsSync(join(dst, '.kici', 'node_modules', '@t', 'sib'))).toBe(true);
    expect(existsSync(join(dst, 'packages', 'sib', 'index.js'))).toBe(true);
  });

  it('yarn hoisted: packs root node_modules + sibling when .kici/node_modules is absent', async () => {
    const src = join(root, 'src-yhoist');
    const kiciDir = join(src, '.kici');
    const sib = join(src, 'packages', 'sib');
    await mkdir(join(src, 'node_modules', '@t'), { recursive: true });
    await mkdir(join(src, 'node_modules', 'lodash'), { recursive: true });
    await mkdir(kiciDir, { recursive: true });
    await mkdir(sib, { recursive: true });
    await writeFile(join(src, 'yarn.lock'), '# yarn lockfile v1\n');
    await writeFile(join(src, 'node_modules', 'lodash', 'index.js'), 'module.exports=1');
    await writeFile(join(sib, 'index.js'), 'module.exports=2');
    await symlink('../../packages/sib', join(src, 'node_modules', '@t', 'sib'));
    await writeFile(join(kiciDir, 'package.json'), '{"dependencies":{"@t/sib":"^1.0.0"}}');

    const { tarball } = await packNodeModules(kiciDir);

    const dst = join(root, 'dst-yhoist');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    expect(existsSync(join(dst, 'node_modules', 'lodash', 'index.js'))).toBe(true);
    expect(existsSync(join(dst, 'node_modules', '@t', 'sib'))).toBe(true);
    expect(existsSync(join(dst, 'packages', 'sib', 'index.js'))).toBe(true);
  });

  async function npmMember(src: string): Promise<string> {
    const kiciDir = join(src, '.kici');
    await mkdir(kiciDir, { recursive: true });
    await writeFile(
      join(src, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['.kici', 'packages/*'] }),
    );
    await writeFile(join(src, 'package-lock.json'), '{}'); // marks npm
    await writeFile(
      join(kiciDir, 'package.json'),
      '{"name":"@kici-dev/workflows","dependencies":{"@e2e/utils":"^0.0.0"}}',
    );
    await mkdir(join(src, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(src, 'node_modules', 'zod', 'index.js'), 'zod-hoisted');
    await mkdir(join(src, 'node_modules', '@kici-dev'), { recursive: true });
    await symlink('../../.kici', join(src, 'node_modules', '@kici-dev', 'workflows'));
    await mkdir(join(src, 'packages', 'utils', 'dist'), { recursive: true });
    await writeFile(join(src, 'packages', 'utils', 'dist', 'index.js'), 'utils');
    await mkdir(join(src, 'node_modules', '@e2e'), { recursive: true });
    await symlink('../../packages/utils', join(src, 'node_modules', '@e2e', 'utils'));
    return kiciDir;
  }

  it('npm workspace member: packs the hoisted root node_modules and the linked siblings', async () => {
    const kiciDir = await npmMember(join(root, 'src-npm-member'));
    // fails-when: npm packs only .kici/node_modules, which a hoisted member does not
    // have, so packNodeModules throws and the build job fails
    const { tarball } = await packNodeModules(kiciDir);
    const dst = join(root, 'dst-npm-member');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    expect(await readFile(join(dst, 'node_modules', 'zod', 'index.js'), 'utf-8')).toBe(
      'zod-hoisted',
    );
    expect(await realpath(join(dst, 'node_modules', '@e2e', 'utils'))).toBe(
      await realpath(join(dst, 'packages', 'utils')),
    );
    expect(
      await readFile(join(dst, 'node_modules', '@e2e', 'utils', 'dist', 'index.js'), 'utf-8'),
    ).toBe('utils');
  });

  it('npm workspace member with a nested conflict: packs both node_modules roots', async () => {
    const src = join(root, 'src-npm-nested');
    const kiciDir = await npmMember(src);
    await mkdir(join(kiciDir, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(kiciDir, 'node_modules', 'zod', 'index.js'), 'zod-nested');
    const { tarball } = await packNodeModules(kiciDir);
    const dst = join(root, 'dst-npm-nested');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    expect(await readFile(join(dst, '.kici', 'node_modules', 'zod', 'index.js'), 'utf-8')).toBe(
      'zod-nested',
    );
    expect(await readFile(join(dst, 'node_modules', 'zod', 'index.js'), 'utf-8')).toBe(
      'zod-hoisted',
    );
  });

  it('npm standalone .kici: never packs an unrelated root node_modules', async () => {
    const src = join(root, 'src-npm-standalone');
    const kiciDir = join(src, '.kici');
    await mkdir(join(kiciDir, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(kiciDir, 'node_modules', 'foo', 'index.js'), 'foo');
    await writeFile(join(src, 'package-lock.json'), '{}');
    await mkdir(join(src, 'node_modules', 'repo-only'), { recursive: true });
    const { tarball } = await packNodeModules(kiciDir);
    const dst = join(root, 'dst-npm-standalone');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    // breaks-if-wrong: the standalone tarball carries the repo's own root dependencies
    expect(existsSync(join(dst, 'node_modules'))).toBe(false);
    expect(await readFile(join(dst, '.kici', 'node_modules', 'foo', 'index.js'), 'utf-8')).toBe(
      'foo',
    );
  });

  it('npm with no .kici/node_modules and an unrelated root node_modules: throws', async () => {
    const src = join(root, 'src-npm-uninstalled');
    await mkdir(join(src, '.kici'), { recursive: true });
    await writeFile(join(src, 'package-lock.json'), '{}');
    await mkdir(join(src, 'node_modules', 'repo-only'), { recursive: true });
    // fails-when: npm falls back to any root node_modules like yarn does, so an
    // uninstalled standalone .kici uploads the repo's own dependencies as its cache
    await expect(packNodeModules(join(src, '.kici'))).rejects.toThrow(/node_modules not found/);
  });
});
