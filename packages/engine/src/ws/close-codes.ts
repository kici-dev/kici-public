/**
 * Unified WebSocket close codes for KiCI connections.
 * Single source of truth — replaces duplicate definitions in other KiCI packages.
 *
 * Standard codes (1000-1015) are defined by RFC 6455.
 * Custom codes (4000-4999) are reserved for application use.
 */

/** The endpoint is going away (e.g., server shutdown or browser navigating away). */
export const WS_CLOSE_GOING_AWAY = 1001;

/** The connection was closed because the client failed authentication. */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** The connection was closed because the auth timeout expired. */
export const WS_CLOSE_AUTH_TIMEOUT = 4002;

/** The connection was closed due to an invalid or unparseable message. */
export const WS_CLOSE_INVALID_MESSAGE = 4003;

/** The connection was closed because the heartbeat timed out. */
export const WS_CLOSE_HEARTBEAT_TIMEOUT = 4004;

/** The connection was closed due to a protocol-level error. */
export const WS_CLOSE_PROTOCOL_ERROR = 4005;

/** The connection was closed due to an unexpected internal server error. */
export const WS_CLOSE_INTERNAL_ERROR = 4006;

/** The connection was closed because the agent token authentication failed. */
export const WS_CLOSE_AGENT_AUTH_FAILED = 4010;

/** The connection was closed because the organization has reached its plan limit. */
export const WS_CLOSE_PLAN_LIMIT = 4020;

/**
 * The orchestrator's reported `cluster_name` collides with another
 * already-connected orchestrator in the same org. Operator must rename
 * via `kici-admin cluster-name set <name>` before reconnecting.
 */
export const WS_CLOSE_CLUSTER_NAME_CONFLICT = 4011;

/** The connection was closed because the requested run was not found. */
export const WS_CLOSE_RUN_NOT_FOUND = 4030;

/**
 * The connection was closed because a job dispatch went unacknowledged past
 * its deadline. The orchestrator treats the dispatch as lost, requeues the
 * job, and disconnects the unresponsive agent (scaler-managed agents are then
 * destroyed by their normal lifecycle; static agents reconnect and re-sync).
 */
export const WS_CLOSE_DISPATCH_ACK_TIMEOUT = 4031;
