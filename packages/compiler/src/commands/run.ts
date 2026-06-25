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
import type { RunLocalOptions } from '../local-executor/types.js';
import { resolveKiciDir } from '../execution/index.js';
import { loadGlobalConfig, type GlobalConfig } from '../remote/config.js';
import {
  PlatformRunClient,
  AmbiguousClusterError,
  NoClusterError,
  AuthenticationError,
  AccessDeniedError,
  ConnectionError,
  type ClusterTarget,
  type PlatformRunStatusResponse,
} from '../remote/platform-client.js';
import { compileFixtures, filterFixtures, type CompiledFixture } from '../fixtures/compiler.js';
import { describeEvent } from '../fixtures/describe-event.js';
import { runFixturePicker, FixturePickerCancelledError } from '../fixtures/picker.js';
import { createOverlayTarball, getSizeWarning, uploadTarball } from '../remote/uploader.js';
import {
  formatSummary,
  formatErrorHighlight,
  formatMultiFixtureSummary,
  type RunResult,
} from '../remote/output/summary.js';
import { formatJsonResult } from '../remote/output/json.js';
import { formatJunitResult } from '../remote/output/junit.js';
import { RunHistory } from '../remote/history.js';
import { buildEncryptedSecrets } from '../remote/secret-upload.js';
import {
  resolveHeldRunContext,
  listHeldRunsForRun,
  type HeldRunContext,
} from './held-run-client.js';
import { handleNewHolds } from './run-hold-watch.js';
import { compileCommand } from './compile.js';
import { confirm as inquirerConfirm } from '@inquirer/prompts';
import type { RemoteRunOptions, RemoteRunResult } from './test.js';

/** Terminal run statuses returned by the Platform run-status snapshot. */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'error']);

/**
 * Compile `--target` selector strings into a {@link HostTargetSelector}. Each
 * string becomes one AND value (its own include set); repeated values
 * AND-combine. Returns undefined when no `--target` is given. Throws when
 * `--target-allow-empty` is set without at least one `--target`.
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
 * Look up the dispatch-trigger `inputs` descriptor for a workflow from a parsed
 * inline lock file. When `workflowName` is given, only that workflow's dispatch
 * triggers are considered; otherwise descriptors across all workflows are merged
 * (best-effort fast-fail — the orchestrator re-validates against the matched
 * workflow authoritatively). Returns undefined when no dispatch inputs declared.
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
 * Validate raw `--input KEY=VALUE` pairs against the (optional) lock descriptor
 * and return the raw operator pairs verbatim. The CLI fast-fails on malformed /
 * invalid input for UX, but forwards the **raw** strings — the orchestrator is
 * authoritative and applies coercion + defaults exactly once.
 */
export function buildDispatchInputs(
  pairs: string[],
  descriptor: InputsDescriptorMap | undefined,
): Record<string, string> {
  if (!pairs.length) return {};
  const raw = parseInputPairs(pairs);
  if (descriptor) {
    const r = coerceDispatchInputs(raw, descriptor);
    if ('error' in r) throw r.error; // fast-fail UX; orchestrator re-validates authoritatively
  }
  return raw;
}

/** Interval between status/log polls while a run is active. */
const POLL_INTERVAL_MS = 750;

/**
 * Recompile `.kici/workflows` → `kici.lock.json` before a remote run, mirroring
 * `kici run local`. The orchestrator matches triggers and dispatches against the
 * inline lock, so a stale lock would route an edited or newly-added workflow
 * incorrectly. Returns false on a compile/validation error so the caller can
 * abort before any upload or dispatch.
 */
async function compileBeforeRemoteRun(options: RemoteRunOptions): Promise<boolean> {
  return compileCommand({
    kiciDir: options.kiciDir ?? '.kici',
    check: false,
    verbose: options.debug ?? false,
    // Keep stdout pure for machine-readable runs: --json (and --quiet) must not
    // carry the compile / auto-types success lines before the JSON result.
    quiet: Boolean(options.json || options.quiet),
  });
}

/**
 * Run a workflow locally using the local executor.
 * Thin wrapper that delegates to executeLocal from local-executor.
 *
 * Exit codes: 0 = success, 1 = job failure, 2 = config/compilation error
 */
export async function runLocalCommand(options: RunLocalOptions): Promise<boolean> {
  if (options.debug) {
    process.env.KICI_DEBUG = 'true';
    if (!options.quiet) logger.info(pc.gray('Debug mode enabled'));
  }

  try {
    // Dynamic import: executeLocal may not be available yet (Plan 03 dependency)
    const { executeLocal } = await import('../local-executor/index.js');
    return await executeLocal(options);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Cannot find module') ||
        error.message.includes('ERR_MODULE_NOT_FOUND'))
    ) {
      logger.error(
        pc.red(
          'Local executor not yet available. The local execution engine is under development.',
        ),
      );
      return false;
    }

    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (options.debug && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

/**
 * Run fixtures remotely, routed through the Platform.
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
    // Fail fast on an invalid --target / --target-allow-empty combination (and
    // an unsafe regex / invalid glob) before any compile or dispatch work.
    buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);

    // --workflow without a fixture: direct workflow run (bypass triggers)
    if (options.workflow && !fixture && !options.all) {
      return await runDirectWorkflow(options.workflow, options);
    }

    // Resolve .kici directory
    const kiciDir = resolveKiciDir(options.kiciDir);

    // --history: show recent run history
    if (options.history) {
      const history = new RunHistory();
      await history.load();
      const entries = history.getEntries({ limit: 20 });
      console.log(history.formatTable(entries));
      return true;
    }

    // Compile fixtures
    const testsDir = path.join(kiciDir, 'tests');
    const fixtures = await compileFixtures(testsDir);

    // Determine which fixtures to run
    let selected: CompiledFixture[];
    if (options.pick) {
      // No fixtures at all: fall through to the help/empty message.
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
      // No fixture arg and no --all: list available fixtures
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

    // Run selected fixtures remotely
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

// --- Remote execution functions ---

/**
 * List available fixtures as a table.
 */
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

  // Table header
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

/** Resolved Platform context: an authenticated client + the target org/cluster. */
interface PlatformContext {
  client: PlatformRunClient;
  orgId: string;
  target: ClusterTarget;
}

/**
 * Resolve the authenticated Platform client and the run target (org + cluster).
 *
 * Org resolution: `--org` → `config.activeOrgId` → error.
 * Cluster resolution: `--orchestrator` → `config.defaultClusters[orgId]` →
 * omit and let the Platform sole-select (or return a 422 the CLI surfaces).
 */
function resolvePlatformContext(
  config: GlobalConfig,
  options: RemoteRunOptions,
): PlatformContext | null {
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

  return {
    client: new PlatformRunClient({ platformEndpoint: config.platformEndpoint, token }),
    orgId,
    target: { orchestrator, defaultCluster },
  };
}

/**
 * Run fixtures remotely against the Platform.
 */
async function runFixturesRemotely(
  fixtures: CompiledFixture[],
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;

  const config = await loadGlobalConfig();
  const ctx = resolvePlatformContext(config, options);
  if (!ctx) return false;

  // --json implies --quiet (only structured JSON goes to stdout)
  if (options.json) {
    options.quiet = true;
  }

  const history = new RunHistory();
  await history.load();

  if (!options.quiet) {
    logger.info(pc.gray(`Platform: ${config.platformEndpoint}`));
    logger.info(pc.gray(`Organization: ${ctx.orgId}`));
    logger.info(pc.gray(`Fixtures: ${fixtures.length} to run\n`));
  }

  const results: RemoteRunResult[] = [];

  if (options.parallel && fixtures.length > 1) {
    const promises = fixtures.map((f) => runSingleFixture(f, ctx, options, config, history));
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
      const result = await runSingleFixture(f, ctx, options, config, history);
      results.push(result);
      // Fail fast on rejected
      if (result.status === 'failed' || result.status === 'error') {
        break;
      }
    }
  }

  return renderResults(results, options);
}

/**
 * Render the aggregated fixture results in the requested format.
 */
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
 * Prepare the overlay tarball + routing metadata for a run.
 *
 * The overlay always carries the full local working tree (the run executes the
 * developer's local code, never a clone). The compiled lock is inlined so the
 * orchestrator can match triggers under the `remote:<orgId>` anchor without a
 * webhook provider to fetch it from a git host.
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

  // `kici run remote` always uploads the full local working tree as a
  // self-contained overlay — the orchestrator runs the developer's local code,
  // not a clone of a committed revision. The orchestrator never clones for a
  // relayed run (the `remote:<orgId>` anchor has no webhook provider / clone
  // URL), so a diff-only overlay against a remote HEAD would leave the agent
  // with no base tree. `fullWorkingTree: true` forces the complete selection
  // regardless of whether the repo has a git remote.
  const { tarballPath, summary, hasRemote } = await createOverlayTarball(repoRoot, {
    fullWorkingTree: true,
  });

  if (!options.quiet) {
    // Guarded by !quiet so `--json` (which sets quiet) keeps stdout pure JSON.
    // The overlay includes the `.git` directory, so the remote workspace is the
    // developer's working tree exactly — steps that shell out to git work.
    logger.info(
      pc.gray('Running your local working tree (overlay includes .git, so git steps work)'),
    );
  }

  // Platform-first runs always carry the compiled lock inline: the run is
  // relayed under the `remote:<orgId>` anchor, which resolves the org but has
  // no webhook provider to fetch the lock from a git host. The dev's local
  // compiled lock is the authority for a test run of their working tree.
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

/**
 * Init the upload (Platform) and PUT the encrypted tarball directly to the
 * object store (data plane). Returns the upload id + the encryption keys.
 */
async function initAndUpload(
  ctx: PlatformContext,
  overlay: Awaited<ReturnType<typeof prepareOverlay>>,
  options: RemoteRunOptions,
): Promise<{ uploadId: string; publicKey: string; cliPublicKey: string }> {
  if (!options.quiet) {
    logger.info(pc.gray('Initializing upload...'));
  }

  const upload = await ctx.client.initUpload(ctx.orgId, ctx.target, {
    sha: overlay.summary.sha,
    fileCount: overlay.summary.fileCount,
    compressedSize: overlay.summary.compressedSize,
  });

  if (!options.quiet) {
    logger.info(pc.gray('Uploading overlay...'));
  }

  const uploadResult = await uploadTarball({
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
 * Run a single fixture remotely through the Platform.
 */
async function runSingleFixture(
  fixture: CompiledFixture,
  ctx: PlatformContext,
  options: RemoteRunOptions,
  config: GlobalConfig,
  history: RunHistory,
): Promise<RemoteRunResult> {
  const opts =
    typeof fixture.fixture.options === 'function'
      ? await fixture.fixture.options()
      : fixture.fixture.options;

  if (!options.quiet) {
    logger.info(pc.cyan(`\n--- ${fixture.id} ---`));
  }

  try {
    const overlay = await prepareOverlay(options);
    const uploaded = await initAndUpload(ctx, overlay, options);

    // Build the simulated event from fixture. The run always executes the
    // local working tree (fullRepo), so stamp a synthetic `local/<repo>`
    // repository identifier regardless of whether a git remote exists.
    const event = buildEventFromFixture(opts);
    {
      const repoName = path.basename(overlay.repoRoot);
      const repo = event.payload.repository as Record<string, unknown> | undefined;
      event.payload.repository = { ...(repo ?? {}), full_name: `local/${repoName}` };
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

    const triggerResult = await ctx.client.trigger(ctx.orgId, ctx.target, {
      fixtureId: fixture.id,
      event,
      uploadId: uploaded.uploadId,
      // The key that encrypted the overlay tarball — required for the
      // orchestrator to decrypt + apply the overlay (independent of secrets).
      cliPublicKey: uploaded.cliPublicKey,
      secrets: opts.secrets,
      ...(encrypted && {
        encryptedSecrets: encrypted.encryptedSecrets,
        encryptedSecretsKey: encrypted.cliPublicKey,
      }),
      workflowName: opts.workflowName,
      inlineLockFile: overlay.inlineLockFile,
      // Always fullRepo: the overlay carries the complete local working tree;
      // the orchestrator never clones for a relayed run.
      fullRepo: true,
      ...(options.checkMode && { checkMode: options.checkMode }),
      ...(() => {
        const target = buildTargetSelector(options.targets, options.targetAllowEmpty ?? false);
        return target ? { target } : {};
      })(),
      ...(() => {
        const descriptor = lookupDispatchInputsDescriptor(
          overlay.inlineLockFile,
          opts.workflowName,
        );
        const dispatchInputs = buildDispatchInputs(options.inputs ?? [], descriptor);
        return Object.keys(dispatchInputs).length ? { dispatchInputs } : {};
      })(),
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

    if (!options.quiet) {
      logger.info(pc.green(`Run started: ${triggerResult.runId}`));
    }

    await history.addEntry({
      runId: triggerResult.runId,
      fixtureId: fixture.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      endpoint: config.platformEndpoint ?? '',
    });

    // --no-wait: print runId and return immediately
    if (options.wait === false) {
      return { fixtureId: fixture.id, runId: triggerResult.runId, status: 'accepted' };
    }

    const result = await pollRunToCompletion(ctx, triggerResult.runId, fixture.id, options);

    await history.updateEntry(triggerResult.runId, {
      status: result.status as 'success' | 'failed' | 'cancelled',
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      jobs: result.jobs,
    });

    return result;
  } catch (error) {
    return handleRunError(fixture.id, error, options);
  }
}

/** Map a run-path error to a CLI message + a result. */
function handleRunError(
  fixtureId: string,
  error: unknown,
  options: RemoteRunOptions,
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
    logger.error(pc.red('Authentication failed. Run `kici login` to re-authenticate.'));
  } else if (error instanceof AccessDeniedError) {
    logger.error(pc.red(`Access denied: ${error.message}`));
  } else if (error instanceof ConnectionError) {
    logger.error(pc.red(`Connection failed: ${error.message}`));
  } else if (options.debug && error instanceof Error && error.stack) {
    logger.error(pc.gray(error.stack));
  }

  return { fixtureId, runId: '', status: 'error', reason: toErrorMessage(error) };
}

/**
 * Poll the Platform for run completion, streaming log lines as they arrive.
 *
 * Advances a monotonic line-offset cursor (spec §13a): each `runLogs(cursor)`
 * returns the next chunk + `nextCursor`; the run is done only when the status
 * is terminal and the log stream has drained.
 */
async function pollRunToCompletion(
  ctx: PlatformContext,
  runId: string,
  fixtureId: string,
  options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const startTime = Date.now();
  let cursor = 0;
  const tailLines: string[] = [];
  const MAX_TAIL = 50;

  // Set up Ctrl+C cancel
  let cancelled = false;
  const cancelHandler = async () => {
    if (cancelled) return;
    cancelled = true;
    if (!options.quiet) logger.info(pc.yellow('\nCancelling test run...'));
    try {
      await ctx.client.cancel(ctx.orgId, runId, ctx.target);
    } catch {
      // best effort
    }
  };
  process.on('SIGINT', cancelHandler);

  try {
    let lastStatus: PlatformRunStatusResponse | null = null;
    // Holds observed so far (so we prompt / notify once per hold).
    const seenHolds = new Set<string>();
    // Resolved lazily on the first hold so a hold-free run pays no cost.
    let heldCtx: HeldRunContext | null | undefined;

    while (!cancelled) {
      const logs = await ctx.client.runLogs(ctx.orgId, runId, cursor, ctx.target);
      for (const line of logs.lines) {
        if (!options.quiet) process.stdout.write(line + '\n');
        tailLines.push(line);
        while (tailLines.length > MAX_TAIL) tailLines.shift();
      }
      cursor = logs.nextCursor;

      lastStatus = await ctx.client.runStatus(ctx.orgId, runId, ctx.target);
      const terminal = lastStatus.done || TERMINAL_STATUSES.has(lastStatus.status);

      if (terminal && logs.done) {
        return finishRun(fixtureId, runId, lastStatus, startTime, tailLines, options);
      }

      // Surface any approval holds for this run: print the (drift) payload and,
      // in a TTY, prompt approve/reject inline. Reuses the `kici approve` path.
      if (!terminal && !options.quiet) {
        await watchRunHolds(
          runId,
          seenHolds,
          () => heldCtx,
          (c) => (heldCtx = c),
          options,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return {
      fixtureId,
      runId,
      status: 'cancelled',
      durationMs: Date.now() - startTime,
      jobs: jobsFromStatus(lastStatus),
    };
  } finally {
    process.removeListener('SIGINT', cancelHandler);
  }
}

/**
 * Fetch this run's pending holds and surface them to the operator. The held-run
 * context is resolved lazily (cached across ticks via the getter/setter). A
 * resolution / fetch failure is swallowed — hold-visibility is best-effort and
 * must never abort the run watch.
 */
async function watchRunHolds(
  runId: string,
  seenHolds: Set<string>,
  getCtx: () => HeldRunContext | null | undefined,
  setCtx: (c: HeldRunContext | null) => void,
  options: RemoteRunOptions,
): Promise<void> {
  try {
    let ctx = getCtx();
    if (ctx === undefined) {
      ctx = await resolveHeldRunContext();
      setCtx(ctx);
    }
    if (!ctx) return;
    const holds = await listHeldRunsForRun(ctx, runId);
    if (holds.length === 0) return;
    const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    await handleNewHolds({
      holds,
      seen: seenHolds,
      isTty,
      approveAll: Boolean(options.approveAll),
      confirm: (message) => inquirerConfirm({ message, default: false }),
    });
  } catch {
    // Best-effort: never let a hold-poll error abort the run watch.
  }
}

/** Build the final result + render the summary table for a completed run. */
function finishRun(
  fixtureId: string,
  runId: string,
  status: PlatformRunStatusResponse,
  startTime: number,
  tailLines: string[],
  options: RemoteRunOptions,
): RemoteRunResult {
  const durationMs = Date.now() - startTime;
  const jobs = jobsFromStatus(status);
  const finalStatus = status.status as RemoteRunResult['status'];

  if (!options.quiet) {
    const runResult: RunResult = {
      fixtureId,
      runId,
      status:
        finalStatus === 'failed' ? 'failed' : finalStatus === 'cancelled' ? 'cancelled' : 'success',
      totalDurationMs: durationMs,
      jobs,
    };
    process.stdout.write('\n' + formatSummary(runResult) + '\n');

    if (finalStatus === 'failed' && tailLines.length > 0) {
      const failedJob = status.jobs.find((j) => j.status === 'failed');
      process.stdout.write(
        '\n' + formatErrorHighlight(failedJob?.jobName ?? 'run', tailLines) + '\n',
      );
    }
  }

  return { fixtureId, runId, status: finalStatus, durationMs, jobs };
}

/** Map a Platform run-status snapshot to the CLI's job summary shape. */
function jobsFromStatus(
  status: PlatformRunStatusResponse | null,
): Array<{ name: string; status: string; durationMs?: number }> {
  if (!status) return [];
  return status.jobs.map((j) => ({ name: j.jobName, status: j.status }));
}

/**
 * Build a SimulatedEvent-compatible object from fixture options.
 */
function buildEventFromFixture(opts: import('@kici-dev/sdk').FixtureOptions): {
  type: string;
  action?: string;
  targetBranch: string;
  sourceBranch?: string;
  payload: Record<string, unknown>;
  changedFiles?: string[];
} {
  const event = opts.event;
  const eventObj = event as unknown as Record<string, unknown>;

  const type = String(eventObj._type ?? 'push');
  const action = eventObj.action ? String(eventObj.action) : undefined;

  const targetBranch = opts.branch ?? 'main';
  const sourceBranch = type === 'pr' ? (opts.branch ?? 'feature/test') : undefined;

  return {
    type,
    action,
    targetBranch,
    sourceBranch,
    payload: {
      ref: `refs/heads/${targetBranch}`,
      repository: {
        full_name: opts.repo ?? 'owner/repo',
      },
      ...(opts.sha && { after: opts.sha }),
      ...(opts.pr && { number: opts.pr }),
    },
  };
}

/**
 * Run a specific workflow directly (bypass trigger matching), through the
 * Platform.
 */
async function runDirectWorkflow(
  workflowName: string,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;

  const config = await loadGlobalConfig();
  const ctx = resolvePlatformContext(config, options);
  if (!ctx) return false;

  if (options.json) {
    options.quiet = true;
  }

  if (!options.quiet) {
    logger.info(pc.gray(`Running workflow "${workflowName}" directly (bypassing triggers)`));
  }

  const history = new RunHistory();
  await history.load();

  const fixtureId = `direct:${workflowName}`;

  try {
    const overlay = await prepareOverlay(options);
    const uploaded = await initAndUpload(ctx, overlay, options);

    // The run always executes the local working tree (fullRepo), so stamp the
    // synthetic `local/<repo>` identifier regardless of a git remote.
    const payload: Record<string, unknown> = {
      repository: { full_name: `local/${path.basename(overlay.repoRoot)}` },
    };

    const encrypted = await buildEncryptedSecrets(
      overlay.kiciDir,
      options.envFlags,
      options.context,
      uploaded.publicKey,
    );

    const triggerResult = await ctx.client.trigger(ctx.orgId, ctx.target, {
      fixtureId,
      event: { type: 'manual', targetBranch: 'main', payload },
      uploadId: uploaded.uploadId,
      // Overlay-tarball key — required for overlay decryption (independent of secrets).
      cliPublicKey: uploaded.cliPublicKey,
      ...(encrypted && {
        encryptedSecrets: encrypted.encryptedSecrets,
        encryptedSecretsKey: encrypted.cliPublicKey,
      }),
      workflowName,
      inlineLockFile: overlay.inlineLockFile,
      // Always fullRepo: the overlay carries the complete local working tree.
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

    if (!options.quiet) {
      logger.info(pc.green(`Run started: ${triggerResult.runId}`));
    }

    if (options.wait === false) {
      return triggerResult.status === 'accepted';
    }

    const result = await pollRunToCompletion(ctx, triggerResult.runId, fixtureId, options);
    return result.status === 'success';
  } catch (error) {
    const result = handleRunError(fixtureId, error, options);
    return result.status === 'success';
  }
}

/**
 * Display remote run results as a summary table.
 */
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
