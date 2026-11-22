import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { formatBytes, logger, toErrorMessage } from '@kici-dev/core';
import type { TempHandle } from '@kici-dev/core/tmp';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import {
  parseInputPairs,
  coerceDispatchInputs,
  type HostTargetSelector,
  type InputsDescriptorMap,
} from '@kici-dev/engine';
import { resolveKiciDir } from '../execution/index.js';
import { loadGlobalConfig, type GlobalConfig } from '../remote/config.js';
import {
  PlatformRunClient,
  AmbiguousClusterError,
  NoClusterError,
  AuthenticationError,
  AccessDeniedError,
  ConnectionError,
  type PlatformTriggerInput,
  type PlatformTriggerResponse,
} from '../remote/platform-client.js';
import { DirectRunClient } from '../remote/direct-client.js';
import {
  createDirectTransport,
  createPlatformTransport,
  type RunRemoteTransport,
} from '../remote/run-transport.js';
import { resolveRunTarget } from '../remote/target.js';
import { compileFixtures, filterFixtures, type CompiledFixture } from '../fixtures/compiler.js';
import { describeEvent } from '../fixtures/describe-event.js';
import {
  buildFixtureEvent,
  currentBranchFallback,
  FALLBACK_BRANCH,
  type FixtureEvent,
  type GitHead,
} from '../fixtures/event.js';
import type { FixtureOptions } from '@kici-dev/sdk';
import { detectCurrentBranch } from '../test-runner/git-detector.js';
import { runFixturePicker, FixturePickerCancelledError } from '../fixtures/picker.js';
import { createOverlayTarball, gcStaleOverlayDirs, getSizeWarning } from '../remote/uploader.js';
import type { ShippedGit } from '../remote/shipped-git/git-ship-types.js';
import { validateSyntheticTagName } from '../remote/shipped-git/synthetic-commit.js';
import { buildOverlayReport } from '../remote/overlay-report.js';
import { computeRemoteChangedFiles } from '../remote/remote-changed-files.js';
import {
  describeGitShipment,
  resolveGitShipRequirement,
  type GitShipRequirement,
} from '../remote/git-ship-requirement.js';
import { formatMultiFixtureSummary, type RunResult } from '../remote/output/summary.js';
import { formatJsonResult } from '../remote/output/json.js';
import { formatJunitResult } from '../remote/output/junit.js';
import { RunHistory } from '../remote/history.js';
import { buildEncryptedSecrets } from '../remote/secret-upload.js';
import { buildLocalRepoIdentity } from '../remote/local-repo-identity.js';
import { compileCommand } from './compile.js';
import { followRuns, type FollowedRun } from './run-remote-follow.js';
import type { OverlayReport, RemoteRunOptions, RemoteRunResult } from './preview.js';
import type { RemoteGitCliFlags } from './remote-git-flags.js';

/** One run per matched workflow, or the single `runId` of an orchestrator that predates `runs`. */
function triggeredRuns(response: PlatformTriggerResponse): FollowedRun[] {
  if (response.runs?.length) {
    return response.runs.map((r) => ({ runId: r.runId, workflowName: r.workflowName }));
  }
  return [{ runId: response.runId }];
}

/** `Run started: <id>`, naming the workflow when the server did. */
function runStartedLine(run: FollowedRun): string {
  return `Run started: ${run.runId}${run.workflowName ? ` (${run.workflowName})` : ''}`;
}

/**
 * Each `--target` string becomes its own include set; repeated values AND-combine.
 * Throws when `--target-allow-empty` is set without a `--target`.
 */
export function buildTargetSelector(
  targets: string[] | undefined,
  allowEmpty: boolean,
): HostTargetSelector | undefined {
  if (!targets || targets.length === 0) {
    if (allowEmpty) {
      throw new Error('--target-allow-empty requires at least one --target selector');
    }
    return undefined;
  }
  return {
    values: targets.map((t) => normalizeRunsOnToMatchers(t, 'kici run --target')),
    allowEmpty,
  };
}

/**
 * Without `workflowName`, merges every workflow's dispatch `inputs` descriptors: a best-effort
 * fast-fail, since the orchestrator re-validates against the matched workflow.
 */
export function lookupDispatchInputsDescriptor(
  inlineLockFile: string | undefined,
  workflowName: string | undefined,
): InputsDescriptorMap | undefined {
  if (!inlineLockFile) return undefined;
  let lock: { workflows?: { name: string; triggers?: { _type: string; inputs?: unknown }[] }[] };
  try {
    lock = JSON.parse(inlineLockFile);
  } catch {
    return undefined;
  }
  const merged: InputsDescriptorMap = {};
  let found = false;
  for (const wf of lock.workflows ?? []) {
    if (workflowName && wf.name !== workflowName) continue;
    for (const trigger of wf.triggers ?? []) {
      if (trigger._type === 'dispatch' && trigger.inputs) {
        Object.assign(merged, trigger.inputs as InputsDescriptorMap);
        found = true;
      }
    }
  }
  return found ? merged : undefined;
}

/**
 * The problem when `workflowName` is not in the compiled lock, listing those it has. Undefined
 * when it is, or when the lock does not parse (the orchestrator decides).
 */
export function describeMissingWorkflow(
  inlineLockFile: string,
  workflowName: string,
): string | undefined {
  let lock: { workflows?: { name: string }[] };
  try {
    lock = JSON.parse(inlineLockFile);
  } catch {
    return undefined;
  }
  const names = (lock.workflows ?? []).map((w) => w.name);
  if (names.includes(workflowName)) return undefined;
  const available = names.length
    ? `Available workflows: ${names.join(', ')}`
    : 'The lock file has no workflows';
  return `Workflow '${workflowName}' is not in the compiled lock file. ${available}.`;
}

/** Checks `--workflow` against the fresh lock before any upload; false after logging. */
async function checkWorkflowInLock(
  workflowName: string | undefined,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!workflowName) return true;
  const lockPath = path.join(resolveKiciDir(options.kiciDir), 'kici.lock.json');
  const problem = describeMissingWorkflow(await readFile(lockPath, 'utf-8'), workflowName);
  if (!problem) return true;
  logger.error(pc.red(problem));
  return false;
}

/**
 * Fast-fails on invalid `--input` pairs but returns the **raw** strings: the
 * orchestrator is authoritative and applies coercion and defaults exactly once.
 */
export function buildDispatchInputs(
  pairs: string[],
  descriptor: InputsDescriptorMap | undefined,
): Record<string, string> {
  if (!pairs.length) return {};
  const raw = parseInputPairs(pairs);
  if (descriptor) {
    const r = coerceDispatchInputs(raw, descriptor);
    if ('error' in r) throw r.error;
  }
  return raw;
}

/**
 * Compiling evaluates user modules, whose top-level `console.log` writes to stdout. A `--json`
 * stdout carries only the final JSON, so compile phases redirect stdout to stderr.
 */
export async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = realWrite;
  }
}

/**
 * The orchestrator matches triggers against the inline lock, so a stale one misroutes an
 * edited workflow. False on a compile error, before any upload or dispatch.
 */
async function compileBeforeRemoteRun(options: RemoteRunOptions): Promise<boolean> {
  // --json and --quiet stdout carries no compile lines and no module-level console.log.
  const pureStdout = Boolean(options.json || options.quiet);
  const compile = () =>
    compileCommand({
      kiciDir: options.kiciDir ?? '.kici',
      check: false,
      verbose: options.debug ?? false,
      quiet: pureStdout,
      warnMissingKiciManifest: true,
      // So the types refresh of a direct run never reaches a saved Platform login.
      orchestratorUrl: options.orchestratorUrl,
    });
  return pureStdout ? withStdoutOnStderr(compile) : compile();
}

/** Run fixtures remotely, through the Platform or straight to an orchestrator. */
export async function runRemoteCommand(
  fixture: string | undefined,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (options.debug) {
    process.env.KICI_DEBUG = 'true';
    if (!options.quiet) logger.info(pc.gray('Debug mode enabled'));
  }

  try {
    // Fail fast on an invalid selector, unsafe regex or glob, before any compile or dispatch.
    buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);
    // The CLI already checked each --tag; this covers a programmatic caller.
    for (const tag of options.git?.tags ?? []) validateSyntheticTagName(tag);

    // --history only reads local history, so it wins over every run selector.
    if (options.history) {
      const history = new RunHistory();
      await history.load();
      const entries = history.getEntries({ limit: 20 });
      console.log(history.formatTable(entries));
      return true;
    }

    if (options.workflow && !fixture && !options.all) {
      return await runDirectWorkflow(options.workflow, options);
    }

    const kiciDir = resolveKiciDir(options.kiciDir);

    const testsDir = path.join(kiciDir, 'tests');
    const fixtures = options.json
      ? await withStdoutOnStderr(() => compileFixtures(testsDir))
      : await compileFixtures(testsDir);

    let selected: CompiledFixture[];
    if (options.pick) {
      if (fixtures.length === 0) {
        return listFixtures(fixtures);
      }
      try {
        selected = await runFixturePicker(fixtures);
      } catch (err) {
        if (err instanceof FixturePickerCancelledError) {
          logger.info(pc.gray(err.message));
          return false;
        }
        throw err;
      }
    } else if (!fixture && !options.all) {
      return listFixtures(fixtures);
    } else if (options.all) {
      selected = fixtures;
    } else {
      selected = filterFixtures(fixtures, fixture!);
    }

    if (selected.length === 0) {
      logger.info(pc.yellow(`No fixtures matched: ${fixture ?? '(none)'}`));
      logger.info(pc.gray('Run `kici run remote` with no arguments to list available fixtures.'));
      return false;
    }

    return await runFixturesRemotely(selected, options);
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (options.debug && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

function listFixtures(fixtures: CompiledFixture[]): boolean {
  if (fixtures.length === 0) {
    logger.info(pc.yellow('No fixtures found.'));
    logger.info(pc.gray('Create fixture files in .kici/tests/ to get started.'));
    logger.info(
      pc.gray(
        'Example: export const pushMain = fixture("push-main", { event: push({ branches: ["main"] }) })',
      ),
    );
    return true;
  }

  logger.info(pc.bold('\nAvailable fixtures:\n'));

  const idWidth = Math.max(12, ...fixtures.map((f) => f.id.length)) + 2;
  const header = `  ${pc.bold('ID'.padEnd(idWidth))} ${pc.bold('Source'.padEnd(40))} ${pc.bold('Event type')}`;
  logger.info(header);
  logger.info(`  ${''.padEnd(idWidth, '-')} ${''.padEnd(40, '-')} ${''.padEnd(15, '-')}`);

  for (const f of fixtures) {
    const opts = typeof f.fixture.options === 'function' ? null : f.fixture.options;
    const eventType = opts?.event ? describeEvent(opts.event) : '(async)';
    const source = path.relative(process.cwd(), f.sourceFile);
    logger.info(`  ${pc.cyan(f.id.padEnd(idWidth))} ${pc.gray(source.padEnd(40))} ${eventType}`);
  }

  logger.info(pc.gray(`\n  ${fixtures.length} fixture(s) available`));
  logger.info(pc.gray('  Run: kici run remote <fixture-name> or kici run remote --all\n'));
  return true;
}

/** Write a warning line to stderr, so a `--json` stdout stays pure. */
function warnStderr(message: string): void {
  process.stderr.write(`${pc.yellow(message)}\n`);
}

function warnDeprecatedRunFlags(options: RemoteRunOptions): void {
  if (options.routingKey) {
    warnStderr(
      '--routing-key is deprecated and has no effect: the orchestrator chooses the routing key. It will be removed in v1.0.0.',
    );
  }
}

function warnIgnoredForDirect(options: RemoteRunOptions): void {
  const flags = [options.org && '--org', options.orchestrator && '--orchestrator'].filter(Boolean);
  warnStderr(
    `${flags.join(' and ')} ignored: a direct run goes to one orchestrator, and the orchestrator chooses the organization.`,
  );
}

/** A direct target runs `whoami` first: a token that cannot start runs stops before any upload. */
async function resolveRunContext(
  config: GlobalConfig,
  options: RemoteRunOptions,
): Promise<RunRemoteTransport | null> {
  warnDeprecatedRunFlags(options);
  const resolved = resolveRunTarget({ flagUrl: options.orchestratorUrl, env: process.env, config });
  if (!resolved.ok) {
    logger.error(pc.red(resolved.error));
    return null;
  }
  if (resolved.target.kind === 'platform') return resolvePlatformTransport(config, options);
  if (options.org || options.orchestrator) warnIgnoredForDirect(options);
  const client = new DirectRunClient({ url: resolved.target.url, token: resolved.target.token });
  const whoami = await client.whoami();
  if (!whoami.permissions.trigger) {
    logger.error(
      pc.red(
        `The token for ${client.url} has role ${whoami.role}, which cannot start runs. Use an owner or admin token.`,
      ),
    );
    return null;
  }
  return createDirectTransport({ client, whoami });
}

/**
 * Org: `--org` → `config.activeOrgId` → error. Cluster: `--orchestrator` →
 * `config.defaultClusters[orgId]` → omitted (the Platform sole-selects, or returns a 422).
 */
function resolvePlatformTransport(
  config: GlobalConfig,
  options: RemoteRunOptions,
): RunRemoteTransport | null {
  const token = config.pat;
  if (!token) {
    logger.error(pc.red('Not authenticated. Run `kici login` to authenticate.'));
    return null;
  }

  if (!config.platformEndpoint) {
    logger.error(
      pc.red('No Platform endpoint configured. Run `kici login` to set up your Platform.'),
    );
    return null;
  }

  const orgId = options.org ?? config.activeOrgId;
  if (!orgId) {
    logger.error(
      pc.red('No target organization. Select one with `kici org use <org>` or pass `--org <id>`.'),
    );
    return null;
  }

  const orchestrator = options.orchestrator;
  const defaultCluster = config.defaultClusters?.[orgId];

  return createPlatformTransport({
    client: new PlatformRunClient({ platformEndpoint: config.platformEndpoint, token }),
    orgId,
    target: { orchestrator, defaultCluster },
    endpoint: config.platformEndpoint,
    token,
  });
}

async function runFixturesRemotely(
  fixtures: CompiledFixture[],
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;
  if (!(await checkWorkflowInLock(options.workflow, options))) return false;

  const config = await loadGlobalConfig();
  const ctx = await resolveRunContext(config, options);
  if (!ctx) return false;

  // --json implies --quiet: only structured JSON goes to stdout.
  if (options.json) {
    options.quiet = true;
  }

  const history = new RunHistory();
  await history.load();

  if (!options.quiet) {
    for (const line of ctx.banner) logger.info(pc.gray(line));
    if (options.workflow) {
      logger.info(
        pc.gray(
          `Sending each fixture's event to workflow "${options.workflow}" only (bypassing triggers)`,
        ),
      );
    }
    logger.info(pc.gray(`Fixtures: ${fixtures.length} to run\n`));
  }

  const results: RemoteRunResult[] = [];

  if (options.parallel && fixtures.length > 1) {
    const promises = fixtures.map((f) => runSingleFixture(f, ctx, options, history));
    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        results.push({
          fixtureId: 'unknown',
          runId: '',
          status: 'error',
          reason: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  } else {
    for (const f of fixtures) {
      const result = await runSingleFixture(f, ctx, options, history);
      results.push(result);
      // Fail fast, and stop after a cancel: Ctrl-C ends the whole batch.
      if (
        result.status === 'failed' ||
        result.status === 'error' ||
        result.status === 'cancelled'
      ) {
        break;
      }
    }
  }

  return renderResults(results, options);
}

async function renderResults(
  results: RemoteRunResult[],
  options: RemoteRunOptions,
): Promise<boolean> {
  const runResults: RunResult[] = results
    .filter((r) => r.status === 'success' || r.status === 'failed' || r.status === 'cancelled')
    .map((r) => ({
      fixtureId: r.fixtureId,
      runId: r.runId,
      status: r.status as 'success' | 'failed' | 'cancelled',
      totalDurationMs: r.durationMs ?? 0,
      jobs: r.jobs ?? [],
      ...(r.runs && { runs: r.runs }),
      ...(r.overlay && { overlay: r.overlay }),
    }));

  if (options.json) {
    console.log(formatJsonResult(runResults));
  } else if (options.junit) {
    const junitXml = formatJunitResult(runResults);
    await writeFile(options.junit, junitXml);
    if (!options.quiet) {
      logger.info(pc.green(`JUnit XML written to ${options.junit}`));
    }
  } else if (
    !options.quiet ||
    results.some((r) => r.status !== 'success' && r.status !== 'accepted')
  ) {
    if (runResults.length > 1) {
      logger.info(formatMultiFixtureSummary(runResults));
    } else {
      displayRemoteResults(results);
    }
  }

  return results.every((r) => r.status === 'accepted' || r.status === 'success');
}

/** The repository the overlay ships: the parent of the `.kici` directory. */
function overlayRepoRoot(options: RemoteRunOptions): string {
  return path.resolve(resolveKiciDir(options.kiciDir), '..');
}

/** A programmatic caller without `git` gets what the CLI does without the flags; a fresh object per run. */
function defaultGitFlags(): RemoteGitCliFlags {
  return { commit: true, tags: [] };
}

/** The status, `Git:` and `Workspace commit:` lines, and one line per replaced tag. */
function logShippedGit(
  options: RemoteRunOptions,
  requirement: GitShipRequirement,
  git: ShippedGit | undefined,
): void {
  if (!options.quiet) {
    // No `.git` when `.kici` is below the repository top level; a warning says so.
    if (!git) {
      logger.info(
        pc.gray('Running your local working tree (no .git ships, so git steps see no repository)'),
      );
    } else {
      logger.info(pc.gray('Running your local working tree over a checkout of your repository'));
      logger.info(pc.gray(describeGitShipment(requirement)));
      logger.info(
        pc.gray(
          git.synthetic
            ? `Workspace commit: ${git.workspaceSha} (synthetic commit over HEAD ${git.baseSha})`
            : `Workspace commit: ${git.workspaceSha} (HEAD)`,
        ),
      );
    }
  }
  for (const name of git?.replacedTags ?? []) {
    const line = `Tag '${name}' replaces the tag of that name from your repository in the remote workspace.`;
    // Quiet and --json stdout carry no status lines, but a replaced tag changes what the job sees.
    if (options.quiet) warnStderr(line);
    else logger.info(pc.yellow(line));
  }
}

/**
 * The full local working tree with the compiled lock inlined: a relayed run never clones, and
 * the `remote:<orgId>` anchor has no provider to fetch a lock or base tree from. The shipped
 * `.git` has the history and tags `scope`'s jobs ask for (each git flag overrides its
 * dimension), the uncommitted changes as a synthetic commit unless `--no-commit`, and each `--tag`.
 */
async function prepareOverlay(
  options: RemoteRunOptions,
  scope: { workflowName?: string; event?: FixtureEvent },
): Promise<{
  tarballPath: string;
  summary: Awaited<ReturnType<typeof createOverlayTarball>>['summary'];
  hasRemote: boolean;
  inlineLockFile: string;
  kiciDir: string;
  repoRoot: string;
  report: OverlayReport;
  git?: ShippedGit;
  /** Holds the tarball and the shipped repository: `thenRemoveOverlay` removes it. */
  tempDir: TempHandle;
}> {
  const kiciDir = resolveKiciDir(options.kiciDir);
  const repoRoot = overlayRepoRoot(options);

  // The local compiled lock is the authority on either transport, and sizes the shipped history.
  const inlineLockFile = await readFile(path.join(kiciDir, 'kici.lock.json'), 'utf-8');
  const flags = options.git ?? defaultGitFlags();
  const requirement = resolveGitShipRequirement({
    inlineLockFile,
    workflowName: scope.workflowName,
    event: scope.event,
    flags,
  });

  await gcStaleOverlayDirs().catch((err: unknown) =>
    warnStderr(`Could not clean up old overlay temp dirs: ${toErrorMessage(err)}`),
  );

  if (!options.quiet) {
    logger.info(pc.gray('Creating overlay tarball...'));
  }

  // The agent has no base tree, so the full selection is forced even with a git remote. The
  // commit message and author pass through raw: the builder applies the defaults.
  const { tarballPath, summary, hasRemote, warnings, git, tempDir } = await createOverlayTarball(
    repoRoot,
    {
      fullWorkingTree: true,
      git: {
        depth: requirement.depth,
        tags: requirement.tags,
        commit: flags.commit,
        ...(flags.commitMessage !== undefined && { commitMessage: flags.commitMessage }),
        ...(flags.commitAuthor && { commitAuthor: flags.commitAuthor }),
        syntheticTags: flags.tags,
      },
    },
  );
  try {
    reportOverlay(options, { summary, warnings, requirement, git });
  } catch (err) {
    await tempDir.cleanup();
    throw err;
  }

  return {
    tarballPath,
    summary,
    hasRemote,
    inlineLockFile,
    kiciDir,
    repoRoot,
    report: buildOverlayReport(summary, requirement, git),
    ...(git && { git }),
    tempDir,
  };
}

/** Print what the overlay holds and ships. */
function reportOverlay(
  options: RemoteRunOptions,
  overlay: {
    summary: Awaited<ReturnType<typeof createOverlayTarball>>['summary'];
    warnings: string[];
    requirement: GitShipRequirement;
    git: ShippedGit | undefined;
  },
): void {
  const { summary, warnings, requirement, git } = overlay;
  // Warnings name paths the remote workspace lacks; stderr keeps --json stdout parseable.
  for (const warning of warnings) process.stderr.write(`${pc.yellow(`⚠ ${warning}`)}\n`);

  logShippedGit(options, requirement, git);

  if (!options.quiet) {
    logger.info(
      pc.gray(
        `${summary.fileCount} files changed, ${summary.newFiles} new, ${summary.deletedFiles} deleted (${formatBytes(summary.compressedSize)} compressed)`,
      ),
    );
    const sizeWarning = getSizeWarning(summary.compressedSize);
    if (sizeWarning) {
      logger.info(pc.yellow(sizeWarning));
    }
  }
}

/** The branch and commit the overlay was built from: the defaults for the run's event. */
function localGitHead(overlay: { repoRoot: string; summary: { sha: string } }): GitHead {
  return { branch: detectCurrentBranch(overlay.repoRoot), sha: overlay.summary.sha };
}

/** The trigger fields of an uploaded overlay, shared by fixture runs and `--workflow` runs. */
async function overlayTriggerFields(
  overlay: Awaited<ReturnType<typeof prepareOverlay>>,
  uploaded: { uploadId: string; publicKey: string; cliPublicKey: string },
  workflowName: string | undefined,
  options: RemoteRunOptions,
): Promise<Omit<PlatformTriggerInput, 'fixtureId' | 'event'>> {
  const encrypted = await buildEncryptedSecrets(
    overlay.kiciDir,
    options.envFlags,
    options.context,
    uploaded.publicKey,
  );
  const target = buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);
  const descriptor = lookupDispatchInputsDescriptor(overlay.inlineLockFile, workflowName);
  const dispatchInputs = buildDispatchInputs(options.inputs ?? [], descriptor);
  return {
    uploadId: uploaded.uploadId,
    // Overlay-tarball key, required to decrypt the overlay (independent of secrets).
    cliPublicKey: uploaded.cliPublicKey,
    ...(encrypted && {
      encryptedSecrets: encrypted.encryptedSecrets,
      encryptedSecretsKey: encrypted.cliPublicKey,
    }),
    workflowName,
    inlineLockFile: overlay.inlineLockFile,
    // The overlay carries the complete working tree; a relayed run never clones.
    fullRepo: true,
    ...(options.checkMode && { checkMode: options.checkMode }),
    ...(target && { target }),
    ...(Object.keys(dispatchInputs).length > 0 && { dispatchInputs }),
  };
}

/** Inits the upload (control plane), then PUTs the encrypted tarball straight to the object store (data plane). */
async function initAndUpload(
  ctx: RunRemoteTransport,
  overlay: Awaited<ReturnType<typeof prepareOverlay>>,
  options: RemoteRunOptions,
): Promise<{ uploadId: string; publicKey: string; cliPublicKey: string }> {
  if (!options.quiet) {
    logger.info(pc.gray('Initializing upload...'));
  }

  const upload = await ctx.initUpload({
    sha: overlay.summary.sha,
    fileCount: overlay.summary.fileCount,
    compressedSize: overlay.summary.compressedSize,
  });

  if (!options.quiet) {
    logger.info(pc.gray('Uploading overlay...'));
  }

  const uploadResult = await ctx.uploadTarball({
    tarballPath: overlay.tarballPath,
    signedUrl: upload.signedUrl,
    orchestratorPublicKey: Buffer.from(upload.publicKey, 'base64'),
  });

  return {
    uploadId: upload.uploadId,
    publicKey: upload.publicKey,
    cliPublicKey: uploadResult.cliPublicKey.toString('base64'),
  };
}

/**
 * A fixture's event: branch and commit default to `head`; the repository is the origin
 * `owner/repo` and provider, else a synthetic `local/<repo>`, so no external link breaks.
 */
function buildRemoteFixtureEvent(
  fixtureId: string,
  opts: FixtureOptions,
  head: GitHead,
  repoRoot: string,
): FixtureEvent {
  const fallback = head.branch ? undefined : currentBranchFallback(opts);
  if (fallback) {
    warnStderr(
      `HEAD is detached, so fixture ${fixtureId} uses branch '${fallback}' in place of the current branch.`,
    );
  }
  const event = buildFixtureEvent(opts, head);
  const identity = buildLocalRepoIdentity(repoRoot);
  const repo = event.payload.repository as Record<string, unknown> | undefined;
  event.payload.repository = {
    ...(repo ?? {}),
    full_name: identity.repoIdentifier,
    provider: identity.provider,
  };
  return event;
}

/**
 * A fixture's remote-run event: the workspace commit (synthetic when dirty), a push's `before`
 * its parent, and changed files from local history when a `.git` ships (with the uncommitted
 * changes under `--no-commit`); without one, no list and the agent decides.
 */
function buildRemoteRunEvent(
  fixtureId: string,
  opts: FixtureOptions,
  branch: string | undefined,
  overlay: Awaited<ReturnType<typeof prepareOverlay>>,
): FixtureEvent {
  const { git } = overlay;
  const parent = git?.parentSha ? { parentSha: git.parentSha } : {};
  const event = buildRemoteFixtureEvent(
    fixtureId,
    opts,
    { branch, sha: git?.workspaceSha ?? overlay.summary.sha, ...parent },
    overlay.repoRoot,
  );
  if (git) {
    const { files, warning } = computeRemoteChangedFiles({
      repoRoot: overlay.repoRoot,
      shipRoot: git.root,
      event,
      workspaceSha: git.workspaceSha,
      ...parent,
      ...(git.uncommittedPaths && { uncommittedPaths: git.uncommittedPaths }),
    });
    if (files) event.changedFiles = files;
    if (warning) warnStderr(warning);
  }
  return event;
}

/** Run `fn`, then always remove the overlay temp dir (tarball, and a full history at depth 0). */
async function thenRemoveOverlay<T>(
  overlay: { tempDir: TempHandle },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    await overlay.tempDir.cleanup();
  }
}

async function runSingleFixture(
  fixture: CompiledFixture,
  ctx: RunRemoteTransport,
  options: RemoteRunOptions,
  history: RunHistory,
): Promise<RemoteRunResult> {
  const opts =
    typeof fixture.fixture.options === 'function'
      ? await fixture.fixture.options()
      : fixture.fixture.options;

  if (!options.quiet) {
    logger.info(pc.cyan(`\n--- ${fixture.id} ---`));
  }

  // `--workflow` wins over a workflow the fixture names.
  if (options.workflow && opts.workflowName && opts.workflowName !== options.workflow) {
    warnStderr(
      `fixture ${fixture.id} names workflow '${opts.workflowName}'; running '${options.workflow}' as --workflow asks.`,
    );
  }
  const workflowName = options.workflow ?? opts.workflowName;

  // Every result returned once the overlay exists carries its report.
  let report: OverlayReport | undefined;
  const withOverlay = (result: RemoteRunResult): RemoteRunResult =>
    report ? { ...result, overlay: report } : result;

  try {
    const branch = detectCurrentBranch(overlayRepoRoot(options));
    // The named workflow's jobs, else every matched workflow's, size the shipped .git.
    const overlay = await prepareOverlay(options, {
      workflowName,
      event: buildFixtureEvent(opts, { branch }),
    });
    report = overlay.report;
    const { event, uploaded } = await thenRemoveOverlay(overlay, async () => ({
      event: buildRemoteRunEvent(fixture.id, opts, branch, overlay),
      uploaded: await initAndUpload(ctx, overlay, options),
    }));

    if (!options.quiet) {
      logger.info(pc.gray('Triggering test run...'));
    }

    const triggerResult = await ctx.trigger({
      fixtureId: fixture.id,
      event,
      secrets: opts.secrets,
      ...(await overlayTriggerFields(overlay, uploaded, workflowName, options)),
      // This CLI follows every run, so each matched workflow gets its own.
      acceptsMultipleRuns: true,
    });

    if (triggerResult.status === 'rejected') {
      if (!options.quiet) {
        logger.info(pc.red(`Rejected: ${triggerResult.reason ?? 'unknown reason'}`));
      }
      return withOverlay({
        fixtureId: fixture.id,
        runId: triggerResult.runId,
        status: 'rejected',
        reason: triggerResult.reason,
      });
    }

    const runs = triggeredRuns(triggerResult);
    if (!options.quiet) {
      for (const run of runs) logger.info(pc.green(runStartedLine(run)));
      for (const warning of triggerResult.warnings ?? []) {
        logger.warn(pc.yellow(`⚠ ${warning}`));
      }
    }

    // One history entry per run, so `kici runs show <id>` finds each one.
    const startedAt = new Date().toISOString();
    for (const run of runs) {
      await history.addEntry({
        runId: run.runId,
        fixtureId: fixture.id,
        ...(run.workflowName && { workflowName: run.workflowName }),
        status: 'running',
        startedAt,
        endpoint: ctx.endpoint,
      });
    }

    if (options.wait === false) {
      return withOverlay({
        fixtureId: fixture.id,
        runId: triggerResult.runId,
        status: 'accepted',
        runs: runs.map((r) => ({ ...r, status: 'accepted', jobs: [] })),
      });
    }

    const result = await followRuns(ctx, runs, fixture.id, options);

    const completedAt = new Date().toISOString();
    for (const run of result.runs ?? []) {
      await history.updateEntry(run.runId, {
        status:
          run.status === 'error' ? 'failed' : (run.status as 'success' | 'failed' | 'cancelled'),
        completedAt,
        ...(run.durationMs !== undefined && { durationMs: run.durationMs }),
        jobs: run.jobs.map(({ name, status, durationMs }) => ({
          name,
          status,
          ...(durationMs !== undefined && { durationMs }),
        })),
      });
    }

    return withOverlay(result);
  } catch (error) {
    return withOverlay(handleRunError(fixture.id, error, options, ctx.kind));
  }
}

function handleRunError(
  fixtureId: string,
  error: unknown,
  options: RemoteRunOptions,
  transport: RunRemoteTransport['kind'],
): RemoteRunResult {
  if (error instanceof AmbiguousClusterError) {
    logger.error(
      pc.red(
        `Multiple orchestrators are connected. Pass --orchestrator <name>, one of: ${error.clusters.join(', ')}`,
      ),
    );
    logger.error(pc.gray('Or set a default with `kici orchestrators use <name>`.'));
  } else if (error instanceof NoClusterError) {
    logger.error(pc.red('No orchestrator is connected for this organization.'));
  } else if (error instanceof AuthenticationError) {
    // The direct client's message already names the orchestrator-token remedy.
    logger.error(
      pc.red(
        transport === 'direct'
          ? error.message
          : 'Authentication failed. Run `kici login` to re-authenticate.',
      ),
    );
  } else if (error instanceof AccessDeniedError) {
    logger.error(pc.red(`Access denied: ${error.message}`));
  } else if (error instanceof ConnectionError) {
    logger.error(pc.red(`Connection failed: ${error.message}`));
  } else if (options.debug && error instanceof Error && error.stack) {
    logger.error(pc.gray(error.stack));
  }

  return { fixtureId, runId: '', status: 'error', reason: toErrorMessage(error) };
}

/** A direct run's verdict, rendered like a fixture's under `--json` or `--junit`. */
async function finishDirectRun(
  result: RemoteRunResult,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (options.json || options.junit) return renderResults([result], options);
  return result.status === 'success' || result.status === 'accepted';
}

/** Runs a workflow directly, bypassing trigger matching. */
async function runDirectWorkflow(
  workflowName: string,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;
  if (!(await checkWorkflowInLock(workflowName, options))) return false;

  const config = await loadGlobalConfig();
  const ctx = await resolveRunContext(config, options);
  if (!ctx) return false;

  if (options.json) {
    options.quiet = true;
  }

  if (!options.quiet) {
    for (const line of ctx.banner) logger.info(pc.gray(line));
    logger.info(pc.gray(`Running workflow "${workflowName}" directly (bypassing triggers)`));
  }

  const history = new RunHistory();
  await history.load();

  const fixtureId = `direct:${workflowName}`;
  let report: OverlayReport | undefined;
  const withOverlay = (result: RemoteRunResult): RemoteRunResult =>
    report ? { ...result, overlay: report } : result;

  try {
    const overlay = await prepareOverlay(options, { workflowName });
    report = overlay.report;
    const uploaded = await thenRemoveOverlay(overlay, () => initAndUpload(ctx, overlay, options));

    // Real origin identity, else synthetic `local/<repo>` (see buildRemoteFixtureEvent).
    const identity = buildLocalRepoIdentity(overlay.repoRoot);
    const head = localGitHead(overlay);
    if (!head.branch) {
      warnStderr(
        `HEAD is detached, so workflow ${workflowName} uses branch '${FALLBACK_BRANCH}' in place of the current branch.`,
      );
    }
    const payload: Record<string, unknown> = {
      repository: { full_name: identity.repoIdentifier, provider: identity.provider },
      ...(head.sha && { after: head.sha }),
    };

    const triggerResult = await ctx.trigger({
      fixtureId,
      event: {
        type: 'manual',
        targetBranch: head.branch ?? FALLBACK_BRANCH,
        payload,
      },
      ...(await overlayTriggerFields(overlay, uploaded, workflowName, options)),
    });

    if (triggerResult.status === 'rejected') {
      logger.error(pc.red(`Rejected: ${triggerResult.reason ?? 'unknown reason'}`));
      return finishDirectRun(
        withOverlay({
          fixtureId,
          runId: triggerResult.runId,
          status: 'rejected',
          reason: triggerResult.reason,
        }),
        options,
      );
    }

    // `--workflow` names one workflow, so the trigger creates one run.
    const runs = triggeredRuns(triggerResult);
    if (!options.quiet) {
      for (const run of runs) logger.info(pc.green(runStartedLine(run)));
    }

    if (options.wait === false) {
      return finishDirectRun(
        withOverlay({
          fixtureId,
          runId: triggerResult.runId,
          status: 'accepted',
          runs: runs.map((r) => ({ ...r, status: 'accepted', jobs: [] })),
        }),
        options,
      );
    }

    const result = await followRuns(ctx, runs, fixtureId, options);
    return finishDirectRun(withOverlay(result), options);
  } catch (error) {
    return finishDirectRun(
      withOverlay(handleRunError(fixtureId, error, options, ctx.kind)),
      options,
    );
  }
}

function displayRemoteResults(results: RemoteRunResult[]): void {
  logger.info(pc.bold('\n--- Results ---\n'));

  for (const r of results) {
    const statusColor =
      r.status === 'success' || r.status === 'accepted'
        ? pc.green
        : r.status === 'cancelled'
          ? pc.yellow
          : pc.red;

    const duration = r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : '';
    logger.info(`  ${statusColor(r.status.padEnd(12))} ${r.fixtureId}${duration}`);

    if (r.reason) {
      logger.info(pc.gray(`    ${r.reason}`));
    }
  }

  const passed = results.filter((r) => r.status === 'success' || r.status === 'accepted').length;
  const failed = results.length - passed;

  logger.info('');
  if (failed === 0) {
    logger.info(pc.green(`All ${results.length} fixture(s) passed`));
  } else {
    logger.info(pc.red(`${failed} of ${results.length} fixture(s) failed`));
  }
  logger.info('');
}
