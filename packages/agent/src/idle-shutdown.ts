/**
 * What a scaler-managed agent does about its idle-shutdown timer when
 * `register.ack` arrives.
 *
 * This lives apart from `server.ts` so the rule has exactly one
 * implementation: the server acts on the verdict, and the tests assert on the
 * verdict. Importing `server.ts` starts the agent (it ends in a top-level
 * `guardStartup`), so a function exported from there could only ever be tested
 * by a copy of itself.
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
}): IdleShutdownDecision {
  if (!input.scalerManaged || input.activeJobs > 0) return 'none';
  // Warm is read before pendingDispatch: the orchestrator sets them from the
  // same `boundJobId`, so they are mutually exclusive at the source, and an ack
  // that somehow carried both must not arm a timer under a warm agent — the
  // warm-pool reaper is the sole authority on that agent's lifetime.
  if (input.warmPool) return 'warm';
  if (input.pendingDispatch) return 'pending-dispatch';
  return 'idle';
}
