import { reservedEventNamePrefix } from '@kici-dev/engine';

/** Config produced by {@link invokeSource}: emit a kici event at the source repo and gate on the runs it triggers. */
export interface InvokeConfig {
  readonly _tag: 'InvokeSource';
  /** The kici event name to emit. Subscribers opt in with `kiciEvent({ name })`. */
  readonly event: string;
  /** Target scope. `'source'` targets exactly `ctx.sourceRepo` (the only v1 scope). */
  readonly scope: 'source';
  /** Optional event payload delivered to subscribers. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * When true, a zero-subscriber emit succeeds immediately (the repo may opt out).
   * When false/unset (the default), a zero-subscriber emit FAILS the gate — a repo
   * that never wired up its tests must not silently pass the org gate.
   */
  readonly optional?: boolean;
}

/**
 * Invoke the source repo's opt-in workflows and gate on them.
 *
 * Targets exactly `ctx.sourceRepo`, so a global workflow can hand control back to
 * the repo whose event triggered it without any org-wide fan-out. Subscribers opt
 * in with `kiciEvent({ name })`. Required by default: if no workflow subscribes,
 * the gate fails unless `optional: true` is set.
 */
export function invokeSource(
  event: string,
  opts?: { payload?: Record<string, unknown>; optional?: boolean },
): InvokeConfig {
  if (typeof event !== 'string' || event.trim().length === 0) {
    throw new Error('invokeSource: event name must be a non-empty string');
  }
  // The same reservation `ctx.emit` enforces: `kici.` names KiCI system events,
  // and `__` names the events the orchestrator mints for itself — whose runs are
  // dispatched as a trusted ref. A gate is a workflow-authored emit, so it must
  // not be the way around either. This fails at compile time; the orchestrator
  // refuses it again at dispatch.
  const reservedPrefix = reservedEventNamePrefix(event);
  if (reservedPrefix) {
    throw new Error(
      `invokeSource: event name prefix "${reservedPrefix}" is reserved for KiCI internal events (got "${event}")`,
    );
  }
  return Object.freeze({
    _tag: 'InvokeSource' as const,
    event,
    scope: 'source' as const,
    ...(opts?.payload !== undefined && { payload: Object.freeze({ ...opts.payload }) }),
    ...(opts?.optional === true && { optional: true }),
  });
}
