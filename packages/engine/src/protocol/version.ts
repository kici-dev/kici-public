/**
 * Protocol version. Sent during WebSocket handshake.
 *
 * Increment when a message schema gains something an older peer cannot parse,
 * and pair the bump with a named floor (below) so a sender can gate on the
 * version a peer negotiated instead of guessing.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Minimum protocol version accepted.
 * Connections below this are rejected.
 * Capabilities handle per-feature negotiation above this baseline.
 */
export const MIN_PROTOCOL_VERSION = 1;

/**
 * First protocol version whose `trust_policy.update` reader accepts
 * `forkPolicy: 'ignore'`.
 *
 * A peer below this version may validate the pushed policy against a
 * `forkPolicy` enum with no `ignore` member. `trust_policy.update` is a member
 * of a discriminated union, so that value fails the WHOLE frame rather than one
 * field: the org's identity links, member CI trust levels and team memberships
 * are dropped with it. The Platform therefore rewrites `ignore` to the
 * deprecated `reject` before sending to such a peer — the value that peer's
 * enum does carry, that denies dispatch the same way, and that this build's own
 * fork switch already resolves through the same arm as `ignore`.
 */
export const FORK_POLICY_IGNORE_MIN_PROTOCOL_VERSION = 2;
