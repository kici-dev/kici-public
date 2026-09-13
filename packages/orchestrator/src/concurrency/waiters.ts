/**
 * In-memory waiter registry for the long-poll concurrency protocol.
 *
 * When the orchestrator acks a `concurrency.report` with `{ action: 'wait' }`,
 * the agent stays connected on the same WS waiting for an unsolicited follow-up
 * `concurrency.ack`. This module tracks which agent is parked on which queued
 * run so that, when a slot frees, we can find the right WS to wake up.
 *
 * The store is keyed on `(groupKey, routingKey)` tuples and preserves FIFO
 * order within each scope (the same ordering invariant the queue manager uses
 * in `concurrency_groups.created_at`).
 *
 * State is in-memory only — orchestrator restarts drop all WS connections
 * anyway, so a queued waiter that survived a restart would have no agent to
 * notify. The slot-release helper handles the missing-waiter case by marking
 * the just-dequeued entry completed (effectively cancelling it).
 */

export interface WaiterEntry {
  /** The run id queued behind a held slot. */
  runId: string;
  /** The job id the agent is parked on. */
  jobId: string;
  /** The agent id holding the WS connection. */
  agentId: string;
}

export class ConcurrencyWaiters {
  /** Scoped state: `${routingKey}\0${groupKey}` -> ordered FIFO of waiters. */
  private readonly waiters = new Map<string, WaiterEntry[]>();

  private scopeKey(groupKey: string, routingKey: string): string {
    return `${routingKey}\0${groupKey}`;
  }

  /**
   * Register a waiter for the given (group, routingKey). FIFO order is
   * preserved across multiple registrations.
   */
  register(groupKey: string, routingKey: string, entry: WaiterEntry): void {
    const k = this.scopeKey(groupKey, routingKey);
    const list = this.waiters.get(k) ?? [];
    list.push(entry);
    this.waiters.set(k, list);
  }

  /**
   * Pop the FIFO-first waiter whose runId matches the given runId. Returns
   * undefined if no waiter for that runId is registered (e.g. after an
   * orchestrator restart, or because the WS already disconnected and called
   * dropForAgent).
   *
   * Matches by runId (not "shift the head") because the queue-manager's
   * `dequeueNext()` may pick a specific row; the in-memory tracker has to
   * follow the DB's verdict, not the in-memory FIFO head independently.
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
   * Drop all waiters owned by the given agent. Returns the dropped entries so
   * the caller can `cancelQueued(runId)` the matching DB rows and emit failure
   * events.
   *
   * Called from the agent-handler `onClose` so a disconnect doesn't leave a
   * queued row dangling forever.
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
