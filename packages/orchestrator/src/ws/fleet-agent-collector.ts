/**
 * Orchestrator-side correlation for fleet.logs.request -> chunked response.
 *
 * No orchestrator->agent request/response primitive existed before fleet
 * collection; this is it. One instance per orchestrator, keyed by requestId.
 * Pending requests reject on timeout, on a fleet.bundle.error, or when the
 * owning agent disconnects. A thin wrapper over the shared ChunkRequestWaiter
 * so the agent channel and the peer channel share one correlation core; the
 * requestId->agentId map lets a single agent's disconnect reject only that
 * agent's in-flight requests rather than every concurrent collection.
 */
import { ChunkRequestWaiter } from '@kici-dev/shared';

export interface FleetAgentCollectorOptions {
  timeoutMs: number;
}

export class FleetAgentCollector {
  private readonly waiter = new ChunkRequestWaiter();
  /** requestId -> owning agentId, so a disconnect rejects only that agent's requests. */
  private readonly requestAgent = new Map<string, string>();

  constructor(private readonly opts: FleetAgentCollectorOptions) {}

  /**
   * Register the pending request `requestId` (owned by `agentId`), invoke
   * `send` to dispatch the fleet.logs.request envelope, and await the
   * reassembled bundle Buffer.
   */
  request(requestId: string, agentId: string, send: () => void): Promise<Buffer> {
    this.requestAgent.set(requestId, agentId);
    const promise = this.waiter.add(requestId, this.opts.timeoutMs).finally(() => {
      this.requestAgent.delete(requestId);
    });
    send();
    return promise;
  }

  onChunk(requestId: string, seq: number, dataB64: string, isLast: boolean): void {
    this.waiter.onChunk(requestId, seq, dataB64, isLast);
  }

  onError(requestId: string, message: string): void {
    this.waiter.onError(requestId, message);
  }

  /** Reject every pending request owned by `agentId` (called on its disconnect). */
  rejectAgent(agentId: string, reason: string): void {
    for (const [requestId, owner] of this.requestAgent) {
      if (owner === agentId) this.waiter.onError(requestId, reason);
    }
  }

  /** Reject every pending request regardless of owner (orchestrator shutdown). */
  rejectAll(reason: string): void {
    this.waiter.rejectAll(reason);
  }
}
