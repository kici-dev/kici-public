import { z } from 'zod';

/**
 * The agent provisioning backends the orchestrator's auto-scaler supports. Each
 * implements the ScalerBackend interface.
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
 * workflow steps (`ctx.emit(...)`) MUST NOT use it: the SDK (client-side) and
 * the orchestrator (authoritative) both reject such a name, so a user step
 * cannot forge a system event. The rate limiter also exempts it. Defined here
 * so the SDK and the orchestrator share it without the SDK importing the
 * orchestrator.
 */
export const KICI_EVENT_NAME_PREFIX = 'kici.';

/**
 * Reserved event-name prefix for the events the ORCHESTRATOR mints for itself
 * (`__schedule_fire`, `__workflow_complete`, `__job_complete`,
 * `__workflows_failed_batch`).
 *
 * Reserved for the same reason as {@link KICI_EVENT_NAME_PREFIX}, and more
 * sharply: every name under this prefix is exempt from the event-storm rate
 * limiter, and `__schedule_fire` is also classified as a TRUSTED ref — no run
 * causes it, so nothing external shaped it. The others are caused by runs and
 * inherit the tier of the run behind them (for the failure batch, the most
 * restrictive tier across the runs), so they forge no privilege on their own.
 * A user step emitting any of them would forge the rate-limiter exemption, and
 * for `__schedule_fire` the trusted classification too — so the SDK and,
 * authoritatively, the orchestrator reserve the whole prefix.
 */
export const INTERNAL_EVENT_NAME_PREFIX = '__';

/**
 * The reserved prefix `eventName` uses, or `undefined` when a user step may
 * emit it. The SDK-side check and the orchestrator's authoritative backstop
 * share this one definition, so they never disagree.
 */
export function reservedEventNamePrefix(eventName: string): string | undefined {
  for (const prefix of [KICI_EVENT_NAME_PREFIX, INTERNAL_EVENT_NAME_PREFIX]) {
    if (eventName.startsWith(prefix)) return prefix;
  }
  return undefined;
}
