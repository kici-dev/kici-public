/**
 * Versioned-directory upgrade shared by the kici-admin upgrade commands: each
 * release extracts beside the old ones, the symlink (Unix) or service
 * registration (Windows) switches atomically, and old releases stay for
 * rollback until `--cleanup`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execSync, spawnSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import {
  DEFAULT_RESTART_POLICY,
  ENV_FILE_LOADER_EXPORT,
  SERVICE_TEXT,
  envFileRefusal,
  isRoot,
  launchReadsEnvFile,
  launchedRelease,
  kiciConfigRoot,
  readKiciVersion,
  resolveInstanceTarget,
  resolveNpmInstallTarget,
  resolveVersionFromLaunchSpec,
  writeManifest,
  type NpmInstallTarget,
  type ResolvedInstance,
  type ServiceManager,
  type ServicePlatform,
} from '../../service/index.js';
import type { LaunchSpec, ServiceConfig } from '../../service/types.js';
import { toErrorMessage } from '@kici-dev/shared';
import {
  appliedHead,
  backupRefusalMessage,
  drainTimeoutMessage,
  mergeMigrationHead,
  readLiveMigrationRows,
  SCHEMA_NOT_CHECKED,
  schemaGuardVerdict,
  type MigrationStatusRow,
} from './upgrade-safety.js';
import { makeTempDir } from '@kici-dev/shared/tmp';
import { confirmPrompt } from './confirm.js';
import { preflightBareMetalBinaryPaths } from './bare-metal-binary-check.js';
import { agentBinaryFromLaunch } from '../../../scaler/agent-binary-location.js';

export type UpgradeComponent = 'orchestrator' | 'agent';

export interface VersionedUpgradeOptions {
  platform?: ServicePlatform;
  /** No default: {@link resolveInstanceTarget} picks the target. */
  name?: string;
  instanceDir?: string;
  from?: string;
  url?: string;
  version?: string;
  yes?: boolean;
  cleanup?: boolean;
  rollback?: boolean;
  pick?: boolean;
  force?: boolean;
  /** Restart the already-installed package without the npm install (pre-staged / air-gapped). */
  restartOnly?: boolean;
  /** Skip the pre-upgrade dump. Loud: printed as a banner and echoed at the end. */
  skipBackup?: boolean;
  /** Where the pre-upgrade dump goes. Defaults to `<instanceDir>/backups`. */
  backupDir?: string;
  /** Skip quiescing the coordinator before the restart. */
  noDrain?: boolean;
  /** Seconds to wait for in-flight jobs to finish. Default 300. */
  drainTimeout?: string;
  /**
   * On a rollback whose database is ahead of the target, revert the schema to
   * the target's recorded head first, through the still-running newer service.
   */
  migrateDown?: boolean;
  /**
   * Upgrade even when a bare-metal scaler's `binaryPath` is not executable or is
   * a version-manager shim. The check still prints what it found.
   */
  skipBinaryPathCheck?: boolean;
}

/**
 * Check every bare-metal `binaryPath` of an orchestrator before the upgrade
 * installs or restarts anything. `spec` is the unit's launch command: the
 * `kici-agent` installed with its runtime is the one each `binaryPath` should
 * name. `expectedVersion` is what that agent runs after the upgrade, when the
 * caller knows it. Throws when a `binaryPath` would stop the restarted service,
 * unless `skip` is set: then every finding is a warning.
 */
async function checkBareMetalBinaryPathsBeforeUpgrade(args: {
  component: UpgradeComponent;
  config: ServiceConfig;
  platform: ServicePlatform;
  spec: LaunchSpec | null;
  expectedVersion: string | null;
  willInstall: boolean;
  skip: boolean;
}): Promise<void> {
  // An agent upgrade has no scalers, and a compose service runs its scalers
  // inside a container whose paths this host cannot check.
  if (args.component !== 'orchestrator' || args.platform === 'compose') return;
  const expectedAgent = args.spec
    ? agentBinaryFromLaunch(args.spec, isWindows(args.platform))
    : null;
  await preflightBareMetalBinaryPaths({
    serviceName: args.config.name,
    envFilePath: args.config.envFilePath,
    workingDirectory: args.config.workingDirectory,
    expectedAgent,
    expectedVersion: expectedAgent ? args.expectedVersion : null,
    willInstall: args.willInstall && expectedAgent !== null,
    skip: args.skip,
    warn: (line) => console.warn(line),
  });
}

/**
 * The orchestrator-only pre-stop steps, injected so the agent upgrade can pass
 * none and stay unchanged, and so each is testable without a live service.
 */
export interface UpgradeHooks {
  /** Read the live migration ledger from the running service. */
  migrationStatus?: () => Promise<{ migrations: MigrationStatusRow[] }>;
  /** Put the coordinator into drain and poll until quiesced. */
  drain?: (timeoutSeconds: number) => Promise<{ quiesced: boolean; jobsRunning: number }>;
  /** Revert the schema to `head` through the running service. */
  migrateDown?: (head: string) => Promise<void>;
  /**
   * Take the pre-upgrade dump. `envFilePath` comes from the instance manifest,
   * so the dump hits the database the running service uses, not whatever the
   * operator's shell exports.
   */
  backup?: (args: {
    outputPath: string;
    envFilePath: string;
  }) => Promise<{ outputPath: string; byteSize: number }>;
}

/** The manifest-backed target; `installBase` is the manifest's, never re-derived from the name. */
export interface UpgradeTarget {
  config: ServiceConfig;
  installBase: string;
  resolvedInstance: ResolvedInstance;
  /** Built for {@link UpgradeTarget.platform}. */
  manager: ServiceManager;
  /**
   * `platformOverride ?? manifest.platform`. Every downstream question (root
   * check, launcher name, symlink vs version file) is about the layout on disk,
   * so it is answered from the install, not the host.
   */
  platform: ServicePlatform;
}

/**
 * Resolve the upgrade target through {@link resolveInstanceTarget}: `instanceDir`,
 * then `name`, then the CWD `./.kici-<component>.json`, else refuse with a
 * candidate list. `installBase` comes from the manifest, never re-derived from
 * the name, so an install with a non-default base keeps it on upgrade.
 */
export async function resolveUpgradeTarget(args: {
  component: UpgradeComponent;
  opts: { instanceDir?: string; name?: string };
  /** The `--platform` flag; forces the driver when set. */
  platformOverride?: ServicePlatform;
  isUserLevel: boolean;
  kiciRoot: string;
  /** Defaults to the service barrel's createServiceManager. */
  createManager?: (platform: ServicePlatform) => Promise<ServiceManager>;
}): Promise<UpgradeTarget> {
  const { component, opts, isUserLevel, kiciRoot } = args;
  const { resolved, manager, platform } = await resolveInstanceTarget({
    component,
    opts: { instanceDir: opts.instanceDir, name: opts.name },
    cwd: process.cwd(),
    kiciRoot,
    platformOverride: args.platformOverride,
    isUserLevel,
    createManager: args.createManager,
  });
  const config: ServiceConfig = {
    name: resolved.manifest.name,
    ...SERVICE_TEXT[component],
    executablePath: '',
    envFilePath: resolved.manifest.envFilePath,
    workingDirectory: resolved.manifest.configDir,
    isUserLevel: resolved.manifest.isUserLevel,
    // The shared constant, not a copy that drifts: on Windows `upgrade`
    // re-registers the service from this config.
    restartPolicy: DEFAULT_RESTART_POLICY,
    component,
    // Keeps recovery working if the instance index is later lost.
    instanceDir: resolved.instanceDir,
  };
  return {
    config,
    installBase: resolved.manifest.installBase,
    resolvedInstance: resolved,
    manager,
    platform,
  };
}

/** Prompt the user for confirmation on stdout, beside the upgrade plan it follows. */
function confirm(message: string): Promise<boolean> {
  return confirmPrompt(`${message} [y/N] `, { input: process.stdin, output: process.stdout });
}

async function downloadArchive(url: string, destPath: string): Promise<void> {
  console.log(`Downloading from ${url}...`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const fileStream = createWriteStream(destPath);
  await pipeline(res.body, fileStream);
  console.log(`Downloaded to ${destPath}`);
}

/**
 * Name-scoped install base, so two instances of one component on a host own
 * independent versioned trees and symlinks.
 */
export function getInstallBase(platform: ServicePlatform, name: string): string {
  const sep = platform === 'windows' ? '\\' : '/';
  switch (platform) {
    case 'systemd':
    case 'compose':
      return `/opt/kici/${name}${sep}`;
    case 'launchd':
      return `/usr/local/kici/${name}${sep}`;
    case 'windows':
      return `C:\\Program Files\\KiCI\\${name}${sep}`;
  }
}

export interface PickChoice {
  value: string;
  name: string;
  /** `false` when selectable; a reason string when disabled (inquirer renders it). */
  disabled: boolean | string;
}

/**
 * `--pick` choices, newest-first (lexicographic, like the rest of the
 * versioned-directory handling). The active version is disabled: picking it
 * would be a no-op restart.
 */
export function buildPickChoices(versions: string[], current: string | null): PickChoice[] {
  return [...versions]
    .sort()
    .reverse()
    .map((v) => ({
      value: v,
      name: v === current ? `${v} (current)` : v,
      disabled: v === current ? 'current version' : false,
    }));
}

/** Every installed version except the active one; empty means "nothing to pick". */
export function selectablePickTargets(versions: string[], current: string | null): string[] {
  return versions.filter((v) => v !== current);
}

/**
 * `--pick` activates an installed version, so it excludes `--from`, `--url`,
 * `--version`, `--rollback` and `--cleanup`. Returns an error message, or null.
 */
export function checkPickFlagConflicts(opts: {
  pick?: boolean;
  from?: string;
  url?: string;
  version?: string;
  rollback?: boolean;
  cleanup?: boolean;
}): string | null {
  if (!opts.pick) return null;
  const conflicts: string[] = [];
  if (opts.from) conflicts.push('--from');
  if (opts.url) conflicts.push('--url');
  if (opts.version) conflicts.push('--version');
  if (opts.rollback) conflicts.push('--rollback');
  if (opts.cleanup) conflicts.push('--cleanup');
  if (conflicts.length === 0) return null;
  return (
    `--pick cannot be combined with ${conflicts.join(', ')}. ` +
    `--pick activates an already-installed version; it never downloads or takes an explicit version.`
  );
}

/**
 * Point the Windows service at `launcherPath`. sc.exe has no "update binary
 * path", so `install` replaces the registration: it checks the new launch
 * command first, then removes the old service and waits until it is gone
 * before it creates the new one. A launch command it refuses leaves the old
 * registration in place.
 */
async function reregisterWindowsService(
  manager: ServiceManager,
  config: ServiceConfig,
  launcherPath: string,
): Promise<void> {
  config.executablePath = launcherPath;
  await manager.install(config);
}

function isWindows(platform: ServicePlatform): boolean {
  return platform === 'windows';
}

/**
 * Refuse to point a Windows service at a release from before KICI_ENV_FILE.
 * Every caller runs it before it stops the service, so a refused switch leaves
 * the service registered and running as it was.
 */
function assertWindowsLaunchReadsEnvFile(args: {
  launch: { executablePath: string; args?: string[] };
  /** How the refusal names the release. */
  release: string;
  /** What was refused, for example `switch "<name>" to <version>`. */
  action: string;
  config: ServiceConfig;
}): void {
  if (launchReadsEnvFile(args.launch)) return;
  throw new Error(
    `refusing to ${args.action}: ${envFileRefusal(args.release, args.config.envFilePath)} ` +
      'The service was not changed.',
  );
}

/**
 * The restart every npm-source upgrade ends with: stop, re-register on
 * Windows, start. `npm install -g` replaces the package in place, so `spec`
 * stays valid; on Windows the registration around it (wrapper arguments,
 * description, recovery settings) is whatever the installing CLI wrote, so
 * `install` rewrites it. A launch command naming a missing file was read back
 * wrong and is not registered: the service restarts as it was, with a warning.
 * systemd and launchd keep their unit.
 */
export async function restartOntoInstalledPackage(args: {
  manager: ServiceManager;
  config: ServiceConfig;
  platform: ServicePlatform;
  spec: LaunchSpec | null;
}): Promise<void> {
  const { manager, config, platform, spec } = args;
  const component = config.component ?? 'orchestrator';
  const read = spec ? { executablePath: spec.execPath, args: spec.args } : null;
  const launch =
    read && fs.existsSync(read.executablePath) && fs.existsSync(launchedRelease(read))
      ? read
      : null;
  if (isWindows(platform) && launch) {
    assertWindowsLaunchReadsEnvFile({
      launch,
      release: launchedRelease(launch),
      action: `restart "${config.name}" onto the installed package`,
      config,
    });
  }
  const status = await manager.status(config);
  if (status.state === 'running') await manager.stop(config);
  if (isWindows(platform)) {
    if (launch) {
      try {
        await manager.install({ ...config, ...launch });
      } catch (err) {
        throw new Error(
          `could not register the service again: ${toErrorMessage(err)}. ` +
            `Run \`kici-admin ${component} install\` for it.`,
          { cause: err },
        );
      }
      console.log('Service registration rewritten from the current installer.');
    } else {
      console.warn(
        'Warning: the service was not registered again, because its launch command could not ' +
          `be read, or names a file that does not exist. Run \`kici-admin ${component} install\` for it to apply the current registration.`,
      );
    }
  }
  await manager.start(config);
}

function getLauncherName(component: UpgradeComponent, platform: ServicePlatform): string {
  const baseName = component === 'orchestrator' ? 'kici-orchestrator-standalone' : 'kici-agent';
  return isWindows(platform) ? `${baseName}.cmd` : baseName;
}

/** Extract a .tar.gz or .zip and return its top-level directory name. */
function extractArchive(archivePath: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    if (os.platform() === 'win32') {
      execSync(
        `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: 'inherit' },
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  }

  const entries = fs.readdirSync(destDir);
  const dirs = entries.filter((e) => fs.statSync(path.join(destDir, e)).isDirectory());
  if (dirs.length === 0) {
    throw new Error('Archive does not contain a directory');
  }
  return dirs[0]!;
}

/**
 * Extract a release archive into `tmpDir` and return the release folder in it.
 * On Windows a release from before KICI_ENV_FILE is refused here, before
 * anything is copied into the install base or the service is stopped.
 */
export function extractRelease(args: {
  archivePath: string;
  tmpDir: string;
  component: UpgradeComponent;
  platform: ServicePlatform;
  version: string;
  config: ServiceConfig;
}): string {
  const { archivePath, tmpDir, component, platform, version, config } = args;
  const extractDir = path.join(tmpDir, 'extract');
  const srcDir = path.join(extractDir, extractArchive(archivePath, extractDir));
  if (isWindows(platform)) {
    assertWindowsLaunchReadsEnvFile({
      launch: { executablePath: path.join(srcDir, getLauncherName(component, platform)) },
      release: `version ${version}`,
      action: `upgrade "${config.name}" to ${version}`,
      config,
    });
  }
  return srcDir;
}

/**
 * Put the release at `versionedDirPath`. It is extracted and checked first
 * ({@link extractRelease}); only then is an existing folder there removed
 * (the caller allows that with `--force`). A refused release leaves the
 * install base as it was.
 */
export function installRelease(args: {
  archivePath: string;
  tmpDir: string;
  installBase: string;
  versionedDirPath: string;
  component: UpgradeComponent;
  platform: ServicePlatform;
  version: string;
  config: ServiceConfig;
}): void {
  const { installBase, versionedDirPath, platform } = args;
  const srcDir = extractRelease(args);
  if (fs.existsSync(versionedDirPath)) {
    console.log(`Removing existing directory ${versionedDirPath} (--force)`);
    fs.rmSync(versionedDirPath, { recursive: true, force: true });
  }
  // A platform copy handles a move across devices (e.g., /tmp on tmpfs to
  // /opt/kici on disk).
  fs.mkdirSync(installBase, { recursive: true });
  if (isWindows(platform)) {
    execSync(`xcopy "${srcDir}" "${versionedDirPath}" /E /I /Q /Y`, { stdio: 'inherit' });
  } else {
    execSync(`cp -r "${srcDir}" "${versionedDirPath}"`, { stdio: 'inherit' });
  }
  console.log(`Extracted to ${versionedDirPath}`);
}

/** Installed versions: the `{component}-{version}/` directories under the install base. */
function listInstalledVersions(installBase: string, component: UpgradeComponent): string[] {
  if (!fs.existsSync(installBase)) return [];
  const prefix = `${component}-`;
  return fs
    .readdirSync(installBase)
    .filter((entry) => {
      if (!entry.startsWith(prefix)) return false;
      const fullPath = path.join(installBase, entry);
      return fs.statSync(fullPath).isDirectory();
    })
    .map((entry) => entry.slice(prefix.length))
    .sort();
}

/**
 * The active version, from the symlink target, or on Windows from the
 * version file. Null when neither exists.
 */
function getCurrentVersion(
  installBase: string,
  component: UpgradeComponent,
  platform: ServicePlatform,
): string | null {
  if (isWindows(platform)) {
    const versionFile = path.join(installBase, `${component}-current-version.txt`);
    try {
      return fs.readFileSync(versionFile, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  const symlinkPath = path.join(installBase, component);
  try {
    const target = fs.readlinkSync(symlinkPath);
    const prefix = `${component}-`;
    if (target.startsWith(prefix)) {
      return target.slice(prefix.length);
    }
    // An absolute target.
    const basename = path.basename(target);
    if (basename.startsWith(prefix)) {
      return basename.slice(prefix.length);
    }
  } catch {
    // Missing, or not a symlink.
  }
  return null;
}

/** Windows has no symlink, so the active version lives in a file. */
function writeCurrentVersion(
  installBase: string,
  component: UpgradeComponent,
  version: string,
): void {
  const versionFile = path.join(installBase, `${component}-current-version.txt`);
  fs.writeFileSync(versionFile, version, 'utf-8');
}

/** Repoint the symlink atomically: a relative temp link renamed over the old one. */
function updateSymlinkAtomic(
  installBase: string,
  component: UpgradeComponent,
  version: string,
): void {
  const symlinkPath = path.join(installBase, component);
  const tmpLink = `${symlinkPath}.tmp.${Date.now()}`;
  const target = `${component}-${version}`;

  try {
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, symlinkPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpLink);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

/**
 * Target version of a restart-only npm-source upgrade. The operator already
 * ran `npm install -g`, so the running `kici-admin` is the new version: the
 * target defaults to `running`, and a different `--version` means the install
 * did not update the global binary.
 */
export function resolveNpmSourceVersion(opts: {
  requested: string | undefined;
  running: string;
}): string {
  if (opts.running === 'unknown' || opts.running.trim() === '') {
    throw new Error(
      'npm-source upgrade: could not determine the running package version. ' +
        'Pass --from <archive> / --url <url> + --version for an archive-based upgrade instead.',
    );
  }
  if (opts.requested && opts.requested !== opts.running) {
    throw new Error(
      `npm-source upgrade: requested --version ${opts.requested} does not match the installed ` +
        `package version ${opts.running}. Run \`npm install -g @kici-dev/<pkg>@${opts.requested}\` first, ` +
        `then re-run the upgrade.`,
    );
  }
  return opts.running;
}

export type NpmSourceLaunchVerdict =
  { ok: true; version: string; manifestVersion: string | null } | { ok: false; reason: string };

/**
 * Whether an npm-source upgrade may proceed: the invoking CLI's version must
 * match what the unit will launch (`launched`, null when unresolvable such as
 * an opaque --binary install). A null `manifestVersion` leaves the manifest's
 * kiciVersion unchanged because it was not verified.
 */
export function verifyNpmSourceLaunch(opts: {
  component: UpgradeComponent;
  invoked: string;
  launched: string | null;
  launchedPath: string | null;
  force: boolean;
}): NpmSourceLaunchVerdict {
  const { component, invoked, launched, launchedPath, force } = opts;
  if (launched === null) {
    if (force) return { ok: true, version: invoked, manifestVersion: null };
    return {
      ok: false,
      reason:
        'npm-source upgrade aborted: could not determine the version the installed unit ' +
        'will launch (custom --binary install or unparseable launch target). Pass --force ' +
        'to restart without version verification (the manifest version is left unchanged).',
    };
  }
  if (launched !== invoked) {
    const via = launchedPath ? ` (via ${launchedPath})` : '';
    return {
      ok: false,
      reason:
        `npm-source upgrade aborted: this kici-admin is version ${invoked}, but the ` +
        `installed unit will launch version ${launched}${via}. Your \`npm install -g\` ` +
        `updated a different install than the service is pinned to. Install ${invoked} ` +
        `under the unit's runtime (the node its ExecStart points at), or re-run ` +
        `\`kici-admin ${component} install\` to repoint the unit, then retry.`,
    };
  }
  return { ok: true, version: launched, manifestVersion: launched };
}

export type NpmSourceUpgradeAction =
  | { kind: 'restart-only'; verdict: NpmSourceLaunchVerdict }
  | { kind: 'self-drive'; target: NpmInstallTarget; version: string }
  | { kind: 'error'; reason: string };

/**
 * Decide how an npm-source upgrade proceeds. `restart-only` re-verifies and
 * restarts the installed package; the default self-drives, resolving the
 * global package and pinned node from the unit's launch spec. Operator-facing
 * refusals return an `error` action rather than throwing.
 */
export function planNpmSourceUpgrade(opts: {
  component: UpgradeComponent;
  spec: LaunchSpec | null;
  invoked: string;
  requestedVersion: string | undefined;
  restartOnly: boolean;
  force: boolean;
  windows: boolean;
}): NpmSourceUpgradeAction {
  const { component, spec, invoked, requestedVersion, restartOnly, force, windows } = opts;

  if (restartOnly) {
    const launched = spec ? resolveVersionFromLaunchSpec(spec, component) : null;
    const verdict = verifyNpmSourceLaunch({
      component,
      invoked,
      launched,
      launchedPath: spec?.execPath ?? null,
      force,
    });
    return { kind: 'restart-only', verdict };
  }

  if (!requestedVersion) {
    return {
      kind: 'error',
      reason:
        'self-driving upgrade requires --version <target> (the version to install). ' +
        'Pass --restart-only to restart the already-installed package without installing.',
    };
  }

  const resolution = spec ? resolveNpmInstallTarget(spec, component, { windows }) : null;
  if (resolution && !resolution.ok && resolution.reason === 'not-global') {
    return {
      kind: 'error',
      reason:
        `npm-source upgrade cannot self-install: the unit's launch target ${resolution.entry} ` +
        "is not inside a global npm install, so the unit's npm has no global prefix that holds it. " +
        `The unit runs ${spec!.execPath}; this kici-admin runs ${process.execPath}. ` +
        'Use an archive upgrade (--from <archive> / --url <url> + --version), or pre-install the ' +
        'package and re-run with --restart-only.',
    };
  }
  if (!resolution?.ok) {
    return {
      kind: 'error',
      reason:
        "npm-source upgrade cannot self-install: the unit's launch target is a custom " +
        '--binary install or a non-node_modules path, so there is no global package to update. ' +
        'Use an archive upgrade (--from <archive> / --url <url> + --version), or pre-install the ' +
        'package and re-run with --restart-only.',
    };
  }
  return { kind: 'self-drive', target: resolution.target, version: requestedVersion };
}

/** Process runner for the npm calls; tests inject it. */
export type SpawnRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string };

/**
 * The cmd.exe command line for npm on Windows. npm is a batch file there, which
 * Node.js starts only through a shell, joining the parts with spaces and
 * quoting none of them; the npm path is quoted here because the standard Node.js
 * install is under `C:\Program Files`. An argument with a character outside those of a
 * package name, a version or a flag is refused rather than handed to cmd.exe.
 */
export function windowsShellCommand(cmd: string, args: string[]): string {
  if (cmd.includes('"')) {
    throw new Error(`cannot run "${cmd}" through cmd.exe: the path holds a double quote`);
  }
  for (const arg of args) {
    if (!/^[A-Za-z0-9@/._+-]+$/.test(arg)) {
      throw new Error(`cannot pass "${arg}" to npm: it holds a character cmd.exe reads as syntax`);
    }
  }
  return [`"${cmd}"`, ...args].join(' ');
}

/**
 * Only a Windows batch file (`npm.cmd`) goes through cmd.exe; the pinned
 * `node.exe` running npm-cli.js spawns directly, with no shell to parse its
 * `C:\…` arguments.
 */
const defaultSpawnRunner: SpawnRunner = (cmd, args, opts) => {
  const env = opts?.env ?? process.env;
  const r =
    process.platform === 'win32' && /\.cmd$/i.test(cmd)
      ? spawnSync(windowsShellCommand(cmd, args), { encoding: 'utf-8', shell: true, env })
      : spawnSync(cmd, args, { encoding: 'utf-8', env });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
  };
};

/**
 * The environment npm runs in: the unit's pinned node first on PATH, so a
 * wrapper fallback (`npmPath`, an `env node` shebang) resolves that node. The
 * caller's `npm_config_*` stay, so an operator-set registry or proxy still
 * applies.
 *
 * On the `npm.cmd` fallback the prefix goes through `npm_config_prefix`:
 * {@link windowsShellCommand} refuses the `\`, `:` and `=` a `--prefix=C:\…`
 * argument holds. Every other invocation passes `--prefix` on the command
 * line ({@link npmArgs}), which npm ranks above the environment.
 */
function npmEnv(target: NpmInstallTarget): NodeJS.ProcessEnv {
  const pinnedBinDir = path.dirname(target.nodeExecPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${pinnedBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  if (prefixViaEnv(target)) {
    // npm reads npm_config_* case-insensitively; drop every spelling so the
    // caller's value cannot win over this one.
    for (const key of Object.keys(env)) {
      if (/^npm_config_(global_)?prefix$/i.test(key)) delete env[key];
    }
    env.npm_config_prefix = target.globalPrefix;
  }
  return env;
}

/** Whether the prefix travels in the environment: the `npm.cmd` fallback. */
function prefixViaEnv(target: NpmInstallTarget): boolean {
  return target.npmInvocation.preArgs.length === 0 && /\.cmd$/i.test(target.npmInvocation.cmd);
}

/** The argv for one npm call: npm-cli.js first when the pinned node runs it, `--prefix` last. */
function npmArgs(target: NpmInstallTarget, args: string[]): string[] {
  const prefix = prefixViaEnv(target) ? [] : [`--prefix=${target.globalPrefix}`];
  return [...target.npmInvocation.preArgs, ...args, ...prefix];
}

/**
 * Whether `version` reads KICI_ENV_FILE, asked of the unit's npm registry. Such
 * a release exports the env-file loader from `@kici-dev/shared`, which every
 * KiCI package of that version depends on.
 */
export function npmReleaseReadsEnvFile(
  target: NpmInstallTarget,
  version: string,
  run: SpawnRunner = defaultSpawnRunner,
): { ok: true; reads: boolean } | { ok: false; error: string } {
  const res = run(
    target.npmInvocation.cmd,
    npmArgs(target, ['view', `@kici-dev/shared@${version}`, 'exports', '--json']),
    { env: npmEnv(target) },
  );
  if (res.status !== 0) {
    return { ok: false, error: res.stderr.trim() || `npm view exited with ${res.status}` };
  }
  const out = res.stdout.trim();
  // A release whose @kici-dev/shared declares no exports prints nothing.
  if (!out) return { ok: true, reads: false };
  let exportsMap: unknown;
  try {
    exportsMap = JSON.parse(out);
  } catch {
    return { ok: false, error: `npm view printed no JSON: ${out.slice(0, 200)}` };
  }
  if (Array.isArray(exportsMap)) {
    return {
      ok: false,
      error: `npm matched more than one version of @kici-dev/shared for ${version}; pass an exact --version`,
    };
  }
  const reads =
    typeof exportsMap === 'object' && exportsMap !== null && ENV_FILE_LOADER_EXPORT in exportsMap;
  return { ok: true, reads };
}

/**
 * Install `<owningPackage>@<version>` globally into the prefix the unit's
 * ExecStart resolves from, with the unit's pinned node. Without an explicit
 * prefix npm derives one from the node that runs npm-cli.js, or takes the
 * `npm_config_prefix` the caller's environment carries (`npx` exports its
 * own), so the install would land where the unit never reads it. The pinned
 * node runs npm-cli.js directly, skipping a version-manager wrapper at
 * `<pinned>/bin/npm`, which also keeps the shell's active node out of it.
 */
export function installGlobalPackage(
  target: NpmInstallTarget,
  version: string,
  run: SpawnRunner = defaultSpawnRunner,
): { ok: boolean; stderr: string } {
  const res = run(
    target.npmInvocation.cmd,
    npmArgs(target, ['install', '-g', `${target.owningPackage}@${version}`]),
    { env: npmEnv(target) },
  );
  return { ok: res.status === 0, stderr: res.stderr };
}

/**
 * Take the pre-upgrade dump, quiesce the coordinator, and return the head the
 * CURRENT version runs at for the manifest. All of it runs while the service
 * is up: the dump needs a live database, the drain a live admin API, and the
 * head must come from the version about to be replaced.
 */
async function runPreStopSafety(args: {
  component: UpgradeComponent;
  opts: VersionedUpgradeOptions;
  hooks: UpgradeHooks;
  resolvedInstance: ResolvedInstance;
}): Promise<{ map: Record<string, string> | undefined }> {
  const { component, opts, hooks, resolvedInstance } = args;
  const manifest = resolvedInstance.manifest;

  // An agent has no database and no drain.
  if (component !== 'orchestrator') return { map: manifest.migrationHeads };

  // Recorded so a later rollback to the replaced version can be checked.
  const rows = hooks.migrationStatus ? await readLiveMigrationRows(hooks.migrationStatus) : null;
  const map = rows
    ? mergeMigrationHead(manifest.migrationHeads, manifest.kiciVersion, appliedHead(rows))
    : manifest.migrationHeads;

  // Unconditional, with a loud opt-out. Gating it on a recorded head would
  // skip it on exactly the older installs most at risk, which have none.
  if (opts.skipBackup) {
    console.log('');
    console.log('  !!  --skip-backup: no pre-upgrade dump will be taken.');
    console.log('      If this upgrade goes wrong there is nothing to restore from.');
    console.log('');
  } else if (hooks.backup) {
    const dir = opts.backupDir ?? path.join(resolvedInstance.instanceDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = opts.version ?? 'next';
    const outputPath = path.join(
      dir,
      `pre-upgrade-${manifest.kiciVersion}-${target}-${stamp}.dump`,
    );
    console.log('Taking a pre-upgrade backup...');
    try {
      const res = await hooks.backup({ outputPath, envFilePath: manifest.envFilePath });
      console.log(`Backup written: ${res.outputPath} (${res.byteSize} bytes)`);
    } catch (err) {
      console.error(backupRefusalMessage(toErrorMessage(err)));
      process.exit(1);
    }
  }

  // Drain is on by default.
  if (!opts.noDrain && hooks.drain) {
    const timeoutSeconds = Number.parseInt(opts.drainTimeout ?? '300', 10);
    console.log(`Draining (waiting up to ${timeoutSeconds}s for in-flight jobs)...`);
    try {
      const result = await hooks.drain(timeoutSeconds);
      if (!result.quiesced) {
        console.error(drainTimeoutMessage(result.jobsRunning, timeoutSeconds));
        process.exit(1);
      }
      console.log('Coordinator quiesced.');
    } catch (err) {
      // Unreachable is not "jobs still running": an install whose CLI has no
      // admin URL or token cannot reach the drain route, and refusing would
      // break its documented upgrade. Warn and continue; a drain that timed
      // out still refuses, because that is evidence of in-flight work.
      console.log('');
      console.log(`  !!  The coordinator could not be drained: ${toErrorMessage(err)}`);
      console.log('      Any in-flight jobs will fail when the service restarts.');
      console.log('      Configure the admin API (--url / --token) to drain first.');
      console.log('');
    }
  }

  // The drain flag is in-memory, so the restarted process comes back accepting.
  return { map };
}

/**
 * Run `kici-admin <component> upgrade`: `--pick`, `--rollback` and `--cleanup`
 * act on installed versions, no `--from`/`--url` is an npm-source upgrade, and
 * an archive installs a new versioned directory, then stops the service,
 * switches the symlink (Unix) or registration (Windows), and starts it.
 */
export async function performVersionedUpgrade(
  component: UpgradeComponent,
  opts: VersionedUpgradeOptions,
  hooks: UpgradeHooks = {},
): Promise<void> {
  try {
    const userLevel = !isRoot();
    const kiciRoot = kiciConfigRoot(userLevel);

    const { config, installBase, resolvedInstance, manager, platform } = await resolveUpgradeTarget(
      {
        component,
        opts: { instanceDir: opts.instanceDir, name: opts.name },
        platformOverride: opts.platform,
        isUserLevel: userLevel,
        kiciRoot,
      },
    );

    // Unix system installs (/opt/kici/, /usr/local/kici/) need root.
    if (!isWindows(platform) && !userLevel && !isRoot()) {
      console.error('Error: root privileges required to upgrade system-level services');
      process.exit(1);
    }

    const pickConflict = checkPickFlagConflicts(opts);
    if (pickConflict) {
      console.error(`Error: ${pickConflict}`);
      process.exit(1);
    }

    if (opts.pick) {
      await handlePick(
        component,
        platform,
        installBase,
        config,
        manager,
        resolvedInstance,
        opts,
        hooks,
      );
      return;
    }

    if (opts.rollback) {
      await handleRollback(
        component,
        platform,
        installBase,
        config,
        manager,
        resolvedInstance,
        opts,
        hooks,
      );
      return;
    }

    if (opts.cleanup) {
      await handleCleanup(component, platform, installBase);
      return;
    }

    if (!opts.from && !opts.url) {
      await performNpmSourceUpgrade(component, config, resolvedInstance, manager, opts, platform);
      return;
    }

    if (!opts.version) {
      console.error('Error: --version is required to specify the target version');
      process.exit(1);
    }

    const version = opts.version;
    const versionedDirName = `${component}-${version}`;
    const versionedDirPath = path.join(installBase, versionedDirName);

    // An existing versioned directory is replaced only with --force, and only
    // once the new release is accepted (installRelease).
    if (fs.existsSync(versionedDirPath) && !opts.force) {
      console.error(`Error: version directory already exists: ${versionedDirPath}`);
      console.error('Use --force to overwrite.');
      process.exit(1);
    }

    const installed = await manager.isInstalled(config);
    if (!installed) {
      console.error(`Error: service "${config.name}" is not installed`);
      process.exit(1);
    }

    // Before the archive is fetched or anything changes: a bare-metal
    // binaryPath that is missing or a shim would stop the restarted service.
    await checkBareMetalBinaryPathsBeforeUpgrade({
      component,
      config,
      platform,
      spec: await manager.readLaunchSpec(config),
      expectedVersion: null,
      willInstall: false,
      skip: opts.skipBinaryPathCheck ?? false,
    });

    let archivePath: string;
    const { path: tmpDir, cleanup: cleanupTmpDir } = await makeTempDir('upgrade');

    if (opts.from) {
      archivePath = path.resolve(opts.from);
      if (!fs.existsSync(archivePath)) {
        console.error(`Error: archive not found at ${archivePath}`);
        process.exit(1);
      }
    } else {
      const ext = opts.url!.endsWith('.zip') ? '.zip' : '.tar.gz';
      archivePath = path.join(tmpDir, `${component}-${version}${ext}`);
      await downloadArchive(opts.url!, archivePath);
    }

    const currentVersion = getCurrentVersion(installBase, component, platform);

    if (!opts.yes) {
      console.log(`This will upgrade "${config.name}" to version ${version}:`);
      if (currentVersion) {
        console.log(`  Current version: ${currentVersion}`);
      }
      console.log(`  New version: ${version}`);
      console.log(`  Install path: ${versionedDirPath}`);
      console.log('  The service will be stopped during upgrade.');
      console.log('');
      const ok = await confirm('Proceed with upgrade?');
      if (!ok) {
        console.log('Upgrade cancelled.');
        return;
      }
    }

    console.log('Extracting archive...');
    try {
      installRelease({
        archivePath,
        tmpDir,
        installBase,
        versionedDirPath,
        component,
        platform,
        version,
        config,
      });
    } catch (err) {
      await cleanupTmpDir();
      throw err;
    }

    // Dump and quiesce BEFORE anything stops.
    const preStopHeads = await runPreStopSafety({ component, opts, hooks, resolvedInstance });

    console.log('Stopping service...');
    const status = await manager.status(config);
    if (status.state === 'running') {
      await manager.stop(config);
      console.log('Service stopped.');
    }

    if (isWindows(platform)) {
      const launcherPath = path.join(versionedDirPath, getLauncherName(component, platform));
      await reregisterWindowsService(manager, config, launcherPath);
      writeCurrentVersion(installBase, component, version);
      console.log(`Service registration updated to ${launcherPath}`);
    } else {
      updateSymlinkAtomic(installBase, component, version);
      const symlinkPath = path.join(installBase, component);
      console.log(`Symlink updated: ${symlinkPath} -> ${versionedDirName}`);

      const launcherPath = path.join(symlinkPath, getLauncherName(component, platform));
      if (fs.existsSync(launcherPath)) {
        fs.chmodSync(launcherPath, 0o755);
      }

      // Through the symlink, not the versioned directory.
      config.executablePath = path.join(
        installBase,
        component,
        getLauncherName(component, platform),
      );
    }

    console.log('Starting service...');
    await manager.start(config);
    console.log('Service started.');

    // Later lifecycle commands and the next upgrade read kiciVersion from here;
    // every other manifest field is preserved.
    writeManifest(resolvedInstance.instanceDir, {
      ...resolvedInstance.manifest,
      kiciVersion: version,
      migrationHeads: preStopHeads.map,
    });

    await cleanupTmpDir();

    console.log('');
    if (currentVersion) {
      console.log(`Upgrade complete: ${currentVersion} -> ${version}`);
      console.log(
        `Previous version preserved at: ${path.join(installBase, `${component}-${currentVersion}`)}`,
      );
    } else {
      console.log(`Upgrade to ${version} complete.`);
    }
  } catch (err) {
    console.error(`Error: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * npm-source upgrade (no --from/--url); no versioned dir, no symlink. By
 * default it self-drives: from the unit's launch spec it recovers the pinned
 * node and the global package ExecStart resolves (kici-admin when the
 * component loads through its nested node_modules, else the standalone
 * `@kici-dev/<component>`), installs `<pkg>@<version>` with the co-located
 * npm, restarts, and verifies the launched version. `--restart-only` skips
 * the install.
 */
async function performNpmSourceUpgrade(
  component: UpgradeComponent,
  config: ServiceConfig,
  resolvedInstance: ResolvedInstance,
  manager: ServiceManager,
  opts: VersionedUpgradeOptions,
  platform: ServicePlatform,
): Promise<void> {
  const installed = await manager.isInstalled(config);
  if (!installed) {
    console.error(`Error: service "${config.name}" is not installed`);
    process.exit(1);
  }

  const invoked = readKiciVersion();
  const spec = await manager.readLaunchSpec(config);

  // Restart-only: the invoking CLI must be the requested version.
  if (opts.restartOnly) {
    resolveNpmSourceVersion({ requested: opts.version, running: invoked });
  }

  const action = planNpmSourceUpgrade({
    component,
    spec,
    invoked,
    requestedVersion: opts.version,
    restartOnly: opts.restartOnly ?? false,
    force: opts.force ?? false,
    windows: isWindows(platform),
  });

  if (action.kind === 'error') {
    console.error(`Error: ${action.reason}`);
    process.exit(1);
  }

  if (action.kind === 'restart-only') {
    await restartOnlyUpgrade({
      component,
      config,
      resolvedInstance,
      manager,
      verdict: action.verdict,
      opts,
      platform,
      spec,
    });
    return;
  }

  await performSelfDrivingInstall({
    component,
    config,
    resolvedInstance,
    manager,
    action,
    opts,
    platform,
    spec,
  });
}

export interface RestartOnlyArgs {
  component: UpgradeComponent;
  config: ServiceConfig;
  resolvedInstance: ResolvedInstance;
  manager: ServiceManager;
  verdict: NpmSourceLaunchVerdict;
  opts: VersionedUpgradeOptions;
  platform: ServicePlatform;
  /** The launch command read from the registration before the upgrade. */
  spec: LaunchSpec | null;
}

export interface SelfDriveArgs extends Omit<RestartOnlyArgs, 'verdict'> {
  action: { target: NpmInstallTarget; version: string };
  run?: SpawnRunner;
}

/**
 * Restart-only path: the operator pre-installed the package. Verify the unit
 * launches the invoking CLI's version, restart onto it, persist the version.
 */
export async function restartOnlyUpgrade(args: RestartOnlyArgs): Promise<void> {
  const { config, resolvedInstance, manager, verdict, opts, platform, spec } = args;
  if (!verdict.ok) {
    console.error(`Error: ${verdict.reason}`);
    process.exit(1);
  }

  await checkBareMetalBinaryPathsBeforeUpgrade({
    component: args.component,
    config,
    platform,
    spec,
    expectedVersion: null,
    willInstall: false,
    skip: opts.skipBinaryPathCheck ?? false,
  });

  if (!opts.yes) {
    console.log(
      `This will restart "${config.name}" onto the npm-installed version ${verdict.version}.`,
    );
    console.log('  The service will be stopped briefly during the restart.');
    console.log('');
    const ok = await confirm('Proceed with upgrade?');
    if (!ok) {
      console.log('Upgrade cancelled.');
      return;
    }
  }

  console.log('Restarting service onto the npm-installed package...');
  await restartOntoInstalledPackage({ manager, config, platform, spec });

  if (verdict.manifestVersion !== null) {
    writeManifest(resolvedInstance.instanceDir, {
      ...resolvedInstance.manifest,
      kiciVersion: verdict.manifestVersion,
    });
  } else {
    console.log('Note: manifest version left unchanged (verification was skipped via --force).');
  }

  console.log(
    `Upgrade complete: service "${config.name}" is now running version ${verdict.version}.`,
  );
}

/** Self-driving path: install under the unit's pinned node/npm, restart, verify the version. */
export async function performSelfDrivingInstall(args: SelfDriveArgs): Promise<void> {
  const { component, config, resolvedInstance, manager, action, opts, platform, spec } = args;
  const { target, version } = action;

  // Before anything is installed: a bare-metal binaryPath that is missing or
  // a shim would stop the restarted service.
  await checkBareMetalBinaryPathsBeforeUpgrade({
    component,
    config,
    platform,
    spec,
    expectedVersion: `${target.owningPackage}@${version}`,
    willInstall: true,
    skip: opts.skipBinaryPathCheck ?? false,
  });

  // Before anything is installed: once npm replaces the package, a Windows
  // service would start a pre-KICI_ENV_FILE release at its next restart.
  if (isWindows(platform)) {
    const release = `${target.owningPackage}@${version}`;
    const verdict = npmReleaseReadsEnvFile(target, version, args.run);
    if (!verdict.ok) {
      throw new Error(
        `could not check whether ${release} reads KICI_ENV_FILE: ${verdict.error}. ` +
          'The service and the installed package were not changed.',
      );
    }
    if (!verdict.reads) {
      throw new Error(
        `refusing to install ${release} for "${config.name}": ` +
          `${envFileRefusal(release, config.envFilePath)} ` +
          'The service and the installed package were not changed.',
      );
    }
  }

  if (!opts.yes) {
    console.log(
      `This will install ${target.owningPackage}@${version} with ${target.nodeExecPath} into ` +
        `${target.globalPrefix} (the unit's runtime), then restart "${config.name}".`,
    );
    console.log('');
    const ok = await confirm('Proceed with upgrade?');
    if (!ok) {
      console.log('Upgrade cancelled.');
      return;
    }
  }

  console.log(
    `Installing ${target.owningPackage}@${version} with ${target.nodeExecPath} into ` +
      `${target.globalPrefix} (the unit's runtime)...`,
  );
  const result = installGlobalPackage(target, version, args.run);
  if (!result.ok) {
    const hint = /EACCES|permission denied|EPERM/i.test(result.stderr)
      ? " The unit's global prefix is not writable — re-run with privileges matching the unit's runtime."
      : '';
    console.error(`Error: npm install failed for ${target.owningPackage}@${version}.${hint}`);
    if (result.stderr.trim()) console.error(result.stderr.trim());
    process.exit(1);
  }

  console.log('Restarting service onto the freshly-installed package...');
  await restartOntoInstalledPackage({ manager, config, platform, spec });

  const newSpec = await manager.readLaunchSpec(config);
  const launched = newSpec ? resolveVersionFromLaunchSpec(newSpec, component) : null;
  if (launched !== version) {
    console.error(
      `Error: install + restart completed but the unit launches ` +
        `${launched ?? 'an unresolvable version'}, expected ${version}. The pinned runtime may ` +
        `resolve a different install than the one just updated.`,
    );
    process.exit(1);
  }

  writeManifest(resolvedInstance.instanceDir, {
    ...resolvedInstance.manifest,
    kiciVersion: version,
  });
  console.log(`Upgrade complete: service "${config.name}" is now running version ${version}.`);
}

/** `--pick`: choose an installed version, confirm, then {@link switchToInstalledVersion}. */
async function handlePick(
  component: UpgradeComponent,
  platform: ServicePlatform,
  installBase: string,
  config: ServiceConfig,
  manager: ServiceManager,
  resolvedInstance: ResolvedInstance,
  opts: VersionedUpgradeOptions,
  hooks: UpgradeHooks,
): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      'Error: --pick requires an interactive terminal; pass an explicit archive ' +
        '(--from/--url) or use --rollback for non-interactive switching.',
    );
    process.exit(1);
  }

  const versions = listInstalledVersions(installBase, component);
  const current = getCurrentVersion(installBase, component, platform);
  const targets = selectablePickTargets(versions, current);
  if (targets.length === 0) {
    const only = current ?? versions[0];
    console.error(
      only
        ? `Error: only one version installed (${only}), nothing to pick.`
        : `Error: no installed versions found for ${component}.`,
    );
    process.exit(1);
  }

  const target = await select({
    message: `Select a ${component} version to activate:`,
    choices: buildPickChoices(versions, current),
  });

  if (!opts.yes) {
    console.log(`This will switch "${config.name}":`);
    if (current) console.log(`  Current version: ${current}`);
    console.log(`  Pick target: ${target}`);
    console.log(`  Install path: ${path.join(installBase, `${component}-${target}`)}`);
    console.log('  The service will be stopped during the switch.');
    console.log('');
    const ok = await confirm('Proceed with switch?');
    if (!ok) {
      console.log('Pick cancelled.');
      return;
    }
  }

  await switchToInstalledVersion({
    component,
    platform,
    installBase,
    config,
    manager,
    resolvedInstance,
    targetVersion: target,
    hooks,
    migrateDown: opts.migrateDown === true,
    yes: opts.yes === true,
  });

  console.log('');
  console.log(`Switched: ${current ?? '(unknown)'} -> ${target}`);
}

/**
 * Refuse a switch whose target cannot boot against the current schema: the
 * older release's static migration provider lacks the newer migrations'
 * names, so Kysely throws `corrupted migrations` on boot and systemd restarts
 * it forever, leaving neither version running. Returns true to proceed.
 */
async function assertSchemaAllowsSwitch(args: {
  component: UpgradeComponent;
  targetVersion: string;
  resolvedInstance: ResolvedInstance;
  hooks: UpgradeHooks;
  migrateDown: boolean;
  yes: boolean;
}): Promise<boolean> {
  const { component, targetVersion, resolvedInstance, hooks, migrateDown, yes } = args;

  // An agent has no database.
  if (component !== 'orchestrator') return true;
  if (!hooks.migrationStatus) return true;

  const rows = await readLiveMigrationRows(hooks.migrationStatus);
  // An unreachable service is no evidence about the schema: let the
  // confirmation decide rather than refuse a rollback of a service already down.
  if (rows === null) {
    console.log('');
    console.log(`  !!  ${SCHEMA_NOT_CHECKED}`);
    console.log('');
    return yes ? true : confirm('Proceed with the switch anyway?');
  }

  const recordedHead = resolvedInstance.manifest.migrationHeads?.[targetVersion];
  const verdict = schemaGuardVerdict({ targetVersion, recordedHead, liveRows: rows });

  if (verdict.kind === 'ok') return true;

  if (verdict.kind === 'unknown-head') {
    console.log('');
    console.log(verdict.message);
    console.log('');
    return yes ? true : confirm('Proceed with the switch anyway?');
  }

  // The database is ahead: refuse by default. down() is largely untested and
  // often lossy, and must not fire automatically mid-incident.
  if (!migrateDown) {
    console.error('');
    console.error(verdict.message);
    console.error('');
    process.exit(1);
  }

  if (!recordedHead) {
    console.error(
      'Error: --migrate-down has no recorded head to target for ' + targetVersion + '.',
    );
    process.exit(1);
  }
  if (!hooks.migrateDown) {
    console.error('Error: --migrate-down is not available for this component.');
    process.exit(1);
  }

  console.log(`Reverting the schema to ${recordedHead} before switching...`);
  try {
    // Through the STILL-RUNNING newer service: only its provider carries
    // those migrations' down() functions.
    await hooks.migrateDown(recordedHead);
    console.log(`Schema reverted to ${recordedHead}.`);
  } catch (err) {
    console.error(`Error: the schema could not be reverted: ${toErrorMessage(err)}`);
    console.error('  The version pointer has NOT been moved; the current version is still live.');
    process.exit(1);
  }
  return true;
}

/**
 * Switch to an installed version for `--rollback` and `--pick`: stop, move the
 * pointer (atomic symlink on Unix; re-registration and version file on
 * Windows), start, and persist `kiciVersion` into the manifest.
 */
export async function switchToInstalledVersion(args: {
  component: UpgradeComponent;
  platform: ServicePlatform;
  installBase: string;
  config: ServiceConfig;
  manager: ServiceManager;
  resolvedInstance: ResolvedInstance;
  targetVersion: string;
  /** Omitted by the agent upgrade. */
  hooks?: UpgradeHooks;
  migrateDown?: boolean;
  /** Skip the confirmation the unknown-head warning falls through to. */
  yes?: boolean;
}): Promise<void> {
  const { component, platform, installBase, config, manager, resolvedInstance, targetVersion } =
    args;
  const launcherPath = path.join(
    installBase,
    `${component}-${targetVersion}`,
    getLauncherName(component, platform),
  );

  // First, before the schema check can revert anything: `--rollback` and
  // `--pick` may select a release an older CLI installed.
  if (isWindows(platform)) {
    assertWindowsLaunchReadsEnvFile({
      launch: { executablePath: launcherPath },
      release: `version ${targetVersion}`,
      action: `switch "${config.name}" to ${targetVersion}`,
      config,
    });
  }

  // A recovery switch is never refused for a binaryPath: it only warns, so the
  // operator learns before the restart that the service may not start.
  await warnAboutBareMetalBinaryPaths(args);

  // Here rather than in handleRollback so `--pick`, which can select ANY
  // installed version, inherits it.
  const proceed = await assertSchemaAllowsSwitch({
    component,
    targetVersion,
    resolvedInstance,
    hooks: args.hooks ?? {},
    migrateDown: args.migrateDown === true,
    yes: args.yes === true,
  });
  if (!proceed) {
    console.log('Switch cancelled.');
    return;
  }

  console.log('Stopping service...');
  const status = await manager.status(config);
  if (status.state === 'running') {
    await manager.stop(config);
    console.log('Service stopped.');
  }

  if (isWindows(platform)) {
    await reregisterWindowsService(manager, config, launcherPath);
    writeCurrentVersion(installBase, component, targetVersion);
    console.log(`Service registration updated to ${launcherPath}`);
  } else {
    updateSymlinkAtomic(installBase, component, targetVersion);
    console.log(
      `Symlink updated: ${path.join(installBase, component)} -> ${component}-${targetVersion}`,
    );
  }

  console.log('Starting service...');
  await manager.start(config);
  console.log('Service started.');

  writeManifest(resolvedInstance.instanceDir, {
    ...resolvedInstance.manifest,
    kiciVersion: targetVersion,
  });
}

/**
 * Print the bare-metal `binaryPath` diagnosis before `--rollback` or `--pick`
 * restarts the service. Never refuses and never throws: both are recovery
 * paths, and a check that cannot run must not block a recovery.
 */
async function warnAboutBareMetalBinaryPaths(args: {
  component: UpgradeComponent;
  platform: ServicePlatform;
  config: ServiceConfig;
  manager: ServiceManager;
}): Promise<void> {
  try {
    await checkBareMetalBinaryPathsBeforeUpgrade({
      component: args.component,
      config: args.config,
      platform: args.platform,
      spec: await args.manager.readLaunchSpec(args.config).catch(() => null),
      expectedVersion: null,
      willInstall: false,
      skip: true,
    });
  } catch (err) {
    console.warn(`Warning: the bare-metal binaryPath check did not run (${toErrorMessage(err)}).`);
  }
}

/** `--rollback`: switch to the previous installed version. */
async function handleRollback(
  component: UpgradeComponent,
  platform: ServicePlatform,
  installBase: string,
  config: ServiceConfig,
  manager: ServiceManager,
  resolvedInstance: ResolvedInstance,
  opts: VersionedUpgradeOptions,
  hooks: UpgradeHooks,
): Promise<void> {
  const versions = listInstalledVersions(installBase, component);
  if (versions.length < 2) {
    console.error('Error: no previous version available for rollback');
    if (versions.length === 1) {
      console.error(`Only version installed: ${versions[0]}`);
    }
    process.exit(1);
  }

  const currentVersion = getCurrentVersion(installBase, component, platform);
  if (!currentVersion) {
    console.error('Error: cannot determine current version (no symlink found)');
    console.log('Available versions:');
    for (const v of versions) {
      console.log(`  ${component}-${v}/`);
    }
    process.exit(1);
  }

  // The one before current in sorted order; when current is the oldest, the next one.
  const currentIdx = versions.indexOf(currentVersion);
  let previousVersion: string;
  if (currentIdx > 0) {
    previousVersion = versions[currentIdx - 1]!;
  } else if (versions.length >= 2) {
    previousVersion = versions[1]!;
  } else {
    console.error('Error: no alternative version available for rollback');
    process.exit(1);
    return; // unreachable, for TS
  }

  if (!opts.yes) {
    console.log(`Rolling back "${config.name}":`);
    console.log(`  Current version: ${currentVersion}`);
    console.log(`  Rollback to: ${previousVersion}`);
    console.log('');
    const ok = await confirm('Proceed with rollback?');
    if (!ok) {
      console.log('Rollback cancelled.');
      return;
    }
  }

  await switchToInstalledVersion({
    component,
    platform,
    installBase,
    config,
    manager,
    resolvedInstance,
    targetVersion: previousVersion,
    hooks,
    migrateDown: opts.migrateDown === true,
    yes: opts.yes === true,
  });

  console.log('');
  console.log(`Rollback complete: ${currentVersion} -> ${previousVersion}`);
}

/** `--cleanup`: remove every versioned directory except the current and previous. */
async function handleCleanup(
  component: UpgradeComponent,
  platform: ServicePlatform,
  installBase: string,
): Promise<void> {
  const versions = listInstalledVersions(installBase, component);
  if (versions.length <= 2) {
    console.log('Nothing to clean up (2 or fewer versions installed).');
    return;
  }

  const currentVersion = getCurrentVersion(installBase, component, platform);
  const currentIdx = currentVersion ? versions.indexOf(currentVersion) : versions.length - 1;
  const previousIdx = currentIdx > 0 ? currentIdx - 1 : -1;

  const toRemove = versions.filter((_, i) => i !== currentIdx && i !== previousIdx);

  if (toRemove.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  console.log('The following versions will be removed:');
  for (const v of toRemove) {
    console.log(`  ${component}-${v}/`);
  }
  if (currentVersion) {
    console.log(`\nKeeping: ${component}-${currentVersion}/ (current)`);
  }
  if (previousIdx >= 0) {
    console.log(`Keeping: ${component}-${versions[previousIdx]!}/ (previous)`);
  }

  for (const v of toRemove) {
    const dirPath = path.join(installBase, `${component}-${v}`);
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`Removed ${dirPath}`);
  }

  console.log(`\nCleanup complete. Removed ${toRemove.length} old version(s).`);
}
