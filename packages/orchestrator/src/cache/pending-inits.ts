/**
 * Pending init tracker for coordinating init-then-execute pipeline.
 *
 * The orchestrator dispatches an init job for dynamic context resolution
 * and waits for the agent to return the resolved field values
 * (contextNames, env, concurrencyGroup). The underlying tracker logic lives
 * in `PendingTracker<InitResult>`; this subclass wires the init-specific
 * logger prefix and disconnect error.
 */

import { PendingTracker } from './pending-tracker.js';

export interface InitResult {
  /** Resolved bound-context names, in merge order (one per `contexts` element). */
  contextNames?: string[];
  env?: Record<string, string>;
  concurrencyGroup?: string;
  /**
   * Resolved matrix combinations when the target job's matrix is a dynamic
   * function. The dispatch path re-materializes these into N execution jobs.
   */
  matrixValues?: Array<Record<string, string | undefined>>;
  /**
   * Verdict of the workflow-level `filter`, reported only when the init job was
   * asked to evaluate one. `false` means the workflow does not apply to this
   * event and its job must not be dispatched.
   *
   * Optional on purpose: an agent that predates the filter never sends it, so
   * absence means "no verdict was reported" and dispatch proceeds — only an
   * explicit `false` suppresses.
   */
  filterPassed?: boolean;
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
