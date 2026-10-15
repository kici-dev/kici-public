/**
 * Orchestrator-side correlation for fleet.logs.request -> chunked response: the
 * orchestrator->agent request/response primitive. One instance per orchestrator, keyed
 * by requestId. Pending requests reject on timeout, on a fleet.bundle.error, or when the
 * owning agent disconnects. Wraps the shared ChunkRequestWaiter so the agent and peer
 * channels share one correlation core; the requestId->agentId map lets one agent's
 * disconnect reject only its in-flight requests, not every concurrent collection.
 */
import { ChunkRequestWaiter } from '@kici-dev/shared';

export interface FleetAgentCollectorOptions {
  timeoutMs: number;
}

export class FleetAgentCollector {
  private readonly waiter = new ChunkRequestWaiter();
  private readonly requestAgent = new Map<string, string>();

  constructor(private readonly opts: FleetAgentCollectorOptions) {}

  /** Registers `requestId` before `send` dispatches the envelope; resolves to the bundle. */
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

  /**
   * Whether this orchestrator still awaits `requestId` from `agentId`. The agent handler
   * checks it before rate limiting a `fleet.bundle.chunk`: a solicited transfer is exempt,
   * an unsolicited one is not.
   */
  isPendingFor(requestId: string, agentId: string): boolean {
    return this.requestAgent.get(requestId) === agentId;
  }

  onError(requestId: string, message: string): void {
    this.waiter.onError(requestId, message);
  }

  /** Called on the agent's disconnect. */
  rejectAgent(agentId: string, reason: string): void {
    for (const [requestId, owner] of this.requestAgent) {
      if (owner === agentId) this.waiter.onError(requestId, reason);
    }
  }

  /** Orchestrator shutdown: rejects regardless of owner. */
  rejectAll(reason: string): void {
    this.waiter.rejectAll(reason);
  }
}
