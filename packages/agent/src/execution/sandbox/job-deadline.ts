import { TimeoutReason } from '@kici-dev/engine';

/** Handle returned by armJobDeadline; call clear() to cancel the timer. */
export interface JobDeadlineHandle {
  clear(): void;
}

/**
 * Arm a job-level wall-clock deadline. When `timeoutMs` is set and elapses
 * before clear() is called, invokes `onTimeout` with the distinct
 * `job_timeout` reason and the configured budget. A no-op when `timeoutMs`
 * is undefined (no job-level cap configured).
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
