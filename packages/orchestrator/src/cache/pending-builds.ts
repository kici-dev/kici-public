/**
 * Pending build tracker for coordinating build-then-execute pipeline.
 *
 * The orchestrator dispatches a build job and waits for the build agent to
 * finish before retrieving cache URLs and dispatching execution jobs. The
 * underlying tracker logic lives in `PendingTracker<void>`; this subclass
 * just wires the build-specific logger prefix and disconnect error.
 */

import { PendingTracker } from './pending-tracker.js';

export class PendingBuildTracker extends PendingTracker<void> {
  constructor() {
    super({
      logPrefix: 'pending-builds',
      itemLabel: 'build',
      disconnectError: 'Build agent disconnected',
    });
  }

  override resolve(jobId: string): void {
    super.resolve(jobId, undefined);
  }
}
