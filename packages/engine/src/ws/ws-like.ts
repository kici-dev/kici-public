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
}
