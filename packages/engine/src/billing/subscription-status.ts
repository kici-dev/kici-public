import { z } from 'zod';

/**
 * The Stripe subscription-status vocabulary, as stored in
 * `organizations.stripe_subscription_status`.
 *
 * Lives in the engine rather than the Platform package for the same reason
 * `plan-type.ts` does: the browser dashboard must classify a status with the
 * same predicate the Platform route uses, and it cannot import a private
 * package. Pure Zod with no Node built-ins, so it is safe on the engine barrel.
 *
 * The stored column is plain text written straight from Stripe, so read it with
 * `safeParse` — a status Stripe adds later must not fail a whole response.
 */
export const StripeSubscriptionStatus = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
export type StripeSubscriptionStatus = z.infer<typeof StripeSubscriptionStatus>;

/**
 * Error code the checkout route returns when the org already holds a
 * subscription Stripe is still honouring.
 */
export const SUBSCRIPTION_EXISTS_CODE = 'SUBSCRIPTION_EXISTS';

/**
 * Statuses in which a second Checkout would create a second live subscription.
 *
 * `active` and `trialing` are plainly live. `past_due` is too: Stripe is still
 * retrying the invoice and the subscription is still attached to the customer,
 * so a second checkout leaves the customer paying twice — and cancelling
 * "the old plan" afterwards fires `customer.subscription.deleted` for that id,
 * which downgrades the org while the second subscription keeps charging.
 *
 * A plan change from any of these belongs in the Stripe Billing Portal, which
 * is configured for prorated in-place changes.
 */
const CHECKOUT_BLOCKING_STATUSES: ReadonlySet<StripeSubscriptionStatus> = new Set([
  StripeSubscriptionStatus.enum.active,
  StripeSubscriptionStatus.enum.trialing,
  StripeSubscriptionStatus.enum.past_due,
]);

/**
 * Does this stored `(subscriptionId, status)` pair block a new Checkout?
 *
 * Both halves matter: an org whose subscription genuinely ended has a null
 * `stripe_subscription_id` (written by the `customer.subscription.deleted`
 * handler) and must reach checkout normally.
 */
export function blocksNewCheckout(
  subscriptionId: string | null | undefined,
  status: string | null | undefined,
): boolean {
  if (!subscriptionId) return false;
  const parsed = StripeSubscriptionStatus.safeParse(status);
  return parsed.success && CHECKOUT_BLOCKING_STATUSES.has(parsed.data);
}
