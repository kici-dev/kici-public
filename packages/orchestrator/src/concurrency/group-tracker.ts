/**
 * In-memory concurrency group tracker.
 *
 * Tracks active runs per concurrency group, scoped by routing key
 * to prevent cross-repo interference. Supports slot acquisition/release
 * and hydration from DB records on startup.
 */

/** Record used to hydrate tracker state from DB on startup. */
export interface HydrateRecord {
  groupKey: string;
  routingKey: string;
  runId: string;
}

export class ConcurrencyGroupTracker {
  /**
   * Scoped state: "routingKey::groupKey" -> ordered list of active run IDs.
   * Using an array (not Set) to preserve insertion order for getOldestRun().
   */
  private readonly groups = new Map<string, string[]>();

  private scopeKey(groupKey: string, routingKey: string): string {
    return `${routingKey}::${groupKey}`;
  }

  private getOrCreateGroup(groupKey: string, routingKey: string): string[] {
    const key = this.scopeKey(groupKey, routingKey);
    let runs = this.groups.get(key);
    if (!runs) {
      runs = [];
      this.groups.set(key, runs);
    }
    return runs;
  }

  /**
   * Try to acquire a slot in the concurrency group.
   * Returns true if under max capacity and the run was added, false otherwise.
   * Idempotent: re-acquiring an already-active run returns true without double-adding.
   */
  acquireSlot(groupKey: string, routingKey: string, runId: string, opts: { max: number }): boolean {
    const runs = this.getOrCreateGroup(groupKey, routingKey);

    // Idempotent: already active
    if (runs.includes(runId)) {
      return true;
    }

    if (runs.length >= opts.max) {
      return false;
    }

    runs.push(runId);
    return true;
  }

  /**
   * Release a slot in the concurrency group.
   * No-op if the run ID is not active.
   */
  releaseSlot(groupKey: string, routingKey: string, runId: string): void {
    const key = this.scopeKey(groupKey, routingKey);
    const runs = this.groups.get(key);
    if (!runs) return;

    const idx = runs.indexOf(runId);
    if (idx !== -1) {
      runs.splice(idx, 1);
    }

    // Clean up empty entries
    if (runs.length === 0) {
      this.groups.delete(key);
    }
  }

  /**
   * Get all active run IDs in a concurrency group.
   * Returns a copy of the array.
   */
  getActiveRuns(groupKey: string, routingKey: string): string[] {
    const key = this.scopeKey(groupKey, routingKey);
    return [...(this.groups.get(key) ?? [])];
  }

  /**
   * Get the oldest active run in a concurrency group.
   * Used by cancelInProgress mode to determine which run to cancel.
   */
  getOldestRun(groupKey: string, routingKey: string): string | null {
    const key = this.scopeKey(groupKey, routingKey);
    const runs = this.groups.get(key);
    if (!runs || runs.length === 0) return null;
    return runs[0];
  }

  /**
   * Hydrate tracker state from DB records.
   * Called on orchestrator startup to restore active concurrency groups.
   */
  hydrate(records: HydrateRecord[]): void {
    for (const record of records) {
      const runs = this.getOrCreateGroup(record.groupKey, record.routingKey);
      if (!runs.includes(record.runId)) {
        runs.push(record.runId);
      }
    }
  }
}
