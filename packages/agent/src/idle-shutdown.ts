/**
 * What a scaler-managed agent does with its idle-shutdown timer on
 * `register.ack`. Kept out of `server.ts`, whose import starts the agent
 * (top-level `guardStartup`), so tests exercise the one real implementation.
 */

/**
 * - `none` — do nothing: either the agent is not scaler-managed, or it is busy.
 * - `warm` — pre-spawned to wait for work; disarm any timer and stay up.
 * - `pending-dispatch` — a bound job is on its way; arm the long safety timeout.
 * - `idle` — arm the ordinary scaler-idle timer.
 */
export type IdleShutdownDecision = 'none' | 'warm' | 'pending-dispatch' | 'idle';

export function decideIdleShutdown(input: {
  scalerManaged: boolean;
  activeJobs: number;
  pendingDispatch?: boolean;
  warmPool?: boolean;
  /** A single-job agent that has run its job: it waits for nothing. */
  singleJobServed?: boolean;
}): IdleShutdownDecision {
  if (!input.scalerManaged || input.activeJobs > 0) return 'none';
  // fails-when: a single-job agent that reconnects after its job reads as warm
  // and stays up, draining, where the warm-pool reaper never looks.
  if (input.singleJobServed) return 'idle';
  // Warm first: both derive from one `boundJobId`, so they are exclusive, and an
  // ack carrying both must not arm a timer — the warm-pool reaper alone owns a
  // warm agent's lifetime.
  if (input.warmPool) return 'warm';
  if (input.pendingDispatch) return 'pending-dispatch';
  return 'idle';
}

/**
 * How long a scaler-managed agent waits for a follow-up job once it is idle.
 * A single-job agent that has run its job waits for nothing and exits at once.
 */
export function idleShutdownDelayMs(input: {
  scalerIdleTimeoutMs: number;
  singleJob: boolean;
  servedJob: boolean;
}): number {
  return input.singleJob && input.servedJob ? 0 : input.scalerIdleTimeoutMs;
}
