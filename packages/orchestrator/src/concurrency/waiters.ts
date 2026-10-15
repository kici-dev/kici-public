/**
 * In-memory waiter registry for the long-poll concurrency protocol.
 *
 * When the orchestrator acks a `job.concurrency.report` with `{ action: 'wait' }`,
 * the agent stays connected on the same WS waiting for an unsolicited follow-up
 * `job.concurrency.ack`; this tracks which agent is parked on which queued run.
 *
 * Keyed on `(groupKey, routingKey)`, FIFO within each scope (the queue
 * manager's `concurrency_groups.created_at` ordering).
 *
 * In-memory only: a restart drops every WS anyway. The slot-release helper
 * marks a dequeued entry with no waiter completed (effectively cancelled).
 */

export interface WaiterEntry {
  /** The run id queued behind a held slot. */
  runId: string;
  jobId: string;
  /** The agent holding the WS connection. */
  agentId: string;
}

export class ConcurrencyWaiters {
  /** `${routingKey}\0${groupKey}` -> FIFO of waiters. */
  private readonly waiters = new Map<string, WaiterEntry[]>();

  private scopeKey(groupKey: string, routingKey: string): string {
    return `${routingKey}\0${groupKey}`;
  }

  register(groupKey: string, routingKey: string, entry: WaiterEntry): void {
    const k = this.scopeKey(groupKey, routingKey);
    const list = this.waiters.get(k) ?? [];
    list.push(entry);
    this.waiters.set(k, list);
  }

  /**
   * Pop the first waiter for `runId`; undefined when none (orchestrator
   * restart, or the WS already disconnected and called dropForAgent). Matches
   * by runId, not the FIFO head, because `dequeueNext()` picks the row and the
   * in-memory tracker must follow the DB's verdict.
   */
  popByRunId(groupKey: string, routingKey: string, runId: string): WaiterEntry | undefined {
    const k = this.scopeKey(groupKey, routingKey);
    const list = this.waiters.get(k);
    if (!list) return undefined;
    const idx = list.findIndex((w) => w.runId === runId);
    if (idx === -1) return undefined;
    const [removed] = list.splice(idx, 1);
    if (list.length === 0) this.waiters.delete(k);
    return removed;
  }

  /**
   * Drop the agent's waiters, returning them so the caller can
   * `cancelQueued(runId)` and emit failure events. Called from the
   * agent-handler `onClose` so a disconnect never leaves a queued row dangling.
   */
  dropForAgent(agentId: string): WaiterEntry[] {
    const dropped: WaiterEntry[] = [];
    for (const [k, list] of this.waiters) {
      const remaining: WaiterEntry[] = [];
      for (const entry of list) {
        if (entry.agentId === agentId) {
          dropped.push(entry);
        } else {
          remaining.push(entry);
        }
      }
      if (remaining.length === 0) {
        this.waiters.delete(k);
      } else if (remaining.length !== list.length) {
        this.waiters.set(k, remaining);
      }
    }
    return dropped;
  }

  /** Number of registered waiters. Test-only. */
  size(): number {
    let total = 0;
    for (const list of this.waiters.values()) total += list.length;
    return total;
  }
}
