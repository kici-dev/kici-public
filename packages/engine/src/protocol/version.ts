/**
 * Protocol version, sent during the WebSocket handshake. Increment when a
 * message schema gains something an older peer cannot parse; every tier keeps
 * parsing the previous release's version for one release (the N-1 window).
 *
 * Version 4 requires the fields every sender already set and drops the
 * always-advertised capability flags; a version-3 peer may omit those fields,
 * so it is refused at connect.
 */
export const PROTOCOL_VERSION = 4;

/**
 * Minimum protocol version accepted: a literal equal to the previous release's
 * {@link PROTOCOL_VERSION}. The release process refuses a minimum above it.
 */
export const MIN_PROTOCOL_VERSION = 4;
