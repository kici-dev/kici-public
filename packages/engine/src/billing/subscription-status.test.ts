import { describe, it, expect } from 'vitest';
import {
  StripeSubscriptionStatus,
  SUBSCRIPTION_EXISTS_CODE,
  blocksNewCheckout,
} from './subscription-status.js';

describe('blocksNewCheckout', () => {
  it('blocks while Stripe is still honouring the subscription', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(blocksNewCheckout('sub_1', status)).toBe(true);
    }
  });

  it('allows a re-subscribe for every terminal or not-yet-live status', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(blocksNewCheckout('sub_1', status)).toBe(false);
    }
  });

  it('allows checkout when no subscription id is stored, whatever the status says', () => {
    // `customer.subscription.deleted` nulls the id, so a stale status left on
    // the row must never block the org from subscribing again.
    expect(blocksNewCheckout(null, 'active')).toBe(false);
    expect(blocksNewCheckout(undefined, 'past_due')).toBe(false);
    expect(blocksNewCheckout('', 'active')).toBe(false);
  });

  it('allows checkout on a status outside the known vocabulary', () => {
    // The column is plain text written straight from Stripe. A status we do not
    // recognise must not be read as "live" — that would lock an org out of
    // subscribing with no way back.
    expect(blocksNewCheckout('sub_1', 'some_future_status')).toBe(false);
    expect(blocksNewCheckout('sub_1', null)).toBe(false);
  });

  it('classifies every status in the vocabulary', () => {
    for (const status of StripeSubscriptionStatus.options) {
      expect(typeof blocksNewCheckout('sub_1', status)).toBe('boolean');
    }
  });
});

describe('SUBSCRIPTION_EXISTS_CODE', () => {
  it('is the literal the checkout route and the dashboard both match on', () => {
    expect(SUBSCRIPTION_EXISTS_CODE).toBe('SUBSCRIPTION_EXISTS');
  });
});
