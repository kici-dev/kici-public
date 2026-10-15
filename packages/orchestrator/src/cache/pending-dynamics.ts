/**
 * Awaits the `LockJob[]` an agent returns after evaluating a DynamicJobFn
 * (runtime job generation). Logic lives in `PendingTracker`.
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
