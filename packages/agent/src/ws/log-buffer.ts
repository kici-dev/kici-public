import { RingBuffer } from '@kici-dev/shared';

/**
 * Buffers operational log lines while the agent's WS is disconnected, for
 * replay on reconnection. Default capacity: 10,000 lines.
 */
export class LogBuffer extends RingBuffer<string> {
  constructor(options?: { maxLines?: number }) {
    super({ maxSize: options?.maxLines ?? 10_000 });
  }
}
