/**
 * Install a container job's `.kici/` dependencies on the agent host, into the
 * tree it copies into the container, so the runner finds `.kici/node_modules`
 * and skips its own install. Without a dependency cache, the in-container
 * install fails when the registry is reachable from the host only (private, or
 * resolved only by the host's `/etc/hosts`).
 *
 * It runs only when nothing it does can run repository code on the host:
 *
 * - Lifecycle scripts are disabled (`KICI_ALLOW_INSTALL_SCRIPTS` unset).
 * - The checkout passes the `host-install-eligibility.ts` allowlist: plain npm
 *   or pnpm, registry-only deps, no workspace, pnpm hooks, yarn or symlinked
 *   manifest.
 * - The agent has its own npm (new enough to refuse git deps; `lookupHostNpm`)
 *   or the pinned pnpm; `host-isolated-install.ts` runs it away from the
 *   checkout with a sanitized `.npmrc` and environment.
 * - An npm too old to refuse URL and file sources runs `npm ci`, only with a
 *   lockfile that pins every package (`host-install-lockfile.ts`).
 *
 * Host-built modules load in the container only with an injected KiCI runtime
 * (`KICI_RUNTIME_NODE_SOURCE` / `KICI_RUNTIME_IMAGE`): preflight admits glibc
 * images only and the container shares the host's architecture, so host-resolved
 * platform packages match. An image's own `node` may be musl or another Node
 * version, so its install stays in the container.
 */

import { join } from 'node:path';
import type { JobDispatch } from '@kici-dev/engine';
import type {
  HostInstallEligibility,
  HostInstallPlan,
  HostInstallRefused,
} from './host-install-eligibility.js';
import type { HostInstallTool, RunHostInstallArgs } from './host-isolated-install.js';
import { describeInstallFailure } from './install-failure.js';
import { redactNpmOutput, type NpmRegistrySpec } from './npm-registry-config.js';

/**
 * Step index of the workflow-level log: setup lines belonging to no step, the
 * runner's own clone / install / module-load lines included.
 */
export const WORKFLOW_LOG_STEP_INDEX = -1;

const LOG_PREFIX = '[host-install]';

/** What the host does with a container job's `.kici/` install. */
export enum HostDepsInstall {
  /** Installed on the host; the runner skips its own install. */
  Install = 'install',
  /** The dispatch carries a dependency cache the runner restores. */
  DepsFromCache = 'deps-from-cache',
  /** The workflow repo has no `.kici/package.json`. */
  NoKiciPackage = 'no-kici-package',
  /** `.kici/node_modules` already exists, so the runner would skip too. */
  AlreadyInstalled = 'already-installed',
  /** The agent allows lifecycle scripts, which must not run on the host. */
  InstallScriptsAllowed = 'install-scripts-allowed',
  /** No runtime is injected, so the image's own Node loads the modules. */
  ImageSuppliesNode = 'image-supplies-node',
  /** The checkout is outside the host-install allowlist. */
  NotHostSafe = 'not-host-safe',
  /** The agent has no pinned package manager of its own for this project. */
  PackageManagerUnavailable = 'package-manager-unavailable',
}

/** The facts the decision reads, gathered by {@link installKiciDepsOnHost}. */
export interface HostDepsInstallFacts {
  hasDepsUrl: boolean;
  hasKiciPackage: boolean;
  hasNodeModules: boolean;
  allowInstallScripts: boolean;
  runtimeInjected: boolean;
  /** The checkout passed `checkHostInstallEligibility`. */
  hostSafe: boolean;
  /** The agent resolved its own npm / pnpm for the project's manager. */
  toolAvailable: boolean;
}

/**
 * `DepsFromCache`, `NoKiciPackage` and `AlreadyInstalled` mean the runner would
 * not install either; every other non-`Install` outcome leaves it to the container.
 */
export function decideHostDepsInstall(facts: HostDepsInstallFacts): HostDepsInstall {
  if (facts.hasDepsUrl) return HostDepsInstall.DepsFromCache;
  if (!facts.hasKiciPackage) return HostDepsInstall.NoKiciPackage;
  if (facts.hasNodeModules) return HostDepsInstall.AlreadyInstalled;
  // fails-when: an agent with KICI_ALLOW_INSTALL_SCRIPTS=true reaches the host
  // install, so a dependency's postinstall runs outside the job container.
  // breaks-if-wrong: the default agent (scripts disabled) must still install on
  // the host — covered by the `Install` case in the unit tests.
  if (facts.allowInstallScripts) return HostDepsInstall.InstallScriptsAllowed;
  // fails-when: an agent with no injected runtime installs on the host, so a
  // musl image's own node loads glibc-resolved platform packages.
  // breaks-if-wrong: an agent with KICI_RUNTIME_IMAGE or
  // KICI_RUNTIME_NODE_SOURCE set must still install on the host.
  if (!facts.runtimeInjected) return HostDepsInstall.ImageSuppliesNode;
  // fails-when: a checkout carrying a pnpmfile, a yarn setup, a workspace or a
  // git dependency is installed on the host, where that code would run.
  // breaks-if-wrong: a plain registry-only npm project must still pass.
  if (!facts.hostSafe) return HostDepsInstall.NotHostSafe;
  if (!facts.toolAvailable) return HostDepsInstall.PackageManagerUnavailable;
  return HostDepsInstall.Install;
}

const LEFT_TO_CONTAINER: Partial<Record<HostDepsInstall, string>> = {
  [HostDepsInstall.InstallScriptsAllowed]:
    'Install scripts are allowed on this agent, so the job container installs the .kici dependencies',
  [HostDepsInstall.ImageSuppliesNode]:
    'No KiCI runtime is injected, so the job container installs the .kici dependencies for its own Node',
};

/** The secrets a host install line or error may echo: registry tokens and install secrets. */
export function hostInstallSecrets(
  dispatch: Pick<JobDispatch, 'npmRegistries' | 'installEnvSecrets'>,
): string[] {
  return [
    ...(dispatch.npmRegistries ?? []).map((r) => r.token),
    ...Object.values(dispatch.installEnvSecrets ?? {}),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export interface InstallKiciDepsOnHostArgs {
  /** The checkout that carries `.kici/` — the workflow repo for a global job. */
  workflowDir: string;
  dispatch: Pick<JobDispatch, 'jobId' | 'depsUrl' | 'npmRegistries' | 'installEnvSecrets'>;
  /** Agent config `allowInstallScripts`. */
  allowInstallScripts: boolean;
  /** Whether the agent injects its runtime into the job container. */
  runtimeInjected: boolean;
  /** The agent's sanitized environment; the install reads only locale, temp and PATH. */
  baseEnv: NodeJS.ProcessEnv;
  log: (line: string) => void;
  signal?: AbortSignal;
  fileExists: (path: string) => Promise<boolean>;
  /**
   * Workflow-declared registries must be on operator-allowed origins, or the
   * container installs instead, so their tokens reach the host install only for
   * an allowed registry host.
   */
  checkEligibility: (
    workflowDir: string,
    workflowRegistries: readonly NpmRegistrySpec[],
  ) => Promise<HostInstallEligibility>;
  resolveTool: (pm: HostInstallPlan['packageManager']) => Promise<HostInstallTool | null>;
  /**
   * Refuses an install the tool cannot keep on the allowed registries (an
   * `npm ci` npm needs a fully pinned lockfile); `null` allows it.
   */
  checkLockedInstall: (
    kiciDir: string,
    plan: HostInstallPlan,
    tool: HostInstallTool,
  ) => Promise<HostInstallRefused | null>;
  runInstall: (args: RunHostInstallArgs) => Promise<void>;
}

function refusedLine(refused: HostInstallRefused): string {
  return (
    `${LOG_PREFIX} The .kici install cannot run on the agent host (${refused.refusal}: ` +
    `${refused.detail}), so the job container installs the .kici dependencies`
  );
}

/** Evaluates the checkout and tooling once the cheap guards allow an install. */
async function resolveHostInstall(
  args: InstallKiciDepsOnHostArgs,
  say: (line: string) => void,
): Promise<{ plan: HostInstallPlan; tool: HostInstallTool } | HostDepsInstall> {
  const eligibility = await args.checkEligibility(
    args.workflowDir,
    args.dispatch.npmRegistries ?? [],
  );
  if (!eligibility.eligible) {
    say(refusedLine(eligibility));
    return HostDepsInstall.NotHostSafe;
  }
  const tool = await args.resolveTool(eligibility.plan.packageManager);
  if (!tool) {
    say(
      `${LOG_PREFIX} The agent has no pinned ${eligibility.plan.packageManager} of its own, ` +
        'so the job container installs the .kici dependencies',
    );
    return HostDepsInstall.PackageManagerUnavailable;
  }
  // fails-when: an npm without --allow-remote installs a project whose
  // lockfile leaves a dependency open, fetching a URL dependency from the host.
  // breaks-if-wrong: a tool this check does not apply to, or a lockfile that
  // pins every package, still installs on the host.
  const locked = await args.checkLockedInstall(
    join(args.workflowDir, '.kici'),
    eligibility.plan,
    tool,
  );
  if (locked) {
    say(refusedLine(locked));
    return HostDepsInstall.NotHostSafe;
  }
  return { plan: eligibility.plan, tool };
}

/**
 * Install on the host when {@link decideHostDepsInstall} says so. Every line is
 * redacted of registry tokens and install secrets. A failure is logged and
 * rethrown, redacted, so the job fails with the installer's error instead of
 * retrying in the container.
 */
export async function installKiciDepsOnHost(
  args: InstallKiciDepsOnHostArgs,
): Promise<HostDepsInstall> {
  const secrets = hostInstallSecrets(args.dispatch);
  const redact = (text: string) => redactNpmOutput(text, secrets);
  const say = (line: string) => args.log(redact(line));
  const kiciDir = join(args.workflowDir, '.kici');
  const early = decideHostDepsInstall({
    hasDepsUrl: Boolean(args.dispatch.depsUrl),
    hasKiciPackage: await args.fileExists(join(kiciDir, 'package.json')),
    hasNodeModules: await args.fileExists(join(kiciDir, 'node_modules')),
    allowInstallScripts: args.allowInstallScripts,
    runtimeInjected: args.runtimeInjected,
    hostSafe: true,
    toolAvailable: true,
  });
  const leftToContainer = LEFT_TO_CONTAINER[early];
  if (leftToContainer) say(`${LOG_PREFIX} ${leftToContainer}`);
  if (early !== HostDepsInstall.Install) return early;

  const resolved = await resolveHostInstall(args, say);
  if (typeof resolved === 'string') return resolved;

  say(
    `${LOG_PREFIX} Installing .kici dependencies on the agent host with ` +
      `${resolved.tool.packageManager} ${resolved.tool.version}`,
  );
  try {
    await args.runInstall({
      kiciDir,
      plan: resolved.plan,
      tool: resolved.tool,
      registries: args.dispatch.npmRegistries ?? [],
      installEnvSecrets: args.dispatch.installEnvSecrets ?? {},
      jobIdShort: args.dispatch.jobId.slice(0, 8),
      baseEnv: args.baseEnv,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (err) {
    // Redact before the output is cut to its end, so a cut never leaves part of a token.
    const message = describeInstallFailure(err, secrets);
    say(`${LOG_PREFIX} [error] ${message}`);
    // fails-when: the raw error (whose text carries the installer's stderr) is
    // rethrown, so a registry token it echoes reaches job.status.error.
    throw new Error(message);
  }
  say(`${LOG_PREFIX} Dependencies installed`);
  return HostDepsInstall.Install;
}
