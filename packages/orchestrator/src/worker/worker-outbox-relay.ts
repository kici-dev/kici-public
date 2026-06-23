/**
 * Relay glue between the worker's in-memory execution tracker and the durable
 * peer outbox. Extracted so the mapping/replay logic is unit-testable and so
 * the worker bootstrap stays under the function-length cap.
 */

import { createLogger } from '@kici-dev/shared';
import { TERMINAL_JOB_STATES, type ExecutionJobStatus, type JobProgress } from '@kici-dev/engine';
import type { StatusUpdate } from './in-memory-execution-tracker.js';
import type { PeerOutbox } from './peer-outbox.js';

const logger = createLogger({ prefix: 'peer-outbox' });

/** Map a terminal job-level StatusUpdate to the JobProgress to durably relay; null otherwise. */
export function buildTerminalJobProgress(update: StatusUpdate): JobProgress | null {
  if (update.type !== 'job') return null;
  if (!TERMINAL_JOB_STATES.has(update.status)) return null;
  return {
    type: 'job.progress',
    kind: 'job',
    runId: update.runId,
    jobId: update.jobId,
    jobName: '',
    stepIndex: update.stepIndex ?? 0,
    stepName: update.stepName ?? '',
    state: update.status as ExecutionJobStatus,
    timestamp: update.timestamp,
    data: update.data,
  };
}

/** Re-send every outbox record destined for `url`. Send failures are retried on the next connect. */
export function replayPending(
  outbox: PeerOutbox,
  send: (m: JobProgress) => boolean,
  url: string,
): void {
  const pending = outbox.pendingFor(url);
  if (pending.length === 0) return;
  logger.info('Replaying buffered terminal job statuses to coordinator', {
    url,
    count: pending.length,
    jobIds: pending.map((r) => r.message.jobId),
  });
  for (const rec of pending) {
    send(rec.message);
  }
}
