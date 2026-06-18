/**
 * Tests for the shared versioned-upgrade helper:
 *
 * - `getInstallBase` — name-scoped install base derivation.
 * - `resolveUpgradeTarget` — folder-anchored target resolution that builds
 *   the ServiceConfig from the on-disk manifest (rather than re-deriving
 *   paths from the service name). The four scenarios mirror the
 *   install/uninstall test matrices:
 *
 *     1. refusal when no targeting flag and no CWD manifest.
 *     2. resolution via `--instance-dir` (installBase comes from the manifest).
 *     3. resolution via `--name` (matches against listInstances output).
 *     4. resolution via CWD manifest.
 *
 * Strategy: stub the service manager's `list` method so we control what
 * the resolver sees; everything else (manifest read, index reconciliation,
 * refusal formatting) runs against real code in real tmpdirs. The
 * archive-extract + symlink-flip path is covered by E2E.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getInstallBase,
  resolveUpgradeTarget,
  resolveNpmSourceVersion,
  verifyNpmSourceLaunch,
} from './versioned-upgrade.js';
import { writeManifest, writeIndex } from '../../service/index.js';
import type { DiscoveredInstance, InstanceManifest, ServiceManager } from '../../service/index.js';

describe('getInstallBase — name-scoped', () => {
  it('systemd: /opt/kici/<name>/', () => {
    expect(getInstallBase('systemd', 'kici-foo')).toBe('/opt/kici/kici-foo/');
  });
  it('launchd: /usr/local/kici/<name>/', () => {
    expect(getInstallBase('launchd', 'kici-foo')).toBe('/usr/local/kici/kici-foo/');
  });
  it('windows: C:\\Program Files\\KiCI\\<name>\\', () => {
    expect(getInstallBase('windows', 'kici-foo')).toBe('C:\\Program Files\\KiCI\\kici-foo\\');
  });
  it('compose: /opt/kici/<name>/', () => {
    expect(getInstallBase('compose', 'kici-foo')).toBe('/opt/kici/kici-foo/');
  });
});

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    envFilePath: '/x/kici-test.env',
    configDir: '/x/',
    logDir: '/x/logs/',
    installBase: '/opt/kici/kici-test/',
    createdAt: '2026-05-28T00:00:00Z',
    kiciVersion: '0.1.13',
    ...overrides,
  };
}

/** Build a ServiceManager stub whose `list()` returns the supplied set. */
function makeManager(listResult: DiscoveredInstance[] = []): ServiceManager {
  return {
    install: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ state: 'stopped' }),
    logs: vi.fn().mockResolvedValue(undefined),
    isInstalled: vi.fn().mockResolvedValue(true),
    list: vi.fn(async () => listResult),
  } satisfies ServiceManager;
}

describe('resolveUpgradeTarget — folder-anchored targeting', () => {
  let tmpInstanceDir: string;
  let tmpKiciRoot: string;
  let savedCwd: string;
  let emptyCwd: string;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e3-i-');
    tmpKiciRoot = mkTmp('kici-e3-c-');
    emptyCwd = mkTmp('kici-e3-cwd-');
    savedCwd = process.cwd();
  });

  afterEach(() => {
    if (process.cwd() !== savedCwd) {
      process.chdir(savedCwd);
    }
    for (const dir of [tmpInstanceDir, tmpKiciRoot, emptyCwd]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses with candidate list when no flag and no CWD manifest', async () => {
    const manager = makeManager([
      { name: 'kici-existing', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
    ]);
    writeIndex(tmpKiciRoot, [
      {
        component: 'orchestrator',
        name: 'kici-existing',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: '/some/place',
      },
    ]);

    process.chdir(emptyCwd);

    await expect(
      resolveUpgradeTarget({
        component: 'orchestrator',
        opts: {},
        manager,
        isUserLevel: true,
        kiciRoot: tmpKiciRoot,
      }),
    ).rejects.toThrow(/No instance specified/);
  });

  it('resolves via --instance-dir, builds ServiceConfig from manifest', async () => {
    const manifest = makeManifest({
      name: 'kici-fromdir',
      configDir: '/some/cfg/',
      envFilePath: '/some/cfg/kici-fromdir.env',
      installBase: '/opt/kici/kici-fromdir/',
    });
    writeManifest(tmpInstanceDir, manifest);

    const manager = makeManager();

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { instanceDir: tmpInstanceDir },
      manager,
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.installBase).toBe('/opt/kici/kici-fromdir/');
    expect(result.config.name).toBe('kici-fromdir');
    expect(result.config.component).toBe('orchestrator');
    expect(result.config.envFilePath).toBe('/some/cfg/kici-fromdir.env');
    expect(result.config.workingDirectory).toBe('/some/cfg/');
    expect(result.config.isUserLevel).toBe(true);
    expect(result.resolvedInstance.instanceDir).toBe(path.resolve(tmpInstanceDir));
  });

  it('resolves via --name', async () => {
    const manifest = makeManifest({
      name: 'kici-byname',
      installBase: '/opt/kici/kici-byname/',
    });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpKiciRoot, [
      {
        component: 'orchestrator',
        name: 'kici-byname',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);
    const manager = makeManager([
      { name: 'kici-byname', platform: 'systemd', isUserLevel: true, component: 'orchestrator' },
    ]);

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { name: 'kici-byname' },
      manager,
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.config.name).toBe('kici-byname');
    expect(result.installBase).toBe('/opt/kici/kici-byname/');
  });

  it('resolves via CWD manifest when no flag is passed', async () => {
    const manifest = makeManifest({
      name: 'kici-cwd',
      installBase: '/opt/kici/kici-cwd/',
    });
    writeManifest(tmpInstanceDir, manifest);

    process.chdir(tmpInstanceDir);

    const manager = makeManager();

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: {},
      manager,
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.config.name).toBe('kici-cwd');
    expect(result.installBase).toBe('/opt/kici/kici-cwd/');
  });

  it('reads installBase from the manifest rather than re-deriving from name', async () => {
    // The manifest's installBase intentionally does NOT match the
    // getInstallBase(platform, name) value. resolveUpgradeTarget MUST
    // honour the manifest — re-deriving would silently break instances
    // installed with a non-default base.
    const manifest = makeManifest({
      name: 'kici-custom',
      installBase: '/var/kici-custom-base/',
    });
    writeManifest(tmpInstanceDir, manifest);

    const manager = makeManager();

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { instanceDir: tmpInstanceDir },
      manager,
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.installBase).toBe('/var/kici-custom-base/');
    expect(result.installBase).not.toBe(getInstallBase('systemd', 'kici-custom'));
  });
});

describe('resolveNpmSourceVersion — npm-source (no archive) upgrade', () => {
  it('defaults to the running package version when --version is omitted', () => {
    expect(resolveNpmSourceVersion({ requested: undefined, running: '0.1.16' })).toBe('0.1.16');
  });

  it('accepts a matching --version', () => {
    expect(resolveNpmSourceVersion({ requested: '0.1.16', running: '0.1.16' })).toBe('0.1.16');
  });

  it('throws on a mismatched --version (guards against npm not updating the global binary)', () => {
    expect(() => resolveNpmSourceVersion({ requested: '0.1.17', running: '0.1.16' })).toThrow(
      /does not match the installed/i,
    );
  });

  it('throws when the running version cannot be resolved', () => {
    expect(() => resolveNpmSourceVersion({ requested: undefined, running: 'unknown' })).toThrow(
      /could not determine/i,
    );
  });
});

describe('verifyNpmSourceLaunch', () => {
  it('ok when launched matches invoked — writes the launched version', () => {
    const v = verifyNpmSourceLaunch({
      component: 'orchestrator',
      invoked: '0.1.17',
      launched: '0.1.17',
      launchedPath: '/n/24.15.0/bin/node',
      force: false,
    });
    expect(v).toEqual({ ok: true, version: '0.1.17', manifestVersion: '0.1.17' });
  });

  it('fails on mismatch — no restart, message names both versions and the path', () => {
    const v = verifyNpmSourceLaunch({
      component: 'orchestrator',
      invoked: '0.1.17',
      launched: '0.1.13',
      launchedPath: '/n/24.15.0/bin/node',
      force: false,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('0.1.17');
      expect(v.reason).toContain('0.1.13');
      expect(v.reason).toContain('/n/24.15.0/bin/node');
    }
  });

  it('fails when unresolvable and no --force', () => {
    const v = verifyNpmSourceLaunch({
      component: 'agent',
      invoked: '0.1.17',
      launched: null,
      launchedPath: null,
      force: false,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('--force');
  });

  it('ok when unresolvable but --force — skips the manifest write', () => {
    const v = verifyNpmSourceLaunch({
      component: 'agent',
      invoked: '0.1.17',
      launched: null,
      launchedPath: null,
      force: true,
    });
    expect(v).toEqual({ ok: true, version: '0.1.17', manifestVersion: null });
  });
});
