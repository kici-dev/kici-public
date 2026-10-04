/**
 * Resolve the npm the agent runs.
 *
 * `resolveNpm()` finds the npm installed with the Node binary that runs the
 * agent. The builder role and the in-container dependency installer use it,
 * and fall back to a bare `npm` on PATH themselves.
 *
 * `lookupHostNpm()` finds the npm the host install trusts: Node's own npm
 * first, exactly as `resolveNpm()` finds it; otherwise a distribution's npm
 * package (Debian and Ubuntu ship npm apart from Node), or an `npm` on PATH
 * that resolves to an npm package's own CLI. Such an npm is accepted only at
 * {@link NPM_ALLOW_GIT_MIN} or later, and only when the modules the agent loads
 * from it resolve inside its own install. The lookup runs nothing: it reads
 * `package.json` files and resolves paths.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Result of npm resolution. */
interface NpmResolution {
  /** Absolute path to npm-cli.js, or undefined if using bare 'npm' from PATH. */
  npmCliPath: string | undefined;
  /** The Node.js executable path (process.execPath). */
  nodeExe: string;
  /** Directory containing the Node.js binary. */
  nodeDir: string;
}

/** Where the Node.js distribution layouts put npm, relative to the Node binary's directory. */
function bundledNpmCliPaths(nodeDir: string): string[] {
  return [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/**
 * Resolve the npm CLI path from the current Node.js binary.
 *
 * Checks standard Node.js distribution layout paths:
 * - {nodeDir}/../lib/node_modules/npm/bin/npm-cli.js (Linux/macOS installed)
 * - {nodeDir}/node_modules/npm/bin/npm-cli.js (Windows / some layouts)
 *
 * Returns undefined npmCliPath if neither is found (caller can fall back to PATH).
 */
export function resolveNpm(): NpmResolution {
  const nodeExe = process.execPath;
  const nodeDir = dirname(nodeExe);
  const npmCliPath = bundledNpmCliPaths(nodeDir).find((p) => existsSync(p));
  return { npmCliPath, nodeExe, nodeDir };
}

/** The oldest npm the host install runs: the first with `--allow-git` (11.10.0). */
export const NPM_ALLOW_GIT_MIN: readonly number[] = [11, 10, 0];

/** Numeric `major.minor.patch` compare; prerelease tags are ignored. */
export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (have !== min[i]) return have > min[i]!;
  }
  return true;
}

/**
 * The version of the npm package whose CLI is `npmCliPath`, read from the
 * package's own `package.json`. `null` when that file is missing, does not
 * parse, or names a package other than npm.
 */
export function readNpmVersion(npmCliPath: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(npmCliPath), '..', 'package.json'), 'utf-8'),
    ) as { name?: unknown; version?: unknown };
    return pkg.name === 'npm' && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Where a distribution that packages npm apart from Node installs its CLI (Debian, Ubuntu). */
export const DISTRIBUTION_NPM_CLI_PATHS: readonly string[] = [
  '/usr/share/nodejs/npm/bin/npm-cli.js',
];

/** The modules the agent loads from the npm it found: the `.npmrc` parser and the lockfile reader. */
const NPM_MODULE_IDS = ['ini', '@npmcli/arborist', 'semver'] as const;

/** Where the npm the host install trusts came from. */
export enum HostNpmSource {
  /** Installed with the Node binary that runs the agent. */
  Bundled = 'bundled',
  /** A distribution's npm package, such as Debian's `npm`. */
  Distribution = 'distribution',
  /** An `npm` on the agent's PATH that resolves to an npm package's own CLI. */
  Path = 'path',
}

/** What the npm lookup reads from the agent process. */
export interface HostNpmLookupEnv {
  /** The Node binary that runs the agent. */
  execPath: string;
  /** The agent process's PATH, never a job's. */
  pathEnv: string | undefined;
  /** Distribution npm CLI locations, tried after Node's own npm. */
  distributionCliPaths: readonly string[];
}

/** The lookup inputs of the running agent. */
export function hostNpmLookupEnv(): HostNpmLookupEnv {
  return {
    execPath: process.execPath,
    pathEnv: process.env.PATH,
    distributionCliPaths: DISTRIBUTION_NPM_CLI_PATHS,
  };
}

/** The npm the host install trusts, or why there is none. */
export type HostNpm =
  | { found: true; npmCliPath: string; version: string | null; source: HostNpmSource }
  | { found: false; detail: string };

/** Whether `file` lies strictly inside `dir`. */
function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The real paths of the `npm` entries on PATH that are an npm package's own
 * CLI. A relative entry is skipped: it resolves against the agent's working
 * directory. A launcher that is not `bin/npm-cli.js` (a version-manager shim,
 * which picks its own npm) is skipped too.
 */
function pathNpmCliPaths(pathEnv: string | undefined): string[] {
  const found: string[] = [];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    let real: string;
    try {
      real = realpathSync(join(dir, 'npm'));
    } catch {
      continue;
    }
    if (basename(real) === 'npm-cli.js' && basename(dirname(real)) === 'bin') found.push(real);
  }
  return found;
}

/**
 * Resolve module `id` as the npm whose CLI is `npmCliPath` loads it. The module
 * must resolve inside the directory that holds the npm package
 * (`/usr/share/nodejs` for Debian's), not from a parent folder or a Node global
 * folder such as `~/.node_modules`, which serves any path: the install runs
 * with its own `HOME`, so a module found there is not the one npm loads.
 * `require.resolve` loads no code.
 */
export function resolveNpmModule(
  npmCliPath: string,
  id: string,
): { file: string } | { reason: string } {
  const moduleRoot = dirname(dirname(dirname(npmCliPath)));
  let file: string;
  try {
    file = createRequire(npmCliPath).resolve(id);
  } catch {
    return { reason: `${npmCliPath}: ${id} does not resolve` };
  }
  return isInside(file, moduleRoot)
    ? { file }
    : { reason: `${npmCliPath}: ${id} resolves to ${file}, outside ${moduleRoot}` };
}

/**
 * Check an npm found outside Node's own install: its version, then that each
 * module the agent loads from it resolves inside its own install
 * ({@link resolveNpmModule}).
 */
function checkCandidate(npmCliPath: string): { version: string } | { reason: string } {
  const version = readNpmVersion(npmCliPath);
  if (!version) return { reason: `${npmCliPath}: no npm version in its package.json` };
  if (!versionAtLeast(version, NPM_ALLOW_GIT_MIN)) {
    return { reason: `${npmCliPath} is npm ${version}, older than ${NPM_ALLOW_GIT_MIN.join('.')}` };
  }
  for (const id of NPM_MODULE_IDS) {
    const resolved = resolveNpmModule(npmCliPath, id);
    if ('reason' in resolved) return resolved;
  }
  return { version };
}

/**
 * The npm the host install trusts. Node's own npm wins whenever it exists, with
 * no further check, so a host that ships npm with Node resolves as it always
 * has. Otherwise the first distribution or PATH candidate that passes
 * {@link checkCandidate}; when none does, `detail` names each candidate and why.
 */
export function lookupHostNpm(env: HostNpmLookupEnv = hostNpmLookupEnv()): HostNpm {
  const bundled = bundledNpmCliPaths(dirname(env.execPath)).find((p) => existsSync(p));
  if (bundled) {
    return {
      found: true,
      npmCliPath: bundled,
      version: readNpmVersion(bundled),
      source: HostNpmSource.Bundled,
    };
  }
  const candidates = [
    ...env.distributionCliPaths
      .filter((p) => isAbsolute(p))
      .map((p) => ({ path: p, source: HostNpmSource.Distribution })),
    ...pathNpmCliPaths(env.pathEnv).map((p) => ({ path: p, source: HostNpmSource.Path })),
  ];
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate.path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const checked = checkCandidate(real);
    if ('reason' in checked) {
      reasons.push(checked.reason);
      continue;
    }
    return { found: true, npmCliPath: real, version: checked.version, source: candidate.source };
  }
  return {
    found: false,
    detail:
      reasons.length > 0
        ? reasons.join('; ')
        : `no npm beside ${env.execPath}, at ${env.distributionCliPaths.join(', ')}, or on PATH`,
  };
}

/**
 * Verify that npm is usable by running `npm --version`.
 *
 * Called at agent startup when the builder role is active.
 * Throws a descriptive error if npm cannot be executed.
 *
 * @returns The npm version string (e.g., "10.8.1")
 */
export function verifyNpmAvailable(): string {
  const { npmCliPath, nodeExe, nodeDir } = resolveNpm();

  const env = {
    ...process.env,
    PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };

  try {
    let output: string;
    if (npmCliPath) {
      output = execFileSync(nodeExe, [npmCliPath, '--version'], {
        env,
        timeout: 10_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else {
      output = execFileSync('npm', ['--version'], {
        env,
        timeout: 10_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    }
    return output.trim();
  } catch (err) {
    const hint = npmCliPath
      ? `npm-cli.js found at ${npmCliPath} but failed to execute`
      : 'npm not found relative to Node binary or on PATH';
    throw new Error(
      `Builder role requires npm but it is not available. ${hint}. ` +
        `Ensure the Node.js distribution includes npm, or install npm and add it to PATH. ` +
        `(Node binary: ${nodeExe})`,
      { cause: err },
    );
  }
}
