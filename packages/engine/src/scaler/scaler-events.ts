/**
 * Shared schemas and constants for the event scaler backend.
 *
 * The event scaler performs no local compute: its `spawn()` / `destroy()` emit
 * reserved `kici.`-prefixed custom events (`kici.scaler.scale-up` /
 * `kici.scaler.scale-down`) that a customer-authored provisioning / teardown
 * workflow consumes via the `kiciEvent()` trigger. These schemas define the
 * event payloads and the single source of truth for the reserved event names.
 *
 * They live here, not in the orchestrator, because both sides of the contract
 * need them: the orchestrator emits, and a workflow file — which may import
 * `@kici-dev/sdk` and nothing else — consumes. Engine is the only package both
 * the SDK and the orchestrator depend on, so it is the shared floor. The SDK
 * re-exports all four symbols; the orchestrator's `scaler/scaler-events.ts`
 * re-exports them for its own call sites.
 */

import { z } from 'zod';

/**
 * Reserved event names the event scaler emits. Both start with
 * `KICI_EVENT_NAME_PREFIX` (`./scaler-backend-type.ts`), so the rate limiter
 * exempts them and user steps cannot forge them — `scaler-events.test.ts`
 * asserts that relationship holds for both names.
 */
export const SCALER_EVENT_NAMES = {
  scaleUp: 'kici.scaler.scale-up',
  scaleDown: 'kici.scaler.scale-down',
} as const;

/**
 * Why the scaler asked for an agent to be torn down. Carried on the
 * `kici.scaler.scale-down` event so a teardown workflow (and the timeline) can
 * distinguish an idle reap from a job-complete teardown or a spawn timeout.
 */
export const ScaleDownReason = z.enum([
  'idle',
  'job-complete',
  'heartbeat-timeout',
  'spawn-timeout',
  'drain',
  'shutdown',
]);
export type ScaleDownReason = z.infer<typeof ScaleDownReason>;

/**
 * Payload of a `kici.scaler.scale-up` event. Everything a provisioning workflow
 * needs to boot an instance whose agent registers back with `agentId` and claim
 * its ephemeral credentials with `claimCode`. The ephemeral token itself is
 * NEVER in this payload — it is delivered only via the
 * `scaler.claim-credentials` RPC response.
 */
export const ScalerScaleUpPayload = z.object({
  /** Name of the scaler entry that emitted the event. */
  scalerName: z.string(),
  /** Agent id the provisioned instance must register with (correlates the spawn). */
  agentId: z.string(),
  /** Exact label set the pending job needs. */
  labels: z.array(z.string()),
  /** Mandatory (taint) labels the pool gates on, if any. */
  mandatoryLabels: z.array(z.string()).default([]),
  /** Resolved resource hints for the provision (e.g. cpus / memBytes). */
  resources: z.record(z.string(), z.unknown()).default({}),
  /** Orchestrator WS URL the provisioned agent connects back to. */
  orchestratorUrl: z.string(),
  /** Single-use code the workflow exchanges for ephemeral agent credentials. */
  claimCode: z.string(),
  /** Execution job id the spawn is bound to (absent for unbound / warm spawns). */
  jobId: z.string().optional(),
  /** Correlation id for this scale-up request. */
  requestId: z.string(),
});
export type ScalerScaleUpPayload = z.infer<typeof ScalerScaleUpPayload>;

/**
 * Payload of a `kici.scaler.scale-down` event. A teardown workflow deletes the
 * instance registered under `agentId`.
 */
export const ScalerScaleDownPayload = z.object({
  /** Name of the scaler entry that emitted the event. */
  scalerName: z.string(),
  /** Agent id whose instance should be torn down. */
  agentId: z.string(),
  /** Why the teardown was requested. */
  reason: ScaleDownReason,
  /** Correlation id for this scale-down request. */
  requestId: z.string(),
});
export type ScalerScaleDownPayload = z.infer<typeof ScalerScaleDownPayload>;
