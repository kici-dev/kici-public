/**
 * Invoke-gate executor.
 *
 * An invoke gate is a standard job whose only novel attribute is `invoke`: it
 * never dispatches steps to an agent. When the gate becomes ready the
 * orchestrator emits the gate's kici event at the source repo, matches the
 * repo's opt-in subscribers, dispatches each as a normal in-repo run, and
 * tracks each spawned run as a **proxy job** in the gate's own run.
 *
 * Correlation is a synchronous in-process match-and-dispatch — one orchestrator
 * serves one org, so the executor matches + dispatches through an injected
 * `summon` callback and gets the spawned run ids back directly. It ALSO persists
 * `summoned_by_run_id` / `summoned_by_proxy_job` on each spawned run so proxy
 * completion still resolves if the run finalizes on another HA instance.
 *
 * The gate itself is the aggregating graph node: downstream `needs` edges point
 * at the gate, and its proxies are its fan-out children (`base_job_name` = the
 * gate name). A zero-subscriber emit fails the gate by default; `optional: true`
 * makes it a green skip.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  TERMINAL_JOB_STATES,
  isFailureStatus,
  reservedEventNamePrefix,
} from '@kici-dev/engine';
import type { LockInvoke, LockJob } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { JobKind } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const logger = createLogger({ prefix: 'invoke-gate' });

/**
 * The invoke parameters carried from a gate's lock job to its (possibly deferred)
 * execution. Persisted on the pending job context so a gate released later — or
 * after a crash-recovery restore — still summons instead of reaching an agent.
 */
export interface InvokeGateParams {
  event: string;
  payload?: Record<string, unknown>;
  /** Require-by-default: false fails the gate on zero subscribers. */
  optional: boolean;
  /** Fan-out concurrency width applied to the gate's proxy children. */
  maxParallel?: number;
  /** Fan-out fail-fast policy applied to the gate's proxy children. */
  failFast?: boolean;
  /** The gate's own wall-clock timeout in ms (orchestrator-swept). */
  timeoutMs?: number;
}

/** Extract the invoke parameters from a lock job, or undefined when it is not a gate. */
export function invokeParamsFromLockJob(
  lockJob: Pick<LockJob, 'invoke' | 'maxParallel' | 'failFast' | 'timeout'> & {
    invoke?: LockInvoke;
  },
): InvokeGateParams | undefined {
  if (!lockJob.invoke) return undefined;
  return {
    event: lockJob.invoke.event,
    ...(lockJob.invoke.payload && { payload: { ...lockJob.invoke.payload } }),
    optional: lockJob.invoke.optional === true,
    ...(lockJob.maxParallel !== undefined && { maxParallel: lockJob.maxParallel }),
    ...(lockJob.failFast !== undefined && { failFast: lockJob.failFast }),
    ...(lockJob.timeout !== undefined && { timeoutMs: lockJob.timeout }),
  };
}

/** True when a lock job is an invoke gate (carries an `invoke` action). */
export function isInvokeGate(lockJob: Pick<LockJob, 'invoke'>): boolean {
  return lockJob.invoke !== undefined;
}

/**
 * A summon that was REFUSED, as opposed to one that matched nothing.
 *
 * The two are not the same verdict and must never render the same. A gate
 * carrying `optional: true` treats zero summoned runs as a green skip, so a
 * refusal returned as `[]` would report success for work that was declined.
 * Throwing this makes the confusion unrepresentable: {@link runInvokeGate}
 * fails the gate job with the reason, whatever order its own checks run in.
 */
export class SummonRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SummonRefusedError';
  }
}

/** One source-repo run summoned by an invoke gate. */
export interface SummonedRun {
  /** The spawned run's id. */
  runId: string;
  /** The source repo the run belongs to (`owner/repo`). */
  repo: string;
  /** The subscribing workflow's name. */
  workflow: string;
}

/** Arguments to the injected `summon` callback. */
export interface SummonArgs {
  event: string;
  payload?: Record<string, unknown>;
  sourceRepo: string;
  /** The chain depth to stamp on the summoned runs (already incremented). */
  chainDepth: number;
  /** The summoning gate's run id — tag each spawned run so its proxy resolves. */
  summonedByRunId: string;
}

/** Dependencies for {@link runInvokeGate}. */
export interface InvokeGateDeps {
  db: Kysely<Database>;
  /** Insert the proxy rows + mark the gate terminal on a zero-match emit. */
  executionTracker: Pick<
    ExecutionTracker,
    'addJobsToRun' | 'onJobStatus' | 'reconcileSummonedRunIfTerminal'
  >;
  /**
   * Match the source repo's subscribers to `event`, dispatch each as a normal
   * in-repo run, and return the spawned run ids. Implemented at the composition
   * root, where it reuses the orchestrator's event match + trust-policy path.
   *
   * An empty array means the event matched no subscriber — a real outcome a
   * gate may declare `optional`. A REFUSAL raises
   * {@link SummonRefusedError} instead, so the two can never be read as the
   * same thing.
   */
  summon: (args: SummonArgs) => Promise<SummonedRun[]>;
  /** Max chain depth allowed for a summon (the circuit breaker's bound). */
  maxChainDepth: number;
}

/** Arguments identifying the gate to run. */
export interface RunInvokeGateArgs {
  runId: string;
  gateJobId: string;
  gateJobName: string;
  event: string;
  payload?: Record<string, unknown>;
  /** When true, a zero-subscriber emit succeeds; when false it fails the gate. */
  optional: boolean;
  sourceRepo: string;
  chainDepth: number;
  /** Fan-out concurrency width stamped on the proxy children (`maxParallel`). */
  maxParallel?: number;
  /** Fan-out fail-fast policy stamped on the proxy children (`failFast`). */
  failFast?: boolean;
}

/**
 * Aggregate an invoke gate's status from its proxies' terminal statuses. The
 * gate stays open (`allTerminal: false`) until every proxy is terminal; then it
 * is `failed` if any proxy is a failure, else `success`. Pure — the tracker's
 * aggregation hook drives the DB reads and the gate transition.
 */
export function aggregateGateStatus(proxyStatuses: readonly string[]): {
  allTerminal: boolean;
  status?: ExecutionJobStatus;
} {
  if (!proxyStatuses.every((s) => TERMINAL_JOB_STATES.has(s))) {
    return { allTerminal: false };
  }
  const anyFailure = proxyStatuses.some((s) => isFailureStatus(s));
  return {
    allTerminal: true,
    status: anyFailure ? ExecutionJobStatus.enum.failed : ExecutionJobStatus.enum.success,
  };
}

/**
 * The message a gate naming a reserved event fails with.
 *
 * Exported so the gate executor and its test state the same string, and so the
 * SDK-side error can be compared against it.
 */
export function reservedEventMessage(event: string, prefix: string): string {
  return (
    `invoke gate cannot summon '${event}': the event-name prefix "${prefix}" is reserved for ` +
    `KiCI internal events. Choose a name a workflow may emit.`
  );
}

/** The message a require-by-default gate fails with when nothing subscribes. */
export function zeroSubscriberMessage(sourceRepo: string, event: string): string {
  return `no workflow in ${sourceRepo} subscribes to ${event}; declare optional: true to allow repos to opt out`;
}

/**
 * The proxy job name for a summoned run — the gate name, a `repo:workflow`
 * variant, and the summoned run id. The run id makes the name **unique per run**:
 * two summoned runs with the same `repo`+`workflow` (duplicate registrations)
 * would otherwise share one `job_name`, so the mirror's `job_name` lookup would
 * resolve one proxy and leave the other hanging. The human-readable label for the
 * graph is carried separately in `variant_label` (`repo:workflow`).
 */
export function proxyJobName(gateJobName: string, run: SummonedRun): string {
  return `${gateJobName} (${run.repo}:${run.workflow}) [${run.runId}]`;
}

/**
 * Run an invoke gate: summon the source repo's subscribers and create one proxy
 * child per spawned run. A zero-subscriber emit terminalizes the gate — failed
 * by default, success under `optional`. When the chain-depth bound is reached
 * the gate fails without summoning, so an invoke chain cannot loop.
 */
export async function runInvokeGate(deps: InvokeGateDeps, args: RunInvokeGateArgs): Promise<void> {
  const { runId, gateJobId, gateJobName, event, sourceRepo } = args;

  // The gate's event name comes from the WORKFLOW (`invokeSource('...')`), and
  // this path reaches the dispatcher without passing the `event.emit` guard —
  // no agent message, no `kici_events` row. So the same reservation is enforced
  // here, authoritatively: a gate naming `__schedule_fire` would otherwise
  // summon a run the classifier could read as orchestrator-minted, and one
  // naming `kici.scaler.scale-*` would forge a scaler event with an
  // author-chosen payload. The SDK refuses it first; this is the backstop.
  const reservedPrefix = reservedEventNamePrefix(event);
  if (reservedPrefix) {
    await deps.executionTracker.onJobStatus(
      runId,
      gateJobId,
      ExecutionJobStatus.enum.failed,
      Date.now(),
      undefined,
      { error: reservedEventMessage(event, reservedPrefix) },
    );
    logger.warn('Invoke gate refused: reserved event-name prefix', {
      runId,
      gateJobName,
      event,
      reservedPrefix,
    });
    return;
  }

  if (args.chainDepth >= deps.maxChainDepth) {
    await deps.executionTracker.onJobStatus(
      runId,
      gateJobId,
      ExecutionJobStatus.enum.failed,
      Date.now(),
      undefined,
      {
        error: `invoke chain depth ${args.chainDepth} reached the bound ${deps.maxChainDepth}; refusing to summon ${event}`,
      },
    );
    logger.warn('Invoke gate refused: chain depth bound reached', {
      runId,
      gateJobName,
      event,
      chainDepth: args.chainDepth,
      maxChainDepth: deps.maxChainDepth,
    });
    return;
  }

  let runs: SummonedRun[];
  try {
    runs = await deps.summon({
      event,
      payload: args.payload,
      sourceRepo,
      chainDepth: args.chainDepth + 1,
      summonedByRunId: runId,
    });
  } catch (err) {
    // A refused summon is a FAILURE of the gate, never a zero-subscriber skip —
    // `optional: true` must not turn a declined summon green. Anything else the
    // callback throws is a failure too, and failing the job here is what keeps
    // it from hanging with no terminal status.
    const reason =
      err instanceof SummonRefusedError
        ? err.message
        : `invoke gate summon failed: ${toErrorMessage(err)}`;
    await deps.executionTracker.onJobStatus(
      runId,
      gateJobId,
      ExecutionJobStatus.enum.failed,
      Date.now(),
      undefined,
      { error: reason },
    );
    logger.error('Invoke gate summon refused or failed', {
      runId,
      gateJobName,
      event,
      sourceRepo,
      reason,
    });
    return;
  }

  if (runs.length === 0) {
    await handleZeroSubscribers(deps, args);
    return;
  }

  await createProxies(deps, args, runs);
  logger.info('Invoke gate summoned subscribers', {
    runId,
    gateJobName,
    event,
    sourceRepo,
    proxyCount: runs.length,
  });
}

/** Dependencies for {@link releaseInvokeGate}. */
export interface ReleaseInvokeGateDeps {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  invokeGateDeps: InvokeGateDeps;
}

/**
 * Release a ready invoke gate: swap its synthetic needs-pending row for a real
 * `gate` job row, then run the gate executor. Reads the summoning run's source
 * repo and chain depth from `execution_runs` (the chain depth bounds recursion).
 * Shared by the needs-release path (`dispatchReadyJob`) and the root-gate
 * post-registration nudge, so both go through one code path.
 */
export async function releaseInvokeGate(
  deps: ReleaseInvokeGateDeps,
  runId: string,
  gateJobName: string,
  params: InvokeGateParams,
): Promise<void> {
  const runRow = await deps.db
    .selectFrom('execution_runs')
    .select(['repo_identifier', 'chain_depth'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!runRow) {
    logger.warn('Invoke gate release: run not found; cannot summon', { runId, gateJobName });
    return;
  }
  const sourceRepo = runRow.repo_identifier;
  const chainDepth = runRow.chain_depth ?? 0;

  // Swap the synthetic needs-pending placeholder for a real `gate` row, then
  // stamp it needs-satisfied (the synthetic row carried that flag; the fresh
  // INSERT defaults it to false) so the scheduler-invariant check does not read
  // the gate as stuck while it waits on its proxies.
  const gateJobId = randomUUID();
  const syntheticId = await deps.executionTracker.findSyntheticJobId(runId, gateJobName);
  await deps.executionTracker.addJobsToRun(
    runId,
    [
      {
        jobId: gateJobId,
        jobName: gateJobName,
        jobKind: JobKind.Gate,
        runsOnLabels: [],
        ...(params.timeoutMs !== undefined && { timeoutMs: params.timeoutMs }),
      },
    ],
    undefined,
    syntheticId,
  );
  await deps.db
    .updateTable('execution_jobs')
    .set({ needs_satisfied: true, ready_at: new Date() })
    .where('run_id', '=', runId)
    .where('job_id', '=', gateJobId)
    .execute();

  logger.info('Invoke gate ready; summoning source-repo subscribers', {
    runId,
    gateJobName,
    event: params.event,
    sourceRepo,
    chainDepth,
    optional: params.optional,
  });

  await runInvokeGate(deps.invokeGateDeps, {
    runId,
    gateJobId,
    gateJobName,
    event: params.event,
    ...(params.payload && { payload: params.payload }),
    optional: params.optional,
    sourceRepo,
    chainDepth,
    ...(params.maxParallel !== undefined && { maxParallel: params.maxParallel }),
    ...(params.failFast !== undefined && { failFast: params.failFast }),
  });
}

/** Zero subscribers: succeed under `optional`, fail (require-by-default) otherwise. */
async function handleZeroSubscribers(deps: InvokeGateDeps, args: RunInvokeGateArgs): Promise<void> {
  const { runId, gateJobId, gateJobName, event, sourceRepo, optional } = args;
  if (optional) {
    await deps.executionTracker.onJobStatus(
      runId,
      gateJobId,
      ExecutionJobStatus.enum.success,
      Date.now(),
    );
    logger.info('Invoke gate skipped: zero subscribers, optional', { runId, gateJobName, event });
    return;
  }
  await deps.executionTracker.onJobStatus(
    runId,
    gateJobId,
    ExecutionJobStatus.enum.failed,
    Date.now(),
    undefined,
    { error: zeroSubscriberMessage(sourceRepo, event) },
  );
  logger.warn('Invoke gate failed: zero subscribers, required', { runId, gateJobName, event });
}

/** Create one proxy child per spawned run and tag each spawned run for completion routing. */
async function createProxies(
  deps: InvokeGateDeps,
  args: RunInvokeGateArgs,
  runs: readonly SummonedRun[],
): Promise<void> {
  const { runId, gateJobName, maxParallel, failFast } = args;
  const bounded = maxParallel !== undefined && maxParallel >= 1;

  const proxies = runs.map((run, index) => ({
    jobId: randomUUID(),
    jobName: proxyJobName(gateJobName, run),
    baseJobName: gateJobName,
    variantKind: 'invoke',
    variantLabel: `${run.repo}:${run.workflow}`,
    jobKind: JobKind.Proxy,
    summonedRunId: run.runId,
    // Beyond the maxParallel window a proxy starts held; the wave scheduler
    // releases it when an in-flight sibling completes.
    ...(bounded && index >= maxParallel && { waveGated: true }),
    ...(bounded && { waveMaxParallel: maxParallel, waveFailFast: failFast ?? false }),
  }));

  await deps.executionTracker.addJobsToRun(runId, proxies);

  // Tag each spawned run with its summoning gate + proxy, so proxy completion
  // resolves even if the run finalizes on another HA instance. Then reconcile:
  // a run that already finalized before this tag landed read a null tag in the
  // mirror and skipped it, so drive the mirror now — otherwise its proxy never
  // terminalizes and the gate hangs until its timeout (forever with no timeout).
  for (let i = 0; i < runs.length; i++) {
    await deps.db
      .updateTable('execution_runs')
      .set({ summoned_by_run_id: runId, summoned_by_proxy_job: proxies[i].jobName })
      .where('run_id', '=', runs[i].runId)
      .execute();
    await deps.executionTracker.reconcileSummonedRunIfTerminal(runs[i].runId);
  }
}
