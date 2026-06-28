/**
 * Pending init tracker for coordinating init-then-execute pipeline.
 *
 * The orchestrator dispatches an init job for dynamic environment resolution
 * and waits for the agent to return the resolved field values
 * (environmentNames, env, concurrencyGroup). The underlying tracker logic lives
 * in `PendingTracker<InitResult>`; this subclass wires the init-specific
 * logger prefix and disconnect error.
 */

import { PendingTracker } from './pending-tracker.js';

export interface InitResult {
  /** Resolved bound-environment names, in merge order (one per `environments` element). */
  environmentNames?: string[];
  env?: Record<string, string>;
  concurrencyGroup?: string;
  /**
   * Resolved matrix combinations when the target job's matrix is a dynamic
   * function. The dispatch path re-materializes these into N execution jobs.
   */
  matrixValues?: Array<Record<string, string | undefined>>;
}

export class PendingInitTracker extends PendingTracker<InitResult> {
  constructor() {
    super({
      logPrefix: 'pending-inits',
      itemLabel: 'init',
      disconnectError: 'Init agent disconnected',
    });
  }
}
