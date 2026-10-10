import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { x as tarExtract } from 'tar';
import { packKiciSource } from './source-packer.js';

describe('packKiciSource', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-source-pack-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('packs hard-linked .kici files as their own content and leaves node_modules out', async () => {
    // Hard links into a store outside the repository, in the order (plain,
    // link, plain, plain, link, plain) that stops node-tar's own hard-link
    // handling for good.
    const workDir = path.join(root, 'repo');
    const store = path.join(root, 'store');
    const lib = path.join(workDir, '.kici', 'lib');
    await fs.mkdir(lib, { recursive: true });
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'shared.ts'), 'export {};\n');
    for (const name of ['a.ts', 'c.ts', 'd.ts', 'f.ts']) {
      await fs.writeFile(path.join(lib, name), `// ${name}\n`);
    }
    for (const name of ['b.ts', 'e.ts']) {
      await fs.link(path.join(store, 'shared.ts'), path.join(lib, name));
    }
    await fs.mkdir(path.join(workDir, '.kici', 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(workDir, '.kici', 'node_modules', 'dep', 'index.js'), '1;\n');

    // fails-when: packKiciSource hands node-tar no single-link caches, so the
    // pack never ends and this test times out
    const { tarball } = await packKiciSource(workDir);

    const out = path.join(root, 'out');
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'source.tgz'), tarball);
    await tarExtract({ file: path.join(out, 'source.tgz'), cwd: out });
    // breaks-if-wrong: each linked file restores with the store's content
    const restored = path.join(out, '.kici', 'lib');
    for (const name of ['a.ts', 'c.ts', 'd.ts', 'f.ts']) {
      expect(await fs.readFile(path.join(restored, name), 'utf-8')).toBe(`// ${name}\n`);
    }
    for (const name of ['b.ts', 'e.ts']) {
      expect(await fs.readFile(path.join(restored, name), 'utf-8')).toBe('export {};\n');
    }
    await expect(fs.access(path.join(out, '.kici', 'node_modules'))).rejects.toThrow(/ENOENT/);
  }, 15_000);
});
