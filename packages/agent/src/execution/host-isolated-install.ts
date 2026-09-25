/**
 * Run a container job's `.kici/` install on the agent host without letting the
 * repository reach the install's configuration, environment or tooling.
 *
 * The install never runs in the checkout. `.kici/package.json` and its
 * lockfile are copied (without following symlinks) into a fresh staging
 * directory next to a freshly written `.npmrc`. That file is serialized from
 * the allowlisted pairs the eligibility check parsed with npm's own parser:
 * registries and registry auth from the repository, plus TLS trust and proxies
 * from the operator's own config only. No line of either source file is
 * copied, so `node-options`, `git`, `script-shell` and every other key outside
 * the allowlist cannot reach the package manager. The repository's pnpmfiles,
 * workspace files and `package.json` scripts are never in reach either.
 *
 * The package manager is the agent's own: the npm that ships next to the Node
 * running the agent, or the pinned pnpm bundle, each started with that Node
 * directly — never a corepack shim, which would follow the repository's
 * `packageManager` field. Both run with scripts disabled and git dependencies
 * refused. npm 11.15.0 and later runs `npm install` and refuses URL, file and
 * directory sources by flag; an older npm has no such flags, so it runs
 * `npm ci` against a lockfile `host-install-lockfile.ts` verified pins every
 * package. The resulting `node_modules` is moved into `.kici/`.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { makeTempDir } from '@kici-dev/core/tmp';
import { PNPM_IGNORE_BUILD_GATE_ARG, PackageManager } from '@kici-dev/shared/package-manager';
import type { HostInstallPlan } from './host-install-eligibility.js';
import { renderAgentLines, tokenEnvName, type NpmRegistrySpec } from './npm-registry-config.js';
import { resolveNpm } from './npm-resolver.js';
import { authEnvReferences, isToolReadEnvName, serializeNpmrc } from './npmrc-allowlist.js';

const execFileAsync = promisify(execFile);

/** The pnpm the agent image pins (packages/agent/Dockerfile, `corepack prepare`). */
export const PINNED_PNPM_VERSION = '11.3.0';

/** First npm with `--allow-git` (11.10.0). */
const NPM_ALLOW_GIT_MIN: readonly number[] = [11, 10, 0];
/** First npm with `--allow-remote` / `--allow-file` / `--allow-directory` (11.15.0). */
const NPM_ALLOW_SOURCES_MIN: readonly number[] = [11, 15, 0];

/** The npm command the host install runs. */
export enum NpmInstallCommand {
  /** npm 11.15.0 and later: refuses every non-registry source by flag. */
  Install = 'install',
  /**
   * An older npm: installs exactly what the lockfile pins and never rewrites
   * it. It runs only once the lockfile is verified to pin every package.
   */
  Ci = 'ci',
}

const INSTALL_TIMEOUT_MS = 600_000;
const INSTALL_MAX_BUFFER = 128 * 1024 * 1024;

/** A package manager the host install may run: a Node script and its version. */
export interface HostInstallTool {
  packageManager: HostInstallPlan['packageManager'];
  /** The Node binary that runs the script. */
  nodeExe: string;
  /** The package manager's own CLI entry point (npm-cli.js / pnpm.cjs). */
  script: string;
  version: string;
}

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

async function readPackageVersion(pkgJson: string, name: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    return pkg.name === name && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The command an npm of `version` runs the host install with. */
export function npmInstallCommand(version: string): NpmInstallCommand {
  return versionAtLeast(version, NPM_ALLOW_SOURCES_MIN)
    ? NpmInstallCommand.Install
    : NpmInstallCommand.Ci;
}

/**
 * The npm bundled with the Node running the agent, when it is new enough to
 * refuse git dependencies. A bare `npm` on `PATH` is never used: it may be a
 * shim that picks its own version.
 */
export async function resolveHostNpm(): Promise<HostInstallTool | null> {
  const { npmCliPath, nodeExe } = resolveNpm();
  if (!npmCliPath) return null;
  const version = await readPackageVersion(join(dirname(npmCliPath), '..', 'package.json'), 'npm');
  if (!version || !versionAtLeast(version, NPM_ALLOW_GIT_MIN)) return null;
  return { packageManager: PackageManager.Npm, nodeExe, script: npmCliPath, version };
}

/**
 * The pinned pnpm bundle from the agent's corepack cache, run with the agent's
 * Node. `null` when no readable cache holds exactly {@link PINNED_PNPM_VERSION}.
 */
export async function resolvePinnedPnpm(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<HostInstallTool | null> {
  const homes = [
    env.COREPACK_HOME,
    join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'node', 'corepack'),
  ].filter((h): h is string => Boolean(h));
  for (const corepackHome of homes) {
    const dir = join(corepackHome, 'v1', 'pnpm', PINNED_PNPM_VERSION);
    const script = join(dir, 'bin', 'pnpm.cjs');
    if (!existsSync(script)) continue;
    const version = await readPackageVersion(join(dir, 'package.json'), 'pnpm');
    if (version !== PINNED_PNPM_VERSION) continue;
    return { packageManager: PackageManager.Pnpm, nodeExe: process.execPath, script, version };
  }
  return null;
}

export interface HostNpmrc {
  /** The sanitized `.npmrc` the install reads. */
  text: string;
  /** Env vars the install needs: registry tokens and referenced install secrets. */
  env: Record<string, string>;
}

/**
 * Build the install's only `.npmrc`: the allowlisted operator and repository
 * pairs, serialized by npm's own encoder, then the agent-managed registry
 * block (npm reads the last value of a key). An install secret reaches the
 * install only under a name a kept registry-auth value references as
 * `${NAME}`, and never under a name npm, pnpm or Node reads.
 */
export function buildHostNpmrc(args: {
  npmrc: HostInstallPlan['npmrc'];
  registries: readonly NpmRegistrySpec[];
  installEnvSecrets: Record<string, string>;
  jobIdShort: string;
}): HostNpmrc {
  const { ini, operator, repo } = args.npmrc;
  const referenced = authEnvReferences([operator, repo]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.installEnvSecrets)) {
    // The eligibility check already refuses a tool-read reference; this keeps
    // a caller that builds the file directly to the same rule.
    if (referenced.has(name) && !isToolReadEnvName(name)) env[name] = value;
  }
  args.registries.forEach((reg, i) => {
    env[tokenEnvName(args.jobIdShort, i)] = reg.token;
  });
  const agentBlock = renderAgentLines(args.registries, args.jobIdShort);
  return { text: serializeNpmrc(ini, operator, repo, agentBlock), env };
}

/**
 * The install's whole environment. Only locale, timezone, temp and `PATH` come
 * from the agent; `HOME` and the XDG dirs point into the staging directory so
 * no user-level npm or pnpm config is read. `NODE_OPTIONS`, `npm_config_*` and
 * `pnpm_config_*` never pass, whatever the agent's own environment holds.
 */
export function buildHostInstallEnv(args: {
  baseEnv: NodeJS.ProcessEnv;
  nodeDir: string;
  stageHome: string;
  extra: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    const value = args.baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  env.PATH = `${args.nodeDir}${sep}${args.baseEnv.PATH ?? ''}`;
  env.HOME = args.stageHome;
  env.USERPROFILE = args.stageHome;
  env.XDG_CONFIG_HOME = join(args.stageHome, '.config');
  env.XDG_CACHE_HOME = join(args.stageHome, '.cache');
  env.XDG_DATA_HOME = join(args.stageHome, '.local', 'share');
  env.XDG_STATE_HOME = join(args.stageHome, '.local', 'state');
  return { ...env, ...args.extra };
}

/** Package-manager argv; every flag that stops a code path is unconditional. */
export function buildHostInstallArgs(
  tool: HostInstallTool,
  stage: { cache: string; store: string; userconfig: string },
): string[] {
  if (tool.packageManager === PackageManager.Npm) {
    const command = npmInstallCommand(tool.version);
    const argv = [
      tool.script,
      command,
      '--ignore-scripts',
      '--allow-git=none',
      '--no-audit',
      '--no-fund',
      '--cache',
      stage.cache,
      '--userconfig',
      stage.userconfig,
    ];
    if (command === NpmInstallCommand.Install) {
      argv.push('--allow-remote=none', '--allow-file=none', '--allow-directory=none');
    }
    return argv;
  }
  return [
    tool.script,
    'install',
    '--ignore-scripts',
    '--ignore-pnpmfile',
    '--ignore-workspace',
    '--pm-on-fail=ignore',
    '--config.runtime-on-fail=ignore',
    '--config.block-exotic-subdeps=true',
    '--config.enable-global-virtual-store=false',
    `--config.store-dir=${stage.store}`,
    '--config.package-import-method=copy',
    '--config.confirm-modules-purge=false',
    '--config.side-effects-cache=false',
    PNPM_IGNORE_BUILD_GATE_ARG,
  ];
}

/** Copy one regular file without following a symlink at `src`; `dest` must not exist. */
async function copyNoFollow(src: string, dest: string): Promise<void> {
  const handle = await open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await writeFile(dest, await handle.readFile(), { flag: 'wx', mode: 0o600 });
  } finally {
    await handle.close();
  }
}

/** Move the staged `node_modules` into `.kici/`, which must still be a plain directory. */
async function moveNodeModules(staged: string, kiciDir: string): Promise<void> {
  const kici = await lstat(kiciDir);
  if (kici.isSymbolicLink() || !kici.isDirectory()) {
    throw new Error('.kici changed into something other than a directory during the install');
  }
  const target = join(kiciDir, 'node_modules');
  if (!existsSync(staged)) {
    await mkdir(target);
    return;
  }
  try {
    await rename(staged, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(staged, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  }
}

export interface RunHostInstallArgs {
  kiciDir: string;
  plan: HostInstallPlan;
  tool: HostInstallTool;
  registries: readonly NpmRegistrySpec[];
  installEnvSecrets: Record<string, string>;
  jobIdShort: string;
  /** The agent's sanitized environment; only locale, temp and PATH are read. */
  baseEnv: NodeJS.ProcessEnv;
  /** Kills the package manager when the job is cancelled. */
  signal?: AbortSignal;
}

/** Stage, install and move `node_modules` into `.kici/`. */
export async function runHostIsolatedInstall(args: RunHostInstallArgs): Promise<void> {
  const stage = await makeTempDir('host-install');
  try {
    const project = join(stage.path, 'project');
    const home = join(stage.path, 'home');
    await mkdir(project);
    await mkdir(home);
    await copyNoFollow(join(args.kiciDir, 'package.json'), join(project, 'package.json'));
    if (args.plan.lockfile) {
      await copyNoFollow(join(args.kiciDir, args.plan.lockfile), join(project, args.plan.lockfile));
    }
    const npmrc = buildHostNpmrc({
      npmrc: args.plan.npmrc,
      registries: args.registries,
      installEnvSecrets: args.installEnvSecrets,
      jobIdShort: args.jobIdShort,
    });
    await writeFile(join(project, '.npmrc'), npmrc.text, { flag: 'wx', mode: 0o600 });

    const argv = buildHostInstallArgs(args.tool, {
      cache: join(stage.path, 'cache'),
      store: join(stage.path, 'store'),
      userconfig: join(home, '.npmrc'),
    });
    await execFileAsync(args.tool.nodeExe, argv, {
      cwd: project,
      env: buildHostInstallEnv({
        baseEnv: args.baseEnv,
        nodeDir: dirname(args.tool.nodeExe),
        stageHome: home,
        extra: npmrc.env,
      }),
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    await moveNodeModules(join(project, 'node_modules'), args.kiciDir);
  } finally {
    await rm(stage.path, { recursive: true, force: true }).catch(() => {});
  }
}
