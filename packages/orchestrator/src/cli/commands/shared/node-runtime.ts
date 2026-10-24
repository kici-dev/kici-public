/**
 * The Node.js runtime `kici-admin <component> upgrade --node <path>` moves an
 * npm-installed service to. The runtime is checked before anything changes:
 * it must be a real Node.js executable (not a version-manager shim) that runs,
 * with its own npm beside it. Once the package is installed under it, its
 * `engines.node` must accept that runtime before the service is registered
 * again.
 *
 * The prefix and npm derivation agrees with the one the upgrade uses for the
 * unit's own pinned node (`resolveNpmInstallTarget`): on Unix the prefix is the
 * folder above `bin/node` and npm is `<prefix>/lib/node_modules/npm`; on
 * Windows the prefix is the folder holding `node.exe` and npm is
 * `<prefix>\node_modules\npm`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isExecutableFile,
  versionManagerExecutable,
} from '../../../scaler/agent-binary-location.js';
import { versionManagerPath, VersionManagerPathType } from './bare-metal-binary-check.js';
import type { LaunchSpec, ServicePlatform } from '../../service/types.js';

/** The `--node <path>` option text on both upgrade commands. */
export const NODE_OPTION_DESCRIPTION =
  'Move an npm-installed service to this Node.js executable (installs the package with its npm, then re-registers the service)';

/** Process runner for the npm and node calls; tests inject it. */
export type SpawnRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: SpawnRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
  };
};

/** A Node.js runtime `--node` accepted. */
export interface NodeRuntime {
  nodeExecPath: string;
  /** What `node --version` printed, without the `v`. */
  nodeVersion: string;
  /** The npm global prefix of this runtime. */
  globalPrefix: string;
  /** The runtime's own npm, run as `<node> <npmCliPath>`. */
  npmCliPath: string;
  /** The npm launcher beside the node (`npm`, `npm.cmd` on Windows). */
  npmPath: string;
  /** Printed before the upgrade goes on. */
  warnings: string[];
}

export type NodeRuntimeResolution = ({ ok: true } & NodeRuntime) | { ok: false; reason: string };

/**
 * Check the `--node` path and derive its prefix and npm. Refuses a
 * version-manager shim, a path that is not an executable file, a node that
 * does not run, and a node with no npm beside it. A path through a
 * version-manager alias is accepted with a warning.
 */
export function resolveNodeRuntime(
  nodePath: string,
  opts: {
    windows: boolean;
    run?: SpawnRunner;
    isExecutable?: (p: string) => boolean;
    exists?: (p: string) => boolean;
  },
): NodeRuntimeResolution {
  const p = opts.windows ? path.win32 : path.posix;
  const nodeExecPath = p.resolve(nodePath);
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  const exists = opts.exists ?? fs.existsSync;
  const warnings: string[] = [];

  const vmPath = versionManagerPath(nodeExecPath);
  const vmExe = vmPath ? null : versionManagerExecutable(nodeExecPath);
  if (vmPath?.type === VersionManagerPathType.Shim || vmExe) {
    const kind = vmPath?.kind ?? `version-manager shim (${vmExe!.manager ?? 'unknown'})`;
    return {
      ok: false,
      reason:
        `--node ${nodePath} is a ${kind}: it starts the version manager, which picks a Node.js ` +
        'runtime each time the service starts. Pass the Node.js executable itself, for example ' +
        'the path `mise which node` prints.',
    };
  }
  if (vmPath?.type === VersionManagerPathType.Alias) {
    let real = nodeExecPath;
    try {
      real = fs.realpathSync(nodeExecPath);
    } catch {
      // Not resolvable here: the executable check below reports it.
    }
    warnings.push(
      `Warning: --node ${nodePath} goes through a ${vmPath.kind}, which moves when another ` +
        `Node.js runtime is installed, and the service moves with it. To keep this runtime, pass ${real}.`,
    );
  }

  if (!isExecutable(nodeExecPath)) {
    return { ok: false, reason: `--node ${nodePath} is not an executable file.` };
  }

  const run = opts.run ?? defaultRunner;
  const res = run(nodeExecPath, ['--version']);
  if (res.status !== 0) {
    const detail = res.stderr.trim() ? `: ${res.stderr.trim()}` : '';
    return {
      ok: false,
      reason: `--node ${nodePath} did not run (\`--version\` exited with ${res.status}${detail}).`,
    };
  }
  const version = /^v(\d+\.\d+\.\d+)\s*$/.exec(res.stdout.trim())?.[1];
  if (!version) {
    return {
      ok: false,
      reason: `--node ${nodePath} printed "${res.stdout.trim()}" for --version, which is not a Node.js version.`,
    };
  }

  const nodeDir = p.dirname(nodeExecPath);
  const globalPrefix = opts.windows ? nodeDir : p.dirname(nodeDir);
  const npmCliPath = opts.windows
    ? p.join(globalPrefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : p.join(globalPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(npmCliPath)) {
    return {
      ok: false,
      reason:
        `--node ${nodePath} has no npm beside it: ${npmCliPath} does not exist. The upgrade ` +
        "installs the package with that runtime's own npm.",
    };
  }
  return {
    ok: true,
    nodeExecPath,
    nodeVersion: version,
    globalPrefix,
    npmCliPath,
    npmPath: p.join(nodeDir, opts.windows ? 'npm.cmd' : 'npm'),
    warnings,
  };
}

type Version = [number, number, number];

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The comparators one range term stands for, or null when it uses syntax this
 * reader does not know. Reads `>=`, `>`, `<=`, `<` and `=` with a full or
 * partial version, a bare full version, and `^` / `~` with a full version.
 * A partial version stands for every version it names, as npm reads it:
 * `<=24` is `<25.0.0` and `>24.5` is `>=24.6.0`.
 */
function termComparators(term: string): Array<[string, Version]> | null {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(term);
  if (!m) return null;
  const op = m[1] ?? '=';
  const full = m[3] !== undefined && m[4] !== undefined;
  const v: Version = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (op === '^' || op === '~') {
    if (!full) return null;
    const upper: Version =
      op === '^' && v[0] === 0 && v[1] === 0
        ? [0, 0, v[2] + 1]
        : op === '~' || v[0] === 0
          ? [v[0], v[1] + 1, 0]
          : [v[0] + 1, 0, 0];
    return [
      ['>=', v],
      ['<', upper],
    ];
  }
  if (full) return [[op, v]];
  if (op === '=') return null;
  // The first version past the ones a partial version names.
  const next: Version = m[3] === undefined ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
  if (op === '<=') return [['<', next]];
  if (op === '>') return [['>=', next]];
  return [[op, v]];
}

/**
 * Whether Node.js `version` satisfies the `engines.node` range. Null when the
 * range uses syntax this reader does not know, so the caller can say it was
 * not checked rather than guess.
 */
export function satisfiesNodeRange(version: string, range: string): boolean | null {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
  const v = parts as Version;
  let any = false;
  for (const set of range.split('||')) {
    const terms = set.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    let all = true;
    for (const term of terms) {
      const comparators = termComparators(term);
      if (!comparators) return null;
      for (const [op, bound] of comparators) {
        const c = compare(v, bound);
        const ok =
          op === '>='
            ? c >= 0
            : op === '>'
              ? c > 0
              : op === '<='
                ? c <= 0
                : op === '<'
                  ? c < 0
                  : c === 0;
        if (!ok) all = false;
      }
    }
    if (all) any = true;
  }
  return any;
}

/** The `package.json` of a global package under `globalPrefix`. */
export function installedPackageJsonPath(
  globalPrefix: string,
  pkg: string,
  windows: boolean,
): string {
  const p = windows ? path.win32 : path.posix;
  const parts = pkg.split('/');
  return windows
    ? p.join(globalPrefix, 'node_modules', ...parts, 'package.json')
    : p.join(globalPrefix, 'lib', 'node_modules', ...parts, 'package.json');
}

/**
 * Whether the package installed at `packageJsonPath` accepts Node.js
 * `nodeVersion` in its `engines.node`. A range this reader cannot read is
 * accepted with a warning.
 */
export function checkInstalledEngines(args: {
  packageJsonPath: string;
  nodeVersion: string;
  nodeExecPath: string;
}): { ok: true; warning?: string } | { ok: false; reason: string } {
  const { packageJsonPath, nodeVersion, nodeExecPath } = args;
  let pkg: { name?: unknown; version?: unknown; engines?: { node?: unknown } };
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as typeof pkg;
  } catch {
    return {
      ok: false,
      reason: `${packageJsonPath} cannot be read, so the package is not installed under ${nodeExecPath}.`,
    };
  }
  const range = pkg.engines?.node;
  if (typeof range !== 'string' || range.trim() === '') return { ok: true };
  const release = `${String(pkg.name)}@${String(pkg.version)}`;
  const verdict = satisfiesNodeRange(nodeVersion, range);
  if (verdict === null) {
    return {
      ok: true,
      warning: `Warning: the engines.node range "${range}" of ${release} was not checked against Node.js ${nodeVersion}.`,
    };
  }
  if (verdict) return { ok: true };
  return {
    ok: false,
    reason:
      `${nodeExecPath} is Node.js ${nodeVersion}, but ${release} needs Node.js ${range} ` +
      `(engines.node in ${packageJsonPath}).`,
  };
}

/**
 * `file` moved from under `oldPrefix` to under `newPrefix`, or null when it is
 * not under `oldPrefix`. Windows compares without regard to case.
 */
export function reRootPath(
  file: string,
  oldPrefix: string,
  newPrefix: string,
  windows: boolean,
): string | null {
  const sep = windows ? '\\' : '/';
  const withSep = (s: string) => (s.endsWith(sep) ? s : s + sep);
  const oldBase = withSep(oldPrefix);
  const norm = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
  if (!norm(file).startsWith(norm(oldBase))) return null;
  return withSep(newPrefix) + file.slice(oldBase.length);
}

/**
 * The launch command after a move: the new node, and every argument under the
 * old prefix re-rooted to the new one. The account the unit runs as stays.
 */
export function reRootLaunch(
  spec: LaunchSpec,
  move: { oldPrefix: string; newPrefix: string; nodeExecPath: string; windows: boolean },
): LaunchSpec {
  const args = spec.args.map(
    (arg) => reRootPath(arg, move.oldPrefix, move.newPrefix, move.windows) ?? arg,
  );
  return { ...spec, execPath: move.nodeExecPath, args };
}

/** What a `--node` upgrade changes: the launch command before and after, and where. */
export interface RuntimeMove {
  from: LaunchSpec;
  to: LaunchSpec;
  /** The npm global prefix the service runs from now. */
  oldPrefix: string;
  /** The global package the unit runs (`kici-admin`, or `@kici-dev/<component>`). */
  owningPackage: string;
  /** That package's `package.json` under the new runtime, for the engines check. */
  packageJsonPath: string;
  node: NodeRuntime;
}

/**
 * Why `--node` cannot run with these options, or null. An archive install
 * takes its Node.js with the release, `--rollback`, `--pick` and `--cleanup`
 * act on installed archive versions, and a compose service runs the Node.js of
 * its image.
 */
export function checkNodeFlagConflicts(opts: {
  node?: string;
  from?: string;
  url?: string;
  rollback?: boolean;
  pick?: boolean;
  cleanup?: boolean;
  restartOnly?: boolean;
  version?: string;
  platform: ServicePlatform;
}): string | null {
  if (!opts.node) return null;
  if (opts.platform === 'compose') {
    return '--node does not apply to a compose service: it runs the Node.js of its container image.';
  }
  const conflicts: string[] = [];
  if (opts.from) conflicts.push('--from');
  if (opts.url) conflicts.push('--url');
  if (opts.rollback) conflicts.push('--rollback');
  if (opts.pick) conflicts.push('--pick');
  if (opts.cleanup) conflicts.push('--cleanup');
  if (conflicts.length === 0) return null;
  return (
    `--node cannot be combined with ${conflicts.join(', ')}. --node moves a service that runs ` +
    'from an npm install; an archive install takes its Node.js with the release.'
  );
}
