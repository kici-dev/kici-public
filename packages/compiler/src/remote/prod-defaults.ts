/**
 * Production defaults for the `kici login` OAuth flow. When the matching
 * env var (or the `--platform-endpoint` flag) is unset, login resolves
 * these so a developer targeting the hosted KiCI Platform authenticates
 * with no setup. Setting the env var overrides the default — staging E2E
 * and self-hosted Platforms depend on that override path.
 *
 * Resolution is login-local: these are read into locals in `oauthLogin`,
 * never written back into `process.env`, so the orchestrator's separate
 * `wss://…/ws` meaning of `KICI_PLATFORM_URL` is unaffected.
 */

/** Platform API base URL — login POSTs to `${value}/api/v1/cli/exchange-token`. */
export const PROD_PLATFORM_URL = 'https://api.kici.dev';

/** OIDC issuer for the hosted Platform's Keycloak realm. */
export const PROD_OIDC_ISSUER = 'https://auth.kici.dev/realms/kici-internal';

/** Public OIDC client id registered for the `kici` CLI. */
export const PROD_OIDC_CLIENT_ID = 'kici-cli';

/**
 * Provenance trust root for `kici verify-attestation` when `--trust-root` is
 * omitted: the hosted KiCI Platform's provenance issuer. The verifier appends
 * `/.well-known/openid-configuration` and pins the token issuer to it. Pass
 * `--trust-root` to verify against a different environment (e.g. staging) or an
 * offline `{ issuer, jwks }` file.
 */
export const PROD_PROVENANCE_ISSUER = 'https://api.kici.dev';
