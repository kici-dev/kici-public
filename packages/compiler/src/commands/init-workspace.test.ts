import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkspaceKind, YarnFlavor } from '@kici-dev/core/package-manager';
import {
  MemberRegistration,
  addManifestWorkspace,
  addMissingVersion,
  addPnpmWorkspacePackage,
  memberEntry,
  memberSiblingSpecifier,
  registerKiciWorkspaceMember,
} from './init-workspace.js';

const PNPM_WS = [
  '# Workspace members',
  'packages:',
  "  - 'packages/*' # libs",
  '  - "apps/*"',
  '',
  '# build settings',
  'onlyBuiltDependencies:',
  '  - esbuild',
  '',
].join('\n');

describe('addPnpmWorkspacePackage', () => {
  it('appends the entry and keeps every original line verbatim', () => {
    const out = addPnpmWorkspacePackage(PNPM_WS, '.kici');
    // fails-when: the file is rewritten through parse + stringify, which drops
    // comments and normalizes quotes
    for (const line of PNPM_WS.split('\n').filter(Boolean)) expect(out).toContain(line);
    expect((parseYaml(out) as { packages: string[] }).packages).toEqual([
      'packages/*',
      'apps/*',
      '.kici',
    ]);
  });

  it('creates packages: when the file declares none', () => {
    const out = addPnpmWorkspacePackage('onlyBuiltDependencies:\n  - esbuild\n', '.kici');
    const doc = parseYaml(out) as { packages: string[]; onlyBuiltDependencies: string[] };
    expect(doc.packages).toEqual(['.kici']);
    expect(doc.onlyBuiltDependencies).toEqual(['esbuild']);
  });
});

describe('addManifestWorkspace', () => {
  it('appends to the array form and keeps a 4-space indent and the trailing newline', () => {
    const raw = JSON.stringify({ name: 'r', workspaces: ['packages/*'] }, null, 4) + '\n';
    const out = addManifestWorkspace(raw, '.kici');
    expect(JSON.parse(out).workspaces).toEqual(['packages/*', '.kici']);
    expect(out).toContain('\n    "name"');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('appends to the { packages } form and keeps every other field', () => {
    const raw = JSON.stringify({
      name: 'r',
      workspaces: { packages: ['packages/*'], nohoist: ['**/x'] },
      dependencies: { lodash: '^4.17.21' },
    });
    const out = JSON.parse(addManifestWorkspace(raw, '.kici'));
    expect(out.workspaces).toEqual({ packages: ['packages/*', '.kici'], nohoist: ['**/x'] });
    expect(out.dependencies).toEqual({ lodash: '^4.17.21' });
  });
});

describe('registerKiciWorkspaceMember', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-member-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('adds .kici to pnpm-workspace.yaml once; a second call changes nothing', async () => {
    await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), PNPM_WS);
    const kici = path.join(root, '.kici');
    expect(await registerKiciWorkspaceMember(root, WorkspaceKind.Pnpm, kici)).toBe(
      MemberRegistration.Added,
    );
    const once = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf-8');
    // fails-when: the membership check is skipped and the entry is appended again
    expect(await registerKiciWorkspaceMember(root, WorkspaceKind.Pnpm, kici)).toBe(
      MemberRegistration.AlreadyMember,
    );
    expect(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf-8')).toBe(once);
  });

  it('adds .kici to the root package.json workspaces for npm and yarn', async () => {
    for (const kind of [WorkspaceKind.Npm, WorkspaceKind.Yarn]) {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }, null, 2) + '\n',
      );
      await registerKiciWorkspaceMember(root, kind, path.join(root, '.kici'));
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
      expect(pkg.workspaces).toEqual(['packages/*', '.kici']);
    }
  });

  it('names a nested .kici by its path from the workspace root', () => {
    expect(memberEntry('/r', path.join('/r', 'apps', 'web', '.kici'))).toBe('apps/web/.kici');
  });
});

describe('memberSiblingSpecifier', () => {
  it.each([
    [WorkspaceKind.Pnpm, YarnFlavor.Classic, 'workspace:*'],
    [WorkspaceKind.Yarn, YarnFlavor.Berry, 'workspace:*'],
    [WorkspaceKind.Yarn, YarnFlavor.Classic, '^<version>'],
    [WorkspaceKind.Npm, YarnFlavor.Classic, '^<version>'],
  ])('%s/%s declares a sibling as %s', (kind, flavor, spec) => {
    // fails-when: npm or yarn classic is told to use workspace:*, which the
    // agent's dependency guard rejects before install
    expect(memberSiblingSpecifier(kind, flavor)).toBe(spec);
  });
});

describe('addMissingVersion', () => {
  it('adds version 0.0.0 after the name, keeping the indent and trailing newline', () => {
    const raw = JSON.stringify({ name: '@kici-dev/workflows', private: true }, null, 4) + '\n';
    const out = addMissingVersion(raw);
    // fails-when: an existing yarn classic member keeps a manifest with no version,
    // which yarn ignores
    expect(Object.keys(JSON.parse(out))).toEqual(['name', 'version', 'private']);
    expect(JSON.parse(out).version).toBe('0.0.0');
    expect(out).toContain('\n    "version"');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('leaves a manifest that has a version byte-identical', () => {
    const raw = '{"name":"w","version":"1.2.3"}';
    // breaks-if-wrong: a user-set version is never rewritten
    expect(addMissingVersion(raw)).toBe(raw);
  });
});
