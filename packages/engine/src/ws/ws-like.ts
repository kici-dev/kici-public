/**
 * Minimal WebSocket interface for testability.
 *
 * Avoids importing framework-specific types so registries and handlers
 * can be unit-tested with plain mock objects.
 */
export interface WsLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  /**
   * Bytes queued in the socket's send buffer, when the transport exposes it.
   * The `ws` library socket does; used by the browser fan-out to terminate a
   * slow consumer past a watermark instead of buffering unboundedly in heap.
   * Optional so mock sockets and non-`ws` transports need not provide it.
   */
  bufferedAmount?: number;
  /**
   * Force-close the underlying socket immediately, when the transport exposes
   * it (the `ws` library socket does). Optional for the same reason as
   * `bufferedAmount`.
   */
  terminate?(): void;
}
