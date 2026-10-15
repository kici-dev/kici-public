/**
 * `kici login` defaults for the hosted Platform, used when the matching env var
 * (or `--platform-endpoint`) is unset. They stay in `oauthLogin` locals, never
 * `process.env`, so the orchestrator's `wss://…/ws` `KICI_PLATFORM_URL` is unaffected.
 */

/** Platform API base URL — login POSTs to `${value}/api/v1/cli/exchange-token`. */
export const PROD_PLATFORM_URL = 'https://api.kici.dev';

export const PROD_OIDC_ISSUER = 'https://auth.kici.dev/realms/kici-internal';

export const PROD_OIDC_CLIENT_ID = 'kici-cli';
