import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';

import { hashKiciSourceTree } from '@kici-dev/core/kici-source-digest';

import { packKiciSource } from './source-packer.js';

/**
 * The seam the drift gate actually spans: producer tree → tarball → extraction
 * → the tree the agent re-hashes.
 *
 * Every other digest test hands one function one tree and never asks whether
 * that tree survives the round trip. A `.kici/node_modules` symlink does not:
 * the packer drops the path by prefix, and the restore renames an
 * already-installed dependency directory into the extracted tree. So the
 * producer hashed a member that could not exist on the other side, and eight
 * consecutive staging runs failed the drift gate against source nobody had
 * touched. This reproduces that in milliseconds.
 */
describe('the digest survives pack → extract → dependency install', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-source-roundtrip-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Write the producer's repository: `.kici/` plus the borrowed toolchain. */
  async function buildProducerRepo(): Promise<string> {
    const workDir = path.join(root, 'producer');
    const kiciDir = path.join(workDir, '.kici');
    await fs.mkdir(path.join(kiciDir, 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(kiciDir, 'workflows', 'deploy.ts'),
      'export const run = () => 1;\n',
      'utf-8',
    );
    await fs.writeFile(path.join(kiciDir, 'package.json'), '{"name":"x"}\n', 'utf-8');
    await fs.writeFile(path.join(kiciDir, '.npmrc'), 'registry=https://example.test\n', 'utf-8');

    // A sibling tree's dependencies, borrowed through a relative link rather
    // than installed again — the shape a multi-`.kici/` monorepo produces.
    const shared = path.join(workDir, 'shared-node-modules');
    await fs.mkdir(path.join(shared, 'dep'), { recursive: true });
    await fs.writeFile(path.join(shared, 'dep', 'index.js'), 'module.exports = 1;\n', 'utf-8');
    await fs.symlink('../shared-node-modules', path.join(kiciDir, 'node_modules'));

    return workDir;
  }

  /** Extract with the options `source-restore.ts` uses, then install deps. */
  async function restoreAgentRepo(tarball: Buffer): Promise<string> {
    const workDir = path.join(root, 'agent');
    await fs.mkdir(workDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      Readable.from(tarball)
        .pipe(tarExtract({ cwd: workDir, gzip: true }))
        .on('finish', resolve)
        .on('error', reject);
    });

    // Both restore paths end here: the deps tarball is renamed into the tree,
    // or `npm install` writes it. Either way it is a real directory.
    const installed = path.join(workDir, '.kici', 'node_modules', 'dep');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'index.js'), 'module.exports = 1;\n', 'utf-8');

    return workDir;
  }

  it('the agent recomputes the producer digest for a symlinked node_modules', async () => {
    const producer = await buildProducerRepo();
    const producerDigest = await hashKiciSourceTree(path.join(producer, '.kici'));

    const { tarball } = await packKiciSource(producer);
    const agent = await restoreAgentRepo(tarball);

    expect(await hashKiciSourceTree(path.join(agent, '.kici'))).toBe(producerDigest);
  });

  it('the tarball carries no node_modules member, which is why the shapes must agree', async () => {
    // fails-when: were the packer to ship `.kici/node_modules`, the two sides
    // could agree for a reason this test does not test.
    const producer = await buildProducerRepo();
    const { tarball } = await packKiciSource(producer);
    const agent = await restoreAgentRepo(tarball);

    await fs.rm(path.join(agent, '.kici', 'node_modules'), { recursive: true, force: true });
    await expect(fs.lstat(path.join(agent, '.kici', 'node_modules'))).rejects.toThrow();
  });
});
