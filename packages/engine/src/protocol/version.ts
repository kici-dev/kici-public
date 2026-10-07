/**
 * Protocol version. Sent during WebSocket handshake.
 *
 * Increment when a message schema gains something an older peer cannot parse.
 * The minimum equals the current version, so every bump is a breaking change:
 * every tier upgrades in the same window.
 *
 * Version 4: fields every sender already set are required, and the capability
 * flags every build advertised are gone. A version-3 peer (every release
 * before it) may omit those fields, so it is refused at connect.
 */
export const PROTOCOL_VERSION = 4;

/** Minimum protocol version accepted. Connections below this are rejected. */
export const MIN_PROTOCOL_VERSION = PROTOCOL_VERSION;
