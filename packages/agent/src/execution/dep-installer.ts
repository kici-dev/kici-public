/**
 * Inline `.kici/` dependency install with the repo's package manager, used when
 * the dep cache is unavailable or a download fails. `.kici/package.json` signals
 * that deps exist.
 *
 * npm is the default. pnpm runs for a pnpm workspace, so a `.kici/` member
 * resolves in-repo `workspace:` siblings. yarn classic reads `.kici/.npmrc` for
 * auth and links version-range siblings; yarn berry reads a synthesized
 * `.kici/.yarnrc.yml` with a forced `nodeLinker: node-modules` (so the runner's
 * plain node resolution holds) and resolves `workspace:`/`portal:` siblings.
 * npm installs a workspace member hoisted at the workspace root and links
 * version-range siblings there. No manager builds a linked sibling, so the
 * agent builds the in-repo closure.
 *
 * Security: a per-invocation cache/store dir stops one repo's package.json
 * poisoning later builds. `--ignore-scripts` applies to every manager: a
 * lifecycle script is customer code, and a step-child install runs it in the
 * process holding the job's secrets. `KICI_ALLOW_INSTALL_SCRIPTS=true` opts out.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { makeTempDir } from '@kici-dev/core/tmp';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { attachNpmDebugLog, describeInstallFailure } from './install-failure.js';
import {
  PNPM_IGNORE_BUILD_GATE_ARG,
  PackageManager,
  YarnFlavor,
  detectPackageManagerFromManifests,
  detectYarnFlavor,
} from '@kici-dev/shared/package-manager';
import { resolveNpm } from './npm-resolver.js';
import {
  applyNpmRegistryConfig,
  redactNpmOutput,
  type ApplyNpmRegistryConfigResult,
  type NpmRegistrySpec,
} from './npm-registry-config.js';
import { applyYarnrcBerryConfig } from './yarnrc-berry-config.js';
import { assertResolvableDeps, kiciHasLocalProtocolDeps } from './validate-kici-deps.js';
import {
  collectSiblingsFromRoots,
  isKiciWorkspaceMember,
  resolveKiciNodeModulesLayout,
} from './workspace-siblings.js';

const logger = createLogger({ prefix: 'dep-installer' });

const execFileAsync = promisify(execFile);

/** Install subprocess timeout (10 min) and stdout/stderr buffer (128 MiB). */
const INSTALL_TIMEOUT_MS = 600_000;
const INSTALL_MAX_BUFFER = 128 * 1024 * 1024;

export interface InstallDepsOptions {
  /** Resolved private npm registries from the orchestrator dispatch. */
  npmRegistries?: readonly NpmRegistrySpec[];
  /** Bare-name secrets to project as install-subprocess env vars. */
  installEnvSecrets?: Record<string, string>;
  /** Job-scoped nonce suffixed onto synthesized env-var names. */
  jobIdShort?: string;
  /**
   * Clone root (repo root). Package-manager detection runs against it first,
   * then falls back to `kiciDir`. Defaults to `dirname(kiciDir)`.
   */
  repoRoot?: string;
  /**
   * Base environment for every install and workspace-build subprocess.
   * Defaults to `process.env`, which inside the runner child is already the
   * sanitized job environment. An agent-process caller MUST pass a sanitized
   * base (`buildSanitizedEnv({}, { trustedEnv })`), or the install inherits the
   * agent's credentials.
   */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Operator opt-out from `--ignore-scripts` (`KICI_ALLOW_INSTALL_SCRIPTS`).
   * Read only from agent config, never from a dispatch payload or workflow, so
   * a pull request cannot re-enable lifecycle scripts for itself.
   */
  allowInstallScripts?: boolean;
}

/**
 * Repo root first (a pnpm workspace's signals live there), then `.kici/` for a
 * standalone project, then npm. Manifests only, so the agent's own
 * `npm_config_user_agent` never leaks into the decision.
 */
async function detectKiciPackageManager(
  repoRoot: string,
  kiciDir: string,
): Promise<PackageManager> {
  return (
    (await detectPackageManagerFromManifests(repoRoot)) ??
    (await detectPackageManagerFromManifests(kiciDir)) ??
    PackageManager.Npm
  );
}

/** Repo root first, then `.kici/` for a standalone project. Yarn repos only. */
async function detectKiciYarnFlavor(repoRoot: string, kiciDir: string): Promise<YarnFlavor> {
  const rootFlavor = await detectYarnFlavor(repoRoot);
  if (rootFlavor === YarnFlavor.Berry) return YarnFlavor.Berry;
  return detectYarnFlavor(kiciDir);
}

/**
 * Install `.kici/` dependencies inline with the repo's package manager, the
 * fallback when the dep cache is unavailable or a download fails.
 *
 * The install uses an isolated cache/store directory under the global temp base
 * (which honors `KICI_TMPDIR`), removed afterwards, to prevent cache poisoning
 * between build jobs. With `opts.npmRegistries` / `opts.installEnvSecrets`, a
 * job-scoped `.kici/.npmrc` overlay is synthesized and restored afterwards.
 * Lifecycle scripts are disabled for every package manager unless
 * `opts.allowInstallScripts` is set.
 *
 * @param kiciDir - Path to the `.kici/` directory containing package.json.
 */
export async function installDeps(kiciDir: string, opts: InstallDepsOptions = {}): Promise<void> {
  const repoRoot = opts.repoRoot ?? dirname(kiciDir);
  const packageManager = await detectKiciPackageManager(repoRoot, kiciDir);
  const yarnFlavor =
    packageManager === PackageManager.Yarn
      ? await detectKiciYarnFlavor(repoRoot, kiciDir)
      : YarnFlavor.Classic;
  logger.info('Installing deps inline', { packageManager, yarnFlavor, dir: kiciDir });
  process.stderr.write(
    `[dep-installer:trace] starting install: pm=${packageManager}, flavor=${yarnFlavor}, cwd=${kiciDir}\n`,
  );

  // Fail fast, with an actionable message, on specifiers the single cloned repo
  // cannot resolve.
  await assertResolvableDeps({ kiciDir, repoRoot, packageManager, yarnFlavor });

  const startTime = Date.now();
  // Never gated on a private registry: a public-registry install would run a
  // pull request's `postinstall` with the caller's full environment.
  const ignoreScripts = opts.allowInstallScripts !== true;
  const baseEnv = opts.baseEnv ?? process.env;

  // Berry reads .yarnrc.yml, every other manager reads .npmrc.
  const isBerry = packageManager === PackageManager.Yarn && yarnFlavor === YarnFlavor.Berry;
  const registryConfig = isBerry
    ? await applyYarnrcBerryConfig({
        kiciDir,
        npmRegistries: opts.npmRegistries,
        installEnvSecrets: opts.installEnvSecrets,
        jobIdShort: opts.jobIdShort ?? '00000000',
        ignoreScripts,
      })
    : await applyNpmRegistryConfig({
        kiciDir,
        // npm and pnpm read a workspace member's .npmrc from the workspace root.
        npmrcDir:
          packageManager !== PackageManager.Yarn && (await isKiciWorkspaceMember(repoRoot, kiciDir))
            ? repoRoot
            : kiciDir,
        npmRegistries: opts.npmRegistries,
        installEnvSecrets: opts.installEnvSecrets,
        jobIdShort: opts.jobIdShort ?? '00000000',
      });

  try {
    if (packageManager === PackageManager.Pnpm) {
      await runPnpmInstall({ kiciDir, ignoreScripts, registryConfig, baseEnv });
    } else if (isBerry) {
      await runYarnBerryInstall({ kiciDir, registryConfig, baseEnv });
    } else if (packageManager === PackageManager.Yarn) {
      await runYarnInstall({ kiciDir, ignoreScripts, registryConfig, baseEnv });
    } else {
      await runNpmInstall({ kiciDir, ignoreScripts, registryConfig, baseEnv });
    }
  } catch (e) {
    // The rethrown message reaches the job error and run log, so it carries the
    // exit code and the redacted tail of the installer output.
    // fails-when: the raw execFile error is rethrown — its message is the
    // command line plus stderr only, and stderr can be empty.
    const description = describeInstallFailure(e, registryConfig.tokensForRedaction);
    process.stderr.write(`[dep-installer:trace] INSTALL FAILED: ${description}\n`);
    throw new Error(description);
  } finally {
    await registryConfig.cleanup();
  }

  // Build linked siblings the workflow imports at load time — after registry
  // cleanup, so the build never sees the synthesized token env vars.
  if (packageManager === PackageManager.Pnpm && (await kiciHasLocalProtocolDeps(kiciDir))) {
    await buildWorkspaceClosure(repoRoot, baseEnv);
  }

  // npm and yarn link a workspace sibling (by version range, or yarn berry's
  // `workspace:`/`portal:`) but do not build it.
  if (packageManager === PackageManager.Yarn || packageManager === PackageManager.Npm) {
    await buildLinkedSiblingClosure({ repoRoot, kiciDir, packageManager, yarnFlavor, baseEnv });
  }

  const durationMs = Date.now() - startTime;
  process.stderr.write(`[dep-installer:trace] install complete: ${durationMs}ms\n`);
  logger.info('Deps installed inline', { packageManager, durationMs });
}

/**
 * Prepend the Node binary dir to PATH so spawned tools find `node`. `baseEnv`
 * defaults to `process.env`, the sanitized job env inside the runner child.
 */
function envWithNodeOnPath(
  extraEnv: Record<string, string>,
  nodeDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Drop NODE_ENV: production skips devDependencies, and workflow bundles
  // externalize @kici-dev/sdk, a devDependency.
  const { NODE_ENV: _NODE_ENV, ...restEnv } = baseEnv;
  return {
    ...restEnv,
    ...extraEnv,
    PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${restEnv.PATH ?? ''}`,
  };
}

/** Run `npm install` in `.kici/` with an isolated cache directory. */
async function runNpmInstall(args: {
  kiciDir: string;
  ignoreScripts: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  const { npmCliPath, nodeExe, nodeDir } = resolveNpm();
  const { path: cacheDir, cleanup } = await makeTempDir('npm-cache');
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir, args.baseEnv);

  // Not `npm ci`: its lockfile URLs may name a different registry than .npmrc
  // (localhost tunnel vs direct IP). `--no-audit` because npm's audit POST
  // competes with the tarball fetch pool and stretches cold installs from ~7s to
  // ~2min on flaky egress.
  const buildArgs = (...prefix: string[]): string[] => {
    const a = [...prefix, 'install', '--cache', cacheDir, '--no-audit', '--no-fund'];
    if (args.ignoreScripts) a.push('--ignore-scripts');
    return a;
  };

  try {
    const bin = npmCliPath ? nodeExe : 'npm';
    const argv = npmCliPath ? buildArgs(npmCliPath) : buildArgs();
    process.stderr.write(`[dep-installer:trace] running: ${bin} ${argv.join(' ')}\n`);
    await execFileAsync(bin, argv, {
      cwd: args.kiciDir,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } catch (e) {
    // npm's debug log lives in the per-job cache removed below.
    await attachNpmDebugLog(e, cacheDir);
    throw e;
  } finally {
    await cleanup().catch(() => {});
  }
}

/**
 * pnpm walks up to the workspace root, so in-repo `workspace:` siblings resolve.
 * A per-install temp store (`--config.store-dir`) isolates jobs from each other;
 * `package-import-method=copy` keeps real files for the dep cache to tar; the
 * purge prompt and side-effects cache are off for non-interactive, deterministic
 * runs.
 */
async function runPnpmInstall(args: {
  kiciDir: string;
  ignoreScripts: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  await assertPnpmAvailable();
  const { nodeDir } = resolveNpm();
  const { path: storeDir, cleanup } = await makeTempDir('pnpm-store');
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir, args.baseEnv);

  const argv = [
    'install',
    `--config.store-dir=${storeDir}`,
    '--config.package-import-method=copy',
    '--config.confirm-modules-purge=false',
    '--config.side-effects-cache=false',
    // pnpm 10+ exits non-zero on unapproved build scripts (protobufjs via the
    // OTel gRPC exporters in `@kici-dev/shared`) the workflow never needs.
    PNPM_IGNORE_BUILD_GATE_ARG,
  ];
  if (args.ignoreScripts) argv.push('--ignore-scripts');

  try {
    process.stderr.write(`[dep-installer:trace] running: pnpm ${argv.join(' ')}\n`);
    await execFileAsync('pnpm', argv, {
      cwd: args.kiciDir,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } finally {
    await cleanup().catch(() => {});
  }
}

/** Pure: argv for `yarn install` with an isolated cache folder. */
export function buildYarnInstallArgs(cacheDir: string, ignoreScripts: boolean): string[] {
  const a = ['install', '--cache-folder', cacheDir, '--non-interactive', '--no-progress'];
  if (ignoreScripts) a.push('--ignore-scripts');
  return a;
}

/**
 * yarn classic reads the synthesized `.kici/.npmrc` (`${VAR}` token expansion)
 * for auth. A workspace member hoists deps to the repo-root node_modules. Not
 * `--frozen-lockfile`: lockfile URLs may name a different registry than `.npmrc`.
 */
async function runYarnInstall(args: {
  kiciDir: string;
  ignoreScripts: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  await assertYarnAvailable();
  const { nodeDir } = resolveNpm();
  const { path: cacheDir, cleanup } = await makeTempDir('yarn-cache');
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir, args.baseEnv);
  const argv = buildYarnInstallArgs(cacheDir, args.ignoreScripts);

  try {
    process.stderr.write(`[dep-installer:trace] running: yarn ${argv.join(' ')}\n`);
    await execFileAsync('yarn', argv, {
      cwd: args.kiciDir,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } finally {
    await cleanup().catch(() => {});
  }
}

/** Cache + linker live in .yarnrc.yml. */
export function buildYarnBerryInstallArgs(): string[] {
  return ['install'];
}

/**
 * The synthesized `.kici/.yarnrc.yml` (`applyYarnrcBerryConfig`) forces
 * `nodeLinker: node-modules`, an isolated `cacheFolder` and `enableScripts:
 * false` (unless scripts are allowed), plus `npmScopes`/`npmRegistryServer`
 * auth for a private registry. corepack provisions the pinned berry
 * non-interactively. Not `--immutable`: lockfile URLs may name another registry.
 */
async function runYarnBerryInstall(args: {
  kiciDir: string;
  registryConfig: ApplyNpmRegistryConfigResult;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  await assertYarnAvailable();
  const { nodeDir } = resolveNpm();
  const env = {
    ...envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir, args.baseEnv),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
  const argv = buildYarnBerryInstallArgs();
  process.stderr.write(`[dep-installer:trace] running: yarn ${argv.join(' ')} (berry)\n`);
  await execFileAsync('yarn', argv, {
    cwd: args.kiciDir,
    env,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: INSTALL_MAX_BUFFER,
  });
}

/** Throw an actionable error when the repo needs yarn but it is not installed. */
async function assertYarnAvailable(): Promise<void> {
  try {
    // Neutral cwd: under a package.json pinning another manager, the corepack
    // shim refuses ("configured to use <other>") although yarn exists.
    await execFileAsync('yarn', ['--version'], { timeout: 30_000, cwd: tmpdir() });
  } catch (e) {
    throw new Error(
      'This repository uses yarn, but yarn is not available on this agent. ' +
        'Install yarn (e.g. `corepack enable`) or run on a container/Firecracker ' +
        `agent that bundles it. (${toErrorMessage(e)})`,
    );
  }
}

/** The argv and working directory that run one linked sibling's `build` script. */
export interface SiblingBuildCommand {
  bin: string;
  argv: string[];
  cwd: string;
}

/**
 * How to run a linked sibling's `build` with the repo's manager. npm runs from
 * the sibling's own directory, so a workspace member's script runs as that
 * member. yarn classic takes the global `--cwd`, which berry dropped, so berry
 * runs from the sibling's directory. No argument follows the script name, so
 * nothing extra reaches the build command.
 */
export function siblingBuildCommand(a: {
  packageManager: PackageManager;
  yarnFlavor: YarnFlavor;
  repoRoot: string;
  sibDir: string;
  npmCliPath: string | undefined;
  nodeExe: string;
}): SiblingBuildCommand {
  if (a.packageManager === PackageManager.Npm) {
    return a.npmCliPath
      ? { bin: a.nodeExe, argv: [a.npmCliPath, 'run', 'build'], cwd: a.sibDir }
      : { bin: 'npm', argv: ['run', 'build'], cwd: a.sibDir };
  }
  if (a.yarnFlavor === YarnFlavor.Berry) {
    return { bin: 'yarn', argv: ['run', 'build'], cwd: a.sibDir };
  }
  return { bin: 'yarn', argv: ['--cwd', a.sibDir, 'run', 'build'], cwd: a.repoRoot };
}

/**
 * Build the in-repo workspace siblings `.kici` depends on, for a manager that
 * links them on install but does not build them (npm, yarn classic, yarn
 * berry). Walks siblings from every node_modules root `.kici` resolves from and
 * runs each sibling's `build` script in leaf-first (reverse-discovery) order,
 * with no registry tokens in the env. npm builds only for a hoisted workspace
 * member: a standalone npm `.kici` is never built. Deep cross-sibling chains
 * may build out of strict topological order; real `.kici` closures are shallow.
 */
async function buildLinkedSiblingClosure(args: {
  repoRoot: string;
  kiciDir: string;
  packageManager: PackageManager;
  yarnFlavor: YarnFlavor;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  const layout = await resolveKiciNodeModulesLayout(args.repoRoot, args.kiciDir);
  if (args.packageManager === PackageManager.Npm && !layout.hoistedMember) return;
  const siblings = await collectSiblingsFromRoots(args.repoRoot, args.kiciDir, layout.roots);
  if (siblings.length === 0) return;
  const { npmCliPath, nodeExe, nodeDir } = resolveNpm();
  const env = envWithNodeOnPath({}, nodeDir, args.baseEnv);
  for (const rel of [...siblings].reverse()) {
    const sibDir = join(args.repoRoot, rel);
    if (!(await siblingHasBuildScript(sibDir))) continue;
    const cmd = siblingBuildCommand({ ...args, sibDir, npmCliPath, nodeExe });
    process.stderr.write(
      `[dep-installer:trace] building ${args.packageManager} sibling: ${cmd.bin} ${cmd.argv.join(' ')} @ ${cmd.cwd}\n`,
    );
    try {
      await execFileAsync(cmd.bin, cmd.argv, {
        cwd: cmd.cwd,
        env,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: INSTALL_MAX_BUFFER,
      });
    } catch (e) {
      logSubprocessStreams(e, []);
      throw new Error(
        `Failed to build .kici ${args.packageManager} workspace sibling ${rel}: ${describeExecError(e)}`,
      );
    }
  }
}

/** Whether a sibling package.json declares a `build` script. */
async function siblingHasBuildScript(sibDir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(sibDir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.build === 'string';
  } catch {
    return false;
  }
}

/**
 * Build `.kici`'s in-repo dependencies (`{.kici}^...` excludes `.kici` itself)
 * with no registry tokens in the env. `--if-present` MUST precede the script
 * name: pnpm forwards later args to the script (e.g. `tsc`), which then fails.
 * The thrown error carries the subprocess output, not a bare "Command failed".
 */
async function buildWorkspaceClosure(repoRoot: string, baseEnv: NodeJS.ProcessEnv): Promise<void> {
  const { nodeDir } = resolveNpm();
  const env = envWithNodeOnPath({}, nodeDir, baseEnv);
  const argv = ['--filter', '{.kici}^...', 'run', '--if-present', 'build'];
  process.stderr.write(
    `[dep-installer:trace] building workspace closure: pnpm ${argv.join(' ')}\n`,
  );
  try {
    await execFileAsync('pnpm', argv, {
      cwd: repoRoot,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } catch (e) {
    logSubprocessStreams(e, []);
    throw new Error(`Failed to build .kici workspace dependency closure: ${describeExecError(e)}`);
  }
}

/** The exec error's stderr, else stdout, else message; capped at 2000 chars. */
function describeExecError(e: unknown): string {
  const pick = (k: 'stderr' | 'stdout'): string =>
    e && typeof e === 'object' && k in e ? String((e as Record<string, unknown>)[k]).trim() : '';
  const detail = pick('stderr') || pick('stdout');
  return (detail || toErrorMessage(e)).slice(0, 2000);
}

/** Throw an actionable error when the repo needs pnpm but it is not installed. */
async function assertPnpmAvailable(): Promise<void> {
  try {
    // Neutral cwd: see assertYarnAvailable.
    await execFileAsync('pnpm', ['--version'], { timeout: 30_000, cwd: tmpdir() });
  } catch (e) {
    throw new Error(
      'This repository is a pnpm workspace, but pnpm is not available on this ' +
        'agent. Install pnpm (e.g. `corepack enable`) or run on a container/ ' +
        `Firecracker agent that bundles it. (${toErrorMessage(e)})`,
    );
  }
}

/** Trace the redacted stdout/stderr of a failed install subprocess. */
function logSubprocessStreams(e: unknown, tokens: readonly string[]): void {
  if (e && typeof e === 'object' && 'stdout' in e) {
    process.stderr.write(
      `[dep-installer:trace] stdout: ${redactNpmOutput(String((e as { stdout: unknown }).stdout), tokens).slice(0, 500)}\n`,
    );
  }
  if (e && typeof e === 'object' && 'stderr' in e) {
    process.stderr.write(
      `[dep-installer:trace] stderr: ${redactNpmOutput(String((e as { stderr: unknown }).stderr), tokens).slice(0, 500)}\n`,
    );
  }
}
