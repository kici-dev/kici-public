import type { AgentToOrchestratorMessage } from '@kici-dev/engine';
import { RingBuffer } from '@kici-dev/shared';

/**
 * Holds outgoing agent-to-orchestrator messages while the WebSocket is down;
 * they flush in order on reconnection. Default maxSize: 5,000 messages.
 */
export class EventBuffer extends RingBuffer<AgentToOrchestratorMessage> {
  constructor(options?: { maxSize?: number }) {
    super({ maxSize: options?.maxSize ?? 5_000 });
  }
}
