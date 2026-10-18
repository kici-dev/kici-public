/** Follow every run one `kici run remote` trigger created (one per matched workflow) until each ends. */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_RUN_STATES,
  toCanonicalStatus,
} from '@kici-dev/engine';
import { confirm as inquirerConfirm } from '@inquirer/prompts';
import {
  NotFoundError,
  FIRST_LOG_POSITION,
  nextLogPosition,
  type PlatformRunLogsResponse,
  type PlatformRunStatusResponse,
  type RunLogPosition,
} from '../remote/platform-client.js';
import { HoldsUnavailableError } from '../remote/direct-client.js';
import type { RunRemoteTransport } from '../remote/run-transport.js';
import {
  formatErrorHighlight,
  formatSummary,
  jobLabel,
  spansWorkflows,
  type RunJobResult,
  type RunResult,
} from '../remote/output/summary.js';
import { unwrapStoredLogLine } from '../remote/output/streaming.js';
import { handleNewHolds } from './run-hold-watch.js';
import type { RemoteRunOptions, RemoteRunResult } from './preview.js';

const POLL_INTERVAL_MS = 750;

/**
 * The trigger answers once the orchestrator creates the run, but the Platform's
 * view arrives over the relay later, so the first poll can legitimately 404.
 * Within this budget, and only until the first successful read, a 404 retries;
 * after that it is a genuinely missing run.
 */
const RUN_VISIBILITY_GRACE_MS = 30_000;

const MAX_TAIL = 50;

const CANCEL_REQUEST_TIMEOUT_MS = 15_000;

/** 128 + SIGINT, the shell convention. */
const SIGINT_EXIT_CODE = 130;

export interface FollowedRun {
  runId: string;
  workflowName?: string;
}

/**
 * Resolves through the engine's canonical vocabulary, not a hand-written literal
 * set, so a newly-added terminal status never leaves `kici run` polling forever.
 */
function isTerminalRunStatus(status: string): boolean {
  const canonical = toCanonicalStatus(status.toLowerCase());
  return canonical !== undefined && TERMINAL_RUN_STATES.has(canonical);
}

const FAILED_JOB_STATES: ReadonlySet<string> = new Set([
  ExecutionJobStatus.enum.failed,
  ExecutionJobStatus.enum.timed_out_stale,
  ExecutionJobStatus.enum.drift_dropped,
  ExecutionJobStatus.enum.unroutable,
]);

function isFailedJobStatus(status: string): boolean {
  const canonical = toCanonicalStatus(status.toLowerCase());
  return canonical !== undefined && FAILED_JOB_STATES.has(canonical);
}

interface RunWatch {
  run: FollowedRun;
  position: RunLogPosition;
  lastStatus: PlatformRunStatusResponse | null;
  /** Set by the first successful read; a 404 after it is a missing run. */
  seen: boolean;
  done: boolean;
  /** When the run ended, or its follow failed; its own duration ends here. */
  doneAt?: number;
  /** Why following this run failed; the other runs are still followed. */
  error?: unknown;
  holdState: HoldWatchState;
  jobTails: Map<string, string[]>;
  runTail: string[];
  attributed: boolean;
}

function pushTail(tail: string[], line: string): void {
  tail.push(line);
  while (tail.length > MAX_TAIL) tail.shift();
}

function consumeLogs(
  watch: RunWatch,
  logs: PlatformRunLogsResponse,
  prefix: string,
  options: RemoteRunOptions,
): void {
  const jobNames = logs.lineJobNames?.length === logs.lines.length ? logs.lineJobNames : undefined;
  if (jobNames) watch.attributed = true;
  logs.lines.forEach((raw, i) => {
    const line = unwrapStoredLogLine(raw);
    if (!options.quiet) process.stdout.write(prefix + line + '\n');
    pushTail(watch.runTail, line);
    const jobName = jobNames?.[i];
    if (jobName !== undefined) {
      let tail = watch.jobTails.get(jobName);
      if (!tail) watch.jobTails.set(jobName, (tail = []));
      pushTail(tail, line);
    }
  });
  watch.position = nextLogPosition(logs);
}

async function pollRun(
  ctx: RunRemoteTransport,
  watch: RunWatch,
  startTime: number,
  prefix: string,
  options: RemoteRunOptions,
): Promise<void> {
  let logs: PlatformRunLogsResponse;
  try {
    logs = await ctx.logs(watch.run.runId, watch.position);
    watch.lastStatus = await ctx.status(watch.run.runId);
  } catch (err) {
    if (
      err instanceof NotFoundError &&
      !watch.seen &&
      Date.now() - startTime < RUN_VISIBILITY_GRACE_MS
    ) {
      return;
    }
    throw err;
  }
  watch.seen = true;
  consumeLogs(watch, logs, prefix, options);

  const terminal = watch.lastStatus.done || isTerminalRunStatus(watch.lastStatus.status);
  if (terminal && logs.done) {
    watch.done = true;
    watch.doneAt = Date.now();
    return;
  }
  if (!terminal) await watchRunHolds(watch.run.runId, watch.holdState, ctx, options);
}

/** A run is done only when its status is terminal and its log stream has drained. */
export async function followRuns(
  ctx: RunRemoteTransport,
  runs: FollowedRun[],
  fixtureId: string,
  options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const startTime = Date.now();
  const watches: RunWatch[] = runs.map((run) => ({
    run,
    position: FIRST_LOG_POSITION,
    lastStatus: null,
    seen: false,
    done: false,
    holdState: { seen: new Set<string>(), unavailable: false },
    jobTails: new Map(),
    runTail: [],
    attributed: false,
  }));
  const prefixOf = (run: FollowedRun): string =>
    runs.length > 1 && run.workflowName ? pc.dim(`[${run.workflowName}] `) : '';

  // Ctrl-C cancels every run still going and returns once the cancels settle;
  // a second Ctrl-C exits at once.
  let cancelRequest: Promise<void> | null = null;
  const cancelHandler = () => {
    const live = watches.filter((w) => !w.done).map((w) => w.run.runId);
    if (!cancelRequest) {
      cancelRequest = Promise.all(live.map((id) => requestRunCancel(ctx, id, options))).then(
        () => undefined,
      );
    } else {
      const which = live.length === 1 ? `Run ${live[0]}` : `Runs ${live.join(', ')}`;
      process.stderr.write(pc.yellow(`Exiting without waiting. ${which} may still be running.\n`));
      process.exit(SIGINT_EXIT_CODE);
    }
  };
  process.on('SIGINT', cancelHandler);

  try {
    while (!cancelRequest && watches.some((w) => !w.done)) {
      for (const watch of watches) {
        if (watch.done || cancelRequest) continue;
        try {
          await pollRun(ctx, watch, startTime, prefixOf(watch.run), options);
        } catch (err) {
          // One unreadable run must not leave the others unwatched and uncancelled.
          Object.assign(watch, { done: true, doneAt: Date.now(), error: err });
          logger.error(pc.red(`Stopped following run ${watch.run.runId}: ${toErrorMessage(err)}`));
        }
      }
      if (cancelRequest || watches.every((w) => w.done)) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (cancelRequest) {
      await cancelRequest;
      return groupResult(fixtureId, watches, 'cancelled', startTime);
    }
    // fails-when: one run's error ends the follow of every run
    // breaks-if-wrong: a single run that cannot be read still reports its own error
    if (watches.every((w) => w.error !== undefined)) throw watches[0]!.error;
    return finishRuns(fixtureId, watches, startTime, options);
  } finally {
    // A Ctrl-C during the last poll tick still sends its cancel before the
    // command reports and exits.
    if (cancelRequest) await cancelRequest;
    process.removeListener('SIGINT', cancelHandler);
  }
}

/** `success` only when every run succeeded; `cancelled` when the rest succeeded. */
export function combineRunStatuses(statuses: readonly string[]): RemoteRunResult['status'] {
  const { success, cancelled } = ExecutionRunStatus.enum;
  if (statuses.length === 0) return 'failed';
  if (statuses.every((s) => s === success)) return 'success';
  if (statuses.every((s) => s === success || s === cancelled)) return 'cancelled';
  return 'failed';
}

function jobsOf(watch: RunWatch): RunJobResult[] {
  if (!watch.lastStatus) return [];
  const workflowName = watch.run.workflowName;
  return watch.lastStatus.jobs.map((j) => ({
    name: j.jobName,
    status: j.status,
    // An unreported duration prints as `-` in the summary table.
    ...(typeof j.durationMs === 'number' && { durationMs: j.durationMs }),
    ...(workflowName !== undefined && { workflowName }),
  }));
}

/** A run's own status: `error` when its follow failed. */
function watchStatus(w: RunWatch): string {
  return w.error !== undefined ? 'error' : (w.lastStatus?.status ?? 'unknown');
}

function groupResult(
  fixtureId: string,
  watches: RunWatch[],
  status: RemoteRunResult['status'],
  startTime: number,
): RemoteRunResult {
  const now = Date.now();
  const runs = watches.map((w) => ({
    runId: w.run.runId,
    ...(w.run.workflowName !== undefined && { workflowName: w.run.workflowName }),
    status: status === 'cancelled' && !w.done ? 'cancelled' : watchStatus(w),
    durationMs: (w.doneAt ?? now) - startTime,
    jobs: jobsOf(w),
  }));
  return {
    fixtureId,
    runId: watches[0]?.run.runId ?? '',
    status,
    durationMs: now - startTime,
    jobs: runs.flatMap((r) => r.jobs),
    runs,
  };
}

function finishRuns(
  fixtureId: string,
  watches: RunWatch[],
  startTime: number,
  options: RemoteRunOptions,
): RemoteRunResult {
  const status = combineRunStatuses(watches.map(watchStatus));
  const result = groupResult(fixtureId, watches, status, startTime);
  const durationMs = result.durationMs ?? 0;

  if (!options.quiet) {
    const runResult: RunResult = {
      fixtureId,
      runId: result.runId,
      status: status === 'success' ? 'success' : status === 'cancelled' ? 'cancelled' : 'failed',
      totalDurationMs: durationMs,
      jobs: result.jobs ?? [],
    };
    process.stdout.write('\n' + formatSummary(runResult) + '\n');
    for (const block of errorBlocks(watches, spansWorkflows(runResult.jobs))) {
      process.stdout.write('\n' + formatErrorHighlight(block.label, block.lines) + '\n');
    }
  }
  return result;
}

/**
 * One block per failed job with only its own output; a run with no failed job
 * shows its failure reason; an older server's unattributed lines get one block.
 */
export function errorBlocks(
  watches: ReadonlyArray<
    Pick<RunWatch, 'run' | 'lastStatus' | 'jobTails' | 'runTail' | 'attributed' | 'error'>
  >,
  labelWorkflow: boolean,
): Array<{ label: string; lines: string[] }> {
  const blocks: Array<{ label: string; lines: string[] }> = [];
  for (const watch of watches) {
    if (watch.error !== undefined) {
      blocks.push({
        label: watch.run.workflowName ?? watch.run.runId,
        lines: [toErrorMessage(watch.error)],
      });
      continue;
    }
    const status = watch.lastStatus;
    if (!status || status.status === ExecutionRunStatus.enum.success) continue;
    const workflowName = watch.run.workflowName;
    const label = (name: string) => jobLabel({ name, status: '', workflowName }, labelWorkflow);
    const failed = status.jobs.filter((j) => isFailedJobStatus(j.status));
    if (failed.length === 0) {
      if (status.status !== ExecutionRunStatus.enum.failed) continue;
      const lines = status.failureReason ? [status.failureReason] : watch.runTail;
      if (lines.length > 0) blocks.push({ label: workflowName ?? 'run', lines });
      continue;
    }
    if (!watch.attributed) {
      if (watch.runTail.length > 0) {
        blocks.push({ label: label(failed[0]!.jobName), lines: watch.runTail });
      }
      continue;
    }
    for (const job of failed) {
      const lines = watch.jobTails.get(job.jobName) ?? [];
      const shown = lines.length > 0 ? lines : job.errorMessage ? [job.errorMessage] : [];
      if (shown.length > 0) blocks.push({ label: label(job.jobName), lines: shown });
    }
  }
  return blocks;
}

/** Never throws: a failed or unanswered cancel is reported, and the command still ends. */
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

export interface HoldWatchState {
  /** Hold ids already prompted or notified, once each. */
  seen: Set<string>;
  /** Set once the transport says it cannot list holds; listing then stops. */
  unavailable: boolean;
}

/**
 * A transport that cannot list holds says so once (`HoldsUnavailableError`) and
 * is not asked again. Any other failure is swallowed: hold visibility is
 * best-effort and must never abort the run watch.
 */
export async function watchRunHolds(
  runId: string,
  state: HoldWatchState,
  transport: Pick<RunRemoteTransport, 'kind' | 'holds'>,
  options: RemoteRunOptions,
): Promise<void> {
  if (state.unavailable) return;
  const quiet = Boolean(options.quiet);
  // Quiet / --json: never block on a stdin prompt (it would hang the run, and
  // --approve-all auto-approves instead), and write hold text to stderr.
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
  }
}
