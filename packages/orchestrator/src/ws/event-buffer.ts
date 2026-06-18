import type { OrchestratorToPlatformMessage } from '@kici-dev/engine';
import { RingBuffer } from '@kici-dev/shared';

/**
 * In-memory buffer for orchestrator-to-Platform messages during disconnection.
 *
 * Wraps the generic RingBuffer from @kici-dev/shared with the orchestrator's
 * message type. Default maxSize is 10,000 (inherited from RingBuffer). When
 * the orchestrator loses its WebSocket connection to Platform, outgoing messages
 * are buffered here and flushed in order on reconnection.
 */
export class EventBuffer extends RingBuffer<OrchestratorToPlatformMessage> {
  constructor(options?: { maxSize?: number }) {
    super(options);
  }
}
