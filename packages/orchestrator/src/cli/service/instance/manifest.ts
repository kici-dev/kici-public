/**
 * Instance manifest — the single source of truth for a folder-anchored
 * service install. Written by `install` into the deploy folder, read by
 * every lifecycle command to reconstruct the ServiceConfig.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Component, InstanceManifest } from './types.js';
import type { LaunchSpec } from '../types.js';

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

/** Per-component manifest filename. */
export function manifestFilename(component: Component): string {
  return `.kici-${component}.json`;
}

/** Resolve the manifest path inside an instance directory. */
export function manifestPath(instanceDir: string, component: Component): string {
  return path.join(instanceDir, manifestFilename(component));
}

/**
 * Read the manifest for `component` from `instanceDir`.
 * Returns null when the file does not exist; throws on parse or schema errors.
 */
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

/**
 * Write the manifest for `manifest.component` into `instanceDir`.
 * Returns the full path written.
 */
export function writeManifest(instanceDir: string, manifest: InstanceManifest): string {
  fs.mkdirSync(instanceDir, { recursive: true });
  const file = manifestPath(instanceDir, manifest.component);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return file;
}

/**
 * Read the running kici-admin's version from the orchestrator package.json.
 *
 * `process.env.npm_package_version` is only populated under `npm run` and is
 * undefined when kici-admin runs as a globally-installed binary, which is the
 * actual install path. Reading from the package.json on disk is the only
 * reliable source.
 */
export function readKiciVersion(): string {
  try {
    // src/cli/service/instance/manifest.ts (or dist/cli/service/instance/manifest.js)
    // → up 4 levels reaches packages/orchestrator/{package.json}.
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
 * Resolve the `@kici-dev/<component>` package version that a {@link LaunchSpec}
 * will actually execute, by locating the component's entry script among the
 * spec's tokens and reading the version from the package.json that owns it.
 *
 * Returns null when no resolvable entry script is present (e.g. an opaque
 * `--binary` install) or the owning package.json is missing / name-mismatched.
 * This is what lets the npm-source upgrade refuse to report a version it can't
 * stand behind.
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

  // Walk up from the entry script to the nearest package.json (dist/ has none,
  // so the first hit is the package root).
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
 * The global npm package + node runtime an npm-source upgrade must install
 * into, derived from a unit's launch spec. `owningPackage` is the top-level
 * global package whose ExecStart the unit runs — `kici-admin` when the
 * component is loaded through its nested node_modules, or `@kici-dev/<component>`
 * for a standalone install. `npmPath` is the npm co-located with the unit's
 * pinned node, so `npm install -g` with it lands in exactly the prefix
 * ExecStart resolves from, regardless of the shell's active node.
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

  // Resolve npm next to the pinned node using the target platform's path
  // semantics — a posix host must still produce `C:\node\npm.cmd` for a
  // Windows unit (and vice versa), so pick the path flavor from `opts.windows`
  // rather than the host's default `path`.
  const p = opts.windows ? path.win32 : path.posix;
  const npmBin = opts.windows ? 'npm.cmd' : 'npm';
  const npmPath = p.join(p.dirname(spec.execPath), npmBin);
  return { nodeExecPath: spec.execPath, npmPath, owningPackage };
}

/**
 * Given an entry-script path inside a global install, return the package
 * directly under the FIRST `node_modules` segment (the global root's
 * node_modules) — the package `npm install -g <pkg>` must target. Scoped
 * packages (`@scope/name`) are returned as two segments. Null when the path
 * has no `node_modules` segment.
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
