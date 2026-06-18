/**
 * Schedule trigger helper - creates triggers for cron-based workflow execution.
 * Returns a frozen ScheduleTriggerConfig directly.
 */

import type { ScheduleConfigInput, ScheduleTriggerConfig } from './types.js';

/**
 * Create a schedule trigger configuration.
 *
 * @example
 * // Run every hour
 * schedule({ cron: '0 * * * *' })
 *
 * // Run daily at midnight UTC
 * schedule({ cron: '0 0 * * *' })
 *
 * // Run weekly on Monday at 9am in a specific timezone
 * schedule({ cron: '0 9 * * 1', timezone: 'America/New_York' })
 */
export function schedule(config: ScheduleConfigInput): ScheduleTriggerConfig {
  if (!config.cron || config.cron.trim() === '') {
    throw new Error('schedule() requires a non-empty cron expression');
  }

  const result: ScheduleTriggerConfig = {
    _tag: 'ScheduleTrigger',
    cron: config.cron,
    timezone: config.timezone ?? 'UTC',
    ...(config.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
