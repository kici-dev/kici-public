/**
 * Shared outbound-webhook event-type vocabulary — the single source of truth for
 * the event types a customer can subscribe an endpoint to, consumed by the
 * Platform route validator and the dashboard endpoint-create checkbox list.
 *
 * Pure Zod (browser-safe): the engine barrel re-exports this module and the
 * dashboard imports the barrel, so no Node built-in may appear here.
 *
 * `docs/user/dashboard/settings.md` § Webhooks lists the subscribable types in
 * prose — adding a type here means updating that list in the same change.
 */
import { z } from 'zod';

/**
 * Subscribable webhook event types — the run/job lifecycle events a customer can
 * wire an endpoint to. Written once here; the full `WebhookEventType` enum
 * derives from these plus the non-subscribable ping. Module-private on purpose:
 * `SUBSCRIBABLE_WEBHOOK_EVENT_TYPES` is the one public name for this list, so
 * consumers cannot pick between two spellings of the same vocabulary.
 */
const SUBSCRIBABLE_EVENT_VALUES = [
  'run.started',
  'run.completed',
  'run.failed',
  'job.started',
  'job.completed',
  'job.failed',
] as const;

/**
 * The connectivity-check event the test-endpoint button sends. It is not
 * subscribable, and a failed ping never counts toward an endpoint's
 * consecutive-failure budget — a customer probing a not-yet-live receiver must
 * not be able to auto-disable their own endpoint.
 */
export const PING_EVENT_TYPE = 'ping';

/** Zod enum for the subscribable set — usable directly as a route schema. */
export const SubscribableWebhookEventType = z.enum(SUBSCRIBABLE_EVENT_VALUES);
export type SubscribableWebhookEventType = z.infer<typeof SubscribableWebhookEventType>;

/**
 * All outbound webhook event types (the Stripe-style envelope `type`, also sent
 * as the X-KiCI-Event header): the subscribable set plus the ping, which is
 * emitted only by the test-endpoint button and is never subscribable.
 */
export const WebhookEventType = z.enum([...SUBSCRIBABLE_EVENT_VALUES, PING_EVENT_TYPE]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/**
 * Readonly value tuple for iteration (UI checkbox list, tests) — the accepted
 * set of `SubscribableWebhookEventType`, in declaration order.
 *
 * A frozen copy, not `SubscribableWebhookEventType.options`: Zod hands back the
 * validator's own internal array from that getter, so re-exporting it would let
 * any consumer `push` / `sort` the shared vocabulary out from under every other
 * module in the process. `event-types.test.ts` asserts the copy still matches
 * the validator's options.
 */
export const SUBSCRIBABLE_WEBHOOK_EVENT_TYPES = Object.freeze([...SUBSCRIBABLE_EVENT_VALUES]);
