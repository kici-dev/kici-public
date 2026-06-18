import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PackageManager, YarnFlavor } from '@kici-dev/shared/package-manager';
import {
  findLocalProtocolDeps,
  formatUnresolvableDepError,
  kiciHasLocalProtocolDeps,
  assertResolvableDeps,
  LocalDepProtocol,
  type LocalProtocolDep,
} from './validate-kici-deps.js';

describe('findLocalProtocolDeps', () => {
  it('flags a workspace:* dependency', () => {
    const pkg = { dependencies: { '@kici-dev/action-github': 'workspace:*' } };
    expect(findLocalProtocolDeps(pkg)).toEqual<LocalProtocolDep[]>([
      {
        name: '@kici-dev/action-github',
        spec: 'workspace:*',
        protocol: LocalDepProtocol.Workspace,
      },
    ]);
  });

  it('flags file:, link:, and portal: specifiers across dep fields', () => {
    const pkg = {
      dependencies: { 'pkg-a': 'file:../pkg-a', 'pkg-b': 'link:../pkg-b' },
      devDependencies: { 'pkg-c': 'portal:../pkg-c' },
    };
    expect(findLocalProtocolDeps(pkg)).toEqual<LocalProtocolDep[]>([
      { name: 'pkg-a', spec: 'file:../pkg-a', protocol: LocalDepProtocol.File },
      { name: 'pkg-b', spec: 'link:../pkg-b', protocol: LocalDepProtocol.Link },
      { name: 'pkg-c', spec: 'portal:../pkg-c', protocol: LocalDepProtocol.Portal },
    ]);
  });

  it('scans optionalDependencies and peerDependencies too', () => {
    const pkg = {
      optionalDependencies: { 'opt-a': 'workspace:^1.0.0' },
      peerDependencies: { 'peer-a': 'link:../peer-a' },
    };
    expect(findLocalProtocolDeps(pkg)).toEqual<LocalProtocolDep[]>([
      { name: 'opt-a', spec: 'workspace:^1.0.0', protocol: LocalDepProtocol.Workspace },
      { name: 'peer-a', spec: 'link:../peer-a', protocol: LocalDepProtocol.Link },
    ]);
  });

  it('returns empty for normal semver / registry / git / url / npm-alias deps', () => {
    const pkg = {
      dependencies: {
        '@kici-dev/sdk': '^1.2.3',
        zod: '3.23.8',
        'some-pkg': '>=0.0.1-0',
        myalias: 'npm:left-pad@1.3.0',
        'git-dep': 'git+https://example.com/repo.git',
        'tarball-dep': 'https://example.com/x.tgz',
      },
    };
    expect(findLocalProtocolDeps(pkg)).toEqual([]);
  });

  it('returns empty for missing/empty dep maps and ignores non-string specs', () => {
    expect(findLocalProtocolDeps({})).toEqual([]);
    expect(findLocalProtocolDeps({ dependencies: {} })).toEqual([]);
    expect(findLocalProtocolDeps({ name: 'x', version: '1.0.0' })).toEqual([]);
    expect(findLocalProtocolDeps({ dependencies: { weird: 123 as unknown as string } })).toEqual(
      [],
    );
  });
});

describe('formatUnresolvableDepError', () => {
  it('explains the npm case (no workspace protocol)', () => {
    const msg = formatUnresolvableDepError(
      [
        {
          name: '@kici-dev/action-github',
          spec: 'workspace:*',
          protocol: LocalDepProtocol.Workspace,
        },
      ],
      PackageManager.Npm,
      YarnFlavor.Classic,
    );
    expect(msg).toContain('@kici-dev/action-github: workspace:*');
    expect(msg).toMatch(/npm/);
    expect(msg).toMatch(/pnpm/);
  });

  it('explains the pnpm case (outside the cloned repo)', () => {
    const msg = formatUnresolvableDepError(
      [{ name: 'pkg-b', spec: 'file:/etc/pkg-b', protocol: LocalDepProtocol.File }],
      PackageManager.Pnpm,
      YarnFlavor.Classic,
    );
    expect(msg).toContain('pkg-b: file:/etc/pkg-b');
    expect(msg).toMatch(/pnpm-workspace\.yaml|inside this repository/);
  });
});

describe('assertResolvableDeps', () => {
  let repoRoot: string;
  let kiciDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-resolvable-'));
    kiciDir = path.join(repoRoot, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeKiciPkg(deps: Record<string, string>): Promise<void> {
    await fs.writeFile(
      path.join(kiciDir, 'package.json'),
      JSON.stringify({ name: 'kici', type: 'module', dependencies: deps }),
      'utf-8',
    );
  }

  it('no-ops when .kici/package.json is missing', async () => {
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).resolves.toBeUndefined();
  });

  it('no-ops for registry-only deps', async () => {
    await writeKiciPkg({ '@kici-dev/sdk': '^0.1.5' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).resolves.toBeUndefined();
  });

  it('rejects workspace:* for npm', async () => {
    await writeKiciPkg({ '@kici-dev/action-github': 'workspace:*' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Npm }),
    ).rejects.toThrow(/@kici-dev\/action-github: workspace:\*/);
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Npm }),
    ).rejects.not.toThrow(/EUNSUPPORTEDPROTOCOL/);
  });

  it('allows workspace:* for pnpm when a pnpm-workspace.yaml is present', async () => {
    await writeKiciPkg({ '@kici-dev/action-github': 'workspace:*' });
    await fs.writeFile(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - .kici\n',
      'utf-8',
    );
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).resolves.toBeUndefined();
  });

  it('rejects workspace:* for pnpm when there is no pnpm-workspace.yaml', async () => {
    await writeKiciPkg({ '@kici-dev/action-github': 'workspace:*' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).rejects.toThrow(/pnpm-workspace\.yaml/);
  });

  it('allows a file: path that stays inside the repo (pnpm)', async () => {
    await writeKiciPkg({ 'pkg-a': 'file:../pkg-a' });
    await fs.writeFile(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - .kici\n',
      'utf-8',
    );
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).resolves.toBeUndefined();
  });

  it('rejects a file: path that escapes the repo (pnpm)', async () => {
    await writeKiciPkg({ 'pkg-a': 'file:/etc/pkg-a' });
    await fs.writeFile(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - .kici\n',
      'utf-8',
    );
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot, packageManager: PackageManager.Pnpm }),
    ).rejects.toThrow(/pkg-a: file:\/etc\/pkg-a/);
  });
});

describe('yarn classic local-protocol resolution', () => {
  let root: string;
  let kiciDir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-yarnval-'));
    kiciDir = path.join(root, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeKici(deps: Record<string, string>): Promise<void> {
    await fs.writeFile(
      path.join(kiciDir, 'package.json'),
      JSON.stringify({ name: 'k', type: 'module', dependencies: deps }, null, 2),
    );
  }

  it('rejects a workspace: dependency (yarn v1 has no workspace protocol)', async () => {
    await writeKici({ '@t/sib': 'workspace:*' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot: root, packageManager: PackageManager.Yarn }),
    ).rejects.toThrow(/@t\/sib: workspace:\*/);
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot: root, packageManager: PackageManager.Yarn }),
    ).rejects.toThrow(/yarn classic|version range|pnpm/i);
  });

  it('rejects a portal: dependency (berry-only)', async () => {
    await writeKici({ '@t/p': 'portal:../p' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot: root, packageManager: PackageManager.Yarn }),
    ).rejects.toThrow(/@t\/p: portal:/);
  });

  it('allows a file: dependency that stays inside the repo', async () => {
    await fs.mkdir(path.join(root, 'vendor', 'lib'), { recursive: true });
    await writeKici({ lib: 'file:../vendor/lib' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot: root, packageManager: PackageManager.Yarn }),
    ).resolves.toBeUndefined();
  });

  it('rejects a file: dependency that escapes the repo', async () => {
    await writeKici({ lib: 'file:../../outside' });
    await expect(
      assertResolvableDeps({ kiciDir, repoRoot: root, packageManager: PackageManager.Yarn }),
    ).rejects.toThrow(/outside the cloned repository|lib: file:/);
  });
});

describe('assertResolvableDeps — yarn berry', () => {
  let root: string;
  let kiciDir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-berryval-'));
    kiciDir = path.join(root, '.kici');
    await fs.mkdir(kiciDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeRepo(args: {
    root: Record<string, unknown>;
    kici: Record<string, unknown>;
  }): Promise<void> {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(args.root, null, 2));
    await fs.writeFile(path.join(kiciDir, 'package.json'), JSON.stringify(args.kici, null, 2));
  }

  it('accepts workspace: when the root package.json declares workspaces', async () => {
    await writeRepo({
      root: { workspaces: ['.kici', 'packages/*'] },
      kici: { dependencies: { '@t/sib': 'workspace:*' } },
    });
    await expect(
      assertResolvableDeps({
        kiciDir,
        repoRoot: root,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Berry,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects workspace: when no workspaces array is declared', async () => {
    await writeRepo({
      root: {},
      kici: { dependencies: { '@t/sib': 'workspace:*' } },
    });
    await expect(
      assertResolvableDeps({
        kiciDir,
        repoRoot: root,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Berry,
      }),
    ).rejects.toThrow(/workspaces/);
  });

  it('accepts an inside-repo portal: dependency', async () => {
    await writeRepo({
      root: { workspaces: ['.kici'] },
      kici: { dependencies: { '@t/p': 'portal:../packages/p' } },
    });
    await expect(
      assertResolvableDeps({
        kiciDir,
        repoRoot: root,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Berry,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a portal: dependency that escapes the repo', async () => {
    await writeRepo({
      root: { workspaces: ['.kici'] },
      kici: { dependencies: { '@t/p': 'portal:../../outside' } },
    });
    await expect(
      assertResolvableDeps({
        kiciDir,
        repoRoot: root,
        packageManager: PackageManager.Yarn,
        yarnFlavor: YarnFlavor.Berry,
      }),
    ).rejects.toThrow(/@t\/p: portal:\.\.\/\.\.\/outside/);
  });
});

describe('kiciHasLocalProtocolDeps', () => {
  let kiciDir: string;

  beforeEach(async () => {
    kiciDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-haslocal-'));
  });

  afterEach(async () => {
    await fs.rm(kiciDir, { recursive: true, force: true });
  });

  it('is true when a workspace: dep is present', async () => {
    await fs.writeFile(
      path.join(kiciDir, 'package.json'),
      JSON.stringify({ dependencies: { '@kici-dev/action-github': 'workspace:*' } }),
      'utf-8',
    );
    expect(await kiciHasLocalProtocolDeps(kiciDir)).toBe(true);
  });

  it('is false for registry-only deps and for a missing package.json', async () => {
    await fs.writeFile(
      path.join(kiciDir, 'package.json'),
      JSON.stringify({ dependencies: { '@kici-dev/sdk': '^0.1.5' } }),
      'utf-8',
    );
    expect(await kiciHasLocalProtocolDeps(kiciDir)).toBe(false);
    await fs.rm(path.join(kiciDir, 'package.json'));
    expect(await kiciHasLocalProtocolDeps(kiciDir)).toBe(false);
  });
});
