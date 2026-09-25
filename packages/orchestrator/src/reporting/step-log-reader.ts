/**
 * Shared step-log reader for the agent-facing step-logs endpoint.
 *
 * Resolves a step's stored log file via the same `execution_steps.log_path` +
 * `LogStorage` access the dashboard step.logs path uses, then returns the lines
 * with line-based cursor pagination. A job's workflow-level log (step `-1`:
 * setup narration such as the clone and the dependency install) has no step
 * row, so its key is derived from the job name the writer used.
 * `toAgentStepLogs` wraps every line in an untrusted envelope (log content is
 * process/user output — never trusted).
 */
import type { Kysely } from 'kysely';
import { wrapUntrusted, type AgentStepLogs } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { LogStorage } from './log-storage.js';
import { stepLogPath } from './step-log-path.js';

export interface StepLogReaderDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
}

export interface RawStepLogs {
  lines: string[];
  totalLines: number;
  nextCursor: string | null;
  /**
   * Whether a log is stored for the step. `false` means none was ever written;
   * `true` with no lines means the stored log is empty.
   */
  recorded: boolean;
}

export interface ReadStepLogArgs {
  runId: string;
  jobId: string;
  stepIndex: number;
  /** Stringified line offset to start from (0-based). Default 0. */
  cursor?: string;
  /** Max number of lines to return. Default 500, hard cap applied by caller. */
  limit?: number;
}

/** Parse a line-offset cursor; non-numeric / negative becomes 0. */
function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read a page of a step's log lines. Returns an empty page (not an error) when
 * the step row or its log file is absent, so a never-emitted-logs step reads as
 * `{ lines: [], totalLines: 0, nextCursor: null, recorded: false }`.
 */
export async function readStepLogLines(
  deps: StepLogReaderDeps,
  args: ReadStepLogArgs,
): Promise<RawStepLogs> {
  const logPath = await resolveStepLogPath(deps, args);
  // fails-when: a step that never wrote a log reads as recorded, so a reader
  // cannot tell it from a stored log that holds no lines
  if (!logPath) {
    return { lines: [], totalLines: 0, nextCursor: null, recorded: false };
  }

  const result = await deps.logStorage.read(logPath);
  const allLines = result.data.split('\n').filter(Boolean);
  const totalLines = allLines.length;

  const offset = parseOffset(args.cursor);
  const limit = args.limit && args.limit > 0 ? args.limit : 500;
  const page = allLines.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < totalLines ? String(nextOffset) : null;

  return { lines: page, totalLines, nextCursor, recorded: true };
}

/**
 * The stored log key of the requested step, or `null` when it has none.
 *
 * A step's row names its log. The workflow-level log is written under a
 * negative index that no `step.status` carries (the wire schema is
 * non-negative), so no row ever names it: its key is built from the job name
 * (see {@link resolveJobName}, which reads the job's row where the log writer
 * reads its in-memory name) and used only when the file exists.
 */
export async function resolveStepLogPath(
  deps: StepLogReaderDeps,
  args: Pick<ReadStepLogArgs, 'runId' | 'jobId' | 'stepIndex'>,
): Promise<string | null> {
  const step = await deps.db
    .selectFrom('execution_steps')
    .select(['log_path'])
    .where('run_id', '=', args.runId)
    .where('job_id', '=', args.jobId)
    .where('step_index', '=', args.stepIndex)
    .executeTakeFirst();
  if (step?.log_path) return step.log_path;
  if (args.stepIndex >= 0) return null;

  const path = stepLogPath(args.runId, await resolveJobName(deps.db, args), args.stepIndex);
  return (await deps.logStorage.exists(path)) ? path : null;
}

/**
 * The job name to build a workflow-level log key from: the job's
 * `execution_jobs.job_name`, else its `dispatch_queue.job_name`, else the job id.
 *
 * The writer names the key through `ExecutionTracker.resolveJobName`, which
 * reads the tracker's in-memory job name instead of the `execution_jobs` row,
 * then the same `dispatch_queue` name, then the job id. The in-memory name is
 * the name the row records, so the two agree once the job has a row; the
 * caller reads the key only when that file exists.
 */
async function resolveJobName(
  db: Kysely<Database>,
  args: Pick<ReadStepLogArgs, 'runId' | 'jobId'>,
): Promise<string> {
  const job = await db
    .selectFrom('execution_jobs')
    .select(['job_name'])
    .where('run_id', '=', args.runId)
    .where('job_id', '=', args.jobId)
    .executeTakeFirst();
  if (job?.job_name) return job.job_name;
  const queued = await db
    .selectFrom('dispatch_queue')
    .select(['job_name'])
    .where('id', '=', args.jobId)
    .executeTakeFirst();
  return queued?.job_name ?? args.jobId;
}

/** Wrap raw step logs into the untrusted-tagged `AgentStepLogs` shape. */
export function toAgentStepLogs(
  runId: string,
  jobId: string,
  stepIndex: number,
  raw: RawStepLogs,
): AgentStepLogs {
  return {
    runId,
    jobId,
    stepIndex,
    totalLines: raw.totalLines,
    lines: raw.lines.map((l) => wrapUntrusted(l)),
    nextCursor: raw.nextCursor,
    recorded: raw.recorded,
  };
}
