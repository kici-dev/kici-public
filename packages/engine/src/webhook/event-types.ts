/**
 * Outbound-webhook event types a customer can subscribe an endpoint to, read
 * by the Platform route validator and the dashboard endpoint-create checkbox
 * list.
 *
 * Pure Zod: the dashboard imports this through the engine barrel, so no Node
 * built-in may appear here.
 *
 * `docs/user/dashboard/settings.md` § Webhooks lists the subscribable types;
 * a new type updates that list in the same change.
 */
import { z } from 'zod';

/**
 * The run/job lifecycle events an endpoint can subscribe to; `WebhookEventType`
 * adds the ping. Module-private so `SUBSCRIBABLE_WEBHOOK_EVENT_TYPES` is the one
 * public name for this list.
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
 * The accepted set of `SubscribableWebhookEventType`, in declaration order, for
 * iteration (UI checkbox list, tests).
 *
 * A frozen copy, not `SubscribableWebhookEventType.options`: that getter returns
 * the validator's own internal array, so any consumer could `push` / `sort` the
 * vocabulary out from under every other module. `event-types.test.ts` asserts
 * the copy still matches the validator's options.
 */
export const SUBSCRIBABLE_WEBHOOK_EVENT_TYPES = Object.freeze([...SUBSCRIBABLE_EVENT_VALUES]);
