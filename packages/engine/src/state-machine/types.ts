/**
 * Execution states for workflow, job, and step lifecycle tracking.
 *
 * State flow:
 *   pending -> queued -> running -> recovering -> running (reconnect)
 *                    \          \               \-> failed (timeout)
 *                     \          \               \-> cancelled
 *                      \          \-> success
 *                       \          \-> failed
 *                        \          \-> cancelled (direct, no hooks)
 *                         \          \-> cancelling (graceful, with hooks)
 *                          \                \-> cancelled (CANCEL_FORCE or COMPLETE)
 *                           \                \-> failed (hook failure)
 *                            \-> failed
 *                             \-> cancelled
 *   pending -> skipped
 *   pending -> cancelled
 *   pending -> held (protection: reviewer required)
 *   pending -> waiting (protection: wait timer)
 *   held -> queued (approved)
 *   held -> cancelled (rejected / expired)
 *   waiting -> queued (timer done)
 *   waiting -> cancelled
 */
export type ExecutionState =
  | 'pending'
  | 'queued'
  | 'running'
  | 'recovering'
  | 'cancelling'
  | 'held'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/**
 * Events that trigger state transitions.
 */
export type ExecutionEvent =
  | 'ENQUEUE'
  | 'START'
  | 'SUCCEED'
  | 'FAIL'
  | 'CANCEL'
  | 'CANCEL_GRACEFUL'
  | 'CANCEL_FORCE'
  | 'COMPLETE'
  | 'SKIP'
  | 'RECOVER'
  | 'HOLD'
  | 'APPROVE'
  | 'REJECT'
  | 'EXPIRE'
  | 'WAIT'
  | 'TIMER_DONE';

/**
 * States from which no further transitions are possible.
 */
export const TERMINAL_STATES: readonly ExecutionState[] = [
  'success',
  'failed',
  'cancelled',
  'skipped',
] as const;
