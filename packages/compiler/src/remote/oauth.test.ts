import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 * Build the OIDC discovery document a mock server returns for the test
 * issuer. The endpoint paths mirror the OIDC `/oauth/v2/*`
 * routes the existing mock handlers already serve, so the discovery flow
 * routes traffic through the same handlers without test-server changes.
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

    // Capture the URL that would be opened in the browser
    vi.mocked(open).mockImplementation(async (target: string) => {
      capturedUrl = target;
      // Simulate browser callback by extracting the redirect_uri from the auth URL
      const authUrl = new URL(target);
      const redirectUri = authUrl.searchParams.get('redirect_uri')!;
      const state = authUrl.searchParams.get('state')!;

      // Simulate OIDC callback with an auth code
      await fetch(`${redirectUri}?code=test-auth-code&state=${state}`);
      return {} as any;
    });

    // Create a mock token endpoint
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

      // Verify the redirect URI uses the fixed port
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

  it('prints URL to stdout when KICI_BROWSER_CMD=none', async () => {
    process.env.KICI_BROWSER_CMD = 'none';
    vi.mocked(open).mockClear();

    const consoleSpy = vi.spyOn(console, 'log');

    // We need to simulate the callback happening after the URL is printed
    // Use a small delay to allow the server to start and URL to be printed
    const callbackPromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const calls = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        const match = calls.match(/KICI_AUTH_URL=(\S+)/);
        if (match) {
          clearInterval(interval);
          const authUrl = new URL(match[1]);
          const redirectUri = authUrl.searchParams.get('redirect_uri')!;
          const state = authUrl.searchParams.get('state')!;
          fetch(`${redirectUri}?code=test-code&state=${state}`).then(() => resolve());
        }
      }, 10);
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

    await callbackPromise;
    const token = await tokenPromise;

    expect(token).toBe('browser-cmd-none-token');
    // Should NOT have called open()
    expect(open).not.toHaveBeenCalled();
    // Should have printed the auth URL
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('KICI_AUTH_URL=');
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
            // First two polls return pending
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'authorization_pending' }));
          } else {
            // Third poll succeeds
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

    // With OIDC discovery in place, an unreachable issuer fails on the
    // /.well-known/openid-configuration fetch — not on the
    // device_authorization endpoint — so the error message points at
    // discovery rather than the device-flow endpoint.
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
    // Bind+close a server to get a port we know nothing is listening on.
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
