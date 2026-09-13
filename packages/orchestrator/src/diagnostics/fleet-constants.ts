/**
 * Shared constants for fleet log collection.
 */

/** Default per-node deadline for a fleet bundle request (overridable via --fleet-timeout). */
export const FLEET_NODE_TIMEOUT_MS = 60_000;

/** Per-node cap on raw log bytes an agent includes in its mini-bundle (50 MiB). */
export const FLEET_MAX_LOG_BYTES = 50 * 1024 * 1024;
