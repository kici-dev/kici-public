import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { formatBytes, logger, toErrorMessage } from '@kici-dev/core';
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
  type GitHead,
} from '../fixtures/event.js';
import { detectCurrentBranch } from '../test-runner/git-detector.js';
import { runFixturePicker, FixturePickerCancelledError } from '../fixtures/picker.js';
import { createOverlayTarball, getSizeWarning } from '../remote/uploader.js';
import { formatMultiFixtureSummary, type RunResult } from '../remote/output/summary.js';
import { formatJsonResult } from '../remote/output/json.js';
import { formatJunitResult } from '../remote/output/junit.js';
import { RunHistory } from '../remote/history.js';
import { buildEncryptedSecrets } from '../remote/secret-upload.js';
import { buildLocalRepoIdentity } from '../remote/local-repo-identity.js';
import { compileCommand } from './compile.js';
import { followRuns, type FollowedRun } from './run-remote-follow.js';
import type { RemoteRunOptions, RemoteRunResult } from './preview.js';

/**
 * The runs a trigger created: one per matched workflow, or the single `runId`
 * of an orchestrator that predates `runs`.
 */
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
 * Without `workflowName`, merges the dispatch `inputs` descriptors of every
 * workflow: a best-effort fast-fail, since the orchestrator re-validates against
 * the matched workflow authoritatively.
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
 * Names the problem when `workflowName` is not a workflow of the compiled lock
 * file, listing the workflows it does have; undefined when it is. An unparsable
 * lock returns undefined and leaves the verdict to the orchestrator.
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

/**
 * Checks `--workflow` against the lock file the compile just wrote, so an
 * unknown name stops before anything is uploaded. Returns false after logging.
 */
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
 * Compiling evaluates every user workflow and fixture module, and a top-level
 * `console.log` writes straight to stdout. A `--json` stdout MUST carry only the
 * final JSON result, so compile phases run with stdout redirected to stderr.
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
 * The orchestrator matches triggers against the inline lock, so a stale lock
 * would route an edited or new workflow incorrectly. Returns false on a compile
 * error so the caller aborts before any upload or dispatch.
 */
async function compileBeforeRemoteRun(options: RemoteRunOptions): Promise<boolean> {
  // --json and --quiet stdout carries neither compile success lines nor user
  // module-top-level console.log output.
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

/**
 * Run fixtures remotely, through the Platform or straight to an orchestrator.
 */
export async function runRemoteCommand(
  fixture: string | undefined,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (options.debug) {
    process.env.KICI_DEBUG = 'true';
    if (!options.quiet) logger.info(pc.gray('Debug mode enabled'));
  }

  try {
    // Fail fast on an invalid selector (or unsafe regex / invalid glob) before
    // any compile or dispatch work.
    buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);

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

/**
 * A direct target is verified with `whoami` first, so a token that cannot start
 * runs stops here, before anything is uploaded.
 */
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
 * `config.defaultClusters[orgId]` → omitted, so the Platform sole-selects (or
 * returns a 422 the CLI surfaces).
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
      // Fail fast, and stop after a cancel: Ctrl-C ends the whole batch, not
      // only the fixture that was running.
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

/**
 * The overlay always carries the full local working tree, and the compiled lock
 * is inlined: the orchestrator never clones for a relayed run, and the
 * `remote:<orgId>` anchor has no webhook provider to fetch the lock or a base
 * tree from a git host.
 */
async function prepareOverlay(options: RemoteRunOptions): Promise<{
  tarballPath: string;
  summary: Awaited<ReturnType<typeof createOverlayTarball>>['summary'];
  hasRemote: boolean;
  inlineLockFile?: string;
  kiciDir: string;
  repoRoot: string;
}> {
  const kiciDir = resolveKiciDir(options.kiciDir);
  const repoRoot = path.resolve(kiciDir, '..');

  if (!options.quiet) {
    logger.info(pc.gray('Creating overlay tarball...'));
  }

  // A diff-only overlay against a remote HEAD would leave the agent with no base
  // tree, so the complete selection is forced whether or not a git remote exists.
  const { tarballPath, summary, hasRemote, warnings } = await createOverlayTarball(repoRoot, {
    fullWorkingTree: true,
  });
  // Warnings name paths the remote workspace lacks (submodules, dangling
  // symlinks); stderr keeps a --json stdout parseable.
  for (const warning of warnings) process.stderr.write(`${pc.yellow(`⚠ ${warning}`)}\n`);

  if (!options.quiet) {
    logger.info(
      pc.gray('Running your local working tree (overlay includes .git, so git steps work)'),
    );
  }

  // On either transport; the local compiled lock is the authority for a test
  // run of the working tree.
  const inlineLockFile = await readFile(path.join(kiciDir, 'kici.lock.json'), 'utf-8');

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

  return { tarballPath, summary, hasRemote, inlineLockFile, kiciDir, repoRoot };
}

/** The branch and commit the overlay was built from: the defaults for the run's event. */
function localGitHead(overlay: { repoRoot: string; summary: { sha: string } }): GitHead {
  return { branch: detectCurrentBranch(overlay.repoRoot), sha: overlay.summary.sha };
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

  // `--workflow` is the explicit choice for this invocation, so it wins over a
  // workflow the fixture names itself.
  if (options.workflow && opts.workflowName && opts.workflowName !== options.workflow) {
    warnStderr(
      `fixture ${fixture.id} names workflow '${opts.workflowName}'; running '${options.workflow}' as --workflow asks.`,
    );
  }
  const workflowName = options.workflow ?? opts.workflowName;

  try {
    const overlay = await prepareOverlay(options);
    const uploaded = await initAndUpload(ctx, overlay, options);

    const head = localGitHead(overlay);
    const fallback = head.branch ? undefined : currentBranchFallback(opts);
    if (fallback) {
      warnStderr(
        `HEAD is detached, so fixture ${fixture.id} uses branch '${fallback}' in place of the current branch.`,
      );
    }
    const event = buildFixtureEvent(opts, head);
    // Stamp the real origin `owner/repo` and provider when the tree has a
    // recognized git remote, else a synthetic `local/<repo>` identity, so the
    // dashboard never builds a broken external link.
    {
      const identity = buildLocalRepoIdentity(overlay.repoRoot);
      const repo = event.payload.repository as Record<string, unknown> | undefined;
      event.payload.repository = {
        ...(repo ?? {}),
        full_name: identity.repoIdentifier,
        provider: identity.provider,
      };
    }

    if (!options.quiet) {
      logger.info(pc.gray('Triggering test run...'));
    }

    const encrypted = await buildEncryptedSecrets(
      overlay.kiciDir,
      options.envFlags,
      options.context,
      uploaded.publicKey,
    );

    const triggerResult = await ctx.trigger({
      fixtureId: fixture.id,
      event,
      uploadId: uploaded.uploadId,
      // Overlay-tarball key, required to decrypt the overlay (independent of secrets).
      cliPublicKey: uploaded.cliPublicKey,
      secrets: opts.secrets,
      ...(encrypted && {
        encryptedSecrets: encrypted.encryptedSecrets,
        encryptedSecretsKey: encrypted.cliPublicKey,
      }),
      workflowName,
      inlineLockFile: overlay.inlineLockFile,
      // The overlay carries the complete working tree; a relayed run never clones.
      fullRepo: true,
      ...(options.checkMode && { checkMode: options.checkMode }),
      ...(() => {
        const target = buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);
        return target ? { target } : {};
      })(),
      ...(() => {
        const descriptor = lookupDispatchInputsDescriptor(overlay.inlineLockFile, workflowName);
        const dispatchInputs = buildDispatchInputs(options.inputs ?? [], descriptor);
        return Object.keys(dispatchInputs).length ? { dispatchInputs } : {};
      })(),
      // This CLI follows every run, so each matched workflow gets its own.
      acceptsMultipleRuns: true,
    });

    if (triggerResult.status === 'rejected') {
      if (!options.quiet) {
        logger.info(pc.red(`Rejected: ${triggerResult.reason ?? 'unknown reason'}`));
      }
      return {
        fixtureId: fixture.id,
        runId: triggerResult.runId,
        status: 'rejected',
        reason: triggerResult.reason,
      };
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
      return {
        fixtureId: fixture.id,
        runId: triggerResult.runId,
        status: 'accepted',
        runs: runs.map((r) => ({ ...r, status: 'accepted', jobs: [] })),
      };
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

    return result;
  } catch (error) {
    return handleRunError(fixture.id, error, options, ctx.kind);
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

  try {
    const overlay = await prepareOverlay(options);
    const uploaded = await initAndUpload(ctx, overlay, options);

    // Real origin identity, else synthetic `local/<repo>` (see runSingleFixture).
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

    const encrypted = await buildEncryptedSecrets(
      overlay.kiciDir,
      options.envFlags,
      options.context,
      uploaded.publicKey,
    );

    const triggerResult = await ctx.trigger({
      fixtureId,
      event: {
        type: 'manual',
        targetBranch: head.branch ?? FALLBACK_BRANCH,
        payload,
      },
      uploadId: uploaded.uploadId,
      cliPublicKey: uploaded.cliPublicKey,
      ...(encrypted && {
        encryptedSecrets: encrypted.encryptedSecrets,
        encryptedSecretsKey: encrypted.cliPublicKey,
      }),
      workflowName,
      inlineLockFile: overlay.inlineLockFile,
      fullRepo: true,
      ...(options.checkMode && { checkMode: options.checkMode }),
      ...(() => {
        const target = buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);
        return target ? { target } : {};
      })(),
      ...(() => {
        const descriptor = lookupDispatchInputsDescriptor(overlay.inlineLockFile, workflowName);
        const dispatchInputs = buildDispatchInputs(options.inputs ?? [], descriptor);
        return Object.keys(dispatchInputs).length ? { dispatchInputs } : {};
      })(),
    });

    if (triggerResult.status === 'rejected') {
      logger.error(pc.red(`Rejected: ${triggerResult.reason ?? 'unknown reason'}`));
      return false;
    }

    // `--workflow` names one workflow, so the trigger creates one run.
    const runs = triggeredRuns(triggerResult);
    if (!options.quiet) {
      for (const run of runs) logger.info(pc.green(runStartedLine(run)));
    }

    if (options.wait === false) return true;

    const result = await followRuns(ctx, runs, fixtureId, options);
    return result.status === 'success';
  } catch (error) {
    const result = handleRunError(fixtureId, error, options, ctx.kind);
    return result.status === 'success';
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
