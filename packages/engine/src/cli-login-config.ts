import { z } from 'zod';

/**
 * Where a Platform publishes the login settings the `kici` CLI needs: the
 * OIDC issuer to authenticate against and the OIDC client the CLI uses there.
 * The route needs no credential, because the CLI reads it before it has one.
 */
export const CLI_LOGIN_CONFIG_PATH = '/api/v1/cli/login-config';

/** One OAuth 2.0 scope token (RFC 6749 section 3.3): no space, double quote or backslash. */
// fails-when: a scope with a space, a quote or a backslash parses
export const OidcScopeToken = z
  .string()
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'must be one scope token');

/**
 * The body of `GET /api/v1/cli/login-config`. The issuer must be an `http:` or
 * `https:` URL: the CLI opens it in the browser and fetches its discovery
 * document, so any other scheme is refused. `extraScopes` are requested after the CLI's own.
 */
export const CliLoginConfig = z.object({
  issuer: z.url({ protocol: /^https?$/ }),
  clientId: z.string().min(1),
  extraScopes: z.array(OidcScopeToken).optional(),
});
export type CliLoginConfig = z.infer<typeof CliLoginConfig>;

/** The `error` of a 404 answer: the Platform has no login settings to publish. */
export const CliLoginConfigError = z.enum(['login_not_configured']);
export type CliLoginConfigError = z.infer<typeof CliLoginConfigError>;
