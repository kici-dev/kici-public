/**
 * Every case builds a real npm-style runtime layout in a temp dir (real files
 * and symlinks), so `realpath`, the executable bit and the owning package.json
 * are the ones the check reads on a host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BinaryPathIssue,
  checkBinaryPath,
  owningPackageVersion,
  preflightBareMetalBinaryPaths,
  scalerConfigLocation,
  SKIP_BINARY_PATH_CHECK_FLAG,
  versionManagerPath,
  versionManagerPathKind,
  VersionManagerPathType,
} from './bare-metal-binary-check.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-bm-check-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * `<tmp>/mise/installs/node/<version>` with kici-admin@<adminVersion>
 * installed globally: `bin/kici-agent` links to the package's bin script.
 */
function runtime(version: string, adminVersion: string): { prefix: string; agent: string } {
  const prefix = path.join(tmp, 'mise', 'installs', 'node', version);
  const pkg = path.join(prefix, 'lib', 'node_modules', 'kici-admin');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'kici-admin', version: adminVersion }),
  );
  fs.writeFileSync(path.join(pkg, 'bin', 'kici-agent.js'), '#!/usr/bin/env node\n', {
    mode: 0o755,
  });
  const agent = path.join(prefix, 'bin', 'kici-agent');
  fs.symlinkSync(path.join(pkg, 'bin', 'kici-agent.js'), agent);
  return { prefix, agent };
}

/** mise's `node/<alias>` link pointing at `target`. */
function alias(name: string, target: string): string {
  const link = path.join(tmp, 'mise', 'installs', 'node', name);
  fs.symlinkSync(target, link);
  return link;
}

/**
 * A version-manager shim as the manager lays it out: `<tmp>/<shimDir>/kici-agent`
 * linking to the manager's own executable `<tmp>/vm-bin/<exe>`.
 */
function linkedShim(shimDir: string, exe: string): { shim: string; exe: string } {
  const exePath = path.join(tmp, 'vm-bin', exe);
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, '#!/bin/sh\n', { mode: 0o755 });
  const shim = path.join(tmp, shimDir, 'kici-agent');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.symlinkSync(exePath, shim);
  return { shim, exe: exePath };
}

/** A shim that is a script in a `shims` folder, as asdf and nodenv write one. */
function scriptShim(shimDir: string): string {
  const shim = path.join(tmp, shimDir, 'kici-agent');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '#!/usr/bin/env bash\nexec asdf exec "kici-agent" "$@"\n', {
    mode: 0o755,
  });
  return shim;
}

const base = (binaryPath: string, expectedAgent: string | null) => ({
  configured: { scaler: 'bm', binaryPath },
  workingDirectory: tmp,
  expectedAgent,
  expectedVersion: null,
  willInstall: false,
  scalerConfigPath: '/etc/kici/scalers.yaml',
});

describe('checkBinaryPath', () => {
  it('refuses a binaryPath whose alias moved to a runtime with no agent, naming the agent the unit runs', () => {
    // The break after a Node.js install: node/24 moved to 24.21.0, which has no kici-agent,
    // while the unit's runtime is 24.15.0.
    const unit = runtime('24.15.0', '0.17.0');
    fs.mkdirSync(path.join(tmp, 'mise', 'installs', 'node', '24.21.0', 'bin'), { recursive: true });
    const moved = alias('24', path.join(tmp, 'mise', 'installs', 'node', '24.21.0'));
    const findings = checkBinaryPath({
      ...base(path.join(moved, 'bin', 'kici-agent'), unit.agent),
      willInstall: true,
    });
    // fails-when: a missing binaryPath is only warned about, or the remedy names
    // a path other than the agent under the unit's own runtime.
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.Missing]);
    expect(findings[0]!.message).toContain(`Set binaryPath to ${unit.agent},`);
    expect(findings[0]!.message).toContain('/etc/kici/scalers.yaml');
  });

  it('refuses a missing binaryPath with no expected agent, and gives a generic remedy', () => {
    const findings = checkBinaryPath(base('/nowhere/kici-agent', null));
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.Missing]);
    expect(findings[0]!.message).toContain('or set binaryPath to an installed kici-agent');
  });

  it('refuses a file that exists but is not executable', () => {
    // fails-when: the check tests existence only — the service's startup check
    // requires the executable bit, so the restart would still fail.
    const file = path.join(tmp, 'kici-agent');
    fs.writeFileSync(file, '', { mode: 0o644 });
    expect(checkBinaryPath(base(file, null)).map((f) => f.issue)).toEqual([
      BinaryPathIssue.Missing,
    ]);
  });

  it('warns about an agent from another runtime, naming both paths and versions', () => {
    const unit = runtime('24.15.0', '0.17.0');
    const other = runtime('22.11.0', '0.16.2');
    const findings = checkBinaryPath({
      ...base(other.agent, unit.agent),
      expectedVersion: 'kici-admin@0.17.0',
    });
    // fails-when: realpaths are not compared, so an agent from another runtime
    // passes silently and stays on the old version after the upgrade.
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.OtherInstall]);
    expect(findings[0]!.message).toContain('(kici-admin@0.16.2)');
    expect(findings[0]!.message).toContain(`${unit.agent} (kici-admin@0.17.0)`);
  });

  it('warns about a version-manager alias even while it still resolves to the unit runtime', () => {
    // The state before that break: node/24 still pointed at 24.15.0.
    const unit = runtime('24.15.0', '0.17.0');
    const moving = alias('24', unit.prefix);
    const findings = checkBinaryPath(base(path.join(moving, 'bin', 'kici-agent'), unit.agent));
    // fails-when: the alias check reads the realpath, which names 24.15.0 and
    // hides the alias that moves on the next Node.js install.
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.VersionManagerPath]);
    expect(findings[0]!.message).toContain('mise alias (node/24)');
    expect(findings[0]!.message).toContain(`Use a stable path: ${unit.agent}.`);
  });

  it('is silent when binaryPath is the agent under the unit runtime', () => {
    const unit = runtime('24.15.0', '0.17.0');
    // breaks-if-wrong: the recommended configuration must pass without noise.
    expect(checkBinaryPath(base(unit.agent, unit.agent))).toEqual([]);
  });

  it('is silent for the expected path the upgrade is about to install', () => {
    const expected = path.join(tmp, 'mise', 'installs', 'node', '24.15.0', 'bin', 'kici-agent');
    // breaks-if-wrong: an operator who already points binaryPath at the
    // unit's runtime must not be refused before the install creates the file.
    expect(checkBinaryPath({ ...base(expected, expected), willInstall: true })).toEqual([]);
    // fails-when: without an install the same missing file is refused.
    const refused = checkBinaryPath(base(expected, expected));
    expect(refused.map((f) => f.issue)).toEqual([BinaryPathIssue.Missing]);
    // The remedy is the install, not the path the operator already set.
    expect(refused[0]!.message).toContain("Install kici-admin under the service's runtime");
  });

  it.each([
    [
      'a mise shim, which links to the mise executable',
      () => linkedShim(path.join('mise', 'shims'), 'mise').shim,
      '`mise which kici-agent`',
    ],
    // An asdf shim is a script, not a link.
    [
      'an asdf script shim',
      () => scriptShim(path.join('.asdf', 'shims')),
      '`asdf which kici-agent`',
    ],
  ])('refuses %s, naming the command that finds the agent', (_kind, make, which) => {
    const shim = make();
    const findings = checkBinaryPath(base(shim, null));
    // fails-when: the check stops at the executable bit, which a shim passes,
    // so the restart starts an orchestrator whose agents never start.
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.VersionManagerShim]);
    expect(findings[0]!.message).toContain(
      `it resolves to ${fs.realpathSync(shim)}, not to a kici-agent`,
    );
    expect(findings[0]!.message).toContain(
      `Set binaryPath to the path ${which} prints, in /etc/kici/scalers.yaml.`,
    );
  });

  it('refuses a shim and names the agent installed with the service runtime when known', () => {
    const unit = runtime('24.15.0', '0.17.0');
    const { shim } = linkedShim(path.join('volta', 'bin'), 'volta-shim');
    const findings = checkBinaryPath(base(shim, unit.agent));
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.VersionManagerShim]);
    expect(findings[0]!.message).toContain('(Volta)');
    expect(findings[0]!.message).toContain(`Set binaryPath to ${unit.agent},`);
  });

  it('resolves a relative binaryPath against the working directory', () => {
    const unit = runtime('24.15.0', '0.17.0');
    const relative = path.relative(tmp, unit.agent);
    expect(checkBinaryPath(base(relative, unit.agent))).toEqual([]);
  });
});

describe('versionManagerPathKind', () => {
  it.each([
    ['/h/.local/share/mise/installs/node/24/bin/kici-agent', 'mise alias (node/24)'],
    ['/h/.local/share/mise/installs/node/lts/bin/kici-agent', 'mise alias (node/lts)'],
    ['/h/.local/share/mise/shims/kici-agent', 'mise shim'],
    ['/h/.asdf/shims/kici-agent', 'asdf shim'],
    ['/h/.volta/bin/kici-agent', 'Volta shim'],
    ['/h/.nodenv/shims/kici-agent', 'nodenv shim'],
    ['/run/user/1000/fnm_multishells/123_456/bin/kici-agent', 'fnm shell link'],
    ['/h/.local/share/fnm/aliases/default/bin/kici-agent', 'fnm alias'],
    ['/h/.nvm/current/bin/kici-agent', 'nvm current link'],
  ])('flags %s', (p, kind) => {
    expect(versionManagerPathKind(p)).toBe(kind);
  });

  it.each([
    '/h/.local/share/mise/installs/node/24.15.0/bin/kici-agent',
    '/h/.nvm/versions/node/v24.15.0/bin/kici-agent',
    '/h/.asdf/installs/nodejs/24.15.0/bin/kici-agent',
    '/usr/local/bin/kici-agent',
  ])('accepts the fixed runtime path %s', (p) => {
    // breaks-if-wrong: a pinned runtime path is the recommended form and must not warn.
    expect(versionManagerPathKind(p)).toBeNull();
  });
});

describe('owningPackageVersion', () => {
  it('reads the package that owns the resolved file', () => {
    const unit = runtime('24.15.0', '0.17.0');
    expect(owningPackageVersion(unit.agent)).toBe('kici-admin@0.17.0');
    expect(owningPackageVersion(path.join(tmp, 'absent'))).toBeNull();
  });
});

describe('scalerConfigLocation', () => {
  it('resolves the path and directory against the working directory', () => {
    expect(
      scalerConfigLocation(
        'KICI_SCALER_CONFIG_PATH=scalers.yaml\nKICI_SCALER_CONFIG_DIR=scalers.d\n',
        '/etc/kici',
      ),
    ).toEqual({ configPath: '/etc/kici/scalers.yaml', configDir: '/etc/kici/scalers.d' });
  });

  it('reads no config without a path, as the service does', () => {
    expect(scalerConfigLocation('KICI_SCALER_CONFIG_DIR=/etc/kici/scalers.d\n', '/')).toBeNull();
  });
});

describe('preflightBareMetalBinaryPaths', () => {
  function instance(binaryPath: string): string {
    const scalers = path.join(tmp, 'scalers.yaml');
    fs.writeFileSync(
      scalers,
      [
        'version: 1',
        'scalers:',
        '  - name: bm',
        '    type: bare-metal',
        '    maxAgents: 1',
        '    labelSets:',
        '      - labels: [linux, bare-metal]',
        `        binaryPath: ${binaryPath}`,
        '',
      ].join('\n'),
    );
    const env = path.join(tmp, 'orch.env');
    fs.writeFileSync(env, `KICI_SCALER_CONFIG_PATH=${scalers}\n`);
    return env;
  }

  const args = (envFilePath: string, expectedAgent: string | null, skip = false) => ({
    serviceName: 'kici-orch',
    envFilePath,
    workingDirectory: tmp,
    expectedAgent,
    expectedVersion: null,
    willInstall: false,
    skip,
    warn: vi.fn(),
  });

  it('throws on a missing binaryPath read from the instance scaler config', async () => {
    const a = args(instance('/nowhere/kici-agent'), null);
    // fails-when: the env file or the scaler config is not read, so the check
    // passes vacuously and the upgrade restarts into a crash loop.
    await expect(preflightBareMetalBinaryPaths(a)).rejects.toThrow(
      /^refusing to upgrade "kici-orch":\n {2}- bare-metal scaler "bm": binaryPath \/nowhere\/kici-agent is not an executable file.*Nothing was installed and the service was not restarted\..*--skip-binary-path-check/s,
    );
  });

  it('reports the refusal as a warning with the skip flag', async () => {
    const a = args(instance('/nowhere/kici-agent'), null, true);
    await expect(preflightBareMetalBinaryPaths(a)).resolves.toBeUndefined();
    expect(a.warn).toHaveBeenCalledWith(expect.stringContaining('/nowhere/kici-agent'));
    expect(SKIP_BINARY_PATH_CHECK_FLAG).toBe('--skip-binary-path-check');
  });

  it('throws on a version-manager shim read from the instance scaler config', async () => {
    const { shim } = linkedShim(path.join('mise', 'shims'), 'mise');
    const a = args(instance(shim), null);
    // fails-when: a shim finding is only warned about, so the upgrade restarts
    // an orchestrator that refuses to start.
    await expect(preflightBareMetalBinaryPaths(a)).rejects.toThrow(
      /^refusing to upgrade "kici-orch":\n {2}- bare-metal scaler "bm": binaryPath .*is a version-manager shim \(mise\)/s,
    );
    expect(a.warn).not.toHaveBeenCalled();
  });

  it('passes a correct binaryPath without a warning', async () => {
    const unit = runtime('24.15.0', '0.17.0');
    const a = args(instance(unit.agent), unit.agent);
    // breaks-if-wrong: a correctly configured instance upgrades as before.
    await expect(preflightBareMetalBinaryPaths(a)).resolves.toBeUndefined();
    expect(a.warn).not.toHaveBeenCalled();
  });

  it('skips an instance with no scaler config', async () => {
    const env = path.join(tmp, 'orch.env');
    fs.writeFileSync(env, 'KICI_DATABASE_URL=postgres://x\n');
    const a = args(env, null);
    await expect(preflightBareMetalBinaryPaths(a)).resolves.toBeUndefined();
    expect(a.warn).not.toHaveBeenCalled();
  });

  it('warns and goes on when the scaler config cannot be read', async () => {
    const env = path.join(tmp, 'orch.env');
    fs.writeFileSync(env, `KICI_SCALER_CONFIG_PATH=${path.join(tmp, 'absent.yaml')}\n`);
    const a = args(env, null);
    await expect(preflightBareMetalBinaryPaths(a)).resolves.toBeUndefined();
    expect(a.warn).toHaveBeenCalledWith(
      expect.stringContaining('binaryPath values were not checked'),
    );
  });
});

describe('versionManagerPath — shim or alias', () => {
  it.each([
    ['/h/.local/share/mise/shims/node', VersionManagerPathType.Shim],
    ['/h/.asdf/shims/node', VersionManagerPathType.Shim],
    ['/h/.volta/bin/node', VersionManagerPathType.Shim],
    ['/h/.nodenv/shims/node', VersionManagerPathType.Shim],
    ['/h/.local/share/mise/installs/node/24/bin/node', VersionManagerPathType.Alias],
    ['/h/.local/share/fnm/aliases/default/bin/node', VersionManagerPathType.Alias],
    ['/h/.nvm/current/bin/node', VersionManagerPathType.Alias],
    ['/run/user/1000/fnm_multishells/1_2/bin/node', VersionManagerPathType.Alias],
  ])('classifies %s as %s', (p, type) => {
    expect(versionManagerPath(p)?.type).toBe(type);
  });

  it('returns null for a fixed runtime path', () => {
    expect(versionManagerPath('/opt/node-24.22.1/bin/node')).toBeNull();
  });
});

describe('checkBinaryPath — moving the service to another Node.js runtime', () => {
  // fails-when: a binaryPath on the runtime the service leaves passes silently,
  // and every agent the scaler starts keeps the old Node.js.
  it('warns about the kici-agent of the runtime the service leaves, naming the new path and the config', () => {
    const oldRt = runtime('24.15.0', '0.27.0');
    const newRt = runtime('24.22.1', '0.27.0');
    const findings = checkBinaryPath({
      ...base(oldRt.agent, newRt.agent),
      willInstall: true,
      previousAgent: oldRt.agent,
    });
    expect(findings.map((f) => f.issue)).toEqual([BinaryPathIssue.PreviousRuntime]);
    expect(findings[0]!.message).toContain(`Set binaryPath to ${newRt.agent}`);
    expect(findings[0]!.message).toContain('/etc/kici/scalers.yaml');
  });

  // breaks-if-wrong: a binaryPath already on the new runtime stays silent.
  it('is silent when binaryPath already names the new runtime agent', () => {
    const oldRt = runtime('24.15.0', '0.27.0');
    const newRt = runtime('24.22.1', '0.27.0');
    expect(
      checkBinaryPath({
        ...base(newRt.agent, newRt.agent),
        willInstall: true,
        previousAgent: oldRt.agent,
      }),
    ).toEqual([]);
  });
});
