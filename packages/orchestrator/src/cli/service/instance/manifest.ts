/**
 * Instance manifest: the single source of truth for a folder-anchored install.
 * `install` writes it into the deploy folder; every lifecycle command rebuilds
 * the ServiceConfig from it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Component, InstanceManifest } from './types.js';
import type { LaunchSpec } from '../types.js';
import { installerImageName, pinnedImageVersion } from '../image-digests.js';

const REQUIRED_FIELDS: readonly (keyof InstanceManifest)[] = [
  'component',
  'name',
  'platform',
  'isUserLevel',
  'envFilePath',
  'configDir',
  'logDir',
  'installBase',
  'createdAt',
  'kiciVersion',
];

export function manifestFilename(component: Component): string {
  return `.kici-${component}.json`;
}

export function manifestPath(instanceDir: string, component: Component): string {
  return path.join(instanceDir, manifestFilename(component));
}

/** Null when the file does not exist; throws on parse or schema errors. */
export function readManifest(instanceDir: string, component: Component): InstanceManifest | null {
  const file = manifestPath(instanceDir, component);
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed instance manifest at ${file}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid instance manifest at ${file}: not an object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in (parsed as Record<string, unknown>))) {
      throw new Error(`Invalid instance manifest at ${file}: missing field "${field}"`);
    }
  }
  return parsed as InstanceManifest;
}

/** Returns the path written. */
export function writeManifest(instanceDir: string, manifest: InstanceManifest): string {
  fs.mkdirSync(instanceDir, { recursive: true });
  const file = manifestPath(instanceDir, manifest.component);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return file;
}

/**
 * The running kici-admin's version, from the orchestrator package.json on
 * disk: `npm_package_version` is set only under `npm run`, never for the
 * globally installed binary.
 */
export function readKiciVersion(): string {
  try {
    // From src/ or dist/cli/service/instance/, four levels up is the package root.
    const pkgUrl = new URL('../../../../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(pkgUrl), 'utf-8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The `@kici-dev/<component>` version a {@link LaunchSpec} executes, read from
 * the package.json owning its entry script. Null when there is no entry script
 * (an opaque `--binary` install) or the package.json is missing or
 * name-mismatched, so the npm-source upgrade never reports an unverified version.
 */
export function resolveVersionFromLaunchSpec(
  spec: LaunchSpec,
  component: Component,
): string | null {
  const pkgName = `@kici-dev/${component}`;
  const entryRe = new RegExp(
    `[/\\\\]@kici-dev[/\\\\]${component}[/\\\\]dist[/\\\\](?:server|standalone)\\.js$`,
  );
  const entry = [spec.execPath, ...spec.args].find((a) => entryRe.test(a));
  if (!entry) return null;

  // dist/ has no package.json, so the nearest one up is the package root.
  let dir = path.dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === pkgName && typeof pkg.version === 'string') return pkg.version;
        return null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The version of the launcher a service definition starts, or null. An npm
 * entry script names it in its package.json ({@link resolveVersionFromLaunchSpec});
 * a launcher under the install base resolves into its `<component>-<version>`
 * folder (through the symlink on Linux and macOS, directly on Windows). A
 * `--binary` anywhere else shows none.
 */
export function resolveLauncherVersion(
  spec: LaunchSpec,
  component: Component,
  installBase: string,
): string | null {
  const fromPackage = resolveVersionFromLaunchSpec(spec, component);
  if (fromPackage) return fromPackage;

  let base: string;
  try {
    base = fs.realpathSync(installBase);
  } catch {
    return null;
  }
  const prefix = `${component}-`;
  for (const token of [spec.execPath, ...spec.args]) {
    if (!path.isAbsolute(token)) continue;
    let real: string;
    try {
      real = fs.realpathSync(token);
    } catch {
      continue;
    }
    // Outside the base the first segment is `..` (or another drive on
    // Windows), which never names a version folder.
    const [folder = '', ...rest] = path.relative(base, real).split(path.sep);
    if (rest.length > 0 && folder.startsWith(prefix) && folder.length > prefix.length) {
      return folder.slice(prefix.length);
    }
  }
  return null;
}

export interface InstallManifestWrite {
  file: string;
  manifest: InstanceManifest;
  /** Set when the folder held a manifest the install replaced instead of updating. */
  warning?: string;
}

/**
 * Write the manifest `install` built. A first install writes `fresh`. A
 * re-install of the same instance (readable manifest, same component and name)
 * keeps `createdAt`, the `migrationHeads` the rollback schema guard reads, and
 * any field a newer CLI wrote, and takes the rest from `fresh`. `kiciVersion`
 * is the version of the launcher `launch` starts, else the recorded one stands,
 * because the CLI running `install` need not be the version the service runs.
 * A compose re-install records the release of the image its compose file pins,
 * whatever `launch` names (`opts.digestRecordPath` overrides the record, for
 * tests). An unreadable manifest, or one naming another instance, is replaced
 * with a warning.
 */
export function writeInstallManifest(
  instanceDir: string,
  fresh: InstanceManifest,
  launch: LaunchSpec,
  opts: { digestRecordPath?: string } = {},
): InstallManifestWrite {
  let existing: InstanceManifest | null;
  try {
    existing = readManifest(instanceDir, fresh.component);
  } catch (err) {
    return {
      file: writeManifest(instanceDir, fresh),
      manifest: fresh,
      warning:
        `${(err as Error).message}. install replaced it, so the migration heads it ` +
        `recorded, if any, are lost.`,
    };
  }
  if (!existing) return { file: writeManifest(instanceDir, fresh), manifest: fresh };
  if (existing.name !== fresh.name) {
    return {
      file: writeManifest(instanceDir, fresh),
      manifest: fresh,
      warning:
        `${manifestPath(instanceDir, fresh.component)} described the instance ` +
        `"${existing.name}". It now describes "${fresh.name}".`,
    };
  }
  const launcherVersion =
    fresh.platform === 'compose'
      ? pinnedImageVersion(installerImageName(fresh.component), { filePath: opts.digestRecordPath })
      : resolveLauncherVersion(launch, fresh.component, fresh.installBase);
  const manifest: InstanceManifest = {
    ...existing,
    ...fresh,
    createdAt: existing.createdAt,
    kiciVersion: launcherVersion ?? existing.kiciVersion,
  };
  if (existing.migrationHeads) manifest.migrationHeads = existing.migrationHeads;
  return { file: writeManifest(instanceDir, manifest), manifest };
}

/**
 * Where an npm-source upgrade installs, from a unit's launch spec.
 * `owningPackage` is the top-level global package ExecStart runs (`kici-admin`
 * when the component loads through its nested node_modules, else
 * `@kici-dev/<component>`). `npmPath` sits beside the pinned node, so
 * `npm install -g` lands in the prefix ExecStart resolves from, whatever the
 * shell's active node.
 */
export interface NpmInstallTarget {
  nodeExecPath: string;
  npmPath: string;
  owningPackage: string;
}

export function resolveNpmInstallTarget(
  spec: LaunchSpec,
  component: Component,
  opts: { windows: boolean },
): NpmInstallTarget | null {
  const entryRe = new RegExp(
    `[/\\\\]@kici-dev[/\\\\]${component}[/\\\\]dist[/\\\\](?:server|standalone)\\.js$`,
  );
  const entry = [spec.execPath, ...spec.args].find((a) => entryRe.test(a));
  if (!entry) return null;

  const owningPackage = firstGlobalPackage(entry);
  if (!owningPackage) return null;

  // The unit's path flavor, not the host's: a posix host must still produce
  // `C:\node\npm.cmd` for a Windows unit, and vice versa.
  const p = opts.windows ? path.win32 : path.posix;
  const npmBin = opts.windows ? 'npm.cmd' : 'npm';
  const npmPath = p.join(p.dirname(spec.execPath), npmBin);
  return { nodeExecPath: spec.execPath, npmPath, owningPackage };
}

/**
 * The package under the FIRST `node_modules` segment (the global root), which
 * `npm install -g` must target; `@scope/name` keeps both segments. Null
 * without a `node_modules` segment.
 */
function firstGlobalPackage(entry: string): string | null {
  const segments = entry.split(/[/\\]/);
  const idx = segments.indexOf('node_modules');
  if (idx === -1 || idx + 1 >= segments.length) return null;
  const first = segments[idx + 1]!;
  if (first.startsWith('@')) {
    if (idx + 2 >= segments.length) return null;
    return `${first}/${segments[idx + 2]}`;
  }
  return first;
}
