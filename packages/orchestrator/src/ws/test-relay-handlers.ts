/**
 * Orchestrator-side handlers for the `kici run remote` control plane. Two
 * transports call them: the Platform relays the `test.relay.*` requests over
 * the authenticated dashboard-proxy WS connection, and the direct test-run
 * routes (`routes/test-direct.ts`, `/api/v1/test/*`) serve the same actions
 * over HTTP to a caller holding an orchestrator admin token.
 *
 * The control plane carries only small JSON: the overlay tarball never reaches
 * the Platform; the developer PUTs it to a presigned URL.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  AccessLogSource,
  ExecutionRunStatus,
  TERMINAL_RUN_STATES,
  stringifyActor,
} from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import type {
  TestRelayRequest,
  TestRelayUploadsInitRequest,
  TestRelayTriggerRequest,
  TestRelayRunStatusRequest,
  TestRelayRunLogsRequest,
  TestRelayCancelRequest,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { CacheStorage } from '../storage/types.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { initTestUpload } from '../routes/uploads.js';
import { processTestTrigger } from '../pipeline/test-pipeline.js';
import type { ProcessingDeps } from '../pipeline/processor.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'test-relay' });

// The `done` flag uses the engine's `TERMINAL_RUN_STATES`, never a local copy: a
// duplicate misses a new terminal status and reports `done: false` forever.

export interface TestRelayHandlerDeps extends ProcessingDeps {
  db: Kysely<Database>;
  /** Required: the cancel handler resolves the job's agent. */
  agentRegistry: NonNullable<ProcessingDeps['agentRegistry']>;
  cacheStorage?: CacheStorage;
  logStorage?: LogStorage;
  // The inherited `logWriter` is drained for a terminal run before the logs
  // handler computes `done`, so the final fire-and-forget chunk is never lost.
  accessLog?: AccessLogWriter;
  /** Canonical org id this orchestrator is bound to, for access_log attribution. */
  orgId?: string | null;
  /** Routing key resolved for the bound org, for access_log attribution. */
  routingKey?: string | null;
  /**
   * The transport recorded on access_log rows: `admin_http` for the direct
   * test-run routes. Defaults to `platform_proxy`, the relay's own source.
   */
  accessLogSource?: AccessLogSource;
}

export interface TestUploadsInitPayload {
  uploadId: string;
  signedUrl: string;
  publicKey: string;
  expiresIn: number;
}

/**
 * Mint an upload record + the presigned PUT URL. The developer's PAT identity
 * (`msg.actor`) is recorded as the upload owner.
 */
export async function handleTestUploadsInit(
  msg: TestRelayUploadsInitRequest,
  deps: TestRelayHandlerDeps,
): Promise<TestUploadsInitPayload> {
  return initTestUpload(
    { db: deps.db, cacheStorage: deps.cacheStorage },
    {
      routingKey: msg.routingKey,
      sha: msg.sha,
      fileCount: msg.fileCount,
      compressedSize: msg.compressedSize,
      createdBy: stringifyActor(msg.actor),
    },
  );
}

export interface TestTriggerPayload {
  runId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
  jobIds: string[];
  /** User-visible warnings on acceptance (e.g. skipped non-test bound environments). */
  warnings?: string[];
}

/**
 * Resolve the overlay tarball URL + decryption keys from the upload record, then
 * run the existing `processTestTrigger` pipeline with `routingKey = remote:<orgId>`.
 * The developer's PAT identity is written to `access_log` (`run.trigger`).
 */
export async function handleTestTrigger(
  msg: TestRelayTriggerRequest,
  deps: TestRelayHandlerDeps,
): Promise<TestTriggerPayload> {
  // The overlay decrypts with the CLI's ephemeral X25519 `cliPublicKey` plus the
  // upload's stored private key — never `encryptedSecretsKey`, which keys only
  // the optional secrets blob and is absent on runs with no secrets.
  const cliPublicKey = msg.cliPublicKey;
  let resolvedOverlay:
    { tarballUrl: string; cliPublicKey: string; orchestratorPrivateKey: string } | undefined;

  if (msg.uploadId && cliPublicKey && deps.cacheStorage) {
    const upload = await deps.db
      .selectFrom('test_uploads')
      .select(['storage_key', 'encryption_private_key'])
      .where('upload_id', '=', msg.uploadId)
      .executeTakeFirst();

    if (upload?.storage_key && upload.encryption_private_key) {
      // Presigned uploads set no S3 metadata, which getUrl() requires.
      await deps.cacheStorage.initMeta(upload.storage_key);
      const tarballUrl = await deps.cacheStorage.getUrl(upload.storage_key);
      if (tarballUrl) {
        resolvedOverlay = {
          tarballUrl,
          cliPublicKey,
          orchestratorPrivateKey: upload.encryption_private_key,
        };
      }
    }
  }

  const result = await processTestTrigger(
    {
      fixtureId: msg.fixtureId,
      event: msg.event,
      routingKey: msg.routingKey,
      uploadId: msg.uploadId,
      resolvedOverlay,
      secrets: msg.secrets,
      encryptedSecrets: msg.encryptedSecrets,
      encryptedSecretsKey: msg.encryptedSecretsKey,
      workflowName: msg.workflowName,
      inlineLockFile: msg.inlineLockFile,
      fullRepo: msg.fullRepo,
      checkMode: msg.checkMode,
      target: msg.target,
      dispatchInputs: msg.dispatchInputs,
      requestId: msg.requestId,
      // Attribution, not authorization: see `handleTestRunStatus`.
      actor: msg.actor,
    },
    deps,
  );

  runDetached(
    logger,
    'Access log write',
    () =>
      deps.accessLog?.record({
        orgId: deps.orgId ?? null,
        routingKey: deps.routingKey ?? msg.routingKey,
        actor: msg.actor,
        action: 'run.trigger',
        target: { type: 'run', id: result.runId },
        requestId: msg.requestId,
        source: deps.accessLogSource ?? AccessLogSource.enum.platform_proxy,
        outcome: result.status === 'accepted' ? 'allowed' : 'denied',
        ...(result.reason ? { errorMessage: result.reason } : {}),
      }),
    { requestId: msg.requestId, runId: result.runId },
  );

  return {
    runId: result.runId,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    jobIds: result.jobIds,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

export interface TestRunStatusPayload {
  runId: string;
  status: string;
  jobs: Array<{
    jobId: string;
    jobName: string;
    status: string;
    errorMessage?: string | null;
    /** Wall-clock; null while the job runs. */
    durationMs?: number | null;
  }>;
  done: boolean;
}

/**
 * Snapshot a run's status + per-job status. `done` is true at a terminal run state.
 *
 * ## Why this does not check ownership against `execution_runs.triggered_by`
 *
 * The idea recurs; it is not free defence in depth:
 *
 * - **The orchestrator cannot authenticate the actor.** The Platform asserts it;
 *   a lying Platform names any principal and passes, so the check stops only a
 *   faithful Platform that forgot to check ownership.
 * - **The two gates would disagree.** The Platform also admits a caller with
 *   unrestricted repository scope (who can already read these runs on the
 *   dashboard run plane). Only the actor reaches this tier, so an org owner
 *   allowed there is refused here; fixing that needs the Platform to assert
 *   "unrestricted", the first problem again.
 * - **Version skew runs the wrong way.** This customer-deployed component
 *   versions independently, so an upgrade that enforces refuses legitimate reads
 *   against an unchanged Platform — a break we cannot roll back. Fail-closed is
 *   right for a security control and wrong for a compatibility surface; this is
 *   both.
 *
 * Enforcing needs the caller's effective authorization scope on the wire (one
 * policy, not two) and an actor this tier can establish independently.
 */
export async function handleTestRunStatus(
  msg: TestRelayRunStatusRequest,
  deps: TestRelayHandlerDeps,
): Promise<TestRunStatusPayload | { error: string }> {
  const run = await deps.db
    .selectFrom('execution_runs')
    .select(['run_id', 'status', 'is_test_run'])
    .where('run_id', '=', msg.runId)
    .executeTakeFirst();

  if (!run || !run.is_test_run) {
    return { error: 'Run not found' };
  }

  const jobs = await deps.db
    .selectFrom('execution_jobs')
    .select(['job_id', 'job_name', 'status', 'error_message', 'duration_ms'])
    .where('run_id', '=', msg.runId)
    .execute();

  return {
    runId: run.run_id,
    status: run.status,
    jobs: jobs.map((j) => ({
      jobId: j.job_id,
      jobName: j.job_name,
      status: j.status,
      errorMessage: j.error_message ?? null,
      durationMs: j.duration_ms ?? null,
    })),
    done: TERMINAL_RUN_STATES.has(run.status),
  };
}

export interface TestRunLogsPayload {
  lines: string[];
  nextCursor: number;
  done: boolean;
}

/**
 * Match `executions/<runId>/job-<name>/step-<index>.log`, including a job's
 * workflow-level setup log, step -1, which sorts ahead of the job's steps.
 */
const LOG_PATH_RE = /job-([^/]+)\/step-(-?\d+)\.log$/;

/**
 * Return the next chunk of a run's logs from a monotonic line-offset cursor:
 * lines are concatenated in `(jobName ASC, stepIndex ASC, lineIndex ASC)` order
 * and `cursor` counts lines already delivered. `done` is true only when the run
 * is terminal AND the cursor reached the end, so a live or not-yet-drained poll
 * returns what exists with `done: false` and no line is dropped.
 */
export async function handleTestRunLogs(
  msg: TestRelayRunLogsRequest,
  deps: TestRelayHandlerDeps,
): Promise<TestRunLogsPayload | { error: string }> {
  const run = await deps.db
    .selectFrom('execution_runs')
    .select(['run_id', 'status', 'is_test_run'])
    .where('run_id', '=', msg.runId)
    .executeTakeFirst();

  if (!run || !run.is_test_run) {
    return { error: 'Run not found' };
  }

  const terminal = TERMINAL_RUN_STATES.has(run.status);
  // Chunks persist fire-and-forget, so a run can turn terminal with the last
  // write pending; draining first means `done: true` never omits the last line.
  if (terminal) await deps.logWriter?.drain(msg.runId);
  const allLines = await collectRunLogLines(msg.runId, deps.logStorage);

  const cursor = Math.max(0, msg.cursor);
  const lines = allLines.slice(cursor);
  const nextCursor = cursor + lines.length;
  // A terminal-but-not-caught-up poll returns done:false; the CLI polls once more.
  const done = terminal && nextCursor >= allLines.length;

  return { lines, nextCursor, done };
}

/** Reads every step log under `executions/<runId>`; empty with no log storage. */
async function collectRunLogLines(
  runId: string,
  logStorage: LogStorage | undefined,
): Promise<string[]> {
  if (!logStorage) return [];

  const prefix = `executions/${runId}`;
  const allFiles = await logStorage.list(prefix);

  const logFiles = allFiles
    .map((f) => {
      const m = f.match(LOG_PATH_RE);
      return m ? { path: f, jobName: m[1], stepIndex: parseInt(m[2], 10) } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => a.jobName.localeCompare(b.jobName) || a.stepIndex - b.stepIndex);

  const lines: string[] = [];
  for (const entry of logFiles) {
    const result = await logStorage.read(entry.path);
    for (const line of result.data.split('\n')) {
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

export interface TestCancelPayload {
  cancelled: boolean;
}

/**
 * Cancel a running test run: signal cancellation to every dispatched agent,
 * mark still-pending dispatch queue entries `expired`, and mark the
 * `execution_runs` row cancelled. Returns `{ cancelled }` — true when the run
 * existed, was a test run, and was not already terminal.
 */
export async function handleTestCancel(
  msg: TestRelayCancelRequest,
  deps: TestRelayHandlerDeps,
): Promise<TestCancelPayload | { error: string }> {
  const runId = msg.runId;
  if (!runId) {
    return { error: 'runId required' };
  }

  const run = await deps.db
    .selectFrom('execution_runs')
    .select(['run_id', 'status', 'is_test_run'])
    .where('run_id', '=', runId)
    .executeTakeFirst();

  if (!run) {
    return { error: 'Run not found' };
  }
  if (!run.is_test_run) {
    return { error: 'Cannot cancel non-test runs via this endpoint' };
  }
  if (TERMINAL_RUN_STATES.has(run.status)) {
    return { cancelled: false };
  }

  const jobs = await deps.db
    .selectFrom('dispatch_queue')
    .select(['id', 'status'])
    .where('run_id', '=', runId)
    .where('status', 'in', [DispatchQueueStatus.Pending, DispatchQueueStatus.Dispatched])
    .execute();

  for (const job of jobs) {
    const agentId = deps.dispatcher.getAgentIdForJob(job.id);
    if (!agentId) continue;
    const entry = deps.agentRegistry.get(agentId);
    if (entry?.ws) {
      entry.ws.send(
        JSON.stringify({
          type: 'job.cancel',
          messageId: randomUUID(),
          runId,
          jobId: job.id,
          reason: 'test run cancelled via relay',
        }),
      );
    }
  }

  const pendingIds = jobs.filter((j) => j.status === DispatchQueueStatus.Pending).map((j) => j.id);
  if (pendingIds.length > 0) {
    // `expired` is the terminal status a cancelled queue row takes, the one
    // `JobQueue.cancelByRunId` writes, so the prune and the scrub cover it.
    await deps.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Expired })
      .where('id', 'in', pendingIds)
      .execute();
  }

  await deps.db
    .updateTable('execution_runs')
    .set({ status: ExecutionRunStatus.enum.cancelled })
    .where('run_id', '=', runId)
    .execute();

  runDetached(
    logger,
    'Access log write',
    () =>
      deps.accessLog?.record({
        orgId: deps.orgId ?? null,
        routingKey: deps.routingKey ?? null,
        actor: msg.actor,
        action: 'run.cancel',
        target: { type: 'run', id: runId },
        requestId: msg.requestId,
        source: deps.accessLogSource ?? AccessLogSource.enum.platform_proxy,
        outcome: 'allowed',
      }),
    { requestId: msg.requestId, runId },
  );

  return { cancelled: true };
}

/**
 * Build the full response envelope (`type` + `requestId` + payload) the caller
 * relays via `sendRaw`. `{ error }` results ride the `error` field; a thrown error
 * propagates, and the caller sends it on the same field. The Platform maps the
 * structured response to an HTTP status.
 */
export async function dispatchTestRelay(
  msg: TestRelayRequest,
  deps: TestRelayHandlerDeps,
): Promise<Record<string, unknown>> {
  switch (msg.type) {
    case 'test.relay.uploads.init': {
      const payload = await handleTestUploadsInit(msg, deps);
      return { type: 'test.relay.uploads.init.response', requestId: msg.requestId, ...payload };
    }
    case 'test.relay.trigger': {
      const payload = await handleTestTrigger(msg, deps);
      return { type: 'test.relay.trigger.response', requestId: msg.requestId, ...payload };
    }
    case 'test.relay.run.status': {
      const payload = await handleTestRunStatus(msg, deps);
      return { type: 'test.relay.run.status.response', requestId: msg.requestId, ...payload };
    }
    case 'test.relay.run.logs': {
      const payload = await handleTestRunLogs(msg, deps);
      return { type: 'test.relay.run.logs.response', requestId: msg.requestId, ...payload };
    }
    case 'test.relay.cancel': {
      const payload = await handleTestCancel(msg, deps);
      return { type: 'test.relay.cancel.response', requestId: msg.requestId, ...payload };
    }
  }
}
