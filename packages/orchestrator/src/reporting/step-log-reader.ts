/**
 * Shared step-log reader for the agent-facing step-logs endpoint.
 *
 * Resolves a step's stored log file via the same `execution_steps.log_path` +
 * `LogStorage` access the dashboard step.logs path uses, then returns the lines
 * with line-based cursor pagination. `toAgentStepLogs` wraps every line in an
 * untrusted envelope (log content is process/user output — never trusted).
 */
import type { Kysely } from 'kysely';
import { wrapUntrusted, type AgentStepLogs } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { LogStorage } from './log-storage.js';

export interface StepLogReaderDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
}

export interface RawStepLogs {
  lines: string[];
  totalLines: number;
  nextCursor: string | null;
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
 * `{ lines: [], totalLines: 0, nextCursor: null }`.
 */
export async function readStepLogLines(
  deps: StepLogReaderDeps,
  args: ReadStepLogArgs,
): Promise<RawStepLogs> {
  const step = await deps.db
    .selectFrom('execution_steps')
    .select(['log_path'])
    .where('run_id', '=', args.runId)
    .where('job_id', '=', args.jobId)
    .where('step_index', '=', args.stepIndex)
    .executeTakeFirst();

  if (!step?.log_path) {
    return { lines: [], totalLines: 0, nextCursor: null };
  }

  const result = await deps.logStorage.read(step.log_path);
  const allLines = result.data.split('\n').filter(Boolean);
  const totalLines = allLines.length;

  const offset = parseOffset(args.cursor);
  const limit = args.limit && args.limit > 0 ? args.limit : 500;
  const page = allLines.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < totalLines ? String(nextOffset) : null;

  return { lines: page, totalLines, nextCursor };
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
  };
}
