import { describe, it, expectTypeOf } from 'vitest';
import type * as engine from '../index.js';
import type * as provider from './index.js';

/**
 * The contributor-resolution surface is gone from the provider abstraction.
 * `ContributorResolver` and its companions were type-only, so no runtime probe
 * can see them return; only the compiler can.
 */
describe('provider barrel', () => {
  // fails-when: ContributorResolver is exported from the provider barrel again
  it('exports no ContributorResolver', () => {
    // @ts-expect-error — the contributor-resolution interface no longer exists
    expectTypeOf<provider.ContributorResolver>().toBeObject();
  });

  // fails-when: ContributorInfo, ContributorPermission or AccessCacheInvalidation
  // return to the engine root barrel
  it('exports none of the contributor-resolution companions from the root', () => {
    // @ts-expect-error — removed with ContributorResolver
    expectTypeOf<engine.ContributorInfo>().toBeObject();
    // @ts-expect-error — removed with ContributorResolver
    expectTypeOf<engine.ContributorPermission>().toBeString();
    // @ts-expect-error — removed with ContributorResolver
    expectTypeOf<engine.AccessCacheInvalidation>().toBeObject();
  });

  // fails-when: the access-cache invalidation hook returns to the normalizer contract
  it('gives WebhookNormalizer no access-cache invalidation hook', () => {
    expectTypeOf<engine.WebhookNormalizer>().not.toHaveProperty('getAccessCacheInvalidations');
  });

  // breaks-if-wrong: the surviving provider contract must still be exported and whole
  it('keeps the live normalizer contract', () => {
    expectTypeOf<engine.WebhookNormalizer>().toHaveProperty('provider');
    expectTypeOf<engine.WebhookNormalizer>().toHaveProperty('normalizeEvent');
    expectTypeOf<engine.WebhookNormalizer>().toHaveProperty('verifySignature');
    expectTypeOf<provider.WebhookNormalizer>().toEqualTypeOf<engine.WebhookNormalizer>();
  });
});
