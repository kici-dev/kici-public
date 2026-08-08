/**
 * Follow an offline routed run against the local plane by polling the
 * orchestrator admin API (no SSE in independent mode). Streams step log lines as
 * they arrive and resolves when the run reaches a terminal state.
 */

import { AdminApiClient } from '@kici-dev/orchestrator';
import {
  TERMINAL_RUN_STATES,
  TERMINAL_JOB_STATES,
  ExecutionJobStatus,
  ExecutionRunStatus,
} from '@kici-dev/engine';

/**
 * Job states that mean the job did NOT succeed (failed / stale / cancelled /
 * dropped / unroutable). Read only by the anti-false-green guard below, so a
 * missing member lets a lagging `success` run header be reported verbatim even
 * though a job settled badly.
 */
const FAILED_JOB_STATES: ReadonlySet<string> = new Set<string>([
  ExecutionJobStatus.enum.failed,
  ExecutionJobStatus.enum.timed_out_stale,
  ExecutionJobStatus.enum.cancelled,
  ExecutionJobStatus.enum.drift_dropped,
  ExecutionJobStatus.enum.unroutable,
]);

/** Job states in which no agent has claimed the job yet. */
const UNCLAIMED_JOB_STATES: ReadonlySet<string> = new Set<string>([
  ExecutionJobStatus.enum.pending,
  ExecutionJobStatus.enum.queued,
]);

/**
 * How often the acceptance check re-fetches jobs. Deliberately far coarser than
 * the poll interval: at 750 ms a two-minute window would cost ~160 extra admin
 * requests to answer a question that changes once.
 */
const ACCEPTANCE_CHECK_INTERVAL_MS = 5_000;

/** Default window for an agent to claim the run before the follow gives up. */
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120_000;

/**
 * Resolve the acceptance window, falling back to the default for any value that
 * is not a positive number of milliseconds.
 *
 * A malformed override must never reach the deadline arithmetic: `Number('')`
 * is `0` (every run fails instantly) and `Number('2 min')` is `NaN`, which makes
 * `now > deadline` permanently false and silently restores the 900 s hang this
 * window exists to prevent. Both failure modes are worse than ignoring a typo.
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

/** A minimal admin-read client (AdminApiClient.get) — injectable for tests. */
export interface RunFollowClient {
  get<T>(path: string): Promise<T>;
}

/** Terminal outcome of a followed run. */
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
   * Idle window: the max time with NO observed progress (no new log line, no run
   * status change) before the follow gives up. Resets on every progress tick, so
   * a legitimately long run (e.g. a full `deploy:stg`, tens of minutes of image
   * builds + host mutation) never times out while it is actively advancing —
   * only a genuinely stalled run does. Default 15 min. `timeoutMs` is a
   * back-compat alias.
   */
  idleTimeoutMs?: number;
  /** @deprecated Back-compat alias for `idleTimeoutMs`. */
  timeoutMs?: number;
  /** Absolute cap regardless of progress (safety net against a runaway follow). Default 2 h. */
  maxTotalMs?: number;
  /**
   * Max time for the FIRST job to leave `pending`/`queued` — that is, for some
   * agent to claim the run. A plane whose scaler matches no label set, or whose
   * agent cannot start, never gets past this, so it fails in seconds instead of
   * consuming the whole idle window. Default 2 min; override with
   * `KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS`.
   */
  acceptanceTimeoutMs?: number;
  /** Plane log path named in the acceptance-failure message. */
  hintLogPath?: string;
}

/** Poll a run to completion, streaming step logs. */
export async function followRun(
  planeUrl: string,
  adminToken: string,
  runId: string,
  opts: FollowRunOptions = {},
): Promise<RunOutcome> {
  const client: RunFollowClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const idleTimeoutMs = opts.idleTimeoutMs ?? opts.timeoutMs ?? 900_000;
  const maxTotalMs = opts.maxTotalMs ?? 7_200_000;
  const acceptanceTimeoutMs = resolveAcceptanceTimeoutMs(
    opts.acceptanceTimeoutMs,
    process.env.KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS,
  );
  // Per-step log cursor (key `<jobId>:<stepIndex>` → next line offset string).
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

    // Acceptance: some agent must claim a job. A run nothing can serve — no
    // scaler label set matches its runsOn, or the agent failed to start — sits
    // in queued until the orchestrator's own hour-long queue timeout, so
    // without this it would consume the entire idle window instead.
    // A run that already reached a terminal state is never blamed on acceptance:
    // its outcome is known, so reporting "no agent picked up this run" for a run
    // that was cancelled — or that finished — as the window elapsed would be the
    // same misdiagnosis this window exists to remove.
    if (!accepted && !TERMINAL_RUN_STATES.has(run.status)) {
      if (run.status === ExecutionRunStatus.enum.held) {
        // A held run is waiting for a reviewer, not for an agent — push the
        // window out rather than blaming the plane for the wait.
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
    // Streaming a new log line is progress — a long-but-active deploy resets the
    // idle window on every batch of output, so only true silence trips it.
    if (stream) {
      const emitted = await drainLogs(client, runId, cursors, stream);
      if (emitted > 0) progressed = true;
    }
    if (progressed) lastProgressAt = now;

    // The run header can report a terminal status while a later dispatch wave
    // (e.g. after the `__build__` init job) is still in flight — reporting done
    // there is a false green AND, for an isolated workdir, would let the caller
    // clean up the clone the agent is about to fetch. Only conclude when the run
    // header is terminal, every job row is terminal, and (for success) no job
    // failed — so a run header lagging behind a just-failed job never reads as
    // success.
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

/** Fetch the run's jobs mapped to the summary shape. */
async function fetchJobs(client: RunFollowClient, runId: string): Promise<RunOutcome['jobs']> {
  const { jobs } = await client.get<JobsResponse>(`/api/v1/admin/runs/${runId}/jobs`);
  return jobs.map((j) => ({
    name: j.jobName,
    status: j.status,
    durationMs: j.durationMs ?? undefined,
  }));
}

/**
 * Stream any new step-log lines. Best-effort: a per-step fetch error never
 * aborts the follow (logs are observability, not the terminal signal).
 */
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
        // Drain the step until the server reports no further pages this tick.
        for (;;) {
          const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
          const page = await client.get<StepLogsResponse>(
            `/api/v1/admin/runs/${runId}/jobs/${job.jobId}/steps/${step.stepIndex}/logs${qs}`,
          );
          for (const l of page.lines) {
            onLine(l.value);
            emitted++;
          }
          // Persist the position even on the last page (nextCursor is null once
          // drained): the cursor is a line offset, so advancing it to
          // `totalLines` stops the next tick re-reading — and re-emitting — the
          // already-streamed tail.
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
