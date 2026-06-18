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
