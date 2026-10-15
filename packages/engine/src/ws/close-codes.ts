/**
 * WebSocket close codes for KiCI connections — the single source of truth.
 * RFC 6455 defines 1000-1015 and reserves 4000-4999 for application use.
 */

/** The endpoint is going away (e.g., server shutdown or browser navigating away). */
export const WS_CLOSE_GOING_AWAY = 1001;

/** The client failed authentication. */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** The auth timeout expired. */
export const WS_CLOSE_AUTH_TIMEOUT = 4002;

/** An invalid or unparseable message. */
export const WS_CLOSE_INVALID_MESSAGE = 4003;

/** The heartbeat timed out. */
export const WS_CLOSE_HEARTBEAT_TIMEOUT = 4004;

/** A protocol-level error. */
export const WS_CLOSE_PROTOCOL_ERROR = 4005;

/** An unexpected internal server error. */
export const WS_CLOSE_INTERNAL_ERROR = 4006;

/** Agent token authentication failed. */
export const WS_CLOSE_AGENT_AUTH_FAILED = 4010;

/** The organization has reached its plan limit. */
export const WS_CLOSE_PLAN_LIMIT = 4020;

/**
 * The orchestrator's `cluster_name` collides with a connected orchestrator in
 * the same org; rename with `kici-admin cluster-name set <name>` before reconnecting.
 */
export const WS_CLOSE_CLUSTER_NAME_CONFLICT = 4011;

/**
 * Load rebalancing across Platform instances: a newly joined instance asks
 * peers holding excess connections to shed some. Not an error — the affected
 * orchestrators reconnect immediately and redistribute evenly.
 */
export const WS_CLOSE_REBALANCE = 4030;

/**
 * A job dispatch went unacknowledged past its deadline: the orchestrator
 * requeues the job as lost and disconnects the agent (a scaler-managed agent
 * is then destroyed by its normal lifecycle; a static agent reconnects and re-syncs).
 */
export const WS_CLOSE_DISPATCH_ACK_TIMEOUT = 4031;

/**
 * The same agent registered on a newer socket, so this one is a ghost. It is
 * closed at registration time, not left to the OS or the WS ping, because a
 * half-open socket closing later carries the same agent id and would tear down
 * the live registration. The agent does not reconnect.
 */
export const WS_CLOSE_SUPERSEDED_BY_RECONNECT = 4032;
