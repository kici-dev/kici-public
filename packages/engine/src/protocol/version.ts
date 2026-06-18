/**
 * Protocol version. Sent during WebSocket handshake.
 * Increment on breaking changes to message schemas.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Minimum protocol version accepted.
 * Connections below this are rejected.
 * Capabilities handle per-feature negotiation above this baseline.
 */
export const MIN_PROTOCOL_VERSION = 1;
