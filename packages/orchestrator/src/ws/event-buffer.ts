import type { OrchestratorToPlatformMessage } from '@kici-dev/engine';
import { RingBuffer } from '@kici-dev/shared';

/**
 * In-memory buffer for orchestrator-to-Platform messages while the Platform
 * WebSocket is down; flushed in order on reconnection. Default maxSize is
 * 10,000 (inherited from RingBuffer).
 */
export class EventBuffer extends RingBuffer<OrchestratorToPlatformMessage> {
  constructor(options?: { maxSize?: number }) {
    super(options);
  }
}
