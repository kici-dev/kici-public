/**
 * Per-run registry of WebSocket observers (several CLI clients may observe one
 * run). Messages carry a monotonic per-run sequence and are buffered for
 * reconnection backfill; closed connections are dropped on broadcast, and a
 * completed run's buffer is reclaimed after a TTL.
 */

import { createLogger } from '@kici-dev/shared';
import type { WsLike } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'observer-registry' });

/** Messages buffered per run for reconnection backfill. */
const BUFFER_SIZE = 1000;

/** How long a buffer outlives run completion. */
const COMPLETION_BUFFER_TTL_MS = 5 * 60 * 1000;

export type ObserverWsLike = WsLike;

interface ObserverConnection {
  ws: ObserverWsLike;
  runId: string;
  lastSeenSequence: number;
  subscribedAt: number;
}

interface BufferedMessage {
  sequence: number;
  data: string;
}

export class ObserverRegistry {
  private readonly observers = new Map<string, Set<ObserverConnection>>();

  private readonly buffers = new Map<string, BufferedMessage[]>();

  private readonly sequenceCounters = new Map<string, number>();

  /** Pending buffer cleanups, cancelled when a new observer subscribes. */
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Replays buffered messages with sequence > `lastSeenSequence` when it is given. */
  subscribe(runId: string, ws: ObserverWsLike, lastSeenSequence?: number): void {
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
            // The next broadcast drops the failed connection.
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

  /** The buffer outlives an empty observer set, for reconnection. */
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
   * Serialize once, stamp a monotonic sequence, buffer, and send to every
   * observer; closed or erroring connections are removed.
   */
  broadcast(runId: string, message: object): void {
    const seq = this.nextSequence(runId);

    const messageWithSeq = { ...message, sequence: seq };
    const data = JSON.stringify(messageWithSeq);

    this.addToBuffer(runId, seq, data);

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

    for (const conn of toRemove) {
      observerSet.delete(conn);
      logger.debug('Removed closed observer connection', { runId });
    }

    if (observerSet.size === 0) {
      this.observers.delete(runId);
    }
  }

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

  broadcastStatus(runId: string, status: string, jobName?: string): void {
    this.broadcast(runId, {
      type: 'observe.status',
      runId,
      status,
      ...(jobName && { jobName }),
      timestamp: Date.now(),
    });
  }

  /** Schedules buffer cleanup after COMPLETION_BUFFER_TTL_MS, a brief reconnection window. */
  broadcastComplete(runId: string, status: string, summary: object): void {
    this.broadcast(runId, {
      type: 'observe.complete',
      runId,
      status,
      summary,
      timestamp: Date.now(),
    });

    const timer = setTimeout(() => {
      this.buffers.delete(runId);
      this.sequenceCounters.delete(runId);
      this.cleanupTimers.delete(runId);
      logger.debug('Buffer cleaned up after completion TTL', { runId });
    }, COMPLETION_BUFFER_TTL_MS);

    this.cleanupTimers.set(runId, timer);
  }

  getObserverCount(runId: string): number {
    return this.observers.get(runId)?.size ?? 0;
  }

  hasObservers(runId: string): boolean {
    const set = this.observers.get(runId);
    return set !== undefined && set.size > 0;
  }

  /**
   * Drop every run's buffer, sequence counter, pending cleanup timer and
   * observer set, active runs included. Call on shutdown.
   */
  cleanup(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.buffers.clear();
    this.sequenceCounters.clear();
    this.observers.clear();
  }

  /** For tests. */
  getCurrentSequence(runId: string): number {
    return this.sequenceCounters.get(runId) ?? 0;
  }

  /** For tests. */
  getBufferSize(runId: string): number {
    return this.buffers.get(runId)?.length ?? 0;
  }

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

    if (buffer.length > BUFFER_SIZE) {
      buffer.splice(0, buffer.length - BUFFER_SIZE);
    }
  }
}
