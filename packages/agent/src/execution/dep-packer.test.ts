import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { packNodeModules } from './dep-packer.js';
import { restoreDeps } from './dep-restore.js';

/** Write a packed tarball to disk and return a file:// URL for restore. */
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

    // Two in-repo workspace siblings with built output; action-github depends
    // on action-core via a workspace symlink (transitive closure).
    const ghDir = join(src, 'actions', 'github');
    const coreDir = join(src, 'actions', 'core');
    await mkdir(join(ghDir, 'dist'), { recursive: true });
    await mkdir(join(coreDir, 'dist'), { recursive: true });
    await writeFile(join(ghDir, 'dist', 'index.js'), 'github');
    await writeFile(join(ghDir, 'package.json'), '{"name":"@kici-dev/action-github"}');
    await writeFile(join(coreDir, 'dist', 'index.js'), 'core');
    await writeFile(join(coreDir, 'package.json'), '{"name":"@kici-dev/action-core"}');
    await mkdir(join(ghDir, 'node_modules', '@kici-dev'), { recursive: true });
    await symlink('../../../core', join(ghDir, 'node_modules', '@kici-dev', 'action-core'));

    // .kici depends on action-github via a workspace symlink.
    await mkdir(join(kiciDir, 'node_modules', '@kici-dev'), { recursive: true });
    await writeFile(
      join(kiciDir, 'package.json'),
      '{"name":"k","dependencies":{"@kici-dev/action-github":"workspace:*"}}',
    );
    await symlink(
      '../../../actions/github',
      join(kiciDir, 'node_modules', '@kici-dev', 'action-github'),
    );

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
    // The .kici → action-github symlink resolves to the restored sibling dir.
    const ghLink = join(dst, '.kici', 'node_modules', '@kici-dev', 'action-github');
    expect((await stat(ghLink)).isDirectory()).toBe(true); // resolves through the symlink
    expect(await realpath(ghLink)).toBe(await realpath(join(dst, 'actions', 'github')));
    expect(await readFile(join(dst, 'actions', 'github', 'dist', 'index.js'), 'utf-8')).toBe(
      'github',
    );
    // The transitive sibling (action-core) and its build output came along.
    expect(await readFile(join(dst, 'actions', 'core', 'dist', 'index.js'), 'utf-8')).toBe('core');
    expect(
      await realpath(join(dst, 'actions', 'github', 'node_modules', '@kici-dev', 'action-core')),
    ).toBe(await realpath(join(dst, 'actions', 'core')));
  });

  it('yarn standalone: packs .kici/node_modules + in-repo sibling and restores', async () => {
    const src = join(root, 'src-ystand');
    const kiciDir = join(src, '.kici');
    const sib = join(src, 'packages', 'sib');
    await mkdir(join(kiciDir, 'node_modules', '@t'), { recursive: true });
    await mkdir(sib, { recursive: true });
    await writeFile(join(src, 'yarn.lock'), '# yarn lockfile v1\n'); // marks yarn
    await writeFile(join(sib, 'index.js'), 'module.exports=1');
    await symlink('../../../packages/sib', join(kiciDir, 'node_modules', '@t', 'sib'));

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

    const { tarball } = await packNodeModules(kiciDir);

    const dst = join(root, 'dst-yhoist');
    await mkdir(join(dst, '.kici'), { recursive: true });
    await restoreDeps(dst, await tarballUrl(root, tarball));
    expect(existsSync(join(dst, 'node_modules', 'lodash', 'index.js'))).toBe(true);
    expect(existsSync(join(dst, 'node_modules', '@t', 'sib'))).toBe(true);
    expect(existsSync(join(dst, 'packages', 'sib', 'index.js'))).toBe(true);
  });
});
