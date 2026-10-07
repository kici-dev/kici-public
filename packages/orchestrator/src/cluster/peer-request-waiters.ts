/**
 * Correlates a peer request with its response by message id. Shared by every
 * request/response pair the outgoing `PeerClient` and the incoming peer handler
 * carry, so each pair needs only its response type and its close-time answer.
 */

/** A wait that ended without a response. */
export const PEER_REQUEST_TIMEOUT = 'timeout';

/** Pending peer requests of one message pair, keyed by message id. */
export class PeerRequestWaiters<TResponse extends { messageId: string }> {
  private readonly waiters = new Map<
    string,
    {
      resolve: (response: TResponse | typeof PEER_REQUEST_TIMEOUT) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * @param closedResponse the answer each pending wait gets when the connection
   *   closes, built from its message id and the close reason.
   */
  constructor(private readonly closedResponse: (messageId: string, reason: string) => TResponse) {}

  /** Wait for the response to `messageId`, or {@link PEER_REQUEST_TIMEOUT}. */
  wait(messageId: string, timeoutMs: number): Promise<TResponse | typeof PEER_REQUEST_TIMEOUT> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(messageId);
        resolve(PEER_REQUEST_TIMEOUT);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(messageId, { resolve, timer });
    });
  }

  /** Hand a response to the request waiting for it. An unknown id is dropped. */
  resolve(response: TResponse): void {
    const waiter = this.waiters.get(response.messageId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(response.messageId);
    waiter.resolve(response);
  }

  /** End every pending wait with the close-time answer naming `reason`. */
  rejectAll(reason: string): void {
    for (const [messageId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.closedResponse(messageId, reason));
    }
    this.waiters.clear();
  }
}
