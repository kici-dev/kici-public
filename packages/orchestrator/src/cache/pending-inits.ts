/**
 * Awaits an init job (dynamic context resolution) in the init-then-execute
 * pipeline until the agent returns the resolved field values.
 */

import { PendingTracker } from './pending-tracker.js';

export interface InitResult {
  /** Resolved bound-context names, in merge order (one per `contexts` element). */
  contextNames?: string[];
  env?: Record<string, string>;
  concurrencyGroup?: string;
  /**
   * Matrix combinations of a dynamic-function matrix, which dispatch
   * re-materializes into N execution jobs.
   */
  matrixValues?: Array<Record<string, string | undefined>>;
  /**
   * The workflow-level `filter` verdict, when asked; `false` suppresses the
   * job. Optional because an agent predating the filter never sends it: absence
   * means "no verdict" and dispatch proceeds — only an explicit `false`
   * suppresses.
   */
  filterPassed?: boolean;
  /**
   * The deferred `paths` verdict, when asked; `false` (the clone diff matched
   * none) suppresses the job. Optional because an agent predating deferred
   * paths never sends it: absence means "no verdict" and dispatch proceeds.
   */
  pathsPassed?: boolean;
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
