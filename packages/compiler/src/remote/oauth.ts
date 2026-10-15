import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import open from 'open';
import pc from 'picocolors';
import { toErrorMessage } from '@kici-dev/core';
import { discoverOidcEndpoints } from './oidc-discovery.js';
import { sleep } from '@kici-dev/engine';

/**
 * Surface transport errors (DNS, connection refused, TLS) with the failing URL
 * and the env var to check, instead of Node's bare "fetch failed".
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

interface PkceFlowOptions {
  issuer: string;
  clientId: string;
  /** Delay before the "still waiting" nudge. A testing seam: no flag or env var sets it. */
  nudgeAfterMs?: number;
  /**
   * Browser-callback timeout. A testing seam: no flag or env var sets it. The
   * timeout message states five minutes literally, which is acceptable only
   * because no user can change this; promoting it to a real option means
   * deriving the message's duration from it.
   */
  timeoutMs?: number;
}

/** RFC 8628 device authorization flow options. */
interface DeviceFlowOptions {
  issuer: string;
  clientId: string;
}

interface ExchangeTokenOptions {
  platformUrl: string;
  /** OIDC access token. */
  accessToken: string;
  /** Machine hostname, used to name the PAT. */
  machineName: string;
}

interface ExchangeTokenResult {
  id: string;
  /** Raw PAT value (kici_pat_...). */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** PKCE pair: verifier is 32 random bytes, challenge its SHA-256; both base64url. */
function generatePkceChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

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
 * Turn a callback-server `listen` failure into an actionable message. The
 * wording differs by cause on purpose: naming `KICI_CALLBACK_PORT` for an
 * ephemeral port misdirects the user, and "already in use" for a permission
 * error is a false diagnosis.
 */
function describeListenFailure(err: NodeJS.ErrnoException, listenPort: number): string {
  const escapes =
    'Retry with `kici login --device` (no local callback needed), or set KICI_CALLBACK_PORT to a free port your firewall allows.';

  if (err.code === 'EADDRINUSE') {
    if (listenPort === 0) {
      return `No local port was available for the login callback server. ${escapes}`;
    }
    return `Port ${listenPort} (KICI_CALLBACK_PORT) is already in use, so the login callback server could not start. ${escapes}`;
  }

  if (err.code === 'EACCES') {
    return `Permission denied binding port ${listenPort} (KICI_CALLBACK_PORT) for the login callback server — ports below 1024 need elevated privileges. ${escapes}`;
  }

  return `Could not start the local callback server on port ${listenPort}: ${err.message}. ${escapes}`;
}

/**
 * PKCE authorization code flow with a localhost callback server (on an
 * ephemeral port, or `KICI_CALLBACK_PORT`). Returns the OIDC access token.
 * Endpoints come from the IdP's OIDC discovery document, so the flow works
 * against any spec-compliant IdP.
 */
export async function pkceFlow(opts: PkceFlowOptions): Promise<string> {
  const { issuer, clientId, nudgeAfterMs = 90_000, timeoutMs = 5 * 60 * 1000 } = opts;

  // Validate before discovery, so a bad env var is not masked by an IdP transport error.
  let listenPort = 0;
  const callbackPortEnv = process.env.KICI_CALLBACK_PORT;
  if (callbackPortEnv) {
    const parsed = parseInt(callbackPortEnv, 10);
    // `server.listen()` rejects a port above 65535 with a synchronous RangeError
    // that escapes as a raw stack trace instead of reaching describeListenFailure().
    if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(
        `KICI_CALLBACK_PORT must be a port number between 0 and 65535, got: "${callbackPortEnv}"`,
      );
    }
    listenPort = parsed;
  }

  const endpoints = await discoverOidcEndpoints(issuer);
  const { verifier, challenge } = generatePkceChallenge();
  const state = randomBytes(16).toString('hex');

  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://127.0.0.1`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Cancel the nudge here, not in cleanup(): the token exchange can outlast
      // the nudge delay, and telling a user mid-exchange to press Ctrl-C would
      // abort a login that is succeeding.
      if (nudgeTimer) clearTimeout(nudgeTimer);

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

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);

      const port = (server.address() as AddressInfo).port;

      try {
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
      if (nudgeTimer) clearTimeout(nudgeTimer);
      if (server.listening) server.close();
    }

    // Without this listener a failed bind raises an uncaught exception and the
    // promise never settles. cleanup() is safe: server.listening is false after
    // a failed bind, and the timers are not set yet.
    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(new Error(describeListenFailure(err, listenPort)));
    });

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
        // Machine-parseable for scripts (no picocolors).
        console.log(`KICI_AUTH_URL=${authUrl.toString()}`);
        console.log(pc.cyan(`  Waiting for browser callback on port ${actualPort}...`));
      } else if (browserCmd) {
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
        // `open` resolves once it spawns the launcher, so a browser that never
        // appears does not reject; print the URL up front to stay recoverable.
        console.log(pc.cyan('  Opening browser for authentication...'));
        console.log(pc.dim(`  If it does not open, visit:\n  ${authUrl.toString()}`));
        open(authUrl.toString()).catch(() => {
          console.log(
            pc.yellow(
              `  Could not open browser automatically. Please visit:\n  ${authUrl.toString()}`,
            ),
          );
        });
      }
    });

    // Nudge once mid-wait, so a blocked callback is not five silent minutes. The
    // delay must clear a healthy sign-in (credentials, MFA, a cold IdP page run
    // well past half a minute): a nudge during a succeeding login reads as
    // advice to abort it.
    nudgeTimer = setTimeout(() => {
      console.log(
        pc.yellow(
          '  Still waiting for the browser callback...\n' +
            '  If you are still signing in, ignore this. If your browser cannot reach the\n' +
            '  callback, press Ctrl+C and retry with `kici login --device`.',
        ),
      );
    }, nudgeAfterMs);

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Authentication timed out after 5 minutes. ' +
            'If your browser cannot reach the local callback, retry with `kici login --device` ' +
            'to authenticate without one.',
        ),
      );
    }, timeoutMs);
  });
}

/**
 * RFC 8628 device authorization flow: shows the user code, then polls the
 * token endpoint until the user authorizes or the code expires. Returns the
 * OIDC access token. Endpoints come from OIDC discovery.
 */
export async function deviceFlow(opts: DeviceFlowOptions): Promise<string> {
  const { issuer, clientId } = opts;
  const endpoints = await discoverOidcEndpoints(issuer);

  const scopes = ['openid', 'profile', 'email', 'offline_access'];

  // Keycloak enforces PKCE on device flow when the client sets
  // `pkce.code.challenge.method` (KiCI's public clients require S256). RFC 8628
  // does not require it, and IdPs that don't enforce it ignore the params. The
  // verifier goes back on the token poll.
  const { verifier, challenge } = generatePkceChallenge();

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

  // verification_uri_complete embeds the code, so the user usually skips code
  // entry. Keep the `Enter code:` substring in both branches: output scrapers
  // (automated logins, support tooling) parse it.
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

  // Server-specified interval, default 5s.
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
          // Pairs with the device-authorization code_challenge.
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
        continue;

      case 'slow_down':
        // +5s per RFC 8628.
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

/** Exchange an OIDC access token (Bearer) for a PAT at /api/v1/cli/exchange-token. */
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
