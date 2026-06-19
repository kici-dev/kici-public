/**
 * Re-run handler for the orchestrator.
 *
 * Loads an original completed run, retrieves its webhook payload from
 * object storage, re-fetches the lock file at the original SHA, and
 * dispatches a new run with parent_run_id linkage.
 *
 * This is NOT a reuse of processWebhook -- it's a separate, simpler function
 * that skips dedup, normalization, trigger matching, and changed files fetching.
 * It goes directly to: lock file parse -> job expansion -> dispatch.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, type ColdStore } from '@kici-dev/shared';
import { partitionMatchers } from '@kici-dev/engine';
import type { Kysely, Selectable } from 'kysely';
import type { Database, ExecutionRunTable } from '../db/types.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { JobQueue } from '../queue/job-queue.js';
import type { PlatformClient } from '../ws/platform-client.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { RunCoordinator } from '../cluster/coordinator.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { EventRouter } from '../events/event-router.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { SourceCache } from '../cache/index.js';
import type { BuildCoordinator } from '../cache/index.js';
import type { DepCache } from '../cache/index.js';
import type { PendingBuildTracker } from '../cache/index.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { JobToRoute, RunContext } from '../cluster/coordinator.js';
import {
  isLockStaticJob,
  TERMINAL_RUN_STATES,
  materializeFanout,
  matrixEnvelopeFields,
  FanoutError,
} from '@kici-dev/engine';
import type { LockFile as FullLockFile, LockWorkflow, MaterializedJob } from '@kici-dev/engine';

const ROUTE_JOBS_TIMEOUT_MS = 30_000;

const logger = createLogger({ prefix: 'rerun' });

/**
 * Thrown when a rerun is attempted on an archived run AND the cold-store
 * replay path failed (chunk missing, contentHash mismatch, S3 outage, or
 * cold-store probe disabled). Phase F replaced the Phase-C "rerun is
 * blocked" semantics with a real replay path; this error now signals
 * a genuine "we tried to bring the row back and could not".
 *
 * The WS dashboard handler maps this to a structured response that the
 * Platform proxy surfaces as HTTP 410 (`errorCode: 'runArchivedNotRerunnable'`).
 */
export class RunArchivedNotRerunnableError extends Error {
  readonly code = 'runArchivedNotRerunnable' as const;
  constructor(public readonly runId: string) {
    super(
      `Run ${runId} was archived to cold storage and the chunk could not be replayed back into the orchestrator DB. ` +
        `Rerun is not possible until the chunk is restored (kici-admin cold-store replay-into-pg).`,
    );
    this.name = 'RunArchivedNotRerunnableError';
  }
}

export interface RerunDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
  providerRegistry: ProviderRegistry;
  executionTracker: ExecutionTracker;
  dispatcher: Dispatcher;
  jobQueue: JobQueue;
  platformClient: PlatformClient | null;
  checkRunReporter: CheckRunReporter | null;
  coordinator: RunCoordinator | null;
  secretResolver: SecretResolver | null;
  eventRouter: EventRouter | null;
  agentRegistry: AgentRegistry;
  sourceCache: SourceCache | null;
  depCache: DepCache | null;
  buildCoordinator: BuildCoordinator | null;
  pendingBuilds: PendingBuildTracker | null;
  /**
   * Phase F — when set, a PG miss on `originalRunId` triggers a
   * cold-store replay of the chunk containing the row, then a re-read.
   * `null` keeps the legacy "throw RunArchivedNotRerunnableError on PG
   * miss" path for deployments without cold-store wired up.
   */
  coldStore: ColdStore | null;
}

/**
 * Original run row from execution_runs (selectAll).
 * Aliased to the Kysely Selectable so all column names stay typed
 * as the underlying schema.
 */
type OriginalRunRow = Selectable<ExecutionRunTable>;

/** Lock-file workflow + provider bundle resolved at the original SHA. */
interface ResolvedRerunWorkflow {
  workflow: LockWorkflow;
  fullLockFile: FullLockFile;
  providerContext: Record<string, unknown>;
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  /** Validated routing key (non-null — `resolveRerunWorkflow` throws on missing). */
  routingKey: string;
}

interface DispatchedJob {
  jobId: string;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  runsOnLabels?: string[];
}

interface RejectedJob {
  jobId: string;
  reason: string;
}

export async function handleRerun(
  originalRunId: string,
  triggeredBy: string | null,
  deps: RerunDeps,
  /**
   * Phase F — routing key for the original run, forwarded by Platform
   * via the WS `run.rerun.request` payload. Required to address the
   * cold-store chunk under the right tenant prefix.
   */
  routingKeyHint?: string,
): Promise<{ newRunId: string }> {
  // 1-3. Load + validate the original run (with cold-store replay fallback).
  const originalRun = await loadAndValidateOriginalRun(originalRunId, routingKeyHint, deps);

  // 4. Load webhook payload from object storage (optional — cron/schedule runs have no payload)
  const payload = await loadWebhookPayload(originalRunId, deps);

  // 5. Re-fetch lock file at original SHA + resolve provider bundle.
  const resolved = await resolveRerunWorkflow(originalRun, deps);

  // 6. Build new-run identity (commit message, lineage chain).
  const newRunId = randomUUID();
  const rootRunId = originalRun.original_run_id ?? originalRunId;
  const commitMessage = extractCommitMessage(payload);

  logger.info('Re-running workflow', {
    originalRunId,
    newRunId,
    rootRunId,
    workflowName: originalRun.workflow_name,
    sha: originalRun.sha,
    triggeredBy,
  });

  // Store payload for the new run (so it also has a payload available for the payload viewer
  // and for a future re-run of the re-run). Skip if there was no payload (cron/schedule runs).
  if (payload) {
    const newPayloadPath = `executions/${newRunId}/webhook-payload.json`;
    await deps.logStorage.append(newPayloadPath, JSON.stringify(payload));
  }

  // 7a. Record execution start BEFORE dispatch so that when jobs are rerouted
  // to peers, the coordinator's rerouted onExecutionStarted call (which lacks
  // rerun-specific metadata like parentRunId) hits ON CONFLICT DO NOTHING and
  // preserves the rich row we insert here. Jobs are added below via
  // executionTracker.addJobsToRun once dispatched locally.
  await recordRerunExecutionStart({
    deps,
    newRunId,
    originalRun,
    originalRunId,
    rootRunId,
    workflow: resolved.workflow,
    providerContext: resolved.providerContext,
    triggeredBy,
    commitMessage,
  });

  // 7b. Dispatch: coordinator-routed (cluster mode) or direct (standalone).
  const { dispatchedJobs, rejectedJobs } = await dispatchRerunJobs({
    deps,
    newRunId,
    originalRun,
    resolved,
    payload,
  });

  // 7c. Register dispatched jobs with the execution tracker (dispatcher-assigned IDs).
  if (dispatchedJobs.length > 0) {
    await deps.executionTracker.addJobsToRun(newRunId, dispatchedJobs);

    // Mark rejected jobs as failed (standalone-fallback path only — the coordinator
    // logs failed jobs separately and does not produce synthetic rejected IDs).
    for (const { jobId, reason } of rejectedJobs) {
      await deps.executionTracker.onJobStatus(newRunId, jobId, 'failed', Date.now(), undefined, {
        error: reason,
      });
    }
  }

  // 8 + 9. Fire workflow.rerun event + GitHub check run.
  await emitRerunEventAndCheckRun({
    deps,
    originalRun,
    originalRunId,
    newRunId,
    workflow: resolved.workflow,
    providerContext: resolved.providerContext,
    triggeredBy,
  });

  return { newRunId };
}

/**
 * Phase 1-3: load the original run from the orchestrator DB, attempting a
 * cold-store replay if the row is missing, then validate that the run is
 * in a terminal state and is not a test run. Throws on any precondition
 * failure.
 */
async function loadAndValidateOriginalRun(
  originalRunId: string,
  routingKeyHint: string | undefined,
  deps: RerunDeps,
): Promise<OriginalRunRow> {
  // 1. Load original run from DB
  let originalRun = await deps.db
    .selectFrom('execution_runs')
    .selectAll()
    .where('run_id', '=', originalRunId)
    .executeTakeFirst();

  if (!originalRun) {
    // Phase F: attempt to restore the row from cold-store before failing.
    // Requires (a) cold-store wired into deps, and (b) Platform forwarded
    // `routingKey` over the WS protocol so we know which tenant prefix
    // to scan. Both conditions hold for the standard hybrid deploy; a
    // standalone orchestrator without Platform forwarding falls through
    // to the legacy error.
    if (deps.coldStore && routingKeyHint) {
      try {
        const replay = await deps.coldStore.replayRow({
          db: 'orchestrator',
          table: 'execution_runs',
          tenantId: routingKeyHint,
          rowId: originalRunId,
        });
        if (replay.chunkId) {
          originalRun = await deps.db
            .selectFrom('execution_runs')
            .selectAll()
            .where('run_id', '=', originalRunId)
            .executeTakeFirst();
          logger.info('rerun: restored archived run from cold-store', {
            runId: originalRunId,
            chunkId: replay.chunkId,
            inserted: replay.inserted,
            skipped: replay.skipped,
            routingKey: routingKeyHint,
          });
        }
      } catch (err) {
        logger.error('rerun: cold-store replayRow threw', {
          runId: originalRunId,
          routingKey: routingKeyHint,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new RunArchivedNotRerunnableError(originalRunId);
      }
    }
    if (!originalRun) {
      // Cold-store unavailable, no chunk found, or replay returned no
      // rows. Surface the structured error so the Platform proxy can
      // render HTTP 410 with `errorCode: 'runArchivedNotRerunnable'`.
      throw new RunArchivedNotRerunnableError(originalRunId);
    }
  }

  // 2. Validate terminal state
  if (!TERMINAL_RUN_STATES.has(originalRun.status)) {
    throw new Error(`Run is not in a terminal state (current: ${originalRun.status})`);
  }

  // 3. Only webhook runs can be re-run (not test runs)
  if (originalRun.is_test_run) {
    throw new Error('Test runs cannot be re-run');
  }

  return originalRun as OriginalRunRow;
}

/**
 * Phase 4: load the original webhook payload from object storage. Returns
 * null for cron/schedule runs (no payload was stored) or when the payload
 * cannot be parsed.
 */
async function loadWebhookPayload(
  originalRunId: string,
  deps: RerunDeps,
): Promise<Record<string, unknown> | null> {
  const payloadPath = `executions/${originalRunId}/webhook-payload.json`;
  const payloadResult = await deps.logStorage.read(payloadPath);
  if (!payloadResult.data) return null;
  try {
    return JSON.parse(payloadResult.data);
  } catch {
    // Corrupted or unparseable payload — treat as missing
    return null;
  }
}

/**
 * Phase 5: re-fetch the lock file at the original SHA and locate the
 * workflow that was originally run. Throws on missing routing_key,
 * unregistered provider, missing lock-file fetcher, missing lock file,
 * or workflow not present in the lock file.
 */
async function resolveRerunWorkflow(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): Promise<ResolvedRerunWorkflow> {
  if (!originalRun.routing_key) {
    throw new Error(
      `Re-run failed: original run ${originalRun.run_id} has no routing_key — cannot select provider bundle`,
    );
  }
  const providerBundle = deps.providerRegistry.getByRoutingKey(originalRun.routing_key);
  if (!providerBundle) {
    throw new Error(`Provider bundle for routing key ${originalRun.routing_key} not registered`);
  }

  if (!providerBundle.lockFileFetcher) {
    throw new Error(`Provider ${originalRun.provider} does not support lock file fetching`);
  }

  const providerContext = JSON.parse(
    typeof originalRun.provider_context === 'string'
      ? originalRun.provider_context
      : JSON.stringify(originalRun.provider_context ?? {}),
  );

  const lockFile = await providerBundle.lockFileFetcher.fetchLockFile(
    originalRun.repo_identifier,
    originalRun.sha,
    providerContext,
  );

  if (!lockFile) {
    throw new Error('Lock file not found at original SHA (branch may have been force-pushed)');
  }

  const fullLockFile = lockFile as unknown as FullLockFile;

  // Find the workflow that was originally run
  const workflow = fullLockFile.workflows.find(
    (w: LockWorkflow) => w.name === originalRun.workflow_name,
  );
  if (!workflow) {
    throw new Error(
      `Workflow '${originalRun.workflow_name}' not found in lock file at SHA ${originalRun.sha}`,
    );
  }

  return {
    workflow,
    fullLockFile,
    providerContext,
    providerBundle,
    routingKey: originalRun.routing_key,
  };
}

/**
 * Phase 6 helper: extract a single-line commit message from the original
 * webhook payload (push.head_commit.message or pull_request.title).
 * Returns undefined for cron/schedule runs (no payload).
 */
function extractCommitMessage(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const headCommit = (payload as { head_commit?: { message?: string } }).head_commit;
  const prTitle = (payload as { pull_request?: { title?: string } }).pull_request?.title;
  return headCommit?.message?.split('\n')[0] ?? prTitle ?? undefined;
}

/**
 * Phase 7a: insert the new execution_runs row up-front so that coordinator
 * reroutes (which call onExecutionStarted from the peer side without
 * rerun-specific metadata) hit ON CONFLICT DO NOTHING and preserve the
 * rich row we wrote here.
 */
async function recordRerunExecutionStart(opts: {
  deps: RerunDeps;
  newRunId: string;
  originalRun: OriginalRunRow;
  originalRunId: string;
  rootRunId: string;
  workflow: LockWorkflow;
  providerContext: Record<string, unknown>;
  triggeredBy: string | null;
  commitMessage: string | undefined;
}): Promise<void> {
  const {
    deps,
    newRunId,
    originalRun,
    originalRunId,
    rootRunId,
    workflow,
    providerContext,
    triggeredBy,
    commitMessage,
  } = opts;

  await deps.executionTracker.onExecutionStarted(
    newRunId,
    workflow.name,
    originalRun.provider,
    originalRun.repo_identifier,
    originalRun.ref,
    originalRun.sha,
    `rerun:${newRunId}`,
    providerContext,
    null, // No trigger decision for re-runs
    [], // jobs added after dispatch via addJobsToRun
    originalRun.routing_key ?? undefined,
    undefined, // contexts
    'rerun', // triggerEvent — marks as user-initiated re-run
    commitMessage, // commitMessage from original webhook payload
    originalRunId, // parentRunId
    triggeredBy, // triggeredBy
    rootRunId, // originalRunId — root ancestor for lineage chain
    workflow.concurrency
      ? {
          cancelInProgress: workflow.concurrency.cancelInProgress,
          max: workflow.concurrency.max,
        }
      : undefined,
    workflow.timeout, // workflowTimeoutMs
  );
}

/**
 * Phase 7b: dispatch jobs either via the cluster coordinator (which tries
 * local first, then reroutes to peers whose scalers can satisfy the labels)
 * or, in standalone mode / on coordinator timeout, directly via the local
 * dispatcher. Returns the job IDs registered with the execution tracker
 * plus any synthetic-rejected IDs that need to be marked failed.
 */
async function dispatchRerunJobs(opts: {
  deps: RerunDeps;
  newRunId: string;
  originalRun: OriginalRunRow;
  resolved: ResolvedRerunWorkflow;
  payload: Record<string, unknown> | null;
}): Promise<{ dispatchedJobs: DispatchedJob[]; rejectedJobs: RejectedJob[] }> {
  const { deps, newRunId, originalRun, resolved, payload } = opts;
  const { workflow, fullLockFile, providerContext, providerBundle, routingKey } = resolved;

  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const dispatchedJobs: DispatchedJob[] = [];
  const rejectedJobs: RejectedJob[] = [];
  const repoUrl = providerBundle.repoUrlBuilder?.buildCloneUrl(originalRun.repo_identifier) ?? '';

  // Re-materialize the matrix fresh from the current lock content (re-expansion,
  // not cloning prior child rows). A matrix that can no longer expand fails that
  // job; the rest of the rerun proceeds.
  let materializedJobs: MaterializedJob[] = [];
  try {
    materializedJobs = materializeFanout(staticJobs).jobs;
  } catch (err) {
    if (err instanceof FanoutError) {
      const syntheticId = `rejected-${randomUUID()}`;
      dispatchedJobs.push({ jobId: syntheticId, jobName: err.jobName, runsOnLabels: undefined });
      rejectedJobs.push({ jobId: syntheticId, reason: err.message });
      materializedJobs = materializeFanout(staticJobs.filter((j) => j.name !== err.jobName)).jobs;
    } else {
      throw err;
    }
  }

  const buildRerunJobConfig = (mat: MaterializedJob) => {
    const job = mat.lockJob;
    return {
      source: workflow.source ?? fullLockFile.source,
      workflowName: workflow.name,
      ...matrixEnvelopeFields(mat),
      steps: job.steps,
      needs: job.needs,
      rules: job.rules,
      ...(workflow.contentHash && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
    };
  };

  const installationId =
    typeof (providerContext as { installationId?: unknown }).installationId === 'number'
      ? ((providerContext as { installationId: number }).installationId as number)
      : undefined;

  const matrixByName = new Map<string, Record<string, unknown>>();
  for (const mj of materializedJobs) {
    if (mj.variantValues) matrixByName.set(mj.expandedName, mj.variantValues);
  }

  let routedViaCoordinator = false;
  if (deps.coordinator && materializedJobs.length > 0) {
    const jobsToRoute: JobToRoute[] = materializedJobs.map((mat) => {
      const job = mat.lockJob;
      const runsOnSel = partitionMatchers(job.runsOn ?? []);
      const excludeSel = partitionMatchers(job.excludeLabels ?? []);
      return {
        jobName: mat.expandedName,
        runsOnLabels: [runsOnSel.exact],
        runsOnPatterns: runsOnSel.regex,
        excludeLabels: excludeSel.exact,
        excludePatterns: excludeSel.regex,
        jobConfig: buildRerunJobConfig(mat),
        repoUrl,
        ref: originalRun.ref,
        sha: originalRun.sha,
        ...(job.resources && { resources: job.resources }),
      };
    });

    const runCtx: RunContext = {
      runId: newRunId,
      deliveryId: `rerun:${newRunId}`,
      routingKey,
      event: 'rerun',
      action: null,
      provider: originalRun.provider,
      payload: (payload as Record<string, unknown> | undefined) ?? {},
      repoIdentifier: originalRun.repo_identifier,
      sha: originalRun.sha,
      ref: originalRun.ref,
      workflowName: workflow.name,
      ...(installationId !== undefined && { installationId }),
    };

    const routeResult = await Promise.race([
      deps.coordinator.routeJobs(runCtx, jobsToRoute),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`routeJobs timed out after ${ROUTE_JOBS_TIMEOUT_MS}ms`)),
          ROUTE_JOBS_TIMEOUT_MS,
        ),
      ),
    ]).catch((err: unknown) => {
      logger.warn('Coordinator routing timed out for rerun, falling back to direct dispatch', {
        newRunId,
        workflow: workflow.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    if (routeResult) {
      routedViaCoordinator = true;
      for (const local of routeResult.localJobs) {
        const runsOnLabels = (() => {
          const mat = materializedJobs.find((m) => m.expandedName === local.jobName);
          const job = mat?.lockJob;
          return job ? partitionMatchers(job.runsOn ?? []).exact : undefined;
        })();
        const matrixValues = matrixByName.get(local.jobName);
        dispatchedJobs.push({
          jobId: local.jobId,
          jobName: local.jobName,
          ...(matrixValues && { matrixValues }),
          runsOnLabels,
        });
      }
      for (const rerouted of routeResult.reroutedJobs) {
        logger.info('Re-run job rerouted to peer', {
          newRunId,
          workflow: workflow.name,
          job: rerouted.jobName,
          peerId: rerouted.peerId,
        });
      }
      for (const failed of routeResult.failedJobs) {
        logger.warn('Re-run job routing failed', {
          newRunId,
          workflow: workflow.name,
          job: failed.jobName,
          reason: failed.reason,
        });
      }
    }
  }

  if (!routedViaCoordinator) {
    // Standalone mode OR coordinator timeout: direct dispatch locally.
    for (const mat of materializedJobs) {
      const job = mat.lockJob;
      const matrixValues = mat.variantValues;
      const runsOnSel = partitionMatchers(job.runsOn ?? []);
      const excludeSel = partitionMatchers(job.excludeLabels ?? []);
      const runsOnLabels = runsOnSel.exact;
      const jobInput: QueuedJobInput = {
        runId: newRunId,
        workflowName: workflow.name,
        jobName: mat.expandedName,
        runsOnLabels,
        runsOnPatterns: runsOnSel.regex,
        excludeLabels: excludeSel.exact,
        excludePatterns: excludeSel.regex,
        jobConfig: buildRerunJobConfig(mat),
        repoUrl,
        ref: originalRun.ref,
        sha: originalRun.sha,
        deliveryId: `rerun:${newRunId}`,
        provider: originalRun.provider,
        providerContext: providerContext as Record<string, unknown>,
        routingKey,
      };

      const result = await deps.dispatcher.dispatch(jobInput);
      if (result.status === 'rejected') {
        const syntheticId = `rejected-${randomUUID()}`;
        dispatchedJobs.push({
          jobId: syntheticId,
          jobName: mat.expandedName,
          ...(matrixValues && { matrixValues }),
          runsOnLabels,
        });
        rejectedJobs.push({ jobId: syntheticId, reason: result.reason });
      } else {
        dispatchedJobs.push({
          jobId: result.jobId,
          jobName: mat.expandedName,
          ...(matrixValues && { matrixValues }),
          runsOnLabels,
        });
      }

      logger.info('Re-run job dispatched', {
        newRunId,
        workflow: workflow.name,
        job: mat.expandedName,
        status: result.status,
      });
    }
  }

  return { dispatchedJobs, rejectedJobs };
}

/**
 * Phase 8 + 9: emit the workflow.rerun system event via the EventRouter
 * and create a pending GitHub check run for the new run.
 */
async function emitRerunEventAndCheckRun(opts: {
  deps: RerunDeps;
  originalRun: OriginalRunRow;
  originalRunId: string;
  newRunId: string;
  workflow: LockWorkflow;
  providerContext: Record<string, unknown>;
  triggeredBy: string | null;
}): Promise<void> {
  const { deps, originalRun, originalRunId, newRunId, workflow, providerContext, triggeredBy } =
    opts;

  // 8. Emit workflow.rerun system event via EventRouter (renumbered from 9)
  if (deps.eventRouter) {
    await deps.eventRouter.emit({
      eventName: 'workflow.rerun',
      payload: {
        parentRunId: originalRunId,
        newRunId,
        workflowName: workflow.name,
        repo: originalRun.repo_identifier,
        sha: originalRun.sha,
        triggeredBy,
      },
      sourceRepo: originalRun.repo_identifier,
      sourceRoutingKey: originalRun.routing_key ?? undefined,
    });
  }

  // 9. Create GitHub check run for the re-run
  if (deps.checkRunReporter) {
    const [owner, repo] = originalRun.repo_identifier.split('/');
    const staticJobs = workflow.jobs.filter(isLockStaticJob);
    const jobNames = staticJobs.map((j) => j.name);

    deps.checkRunReporter.setPending({
      provider: originalRun.provider,
      owner,
      repo,
      sha: originalRun.sha,
      workflowName: workflow.name,
      jobNames,
      installationId: (providerContext as { installationId?: number }).installationId,
      routingKey: originalRun.routing_key ?? undefined,
    });
  }
}
