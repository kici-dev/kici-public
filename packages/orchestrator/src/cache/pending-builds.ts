/**
 * Awaits a build job in the build-then-execute pipeline, before cache URLs are
 * retrieved and execution jobs dispatched.
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
