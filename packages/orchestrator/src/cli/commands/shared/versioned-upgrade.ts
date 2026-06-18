/**
 * Shared versioned directory upgrade logic for kici-admin upgrade commands.
 *
 * Implements the versioned directory layout:
 * - Extract new version alongside old versions
 * - Update symlink (Unix) or service registration (Windows) atomically
 * - Preserve old versions for rollback
 * - Optional cleanup of old versions
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  createServiceManager,
  detectPlatform,
  isRoot,
  kiciConfigRoot,
  readKiciVersion,
  resolveInstance,
  resolveVersionFromLaunchSpec,
  writeManifest,
  type ResolvedInstance,
  type ServiceManager,
  type ServicePlatform,
} from '../../service/index.js';
import type { ServiceConfig } from '../../service/types.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Component types that can be upgraded. */
type UpgradeComponent = 'orchestrator' | 'agent';

/** Options for the versioned upgrade command. */
interface VersionedUpgradeOptions {
  platform?: ServicePlatform;
  /**
   * Service name. No default — targeting flows through {@link resolveInstance}
   * which consumes `name`, `instanceDir`, or the CWD manifest in priority order.
   */
  name?: string;
  /** Deploy folder of the instance to upgrade. */
  instanceDir?: string;
  from?: string;
  url?: string;
  version?: string;
  yes?: boolean;
  cleanup?: boolean;
  rollback?: boolean;
  force?: boolean;
}

/**
 * Resolved upgrade target: the manifest-backed ServiceConfig the upgrade
 * flow operates on, the manifest's installBase (NOT re-derived from name),
 * and the underlying resolved instance for downstream writes.
 */
export interface UpgradeTarget {
  config: ServiceConfig;
  installBase: string;
  resolvedInstance: ResolvedInstance;
}

/**
 * Resolve the upgrade target via the folder-anchored model and build the
 * ServiceConfig + installBase the rest of the upgrade flow needs.
 *
 * Priority chain (delegated to {@link resolveInstance}):
 *   1. `opts.instanceDir` — read manifest at that path.
 *   2. `opts.name`        — match against listInstances() output.
 *   3. CWD manifest       — read `./.kici-<component>.json`.
 *   4. otherwise          — refuse with a candidate-list error.
 *
 * The returned `installBase` comes from the manifest, NEVER re-derived from
 * the service name. Instances installed with a non-default base must
 * continue to resolve to that base on upgrade.
 */
export async function resolveUpgradeTarget(args: {
  component: UpgradeComponent;
  opts: { instanceDir?: string; name?: string };
  manager: ServiceManager;
  isUserLevel: boolean;
  kiciRoot: string;
}): Promise<UpgradeTarget> {
  const { component, opts, manager, isUserLevel, kiciRoot } = args;
  const resolved = await resolveInstance({
    component,
    opts: { instanceDir: opts.instanceDir, name: opts.name },
    cwd: process.cwd(),
    kiciRoot,
    manager,
    isUserLevel,
  });
  const config: ServiceConfig = {
    name: resolved.manifest.name,
    displayName: `KiCI ${component}`,
    description: `KiCI ${component} service`,
    executablePath: '',
    envFilePath: resolved.manifest.envFilePath,
    workingDirectory: resolved.manifest.configDir,
    isUserLevel: resolved.manifest.isUserLevel,
    restartPolicy: {
      enabled: true,
      delays: [1, 5, 15, 30],
      maxRetries: 5,
      windowSeconds: 300,
    },
    component,
    // Re-embed the deploy-folder marker so an upgraded unit keeps recovery
    // working even if the instance index is later lost.
    instanceDir: resolved.instanceDir,
  };
  return { config, installBase: resolved.manifest.installBase, resolvedInstance: resolved };
}

/** Prompt the user for confirmation (returns true if yes). */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/** Download a file from a URL to a local path. */
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
 * Install base for a KiCI component instance.
 *
 * Name-scoped so that two instances of the same component (e.g. an org's
 * dogfood orchestrator and an E2E test orchestrator) own independent
 * versioned trees and symlinks. Per-platform bases:
 *   - systemd / compose: /opt/kici/<name>/
 *   - launchd:           /usr/local/kici/<name>/
 *   - windows:           C:\Program Files\KiCI\<name>\
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

/** Check if the platform is Windows. */
function isWindows(platform: ServicePlatform): boolean {
  return platform === 'windows';
}

/** Get the launcher script name for a component. */
function getLauncherName(component: UpgradeComponent, platform: ServicePlatform): string {
  const baseName = component === 'orchestrator' ? 'kici-orchestrator-standalone' : 'kici-agent';
  return isWindows(platform) ? `${baseName}.cmd` : baseName;
}

/**
 * Extract an archive (.tar.gz or .zip) to a destination directory.
 * Returns the name of the top-level directory inside the archive.
 */
function extractArchive(archivePath: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    // Windows-style zip extraction
    if (os.platform() === 'win32') {
      execSync(
        `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: 'inherit' },
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else {
    // tar.gz extraction
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  }

  // Find the top-level directory in the extracted content
  const entries = fs.readdirSync(destDir);
  const dirs = entries.filter((e) => fs.statSync(path.join(destDir, e)).isDirectory());
  if (dirs.length === 0) {
    throw new Error('Archive does not contain a directory');
  }
  return dirs[0]!;
}

/**
 * List installed versions for a component by scanning the install base directory
 * for directories matching `{component}-{version}/`.
 */
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
 * Read the current symlink target to determine the active version.
 * Returns null if no symlink exists or on Windows.
 */
function getCurrentVersion(
  installBase: string,
  component: UpgradeComponent,
  platform: ServicePlatform,
): string | null {
  if (isWindows(platform)) {
    // On Windows, there's no symlink — track current version in a text file
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
    // Handle absolute paths
    const basename = path.basename(target);
    if (basename.startsWith(prefix)) {
      return basename.slice(prefix.length);
    }
  } catch {
    // Symlink doesn't exist or isn't a symlink
  }
  return null;
}

/** Write the current version to a tracking file (used on Windows). */
function writeCurrentVersion(
  installBase: string,
  component: UpgradeComponent,
  version: string,
): void {
  const versionFile = path.join(installBase, `${component}-current-version.txt`);
  fs.writeFileSync(versionFile, version, 'utf-8');
}

/**
 * Update the symlink atomically on Unix.
 * Creates a temporary symlink then renames it over the existing one.
 */
function updateSymlinkAtomic(
  installBase: string,
  component: UpgradeComponent,
  version: string,
): void {
  const symlinkPath = path.join(installBase, component);
  const tmpLink = `${symlinkPath}.tmp.${Date.now()}`;
  const target = `${component}-${version}`;

  try {
    // Create temp symlink pointing at the new versioned directory (relative path)
    fs.symlinkSync(target, tmpLink);
    // Atomic rename over existing symlink
    fs.renameSync(tmpLink, symlinkPath);
  } catch (err) {
    // Clean up temp link if rename failed
    try {
      fs.unlinkSync(tmpLink);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Perform a versioned directory upgrade for a KiCI component.
 *
 * Flow:
 * 1. Parse upgrade source (--from archive or --url)
 * 2. Determine install base by platform
 * 3. Extract new versioned directory
 * 4. Stop service
 * 5. Update symlink (Unix) or service registration (Windows)
 * 6. Start service
 */
/**
 * Resolve the target version for an npm-source upgrade (no --from/--url).
 *
 * The npm-source flow assumes the operator already ran
 * `npm install -g @kici-dev/<pkg>@<version>`, which overwrites the global
 * package in place. The running `kici-admin` binary is therefore the new
 * version, and `running` is its self-reported version. We default the target
 * to it, or validate an explicitly-passed --version matches — a mismatch means
 * the npm install did not actually update the global binary.
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

/** Verdict from {@link verifyNpmSourceLaunch}. */
export type NpmSourceLaunchVerdict =
  | { ok: true; version: string; manifestVersion: string | null }
  | { ok: false; reason: string };

/**
 * Decide whether an npm-source upgrade may proceed, given the version the
 * invoking CLI is (`invoked`) and the version the installed unit will actually
 * launch (`launched`, or null when unresolvable — e.g. an opaque --binary
 * install). On success `manifestVersion` is the value to persist (null = leave
 * the manifest's kiciVersion unchanged because we couldn't verify it).
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

export async function performVersionedUpgrade(
  component: UpgradeComponent,
  opts: VersionedUpgradeOptions,
): Promise<void> {
  try {
    const platform = detectPlatform(opts.platform);
    const manager = await createServiceManager(platform);
    const userLevel = !isRoot();
    const kiciRoot = kiciConfigRoot(userLevel);

    const { config, installBase, resolvedInstance } = await resolveUpgradeTarget({
      component,
      opts: { instanceDir: opts.instanceDir, name: opts.name },
      manager,
      isUserLevel: userLevel,
      kiciRoot,
    });

    // Check root on Unix (required for /opt/kici/ and /usr/local/kici/)
    if (!isWindows(platform) && !userLevel && !isRoot()) {
      console.error('Error: root privileges required to upgrade system-level services');
      process.exit(1);
    }

    // Handle --rollback
    if (opts.rollback) {
      await handleRollback(component, platform, installBase, config, manager, opts);
      return;
    }

    // Handle --cleanup
    if (opts.cleanup) {
      await handleCleanup(component, platform, installBase);
      return;
    }

    // No archive source: npm-source (restart-only) upgrade.
    if (!opts.from && !opts.url) {
      await performNpmSourceUpgrade(component, config, resolvedInstance, manager, opts);
      return;
    }

    // Archive-based upgrade requires an explicit target version.
    if (!opts.version) {
      console.error('Error: --version is required to specify the target version');
      process.exit(1);
    }

    const version = opts.version;
    const versionedDirName = `${component}-${version}`;
    const versionedDirPath = path.join(installBase, versionedDirName);

    // Check if versioned directory already exists
    if (fs.existsSync(versionedDirPath)) {
      if (opts.force) {
        console.log(`Removing existing directory ${versionedDirPath} (--force)`);
        fs.rmSync(versionedDirPath, { recursive: true, force: true });
      } else {
        console.error(`Error: version directory already exists: ${versionedDirPath}`);
        console.error('Use --force to overwrite.');
        process.exit(1);
      }
    }

    // Check service is installed
    const installed = await manager.isInstalled(config);
    if (!installed) {
      console.error(`Error: service "${config.name}" is not installed`);
      process.exit(1);
    }

    // Resolve archive path
    let archivePath: string;
    const tmpDir = path.join(os.tmpdir(), `kici-upgrade-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    if (opts.from) {
      archivePath = path.resolve(opts.from);
      if (!fs.existsSync(archivePath)) {
        console.error(`Error: archive not found at ${archivePath}`);
        process.exit(1);
      }
    } else {
      // Download from URL
      const ext = opts.url!.endsWith('.zip') ? '.zip' : '.tar.gz';
      archivePath = path.join(tmpDir, `${component}-${version}${ext}`);
      await downloadArchive(opts.url!, archivePath);
    }

    // Get current version info
    const currentVersion = getCurrentVersion(installBase, component, platform);

    // Confirmation
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

    // Extract archive to temp directory
    console.log('Extracting archive...');
    const extractDir = path.join(tmpDir, 'extract');
    const extractedDirName = extractArchive(archivePath, extractDir);

    // Move extracted directory to versioned location.
    // Use platform-appropriate copy to handle cross-device moves
    // (e.g., /tmp on tmpfs → /opt/kici on disk).
    fs.mkdirSync(installBase, { recursive: true });
    const srcDir = path.join(extractDir, extractedDirName);
    if (isWindows(platform)) {
      execSync(`xcopy "${srcDir}" "${versionedDirPath}" /E /I /Q /Y`, { stdio: 'inherit' });
    } else {
      execSync(`cp -r "${srcDir}" "${versionedDirPath}"`, { stdio: 'inherit' });
    }
    console.log(`Extracted to ${versionedDirPath}`);

    // Stop service
    console.log('Stopping service...');
    const status = await manager.status(config);
    if (status.state === 'running') {
      await manager.stop(config);
      console.log('Service stopped.');
    }

    // Update version pointer
    if (isWindows(platform)) {
      // Windows: uninstall and re-install with the new executable path.
      // sc.exe has no "update binary path" — must delete+create the service.
      const launcherPath = path.join(versionedDirPath, getLauncherName(component, platform));
      config.executablePath = launcherPath;
      await manager.uninstall(config);
      // Brief pause after deletion to let Windows fully release the service kernel object.
      await new Promise((r) => setTimeout(r, 2_000));
      await manager.install(config);
      // Track current version in a file (Windows has no symlinks)
      writeCurrentVersion(installBase, component, version);
      console.log(`Service registration updated to ${launcherPath}`);
    } else {
      // Unix: atomic symlink update
      updateSymlinkAtomic(installBase, component, version);
      const symlinkPath = path.join(installBase, component);
      console.log(`Symlink updated: ${symlinkPath} -> ${versionedDirName}`);

      // Ensure the launcher script in the symlinked directory is executable
      const launcherPath = path.join(symlinkPath, getLauncherName(component, platform));
      if (fs.existsSync(launcherPath)) {
        fs.chmodSync(launcherPath, 0o755);
      }

      // executablePath points through the symlink
      config.executablePath = path.join(
        installBase,
        component,
        getLauncherName(component, platform),
      );
    }

    // Start service
    console.log('Starting service...');
    await manager.start(config);
    console.log('Service started.');

    // Persist the new version into the manifest so subsequent lifecycle
    // commands and the next upgrade see the current kiciVersion. Writes the
    // entire manifest in place — every other field is preserved.
    writeManifest(resolvedInstance.instanceDir, {
      ...resolvedInstance.manifest,
      kiciVersion: version,
    });

    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });

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
 * npm-source upgrade (no --from/--url): the operator has already run
 * `npm install -g @kici-dev/<pkg>@<version>`, replacing the global package
 * in place. The systemd/launchd/Windows unit's ExecStart points at that global
 * package (see install.ts → import.meta.resolve), so a stop+start re-executes
 * the freshly-installed code. No archive, no versioned dir, no symlink.
 */
async function performNpmSourceUpgrade(
  component: UpgradeComponent,
  config: ServiceConfig,
  resolvedInstance: ResolvedInstance,
  manager: ServiceManager,
  opts: VersionedUpgradeOptions,
): Promise<void> {
  const invoked = readKiciVersion();
  // Validate an explicit --version against the invoking CLI (unchanged check).
  resolveNpmSourceVersion({ requested: opts.version, running: invoked });

  const installed = await manager.isInstalled(config);
  if (!installed) {
    console.error(`Error: service "${config.name}" is not installed`);
    process.exit(1);
  }

  // Ground truth: the version the installed unit will actually launch, read
  // back from the init system (not from this CLI, which may be a different
  // install than the unit is pinned to).
  const spec = await manager.readLaunchSpec(config);
  const launched = spec ? resolveVersionFromLaunchSpec(spec, component) : null;
  const verdict = verifyNpmSourceLaunch({
    component,
    invoked,
    launched,
    launchedPath: spec?.execPath ?? null,
    force: opts.force ?? false,
  });
  if (!verdict.ok) {
    console.error(`Error: ${verdict.reason}`);
    process.exit(1);
  }

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
  const status = await manager.status(config);
  if (status.state === 'running') {
    await manager.stop(config);
  }
  await manager.start(config);

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

/**
 * Handle --rollback: switch symlink to the previous version and restart.
 */
async function handleRollback(
  component: UpgradeComponent,
  platform: ServicePlatform,
  installBase: string,
  config: ServiceConfig,
  manager: Awaited<ReturnType<typeof createServiceManager>>,
  opts: VersionedUpgradeOptions,
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

  // Find the previous version (the one before current in sorted order)
  const currentIdx = versions.indexOf(currentVersion);
  let previousVersion: string;
  if (currentIdx > 0) {
    previousVersion = versions[currentIdx - 1]!;
  } else if (versions.length >= 2) {
    // Current is the oldest, pick the next one
    previousVersion = versions[1]!;
  } else {
    console.error('Error: no alternative version available for rollback');
    process.exit(1);
    return; // unreachable, for TS
  }

  // Confirmation
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

  // Stop service
  console.log('Stopping service...');
  const status = await manager.status(config);
  if (status.state === 'running') {
    await manager.stop(config);
    console.log('Service stopped.');
  }

  if (isWindows(platform)) {
    const launcherPath = path.join(
      installBase,
      `${component}-${previousVersion}`,
      getLauncherName(component, platform),
    );
    config.executablePath = launcherPath;
    await manager.uninstall(config);
    await manager.install(config);
    writeCurrentVersion(installBase, component, previousVersion);
    console.log(`Service registration updated to ${launcherPath}`);
  } else {
    updateSymlinkAtomic(installBase, component, previousVersion);
    console.log(
      `Symlink updated: ${path.join(installBase, component)} -> ${component}-${previousVersion}`,
    );
  }

  // Start service
  console.log('Starting service...');
  await manager.start(config);
  console.log('Service started.');

  console.log('');
  console.log(`Rollback complete: ${currentVersion} -> ${previousVersion}`);
}

/**
 * Handle --cleanup: remove all versioned directories except the current
 * and previous versions.
 */
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
