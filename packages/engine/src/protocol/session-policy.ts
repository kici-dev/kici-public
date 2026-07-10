/**
 * Per-org dashboard session max age policy constants.
 *
 * Browser-safe (imported by the dashboard): no Node built-ins. Shared so the
 * Platform enforcement/write-validation sites and the dashboard settings UI
 * never drift on the bounds or the dashboard client id.
 */

/** Minimum configurable session max age: 1 hour (floor). */
export const SESSION_MAX_AGE_MIN_SECONDS = 3600;

/** Maximum configurable session max age: 30 days (ceiling == realm cap). */
export const SESSION_MAX_AGE_MAX_SECONDS = 2592000;

/** Default session max age applied to every org: 7 days. */
export const SESSION_MAX_AGE_DEFAULT_SECONDS = 604800;

/**
 * Keycloak client id for the web dashboard. The per-org max-age check applies
 * only to tokens whose `azp` equals this value; CLI / service-account tokens
 * are exempt.
 */
export const DASHBOARD_KEYCLOAK_CLIENT_ID = 'kici-dashboard';
