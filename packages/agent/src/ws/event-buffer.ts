import type { AgentToOrchestratorMessage } from '@kici-dev/engine';
import { RingBuffer } from '@kici-dev/shared';

/**
 * In-memory buffer for agent-to-orchestrator messages during disconnection.
 *
 * Wraps the generic RingBuffer from @kici-dev/shared with the agent's
 * message type and a default maxSize of 5,000. When the agent loses its
 * WebSocket connection to the orchestrator, outgoing messages are buffered
 * here and flushed in order on reconnection.
 */
export class EventBuffer extends RingBuffer<AgentToOrchestratorMessage> {
  constructor(options?: { maxSize?: number }) {
    super({ maxSize: options?.maxSize ?? 5_000 });
  }
}
