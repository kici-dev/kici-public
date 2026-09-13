/**
 * Job complete trigger helper - creates triggers for job completion events.
 * Returns a frozen JobCompleteTriggerConfig directly.
 */

import type { JobCompleteConfigInput, JobCompleteTriggerConfig } from './types.js';

/**
 * Create a job completion trigger configuration.
 *
 * @example
 * // Match any job completion
 * jobComplete()
 *
 * // Match specific workflow + job
 * jobComplete({ workflow: 'CI', job: 'build' })
 *
 * // Match successful completions only
 * jobComplete({ workflow: 'CI', job: 'build', status: ['success'] })
 *
 * // Cross-repo source filter
 * jobComplete({ workflow: 'CI', job: 'build', source: 'org/repo' })
 */
export function jobComplete(config?: JobCompleteConfigInput): JobCompleteTriggerConfig {
  const result: JobCompleteTriggerConfig = {
    _tag: 'JobCompleteTrigger',
    ...(config?.workflow !== undefined && { workflow: config.workflow }),
    ...(config?.job !== undefined && { job: config.job }),
    ...(config?.status !== undefined && {
      status: Object.freeze([...config.status]),
    }),
    ...(config?.source !== undefined && { source: config.source }),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
