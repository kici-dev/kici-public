import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock 'open' to avoid actually opening a browser
vi.mock('open', () => ({
  default: vi.fn(),
}));

import { pkceFlow, deviceFlow, exchangeTokenForPat } from './oauth.js';
import { resetDiscoveryCache } from './oidc-discovery.js';
import open from 'open';

/**
 * The mock OIDC discovery document. Its endpoints are the `/oauth/v2/*` routes
 * the mock handlers already serve, so discovery reuses them unchanged.
 */
function discoveryDoc(origin: string): string {
  return JSON.stringify({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/v2/authorize`,
    token_endpoint: `${origin}/oauth/v2/token`,
    device_authorization_endpoint: `${origin}/oauth/v2/device_authorization`,
  });
}

function isDiscoveryReq(url: string | undefined): boolean {
  return url === '/.well-known/openid-configuration';
}

/**
 * Console-wait deadline. It stays well under the package-wide 15s vitest timeout
 * so a developer reads the helper's diagnosis, not a bare "Test timed out".
 */
const CALLBACK_WAIT_MS = 5_000;

/** The class excludes ESC so a colorized line cannot capture a trailing style reset. */
const AUTHORIZE_URL = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/v2\/authorize\?[^\s\u001B]+)/;

function consoleText(spy: MockInstance): string {
  return spy.mock.calls.map((c) => c.join(' ')).join('\n');
}

/**
 * Wait for `pattern` on the spied console, raced against the flow that prints
 * it. It never hangs: the pattern matches, the flow rejects, or the deadline
 * fires with a diagnosis naming what was awaited and what the console held.
 */
async function waitForConsole(
  spy: MockInstance,
  pattern: RegExp,
  opts: { flow: Promise<unknown>; label: string; timeoutMs?: number },
): Promise<RegExpMatchArray> {
  const timeoutMs = opts.timeoutMs ?? CALLBACK_WAIT_MS;
  const startedAt = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A flow cannot resolve before its callback is driven, so only a rejection may win.
  const flowRejected = opts.flow.then(
    () => new Promise<never>(() => {}),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`while waiting for ${opts.label}, the flow rejected: ${message}`, {
        cause: err,
      });
    },
  );
  // Swallow the loser so a late rejection is not reported as unhandled in the next test.
  flowRejected.catch(() => {});

  const polled = new Promise<RegExpMatchArray>((resolve, reject) => {
    interval = setInterval(() => {
      const match = consoleText(spy).match(pattern);
      if (match) resolve(match);
    }, 10);
    timer = setTimeout(() => {
      const text = consoleText(spy);
      reject(
        new Error(
          `timed out after ${Date.now() - startedAt}ms waiting for ${opts.label} ` +
            `(/${pattern.source}/). Console held: ${text || '(console produced no output)'}`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([polled, flowRejected]);
  } finally {
    clearInterval(interval);
    clearTimeout(timer);
  }
}

/**
 * Wait for the printed authorize URL, then drive the browser's OIDC callback.
 * The fetch is awaited, so a callback that fails to land surfaces here.
 */
async function driveCallback(
  spy: MockInstance,
  flow: Promise<unknown>,
  opts?: { pattern?: RegExp; timeoutMs?: number },
): Promise<void> {
  const match = await waitForConsole(spy, opts?.pattern ?? AUTHORIZE_URL, {
    flow,
    label: 'the authorize URL',
    timeoutMs: opts?.timeoutMs,
  });
  const authUrl = new URL(match[1]);
  const redirectUri = authUrl.searchParams.get('redirect_uri')!;
  const state = authUrl.searchParams.get('state')!;
  await fetch(`${redirectUri}?code=test-code&state=${state}`);
}

beforeEach(() => {
  resetDiscoveryCache();
});

describe('pkceFlow', () => {
  let mockAuthServer: Server;
  let mockPort: number;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KICI_BROWSER_CMD;
    delete process.env.KICI_CALLBACK_PORT;
    if (mockAuthServer?.listening) {
      mockAuthServer.close();
    }
  });

  it('constructs correct authorization URL with PKCE parameters', async () => {
    let capturedUrl: string | undefined;

    vi.mocked(open).mockImplementation(async (target: string) => {
      capturedUrl = target;
      const authUrl = new URL(target);
      const redirectUri = authUrl.searchParams.get('redirect_uri')!;
      const state = authUrl.searchParams.get('state')!;

      await fetch(`${redirectUri}?code=test-auth-code&state=${state}`);
      return {} as any;
    });

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'mock-access-token', token_type: 'Bearer' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const token = await pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    expect(token).toBe('mock-access-token');
    expect(capturedUrl).toBeDefined();

    const authUrl = new URL(capturedUrl!);
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('scope')).toContain('openid');
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
  });

  it('rejects on state mismatch', async () => {
    vi.mocked(open).mockImplementation(async (target: string) => {
      const authUrl = new URL(target);
      const redirectUri = authUrl.searchParams.get('redirect_uri')!;
      // Send wrong state
      await fetch(`${redirectUri}?code=test-code&state=wrong-state`);
      return {} as any;
    });

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok' }));
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    await expect(
      pkceFlow({
        issuer: `http://127.0.0.1:${mockPort}`,
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow('State mismatch');
  });

  it('uses KICI_CALLBACK_PORT when set', async () => {
    process.env.KICI_CALLBACK_PORT = '19876';

    vi.mocked(open).mockImplementation(async (target: string) => {
      const authUrl = new URL(target);
      const redirectUri = authUrl.searchParams.get('redirect_uri')!;
      const state = authUrl.searchParams.get('state')!;

      expect(redirectUri).toContain(':19876/callback');

      await fetch(`${redirectUri}?code=test-code&state=${state}`);
      return {} as any;
    });

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'port-test-token' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const token = await pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    expect(token).toBe('port-test-token');
  });

  it('throws on invalid KICI_CALLBACK_PORT', async () => {
    process.env.KICI_CALLBACK_PORT = 'not-a-number';

    await expect(
      pkceFlow({
        issuer: 'http://127.0.0.1:1234',
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow(/KICI_CALLBACK_PORT/);
  });

  it('throws on negative KICI_CALLBACK_PORT', async () => {
    process.env.KICI_CALLBACK_PORT = '-1';

    await expect(
      pkceFlow({
        issuer: 'http://127.0.0.1:1234',
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow(/KICI_CALLBACK_PORT/);
  });

  it('throws on out-of-range KICI_CALLBACK_PORT', async () => {
    // Above 65535 `server.listen()` throws a synchronous RangeError that never
    // reaches the 'error' listener, so the range has to be rejected up front.
    process.env.KICI_CALLBACK_PORT = '70000';

    await expect(
      pkceFlow({
        issuer: 'http://127.0.0.1:1234',
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow(/KICI_CALLBACK_PORT/);
  });

  it('rejects with an actionable error when KICI_CALLBACK_PORT is busy', async () => {
    // Discovery runs before the callback server binds, so the issuer must be a
    // real discovery endpoint, not the squatter.
    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const squatter = createServer(() => {});
    await new Promise<void>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => resolve());
    });
    const busyPort = (squatter.address() as AddressInfo).port;

    try {
      process.env.KICI_CALLBACK_PORT = String(busyPort);

      const err = await pkceFlow({
        issuer: `http://127.0.0.1:${mockPort}`,
        clientId: 'test-client-id',
      }).then(
        () => null,
        (e) => e as Error,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain(String(busyPort));
      expect(err!.message).toContain('KICI_CALLBACK_PORT');
      expect(err!.message).toContain('--device');
    } finally {
      squatter.close();
    }
  });

  it('prints URL to stdout when KICI_BROWSER_CMD=none', async () => {
    process.env.KICI_BROWSER_CMD = 'none';
    vi.mocked(open).mockClear();

    const consoleSpy = vi.spyOn(console, 'log');

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'browser-cmd-none-token' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    // Wait on the machine-readable marker itself, the thing under test.
    await driveCallback(consoleSpy, tokenPromise, { pattern: /KICI_AUTH_URL=(\S+)/ });
    const token = await tokenPromise;

    expect(token).toBe('browser-cmd-none-token');
    expect(open).not.toHaveBeenCalled();
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('KICI_AUTH_URL=');
  });

  it('prints the authorize URL on the default open path', async () => {
    delete process.env.KICI_BROWSER_CMD;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);

    const consoleSpy = vi.spyOn(console, 'log');

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'default-open-token' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    await driveCallback(consoleSpy, tokenPromise);
    const token = await tokenPromise;

    expect(token).toBe('default-open-token');
    // The URL prints even after a launch, so a launch that silently shows no
    // browser still leaves the user something to click.
    expect(open).toHaveBeenCalledTimes(1);
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('If it does not open, visit:');
    expect(allOutput).toContain('/oauth/v2/authorize?');
  });

  it('serves HTML success page on callback', async () => {
    let callbackResponse: Response | undefined;

    vi.mocked(open).mockImplementation(async (target: string) => {
      const authUrl = new URL(target);
      const redirectUri = authUrl.searchParams.get('redirect_uri')!;
      const state = authUrl.searchParams.get('state')!;
      callbackResponse = await fetch(`${redirectUri}?code=test-code&state=${state}`);
      return {} as any;
    });

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    await pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    expect(callbackResponse).toBeDefined();
    expect(callbackResponse!.status).toBe(200);
    const html = await callbackResponse!.text();
    expect(html).toContain('KiCI');
    expect(html).toContain('success');
  });

  it('names the device flow in the callback timeout error', async () => {
    delete process.env.KICI_BROWSER_CMD;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    // The callback is never driven, so the flow must reject on its own timer.
    // nudgeAfterMs is pinned high so this case exercises only the timeout.
    await expect(
      pkceFlow({
        issuer: `http://127.0.0.1:${mockPort}`,
        clientId: 'test-client-id',
        timeoutMs: 100,
        nudgeAfterMs: 60_000,
      }),
    ).rejects.toThrow(/kici login --device/);
  });

  it('nudges toward the device flow while still waiting for the callback', async () => {
    delete process.env.KICI_BROWSER_CMD;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);

    const consoleSpy = vi.spyOn(console, 'log');

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'nudge-token' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
      nudgeAfterMs: 50,
    });

    // Drive the callback only after the 50ms nudge appears, or the asserted
    // nudge never fires. Waiting on it, not sleeping, keeps this deterministic.
    await waitForConsole(consoleSpy, /Still waiting for the browser callback/, {
      flow: tokenPromise,
      label: 'the nudge',
    });
    await driveCallback(consoleSpy, tokenPromise);
    const token = await tokenPromise;

    expect(token).toBe('nudge-token');
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('Still waiting for the browser callback');
    expect(allOutput).toContain('kici login --device');
  });

  it('does not nudge when the callback arrives promptly', async () => {
    delete process.env.KICI_BROWSER_CMD;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);

    const consoleSpy = vi.spyOn(console, 'log');

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'quiet-token' }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
      nudgeAfterMs: 30_000,
    });
    await driveCallback(consoleSpy, tokenPromise);
    const token = await tokenPromise;

    expect(token).toBe('quiet-token');
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('Still waiting for the browser callback');
  });

  it('does not nudge once the callback landed, even if the token exchange is slow', async () => {
    delete process.env.KICI_BROWSER_CMD;
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValue(undefined as never);

    const consoleSpy = vi.spyOn(console, 'log');

    // The nudge delay far exceeds a loopback round-trip and the token exchange is
    // held past it, so the nudge window falls strictly between callback and
    // token: where "press Ctrl-C" would abort a succeeding login.
    const NUDGE_AFTER_MS = 1_000;
    const TOKEN_HOLD_MS = 1_400;

    let tokenRequestAt: number | undefined;

    mockAuthServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockAuthServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
      } else if (req.url?.startsWith('/oauth/v2/token')) {
        tokenRequestAt = Date.now();
        req.on('data', () => {});
        req.on('end', () => {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'slow-exchange-token' }));
          }, TOKEN_HOLD_MS);
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockAuthServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockAuthServer.address() as AddressInfo).port;

    const startedAt = Date.now();
    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
      nudgeAfterMs: NUDGE_AFTER_MS,
    });

    await driveCallback(consoleSpy, tokenPromise);
    const token = await tokenPromise;

    // Premise guard: a callback slower than the nudge delay would make the
    // assertion below vacuous.
    expect(tokenRequestAt).toBeDefined();
    expect(tokenRequestAt! - startedAt).toBeLessThan(NUDGE_AFTER_MS);

    expect(token).toBe('slow-exchange-token');
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('Still waiting for the browser callback');
  });

  it('waitForConsole reports a deadline with a diagnosis instead of hanging', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const neverSettles = new Promise<never>(() => {});

    await expect(
      waitForConsole(consoleSpy, /a line nothing ever prints/, {
        flow: neverSettles,
        label: 'a line nothing prints',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/waiting for a line nothing prints/);
  });

  it('driveCallback surfaces a flow rejection instead of timing out', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // A dead port makes discovery reject before any URL prints: the shape that
    // leaves an unbounded poller waiting forever.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const tokenPromise = pkceFlow({
      issuer: `http://127.0.0.1:${deadPort}`,
      clientId: 'test-client-id',
    });

    await expect(driveCallback(consoleSpy, tokenPromise)).rejects.toThrow(/the flow rejected/);
    await expect(tokenPromise).rejects.toThrow();
  });
});

describe('deviceFlow', () => {
  let mockServer: Server;
  let mockPort: number;

  afterEach(() => {
    vi.restoreAllMocks();
    if (mockServer?.listening) {
      mockServer.close();
    }
  });

  it('posts to device_authorization endpoint and polls for token', async () => {
    let pollCount = 0;

    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'test-device-code',
              user_code: 'ABCD-1234',
              verification_uri: 'https://example.com/device',
              verification_uri_complete: 'https://example.com/device?user_code=ABCD-1234',
              interval: 0, // immediate for testing
              expires_in: 300,
            }),
          );
        } else if (req.url === '/oauth/v2/token') {
          pollCount++;
          if (pollCount < 3) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'authorization_pending' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'device-access-token', token_type: 'Bearer' }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    const token = await deviceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    expect(token).toBe('device-access-token');
    expect(pollCount).toBe(3);
  });

  it('handles slow_down by increasing interval', { timeout: 15000 }, async () => {
    let pollCount = 0;

    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'test-device-code',
              user_code: 'ABCD-1234',
              verification_uri: 'https://example.com/device',
              interval: 0,
              expires_in: 300,
            }),
          );
        } else if (req.url === '/oauth/v2/token') {
          pollCount++;
          if (pollCount === 1) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'slow_down' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'slow-token' }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    const token = await deviceFlow({
      issuer: `http://127.0.0.1:${mockPort}`,
      clientId: 'test-client-id',
    });

    expect(token).toBe('slow-token');
  });

  it('throws on access_denied', async () => {
    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'test-device-code',
              user_code: 'ABCD-1234',
              verification_uri: 'https://example.com/device',
              interval: 0,
              expires_in: 300,
            }),
          );
        } else if (req.url === '/oauth/v2/token') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'access_denied', error_description: 'User denied access' }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    await expect(
      deviceFlow({
        issuer: `http://127.0.0.1:${mockPort}`,
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow('User denied access');
  });

  it('uses pre-filled messaging when verification_uri_complete is present', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'dc',
              user_code: 'WXYZ-7890',
              verification_uri: 'https://example.com/device',
              verification_uri_complete: 'https://example.com/device?user_code=WXYZ-7890',
              interval: 0,
              expires_in: 300,
            }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok' }));
        }
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    mockPort = (mockServer.address() as AddressInfo).port;

    await deviceFlow({ issuer: `http://127.0.0.1:${mockPort}`, clientId: 'c' });

    const out = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('https://example.com/device?user_code=WXYZ-7890');
    expect(out).toContain('pre-filled');
    // Substring `Enter code:` must remain present so output parsers keep working.
    expect(out).toContain('Enter code:');
    expect(out).toContain('if prompted');
    expect(out).toContain('WXYZ-7890');
  });

  it('uses direct-entry messaging when only verification_uri is present', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'dc',
              user_code: 'AAAA-1111',
              verification_uri: 'https://example.com/device',
              interval: 0,
              expires_in: 300,
            }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok' }));
        }
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    mockPort = (mockServer.address() as AddressInfo).port;

    await deviceFlow({ issuer: `http://127.0.0.1:${mockPort}`, clientId: 'c' });

    const out = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('https://example.com/device');
    expect(out).not.toContain('pre-filled');
    expect(out).not.toContain('if prompted');
    expect(out).toContain('Enter code:');
    expect(out).toContain('AAAA-1111');
  });

  it('wraps IdP transport errors with an actionable message', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    // An unreachable issuer fails on the /.well-known/openid-configuration
    // fetch, so the error names discovery, not the device-flow endpoint.
    await expect(
      deviceFlow({ issuer: `http://127.0.0.1:${deadPort}`, clientId: 'c' }),
    ).rejects.toThrow(
      new RegExp(
        `Could not reach IdP discovery at http://127\\.0\\.0\\.1:${deadPort}/\\.well-known/openid-configuration.*KICI_OIDC_ISSUER`,
      ),
    );
  });

  it('throws on expired_token', async () => {
    mockServer = createServer((req, res) => {
      if (isDiscoveryReq(req.url)) {
        const origin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(discoveryDoc(origin));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/oauth/v2/device_authorization') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'test-device-code',
              user_code: 'ABCD-1234',
              verification_uri: 'https://example.com/device',
              interval: 0,
              expires_in: 300,
            }),
          );
        } else if (req.url === '/oauth/v2/token') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'expired_token' }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    await expect(
      deviceFlow({
        issuer: `http://127.0.0.1:${mockPort}`,
        clientId: 'test-client-id',
      }),
    ).rejects.toThrow(/expired/i);
  });
});

describe('exchangeTokenForPat', () => {
  let mockServer: Server;
  let mockPort: number;

  afterEach(() => {
    if (mockServer?.listening) {
      mockServer.close();
    }
  });

  it('POSTs to exchange-token endpoint and returns PAT info', async () => {
    let capturedHeaders: Record<string, string | undefined> = {};
    let capturedBody: string = '';

    mockServer = createServer((req, res) => {
      capturedHeaders = {
        authorization: req.headers.authorization,
        'content-type': req.headers['content-type'],
      };
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        capturedBody = body;
        if (req.url === '/api/v1/cli/exchange-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'pat-id-123',
              token: 'kici_pat_abc123',
              expiresAt: '2026-07-04T00:00:00Z',
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    const result = await exchangeTokenForPat({
      platformUrl: `http://127.0.0.1:${mockPort}`,
      accessToken: 'oidc-access-token',
      machineName: 'my-laptop',
    });

    expect(result).toEqual({
      id: 'pat-id-123',
      token: 'kici_pat_abc123',
      expiresAt: '2026-07-04T00:00:00Z',
    });

    expect(capturedHeaders.authorization).toBe('Bearer oidc-access-token');
    expect(capturedHeaders['content-type']).toBe('application/json');
    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.machineName).toBe('my-laptop');
  });

  it('throws on non-OK response', async () => {
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockPort = (mockServer.address() as AddressInfo).port;

    await expect(
      exchangeTokenForPat({
        platformUrl: `http://127.0.0.1:${mockPort}`,
        accessToken: 'bad-token',
        machineName: 'my-laptop',
      }),
    ).rejects.toThrow(/exchange.*failed/i);
  });

  it('throws an actionable error when platform URL is unreachable', async () => {
    // Bind+close yields a port nothing listens on.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(
      exchangeTokenForPat({
        platformUrl: `http://127.0.0.1:${deadPort}`,
        accessToken: 'oidc-token',
        machineName: 'my-laptop',
      }),
    ).rejects.toThrow(
      new RegExp(
        `Could not reach Platform at http://127\\.0\\.0\\.1:${deadPort}.*KICI_PLATFORM_URL`,
      ),
    );
  });
});
