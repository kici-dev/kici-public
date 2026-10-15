/** Follows a local-plane run by polling the admin API (independent mode has no SSE). */

import { AdminApiClient } from '@kici-dev/orchestrator';
import {
  TERMINAL_RUN_STATES,
  TERMINAL_JOB_STATES,
  ExecutionJobStatus,
  ExecutionRunStatus,
  sleep,
} from '@kici-dev/engine';
import { unwrapStoredLogLine } from '../remote/output/streaming.js';

/**
 * Read only by the anti-false-green guard below: a missing member lets a lagging
 * `success` run header be reported even though a job settled badly.
 */
const FAILED_JOB_STATES: ReadonlySet<string> = new Set<string>([
  ExecutionJobStatus.enum.failed,
  ExecutionJobStatus.enum.timed_out_stale,
  ExecutionJobStatus.enum.cancelled,
  ExecutionJobStatus.enum.drift_dropped,
  ExecutionJobStatus.enum.unroutable,
]);

const UNCLAIMED_JOB_STATES: ReadonlySet<string> = new Set<string>([
  ExecutionJobStatus.enum.pending,
  ExecutionJobStatus.enum.queued,
]);

/**
 * Far coarser than the poll interval: at 750 ms a two-minute window would cost
 * ~160 extra admin requests for a question that changes once.
 */
const ACCEPTANCE_CHECK_INTERVAL_MS = 5_000;

const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120_000;

/**
 * Falls back to the default for anything but a positive ms count. `Number('')`
 * is `0` (every run fails instantly) and `Number('2 min')` is `NaN` (`now >
 * deadline` stays false, restoring the 900 s hang): both worse than ignoring a typo.
 */
export function resolveAcceptanceTimeoutMs(
  explicitMs: number | undefined,
  raw: string | undefined,
): number {
  if (explicitMs !== undefined) return explicitMs;
  if (raw === undefined) return DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACCEPTANCE_TIMEOUT_MS;
}

/** `AdminApiClient.get`, injectable for tests. */
export interface RunFollowClient {
  get<T>(path: string): Promise<T>;
}

export interface RunOutcome {
  runId: string;
  status: string;
  jobs: Array<{ name: string; status: string; durationMs?: number }>;
}

interface RunHeaderResponse {
  run: { status: string };
}
interface JobsResponse {
  jobs: Array<{
    jobId: string;
    jobName: string;
    status: string;
    durationMs: number | null;
    steps?: Array<{ stepIndex: number }>;
  }>;
}
interface StepLogsResponse {
  lines: Array<{ value: string }>;
  totalLines: number;
  nextCursor: string | null;
}

export interface FollowRunOptions {
  onLine?: (line: string) => void;
  quiet?: boolean;
  client?: RunFollowClient;
  pollIntervalMs?: number;
  /**
   * Max time with no new log line and no run status change; resets on progress,
   * so a long but active run never times out. Default 15 min.
   */
  idleTimeoutMs?: number;
  /** Absolute cap regardless of progress. Default 2 h. */
  maxTotalMs?: number;
  /**
   * Max time for an agent to claim the run (a job leaves `pending`/`queued`), so
   * an unmatched label set or a failed agent start fails fast instead of using
   * the idle window. Default 2 min; `KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS` overrides.
   */
  acceptanceTimeoutMs?: number;
  /** Plane log path named in the acceptance-failure message. */
  hintLogPath?: string;
}

export async function followRun(
  planeUrl: string,
  adminToken: string,
  runId: string,
  opts: FollowRunOptions = {},
): Promise<RunOutcome> {
  const client: RunFollowClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 900_000;
  const maxTotalMs = opts.maxTotalMs ?? 7_200_000;
  const acceptanceTimeoutMs = resolveAcceptanceTimeoutMs(
    opts.acceptanceTimeoutMs,
    process.env.KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS,
  );
  // `<jobId>:<stepIndex>` → next line offset.
  const cursors = new Map<string, string>();
  const stream = !opts.quiet && opts.onLine ? opts.onLine : undefined;

  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastStatus = '';
  let accepted = false;
  let acceptanceDeadline = startedAt + acceptanceTimeoutMs;
  let lastAcceptanceCheck = 0;

  for (;;) {
    const now = Date.now();
    if (now - lastProgressAt > idleTimeoutMs) {
      throw new Error(
        `offline run: follow timed out (no progress for ${idleTimeoutMs}ms) for run ${runId}`,
      );
    }
    if (now - startedAt > maxTotalMs) {
      throw new Error(
        `offline run: follow exceeded its max window (${maxTotalMs}ms) for run ${runId}`,
      );
    }

    const { run } = await client.get<RunHeaderResponse>(`/api/v1/admin/runs/${runId}`);

    // A run nothing can serve sits in queued until the orchestrator's hour-long
    // queue timeout. A terminal run is never blamed on acceptance: its outcome
    // is known, and blaming it would be the misdiagnosis this check removes.
    if (!accepted && !TERMINAL_RUN_STATES.has(run.status)) {
      if (run.status === ExecutionRunStatus.enum.held) {
        // A held run waits for a reviewer, not an agent.
        acceptanceDeadline = now + acceptanceTimeoutMs;
      } else if (now - lastAcceptanceCheck >= ACCEPTANCE_CHECK_INTERVAL_MS) {
        lastAcceptanceCheck = now;
        const claimedJobs = await fetchJobs(client, runId);
        accepted =
          claimedJobs.length > 0 && claimedJobs.some((j) => !UNCLAIMED_JOB_STATES.has(j.status));
      }
      if (!accepted && now > acceptanceDeadline) {
        const seconds = Math.round(acceptanceTimeoutMs / 1000);
        throw new Error(
          `offline run: no agent picked up this run within ${seconds}s — no scaler label set ` +
            `matched the job's runsOn, or the agent failed to start.` +
            (opts.hintLogPath ? ` Plane log: ${opts.hintLogPath}` : ''),
        );
      }
    }

    let progressed = false;
    if (run.status !== lastStatus) {
      lastStatus = run.status;
      progressed = true;
    }
    // A new log line is progress, so only true silence trips the idle window.
    if (stream) {
      const emitted = await drainLogs(client, runId, cursors, stream);
      if (emitted > 0) progressed = true;
    }
    if (progressed) lastProgressAt = now;

    // The header can read terminal while a later dispatch wave (e.g. after the
    // `__build__` init job) is in flight: concluding there is a false green and
    // lets the caller clean up an isolated clone the agent is about to fetch. A
    // header lagging a just-failed job never reads as success.
    if (TERMINAL_RUN_STATES.has(run.status)) {
      const jobs = await fetchJobs(client, runId);
      const allTerminal = jobs.length > 0 && jobs.every((j) => TERMINAL_JOB_STATES.has(j.status));
      const anyFailed = jobs.some((j) => FAILED_JOB_STATES.has(j.status));
      if (allTerminal && !(run.status === 'success' && anyFailed)) {
        if (stream) await drainLogs(client, runId, cursors, stream);
        return { runId, status: run.status, jobs };
      }
    }
    await sleep(pollIntervalMs);
  }
}

async function fetchJobs(client: RunFollowClient, runId: string): Promise<RunOutcome['jobs']> {
  const { jobs } = await client.get<JobsResponse>(`/api/v1/admin/runs/${runId}/jobs`);
  return jobs.map((j) => ({
    name: j.jobName,
    status: j.status,
    durationMs: j.durationMs ?? undefined,
  }));
}

/** Best-effort: a fetch error never aborts the follow; logs are not the terminal signal. */
async function drainLogs(
  client: RunFollowClient,
  runId: string,
  cursors: Map<string, string>,
  onLine: (line: string) => void,
): Promise<number> {
  let emitted = 0;
  let jobs: JobsResponse['jobs'];
  try {
    jobs = (await client.get<JobsResponse>(`/api/v1/admin/runs/${runId}/jobs?includeSteps=true`))
      .jobs;
  } catch {
    return emitted;
  }
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      const key = `${job.jobId}:${step.stepIndex}`;
      try {
        let cursor = cursors.get(key);
        for (;;) {
          const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
          const page = await client.get<StepLogsResponse>(
            `/api/v1/admin/runs/${runId}/jobs/${job.jobId}/steps/${step.stepIndex}/logs${qs}`,
          );
          for (const l of page.lines) {
            // The admin route serves stored JSON envelopes ({"ts","level","msg"})
            // verbatim; print the text, as `kici run remote` and `kici runs logs` do.
            onLine(unwrapStoredLogLine(l.value));
            emitted++;
          }
          // On the last page nextCursor is null; advancing the line offset to
          // `totalLines` stops the next tick re-emitting the streamed tail.
          cursor = page.nextCursor ?? String(page.totalLines);
          cursors.set(key, cursor);
          if (!page.nextCursor) break;
        }
      } catch {
        // best-effort per step
      }
    }
  }
  return emitted;
}
