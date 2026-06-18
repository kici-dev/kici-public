/**
 * Lifecycle trigger helper - creates triggers for cross-workflow lifecycle events.
 * Returns a frozen LifecycleTriggerConfig directly.
 */

import type { LifecycleConfigInput, LifecycleTriggerConfig } from './types.js';

/**
 * Create a lifecycle trigger configuration.
 *
 * @example
 * // Trigger on any workflow completion
 * lifecycle({ events: ['workflow_complete'] })
 *
 * // Trigger on job failures from a specific source
 * lifecycle({ events: ['job_failed'], sources: ['org/deploy-repo'] })
 *
 * // Trigger when workflow registrations are updated
 * lifecycle({ events: ['registration_updated'] })
 */
export function lifecycle(config: LifecycleConfigInput): LifecycleTriggerConfig {
  if (!config.events || config.events.length === 0) {
    throw new Error('lifecycle() requires a non-empty events array');
  }

  const result: LifecycleTriggerConfig = {
    _tag: 'LifecycleTrigger',
    events: Object.freeze([...config.events]),
    ...(config.sources !== undefined && { sources: Object.freeze([...config.sources]) }),
    ...(config.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
