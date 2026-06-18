/**
 * KiCI event trigger helper - creates triggers for custom named events.
 * Returns a frozen KiciEventTriggerConfig directly.
 */

import type { KiciEventConfigInput, KiciEventTriggerConfig } from './types.js';

/**
 * Create a KiCI custom event trigger configuration.
 *
 * @example
 * // Match a specific event by name
 * kiciEvent({ name: 'deploy-complete' })
 *
 * // With JSONPath payload matching
 * kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } })
 *
 * // With negative filter
 * kiciEvent({ name: 'deploy-complete', not: { '$.env': 'staging' } })
 *
 * // Cross-repo source filter
 * kiciEvent({ name: 'deploy-complete', source: 'org/infra-repo' })
 */
export function kiciEvent(config: KiciEventConfigInput): KiciEventTriggerConfig {
  if (!config.name || config.name.trim() === '') {
    throw new Error('kiciEvent() requires a non-empty name');
  }

  const result: KiciEventTriggerConfig = {
    _tag: 'KiciEventTrigger',
    name: config.name,
    ...(config.match !== undefined && { match: Object.freeze({ ...config.match }) }),
    ...(config.source !== undefined && { source: config.source }),
    ...(config.not !== undefined && { not: Object.freeze({ ...config.not }) }),
    ...(config.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
