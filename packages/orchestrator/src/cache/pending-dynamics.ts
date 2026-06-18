/**
 * Pending dynamic-eval tracker for coordinating DynamicJobFn evaluation pipeline.
 *
 * The orchestrator dispatches a dynamic eval job for runtime job generation and
 * waits for the agent to evaluate the DynamicJobFn and return the generated
 * `LockJob[]` array. The underlying tracker logic lives in
 * `PendingTracker<LockJob[]>`; this subclass wires the dynamic-eval-specific
 * logger prefix and disconnect error.
 */

import type { LockJob } from '@kici-dev/engine';
import { PendingTracker } from './pending-tracker.js';

export class PendingDynamicTracker extends PendingTracker<LockJob[]> {
  constructor() {
    super({
      logPrefix: 'pending-dynamics',
      itemLabel: 'dynamic eval',
      disconnectError: 'Dynamic eval agent disconnected',
      extractResolveMeta: (jobs) => ({ jobCount: jobs.length }),
    });
  }
}
