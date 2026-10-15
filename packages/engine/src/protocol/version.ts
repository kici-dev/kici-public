/**
 * Protocol version, sent during the WebSocket handshake.
 *
 * Increment when a message schema gains something an older peer cannot parse.
 * The minimum equals the current version, so every bump is breaking: every
 * tier upgrades in the same window.
 *
 * Version 4 requires the fields every sender already set and drops the
 * always-advertised capability flags; a version-3 peer may omit those fields,
 * so it is refused at connect.
 */
export const PROTOCOL_VERSION = 4;

/** Minimum protocol version accepted. Connections below this are rejected. */
export const MIN_PROTOCOL_VERSION = PROTOCOL_VERSION;
