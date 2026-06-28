/**
 * Schedule trigger helper - creates triggers for cron-based workflow execution.
 * Returns a frozen ScheduleTriggerConfig directly.
 */

import type { DispatchInputsMap, ScheduleConfigInput, ScheduleTriggerConfig } from './types.js';

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
 *
 * // Daily at midnight UTC, with a defaults-only input
 * schedule({ cron: '0 0 * * *', inputs: { mode: z.enum(['full', 'quick']).default('full') } })
 */
export function schedule(config: ScheduleConfigInput): ScheduleTriggerConfig {
  if (!config.cron || config.cron.trim() === '') {
    throw new Error('schedule() requires a non-empty cron expression');
  }

  // A defineDispatchInputs(...) handle carries the map under `.map`; a bare
  // `{ name: ZodSchema }` map is stored as-is.
  const rawInputs = config.inputs;
  let inputsMap: DispatchInputsMap | undefined;
  if (rawInputs) {
    inputsMap =
      '__kiciDispatchInputs' in rawInputs
        ? (rawInputs as { map: DispatchInputsMap }).map
        : (rawInputs as DispatchInputsMap);
  }

  const result: ScheduleTriggerConfig = {
    _tag: 'ScheduleTrigger',
    cron: config.cron,
    timezone: config.timezone ?? 'UTC',
    ...(config.description !== undefined && { description: config.description }),
    ...(inputsMap && { inputs: Object.freeze({ ...inputsMap }) }),
  };

  return Object.freeze(result);
}
