/**
 * The opaque per-file cursor of a `kici run remote` log stream.
 *
 * It records, for each of a run's log files, how many lines the caller already
 * received: `{ "<file>": <lines> }`, JSON-encoded, then base64url so it fits a
 * query string. The file key is the path below `executions/<runId>/`. A file
 * that appears later starts at line 0 wherever it sorts, so no line is lost or
 * sent twice when a step's file sorts before a file that was already read.
 */
import { z } from 'zod';
import { TEST_RUN_LOG_CURSOR_START } from '@kici-dev/engine';

const offsetsSchema = z.record(z.string(), z.number().int().nonnegative());

/** Lines already delivered from each of a run's log files. */
export type RunLogFileOffsets = z.infer<typeof offsetsSchema>;

export function encodeRunLogCursor(offsets: RunLogFileOffsets): string {
  return Buffer.from(JSON.stringify(offsets), 'utf8').toString('base64url');
}

/** Decode a cursor. The start token decodes to no offsets; malformed input to null. */
export function decodeRunLogCursor(cursor: string): RunLogFileOffsets | null {
  if (cursor === TEST_RUN_LOG_CURSOR_START) return {};
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = offsetsSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
