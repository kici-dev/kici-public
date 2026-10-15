/**
 * Minimal WebSocket interface, free of framework types, so registries and
 * handlers can be unit-tested with plain mock objects.
 */
export interface WsLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  /**
   * Bytes queued in the send buffer, when the transport exposes it (`ws`
   * does). The browser fan-out terminates a slow consumer past a watermark
   * instead of buffering unboundedly in heap. Optional for mocks and non-`ws`
   * transports.
   */
  bufferedAmount?: number;
  /**
   * Force-close the socket immediately, when the transport exposes it (`ws`
   * does). Optional, like `bufferedAmount`.
   */
  terminate?(): void;
}
