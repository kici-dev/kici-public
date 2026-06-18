/**
 * Inline dependency installation for graceful degradation.
 *
 * When the dep cache is unavailable or a download fails, the agent installs
 * `.kici/` dependencies directly with the repository's package manager.
 *
 * The package manager is detected from the cloned repo (npm / pnpm / yarn); the
 * presence of `.kici/package.json` signals that deps should be installed. npm
 * is the default and ships with every Node.js install; pnpm is used when the
 * repo is a pnpm workspace so a `.kici/` member can resolve in-repo
 * `workspace:` siblings. yarn is supported in both flavors: classic (v1) reads
 * `.kici/.npmrc` for registry auth and links version-range workspace siblings;
 * berry (v2+) reads a synthesized `.kici/.yarnrc.yml` for auth, runs with a
 * forced `nodeLinker: node-modules` (so the resulting tree matches classic/npm
 * and the runner's plain node resolution holds), and resolves
 * `workspace:`/`portal:` siblings. Either flavor links the sibling but does not
 * build it, so the agent builds the in-repo closure after install.
 *
 * Security: the install runs with an isolated per-invocation cache/store
 * directory to prevent cache poisoning across build jobs — a malicious
 * package.json in one repo cannot taint the cache used by subsequent builds.
 * The same pressure rules out letting lifecycle scripts see synthesized auth
 * env vars — the install runs with `--ignore-scripts` whenever a private
 * registry is configured.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
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
import { collectInRepoSiblings, resolveYarnNodeModulesRoot } from './workspace-siblings.js';

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
  /** Short job-scoped nonce — used as suffix on synthesized env-var names. */
  jobIdShort?: string;
  /**
   * Clone root (repo root). Package-manager detection runs against it first,
   * then falls back to `kiciDir`. Defaults to `dirname(kiciDir)`.
   */
  repoRoot?: string;
}

/**
 * Detect the package manager for the cloned repo from its committed manifests.
 * A pnpm workspace's `packageManager` field + `pnpm-lock.yaml` live at the repo
 * root, so check there first; fall back to `.kici/` for a standalone
 * (non-workspace) project that carries its own lockfile; default to npm when
 * neither carries a signal. Uses the manifests-only detector so the agent's own
 * launch env (`npm_config_user_agent`) never leaks into the decision.
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

/**
 * Detect the yarn flavor (classic vs berry) for the cloned repo. Mirrors
 * `detectKiciPackageManager`: probe the repo root first, then `.kici/` for a
 * standalone project. Only called when the detected manager is `Yarn`.
 */
async function detectKiciYarnFlavor(repoRoot: string, kiciDir: string): Promise<YarnFlavor> {
  // The repo-root signal wins; fall back to .kici/ for a standalone project.
  const rootFlavor = await detectYarnFlavor(repoRoot);
  if (rootFlavor === YarnFlavor.Berry) return YarnFlavor.Berry;
  return detectYarnFlavor(kiciDir);
}

/**
 * Install `.kici/` dependencies inline with the repo's package manager.
 *
 * Falls back to this when the dep cache is unavailable or a download fails.
 * The install runs with an isolated cache/store directory (created in
 * `os.tmpdir()`) to prevent cache poisoning between build jobs; the directory
 * is removed after installation.
 *
 * If `opts.npmRegistries` / `opts.installEnvSecrets` is provided, a job-scoped
 * `.kici/.npmrc` overlay is synthesized for the install, restored in `finally`,
 * and the install runs with `--ignore-scripts` so lifecycle scripts in a
 * committed `package.json` cannot exfiltrate the synthesized token env vars.
 *
 * @param kiciDir - Path to the `.kici/` directory containing package.json.
 * @param opts    - Optional registry / installEnv / repoRoot configuration.
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

  // Fail fast on dependency specifiers the detected package manager cannot
  // resolve from the single cloned repo, so the job fails with an actionable
  // message instead of a raw install error.
  await assertResolvableDeps({ kiciDir, repoRoot, packageManager, yarnFlavor });

  const startTime = Date.now();
  const hasPrivateRegistry =
    (opts.npmRegistries?.length ?? 0) > 0 ||
    (opts.installEnvSecrets ? Object.keys(opts.installEnvSecrets).length > 0 : false);

  // Berry reads .yarnrc.yml, every other manager reads .npmrc.
  const isBerry = packageManager === PackageManager.Yarn && yarnFlavor === YarnFlavor.Berry;
  const registryConfig = isBerry
    ? await applyYarnrcBerryConfig({
        kiciDir,
        npmRegistries: opts.npmRegistries,
        installEnvSecrets: opts.installEnvSecrets,
        jobIdShort: opts.jobIdShort ?? '00000000',
      })
    : await applyNpmRegistryConfig({
        kiciDir,
        npmRegistries: opts.npmRegistries,
        installEnvSecrets: opts.installEnvSecrets,
        jobIdShort: opts.jobIdShort ?? '00000000',
      });

  try {
    if (packageManager === PackageManager.Pnpm) {
      await runPnpmInstall({ kiciDir, hasPrivateRegistry, registryConfig });
    } else if (isBerry) {
      await runYarnBerryInstall({ kiciDir, registryConfig });
    } else if (packageManager === PackageManager.Yarn) {
      await runYarnInstall({ kiciDir, hasPrivateRegistry, registryConfig });
    } else {
      await runNpmInstall({ kiciDir, hasPrivateRegistry, registryConfig });
    }
  } catch (e) {
    const tokens = registryConfig.tokensForRedaction;
    process.stderr.write(
      `[dep-installer:trace] INSTALL FAILED: ${redactNpmOutput(toErrorMessage(e), tokens)}\n`,
    );
    logSubprocessStreams(e, tokens);
    throw e;
  } finally {
    await registryConfig.cleanup();
  }

  // pnpm `workspace:` siblings (e.g. a locally-developed action package) emit
  // build output the workflow imports at load time. `pnpm install` links the
  // sibling but does not build it, so build the in-repo dependency closure of
  // `.kici/` here — after registry cleanup, so the build subprocess never sees
  // the synthesized token env vars.
  if (packageManager === PackageManager.Pnpm && (await kiciHasLocalProtocolDeps(kiciDir))) {
    await buildWorkspaceClosure(repoRoot);
  }

  // yarn links a workspace sibling (classic by version range, berry via
  // `workspace:`/`portal:`) but does not build it. Build the in-repo dependency
  // closure of `.kici/` here — after registry cleanup, so the build subprocess
  // never sees the synthesized token env vars.
  if (packageManager === PackageManager.Yarn) {
    await buildYarnWorkspaceClosure(repoRoot, kiciDir, yarnFlavor);
  }

  const durationMs = Date.now() - startTime;
  process.stderr.write(`[dep-installer:trace] install complete: ${durationMs}ms\n`);
  logger.info('Deps installed inline', { packageManager, durationMs });
}

/** Build the Node binary directory onto PATH so spawned tools find `node`. */
function envWithNodeOnPath(extraEnv: Record<string, string>, nodeDir: string): NodeJS.ProcessEnv {
  // npm/pnpm skip devDependencies when NODE_ENV=production. Workflow bundles
  // externalize @kici-dev/sdk (a devDependency), so it must always be
  // installed — remove NODE_ENV so all dependencies install.
  const { NODE_ENV: _NODE_ENV, ...restEnv } = process.env;
  return {
    ...restEnv,
    ...extraEnv,
    PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };
}

/** Run `npm install` in `.kici/` with an isolated cache directory. */
async function runNpmInstall(args: {
  kiciDir: string;
  hasPrivateRegistry: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
}): Promise<void> {
  const { npmCliPath, nodeExe, nodeDir } = resolveNpm();
  const cacheDir = await mkdtemp(join(tmpdir(), 'kici-npm-cache-'));
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir);

  // Always `npm install` (not `npm ci`): `npm ci` uses resolved URLs baked into
  // package-lock.json, which may point at a different registry than .npmrc
  // (e.g. localhost tunnel vs direct IP). `--no-audit`/`--no-fund` are
  // unconditional: the agent installs deps, it does not advise on CVEs/funding,
  // and npm's post-install audit POST interacts with the tarball fetch pool to
  // balloon cold-cache installs from ~7s to ~2min on flaky egress.
  const buildArgs = (...prefix: string[]): string[] => {
    const a = [...prefix, 'install', '--cache', cacheDir, '--no-audit', '--no-fund'];
    if (args.hasPrivateRegistry) a.push('--ignore-scripts');
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
  } finally {
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run `pnpm install` from `.kici/`. pnpm walks up to the workspace root, so a
 * `workspace:` sibling in the same cloned repo resolves. Uses an isolated store
 * (`--config.store-dir`) for cross-job isolation, `package-import-method=copy`
 * so the on-disk store is a self-contained tree of real files (a later dep
 * cache tars it), and disables interactive purge prompts + the side-effects
 * cache for deterministic, non-interactive runs.
 */
async function runPnpmInstall(args: {
  kiciDir: string;
  hasPrivateRegistry: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
}): Promise<void> {
  await assertPnpmAvailable();
  const { nodeDir } = resolveNpm();
  const storeDir = await mkdtemp(join(tmpdir(), 'kici-pnpm-store-'));
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir);

  const argv = [
    'install',
    `--config.store-dir=${storeDir}`,
    '--config.package-import-method=copy',
    '--config.confirm-modules-purge=false',
    '--config.side-effects-cache=false',
    // A `.kici/` package pulls dependencies with build scripts (protobufjs, via
    // the OpenTelemetry gRPC exporters in `@kici-dev/shared`); pnpm 10+ would
    // otherwise exit non-zero on the unapproved build even though the install
    // succeeded. The workflow package never needs those build scripts.
    PNPM_IGNORE_BUILD_GATE_ARG,
  ];
  if (args.hasPrivateRegistry) argv.push('--ignore-scripts');

  try {
    process.stderr.write(`[dep-installer:trace] running: pnpm ${argv.join(' ')}\n`);
    await execFileAsync('pnpm', argv, {
      cwd: args.kiciDir,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } finally {
    await rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pure: argv for `yarn install` with an isolated cache folder. */
export function buildYarnInstallArgs(cacheDir: string, hasPrivateRegistry: boolean): string[] {
  const a = ['install', '--cache-folder', cacheDir, '--non-interactive', '--no-progress'];
  if (hasPrivateRegistry) a.push('--ignore-scripts');
  return a;
}

/**
 * Run `yarn install` from `.kici/` with an isolated cache folder. yarn classic
 * reads the synthesized `.kici/.npmrc` (registry + `${VAR}` token expansion) for
 * private-registry auth. A workspace member hoists deps to the repo-root
 * node_modules; a standalone `.kici` gets `.kici/node_modules`. Not
 * `--frozen-lockfile` (resolved URLs in the lockfile may point at a different
 * registry than the synthesized `.npmrc`, e.g. localhost tunnel vs direct IP).
 */
async function runYarnInstall(args: {
  kiciDir: string;
  hasPrivateRegistry: boolean;
  registryConfig: ApplyNpmRegistryConfigResult;
}): Promise<void> {
  await assertYarnAvailable();
  const { nodeDir } = resolveNpm();
  const cacheDir = await mkdtemp(join(tmpdir(), 'kici-yarn-cache-'));
  const env = envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir);
  const argv = buildYarnInstallArgs(cacheDir, args.hasPrivateRegistry);

  try {
    process.stderr.write(`[dep-installer:trace] running: yarn ${argv.join(' ')}\n`);
    await execFileAsync('yarn', argv, {
      cwd: args.kiciDir,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
    });
  } finally {
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pure: argv for a berry `yarn install`. Cache + linker live in .yarnrc.yml. */
export function buildYarnBerryInstallArgs(): string[] {
  return ['install'];
}

/**
 * Run a berry `yarn install` from `.kici/`. The synthesized `.kici/.yarnrc.yml`
 * (applied by `applyYarnrcBerryConfig`) forces `nodeLinker: node-modules`, an
 * isolated `cacheFolder`, and — when a private registry is configured —
 * `enableScripts: false` + `npmScopes`/`npmRegistryServer` auth. corepack
 * provisions the repo-pinned berry version; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
 * makes that non-interactive. Not `--immutable` (resolved URLs in the lockfile
 * may point at a different registry than the synthesized config).
 */
async function runYarnBerryInstall(args: {
  kiciDir: string;
  registryConfig: ApplyNpmRegistryConfigResult;
}): Promise<void> {
  await assertYarnAvailable();
  const { nodeDir } = resolveNpm();
  const env = {
    ...envWithNodeOnPath(args.registryConfig.extraEnv, nodeDir),
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
    // Probe from a neutral cwd (no enclosing `packageManager` field). When the
    // agent runs from a tree whose package.json pins a different manager via
    // corepack, the `yarn` shim refuses with "configured to use <other>" — that
    // is a false negative, not a missing yarn.
    await execFileAsync('yarn', ['--version'], { timeout: 30_000, cwd: tmpdir() });
  } catch (e) {
    throw new Error(
      'This repository uses yarn, but yarn is not available on this agent. ' +
        'Install yarn (e.g. `corepack enable`) or run on a container/Firecracker ' +
        `agent that bundles it. (${toErrorMessage(e)})`,
    );
  }
}

/**
 * Build the in-repo workspace siblings `.kici` depends on (yarn links them on
 * install but does not build them). Walks siblings from the resolved
 * node_modules root and runs each sibling's `build` script in leaf-first
 * (reverse-discovery) order with a clean env (no synthesized registry tokens).
 * Deep cross-sibling build chains may build out of strict topological order —
 * real `.kici` closures are shallow.
 */
async function buildYarnWorkspaceClosure(
  repoRoot: string,
  kiciDir: string,
  yarnFlavor: YarnFlavor,
): Promise<void> {
  const nmRoot = resolveYarnNodeModulesRoot(repoRoot, kiciDir);
  const siblings = await collectInRepoSiblings(repoRoot, kiciDir, nmRoot);
  if (siblings.length === 0) return;
  const { nodeDir } = resolveNpm();
  const env = envWithNodeOnPath({}, nodeDir);
  for (const rel of [...siblings].reverse()) {
    const sibDir = join(repoRoot, rel);
    if (!(await siblingHasBuildScript(sibDir))) continue;
    // classic supports the global `--cwd` flag; berry dropped it, so run from
    // the member dir instead. Both build that single member's `build` script.
    const [argv, cwd]: [string[], string] =
      yarnFlavor === YarnFlavor.Berry
        ? [['run', 'build'], sibDir]
        : [['--cwd', sibDir, 'run', 'build'], repoRoot];
    process.stderr.write(
      `[dep-installer:trace] building yarn sibling (${yarnFlavor}): yarn ${argv.join(' ')} @ ${cwd}\n`,
    );
    try {
      await execFileAsync('yarn', argv, {
        cwd,
        env,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: INSTALL_MAX_BUFFER,
      });
    } catch (e) {
      logSubprocessStreams(e, []);
      throw new Error(
        `Failed to build .kici yarn workspace sibling ${rel}: ${describeExecError(e)}`,
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
 * Build the in-repo dependency closure of the `.kici/` package so a
 * `workspace:` sibling's build output exists before the workflow that imports
 * it loads. `--filter "{.kici}^..."` selects only `.kici`'s dependencies (not
 * `.kici` itself); `run --if-present build` skips siblings without a build
 * script. The `--if-present` flag MUST precede the script name: pnpm forwards
 * everything after the script name to the script itself, so `run build
 * --if-present` would pass `--if-present` to the build command (e.g. `tsc`)
 * and fail. Runs with a clean env (no synthesized registry tokens). On failure
 * the subprocess stderr/stdout is folded into the thrown error so the job's
 * failure message names the real cause instead of a bare "Command failed".
 */
async function buildWorkspaceClosure(repoRoot: string): Promise<void> {
  const { nodeDir } = resolveNpm();
  const env = envWithNodeOnPath({}, nodeDir);
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

/** Build a single-line cause from an exec error's stderr/stdout, falling back to its message. */
function describeExecError(e: unknown): string {
  const pick = (k: 'stderr' | 'stdout'): string =>
    e && typeof e === 'object' && k in e ? String((e as Record<string, unknown>)[k]).trim() : '';
  const detail = pick('stderr') || pick('stdout');
  return (detail || toErrorMessage(e)).slice(0, 2000);
}

/** Throw an actionable error when the repo needs pnpm but it is not installed. */
async function assertPnpmAvailable(): Promise<void> {
  try {
    // Probe from a neutral cwd — see the note in assertYarnAvailable: an
    // enclosing `packageManager` field would make the corepack shim refuse.
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
