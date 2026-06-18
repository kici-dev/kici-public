/**
 * Package-manager detection.
 *
 * Determines which package manager (npm / pnpm / yarn) a project relies on, so
 * dependency operations use the manager that matches the rest of the user's
 * repository instead of always assuming npm. Used by `kici init` (to generate a
 * lockfile that matches the user's repo) and by the agent (to install `.kici/`
 * dependencies with the manager that can resolve the repo's dependency graph,
 * including pnpm/yarn `workspace:` siblings).
 *
 * The {@link PackageManager} enum + pure helpers live in the node-free
 * `./package-manager-types.js` module and are re-exported here so existing
 * `@kici-dev/shared/package-manager` consumers keep one import site.
 */

import { access, readFile } from 'node:fs/promises';
import { accessSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PackageManager, YarnFlavor, parsePackageManager } from './package-manager-types.js';

export {
  PackageManager,
  PACKAGE_MANAGERS,
  parsePackageManager,
  YarnFlavor,
} from './package-manager-types.js';

/** Map a detected manager to its install command argv (binary + args). */
export function installCommand(pm: PackageManager): [string, 'install'] {
  return [pm, 'install'];
}

/**
 * pnpm 10+ exits non-zero (`ERR_PNPM_IGNORED_BUILDS`) when a dependency ships a
 * build/lifecycle script that isn't on an approved-builds allowlist — even when
 * the install otherwise succeeds (packages linked, lockfile written). A `.kici/`
 * workflow package pulls such a dependency transitively (protobufjs, via the
 * OpenTelemetry gRPC exporters in `@kici-dev/shared`), so a bare `pnpm install`
 * aborts on a dependency whose build script the workflow never needs. The `pnpm`
 * field in package.json is no longer read by pnpm 11, so a template-level
 * allowlist cannot fix it. This flag turns the strict gate off for the install
 * invocation: ignored build scripts become a warning rather than a fatal exit,
 * and dependency build scripts are not run.
 */
export const PNPM_IGNORE_BUILD_GATE_ARG = '--config.strict-dep-builds=false';

/**
 * Extra argv appended to a package manager's install so a dependency with an
 * unapproved build script does not turn a successful install into a non-zero
 * exit. Only pnpm has this gate; npm and yarn run dependency build scripts by
 * default and need no flag.
 */
export function installBuildPolicyArgs(pm: PackageManager): string[] {
  return pm === PackageManager.Pnpm ? [PNPM_IGNORE_BUILD_GATE_ARG] : [];
}

/** Lockfile basenames mapped to the manager that produces them, in priority order. */
const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', PackageManager.Pnpm],
  ['yarn.lock', PackageManager.Yarn],
  ['package-lock.json', PackageManager.Npm],
];

/**
 * Detect the package manager the user's project relies on.
 *
 * Priority order (first match wins):
 *   1. `packageManager` field in `<projectDir>/package.json` (Corepack
 *      convention, e.g. `"packageManager": "pnpm@9.x"`). Only the name before
 *      `@` is parsed; an unrecognized name falls through.
 *   2. A lockfile in the project root (`pnpm-lock.yaml` > `yarn.lock` >
 *      `package-lock.json`).
 *   3. The `npm_config_user_agent` env var (set by `pnpm dlx` / `yarn dlx` /
 *      `npx`); the leading `<name>/` segment names the manager.
 *   4. Default to npm when nothing matches, so we never guess wrong and emit a
 *      lockfile the user did not ask for.
 *
 * @param projectDir - The project root to inspect.
 */
export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  const fromManifests = await detectPackageManagerFromManifests(projectDir);
  if (fromManifests) return fromManifests;

  const fromUserAgent = parseUserAgent(process.env.npm_config_user_agent);
  if (fromUserAgent) return fromUserAgent;

  return PackageManager.Npm;
}

/**
 * Detect the package manager from a directory's **committed manifests only** —
 * tiers 1 (`packageManager` field) and 2 (lockfile). Returns `null` when the
 * directory carries no package-manager signal, so callers can distinguish
 * "explicitly npm" from "no signal".
 *
 * This deliberately excludes the `npm_config_user_agent` tier: a consumer
 * inspecting a cloned repository (the agent) must key off the repo's own files,
 * not the ambient env of the process that happens to be reading them.
 */
export async function detectPackageManagerFromManifests(
  projectDir: string,
): Promise<PackageManager | null> {
  const fromField = parsePackageManagerField(await readPackageJson(projectDir));
  if (fromField) return fromField;

  for (const [file, pm] of LOCKFILES) {
    if (await fileExists(path.join(projectDir, file))) return pm;
  }
  return null;
}

/**
 * Synchronous {@link detectPackageManager}. Used by the compiler's lock-file
 * generation, which is synchronous; identical tiering and precedence.
 */
export function detectPackageManagerSync(projectDir: string): PackageManager {
  const fromField = parsePackageManagerField(readPackageJsonSync(projectDir));
  if (fromField) return fromField;

  for (const [file, pm] of LOCKFILES) {
    if (fileExistsSync(path.join(projectDir, file))) return pm;
  }

  const fromUserAgent = parseUserAgent(process.env.npm_config_user_agent);
  if (fromUserAgent) return fromUserAgent;

  return PackageManager.Npm;
}

/** Parse the major version out of a `packageManager: "yarn@X.Y.Z"` field. */
function yarnMajorFromField(content: string | null): number | null {
  if (content === null) return null;
  try {
    const pkg = JSON.parse(content) as { packageManager?: unknown };
    if (typeof pkg.packageManager !== 'string') return null;
    const m = /^yarn@(\d+)\./.exec(pkg.packageManager);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Whether a `yarn.lock`'s head carries the berry `__metadata:` marker. */
function yarnLockIsBerry(head: string | null): boolean {
  return head !== null && /^__metadata:/m.test(head);
}

/**
 * Detect whether a yarn project is classic (v1) or berry (v2+). Precedence:
 *   1. `packageManager: "yarn@<major>"` field (>=2 => berry).
 *   2. a `.yarnrc.yml` file (classic uses `.yarnrc`, berry uses `.yarnrc.yml`).
 *   3. a `yarn.lock` whose head contains the berry `__metadata:` marker.
 *   4. default to classic (the already-shipped path; berry is opt-in).
 *
 * Only meaningful when {@link detectPackageManager} returned `Yarn`; callers
 * pass the same dir that yielded `Yarn`.
 */
export async function detectYarnFlavor(projectDir: string): Promise<YarnFlavor> {
  const major = yarnMajorFromField(await readPackageJson(projectDir));
  if (major !== null) return major >= 2 ? YarnFlavor.Berry : YarnFlavor.Classic;
  if (await fileExists(path.join(projectDir, '.yarnrc.yml'))) return YarnFlavor.Berry;
  const head = await readLockHead(path.join(projectDir, 'yarn.lock'));
  return yarnLockIsBerry(head) ? YarnFlavor.Berry : YarnFlavor.Classic;
}

/** Synchronous {@link detectYarnFlavor} for the compiler's sync lockfile path. */
export function detectYarnFlavorSync(projectDir: string): YarnFlavor {
  const major = yarnMajorFromField(readPackageJsonSync(projectDir));
  if (major !== null) return major >= 2 ? YarnFlavor.Berry : YarnFlavor.Classic;
  if (fileExistsSync(path.join(projectDir, '.yarnrc.yml'))) return YarnFlavor.Berry;
  return yarnLockIsBerry(readLockHeadSync(path.join(projectDir, 'yarn.lock')))
    ? YarnFlavor.Berry
    : YarnFlavor.Classic;
}

/** Tier 1: parse the Corepack `packageManager` field, if present. */
function parsePackageManagerField(content: string | null): PackageManager | null {
  if (content === null) return null;
  try {
    const pkg = JSON.parse(content) as { packageManager?: unknown };
    if (typeof pkg.packageManager !== 'string') return null;
    // Format: "<name>@<version>[+<hash>]" — parse the name before the first '@'.
    return parsePackageManager(pkg.packageManager.split('@', 1)[0]);
  } catch {
    return null;
  }
}

/** Tier 3: the `npm_config_user_agent` env var, whose leading segment names the manager. */
function parseUserAgent(userAgent: string | undefined): PackageManager | null {
  if (!userAgent) return null;
  // e.g. "pnpm/9.1.0 npm/? node/v24.0.0 linux x64"
  return parsePackageManager(userAgent.split('/', 1)[0]);
}

async function readPackageJson(projectDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, 'package.json'), 'utf-8');
  } catch {
    return null;
  }
}

function readPackageJsonSync(projectDir: string): string | null {
  try {
    return readFileSync(path.join(projectDir, 'package.json'), 'utf-8');
  } catch {
    return null;
  }
}

/** Read the first 512 bytes of a lockfile as UTF-8, or null when absent. */
async function readLockHead(file: string): Promise<string | null> {
  try {
    return (await readFile(file, 'utf-8')).slice(0, 512);
  } catch {
    return null;
  }
}

function readLockHeadSync(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8').slice(0, 512);
  } catch {
    return null;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function fileExistsSync(target: string): boolean {
  try {
    accessSync(target);
    return true;
  } catch {
    return false;
  }
}
