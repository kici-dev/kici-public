import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { formatBytes, logger, toErrorMessage } from '@kici-dev/core';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import {
  parseInputPairs,
  coerceDispatchInputs,
  toCanonicalStatus,
  TERMINAL_RUN_STATES,
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
  NotFoundError,
  type PlatformRunLogsResponse,
  type PlatformRunStatusResponse,
} from '../remote/platform-client.js';
import { DirectRunClient, HoldsUnavailableError } from '../remote/direct-client.js';
import {
  createDirectTransport,
  createPlatformTransport,
  type RunRemoteTransport,
} from '../remote/run-transport.js';
import { resolveRunTarget } from '../remote/target.js';
import { compileFixtures, filterFixtures, type CompiledFixture } from '../fixtures/compiler.js';
import { describeEvent } from '../fixtures/describe-event.js';
import { runFixturePicker, FixturePickerCancelledError } from '../fixtures/picker.js';
import { createOverlayTarball, getSizeWarning } from '../remote/uploader.js';
import {
  formatSummary,
  formatErrorHighlight,
  formatMultiFixtureSummary,
  type RunResult,
} from '../remote/output/summary.js';
import { formatJsonResult } from '../remote/output/json.js';
import { unwrapStoredLogLine } from '../remote/output/streaming.js';
import { formatJunitResult } from '../remote/output/junit.js';
import { RunHistory } from '../remote/history.js';
import { buildEncryptedSecrets } from '../remote/secret-upload.js';
import { buildLocalRepoIdentity } from '../remote/local-repo-identity.js';
import { handleNewHolds } from './run-hold-watch.js';
import { compileCommand } from './compile.js';
import { confirm as inquirerConfirm } from '@inquirer/prompts';
import type { RemoteRunOptions, RemoteRunResult } from './preview.js';

/**
 * True when the Platform run-status snapshot reports a terminal run status.
 *
 * Resolves through the engine's canonical vocabulary rather than matching a
 * hand-written literal set, so a newly-added terminal status never leaves
 * `kici run` polling a finished run forever.
 */
function isTerminalRunStatus(status: string): boolean {
  const canonical = toCanonicalStatus(status.toLowerCase());
  return canonical !== undefined && TERMINAL_RUN_STATES.has(canonical);
}

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
 * How long a freshly triggered run may still read as missing before a 404 is
 * reported as a real error.
 *
 * The trigger call answers with the run id as soon as the orchestrator has
 * created the run, while the Platform's view of that run arrives over the
 * relay a moment later. The first poll therefore fires while the run is not
 * yet readable and legitimately 404s. Within this budget — and only until the
 * first successful read — a 404 means "not visible yet" and the poll retries;
 * after it, or once the run has been read at least once, a 404 is surfaced as
 * a genuinely missing run.
 */
const RUN_VISIBILITY_GRACE_MS = 30_000;

/**
 * Run `fn` with everything written to `process.stdout` redirected to
 * `process.stderr`, then restore the original writer. Compiling a repo
 * evaluates every user workflow / fixture module, and a `console.log` at a
 * module's top level writes straight to stdout. On a machine-readable
 * (`--json`) run that stdout MUST carry only the final JSON result, so the
 * compile phases run inside this guard — workflow log output belongs on
 * stderr regardless.
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
 * Recompile `.kici/workflows` → `kici.lock.json` before a remote run. The
 * orchestrator matches triggers and dispatches against the inline lock, so a
 * stale lock would route an edited or newly-added workflow incorrectly. Returns
 * false on a compile/validation error so the caller can abort before any upload
 * or dispatch.
 */
async function compileBeforeRemoteRun(options: RemoteRunOptions): Promise<boolean> {
  // Keep stdout pure for machine-readable runs: --json (and --quiet) must not
  // carry the compile / auto-types success lines — nor any user workflow's
  // module-top-level console.log — before the JSON result.
  const pureStdout = Boolean(options.json || options.quiet);
  const compile = () =>
    compileCommand({
      kiciDir: options.kiciDir ?? '.kici',
      check: false,
      verbose: options.debug ?? false,
      quiet: pureStdout,
      // The types refresh reads the orchestrator this run goes to, so a
      // direct run never reaches a saved Platform login.
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

    // Compile fixtures. In machine-readable mode, isolate any module-top-level
    // console.log a fixture emits when evaluated so it cannot corrupt the JSON
    // result that stdout must carry alone.
    const testsDir = path.join(kiciDir, 'tests');
    const fixtures = options.json
      ? await withStdoutOnStderr(() => compileFixtures(testsDir))
      : await compileFixtures(testsDir);

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

/** Write a warning line to stderr, so a `--json` stdout stays pure. */
function warnStderr(message: string): void {
  process.stderr.write(`${pc.yellow(message)}\n`);
}

/** Warn about run flags that are accepted but have no effect. */
function warnDeprecatedRunFlags(options: RemoteRunOptions): void {
  if (options.routingKey) {
    warnStderr(
      '--routing-key is deprecated and has no effect: the orchestrator chooses the routing key. It will be removed in v1.0.0.',
    );
  }
}

/** Warn that the Platform-only targeting flags do not apply to a direct run. */
function warnIgnoredForDirect(options: RemoteRunOptions): void {
  const flags = [options.org && '--org', options.orchestrator && '--orchestrator'].filter(Boolean);
  warnStderr(
    `${flags.join(' and ')} ignored: a direct run goes to one orchestrator, and the orchestrator chooses the organization.`,
  );
}

/**
 * Resolve where this run goes and return the transport that reaches it.
 *
 * The target comes from `resolveRunTarget` (flag, environment, saved direct
 * target, Platform login). A direct target is verified with `whoami` first, so
 * a token that cannot start runs stops here, before anything is uploaded.
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
 * Resolve the authenticated Platform client and the run target (org + cluster).
 *
 * Org resolution: `--org` → `config.activeOrgId` → error.
 * Cluster resolution: `--orchestrator` → `config.defaultClusters[orgId]` →
 * omit and let the Platform sole-select (or return a 422 the CLI surfaces).
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

/**
 * Run fixtures remotely, through the Platform or straight to an orchestrator.
 */
async function runFixturesRemotely(
  fixtures: CompiledFixture[],
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;

  const config = await loadGlobalConfig();
  const ctx = await resolveRunContext(config, options);
  if (!ctx) return false;

  // --json implies --quiet (only structured JSON goes to stdout)
  if (options.json) {
    options.quiet = true;
  }

  const history = new RunHistory();
  await history.load();

  if (!options.quiet) {
    for (const line of ctx.banner) logger.info(pc.gray(line));
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
  const { tarballPath, summary, hasRemote, warnings } = await createOverlayTarball(repoRoot, {
    fullWorkingTree: true,
  });
  // Warnings name paths the remote workspace will not contain (submodules,
  // dangling symlinks). They go to stderr so --json keeps stdout parseable and
  // still shows them.
  for (const warning of warnings) process.stderr.write(`${pc.yellow(`⚠ ${warning}`)}\n`);

  if (!options.quiet) {
    // Guarded by !quiet so `--json` (which sets quiet) keeps stdout pure JSON.
    // The overlay includes the `.git` directory, so the remote workspace is the
    // developer's working tree exactly — steps that shell out to git work.
    logger.info(
      pc.gray('Running your local working tree (overlay includes .git, so git steps work)'),
    );
  }

  // Remote runs always carry the compiled lock inline, on either transport:
  // the run lands under the `remote:<orgId>` anchor, which resolves the org but has
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
 * Init the upload (control plane) and PUT the encrypted tarball directly to the
 * object store (data plane). Returns the upload id + the encryption keys.
 */
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
 * Run a single fixture remotely over the resolved transport.
 */
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

  try {
    const overlay = await prepareOverlay(options);
    const uploaded = await initAndUpload(ctx, overlay, options);

    // Build the simulated event from fixture. The run executes the local
    // working tree. Stamp the real origin `owner/repo` + provider when the tree
    // has a recognized git remote, else a synthetic `local/<repo>` identity so
    // the dashboard never builds a broken external link.
    const event = buildEventFromFixture(opts);
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
      for (const warning of triggerResult.warnings ?? []) {
        logger.warn(pc.yellow(`⚠ ${warning}`));
      }
    }

    await history.addEntry({
      runId: triggerResult.runId,
      fixtureId: fixture.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      endpoint: ctx.endpoint,
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
    return handleRunError(fixture.id, error, options, ctx.kind);
  }
}

/** Map a run-path error to a CLI message + a result. */
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

/**
 * Poll the transport for run completion, streaming log lines as they arrive.
 *
 * Advances a monotonic line-offset cursor: each `runLogs(cursor)`
 * returns the next chunk + `nextCursor`; the run is done only when the status
 * is terminal and the log stream has drained.
 */
async function pollRunToCompletion(
  ctx: RunRemoteTransport,
  runId: string,
  fixtureId: string,
  options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const startTime = Date.now();
  let cursor = 0;
  const tailLines: string[] = [];
  const MAX_TAIL = 50;

  // Ctrl-C cancels the run. The poll loop stops, and the command returns only
  // once the cancel request has settled; a second Ctrl-C exits at once.
  let cancelRequest: Promise<void> | null = null;
  const cancelHandler = () => {
    if (!cancelRequest) {
      cancelRequest = requestRunCancel(ctx, runId, options);
    } else {
      process.stderr.write(
        pc.yellow(`Exiting without waiting. Run ${runId} may still be running.\n`),
      );
      process.exit(SIGINT_EXIT_CODE);
    }
  };
  process.on('SIGINT', cancelHandler);

  try {
    let lastStatus: PlatformRunStatusResponse | null = null;
    // Holds observed so far (so we prompt / notify once per hold), and whether
    // this transport has said it cannot list holds for this run.
    const holdState: HoldWatchState = { seen: new Set<string>(), unavailable: false };

    // Flipped by the first successful read. Until then a 404 is treated as
    // "the Platform has not seen this run yet" (see RUN_VISIBILITY_GRACE_MS).
    let runSeen = false;

    while (!cancelRequest) {
      let logs: PlatformRunLogsResponse;
      try {
        logs = await ctx.logs(runId, cursor);
        lastStatus = await ctx.status(runId);
      } catch (err) {
        if (
          err instanceof NotFoundError &&
          !runSeen &&
          Date.now() - startTime < RUN_VISIBILITY_GRACE_MS
        ) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          continue;
        }
        throw err;
      }
      runSeen = true;

      for (const raw of logs.lines) {
        const line = unwrapStoredLogLine(raw);
        if (!options.quiet) process.stdout.write(line + '\n');
        tailLines.push(line);
        while (tailLines.length > MAX_TAIL) tailLines.shift();
      }
      cursor = logs.nextCursor;

      const terminal = lastStatus.done || isTerminalRunStatus(lastStatus.status);

      if (terminal && logs.done) {
        return finishRun(fixtureId, runId, lastStatus, startTime, tailLines, options);
      }

      // Surface any approval holds for this run every non-terminal tick. Quiet /
      // --json runs are handled inside watchRunHolds: it routes hold text to
      // stderr (keeping stdout pure JSON) and forces the non-interactive path so
      // --approve-all auto-approves instead of the run hanging on a gate.
      if (!terminal) {
        await watchRunHolds(runId, holdState, ctx, options);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    await cancelRequest;
    return {
      fixtureId,
      runId,
      status: 'cancelled',
      durationMs: Date.now() - startTime,
      jobs: jobsFromStatus(lastStatus),
    };
  } finally {
    // A Ctrl-C during the last poll tick still sends its cancel before the
    // command reports and exits.
    if (cancelRequest) await cancelRequest;
    process.removeListener('SIGINT', cancelHandler);
  }
}

/** How long Ctrl-C waits for the orchestrator to answer a cancel request. */
const CANCEL_REQUEST_TIMEOUT_MS = 15_000;

/** Exit code of a second Ctrl-C: 128 + SIGINT, the shell convention. */
const SIGINT_EXIT_CODE = 130;

/**
 * Ask the orchestrator to cancel `runId` and report the outcome. Never throws:
 * a failed or unanswered request is reported, and the command still ends.
 */
export async function requestRunCancel(
  ctx: Pick<RunRemoteTransport, 'cancel'>,
  runId: string,
  options: Pick<RemoteRunOptions, 'quiet'>,
  timeoutMs = CANCEL_REQUEST_TIMEOUT_MS,
): Promise<void> {
  // Quiet / --json keeps stdout for the result, so the notes go to stderr.
  const note = (line: string): void => {
    if (options.quiet) process.stderr.write(`${line}\n`);
    else logger.info(line);
  };
  note(pc.yellow(`\nCancelling run ${runId}... Press Ctrl-C again to exit without waiting.`));
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      ctx.cancel(runId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the orchestrator did not answer within ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
      }),
    ]);
    note(
      pc.yellow(
        answer.cancelled
          ? `Cancelled run ${runId}.`
          : `Run ${runId} had already finished; nothing to cancel.`,
      ),
    );
  } catch (err) {
    process.stderr.write(
      `${pc.red(`Could not cancel run ${runId}: ${toErrorMessage(err)}. The run may still be running.`)}\n`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Hold bookkeeping carried across poll ticks. */
export interface HoldWatchState {
  /** Hold ids already shown (prompted or notified once each). */
  seen: Set<string>;
  /** Set once the transport says it cannot list holds; listing then stops. */
  unavailable: boolean;
}

/**
 * Fetch this run's pending holds and surface them to the operator, through the
 * transport's hold access. A transport that cannot list holds here says so
 * once (`HoldsUnavailableError`) and is not asked again. Any other failure is
 * swallowed: hold-visibility is best-effort and must never abort the run watch.
 */
export async function watchRunHolds(
  runId: string,
  state: HoldWatchState,
  transport: Pick<RunRemoteTransport, 'kind' | 'holds'>,
  options: RemoteRunOptions,
): Promise<void> {
  if (state.unavailable) return;
  const quiet = Boolean(options.quiet);
  // Quiet / --json: never block on a stdin prompt (would hang the machine-
  // readable run) — force the notify path — and never write hold text to
  // stdout (the pure-JSON channel) — route it to stderr.
  const output = quiet
    ? (line: string) => void process.stderr.write(line + '\n')
    : (line: string) => logger.info(line);
  try {
    const holds = await transport.holds.list(runId);
    if (holds.length === 0) return;

    const isTty = quiet ? false : Boolean(process.stdin.isTTY && process.stdout.isTTY);
    await handleNewHolds({
      holds,
      seen: state.seen,
      isTty,
      output,
      approveAll: Boolean(options.approveAll),
      confirm: (message) => inquirerConfirm({ message, default: false }),
      resolveContext: () => transport.holds.context(),
      approve: (ctx, id, auto) => transport.holds.approve(ctx, id, auto),
      reject: (ctx, id, reason) => transport.holds.reject(ctx, id, reason),
      ...(transport.kind === 'direct' && { answerHint: transport.holds.answerHint }),
    });
  } catch (err) {
    if (err instanceof HoldsUnavailableError) {
      state.unavailable = true;
      output(pc.yellow(`[kici] ${err.message}`));
    }
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
  return status.jobs.map((j) => ({
    name: j.jobName,
    status: j.status,
    // The summary table prints `-` for an unknown duration; a relay that does
    // not report one leaves it that way.
    ...(typeof j.durationMs === 'number' && { durationMs: j.durationMs }),
  }));
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
 * Run a specific workflow directly (bypass trigger matching), over the
 * resolved transport.
 */
async function runDirectWorkflow(
  workflowName: string,
  options: RemoteRunOptions,
): Promise<boolean> {
  if (!(await compileBeforeRemoteRun(options))) return false;

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

    // The run executes the local working tree. Stamp the real origin
    // `owner/repo` + provider when the tree has a recognized git remote, else a
    // synthetic `local/<repo>` identity so the dashboard never builds a broken
    // external link.
    const identity = buildLocalRepoIdentity(overlay.repoRoot);
    const payload: Record<string, unknown> = {
      repository: { full_name: identity.repoIdentifier, provider: identity.provider },
    };

    const encrypted = await buildEncryptedSecrets(
      overlay.kiciDir,
      options.envFlags,
      options.context,
      uploaded.publicKey,
    );

    const triggerResult = await ctx.trigger({
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
    const result = handleRunError(fixtureId, error, options, ctx.kind);
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
