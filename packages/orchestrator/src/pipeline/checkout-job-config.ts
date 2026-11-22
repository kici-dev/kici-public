/**
 * The checkout keys a dispatched job config carries, read from a lock job.
 *
 * A static job's lock is compiler output; a generated job's arrives as agent
 * JSON. Both pass through the same validation, so only a boolean `checkout`
 * and a schema-valid `checkoutOptions` reach the agent's clone.
 */

import { parseLockCheckoutOptions, type LockCheckoutOptions } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import { agentVersionAtLeast } from '../agent/agent-version.js';

const logger = createLogger({ prefix: 'pipeline:checkout' });

/** The `checkout` / `checkoutOptions` fields of a job config; absent keys mean the default clone. */
export function checkoutJobConfigFields(job: {
  readonly name: string;
  readonly checkout?: unknown;
  readonly checkoutOptions?: unknown;
}): { checkout?: boolean; checkoutOptions?: LockCheckoutOptions } {
  const fields: { checkout?: boolean; checkoutOptions?: LockCheckoutOptions } = {};
  if (typeof job.checkout === 'boolean') fields.checkout = job.checkout;
  if (job.checkoutOptions !== undefined) {
    const options = parseLockCheckoutOptions(job.checkoutOptions);
    if (options) {
      fields.checkoutOptions = options;
    } else {
      logger.warn('Dropping an invalid checkoutOptions from a job', { jobName: job.name });
    }
  }
  return fields;
}

/**
 * The first agent release that runs a `checkout: false` job. An earlier agent
 * skips the clone when it receives the flag, but then has no `.kici/` to load
 * the workflow from, so the job fails. Such an agent gets the job without the
 * flag and clones as it always did.
 *
 * `checkoutOptions` needs no gate: an earlier agent ignores the key.
 */
export const MIN_CHECKOUT_SKIP_AGENT_VERSION = '0.29.0';

/**
 * The job config to send one agent: `jobConfig` itself, or a copy without
 * `checkout: false` when the agent's version is below
 * {@link MIN_CHECKOUT_SKIP_AGENT_VERSION} or unknown.
 */
export function jobConfigForAgent(
  jobConfig: Record<string, unknown>,
  agent: { readonly agentId: string; readonly version: string | null | undefined },
  jobId: string,
): Record<string, unknown> {
  if (jobConfig.checkout !== false) return jobConfig;
  if (agentVersionAtLeast(agent.version, MIN_CHECKOUT_SKIP_AGENT_VERSION)) return jobConfig;
  logger.info('Agent is too old to skip the clone; the checkout: false job clones instead', {
    jobId,
    agentId: agent.agentId,
    agentVersion: agent.version ?? null,
    minimumVersion: MIN_CHECKOUT_SKIP_AGENT_VERSION,
  });
  const { checkout: _dropped, ...rest } = jobConfig;
  return rest;
}
