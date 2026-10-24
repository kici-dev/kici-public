/**
 * Only the service manager's `list` is stubbed; manifest reads, index
 * reconciliation and refusal formatting run for real in tmpdirs.
 * `resolveUpgradeTarget` builds the ServiceConfig from the on-disk manifest,
 * never re-deriving paths from the service name. The scenarios (refusal,
 * `--instance-dir`, `--name`, CWD manifest) mirror the install/uninstall matrices.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { makeTempDir } from '@kici-dev/test-support/tmp';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
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
import {
  SERVICE_TEXT,
  resolveNpmInstallTarget,
  writeManifest,
  writeIndex,
} from '../../service/index.js';
import type {
  InstanceManifest,
  LaunchSpec,
  ServiceConfig,
  ServiceManager,
  ServicePlatform,
} from '../../service/index.js';
import type { DiscoveredInstance } from '../../service/types.js';
import { SystemdServiceManager } from '../../service/systemd.js';
import { LaunchdServiceManager } from '../../service/launchd.js';
import { serviceCommand as windowsServiceCommand } from '../../service/windows.js';
import {
  renderSystemdBackupService,
  renderSystemdBackupTimer,
  systemdUnitDir,
} from '../../service/backup-timer.js';

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
    tmpInstanceDir = makeTempDir('kici-e3-i-');
    tmpKiciRoot = makeTempDir('kici-e3-c-');
    emptyCwd = makeTempDir('kici-e3-cwd-');
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
    // installBase deliberately differs from getInstallBase(platform, name):
    // re-deriving would break instances installed with a non-default base.
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
    installBase = makeTempDir('kici-switch-base-');
    instanceDir = makeTempDir('kici-switch-inst-');
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

/** A `.tar.gz` in `tmp` holding `orchestrator-0.9.0/` with the given launcher and bundle. */
function releaseArchive(tmp: string, launcherName: string, bundle: string): string {
  const src = path.join(tmp, 'src');
  const release = path.join(src, 'orchestrator-0.9.0');
  fs.mkdirSync(path.join(release, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(release, launcherName), '@echo off\r\n');
  fs.writeFileSync(path.join(release, 'lib', `${launcherName.replace(/\.cmd$/, '')}.cjs`), bundle);
  const out = path.join(tmp, 'orchestrator-0.9.0.tar.gz');
  execSync(`tar -czf "${out}" -C "${src}" orchestrator-0.9.0`);
  return out;
}

/** A system-level Windows orchestrator, as the archive-upgrade checks see it. */
const WINDOWS_ORCH_CONFIG: ServiceConfig = {
  name: 'kici-test',
  ...SERVICE_TEXT.orchestrator,
  executablePath: '',
  envFilePath: 'C:\\ProgramData\\kici\\kici-test\\kici-test.env',
  workingDirectory: 'C:\\ProgramData\\kici\\kici-test',
  isUserLevel: false,
  restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
  component: 'orchestrator',
};

describe('extractRelease — the release an archive upgrade installs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTempDir('kici-extract-release-');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const archive = (launcherName: string, bundle: string) =>
    releaseArchive(tmp, launcherName, bundle);

  const config = WINDOWS_ORCH_CONFIG;

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
    tmp = makeTempDir('kici-install-release-');
    installBase = path.join(tmp, 'base');
    versionedDirPath = path.join(installBase, 'orchestrator-0.9.0');
    // The folder --force would replace: the version the service may run now.
    fs.mkdirSync(versionedDirPath, { recursive: true });
    fs.writeFileSync(path.join(versionedDirPath, 'in-use'), 'x');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const archive = (launcherName: string, bundle: string) =>
    releaseArchive(tmp, launcherName, bundle);

  const config = WINDOWS_ORCH_CONFIG;

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

  // fails-when: a local node_modules entry self-drives, and `npm install -g`
  // lands in a prefix the unit never reads.
  it('refuses a launch entry outside a global npm install, naming both runtimes', () => {
    const action = planNpmSourceUpgrade({
      component: 'orchestrator',
      spec: {
        execPath: NODE,
        args: ['/srv/app/node_modules/@kici-dev/orchestrator/dist/server.js'],
      },
      invoked: '0.1.27',
      requestedVersion: '0.1.27',
      restartOnly: false,
      force: false,
      windows: false,
    });
    expect(action.kind).toBe('error');
    if (action.kind === 'error') {
      expect(action.reason).toMatch(/not inside a global npm install/);
      expect(action.reason).toContain(`The unit runs ${NODE}`);
      expect(action.reason).toContain(`this kici-admin runs ${process.execPath}`);
    }
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
    globalPrefix: '/n',
    npmInvocation: { cmd: '/n/bin/node', preArgs: ['/n/lib/node_modules/npm/bin/npm-cli.js'] },
  };

  // fails-when: the install drops --prefix, or runs npmPath instead of the
  // pinned node with npm-cli.js.
  it('runs `<node> <npm-cli.js> install -g <pkg>@<version> --prefix=<unit prefix>`', () => {
    const calls: Array<[string, string[]]> = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const res = installGlobalPackage(target, '0.1.27', run);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      [
        '/n/bin/node',
        [
          '/n/lib/node_modules/npm/bin/npm-cli.js',
          'install',
          '-g',
          'kici-admin@0.1.27',
          '--prefix=/n',
        ],
      ],
    ]);
  });

  /** The environment installGlobalPackage hands npm. */
  const installEnv = (): NodeJS.ProcessEnv | undefined => {
    let env: NodeJS.ProcessEnv | undefined;
    installGlobalPackage(target, '0.1.27', (_cmd, _args, opts) => {
      env = opts?.env;
      return { status: 0, stdout: '', stderr: '' };
    });
    return env;
  };

  it('runs npm under the pinned node by prepending its bin dir to the spawn PATH', () => {
    // The pinned node's bin dir must be first so npm's `env node` resolves the unit's node.
    expect(installEnv()?.PATH?.split(path.delimiter)[0]).toBe('/n/bin');
  });

  // breaks-if-wrong: an operator-set registry must still reach npm.
  it('keeps the caller npm_config_registry in the child environment', () => {
    vi.stubEnv('npm_config_registry', 'http://registry.example:4873');
    try {
      expect(installEnv()?.npm_config_registry).toBe('http://registry.example:4873');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // fails-when: the npm.cmd fallback passes `--prefix=C:\…`, which
  // windowsShellCommand refuses, or leaves the caller's npm_config_prefix in place.
  it('passes the prefix through npm_config_prefix on the npm.cmd fallback', () => {
    vi.stubEnv('npm_config_prefix', 'C:\\caller');
    vi.stubEnv('NPM_CONFIG_GLOBAL_PREFIX', 'C:\\caller');
    try {
      const cmdTarget = {
        nodeExecPath: 'C:\\node\\node.exe',
        npmPath: 'C:\\node\\npm.cmd',
        owningPackage: 'kici-admin',
        globalPrefix: 'C:\\p',
        npmInvocation: { cmd: 'C:\\node\\npm.cmd', preArgs: [] },
      };
      const calls: Array<[string, string[], NodeJS.ProcessEnv | undefined]> = [];
      const run = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        calls.push([cmd, args, opts?.env]);
        return { status: 0, stdout: '', stderr: '' };
      };
      installGlobalPackage(cmdTarget, '0.1.27', run);
      const [cmd, args, env] = calls[0]!;
      expect(cmd).toBe('C:\\node\\npm.cmd');
      expect(args).toEqual(['install', '-g', 'kici-admin@0.1.27']);
      expect(() => windowsShellCommand(cmd, args)).not.toThrow();
      expect(env?.npm_config_prefix).toBe('C:\\p');
      expect(env?.NPM_CONFIG_GLOBAL_PREFIX).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports failure with captured stderr on non-zero exit', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'npm ERR! code EACCES' });
    const res = installGlobalPackage(target, '0.1.27', run);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/EACCES/);
  });
});

describe('installGlobalPackage — a real npm under a leaked caller prefix', () => {
  // npm ships beside the node running this test in every standard layout
  // (mise, nvm, the official tarball); without it the hermetic install cannot run.
  const hostNpm = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm');
  const hasHostNpm =
    process.platform !== 'win32' && fs.existsSync(path.join(hostNpm, 'bin', 'npm-cli.js'));
  if (!hasHostNpm) {
    console.warn(`skipping the real-npm install test: no npm package at ${hostNpm}`);
  }

  let tmp: string;
  beforeEach(() => {
    tmp = makeTempDir('kici-npm-prefix-');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(!hasHostNpm)(
    "installs into the unit's prefix, never the caller's, and skips the npm wrapper",
    () => {
      // R: the unit's runtime. Its bin/npm is a wrapper that fails, as mise's
      // reshim does without mise on PATH.
      const R = path.join(tmp, 'R');
      fs.mkdirSync(path.join(R, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(R, 'lib', 'node_modules'), { recursive: true });
      fs.symlinkSync(process.execPath, path.join(R, 'bin', 'node'));
      fs.symlinkSync(hostNpm, path.join(R, 'lib', 'node_modules', 'npm'));
      fs.writeFileSync(path.join(R, 'bin', 'npm'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
      // D: the decoy prefix a caller's `npx` environment names.
      const D = path.join(tmp, 'D');
      fs.mkdirSync(D);

      const fixture = path.join(tmp, 'fixture');
      fs.mkdirSync(fixture);
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: 'kici-prefix-probe', version: '1.0.0' }),
      );
      execFileSync(
        process.execPath,
        [path.join(hostNpm, 'bin', 'npm-cli.js'), 'pack', '--pack-destination', tmp],
        {
          cwd: fixture,
          stdio: 'pipe',
          env: { ...process.env, npm_config_cache: path.join(tmp, 'cache') },
        },
      );
      const tarball = path.join(tmp, 'kici-prefix-probe-1.0.0.tgz');

      const resolution = resolveNpmInstallTarget(
        {
          execPath: path.join(R, 'bin', 'node'),
          args: [
            path.join(
              R,
              'lib',
              'node_modules',
              'kici-admin',
              'node_modules',
              '@kici-dev',
              'agent',
              'dist',
              'server.js',
            ),
          ],
        },
        'agent',
        { windows: false },
      );
      if (!resolution.ok) throw new Error(`unresolved: ${resolution.reason}`);
      const target = { ...resolution.target, owningPackage: 'kici-prefix-probe' };

      vi.stubEnv('npm_config_prefix', D);
      vi.stubEnv('npm_config_global_prefix', D);
      vi.stubEnv('npm_config_cache', path.join(tmp, 'cache'));
      vi.stubEnv('npm_config_offline', 'true');
      vi.stubEnv('npm_config_audit', 'false');
      vi.stubEnv('npm_config_fund', 'false');
      vi.stubEnv('npm_config_update_notifier', 'false');
      const res = installGlobalPackage(target, `file:${tarball}`);

      expect(res.stderr).not.toMatch(/ERR/);
      expect(res.ok).toBe(true);
      // fails-when: --prefix is dropped — npm honours the leaked
      // npm_config_prefix (the npx case) and installs into D.
      expect(
        fs.existsSync(path.join(R, 'lib', 'node_modules', 'kici-prefix-probe', 'package.json')),
      ).toBe(true);
      expect(fs.existsSync(path.join(D, 'lib', 'node_modules', 'kici-prefix-probe'))).toBe(false);
      // fails-when: the upgrade runs the version-manager wrapper R/bin/npm,
      // which exits 97 — the install above would have failed.
      expect(target.npmInvocation.cmd).toBe(path.join(R, 'bin', 'node'));
    },
    120_000,
  );
});

describe('restartOntoInstalledPackage — the end of every npm-source upgrade', () => {
  // A launch command whose node and entry exist, as an npm install leaves them.
  let tmp: string;
  let spec: LaunchSpec;
  beforeEach(() => {
    tmp = makeTempDir('kici-restart-');
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
    tmp = makeTempDir('kici-npm-upgrade-');
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
      target: {
        nodeExecPath: spec.execPath,
        npmPath: 'npm',
        owningPackage: 'kici-admin',
        globalPrefix: '/p',
        npmInvocation: { cmd: 'npm', preArgs: [] },
      },
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
      ['view', '@kici-dev/shared@0.2.0', 'exports', '--json', '--prefix=/p'],
      expect.anything(),
    );
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'kici-admin@0.2.0', '--prefix=/p'],
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
    // The caller runs the post-start report only on true: a started service.
    const restarted = await restartOnlyUpgrade({
      component: 'agent',
      config,
      resolvedInstance,
      manager,
      verdict: { ok: true, version: '0.2.0', manifestVersion: '0.2.0' },
      opts: { yes: true },
      platform: 'windows',
      spec,
    });
    expect(restarted).toBe(true);
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
      ['install', '-g', 'kici-admin@0.2.0', '--prefix=/p'],
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
    globalPrefix: '/n',
    npmInvocation: { cmd: '/n/bin/node', preArgs: ['/n/lib/node_modules/npm/bin/npm-cli.js'] },
  };

  // fails-when: the registry check runs without the unit's prefix, so a
  // caller's npmrc under another prefix answers it.
  it('asks through the pinned node and npm-cli.js, with the unit prefix', () => {
    const calls: Array<[string, string[]]> = [];
    npmReleaseReadsEnvFile(target, '0.12.0', (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(calls).toEqual([
      [
        '/n/bin/node',
        [
          '/n/lib/node_modules/npm/bin/npm-cli.js',
          'view',
          '@kici-dev/shared@0.12.0',
          'exports',
          '--json',
          '--prefix=/n',
        ],
      ],
    ]);
  });
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

describe('the bare-metal binaryPath check before an orchestrator upgrade', () => {
  let tmp: string;
  let agent: string;
  let spec: LaunchSpec;
  beforeEach(() => {
    tmp = makeTempDir('kici-bm-upgrade-');
    // The unit's runtime: <prefix>/bin/node running kici-admin's nested orchestrator.
    const prefix = path.join(tmp, 'node', '24.15.0');
    const admin = path.join(prefix, 'lib', 'node_modules', 'kici-admin');
    const orch = path.join(admin, 'node_modules', '@kici-dev', 'orchestrator');
    fs.mkdirSync(path.join(orch, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(admin, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(orch, 'package.json'),
      JSON.stringify({ name: '@kici-dev/orchestrator', version: '0.17.0' }),
    );
    fs.writeFileSync(path.join(orch, 'dist', 'server.js'), READS_ENV_FILE);
    fs.writeFileSync(path.join(admin, 'bin', 'kici-agent.js'), '', { mode: 0o755 });
    agent = path.join(prefix, 'bin', 'kici-agent');
    fs.symlinkSync(path.join(admin, 'bin', 'kici-agent.js'), agent);
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), '', { mode: 0o755 });
    spec = {
      execPath: path.join(prefix, 'bin', 'node'),
      args: [path.join(orch, 'dist', 'server.js')],
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** An orchestrator instance whose scaler config names `binaryPath`. */
  function fixture(binaryPath: string) {
    // JSON is valid YAML, and the scaler config loader reads either.
    const scalers = path.join(tmp, 'scalers.yaml');
    const labelSets = [{ labels: ['linux', 'bare-metal'], binaryPath }];
    const bm = { name: 'bm', type: 'bare-metal', maxAgents: 1, labelSets };
    fs.writeFileSync(scalers, JSON.stringify({ version: 1, scalers: [bm] }));
    const envFilePath = path.join(tmp, 'kici-orch.env');
    fs.writeFileSync(envFilePath, `KICI_SCALER_CONFIG_PATH=${scalers}\n`);
    const manager = makeManager([], 'systemd');
    manager.readLaunchSpec = vi.fn().mockResolvedValue(spec);
    const manifest = makeManifest({ envFilePath, configDir: tmp, name: 'kici-orch' });
    writeManifest(tmp, manifest);
    const resolvedInstance = {
      manifest,
      manifestPath: path.join(tmp, '.kici-orchestrator.json'),
      instanceDir: tmp,
    };
    const config: ServiceConfig = {
      name: 'kici-orch',
      ...SERVICE_TEXT.orchestrator,
      executablePath: '',
      envFilePath,
      workingDirectory: tmp,
      isUserLevel: true,
      restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
      component: 'orchestrator',
      instanceDir: tmp,
    };
    const action = {
      target: {
        nodeExecPath: spec.execPath,
        npmPath: 'npm',
        owningPackage: 'kici-admin',
        globalPrefix: '/p',
        npmInvocation: { cmd: 'npm', preArgs: [] },
      },
      version: '0.17.0',
    };
    const run = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, stdout: '', stderr: '' }));
    return { manager, resolvedInstance, config, action, run };
  }

  it('refuses a self-driving install before npm runs or the service stops', async () => {
    // binaryPath through mise's node/24, which moved to a runtime without kici-agent.
    const { manager, resolvedInstance, config, action, run } = fixture(
      path.join(tmp, 'node', '24', 'bin', 'kici-agent'),
    );
    // fails-when: the check runs after `npm install -g` or after the restart,
    // or never runs for an orchestrator — `run` or a manager seam is called.
    await expect(
      performSelfDrivingInstall({
        component: 'orchestrator',
        config,
        resolvedInstance,
        manager,
        action,
        opts: { yes: true },
        platform: 'systemd',
        spec,
        run,
      }),
    ).rejects.toThrow(
      /^refusing to upgrade "kici-orch":.*Set binaryPath to .*24\.15\.0\/bin\/kici-agent,/s,
    );
    expect(run).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.restart).not.toHaveBeenCalled();
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('refuses a --restart-only upgrade before the service restarts', async () => {
    const { manager, resolvedInstance, config } = fixture('/nowhere/kici-agent');
    await expect(
      restartOnlyUpgrade({
        component: 'orchestrator',
        config,
        resolvedInstance,
        manager,
        verdict: { ok: true, version: '0.17.0', manifestVersion: '0.17.0' },
        opts: { yes: true },
        platform: 'systemd',
        spec,
      }),
    ).rejects.toThrow(/refusing to upgrade "kici-orch"/);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('installs and restarts when binaryPath is the agent under the unit runtime', async () => {
    const { manager, resolvedInstance, config, action, run } = fixture(agent);
    // breaks-if-wrong: the recommended configuration must upgrade as before.
    await performSelfDrivingInstall({
      component: 'orchestrator',
      config,
      resolvedInstance,
      manager,
      action,
      opts: { yes: true },
      platform: 'systemd',
      spec,
      run,
    });
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'kici-admin@0.17.0', '--prefix=/p'],
      expect.anything(),
    );
    expect(manager.start).toHaveBeenCalledTimes(1);
  });

  it('installs and restarts with --skip-binary-path-check despite a missing binaryPath', async () => {
    const { manager, resolvedInstance, config, action, run } = fixture('/nowhere/kici-agent');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await performSelfDrivingInstall({
        component: 'orchestrator',
        config,
        resolvedInstance,
        manager,
        action,
        opts: { yes: true, skipBinaryPathCheck: true },
        platform: 'systemd',
        spec,
        run,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('/nowhere/kici-agent'));
    } finally {
      warn.mockRestore();
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
  });

  describe('--rollback and --pick', () => {
    /** Switch the fixture instance from 0.1.2 to the installed 0.1.1. */
    async function rollBack(binaryPath: string, order: string[]) {
      const { manager, resolvedInstance, config } = fixture(binaryPath);
      const installBase = path.join(tmp, 'install');
      for (const v of ['0.1.1', '0.1.2']) {
        fs.mkdirSync(path.join(installBase, `orchestrator-${v}`), { recursive: true });
      }
      fs.symlinkSync('orchestrator-0.1.2', path.join(installBase, 'orchestrator'));
      (manager.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('start');
      });
      await switchToInstalledVersion({
        component: 'orchestrator',
        platform: 'systemd',
        installBase,
        config,
        manager,
        resolvedInstance,
        targetVersion: '0.1.1',
      });
      return fs.readlinkSync(path.join(installBase, 'orchestrator'));
    }

    it('prints the diagnosis of a missing binaryPath and still switches', async () => {
      const order: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => void order.push('warn'));
      try {
        const active = await rollBack('/nowhere/kici-agent', order);
        // fails-when: the switch runs no check, so the operator learns about
        // the binaryPath only when the restarted service fails to start.
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Warning: bare-metal scaler "bm": binaryPath \/nowhere\/kici-agent is not an executable file.*Set binaryPath to .*24\.15\.0\/bin\/kici-agent,/,
          ),
        );
        // breaks-if-wrong: a recovery switch is never refused for a binaryPath —
        // the rollback still flips the version and starts the service, after the warning.
        expect(order).toEqual(['warn', 'start']);
        expect(active).toBe('orchestrator-0.1.1');
      } finally {
        warn.mockRestore();
      }
    });

    it('switches without a warning when binaryPath is the agent under the unit runtime', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await rollBack(agent, [])).toBe('orchestrator-0.1.1');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

/**
 * `--node <path>`: an npm-source upgrade that moves the service to another
 * Node.js runtime. Every case runs on a real npm-style layout in a temp dir: an
 * old prefix the unit runs from, and a new prefix with its own node and npm.
 * The fake npm "installs" by writing the package into the prefix it was given.
 */
describe('--node moves an npm-installed service to another Node.js runtime', () => {
  type Component = 'agent' | 'orchestrator';
  let tmp: string;
  let oldPrefix: string;
  let newPrefix: string;
  beforeEach(() => {
    tmp = makeTempDir('kici-node-move-');
    oldPrefix = path.join(tmp, 'old');
    newPrefix = path.join(tmp, 'new');
    for (const prefix of [oldPrefix, newPrefix]) {
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(prefix, 'bin', 'node'), '', { mode: 0o755 });
      const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      fs.mkdirSync(path.dirname(npmCli), { recursive: true });
      fs.writeFileSync(npmCli, '');
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const adminDir = (prefix: string) => path.join(prefix, 'lib', 'node_modules', 'kici-admin');
  const entryUnder = (prefix: string, component: Component = 'agent') =>
    path.join(adminDir(prefix), 'node_modules', '@kici-dev', component, 'dist', 'server.js');

  /** Write kici-admin@<version> with its nested component into `prefix`, as `npm install -g` does. */
  function installPackage(
    prefix: string,
    version: string,
    opts: { engines?: string; component?: Component } = {},
  ): void {
    const component = opts.component ?? 'agent';
    const admin = adminDir(prefix);
    const entry = entryUnder(prefix, component);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(path.join(admin, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(admin, 'package.json'),
      JSON.stringify({
        name: 'kici-admin',
        version,
        engines: { node: opts.engines ?? '>=24.5.0' },
      }),
    );
    fs.writeFileSync(
      path.join(path.dirname(path.dirname(entry)), 'package.json'),
      JSON.stringify({ name: `@kici-dev/${component}`, version }),
    );
    fs.writeFileSync(entry, READS_ENV_FILE);
    fs.writeFileSync(path.join(admin, 'bin', 'kici-admin.js'), '');
    const bin = path.join(prefix, 'bin', 'kici-admin');
    if (!fs.existsSync(bin)) fs.symlinkSync(path.join(admin, 'bin', 'kici-admin.js'), bin);
  }

  function fixture(
    platform: ServicePlatform,
    opts: { nodeVersion?: string; engines?: string; component?: Component } = {},
  ) {
    const component = opts.component ?? 'agent';
    installPackage(oldPrefix, '0.26.0', { component });
    const oldSpec: LaunchSpec = {
      execPath: path.join(oldPrefix, 'bin', 'node'),
      args: [entryUnder(oldPrefix, component)],
      user: 'kici',
    };
    // The manager reads back whatever was last registered, as a real one does.
    let registered: LaunchSpec = oldSpec;
    const manager = makeManager([], platform);
    manager.readLaunchSpec = vi.fn(async () => registered);
    manager.install = vi.fn(async (c: ServiceConfig) => {
      registered = { execPath: c.executablePath, args: c.args ?? [], user: c.user };
    });
    (manager.status as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'running' });
    const name = component === 'agent' ? 'kici-agent-x' : 'kici-orch';
    const envFilePath = path.join(tmp, 'svc.env');
    fs.writeFileSync(envFilePath, 'KICI_LOG_LEVEL=info\n');
    const manifest = makeManifest({ component, name, platform, envFilePath, configDir: tmp });
    writeManifest(tmp, manifest);
    const resolvedInstance = {
      manifest,
      manifestPath: path.join(tmp, `.kici-${component}.json`),
      instanceDir: tmp,
    };
    const config: ServiceConfig = {
      name,
      ...SERVICE_TEXT[component],
      executablePath: '',
      envFilePath,
      workingDirectory: tmp,
      isUserLevel: false,
      restartPolicy: { enabled: true, delays: [1], maxRetries: 1, windowSeconds: 1 },
      component,
      instanceDir: tmp,
    };
    const node = {
      nodeExecPath: path.join(newPrefix, 'bin', 'node'),
      nodeVersion: opts.nodeVersion ?? '24.22.1',
      globalPrefix: newPrefix,
      npmCliPath: path.join(newPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      npmPath: path.join(newPrefix, 'bin', 'npm'),
      warnings: [],
    };
    const plan = (restartOnly: boolean) =>
      planNpmSourceUpgrade({
        component,
        spec: oldSpec,
        invoked: '0.27.0',
        requestedVersion: restartOnly ? undefined : '0.27.0',
        restartOnly,
        force: false,
        windows: false,
        node,
      });
    // `npm install -g` into the prefix it was handed; `npm view` answers the env-file check.
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('view')) {
        return { status: 0, stdout: JSON.stringify({ './load-service-env-file': {} }), stderr: '' };
      }
      const prefix = args.find((a) => a.startsWith('--prefix='))!.slice('--prefix='.length);
      installPackage(prefix, '0.27.0', { engines: opts.engines, component });
      return { status: 0, stdout: '', stderr: '' };
    });
    const timerFiles: Record<string, string> = {};
    const timerIo = {
      mkdirp: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn((file: string): string => {
        const content = timerFiles[file];
        if (content === undefined) throw new Error(`ENOENT: ${file}`);
        return content;
      }),
      removeFile: vi.fn(),
      run: vi.fn(),
    };
    const selfDrive = () => {
      const action = plan(false);
      if (action.kind !== 'self-drive') throw new Error(`expected self-drive, got ${action.kind}`);
      return {
        component,
        config,
        resolvedInstance,
        manager,
        action,
        opts: { yes: true },
        platform,
        spec: oldSpec,
        run,
        timerIo,
      };
    };
    return {
      manager,
      oldSpec,
      resolvedInstance,
      config,
      run,
      node,
      timerIo,
      timerFiles,
      plan,
      selfDrive,
    };
  }

  const manifestVersion = (component: Component = 'agent') =>
    JSON.parse(fs.readFileSync(path.join(tmp, `.kici-${component}.json`), 'utf-8')).kiciVersion;

  it('plans the install into the new prefix with its own node and npm-cli.js', () => {
    const { selfDrive, node } = fixture('systemd');
    const { action } = selfDrive();
    expect(action.target).toMatchObject({
      nodeExecPath: node.nodeExecPath,
      globalPrefix: newPrefix,
      owningPackage: 'kici-admin',
      npmInvocation: { cmd: node.nodeExecPath, preArgs: [node.npmCliPath] },
    });
    expect(action.move?.to).toEqual({
      execPath: node.nodeExecPath,
      args: [entryUnder(newPrefix)],
      user: 'kici',
    });
    expect(action.move?.oldPrefix).toBe(oldPrefix);
  });

  it('refuses --node for an opaque --binary launch', () => {
    const { node } = fixture('systemd');
    const action = planNpmSourceUpgrade({
      component: 'agent',
      spec: { execPath: '/opt/kici/agent', args: [] },
      invoked: '0.27.0',
      requestedVersion: '0.27.0',
      restartOnly: false,
      force: false,
      windows: false,
      node,
    });
    expect(action.kind).toBe('error');
    if (action.kind === 'error') expect(action.reason).toMatch(/--node/);
  });

  it('restart-only with --node verifies the package already under the new runtime', () => {
    const { plan, node } = fixture('systemd');
    installPackage(newPrefix, '0.27.0');
    const action = plan(true);
    expect(action.kind).toBe('restart-only');
    if (action.kind === 'restart-only') {
      expect(action.verdict).toMatchObject({ ok: true, version: '0.27.0' });
      expect(action.move?.to.execPath).toBe(node.nodeExecPath);
    }
  });

  /** The registration a real renderer writes from the config `manager.install` got. */
  function rendered(platform: ServicePlatform, config: ServiceConfig): string {
    if (platform === 'systemd') return new SystemdServiceManager().generateUnitFile(config);
    if (platform === 'launchd') return new LaunchdServiceManager().generatePlist(config);
    return windowsServiceCommand(config).join(' ');
  }

  it.each<ServicePlatform>(['systemd', 'launchd', 'windows'])(
    'self-drive with --node installs into the new prefix and re-registers onto it (%s)',
    async (platform) => {
      const { manager, run, node, selfDrive } = fixture(platform);
      await performSelfDrivingInstall(selfDrive());
      expect(run).toHaveBeenCalledWith(
        node.nodeExecPath,
        [node.npmCliPath, 'install', '-g', 'kici-admin@0.27.0', `--prefix=${newPrefix}`],
        expect.anything(),
      );
      expect(manager.install).toHaveBeenCalledTimes(1);
      const registeredConfig = (manager.install as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as ServiceConfig;
      expect(registeredConfig).toMatchObject({
        executablePath: node.nodeExecPath,
        args: [entryUnder(newPrefix)],
        nodeBinDir: path.join(newPrefix, 'bin'),
        user: 'kici',
      });
      const unit = rendered(platform, registeredConfig);
      expect(unit).toContain(node.nodeExecPath);
      expect(unit).toContain(entryUnder(newPrefix));
      expect(unit).not.toContain(oldPrefix + path.sep);
      if (platform === 'systemd') {
        expect(unit).toContain(`ExecStart=${node.nodeExecPath} ${entryUnder(newPrefix)}`);
        expect(unit).toContain(`Environment=PATH=${path.join(newPrefix, 'bin')}:`);
        expect(unit).toContain('User=kici');
      }
      if (platform === 'launchd') {
        expect(unit).toContain(`<string>${path.join(newPrefix, 'bin')}:`);
        expect(unit).toContain('<key>UserName</key>');
      }
      expect(manager.stop).toHaveBeenCalledTimes(1);
      expect(manager.start).toHaveBeenCalledTimes(1);
      expect(manifestVersion()).toBe('0.27.0');
      // The old runtime is left as it was.
      const oldAdmin = path.join(adminDir(oldPrefix), 'package.json');
      expect(JSON.parse(fs.readFileSync(oldAdmin, 'utf-8')).version).toBe('0.26.0');
    },
  );

  // breaks-if-wrong for every refusal: the old registration stays untouched.
  it('refuses a node below the installed package engines.node; the old registration is untouched', async () => {
    const { manager, run, selfDrive } = fixture('systemd', { nodeVersion: '22.20.0' });
    await expect(performSelfDrivingInstall(selfDrive())).rejects.toThrow(
      /22\.20\.0.*>=24\.5\.0.*not changed/s,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.restart).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manifestVersion()).toBe('0.1.13');
  });

  // breaks-if-wrong: a release whose engines.node the new runtime meets moves.
  it('moves when the new node meets a stricter engines.node', async () => {
    const { manager, selfDrive } = fixture('systemd', { engines: '>=24.22.0' });
    await performSelfDrivingInstall(selfDrive());
    expect(manager.install).toHaveBeenCalledTimes(1);
  });

  // fails-when: the unit still launches the old node; the version check alone
  // would pass, because the package version is the same under both prefixes.
  it('post-restart verification reads the new node from the launch spec', async () => {
    const { manager, oldSpec, selfDrive } = fixture('systemd');
    const args = selfDrive();
    installPackage(oldPrefix, '0.27.0');
    // A registration that did not take: the unit still names the old node.
    manager.install = vi.fn().mockResolvedValue(undefined);
    await expect(performSelfDrivingInstall(args)).rejects.toThrow(
      `launches ${oldSpec.execPath}, expected ${path.join(newPrefix, 'bin', 'node')}`,
    );
    expect(manifestVersion()).toBe('0.1.13');
  });

  it('--node rewrites an installed backup unit with the new node and CLI script path', async () => {
    const { oldSpec, config, node, timerIo, timerFiles, selfDrive } = fixture('systemd', {
      component: 'orchestrator',
    });
    const timerConfig = {
      serviceName: 'kici-orch',
      schedule: 'daily',
      outputDir: path.join(tmp, 'backups'),
      keep: 7,
      nodeBinPath: oldSpec.execPath,
      cliScriptPath: path.join(oldPrefix, 'bin', 'kici-admin'),
      envFilePath: config.envFilePath,
      isUserLevel: false,
      user: 'kici',
    };
    const unitDir = systemdUnitDir(false);
    const servicePath = path.join(unitDir, 'kici-orch-db-backup.service');
    timerFiles[servicePath] = renderSystemdBackupService(timerConfig);
    timerFiles[path.join(unitDir, 'kici-orch-db-backup.timer')] =
      renderSystemdBackupTimer(timerConfig);
    await performSelfDrivingInstall(selfDrive());
    expect(timerIo.writeFile).toHaveBeenCalledWith(
      servicePath,
      renderSystemdBackupService({
        ...timerConfig,
        nodeBinPath: node.nodeExecPath,
        cliScriptPath: path.join(newPrefix, 'bin', 'kici-admin'),
      }),
    );
    expect(timerIo.run).toHaveBeenCalledWith('systemctl', ['daemon-reload']);
    expect(manifestVersion('orchestrator')).toBe('0.27.0');
  });

  it('a --node move with no backup unit installed writes no timer file', async () => {
    const { timerIo, selfDrive } = fixture('systemd', { component: 'orchestrator' });
    await performSelfDrivingInstall(selfDrive());
    expect(timerIo.readFile).toHaveBeenCalled();
    expect(timerIo.writeFile).not.toHaveBeenCalled();
    expect(timerIo.run).not.toHaveBeenCalled();
  });

  it('--restart-only with --node re-registers onto the new runtime', async () => {
    const { manager, oldSpec, resolvedInstance, config, node, timerIo, plan } = fixture('systemd');
    installPackage(newPrefix, '0.27.0');
    const action = plan(true);
    if (action.kind !== 'restart-only') throw new Error('expected restart-only');
    await restartOnlyUpgrade({
      component: 'agent',
      config,
      resolvedInstance,
      manager,
      verdict: action.verdict,
      move: action.move,
      opts: { yes: true },
      platform: 'systemd',
      spec: oldSpec,
      timerIo,
    });
    expect(manager.install).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: node.nodeExecPath, args: [entryUnder(newPrefix)] }),
    );
    expect(manifestVersion()).toBe('0.27.0');
  });

  it('warns about a bare-metal binaryPath on the runtime the orchestrator leaves', async () => {
    const { config, selfDrive } = fixture('systemd', { component: 'orchestrator' });
    const scalers = path.join(tmp, 'scalers.yaml');
    const oldAgent = path.join(oldPrefix, 'bin', 'kici-agent');
    fs.writeFileSync(oldAgent, '', { mode: 0o755 });
    const labelSets = [{ labels: ['linux', 'bare-metal'], binaryPath: oldAgent }];
    const bm = { name: 'bm', type: 'bare-metal', maxAgents: 1, labelSets };
    fs.writeFileSync(scalers, JSON.stringify({ version: 1, scalers: [bm] }));
    fs.writeFileSync(config.envFilePath, `KICI_SCALER_CONFIG_PATH=${scalers}\n`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await performSelfDrivingInstall(selfDrive());
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Set binaryPath to ${path.join(newPrefix, 'bin', 'kici-agent')}`),
      );
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The pre-stop safety every orchestrator upgrade runs (dump, drain, the
   * replaced version's migration head), on the npm-source paths. `order`
   * records each hook and each manager call, so the test reads the sequence.
   */
  describe('the pre-upgrade dump and drain on an npm-source orchestrator upgrade', () => {
    function recordingHooks(order: string[], opts: { backupFails?: boolean } = {}) {
      return {
        migrationStatus: vi.fn(async () => {
          order.push('migrationStatus');
          return { migrations: [{ name: '2026_10_01_head', status: 'applied' }] };
        }),
        backup: vi.fn(async (a: { outputPath: string; envFilePath: string }) => {
          order.push('backup');
          if (opts.backupFails) throw new Error('pg_dump: connection refused');
          return { outputPath: a.outputPath, byteSize: 42 };
        }),
        drain: vi.fn(async () => {
          order.push('drain');
          return { quiesced: true, jobsRunning: 0 };
        }),
      };
    }

    function recordManager(manager: ServiceManager, order: string[]): void {
      for (const verb of ['stop', 'start', 'install'] as const) {
        const inner = manager[verb] as (c: ServiceConfig) => Promise<void>;
        manager[verb] = vi.fn(async (c: ServiceConfig) => {
          order.push(verb);
          await inner(c);
        });
      }
    }

    const heads = () =>
      JSON.parse(fs.readFileSync(path.join(tmp, '.kici-orchestrator.json'), 'utf-8'))
        .migrationHeads as Record<string, string> | undefined;

    // fails-when: the npm-source path restarts with no dump and no drain, as
    // only the archive path called the pre-stop safety.
    it.each([
      ['a plain self-drive', false],
      ['a --node move', true],
    ])('%s dumps and drains before the service stops', async (_label, withNode) => {
      const order: string[] = [];
      const { manager, selfDrive, oldSpec, run } = fixture('systemd', {
        component: 'orchestrator',
      });
      recordManager(manager, order);
      const args = selfDrive();
      const action = withNode
        ? args.action
        : {
            target: {
              nodeExecPath: oldSpec.execPath,
              npmPath: path.join(oldPrefix, 'bin', 'npm'),
              owningPackage: 'kici-admin',
              globalPrefix: oldPrefix,
              npmInvocation: {
                cmd: oldSpec.execPath,
                preArgs: [path.join(oldPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')],
              },
            },
            version: '0.27.0',
          };
      const hooks = recordingHooks(order);
      const recordingRun = vi.fn((cmd: string, a: string[]) => {
        order.push('npm');
        return run(cmd, a);
      });
      await performSelfDrivingInstall({ ...args, action, hooks, run: recordingRun });
      // The dump comes before npm replaces anything; the drain right before the stop.
      expect(order.slice(0, 5)).toEqual(['migrationStatus', 'backup', 'npm', 'drain', 'stop']);
      expect(hooks.backup.mock.calls[0]![0].outputPath).toMatch(
        /pre-upgrade-0\.1\.13-0\.27\.0-.*\.dump$/,
      );
      // The replaced version's head is recorded for a later rollback check.
      expect(heads()).toEqual({ '0.1.13': '2026_10_01_head' });
    });

    it('--restart-only of an orchestrator dumps and drains before the service stops', async () => {
      const order: string[] = [];
      const { manager, resolvedInstance, config, oldSpec, timerIo } = fixture('systemd', {
        component: 'orchestrator',
      });
      recordManager(manager, order);
      const hooks = recordingHooks(order);
      await restartOnlyUpgrade({
        component: 'orchestrator',
        config,
        resolvedInstance,
        manager,
        verdict: { ok: true, version: '0.26.0', manifestVersion: '0.26.0' },
        opts: { yes: true },
        platform: 'systemd',
        spec: oldSpec,
        timerIo,
        hooks,
      });
      expect(order.slice(0, 4)).toEqual(['migrationStatus', 'backup', 'drain', 'stop']);
      // fails-when: the dump is named from --version, which --restart-only
      // leaves out, so it reads `-next-` instead of the version restarted onto.
      expect(hooks.backup.mock.calls[0]![0].outputPath).toMatch(
        /pre-upgrade-0\.1\.13-0\.26\.0-.*\.dump$/,
      );
      expect(heads()).toEqual({ '0.1.13': '2026_10_01_head' });
    });

    // fails-when: the drain moves before `npm install`, so a failed install
    // exits with the running coordinator left draining and accepting no work.
    it('a failed npm install after the dump leaves the coordinator undrained', async () => {
      const order: string[] = [];
      const { manager, selfDrive } = fixture('systemd', { component: 'orchestrator' });
      recordManager(manager, order);
      const hooks = recordingHooks(order);
      const failingRun = vi.fn((_cmd: string, _a: string[]) => {
        order.push('npm');
        return { status: 1, stdout: '', stderr: 'npm error code E404' };
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          performSelfDrivingInstall({ ...selfDrive(), hooks, run: failingRun }),
        ).rejects.toThrow('process.exit(1)');
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
      expect(order).toEqual(['migrationStatus', 'backup', 'npm']);
      expect(hooks.drain).not.toHaveBeenCalled();
      expect(manager.stop).not.toHaveBeenCalled();
      expect(manifestVersion('orchestrator')).toBe('0.1.13');
    });

    // breaks-if-wrong: a failed dump refuses before anything is touched, as on
    // the archive path; the old registration stays.
    it('a failed dump leaves the old registration untouched', async () => {
      const order: string[] = [];
      const { manager, selfDrive, run } = fixture('systemd', { component: 'orchestrator' });
      recordManager(manager, order);
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          performSelfDrivingInstall({
            ...selfDrive(),
            hooks: recordingHooks(order, { backupFails: true }),
          }),
        ).rejects.toThrow('process.exit(1)');
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
      expect(order).toEqual(['migrationStatus', 'backup']);
      // Nothing was installed: neither into the new runtime nor in place.
      expect(run).not.toHaveBeenCalled();
      expect(manager.install).not.toHaveBeenCalled();
      expect(manager.stop).not.toHaveBeenCalled();
      expect(manager.start).not.toHaveBeenCalled();
      expect(manifestVersion('orchestrator')).toBe('0.1.13');
    });

    it('--skip-backup and --no-drain opt out on the npm path as on the archive path', async () => {
      const order: string[] = [];
      const { manager, selfDrive } = fixture('systemd', { component: 'orchestrator' });
      recordManager(manager, order);
      const args = selfDrive();
      const hooks = recordingHooks(order);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await performSelfDrivingInstall({
          ...args,
          opts: { yes: true, skipBackup: true, noDrain: true },
          hooks,
        });
      } finally {
        log.mockRestore();
      }
      expect(hooks.backup).not.toHaveBeenCalled();
      expect(hooks.drain).not.toHaveBeenCalled();
      expect(order[0]).toBe('migrationStatus');
    });

    // breaks-if-wrong: an agent has no database and no drain, as on the archive path.
    it('an agent npm-source upgrade calls no pre-stop hook', async () => {
      const order: string[] = [];
      const { manager, selfDrive } = fixture('systemd');
      recordManager(manager, order);
      const hooks = recordingHooks(order);
      await performSelfDrivingInstall({ ...selfDrive(), hooks });
      expect(hooks.migrationStatus).not.toHaveBeenCalled();
      expect(hooks.backup).not.toHaveBeenCalled();
      expect(hooks.drain).not.toHaveBeenCalled();
      expect(order[0]).toBe('stop');
    });
  });
});
