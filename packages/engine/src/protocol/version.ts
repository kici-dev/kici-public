/**
 * Protocol version. Sent during WebSocket handshake.
 *
 * Increment when a message schema gains something an older peer cannot parse,
 * and pair the bump with a named floor so a sender can gate on the version a
 * peer negotiated instead of guessing.
 *
 * Version 3 records that a version-2 peer (every 0.8.x build) cannot parse the
 * 0.9.0 `trust_policy.update` policy, the peer heartbeat, or the
 * `artifacts.upload.complete` frame: the fields it requires were removed and
 * the schemas are strict, so a version-2 peer that was let through the
 * handshake would drop or refuse those frames silently.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Minimum protocol version accepted.
 * Connections below this are rejected.
 * Capabilities handle per-feature negotiation above this baseline.
 */
export const MIN_PROTOCOL_VERSION = PROTOCOL_VERSION;
