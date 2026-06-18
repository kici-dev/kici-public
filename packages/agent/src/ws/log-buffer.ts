import { RingBuffer } from '@kici-dev/shared';

/**
 * Ring buffer for agent log lines during WS disconnection.
 *
 * Wraps the generic RingBuffer from @kici-dev/shared with string type
 * and a default capacity of 10,000 lines. When the agent loses its
 * WebSocket connection, operational log lines are buffered here and
 * replayed on reconnection.
 */
export class LogBuffer extends RingBuffer<string> {
  constructor(options?: { maxLines?: number }) {
    super({ maxSize: options?.maxLines ?? 10_000 });
  }
}
