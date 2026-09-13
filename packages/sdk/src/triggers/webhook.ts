/**
 * Webhook trigger helper - catch-all trigger for any GitHub webhook event.
 * Returns a frozen WebhookTriggerConfig directly.
 *
 * Unlike other triggers, `events` is required -- catch-all must specify what to catch.
 */

import type { BranchPattern, WebhookConfigInput, WebhookTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a catch-all webhook trigger configuration.
 *
 * @example
 * // Match deployment events
 * webhook({ events: ['deployment'] })
 *
 * // Match multiple events with actions
 * webhook({ events: ['deployment', 'deployment_status'], actions: ['created'] })
 */
export function webhook(config: WebhookConfigInput): WebhookTriggerConfig {
  if (!config.events || config.events.length === 0) {
    throw new Error('webhook() requires a non-empty events array');
  }

  const repos: BranchPattern[] = config.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: WebhookTriggerConfig = {
    _tag: 'WebhookTrigger',
    events: Object.freeze([...config.events]),
    actions: Object.freeze(config.actions ? [...config.actions] : []),
    repos: Object.freeze([...repos]),
    ...(config.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
