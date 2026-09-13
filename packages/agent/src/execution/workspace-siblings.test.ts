import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { collectInRepoSiblings, resolveYarnNodeModulesRoot } from './workspace-siblings.js';

describe('collectInRepoSiblings', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-wsibs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds an in-repo sibling symlinked from a seed node_modules', async () => {
    const kiciDir = join(root, '.kici');
    const sib = join(root, 'packages', 'sib');
    await mkdir(join(kiciDir, 'node_modules', '@t'), { recursive: true });
    await mkdir(sib, { recursive: true });
    await symlink('../../../packages/sib', join(kiciDir, 'node_modules', '@t', 'sib'));

    const found = await collectInRepoSiblings(root, kiciDir, join(kiciDir, 'node_modules'));
    expect(found).toEqual([join('packages', 'sib')]);
  });

  it('finds a sibling symlinked from the hoisted root node_modules', async () => {
    const kiciDir = join(root, '.kici');
    const sib = join(root, 'packages', 'sib');
    await mkdir(join(root, 'node_modules', '@t'), { recursive: true });
    await mkdir(kiciDir, { recursive: true });
    await mkdir(sib, { recursive: true });
    await symlink('../../packages/sib', join(root, 'node_modules', '@t', 'sib'));

    const found = await collectInRepoSiblings(root, kiciDir, join(root, 'node_modules'));
    expect(found).toEqual([join('packages', 'sib')]);
  });

  it('ignores real (non-symlink) packages and excludes .kici itself', async () => {
    const kiciDir = join(root, '.kici');
    await mkdir(join(root, 'node_modules', 'lodash'), { recursive: true });
    await mkdir(join(kiciDir, 'node_modules'), { recursive: true });
    const found = await collectInRepoSiblings(root, kiciDir, join(root, 'node_modules'));
    expect(found).toEqual([]);
  });
});

describe('resolveYarnNodeModulesRoot', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-ynm-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns .kici/node_modules when it exists (standalone)', async () => {
    const kiciDir = join(root, '.kici');
    await mkdir(join(kiciDir, 'node_modules'), { recursive: true });
    expect(resolveYarnNodeModulesRoot(root, kiciDir)).toBe(join(kiciDir, 'node_modules'));
    expect(existsSync(resolveYarnNodeModulesRoot(root, kiciDir))).toBe(true);
  });

  it('returns the repo-root node_modules when .kici/node_modules is absent (hoisted)', async () => {
    const kiciDir = join(root, '.kici');
    await mkdir(kiciDir, { recursive: true });
    expect(resolveYarnNodeModulesRoot(root, kiciDir)).toBe(join(root, 'node_modules'));
  });
});
