import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import open from 'open';
import pc from 'picocolors';
import { toErrorMessage } from '@kici-dev/core';
import { discoverOidcEndpoints } from './oidc-discovery.js';

/**
 * Wrap a fetch call so that transport errors (DNS failure, connection refused,
 * TLS handshake failure) surface with the URL that failed and a hint about
 * which env var the user should check, instead of Node's bare "fetch failed".
 */
async function fetchOrThrow(
  url: string,
  init: RequestInit,
  kind: 'Platform' | 'IdP',
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const envHint = kind === 'Platform' ? 'KICI_PLATFORM_URL' : 'KICI_OIDC_ISSUER';
    throw new Error(
      `Could not reach ${kind} at ${url} (${toErrorMessage(err)}). Check ${envHint}.`,
    );
  }
}

/** Options for the PKCE authorization code flow. */
interface PkceFlowOptions {
  /** OIDC issuer URL (e.g., https://auth.your-domain.example.com) */
  issuer: string;
  /** OAuth client ID for the CLI application */
  clientId: string;
}

/** Options for the RFC 8628 device authorization flow. */
interface DeviceFlowOptions {
  /** OIDC issuer URL */
  issuer: string;
  /** OAuth client ID for the CLI application */
  clientId: string;
}

/** Options for exchanging an OIDC token for a PAT. */
interface ExchangeTokenOptions {
  /** Platform API base URL */
  platformUrl: string;
  /** OIDC access token */
  accessToken: string;
  /** Machine hostname for PAT naming */
  machineName: string;
}

/** Response from the PAT exchange endpoint. */
interface ExchangeTokenResult {
  /** PAT identifier */
  id: string;
  /** Raw PAT value (kici_pat_...) */
  token: string;
  /** ISO 8601 expiry timestamp */
  expiresAt: string;
}

/**
 * Generate a PKCE code verifier and challenge.
 *
 * Verifier: 32 random bytes, base64url encoded.
 * Challenge: SHA-256 of verifier, base64url encoded.
 */
function generatePkceChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** HTML page served after successful PKCE callback. */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KiCI - Login successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0f1117;
      color: #e1e1e6;
    }
    .card {
      text-align: center;
      padding: 3rem 2rem;
      background: #1a1b23;
      border-radius: 12px;
      border: 1px solid #2d2e3a;
      max-width: 420px;
    }
    .logo { font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; }
    .logo span { color: #4c6ef5; }
    .check { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    p { color: #8b8c99; margin: 0.5rem 0; }
    .hint { font-size: 0.875rem; color: #6b6c7a; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Ki<span>CI</span></div>
    <div class="check">&#10003;</div>
    <h1>Login success!</h1>
    <p>You can close this tab and return to your terminal.</p>
    <p class="hint">Your CLI session has been authenticated.</p>
  </div>
</body>
</html>`;

/**
 * PKCE authorization code flow with localhost callback.
 *
 * Spins up a temporary HTTP server on a random port, opens the browser
 * to the IdP's authorization endpoint, captures the callback with the
 * authorization code, and exchanges it for tokens. The authorization
 * and token endpoints come from the IdP's OIDC discovery document
 * (`/.well-known/openid-configuration`) so the same flow works against
 * any spec-compliant IdP regardless of its URL conventions.
 *
 * @returns OIDC access token
 */
export async function pkceFlow(opts: PkceFlowOptions): Promise<string> {
  const { issuer, clientId } = opts;

  // Validate KICI_CALLBACK_PORT before the discovery round-trip — a bad
  // env var should fail fast with a clear message, not get masked by a
  // transport error from an unrelated IdP fetch.
  let listenPort = 0;
  const callbackPortEnv = process.env.KICI_CALLBACK_PORT;
  if (callbackPortEnv) {
    const parsed = parseInt(callbackPortEnv, 10);
    if (isNaN(parsed) || parsed < 0) {
      throw new Error(
        `KICI_CALLBACK_PORT must be a valid non-negative integer, got: "${callbackPortEnv}"`,
      );
    }
    listenPort = parsed;
  }

  const endpoints = await discoverOidcEndpoints(issuer);
  const { verifier, challenge } = generatePkceChallenge();
  const state = randomBytes(16).toString('hex');

  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://127.0.0.1`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const description = url.searchParams.get('error_description') || error;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Authentication error: ${description}`);
        cleanup();
        reject(new Error(`Authentication error: ${description}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch - possible CSRF attack');
        cleanup();
        reject(new Error('State mismatch - possible CSRF attack'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing authorization code');
        cleanup();
        reject(new Error('Missing authorization code in callback'));
        return;
      }

      // Serve success page immediately
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);

      const port = (server.address() as AddressInfo).port;

      try {
        // Exchange authorization code for tokens
        const tokenRes = await fetchOrThrow(
          endpoints.token_endpoint,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              redirect_uri: `http://127.0.0.1:${port}/callback`,
              code_verifier: verifier,
            }),
          },
          'IdP',
        );

        if (!tokenRes.ok) {
          const errorBody = await tokenRes.text();
          cleanup();
          reject(new Error(`Token exchange failed: ${errorBody}`));
          return;
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };
        cleanup();
        resolve(tokenData.access_token);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (server.listening) server.close();
    }

    server.listen(listenPort, '127.0.0.1', () => {
      const actualPort = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

      const authUrl = new URL(endpoints.authorization_endpoint);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      const scopes = ['openid', 'profile', 'email', 'offline_access'];
      authUrl.searchParams.set('scope', scopes.join(' '));
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      const browserCmd = process.env.KICI_BROWSER_CMD;
      if (browserCmd === 'none') {
        // Machine-parseable output for E2E test capture (no picocolors)
        console.log(`KICI_AUTH_URL=${authUrl.toString()}`);
        console.log(pc.cyan(`  Waiting for browser callback on port ${actualPort}...`));
      } else if (browserCmd) {
        // Custom browser command with {url} template
        const cmd = browserCmd.replace('{url}', authUrl.toString());
        exec(cmd, (err) => {
          if (err) {
            console.log(
              pc.yellow(
                `  Custom browser command failed: ${err.message}\n  Please visit:\n  ${authUrl.toString()}`,
              ),
            );
          }
        });
      } else {
        // Default: use open package
        console.log(pc.cyan('  Opening browser for authentication...'));
        open(authUrl.toString()).catch(() => {
          console.log(
            pc.yellow(
              `  Could not open browser automatically. Please visit:\n  ${authUrl.toString()}`,
            ),
          );
        });
      }
    });

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error('Authentication timed out after 5 minutes. Please try again with `kici login`.'),
      );
    }, TIMEOUT_MS);
  });
}

/** Sleep helper for device flow polling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RFC 8628 device authorization flow.
 *
 * Requests a device code from the IdP, displays the user code and
 * verification URI, then polls the token endpoint until the user
 * authorizes the device or the code expires. Endpoints come from the
 * OIDC discovery document so the same flow works against any
 * spec-compliant IdP.
 *
 * @returns OIDC access token
 */
export async function deviceFlow(opts: DeviceFlowOptions): Promise<string> {
  const { issuer, clientId } = opts;
  const endpoints = await discoverOidcEndpoints(issuer);

  const scopes = ['openid', 'profile', 'email', 'offline_access'];

  // Generate PKCE parameters. Keycloak's device authorization flow enforces
  // PKCE when the client has `pkce.code.challenge.method` set (which is the
  // KiCI staging shape — every public client requires S256). RFC 8628 itself
  // does not require PKCE on device flow, but sending the params is forward-
  // compatible with PKCE-enforced IdPs and harmless against IdPs that don't
  // enforce it. The verifier is sent back on the token-poll step below.
  const { verifier, challenge } = generatePkceChallenge();

  // Request device authorization
  const deviceAuthRes = await fetchOrThrow(
    endpoints.device_authorization_endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    },
    'IdP',
  );

  if (!deviceAuthRes.ok) {
    const errorBody = await deviceAuthRes.text();
    throw new Error(`Device authorization request failed: ${errorBody}`);
  }

  const deviceAuth = (await deviceAuthRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval: number;
    expires_in: number;
  };

  // Display instructions to user. When the IdP returns verification_uri_complete
  // the code is embedded in the URL, so the user usually skips code entry and
  // goes straight to login + approval. Keep the `Enter code:` substring in both
  // branches so output-parsing scrapers (E2E tests, support tooling) keep working.
  console.log();
  console.log(pc.bold('  Device authorization'));
  if (deviceAuth.verification_uri_complete) {
    console.log(`  Open ${pc.cyan(deviceAuth.verification_uri_complete)}`);
    console.log(pc.gray('  The code is pre-filled; approve on the IdP screen.'));
    console.log(pc.gray(`  Enter code: ${pc.bold(pc.yellow(deviceAuth.user_code))} (if prompted)`));
  } else {
    console.log(`  Open ${pc.cyan(deviceAuth.verification_uri)}`);
    console.log(`  Enter code: ${pc.bold(pc.yellow(deviceAuth.user_code))}`);
  }
  console.log(pc.gray(`  Code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes`));
  console.log();

  // Poll token endpoint (use server-specified interval; default to 5s if not provided)
  let intervalMs = (deviceAuth.interval ?? 5) * 1000;

  while (true) {
    await sleep(intervalMs);

    const tokenRes = await fetchOrThrow(
      endpoints.token_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceAuth.device_code,
          // PKCE verifier — paired with the code_challenge sent on the
          // device authorization request above. Keycloak enforces this on
          // PKCE-required public clients; spec-strict device-flow IdPs
          // ignore it.
          code_verifier: verifier,
        }),
      },
      'IdP',
    );

    if (tokenRes.ok) {
      const tokenData = (await tokenRes.json()) as { access_token: string };
      return tokenData.access_token;
    }

    const errorData = (await tokenRes.json()) as {
      error: string;
      error_description?: string;
    };

    switch (errorData.error) {
      case 'authorization_pending':
        // User hasn't authorized yet, keep polling
        continue;

      case 'slow_down':
        // Increase polling interval by 5 seconds per RFC 8628
        intervalMs += 5000;
        continue;

      case 'expired_token':
        throw new Error(
          'Device code expired. Please run `kici login` again to restart authentication.',
        );

      case 'access_denied':
        throw new Error(errorData.error_description || 'Access denied by user');

      default:
        throw new Error(errorData.error_description || `Device flow error: ${errorData.error}`);
    }
  }
}

/**
 * Exchange an OIDC access token for a personal access token (PAT).
 *
 * POSTs to the Platform /api/v1/cli/exchange-token endpoint with the
 * OIDC token as Bearer auth. Returns the generated PAT details.
 */
export async function exchangeTokenForPat(
  opts: ExchangeTokenOptions,
): Promise<ExchangeTokenResult> {
  const { platformUrl, accessToken, machineName } = opts;

  const res = await fetchOrThrow(
    `${platformUrl}/api/v1/cli/exchange-token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ machineName }),
    },
    'Platform',
  );

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errorBody}`);
  }

  return (await res.json()) as ExchangeTokenResult;
}
