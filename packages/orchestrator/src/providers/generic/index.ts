/**
 * Generic webhook provider implementations for KiCI.
 *
 * Unlike Git providers (GitHub, GitLab, Bitbucket), the generic provider
 * only implements WebhookNormalizer. Git-related methods (lock file fetching,
 * changed files, clone tokens, URL building) are not applicable for
 * arbitrary webhook sources.
 */

import type { ProviderBundle } from '../../provider-registry.js';
import { GenericWebhookNormalizer } from './normalizer.js';
import type { GenericSourceManager } from '../../webhook/generic-sources.js';

export { GenericWebhookNormalizer } from './normalizer.js';
export {
  verifyGenericWebhook,
  type VerificationMethod,
  type VerificationConfig,
  type HmacVerificationConfig,
  type BearerVerificationConfig,
  type IpAllowlistVerificationConfig,
  type NoneVerificationConfig,
} from './verification.js';

/**
 * Create a ProviderBundle for generic webhook sources.
 *
 * Only provides a normalizer -- no git-related methods.
 * The pipeline processor handles missing capabilities gracefully.
 *
 * @param sourceManager - GenericSourceManager for source config lookup
 * @returns ProviderBundle with normalizer only
 */
export function createGenericProviderBundle(sourceManager: GenericSourceManager): ProviderBundle {
  return {
    normalizer: new GenericWebhookNormalizer(sourceManager),
  };
}
