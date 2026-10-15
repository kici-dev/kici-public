/**
 * Per-org dashboard session max age bounds, shared by the Platform enforcement
 * and write-validation sites and the dashboard settings UI. Browser-safe.
 */

/** 1 hour. */
export const SESSION_MAX_AGE_MIN_SECONDS = 3600;

/** 30 days; equals the realm cap. */
export const SESSION_MAX_AGE_MAX_SECONDS = 2592000;

/** 7 days, applied to every org. */
export const SESSION_MAX_AGE_DEFAULT_SECONDS = 604800;

/**
 * The per-org max-age check applies only to tokens whose `azp` equals this
 * Keycloak client id; CLI and service-account tokens are exempt.
 */
export const DASHBOARD_KEYCLOAK_CLIENT_ID = 'kici-dashboard';
