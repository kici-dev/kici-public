/**
 * Orchestrator-side handlers for the Platform-relayed `kici run remote` control
 * plane. The Platform relays five `test.relay.*` requests over the authenticated
 * dashboard-proxy WS connection; each handler here performs the action by
 * reusing the existing test pipeline / upload / cancel internals (no
 * duplication) and returns the response payload the caller sends back keyed by
 * `requestId`.
 *
 * The control plane carries only small JSON. The overlay tarball never reaches
 * the Platform — `handleTestUploadsInit` returns an external presigned URL the
 * developer PUTs to directly.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { stringifyActor } from '@kici-dev/engine';
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

/** Terminal execution-run states for the relay status/logs `done` flag. */
const TERMINAL_RUN_STATES = new Set(['success', 'failed', 'cancelled']);

/** Dependencies shared by all five test-relay handlers. */
export interface TestRelayHandlerDeps extends ProcessingDeps {
  db: Kysely<Database>;
  /** Agent registry — required here: the cancel handler resolves the job's agent. */
  agentRegistry: NonNullable<ProcessingDeps['agentRegistry']>;
  cacheStorage?: CacheStorage;
  logStorage?: LogStorage;
  accessLog?: AccessLogWriter;
  /** Canonical org id this orchestrator is bound to (for access_log attribution). */
  orgId?: string | null;
  /** Routing key resolved for this orchestrator's bound org (for access_log attribution). */
  routingKey?: string | null;
}

/** Response payload for `test.relay.uploads.init.response` (minus envelope fields). */
export interface TestUploadsInitPayload {
  uploadId: string;
  signedUrl: string;
  publicKey: string;
  expiresIn: number;
}

/**
 * Mint an upload record + external presigned PUT URL. The developer's PAT
 * identity (`msg.actor`) is recorded as the upload owner so the upload is
 * attributable.
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
      internal: false,
    },
  );
}

/** Response payload for `test.relay.trigger.response` (minus envelope fields). */
export interface TestTriggerPayload {
  runId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
  jobIds: string[];
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
  // The overlay tarball is decrypted with the CLI's ephemeral X25519 public key
  // (`cliPublicKey`) paired with the upload record's stored private key. This is
  // a distinct key from `encryptedSecretsKey` (which keys the optional secrets
  // blob) — using the secrets key here would break runs with no secrets (no key
  // at all) and corrupt decryption when secrets are present (wrong key).
  const cliPublicKey = msg.cliPublicKey;
  let resolvedOverlay:
    | { tarballUrl: string; cliPublicKey: string; orchestratorPrivateKey: string }
    | undefined;

  if (msg.uploadId && cliPublicKey && deps.cacheStorage) {
    const upload = await deps.db
      .selectFrom('test_uploads')
      .select(['storage_key', 'encryption_private_key'])
      .where('upload_id', '=', msg.uploadId)
      .executeTakeFirst();

    if (upload?.storage_key && upload.encryption_private_key) {
      // Pre-signed uploads don't set S3 metadata — initialize it so getUrl()
      // (which requires metadata) can mint a download URL.
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
      requestId: msg.requestId,
    },
    deps,
  );

  void deps.accessLog?.record({
    orgId: deps.orgId ?? null,
    routingKey: deps.routingKey ?? msg.routingKey,
    actor: msg.actor,
    action: 'run.trigger',
    target: { type: 'run', id: result.runId },
    requestId: msg.requestId,
    source: 'platform_proxy',
    outcome: result.status === 'accepted' ? 'allowed' : 'denied',
    ...(result.reason ? { errorMessage: result.reason } : {}),
  });

  return {
    runId: result.runId,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    jobIds: result.jobIds,
  };
}

/** Response payload for `test.relay.run.status.response` (minus envelope fields). */
export interface TestRunStatusPayload {
  runId: string;
  status: string;
  jobs: Array<{
    jobId: string;
    jobName: string;
    status: string;
    errorMessage?: string | null;
  }>;
  done: boolean;
}

/** Snapshot a run's status + per-job status. `done` is true at a terminal run state. */
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
    .select(['job_id', 'job_name', 'status', 'error_message'])
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
    })),
    done: TERMINAL_RUN_STATES.has(run.status),
  };
}

/** Response payload for `test.relay.run.logs.response` (minus envelope fields). */
export interface TestRunLogsPayload {
  lines: string[];
  nextCursor: number;
  done: boolean;
}

/** Match `executions/<runId>/job-<name>/step-<index>.log`. */
const LOG_PATH_RE = /job-([^/]+)\/step-(\d+)\.log$/;

/**
 * Return the next chunk of a run's logs from a monotonic line-offset cursor
 * (spec §13a). The orchestrator concatenates every log line in a deterministic
 * `(jobName ASC, stepIndex ASC, lineIndex ASC)` order; `cursor` is the count of
 * lines already delivered. `done` is true only when the run is terminal AND the
 * cursor has reached the end (the final tail-draining poll). A poll mid-step
 * returns the lines available so far with `done: false`, so no line is ever
 * dropped or skipped on a live run.
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
  const allLines = await collectRunLogLines(msg.runId, deps.logStorage);

  const cursor = Math.max(0, msg.cursor);
  const lines = allLines.slice(cursor);
  const nextCursor = cursor + lines.length;
  // `done` only once the run is terminal AND we've drained the full stream — so
  // a terminal-but-not-caught-up poll returns the tail with done:false and the
  // CLI makes one final drain poll.
  const done = terminal && nextCursor >= allLines.length;

  return { lines, nextCursor, done };
}

/**
 * Build the ordered, flattened line stream for a run by reading every stored
 * step log under `executions/<runId>` and ordering by `(jobName, stepIndex,
 * lineIndex)`. Empty when no log storage is configured.
 */
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

/** Response payload for `test.relay.cancel.response` (minus envelope fields). */
export interface TestCancelPayload {
  cancelled: boolean;
}

/**
 * Cancel a running test run: signal cancellation to every dispatched agent,
 * mark still-pending dispatch queue entries cancelled, and mark the
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
    .where('status', 'in', ['pending', 'dispatched'])
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

  const pendingIds = jobs.filter((j) => j.status === 'pending').map((j) => j.id);
  if (pendingIds.length > 0) {
    await deps.db
      .updateTable('dispatch_queue')
      .set({ status: 'cancelled' })
      .where('id', 'in', pendingIds)
      .execute();
  }

  await deps.db
    .updateTable('execution_runs')
    .set({ status: 'cancelled' })
    .where('run_id', '=', runId)
    .execute();

  void deps.accessLog?.record({
    orgId: deps.orgId ?? null,
    routingKey: deps.routingKey ?? null,
    actor: msg.actor,
    action: 'run.cancel',
    target: { type: 'run', id: runId },
    requestId: msg.requestId,
    source: 'platform_proxy',
    outcome: 'allowed',
  });

  return { cancelled: true };
}

/**
 * Route a parsed `test.relay.*` request to its handler and build the full
 * response envelope (`type` + `requestId` + payload) the caller relays back over
 * the WS connection via `sendRaw`. Errors and `{ error }` results are surfaced
 * on the response's `error` field; the wire stays a structured response so the
 * Platform can map it to an HTTP status.
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
