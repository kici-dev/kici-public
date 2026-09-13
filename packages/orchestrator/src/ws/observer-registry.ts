/**
 * Registry tracking active WebSocket observers per execution run.
 *
 * Multiple CLI clients can subscribe to observe the same run.
 * The registry handles:
 * - Per-run observer sets with subscribe/unsubscribe
 * - Broadcast of messages (log, step, status, complete) to all observers
 * - Message buffering with monotonic sequence numbers for reconnection backfill
 * - Automatic cleanup of closed/errored connections during broadcast
 * - TTL-based buffer cleanup after run completion
 */

import { createLogger } from '@kici-dev/shared';
import type { WsLike } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'observer-registry' });

/** Maximum number of messages to buffer per run for reconnection backfill. */
const BUFFER_SIZE = 1000;

/** How long to keep buffers after run completion (ms). */
const COMPLETION_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ObserverWsLike = WsLike;

/** An active observer connection. */
interface ObserverConnection {
  ws: ObserverWsLike;
  runId: string;
  lastSeenSequence: number;
  subscribedAt: number;
}

/** A buffered message with its sequence number. */
interface BufferedMessage {
  sequence: number;
  data: string;
}

export class ObserverRegistry {
  /** Per-run observer sets. */
  private readonly observers = new Map<string, Set<ObserverConnection>>();

  /** Per-run message buffers for reconnection backfill. */
  private readonly buffers = new Map<string, BufferedMessage[]>();

  /** Monotonic sequence counter per run. */
  private readonly sequenceCounters = new Map<string, number>();

  /** Scheduled buffer cleanup timers (for cancellation on new subscribe). */
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Subscribe an observer to a run.
   *
   * If `lastSeenSequence` is provided, buffered messages with sequence > lastSeenSequence
   * are replayed to the observer immediately.
   */
  subscribe(runId: string, ws: ObserverWsLike, lastSeenSequence?: number): void {
    // Cancel any pending buffer cleanup since we have a new observer
    const existingTimer = this.cleanupTimers.get(runId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.cleanupTimers.delete(runId);
    }

    let observerSet = this.observers.get(runId);
    if (!observerSet) {
      observerSet = new Set();
      this.observers.set(runId, observerSet);
    }

    const connection: ObserverConnection = {
      ws,
      runId,
      lastSeenSequence: lastSeenSequence ?? 0,
      subscribedAt: Date.now(),
    };

    observerSet.add(connection);

    logger.info('Observer subscribed', {
      runId,
      observerCount: observerSet.size,
      lastSeenSequence: lastSeenSequence ?? 'none',
    });

    // Backfill missed messages if lastSeenSequence provided
    if (lastSeenSequence !== undefined && lastSeenSequence > 0) {
      const buffer = this.buffers.get(runId);
      if (buffer) {
        const missed = buffer.filter((msg) => msg.sequence > lastSeenSequence);
        for (const msg of missed) {
          try {
            if (ws.readyState === 1) {
              ws.send(msg.data);
            }
          } catch {
            // Connection failed during backfill -- will be cleaned up on next broadcast
            logger.warn('Failed to backfill observer', { runId, sequence: msg.sequence });
          }
        }
        if (missed.length > 0) {
          logger.info('Observer backfill complete', {
            runId,
            messagesReplayed: missed.length,
          });
        }
      }
    }
  }

  /**
   * Unsubscribe an observer from a run.
   *
   * If the observer set becomes empty, the buffer is kept alive
   * for potential reconnection (TTL-based cleanup happens later).
   */
  unsubscribe(runId: string, ws: ObserverWsLike): void {
    const observerSet = this.observers.get(runId);
    if (!observerSet) return;

    for (const conn of observerSet) {
      if (conn.ws === ws) {
        observerSet.delete(conn);
        break;
      }
    }

    if (observerSet.size === 0) {
      this.observers.delete(runId);
    }

    logger.debug('Observer unsubscribed', {
      runId,
      remainingObservers: observerSet.size,
    });
  }

  /**
   * Broadcast a message object to all observers of a run.
   *
   * The message is serialized once, sent to all observers, and added to the
   * run's buffer with a monotonic sequence number. Closed/errored connections
   * are removed during broadcast.
   */
  broadcast(runId: string, message: object): void {
    // Assign sequence number
    const seq = this.nextSequence(runId);

    // Add sequence to message for client tracking
    const messageWithSeq = { ...message, sequence: seq };
    const data = JSON.stringify(messageWithSeq);

    // Buffer the message
    this.addToBuffer(runId, seq, data);

    // Send to all observers
    const observerSet = this.observers.get(runId);
    if (!observerSet || observerSet.size === 0) return;

    const toRemove: ObserverConnection[] = [];

    for (const conn of observerSet) {
      try {
        if (conn.ws.readyState === 1) {
          conn.ws.send(data);
        } else {
          toRemove.push(conn);
        }
      } catch {
        toRemove.push(conn);
      }
    }

    // Clean up closed/errored connections
    for (const conn of toRemove) {
      observerSet.delete(conn);
      logger.debug('Removed closed observer connection', { runId });
    }

    if (observerSet.size === 0) {
      this.observers.delete(runId);
    }
  }

  /**
   * Convenience: broadcast a log chunk message.
   */
  broadcastLog(
    runId: string,
    jobId: string,
    jobName: string,
    stepIndex: number,
    stepName: string,
    lines: string[],
  ): void {
    this.broadcast(runId, {
      type: 'observe.log',
      runId,
      jobId,
      jobName,
      stepIndex,
      stepName,
      lines,
      timestamp: Date.now(),
    });
  }

  /**
   * Convenience: broadcast a step lifecycle event.
   */
  broadcastStep(
    runId: string,
    jobId: string,
    jobName: string,
    stepName: string,
    state: string,
    durationMs?: number,
  ): void {
    this.broadcast(runId, {
      type: 'observe.step',
      runId,
      jobId,
      jobName,
      stepName,
      state,
      ...(durationMs !== undefined && { durationMs }),
      timestamp: Date.now(),
    });
  }

  /**
   * Convenience: broadcast a run status change.
   */
  broadcastStatus(runId: string, status: string, jobName?: string): void {
    this.broadcast(runId, {
      type: 'observe.status',
      runId,
      status,
      ...(jobName && { jobName }),
      timestamp: Date.now(),
    });
  }

  /**
   * Convenience: broadcast run completion with summary.
   *
   * After broadcasting, schedules buffer cleanup after COMPLETION_BUFFER_TTL_MS
   * to allow brief reconnection windows.
   */
  broadcastComplete(runId: string, status: string, summary: object): void {
    this.broadcast(runId, {
      type: 'observe.complete',
      runId,
      status,
      summary,
      timestamp: Date.now(),
    });

    // Schedule buffer cleanup after TTL
    const timer = setTimeout(() => {
      this.buffers.delete(runId);
      this.sequenceCounters.delete(runId);
      this.cleanupTimers.delete(runId);
      logger.debug('Buffer cleaned up after completion TTL', { runId });
    }, COMPLETION_BUFFER_TTL_MS);

    // Store timer for potential cancellation (if observer re-subscribes)
    this.cleanupTimers.set(runId, timer);
  }

  /**
   * Get the number of active observers for a run.
   */
  getObserverCount(runId: string): number {
    return this.observers.get(runId)?.size ?? 0;
  }

  /**
   * Check if a run has any active observers.
   */
  hasObservers(runId: string): boolean {
    const set = this.observers.get(runId);
    return set !== undefined && set.size > 0;
  }

  /**
   * Remove all buffers for completed runs.
   * Call periodically or on shutdown to reclaim memory.
   */
  cleanup(): void {
    // Clear all cleanup timers
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.buffers.clear();
    this.sequenceCounters.clear();
    this.observers.clear();
  }

  /**
   * Get the current sequence number for a run (for testing).
   */
  getCurrentSequence(runId: string): number {
    return this.sequenceCounters.get(runId) ?? 0;
  }

  /**
   * Get the buffer size for a run (for testing).
   */
  getBufferSize(runId: string): number {
    return this.buffers.get(runId)?.length ?? 0;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private nextSequence(runId: string): number {
    const current = this.sequenceCounters.get(runId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(runId, next);
    return next;
  }

  private addToBuffer(runId: string, sequence: number, data: string): void {
    let buffer = this.buffers.get(runId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(runId, buffer);
    }

    buffer.push({ sequence, data });

    // Cap buffer at BUFFER_SIZE
    if (buffer.length > BUFFER_SIZE) {
      buffer.splice(0, buffer.length - BUFFER_SIZE);
    }
  }
}
