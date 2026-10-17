import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectInRepoSiblings,
  collectSiblingsFromRoots,
  isKiciWorkspaceMember,
  kiciDepsPresent,
  resolveKiciNodeModulesLayout,
} from './workspace-siblings.js';

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

describe('resolveKiciNodeModulesLayout', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-nmlayout-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const kici = () => join(root, '.kici');

  it('standalone: only .kici/node_modules', async () => {
    await mkdir(join(kici(), 'node_modules'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'unrelated'), { recursive: true });
    // breaks-if-wrong: a standalone .kici never claims the repo's own root node_modules
    expect(await resolveKiciNodeModulesLayout(root, kici())).toEqual({
      roots: [join(kici(), 'node_modules')],
      hoistedMember: false,
    });
  });

  it('hoisted npm/yarn member: the root node_modules that links .kici', async () => {
    await mkdir(kici(), { recursive: true });
    await mkdir(join(root, 'node_modules', '@kici-dev'), { recursive: true });
    await symlink('../../.kici', join(root, 'node_modules', '@kici-dev', 'workflows'));
    expect(await resolveKiciNodeModulesLayout(root, kici())).toEqual({
      roots: [join(root, 'node_modules')],
      hoistedMember: true,
    });
    // fails-when: the skip check reads only .kici/node_modules, so a hoisted member
    // reinstalls on every job
    expect(await kiciDepsPresent(root, kici())).toBe(true);
  });

  it('member with a nested conflict: both roots', async () => {
    await mkdir(join(kici(), 'node_modules', 'zod'), { recursive: true });
    await mkdir(join(root, 'node_modules', '@kici-dev'), { recursive: true });
    await symlink('../../.kici', join(root, 'node_modules', '@kici-dev', 'workflows'));
    // fails-when: an existing .kici/node_modules hides the hoisted root, so the
    // packed closure loses every hoisted package
    expect((await resolveKiciNodeModulesLayout(root, kici())).roots).toEqual([
      join(kici(), 'node_modules'),
      join(root, 'node_modules'),
    ]);
  });

  it('hoisted yarn tree that does not link .kici: the root node_modules', async () => {
    await mkdir(kici(), { recursive: true });
    await mkdir(join(root, 'node_modules', 'lodash'), { recursive: true });
    expect(await resolveKiciNodeModulesLayout(root, kici())).toEqual({
      roots: [join(root, 'node_modules')],
      hoistedMember: false,
    });
    // breaks-if-wrong: an unrelated root node_modules is not .kici's installed deps
    expect(await kiciDepsPresent(root, kici())).toBe(false);
  });

  it('nothing installed: no roots and no deps present', async () => {
    await mkdir(kici(), { recursive: true });
    expect(await resolveKiciNodeModulesLayout(root, kici())).toEqual({
      roots: [],
      hoistedMember: false,
    });
    expect(await kiciDepsPresent(root, kici())).toBe(false);
  });
});

describe('collectSiblingsFromRoots', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-declared-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function member(name: string, dir: string, deps: Record<string, string> = {}) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), JSON.stringify({ name, dependencies: deps }));
    const parts = name.split('/');
    const linkDir = join(root, 'node_modules', ...parts.slice(0, -1));
    await mkdir(linkDir, { recursive: true });
    const up = '../'.repeat(parts.length);
    await symlink(`${up}${dir}`, join(linkDir, parts[parts.length - 1]));
  }

  it('hoisted member: only the workspace packages .kici declares, transitively', async () => {
    await member('@kici-dev/workflows', '.kici', { '@t/sib': '^1.0.0' });
    await member('@t/sib', 'packages/sib', { '@t/deep': '*' });
    await member('@t/deep', 'packages/deep');
    await member('@t/unrelated', 'packages/unrelated');
    // fails-when: the walk follows every symlink in the hoisted root node_modules,
    // so an unrelated workspace package is built and packed with .kici's deps
    expect(
      await collectSiblingsFromRoots(root, join(root, '.kici'), [join(root, 'node_modules')]),
    ).toEqual([join('packages', 'sib'), join('packages', 'deep')]);
  });

  it('resolves a declared sibling nested under .kici/node_modules first', async () => {
    await member('@kici-dev/workflows', '.kici', { '@t/sib': 'file:../packages/sib' });
    await mkdir(join(root, 'packages', 'sib'), { recursive: true });
    await writeFile(join(root, 'packages', 'sib', 'package.json'), '{"name":"@t/sib"}');
    await mkdir(join(root, '.kici', 'node_modules', '@t'), { recursive: true });
    await symlink('../../../packages/sib', join(root, '.kici', 'node_modules', '@t', 'sib'));
    // breaks-if-wrong: a standalone .kici's own node_modules still yields its sibling
    expect(
      await collectSiblingsFromRoots(root, join(root, '.kici'), [
        join(root, '.kici', 'node_modules'),
      ]),
    ).toEqual([join('packages', 'sib')]);
  });
});

describe('isKiciWorkspaceMember', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kici-member-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const kici = () => join(root, '.kici');

  it('is true for an explicit entry in pnpm-workspace.yaml or package.json workspaces', async () => {
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n  - '.kici'\n",
    );
    expect(await isKiciWorkspaceMember(root, kici())).toBe(true);
    await rm(join(root, 'pnpm-workspace.yaml'));
    await writeFile(join(root, 'package.json'), '{"workspaces":{"packages":["./.kici/"]}}');
    expect(await isKiciWorkspaceMember(root, kici())).toBe(true);
  });

  it('is false for a wildcard, a negation, or no workspace', async () => {
    // fails-when: `*` matches the dot directory, so a standalone .kici next to a
    // `*` workspace has its private-registry overlay written to the root .npmrc
    await writeFile(join(root, 'package.json'), '{"workspaces":["*"]}');
    expect(await isKiciWorkspaceMember(root, kici())).toBe(false);
    await writeFile(join(root, 'package.json'), '{"workspaces":[".kici","!.kici"]}');
    expect(await isKiciWorkspaceMember(root, kici())).toBe(false);
    await writeFile(join(root, 'package.json'), '{"name":"r"}');
    expect(await isKiciWorkspaceMember(root, kici())).toBe(false);
  });
});
