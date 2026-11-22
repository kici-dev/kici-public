/**
 * `kici login` defaults for the hosted Platform (`login-target.ts`).
 * `PROD_OIDC_ISSUER` applies only when no Platform is named or the hosted URL
 * is named. `PROD_PLATFORM_URL` and `PROD_OIDC_CLIENT_ID` also fill in for an
 * explicit `--oidc-issuer`. They stay in
 * `oauthLogin` locals, never `process.env`, so the orchestrator's `wss://…/ws`
 * `KICI_PLATFORM_URL` is unaffected.
 */

/** Platform API base URL — login POSTs to `${value}/api/v1/cli/exchange-token`. */
export const PROD_PLATFORM_URL = 'https://api.kici.dev';

export const PROD_OIDC_ISSUER = 'https://auth.kici.dev/realms/kici-internal';

export const PROD_OIDC_CLIENT_ID = 'kici-cli';
