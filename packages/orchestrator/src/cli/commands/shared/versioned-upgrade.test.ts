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
 * archive-extract + symlink-flip path needs a real release archive and is
 * out of scope here.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getInstallBase,
  resolveUpgradeTarget,
  resolveNpmSourceVersion,
  verifyNpmSourceLaunch,
  buildPickChoices,
  selectablePickTargets,
  switchToInstalledVersion,
  checkPickFlagConflicts,
  planNpmSourceUpgrade,
  installGlobalPackage,
  restartOntoInstalledPackage,
  restartOnlyUpgrade,
  performSelfDrivingInstall,
  windowsShellCommand,
  extractRelease,
  installRelease,
  npmReleaseReadsEnvFile,
} from './versioned-upgrade.js';
import { SERVICE_TEXT, writeManifest, writeIndex } from '../../service/index.js';
import type {
  InstanceManifest,
  LaunchSpec,
  ServiceConfig,
  ServiceManager,
  ServicePlatform,
} from '../../service/index.js';
import type { DiscoveredInstance } from '../../service/types.js';

/** A bundle or an npm entry of a release that reads KICI_ENV_FILE. */
const READS_ENV_FILE = 'import "@kici-dev/shared/load-service-env-file"; // KICI_ENV_FILE';
/** A bundle or an npm entry of a release from before KICI_ENV_FILE. */
const PREDATES_ENV_FILE = 'import "./app.js"; // no env-file loader';

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

/** Build a ServiceManager stub for one platform whose `list()` returns the supplied set. */
function makeManager(
  listResult: DiscoveredInstance[] = [],
  platform: ServicePlatform = 'systemd',
): ServiceManager {
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
    readLaunchSpec: vi.fn().mockResolvedValue(null),
    platform,
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
        createManager: async () => manager,
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
      createManager: async () => manager,
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

  // fails-when: an upgrade that registers a Windows service again writes its
  // own text, so the description differs from what install writes.
  it.each(['orchestrator', 'agent'] as const)(
    'gives the %s the display name and description install writes',
    async (component) => {
      writeManifest(
        tmpInstanceDir,
        makeManifest({
          component,
          name: `kici-${component}-text`,
          platform: 'windows',
          configDir: 'C:\\ProgramData\\kici\\x\\',
          envFilePath: 'C:\\ProgramData\\kici\\x\\x.env',
          installBase: 'C:\\Program Files\\KiCI\\x\\',
        }),
      );
      const target = await resolveUpgradeTarget({
        component,
        opts: { instanceDir: tmpInstanceDir },
        createManager: async () => makeManager([], 'windows'),
        isUserLevel: true,
        kiciRoot: tmpKiciRoot,
      });
      expect(target.config.displayName).toBe(SERVICE_TEXT[component].displayName);
      expect(target.config.description).toBe(SERVICE_TEXT[component].description);
    },
  );

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
      createManager: async () => manager,
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
      createManager: async () => manager,
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
      createManager: async () => manager,
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.installBase).toBe('/var/kici-custom-base/');
    expect(result.installBase).not.toBe(getInstallBase('systemd', 'kici-custom'));
  });

  // fails-when: the platform comes from detectPlatform(). This runs on a systemd
  // host, so a host-derived value is 'systemd' and every downstream question the
  // upgrade asks — the root check, isWindows()'s launcher naming, whether
  // getCurrentVersion reads a symlink or a version file — is answered for a
  // layout the install does not have.
  it('reports the install platform, not the host, for a compose manifest', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-compose', platform: 'compose' }));
    const built: ServicePlatform[] = [];

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { instanceDir: tmpInstanceDir },
      createManager: async (p) => {
        built.push(p);
        return makeManager([], p);
      },
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.platform).toBe('compose');
    expect(result.manager.platform).toBe('compose');
    expect(built).toContain('compose');
  });

  // breaks-if-wrong: the common case must be unaffected — a systemd install still
  // reports systemd, so nothing downstream changes shape for it.
  it('reports systemd for a systemd manifest', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-sysd', platform: 'systemd' }));

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { instanceDir: tmpInstanceDir },
      createManager: async (p) => makeManager([], p),
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.platform).toBe('systemd');
    expect(result.manager.platform).toBe('systemd');
  });

  // breaks-if-wrong: --platform is the operator's documented escape hatch and
  // still forces the driver, ahead of whatever the manifest records.
  it('honours --platform over the manifest', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-forced', platform: 'systemd' }));

    const result = await resolveUpgradeTarget({
      component: 'orchestrator',
      opts: { instanceDir: tmpInstanceDir },
      platformOverride: 'launchd',
      createManager: async (p) => makeManager([], p),
      isUserLevel: true,
      kiciRoot: tmpKiciRoot,
    });

    expect(result.platform).toBe('launchd');
    expect(result.manager.platform).toBe('launchd');
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

describe('buildPickChoices — interactive --pick list', () => {
  it('returns one choice per version, newest-first (lexicographic desc)', () => {
    const choices = buildPickChoices(['0.1.1', '0.1.2', '0.1.3'], '0.1.2');
    expect(choices.map((c) => c.value)).toEqual(['0.1.3', '0.1.2', '0.1.1']);
  });

  it('marks the current version disabled with a "(current)" label', () => {
    const choices = buildPickChoices(['0.1.1', '0.1.2'], '0.1.2');
    const cur = choices.find((c) => c.value === '0.1.2')!;
    expect(cur.disabled).toBe('current version');
    expect(cur.name).toContain('(current)');
  });

  it('leaves non-current versions enabled with name === value', () => {
    const choices = buildPickChoices(['0.1.1', '0.1.2'], '0.1.2');
    const other = choices.find((c) => c.value === '0.1.1')!;
    expect(other.disabled).toBe(false);
    expect(other.name).toBe('0.1.1');
  });

  it('disables nothing when there is no current version', () => {
    const choices = buildPickChoices(['0.1.1', '0.1.2'], null);
    expect(choices.every((c) => c.disabled === false)).toBe(true);
  });
});

describe('selectablePickTargets — what --pick can switch to', () => {
  it('excludes the current version', () => {
    expect(selectablePickTargets(['0.1.1', '0.1.2', '0.1.3'], '0.1.2')).toEqual(['0.1.1', '0.1.3']);
  });

  it('is empty when only the current version is installed', () => {
    expect(selectablePickTargets(['0.1.2'], '0.1.2')).toEqual([]);
  });

  it('is empty when nothing is installed', () => {
    expect(selectablePickTargets([], null)).toEqual([]);
  });
});

describe('switchToInstalledVersion — shared switch sequence', () => {
  let installBase: string;
  let instanceDir: string;

  beforeEach(() => {
    installBase = mkTmp('kici-switch-base-');
    instanceDir = mkTmp('kici-switch-inst-');
    // Two installed versioned dirs + an active symlink pointing at the older one.
    fs.mkdirSync(path.join(installBase, 'orchestrator-0.1.1'), { recursive: true });
    fs.mkdirSync(path.join(installBase, 'orchestrator-0.1.2'), { recursive: true });
    fs.symlinkSync('orchestrator-0.1.1', path.join(installBase, 'orchestrator'));
  });

  afterEach(() => {
    for (const d of [installBase, instanceDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('flips the symlink to the target and persists kiciVersion to the manifest', async () => {
    const manager = makeManager(); // status → stopped, start/stop are vi.fns
    const manifest = makeManifest({ name: 'kici-test', installBase, kiciVersion: '0.1.1' });
    const resolvedInstance = {
      manifest,
      manifestPath: path.join(instanceDir, '.kici-orchestrator.json'),
      instanceDir,
    };
    writeManifest(instanceDir, manifest);
    const config = {
      name: 'kici-test',
      displayName: 'KiCI orchestrator',
      description: 'x',
      executablePath: '',
      envFilePath: manifest.envFilePath,
      workingDirectory: manifest.configDir,
      isUserLevel: true,
      restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
      component: 'orchestrator' as const,
      instanceDir,
    };

    await switchToInstalledVersion({
      component: 'orchestrator',
      platform: 'systemd',
      installBase,
      config,
      manager,
      resolvedInstance,
      targetVersion: '0.1.2',
    });

    expect(fs.readlinkSync(path.join(installBase, 'orchestrator'))).toBe('orchestrator-0.1.2');
    const written = JSON.parse(
      fs.readFileSync(path.join(instanceDir, '.kici-orchestrator.json'), 'utf-8'),
    );
    expect(written.kiciVersion).toBe('0.1.2');
    expect(manager.start).toHaveBeenCalledTimes(1);
  });

  it('on Windows re-registers through install, which refuses before the old service is removed', async () => {
    // fails-when: the switch runs uninstall before install, so a launcher path
    // install refuses leaves the instance with no service registration at all.
    const manager = makeManager([], 'windows');
    (manager.install as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('cannot run the launcher as a Windows service'),
    );
    const manifest = makeManifest({
      name: 'kici-test',
      platform: 'windows',
      installBase,
      kiciVersion: '0.1.1',
    });
    writeManifest(instanceDir, manifest);
    const config = {
      name: 'kici-test',
      displayName: 'KiCI orchestrator',
      description: 'x',
      executablePath: '',
      envFilePath: manifest.envFilePath,
      workingDirectory: manifest.configDir,
      isUserLevel: true,
      restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
      component: 'orchestrator' as const,
      instanceDir,
    };

    await expect(
      switchToInstalledVersion({
        component: 'orchestrator',
        platform: 'windows',
        installBase,
        config,
        manager,
        resolvedInstance: {
          manifest,
          manifestPath: path.join(instanceDir, '.kici-orchestrator.json'),
          instanceDir,
        },
        targetVersion: '0.1.2',
      }),
    ).rejects.toThrow(/cannot run the launcher/);

    expect(manager.install).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: path.join(
          installBase,
          'orchestrator-0.1.2',
          'kici-orchestrator-standalone.cmd',
        ),
      }),
    );
    expect(manager.uninstall).not.toHaveBeenCalled();
  });

  describe('on Windows, a release from before KICI_ENV_FILE', () => {
    /** A package release `<installBase>/orchestrator-<version>/`; returns its launcher. */
    function writeRelease(version: string, bundle: string): string {
      const dir = path.join(installBase, `orchestrator-${version}`);
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      const launcher = path.join(dir, 'kici-orchestrator-standalone.cmd');
      fs.writeFileSync(launcher, '@echo off\r\n');
      fs.writeFileSync(path.join(dir, 'lib', 'kici-orchestrator-standalone.cjs'), bundle);
      return launcher;
    }

    function windowsTarget() {
      const manifest = makeManifest({
        name: 'kici-test',
        platform: 'windows',
        installBase,
        kiciVersion: '0.1.1',
      });
      writeManifest(instanceDir, manifest);
      const config: ServiceConfig = {
        name: 'kici-test',
        ...SERVICE_TEXT.orchestrator,
        executablePath: '',
        envFilePath: manifest.envFilePath,
        workingDirectory: manifest.configDir,
        isUserLevel: true,
        restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
        component: 'orchestrator',
        instanceDir,
      };
      const resolvedInstance = {
        manifest,
        manifestPath: path.join(instanceDir, '.kici-orchestrator.json'),
        instanceDir,
      };
      return { config, resolvedInstance, manager: makeManager([], 'windows') };
    }

    // --rollback and --pick both switch through switchToInstalledVersion.
    // fails-when: a switch to a release that cannot read KICI_ENV_FILE is
    // accepted, so the service starts without its configuration or with the
    // env file's values on its command line.
    it('is refused before the schema check, the stop or the registration', async () => {
      writeRelease('0.1.2', PREDATES_ENV_FILE);
      const { config, resolvedInstance, manager } = windowsTarget();
      const migrationStatus = vi.fn();

      await expect(
        switchToInstalledVersion({
          component: 'orchestrator',
          platform: 'windows',
          installBase,
          config,
          manager,
          resolvedInstance,
          targetVersion: '0.1.2',
          hooks: { migrationStatus },
        }),
      ).rejects.toThrow(
        /^refusing to switch "kici-test" to 0\.1\.2: version 0\.1\.2 predates KICI_ENV_FILE.*The service was not changed\.$/s,
      );

      expect(migrationStatus).not.toHaveBeenCalled();
      expect(manager.status).not.toHaveBeenCalled();
      expect(manager.stop).not.toHaveBeenCalled();
      expect(manager.install).not.toHaveBeenCalled();
      expect(manager.start).not.toHaveBeenCalled();
      const written = JSON.parse(
        fs.readFileSync(path.join(instanceDir, '.kici-orchestrator.json'), 'utf-8'),
      );
      expect(written.kiciVersion).toBe('0.1.1');
      expect(fs.existsSync(path.join(installBase, 'orchestrator-current-version.txt'))).toBe(false);
    });

    // breaks-if-wrong: a switch to a release that reads KICI_ENV_FILE still
    // registers the service on it and starts it.
    it('does not stop a switch to a release that reads KICI_ENV_FILE', async () => {
      const launcher = writeRelease('0.1.2', READS_ENV_FILE);
      const { config, resolvedInstance, manager } = windowsTarget();

      await switchToInstalledVersion({
        component: 'orchestrator',
        platform: 'windows',
        installBase,
        config,
        manager,
        resolvedInstance,
        targetVersion: '0.1.2',
      });

      expect(manager.install).toHaveBeenCalledWith(
        expect.objectContaining({ executablePath: launcher }),
      );
      expect(manager.start).toHaveBeenCalledTimes(1);
      expect(
        fs.readFileSync(path.join(installBase, 'orchestrator-current-version.txt'), 'utf-8'),
      ).toBe('0.1.2');
    });
  });
});

describe('extractRelease — the release an archive upgrade installs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp('kici-extract-release-');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A `.tar.gz` holding `orchestrator-0.9.0/` with the given launcher and bundle. */
  function archive(launcherName: string, bundle: string): string {
    const src = path.join(tmp, 'src');
    const release = path.join(src, 'orchestrator-0.9.0');
    fs.mkdirSync(path.join(release, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(release, launcherName), '@echo off\r\n');
    fs.writeFileSync(
      path.join(release, 'lib', `${launcherName.replace(/\.cmd$/, '')}.cjs`),
      bundle,
    );
    const out = path.join(tmp, 'orchestrator-0.9.0.tar.gz');
    execSync(`tar -czf "${out}" -C "${src}" orchestrator-0.9.0`);
    return out;
  }

  const config: ServiceConfig = {
    name: 'kici-test',
    ...SERVICE_TEXT.orchestrator,
    executablePath: '',
    envFilePath: 'C:\\ProgramData\\kici\\kici-test\\kici-test.env',
    workingDirectory: 'C:\\ProgramData\\kici\\kici-test',
    isUserLevel: false,
    restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
    component: 'orchestrator',
  };

  // fails-when: an archive upgrade accepts a release that cannot read
  // KICI_ENV_FILE and goes on to copy it and stop the service.
  it('on Windows refuses a release from before KICI_ENV_FILE', () => {
    const archivePath = archive('kici-orchestrator-standalone.cmd', PREDATES_ENV_FILE);
    expect(() =>
      extractRelease({
        archivePath,
        tmpDir: tmp,
        component: 'orchestrator',
        platform: 'windows',
        version: '0.9.0',
        config,
      }),
    ).toThrow(
      /^refusing to upgrade "kici-test" to 0\.9\.0: version 0\.9\.0 predates KICI_ENV_FILE, so a Windows service can run it only with the values of C:\\ProgramData\\kici\\kici-test\\kici-test\.env on its command line/,
    );
  });

  // breaks-if-wrong: the archive of a release that reads KICI_ENV_FILE is extracted.
  it('on Windows returns the folder of a release that reads KICI_ENV_FILE', () => {
    const archivePath = archive('kici-orchestrator-standalone.cmd', READS_ENV_FILE);
    const dir = extractRelease({
      archivePath,
      tmpDir: tmp,
      component: 'orchestrator',
      platform: 'windows',
      version: '0.9.0',
      config,
    });
    expect(dir).toBe(path.join(tmp, 'extract', 'orchestrator-0.9.0'));
    expect(fs.existsSync(path.join(dir, 'kici-orchestrator-standalone.cmd'))).toBe(true);
  });

  // breaks-if-wrong: a systemd service reads its env file through the unit, so
  // no release is refused there.
  it('on systemd extracts a release whatever its bundle holds', () => {
    const archivePath = archive('kici-orchestrator-standalone', PREDATES_ENV_FILE);
    const dir = extractRelease({
      archivePath,
      tmpDir: tmp,
      component: 'orchestrator',
      platform: 'systemd',
      version: '0.9.0',
      config,
    });
    expect(dir).toBe(path.join(tmp, 'extract', 'orchestrator-0.9.0'));
  });
});

describe('installRelease — an archive upgrade with --force', () => {
  let tmp: string;
  let installBase: string;
  let versionedDirPath: string;
  beforeEach(() => {
    tmp = mkTmp('kici-install-release-');
    installBase = path.join(tmp, 'base');
    versionedDirPath = path.join(installBase, 'orchestrator-0.9.0');
    // The folder --force would replace: the version the service may run now.
    fs.mkdirSync(versionedDirPath, { recursive: true });
    fs.writeFileSync(path.join(versionedDirPath, 'in-use'), 'x');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function archive(launcherName: string, bundle: string): string {
    const src = path.join(tmp, 'src');
    const release = path.join(src, 'orchestrator-0.9.0');
    fs.mkdirSync(path.join(release, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(release, launcherName), '@echo off\r\n');
    fs.writeFileSync(
      path.join(release, 'lib', `${launcherName.replace(/\.cmd$/, '')}.cjs`),
      bundle,
    );
    const out = path.join(tmp, 'orchestrator-0.9.0.tar.gz');
    execSync(`tar -czf "${out}" -C "${src}" orchestrator-0.9.0`);
    return out;
  }

  const config: ServiceConfig = {
    name: 'kici-test',
    ...SERVICE_TEXT.orchestrator,
    executablePath: '',
    envFilePath: 'C:\\ProgramData\\kici\\kici-test\\kici-test.env',
    workingDirectory: 'C:\\ProgramData\\kici\\kici-test',
    isUserLevel: false,
    restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
    component: 'orchestrator',
  };

  // fails-when: --force removes the existing version folder before the release
  // is checked, so a refused upgrade still deletes what the service may run.
  it('on Windows refuses a release from before KICI_ENV_FILE and keeps the existing folder', () => {
    const archivePath = archive('kici-orchestrator-standalone.cmd', PREDATES_ENV_FILE);
    expect(() =>
      installRelease({
        archivePath,
        tmpDir: path.join(tmp, 'work'),
        installBase,
        versionedDirPath,
        component: 'orchestrator',
        platform: 'windows',
        version: '0.9.0',
        config,
      }),
    ).toThrow(/predates KICI_ENV_FILE/);
    expect(fs.readFileSync(path.join(versionedDirPath, 'in-use'), 'utf-8')).toBe('x');
  });

  // breaks-if-wrong: --force still replaces the folder with an accepted release.
  it('replaces the existing folder with an accepted release', () => {
    const archivePath = archive('kici-orchestrator-standalone', PREDATES_ENV_FILE);
    installRelease({
      archivePath,
      tmpDir: path.join(tmp, 'work'),
      installBase,
      versionedDirPath,
      component: 'orchestrator',
      platform: 'systemd',
      version: '0.9.0',
      config,
    });
    expect(fs.existsSync(path.join(versionedDirPath, 'in-use'))).toBe(false);
    expect(fs.existsSync(path.join(versionedDirPath, 'kici-orchestrator-standalone'))).toBe(true);
  });
});

describe('checkPickFlagConflicts — --pick mutual exclusivity', () => {
  it('returns null when --pick is absent', () => {
    expect(checkPickFlagConflicts({ from: 'x.tar.gz' })).toBeNull();
  });

  it('returns null when --pick is used alone', () => {
    expect(checkPickFlagConflicts({ pick: true })).toBeNull();
  });

  it('reports conflict with --from / --url / --version / --rollback / --cleanup', () => {
    expect(checkPickFlagConflicts({ pick: true, from: 'x' })).toContain('--from');
    expect(checkPickFlagConflicts({ pick: true, url: 'x' })).toContain('--url');
    expect(checkPickFlagConflicts({ pick: true, version: '0.1.0' })).toContain('--version');
    expect(checkPickFlagConflicts({ pick: true, rollback: true })).toContain('--rollback');
    expect(checkPickFlagConflicts({ pick: true, cleanup: true })).toContain('--cleanup');
  });

  it('lists every conflicting flag at once', () => {
    const msg = checkPickFlagConflicts({ pick: true, from: 'x', rollback: true })!;
    expect(msg).toContain('--from');
    expect(msg).toContain('--rollback');
  });
});

describe('planNpmSourceUpgrade', () => {
  const NODE = '/n/24.15.0/bin/node';
  const nested = (c: string) =>
    `/n/24.15.0/lib/node_modules/kici-admin/node_modules/@kici-dev/${c}/dist/server.js`;

  it('self-drives with the resolved target when --version is given', () => {
    const action = planNpmSourceUpgrade({
      component: 'orchestrator',
      spec: { execPath: NODE, args: [nested('orchestrator')] },
      invoked: '0.1.27',
      requestedVersion: '0.1.27',
      restartOnly: false,
      force: false,
      windows: false,
    });
    expect(action.kind).toBe('self-drive');
    if (action.kind === 'self-drive') {
      expect(action.target.owningPackage).toBe('kici-admin');
      expect(action.version).toBe('0.1.27');
    }
  });

  it('errors when self-driving without --version', () => {
    const action = planNpmSourceUpgrade({
      component: 'orchestrator',
      spec: { execPath: NODE, args: [nested('orchestrator')] },
      invoked: '0.1.27',
      requestedVersion: undefined,
      restartOnly: false,
      force: false,
      windows: false,
    });
    expect(action.kind).toBe('error');
    if (action.kind === 'error') expect(action.reason).toMatch(/requires --version/);
  });

  it('errors when self-driving an opaque --binary install', () => {
    const action = planNpmSourceUpgrade({
      component: 'orchestrator',
      spec: { execPath: '/opt/kici/orchestrator', args: [] },
      invoked: '0.1.27',
      requestedVersion: '0.1.27',
      restartOnly: false,
      force: false,
      windows: false,
    });
    expect(action.kind).toBe('error');
    if (action.kind === 'error') expect(action.reason).toMatch(/cannot self-install/);
  });

  it('restart-only returns a verifyNpmSourceLaunch verdict', () => {
    const action = planNpmSourceUpgrade({
      component: 'orchestrator',
      spec: { execPath: NODE, args: [nested('orchestrator')] },
      invoked: '0.1.27',
      requestedVersion: undefined,
      restartOnly: true,
      force: false,
      windows: false,
    });
    expect(action.kind).toBe('restart-only');
  });
});

describe('installGlobalPackage', () => {
  const target = {
    nodeExecPath: '/n/bin/node',
    npmPath: '/n/bin/npm',
    owningPackage: 'kici-admin',
  };

  it('runs `<npm> install -g <pkg>@<version>` and reports success', () => {
    const calls: Array<[string, string[]]> = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = installGlobalPackage(target, '0.1.27', run);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([['/n/bin/npm', ['install', '-g', 'kici-admin@0.1.27']]]);
  });

  it('runs npm under the pinned node by prepending its bin dir to the spawn PATH', () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const run = (_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts?.env;
      return { status: 0, stdout: '', stderr: '' };
    };
    installGlobalPackage(target, '0.1.27', run);
    // The pinned node's bin dir must be the FIRST PATH entry so npm's
    // `env node` / wrapper resolves the unit's node, not the shell's active one.
    expect(capturedEnv?.PATH?.split(path.delimiter)[0]).toBe('/n/bin');
  });

  it('reports failure with captured stderr on non-zero exit', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'npm ERR! code EACCES' });
    const res = installGlobalPackage(target, '0.1.27', run);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/EACCES/);
  });
});

describe('restartOntoInstalledPackage — the end of every npm-source upgrade', () => {
  // A launch command whose node and entry exist, as an npm install leaves them.
  let tmp: string;
  let spec: LaunchSpec;
  beforeEach(() => {
    tmp = mkTmp('kici-restart-');
    const dist = path.join(
      tmp,
      'node_modules',
      'kici-admin',
      'node_modules',
      '@kici-dev',
      'agent',
      'dist',
    );
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'bin', 'node'), '');
    fs.writeFileSync(path.join(dist, 'server.js'), READS_ENV_FILE);
    spec = { execPath: path.join(tmp, 'bin', 'node'), args: [path.join(dist, 'server.js')] };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const config: ServiceConfig = {
    name: 'kici-agent-x',
    ...SERVICE_TEXT.agent,
    executablePath: '',
    envFilePath: 'C:\\ProgramData\\kici\\kici-agent-x\\kici-agent-x.env',
    workingDirectory: 'C:\\ProgramData\\kici\\kici-agent-x',
    isUserLevel: false,
    restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
    component: 'agent',
    instanceDir: 'C:\\deploy',
  };
  const running = (manager: ServiceManager) =>
    (manager.status as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'running' });
  const order = (manager: ServiceManager, name: 'stop' | 'install' | 'start') =>
    (manager[name] as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];

  // fails-when: the Windows npm-source upgrade only stops and starts, so the
  // registration an older CLI wrote survives the upgrade.
  it('on Windows registers the service again from its launch command, between stop and start', async () => {
    const manager = makeManager([], 'windows');
    running(manager);
    await restartOntoInstalledPackage({ manager, config, platform: 'windows', spec });
    expect(manager.install).toHaveBeenCalledWith({
      ...config,
      executablePath: spec.execPath,
      args: spec.args,
    });
    expect(order(manager, 'stop')).toBeLessThan(order(manager, 'install'));
    expect(order(manager, 'install')).toBeLessThan(order(manager, 'start'));
  });

  // breaks-if-wrong: systemd and launchd keep their unit and still restart.
  it.each(['systemd', 'launchd'] as const)('on %s only stops and starts', async (platform) => {
    const manager = makeManager([], platform);
    running(manager);
    await restartOntoInstalledPackage({ manager, config, platform, spec });
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
  });

  it('restarts without registering, and says so, when the launch command cannot be read', async () => {
    const manager = makeManager([], 'windows');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warned: unknown;
    try {
      await restartOntoInstalledPackage({ manager, config, platform: 'windows', spec: null });
      warned = warn.mock.calls[0]?.[0];
    } finally {
      warn.mockRestore();
    }
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(String(warned)).toMatch(/not registered again.*kici-admin agent install/);
  });

  // fails-when: a launch command read back wrong (sc.exe prints a non-ASCII
  // path in the console code page, which decodes to U+FFFD) is registered, so
  // the service is left pointing at a file that does not exist.
  it('restarts without registering when the launch command names a file that does not exist', async () => {
    const manager = makeManager([], 'windows');
    running(manager);
    const mangled = { ...spec, args: [spec.args[0]!.replace('node_modules', 'node_m\uFFFDdules')] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warned: unknown;
    try {
      await restartOntoInstalledPackage({ manager, config, platform: 'windows', spec: mangled });
      warned = warn.mock.calls[0]?.[0];
    } finally {
      warn.mockRestore();
    }
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(String(warned)).toMatch(/not registered again.*kici-admin agent install/);
  });

  it('names the remedy when the registration cannot be written, and does not start', async () => {
    const manager = makeManager([], 'windows');
    (manager.install as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('shawl add failed'));
    await expect(
      restartOntoInstalledPackage({ manager, config, platform: 'windows', spec }),
    ).rejects.toThrow(
      /could not register the service again: shawl add failed.*kici-admin agent install/,
    );
    expect(manager.start).not.toHaveBeenCalled();
  });

  // fails-when: the installed package is a release from before KICI_ENV_FILE
  // and the restart stops the service before the driver refuses it, which
  // leaves the service stopped.
  it('on Windows refuses a package from before KICI_ENV_FILE before it stops the service', async () => {
    fs.writeFileSync(spec.args[0]!, PREDATES_ENV_FILE);
    const manager = makeManager([], 'windows');
    running(manager);

    await expect(
      restartOntoInstalledPackage({ manager, config, platform: 'windows', spec }),
    ).rejects.toThrow(`${spec.args[0]} predates KICI_ENV_FILE`);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.install).not.toHaveBeenCalled();
  });
});

describe('npm-source paths end in restartOntoInstalledPackage', () => {
  let tmp: string;
  let entry: string;
  beforeEach(() => {
    tmp = mkTmp('kici-npm-upgrade-');
    const pkgDir = path.join(
      tmp,
      'node_modules',
      'kici-admin',
      'node_modules',
      '@kici-dev',
      'agent',
    );
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@kici-dev/agent', version: '0.2.0' }),
    );
    entry = path.join(pkgDir, 'dist', 'server.js');
    fs.writeFileSync(entry, READS_ENV_FILE);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function fixture(platform: ServicePlatform) {
    const manager = makeManager([], platform);
    const spec = { execPath: path.join(tmp, 'bin', 'node'), args: [entry] };
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
    fs.writeFileSync(spec.execPath, '');
    manager.readLaunchSpec = vi.fn().mockResolvedValue(spec);
    (manager.status as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'running' });
    const manifest = makeManifest({ component: 'agent', name: 'kici-agent-x', platform });
    writeManifest(tmp, manifest);
    const resolvedInstance = {
      manifest,
      manifestPath: path.join(tmp, '.kici-agent.json'),
      instanceDir: tmp,
    };
    const config: ServiceConfig = {
      name: 'kici-agent-x',
      ...SERVICE_TEXT.agent,
      executablePath: '',
      envFilePath: manifest.envFilePath,
      workingDirectory: manifest.configDir,
      isUserLevel: true,
      restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
      component: 'agent',
      instanceDir: tmp,
    };
    const action = {
      target: { nodeExecPath: spec.execPath, npmPath: 'npm', owningPackage: 'kici-admin' },
      version: '0.2.0',
    };
    return { manager, spec, resolvedInstance, config, action };
  }

  /** A runner whose `npm view … exports` answers `exportsJson`; every other npm call succeeds. */
  function npmRunner(exportsJson: string, viewStatus = 0) {
    return vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'view'
        ? { status: viewStatus, stdout: exportsJson, stderr: viewStatus ? 'npm error 404' : '' }
        : { status: 0, stdout: '', stderr: '' },
    );
  }
  const READS_EXPORTS = JSON.stringify({ '.': {}, './load-service-env-file': {} });
  const manifestVersion = () =>
    JSON.parse(fs.readFileSync(path.join(tmp, '.kici-agent.json'), 'utf-8')).kiciVersion;

  it('the self-driving install registers a Windows service again and persists the version', async () => {
    const { manager, spec, resolvedInstance, config, action } = fixture('windows');
    const run = npmRunner(READS_EXPORTS);
    await performSelfDrivingInstall({
      component: 'agent',
      config,
      resolvedInstance,
      manager,
      action,
      opts: { yes: true },
      platform: 'windows',
      spec,
      run,
    });
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['view', '@kici-dev/shared@0.2.0', 'exports', '--json'],
      expect.anything(),
    );
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'kici-admin@0.2.0'],
      expect.anything(),
    );
    expect(manager.install).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: spec.execPath, args: spec.args }),
    );
    expect(manifestVersion()).toBe('0.2.0');
  });

  // fails-when: an npm-source downgrade to a release from before KICI_ENV_FILE
  // installs it, so the service starts it with no configuration.
  it('refuses a Windows downgrade to a release from before KICI_ENV_FILE before it installs anything', async () => {
    const { manager, spec, resolvedInstance, config, action } = fixture('windows');
    const run = npmRunner(JSON.stringify({ '.': {}, './env': {} }));
    await expect(
      performSelfDrivingInstall({
        component: 'agent',
        config,
        resolvedInstance,
        manager,
        action,
        opts: { yes: true },
        platform: 'windows',
        spec,
        run,
      }),
    ).rejects.toThrow(
      /^refusing to install kici-admin@0\.2\.0 for "kici-agent-x": kici-admin@0\.2\.0 predates KICI_ENV_FILE.*The service and the installed package were not changed\.$/s,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.install).not.toHaveBeenCalled();
    expect(manifestVersion()).toBe('0.1.13');
  });

  it('refuses a Windows upgrade whose release npm cannot describe', async () => {
    const { manager, spec, resolvedInstance, config, action } = fixture('windows');
    const run = npmRunner('', 1);
    await expect(
      performSelfDrivingInstall({
        component: 'agent',
        config,
        resolvedInstance,
        manager,
        action,
        opts: { yes: true },
        platform: 'windows',
        spec,
        run,
      }),
    ).rejects.toThrow(
      /could not check whether kici-admin@0\.2\.0 reads KICI_ENV_FILE: npm error 404/,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it('--restart-only registers a Windows service again', async () => {
    const { manager, spec, resolvedInstance, config } = fixture('windows');
    await restartOnlyUpgrade({
      component: 'agent',
      config,
      resolvedInstance,
      manager,
      verdict: { ok: true, version: '0.2.0', manifestVersion: '0.2.0' },
      opts: { yes: true },
      platform: 'windows',
      spec,
    });
    expect(manager.install).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manifestVersion()).toBe('0.2.0');
  });

  // breaks-if-wrong: a systemd unit is left as it is, and no release is refused there.
  it('the self-driving install leaves a systemd unit alone', async () => {
    const { manager, spec, resolvedInstance, config, action } = fixture('systemd');
    const run = npmRunner('');
    await performSelfDrivingInstall({
      component: 'agent',
      config,
      resolvedInstance,
      manager,
      action,
      opts: { yes: true },
      platform: 'systemd',
      spec,
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'kici-admin@0.2.0'],
      expect.anything(),
    );
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.start).toHaveBeenCalledTimes(1);
  });
});

describe('npmReleaseReadsEnvFile — the registry check before a Windows npm-source upgrade', () => {
  const target = {
    nodeExecPath: '/n/bin/node',
    npmPath: '/n/bin/npm',
    owningPackage: 'kici-admin',
  };
  const answer =
    (stdout: string, status = 0) =>
    () => ({ status, stdout, stderr: '' });

  it('reads the loader export from the exports of @kici-dev/shared', () => {
    expect(
      npmReleaseReadsEnvFile(
        target,
        '0.12.0',
        answer(JSON.stringify({ './load-service-env-file': {} })),
      ),
    ).toEqual({ ok: true, reads: true });
    expect(
      npmReleaseReadsEnvFile(target, '0.11.0', answer(JSON.stringify({ './env': {} }))),
    ).toEqual({ ok: true, reads: false });
    expect(npmReleaseReadsEnvFile(target, '0.1.0', answer(''))).toEqual({ ok: true, reads: false });
  });

  // fails-when: a --version that matches several releases (npm prints an
  // array) is reported as a release from before KICI_ENV_FILE.
  it('asks for an exact version when npm matches several', () => {
    const several = JSON.stringify([{ './load-service-env-file': {} }, { './env': {} }]);
    const verdict = npmReleaseReadsEnvFile(target, '0.12', answer(several));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/more than one version.*exact --version/);
  });
});

describe('windowsShellCommand — npm through cmd.exe', () => {
  // fails-when: the npm path is passed unquoted, and cmd.exe runs `C:\Program`.
  it('quotes the npm path, which holds a space on every standard Node.js install', () => {
    expect(
      windowsShellCommand('C:\\Program Files\\nodejs\\npm.cmd', [
        'install',
        '-g',
        'kici-admin@0.11.1-9934',
      ]),
    ).toBe('"C:\\Program Files\\nodejs\\npm.cmd" install -g kici-admin@0.11.1-9934');
  });

  it('accepts a scoped package, a version with build metadata and a flag', () => {
    expect(
      windowsShellCommand('npm', ['view', '@kici-dev/shared@1.0.0+b.1', 'exports', '--json']),
    ).toBe('"npm" view @kici-dev/shared@1.0.0+b.1 exports --json');
  });

  it('refuses an argument cmd.exe would read as syntax', () => {
    expect(() => windowsShellCommand('npm', ['install', '-g', 'kici-admin@1.0.0&calc'])).toThrow(
      /cmd\.exe reads as syntax/,
    );
  });

  it('refuses an npm path holding a double quote', () => {
    expect(() => windowsShellCommand('C:\\a"b\\npm.cmd', [])).toThrow(/double quote/);
  });
});
