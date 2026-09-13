import { z } from 'zod';

/**
 * Scaler backend type identifiers.
 *
 * Enumerates the agent provisioning backends supported by the orchestrator's
 * auto-scaler module. Each backend implements the ScalerBackend interface.
 * Access values: ScalerBackendType.enum.container, ScalerBackendType.enum.firecracker, etc.
 */
export const ScalerBackendType = z.enum([
  'container',
  'bare-metal',
  'firecracker',
  'kubernetes',
  'event',
]);
export type ScalerBackendType = z.infer<typeof ScalerBackendType>;

/**
 * Reserved event-name prefix for KiCI-internal system events (today: the event
 * scaler's scale-up / scale-down events). Custom events emitted from user
 * workflow steps (`ctx.emit(...)`) MUST NOT use this prefix — both the SDK
 * (client-side) and the orchestrator (authoritative) reject a name that starts
 * with it, so a user step cannot forge a system event. The rate limiter also
 * exempts it. Defined in `@kici-dev/engine` so the SDK and the orchestrator
 * share one source of truth without the SDK importing the orchestrator.
 */
export const KICI_EVENT_NAME_PREFIX = 'kici.';

/**
 * Reserved event-name prefix for the events the ORCHESTRATOR mints for itself
 * (`__schedule_fire`, `__workflow_complete`, `__job_complete`,
 * `__workflows_failed_batch`).
 *
 * Reserved for the same reason as {@link KICI_EVENT_NAME_PREFIX}, and more
 * sharply: every name under this prefix is exempt from the event-storm rate
 * limiter, and `__schedule_fire` is additionally classified as a TRUSTED ref —
 * no run causes it, so nothing external shaped it. The other three ARE caused
 * by runs and inherit the tier of the run (or, for the failure batch, the most
 * restrictive tier across the runs) behind them, so they forge no privilege on
 * their own. A user step that could emit any of them would forge the
 * rate-limiter exemption, and `__schedule_fire` the trusted classification on
 * top of it — so the same two-sided reservation applies to the whole prefix,
 * SDK first and orchestrator authoritatively.
 */
export const INTERNAL_EVENT_NAME_PREFIX = '__';

/**
 * The reserved prefix `eventName` uses, or `undefined` when a user step may
 * emit it. One definition of "reserved", so the SDK-side check and the
 * orchestrator's authoritative backstop can never disagree about which names a
 * workflow may emit.
 */
export function reservedEventNamePrefix(eventName: string): string | undefined {
  for (const prefix of [KICI_EVENT_NAME_PREFIX, INTERNAL_EVENT_NAME_PREFIX]) {
    if (eventName.startsWith(prefix)) return prefix;
  }
  return undefined;
}
