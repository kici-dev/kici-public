/**
 * The runtime `--node <path>` names: its prefix and npm agree with the pinned
 * runtime the npm-source upgrade derives from a unit's launch spec, and every
 * runtime that could not run the release is refused before anything changes.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/test-support/tmp';
import {
  checkInstalledEngines,
  checkNodeFlagConflicts,
  installedPackageJsonPath,
  reRootLaunch,
  reRootPath,
  resolveNodeRuntime,
  satisfiesNodeRange,
} from './node-runtime.js';
import { resolveNpmInstallTarget } from '../../service/index.js';

/** A runner whose `node --version` prints `stdout` with exit `status`. */
function versionRunner(stdout = 'v24.22.1\n', status = 0) {
  return vi.fn((_cmd: string, _args: string[]) => ({ status, stdout, stderr: '' }));
}

const everything = { isExecutable: () => true, exists: () => true };

describe('resolveNodeRuntime', () => {
  it.each([
    {
      name: 'Unix',
      windows: false,
      node: '/opt/node-24.22.1/bin/node',
      prefix: '/opt/node-24.22.1',
      npmCli: '/opt/node-24.22.1/lib/node_modules/npm/bin/npm-cli.js',
      npm: '/opt/node-24.22.1/bin/npm',
    },
    {
      name: 'Windows',
      windows: true,
      node: 'C:\\node-24.22.1\\node.exe',
      prefix: 'C:\\node-24.22.1',
      npmCli: 'C:\\node-24.22.1\\node_modules\\npm\\bin\\npm-cli.js',
      npm: 'C:\\node-24.22.1\\npm.cmd',
    },
  ])('resolves prefix and npm for a $name node path', (row) => {
    const run = versionRunner();
    const res = resolveNodeRuntime(row.node, { windows: row.windows, run, ...everything });
    expect(res).toEqual({
      ok: true,
      nodeExecPath: row.node,
      nodeVersion: '24.22.1',
      globalPrefix: row.prefix,
      npmCliPath: row.npmCli,
      npmPath: row.npm,
      warnings: [],
    });
    expect(run).toHaveBeenCalledWith(row.node, ['--version']);
  });

  // The derivation must agree with the one the upgrade already uses for the
  // unit's own pinned node, or a move installs where the unit never reads.
  it.each([
    [
      false,
      '/opt/n/bin/node',
      '/opt/n/lib/node_modules/kici-admin/node_modules/@kici-dev/agent/dist/server.js',
    ],
    [
      true,
      'C:\\n\\node.exe',
      'C:\\n\\node_modules\\kici-admin\\node_modules\\@kici-dev\\agent\\dist\\server.js',
    ],
  ])('agrees with resolveNpmInstallTarget (windows=%s)', (windows, node, entry) => {
    const res = resolveNodeRuntime(node, { windows, run: versionRunner(), ...everything });
    const pinned = resolveNpmInstallTarget({ execPath: node, args: [entry] }, 'agent', {
      windows,
      exists: () => true,
    });
    expect(res.ok && pinned.ok).toBe(true);
    if (!res.ok || !pinned.ok) return;
    expect(res.globalPrefix).toBe(pinned.target.globalPrefix);
    expect(res.npmPath).toBe(pinned.target.npmPath);
    expect(pinned.target.npmInvocation).toEqual({ cmd: node, preArgs: [res.npmCliPath] });
  });

  // fails-when: a mise shim passes, and the service runs whatever node the
  // shim picks at each start.
  it('refuses a version-manager shim', () => {
    const run = versionRunner();
    const res = resolveNodeRuntime('/home/u/.local/share/mise/shims/node', {
      windows: false,
      run,
      ...everything,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/mise shim/);
      expect(res.reason).toContain('mise which node');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('warns about a path through a version-manager alias and still resolves it', () => {
    const res = resolveNodeRuntime('/home/u/.local/share/mise/installs/node/24/bin/node', {
      windows: false,
      run: versionRunner(),
      ...everything,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(/mise alias \(node\/24\)/);
    }
  });

  // breaks-if-wrong: a fixed mise install path is not an alias.
  it('does not warn about a fixed mise install path', () => {
    const res = resolveNodeRuntime('/home/u/.local/share/mise/installs/node/24.22.1/bin/node', {
      windows: false,
      run: versionRunner(),
      ...everything,
    });
    expect(res.ok && res.warnings).toEqual([]);
  });

  it('refuses a node with no npm beside it', () => {
    const res = resolveNodeRuntime('/opt/n/bin/node', {
      windows: false,
      run: versionRunner(),
      isExecutable: () => true,
      exists: (p) => !p.endsWith('npm-cli.js'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('/opt/n/lib/node_modules/npm/bin/npm-cli.js');
  });

  it('refuses a node that does not run', () => {
    const res = resolveNodeRuntime('/opt/n/bin/node', {
      windows: false,
      run: versionRunner('', 126),
      ...everything,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/did not run/);
  });

  it('refuses a node whose --version prints no Node.js version', () => {
    const res = resolveNodeRuntime('/opt/n/bin/node', {
      windows: false,
      run: versionRunner('Python 3.13.0\n'),
      ...everything,
    });
    expect(res.ok).toBe(false);
  });

  it('refuses a path that is not an executable file', () => {
    const run = versionRunner();
    const res = resolveNodeRuntime('/opt/n/bin/node', {
      windows: false,
      run,
      isExecutable: () => false,
      exists: () => true,
    });
    expect(res.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the real node this test runs on (positive control on the default seams)', () => {
    const res = resolveNodeRuntime(process.execPath, { windows: process.platform === 'win32' });
    // A node with npm beside it resolves; one without (a distro node) is refused
    // for npm, never for the version.
    if (res.ok) {
      expect(res.nodeVersion).toBe(process.versions.node);
    } else {
      expect(res.reason).toMatch(/npm-cli\.js/);
    }
  });
});

describe('satisfiesNodeRange', () => {
  it.each([
    ['24.22.1', '>=24.5.0', true],
    ['24.4.9', '>=24.5.0', false],
    ['22.20.0', '>=24.5.0', false],
    ['24.22.1', '>=20 <25', true],
    ['25.0.0', '>=20 <25', false],
    ['18.0.0', '^18.0.0 || >=24.5.0', true],
    ['24.22.1', '24.22.1', true],
    ['24.22.1', '>24.22.1', false],
    ['24.22.1', '<=24.22.1', true],
    ['24.22.1', '^24.5.0 || >=26', true],
    ['25.1.0', '^24.5.0 || >=26', false],
    ['26.0.0', '^24.5.0 || >=26', true],
    // fails-when: a partial version is read as its `.0` floor, so `<=24`
    // refuses 24.22.1 and `>24` accepts it.
    ['24.22.1', '<=24', true],
    ['25.0.0', '<=24', false],
    ['24.22.1', '>24', false],
    ['25.0.0', '>24', true],
    ['24.22.1', '>24.21', true],
    ['24.21.9', '>24.21', false],
    ['24.22.1', '<24', false],
    ['0.0.4', '^0.0.3', false],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });

  it('returns null for a range it cannot read', () => {
    expect(satisfiesNodeRange('24.22.1', 'lts/*')).toBeNull();
  });
});

describe('checkInstalledEngines — after the install, before the restart', () => {
  function pkgDir(engines?: Record<string, string>): string {
    const dir = makeTempDir('kici-node-engines-');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'kici-admin', version: '0.27.0', ...(engines ? { engines } : {}) }),
    );
    return path.join(dir, 'package.json');
  }

  it('refuses a node below the installed package engines.node', () => {
    const res = checkInstalledEngines({
      packageJsonPath: pkgDir({ node: '>=24.5.0' }),
      nodeVersion: '22.20.0',
      nodeExecPath: '/opt/n/bin/node',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/22\.20\.0.*>=24\.5\.0/);
  });

  it('accepts a node inside engines.node', () => {
    const res = checkInstalledEngines({
      packageJsonPath: pkgDir({ node: '>=24.5.0' }),
      nodeVersion: '24.22.1',
      nodeExecPath: '/opt/n/bin/node',
    });
    expect(res).toEqual({ ok: true });
  });

  it('accepts a package with no engines.node', () => {
    expect(
      checkInstalledEngines({
        packageJsonPath: pkgDir(),
        nodeVersion: '24.22.1',
        nodeExecPath: '/opt/n/bin/node',
      }),
    ).toEqual({ ok: true });
  });

  it('refuses when the package is not installed under the runtime', () => {
    const res = checkInstalledEngines({
      packageJsonPath: '/nowhere/package.json',
      nodeVersion: '24.22.1',
      nodeExecPath: '/opt/n/bin/node',
    });
    expect(res.ok).toBe(false);
  });

  it('warns and accepts when engines.node uses syntax it cannot read', () => {
    const res = checkInstalledEngines({
      packageJsonPath: pkgDir({ node: 'lts/*' }),
      nodeVersion: '24.22.1',
      nodeExecPath: '/opt/n/bin/node',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warning).toMatch(/lts\/\*/);
  });
});

describe('installedPackageJsonPath', () => {
  it('names the global package folder on each layout', () => {
    expect(installedPackageJsonPath('/opt/n', 'kici-admin', false)).toBe(
      '/opt/n/lib/node_modules/kici-admin/package.json',
    );
    expect(installedPackageJsonPath('C:\\n', '@kici-dev/agent', true)).toBe(
      'C:\\n\\node_modules\\@kici-dev\\agent\\package.json',
    );
  });
});

describe('reRootLaunch / reRootPath', () => {
  it('moves the node and every launch token under the old prefix', () => {
    const moved = reRootLaunch(
      {
        execPath: '/old/bin/node',
        args: ['/old/lib/node_modules/kici-admin/node_modules/@kici-dev/agent/dist/server.js'],
      },
      { oldPrefix: '/old', newPrefix: '/new', nodeExecPath: '/new/bin/node', windows: false },
    );
    expect(moved).toEqual({
      execPath: '/new/bin/node',
      args: ['/new/lib/node_modules/kici-admin/node_modules/@kici-dev/agent/dist/server.js'],
    });
  });

  it('keeps a token outside the old prefix and a sibling folder sharing its name', () => {
    expect(reRootPath('/old-other/x.js', '/old', '/new', false)).toBeNull();
    expect(reRootPath('/srv/x.js', '/old', '/new', false)).toBeNull();
  });

  it('matches a Windows prefix without regard to case', () => {
    expect(reRootPath('c:\\Old\\node_modules\\a.js', 'C:\\old', 'D:\\new', true)).toBe(
      'D:\\new\\node_modules\\a.js',
    );
  });

  it('re-roots under a root prefix', () => {
    expect(reRootPath('/lib/node_modules/a.js', '/', '/new', false)).toBe(
      '/new/lib/node_modules/a.js',
    );
  });

  it('keeps the account the unit runs as', () => {
    const moved = reRootLaunch(
      { execPath: '/old/bin/node', args: [], user: 'kici' },
      { oldPrefix: '/old', newPrefix: '/new', nodeExecPath: '/new/bin/node', windows: false },
    );
    expect(moved.user).toBe('kici');
  });
});

describe('checkNodeFlagConflicts', () => {
  it('returns null without --node', () => {
    expect(checkNodeFlagConflicts({ from: 'a.tgz', platform: 'systemd' })).toBeNull();
  });

  it('returns null for --node with --version or --restart-only', () => {
    expect(
      checkNodeFlagConflicts({ node: '/n', version: '1.0.0', platform: 'systemd' }),
    ).toBeNull();
    expect(
      checkNodeFlagConflicts({ node: '/n', restartOnly: true, platform: 'windows' }),
    ).toBeNull();
  });

  it.each([
    [{ from: 'a.tgz' }, '--from'],
    [{ url: 'https://x/a.tgz' }, '--url'],
    [{ rollback: true }, '--rollback'],
    [{ pick: true }, '--pick'],
    [{ cleanup: true }, '--cleanup'],
  ])('refuses --node with %o', (extra, flag) => {
    const msg = checkNodeFlagConflicts({ node: '/n', platform: 'systemd', ...extra });
    expect(msg).toContain(flag);
  });

  it('refuses --node on a compose service', () => {
    expect(checkNodeFlagConflicts({ node: '/n', platform: 'compose' })).toMatch(/compose/);
  });
});
