/**
 * Generic webhook trigger helper - creates triggers for non-GitHub webhook sources.
 * Returns a frozen GenericWebhookTriggerConfig directly.
 */

import type { GenericWebhookConfigInput, GenericWebhookTriggerConfig } from './types.js';

/**
 * Create a generic webhook trigger configuration.
 *
 * @example
 * // Match any event from a source
 * genericWebhook({ source: 'my-service' })
 *
 * // Match specific event types
 * genericWebhook({ source: 'my-service', events: ['deploy', 'rollback'] })
 *
 * // With JSONPath payload matching
 * genericWebhook({ source: 'my-service', events: ['deploy'], match: { '$.env': 'prod' } })
 *
 * // With negative filter
 * genericWebhook({ source: 'my-service', not: { '$.dry_run': true } })
 *
 * // With HMAC-SHA256 auth
 * genericWebhook({ source: 'stripe', auth: { method: 'hmac-sha256', secret: 'stripe-key', signatureHeader: 'stripe-signature' } })
 *
 * // With API key auth
 * genericWebhook({ source: 'slack', auth: { method: 'api-key', secret: 'slack-token' } })
 *
 * // With path pattern
 * genericWebhook({ source: 'stripe', path: 'stripe/payments' })
 */
export function genericWebhook(config: GenericWebhookConfigInput): GenericWebhookTriggerConfig {
  if (!config.source || config.source.trim() === '') {
    throw new Error('genericWebhook() requires a non-empty source');
  }

  const result: GenericWebhookTriggerConfig = {
    _tag: 'GenericWebhookTrigger',
    source: config.source,
    ...(config.events !== undefined && {
      events: Object.freeze([...config.events]),
    }),
    ...(config.match !== undefined && { match: Object.freeze({ ...config.match }) }),
    ...(config.not !== undefined && { not: Object.freeze({ ...config.not }) }),
    ...(config.auth !== undefined && { auth: Object.freeze({ ...config.auth }) }),
    ...(config.path !== undefined && { path: config.path }),
    ...(config.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
