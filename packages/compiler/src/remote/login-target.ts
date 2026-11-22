import { z } from 'zod';
import { toErrorMessage } from '@kici-dev/core';
import { CLI_LOGIN_CONFIG_PATH, CliLoginConfig, CliLoginConfigError } from '@kici-dev/engine';
import { PROD_OIDC_CLIENT_ID, PROD_OIDC_ISSUER, PROD_PLATFORM_URL } from './prod-defaults.js';
import {
  ClientNewerThanPlatformError,
  platformFetch,
  type PlatformFetch,
} from './platform-fetch.js';

/** Where `kici login` got its identity provider: hosted values, an explicit issuer, or the named Platform. */
export const LoginTargetSource = z.enum([
  'hosted_default',
  'explicit_issuer',
  'platform_published',
]);
export type LoginTargetSource = z.infer<typeof LoginTargetSource>;

/** The Platform `kici login` exchanges a token with, and the IdP it gets the token from. */
export interface LoginTarget {
  platformUrl: string;
  issuer: string;
  clientId: string;
  source: LoginTargetSource;
  /** Scopes the named Platform publishes, requested after the user's own; empty on other paths. */
  extraScopes: readonly string[];
}

/** How long `kici login` waits for a Platform to publish its login settings. */
const LOGIN_CONFIG_TIMEOUT_MS = 15_000;

const ISSUER_HINT =
  'Pass --oidc-issuer (or set KICI_OIDC_ISSUER) to name the identity provider yourself.';

/** The first non-empty value: an empty flag or variable counts as unset. */
function firstSet(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => v !== undefined && v !== '');
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** True when `url` names `expected`, ignoring host case and trailing slashes. */
function isSameUrl(url: string, expected: string): boolean {
  try {
    return stripTrailingSlashes(new URL(url).href) === expected;
  } catch {
    return false;
  }
}

/** True when `url` is the hosted Platform's host on its default port, over http or https. */
function isHostedPlatform(url: string): boolean {
  try {
    const u = new URL(url);
    // fails-when: http://api.kici.dev goes to discovery and is refused as the hosted issuer
    // breaks-if-wrong: api.kici.dev.evil.example or evil-api.kici.dev skips discovery
    return (
      /^https?:$/.test(u.protocol) &&
      u.host === new URL(PROD_PLATFORM_URL).host &&
      `${u.username}${u.password}${u.search}${u.hash}` === '' &&
      stripTrailingSlashes(u.pathname) === ''
    );
  } catch {
    return false;
  }
}

/**
 * Refuse a WebSocket URL (the orchestrator's `KICI_PLATFORM_URL` form) before
 * any request: `kici login` talks to the Platform's HTTP API.
 */
function assertNotWebSocket(endpoint: string, from: string): void {
  if (/^wss?:\/\//i.test(endpoint)) {
    throw new Error(
      `${from} is a WebSocket URL (${endpoint}). kici login needs the Platform's ` +
        `http:// or https:// API URL: pass it with --platform-endpoint or KICI_PLATFORM_URL.`,
    );
  }
}

function invalidLoginConfig(base: string, url: string, reason: string): Error {
  return new Error(
    `The Platform at ${base} returned an invalid login configuration from ${url} ` +
      `(${reason}). ${ISSUER_HINT}`,
  );
}

/**
 * Read the login settings a Platform publishes at
 * `<platformUrl>/api/v1/cli/login-config`. Throws an actionable error, never a
 * fallback value, when the Platform cannot be reached, publishes no login
 * settings, or answers with a body that is not a valid login configuration.
 */
export async function fetchCliLoginConfig(
  platformUrl: string,
  fetchImpl: PlatformFetch = platformFetch,
): Promise<CliLoginConfig> {
  const base = stripTrailingSlashes(platformUrl);
  const url = `${base}${CLI_LOGIN_CONFIG_PATH}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LOGIN_CONFIG_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof ClientNewerThanPlatformError) throw err;
    throw new Error(`Could not reach Platform at ${base} (${toErrorMessage(err)}). ${ISSUER_HINT}`);
  }

  let body: unknown;
  let bodyIsJson = true;
  try {
    body = await res.json();
  } catch {
    bodyIsJson = false;
  }

  if (!res.ok) {
    const refusal = z.object({ error: CliLoginConfigError }).safeParse(body);
    if (res.status === 404 && refusal.success) {
      throw new Error(
        `The Platform at ${base} publishes no login settings ` +
          `(${refusal.data.error}). ${ISSUER_HINT}`,
      );
    }
    throw new Error(
      `The Platform at ${base} answered HTTP ${res.status} for its login settings ` +
        `(${url}). ${ISSUER_HINT}`,
    );
  }

  if (!bodyIsJson) {
    throw invalidLoginConfig(base, url, 'the body is not JSON');
  }
  const parsed = CliLoginConfig.safeParse(body);
  if (!parsed.success) {
    // One line: the error is printed beside the request URL and the hint.
    throw invalidLoginConfig(base, url, z.prettifyError(parsed.error).replace(/\s*\n\s*/g, '; '));
  }
  return parsed.data;
}

/**
 * Decide which Platform and identity provider `kici login` uses. An explicit
 * issuer, or no Platform other than the hosted one, makes no request. A
 * Platform other than the hosted one is asked for its login settings, and a
 * failure stops the login: it never falls back to the hosted identity provider.
 * `KICI_OIDC_CLIENT_ID` overrides the client id on every path.
 */
export async function resolveLoginTarget(input: {
  platformEndpoint?: string;
  oidcIssuer?: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: PlatformFetch;
}): Promise<LoginTarget> {
  const { env } = input;
  const flagEndpoint = firstSet(input.platformEndpoint);
  const endpoint = firstSet(flagEndpoint, env.KICI_PLATFORM_URL);
  const issuer = firstSet(input.oidcIssuer, env.KICI_OIDC_ISSUER);
  const clientIdOverride = firstSet(env.KICI_OIDC_CLIENT_ID);

  if (endpoint !== undefined) {
    assertNotWebSocket(
      endpoint,
      flagEndpoint !== undefined ? '--platform-endpoint' : 'KICI_PLATFORM_URL',
    );
  }

  if (issuer !== undefined) {
    return {
      platformUrl: endpoint ?? PROD_PLATFORM_URL,
      issuer,
      clientId: clientIdOverride ?? PROD_OIDC_CLIENT_ID,
      source: LoginTargetSource.enum.explicit_issuer,
      extraScopes: [],
    };
  }

  if (endpoint === undefined || isHostedPlatform(endpoint)) {
    return {
      platformUrl: PROD_PLATFORM_URL,
      issuer: PROD_OIDC_ISSUER,
      clientId: clientIdOverride ?? PROD_OIDC_CLIENT_ID,
      source: LoginTargetSource.enum.hosted_default,
      extraScopes: [],
    };
  }

  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error(
      `The Platform endpoint ${endpoint} is not an http:// or https:// URL. ` +
        'Pass the Platform API URL with --platform-endpoint or KICI_PLATFORM_URL.',
    );
  }

  const platformUrl = stripTrailingSlashes(endpoint);
  const published = await fetchCliLoginConfig(platformUrl, input.fetchImpl);
  // Only another Platform gets here (the hosted one returns above).
  // fails-when: it publishes the hosted issuer and the CLI signs in there for it
  // breaks-if-wrong: the hosted Platform or an explicit hosted issuer still logs in
  if (isSameUrl(published.issuer, PROD_OIDC_ISSUER)) {
    throw new Error(
      `The Platform at ${platformUrl} publishes the hosted KiCI identity provider ` +
        `(${published.issuer}) as its own. kici login signs in there only for the hosted ` +
        `Platform (${PROD_PLATFORM_URL}). ${ISSUER_HINT}`,
    );
  }
  return {
    platformUrl,
    issuer: published.issuer,
    clientId: clientIdOverride ?? published.clientId,
    source: LoginTargetSource.enum.platform_published,
    extraScopes: published.extraScopes ?? [],
  };
}
