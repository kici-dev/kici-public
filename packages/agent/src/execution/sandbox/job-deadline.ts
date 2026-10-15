import { TimeoutReason } from '@kici-dev/engine';

export interface JobDeadlineHandle {
  clear(): void;
}

/**
 * Arm a job-level wall-clock deadline: if it elapses before clear(),
 * `onTimeout` gets the distinct `job_timeout` reason and the budget. A no-op
 * when `timeoutMs` is undefined or not positive.
 */
export function armJobDeadline(
  timeoutMs: number | undefined,
  onTimeout: (reason: TimeoutReason, timeoutMs: number) => void,
): JobDeadlineHandle {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { clear: () => {} };
  }
  const timer = setTimeout(() => {
    onTimeout(TimeoutReason.enum.job_timeout, timeoutMs);
  }, timeoutMs);
  // Don't keep the event loop alive on the deadline alone.
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
}
