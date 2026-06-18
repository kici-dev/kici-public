import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverOidcEndpoints, resetDiscoveryCache } from './oidc-discovery.js';

interface HitTracker {
  count: number;
  lastUrl: string | undefined;
}

function startServer(
  handler: (req: Parameters<Parameters<typeof createServer>[0]>[0]) => {
    status: number;
    body: string;
    contentType?: string;
  },
): Promise<{ url: string; server: Server; hits: HitTracker }> {
  const hits: HitTracker = { count: 0, lastUrl: undefined };
  const server = createServer((req, res) => {
    hits.count += 1;
    hits.lastUrl = req.url;
    const { status, body, contentType } = handler(req);
    res.writeHead(status, { 'Content-Type': contentType ?? 'application/json' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server, hits });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const VALID_DOC = (issuer: string): string =>
  JSON.stringify({
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    device_authorization_endpoint: `${issuer}/protocol/openid-connect/auth/device`,
    userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  });

describe('discoverOidcEndpoints', () => {
  let activeServer: Server | undefined;

  beforeEach(() => {
    resetDiscoveryCache();
  });

  afterEach(async () => {
    if (activeServer) {
      await closeServer(activeServer);
      activeServer = undefined;
    }
  });

  it('fetches /.well-known/openid-configuration and returns the four endpoints', async () => {
    const { url, server, hits } = await startServer((req) => {
      if (req.url === '/.well-known/openid-configuration') {
        return { status: 200, body: VALID_DOC(`http://example.test`) };
      }
      return { status: 404, body: 'not found', contentType: 'text/plain' };
    });
    activeServer = server;

    const endpoints = await discoverOidcEndpoints(url);

    expect(hits.count).toBe(1);
    expect(hits.lastUrl).toBe('/.well-known/openid-configuration');
    expect(endpoints.issuer).toBe('http://example.test');
    expect(endpoints.authorization_endpoint).toBe(
      'http://example.test/protocol/openid-connect/auth',
    );
    expect(endpoints.token_endpoint).toBe('http://example.test/protocol/openid-connect/token');
    expect(endpoints.device_authorization_endpoint).toBe(
      'http://example.test/protocol/openid-connect/auth/device',
    );
  });

  it('caches the result per-issuer (no second round-trip)', async () => {
    const { url, server, hits } = await startServer((req) => {
      if (req.url === '/.well-known/openid-configuration') {
        return { status: 200, body: VALID_DOC(url) };
      }
      return { status: 404, body: 'not found' };
    });
    activeServer = server;

    await discoverOidcEndpoints(url);
    await discoverOidcEndpoints(url);
    await discoverOidcEndpoints(url);

    expect(hits.count).toBe(1);
  });

  it('strips trailing slashes before appending the discovery path', async () => {
    const { url, server, hits } = await startServer((req) => {
      if (req.url === '/.well-known/openid-configuration') {
        return { status: 200, body: VALID_DOC(url) };
      }
      return { status: 404, body: 'not found' };
    });
    activeServer = server;

    await discoverOidcEndpoints(`${url}///`);

    expect(hits.lastUrl).toBe('/.well-known/openid-configuration');
  });

  it('throws on an empty issuer', async () => {
    await expect(discoverOidcEndpoints('')).rejects.toThrowError(/issuer is empty/);
    await expect(discoverOidcEndpoints('   ')).rejects.toThrowError(/issuer is empty/);
  });

  it('throws on a non-2xx response', async () => {
    const { url, server } = await startServer(() => ({ status: 404, body: 'nope' }));
    activeServer = server;

    await expect(discoverOidcEndpoints(url)).rejects.toThrowError(/HTTP 404/);
  });

  it('throws on a non-JSON body', async () => {
    const { url, server } = await startServer(() => ({
      status: 200,
      body: 'this is not json',
      contentType: 'text/plain',
    }));
    activeServer = server;

    await expect(discoverOidcEndpoints(url)).rejects.toThrowError(/non-JSON body/);
  });

  it('throws when a required endpoint field is missing', async () => {
    const { url, server } = await startServer(() => ({
      status: 200,
      body: JSON.stringify({
        issuer: 'http://example.test',
        authorization_endpoint: 'http://example.test/auth',
        token_endpoint: 'http://example.test/token',
        // device_authorization_endpoint deliberately missing
      }),
    }));
    activeServer = server;

    await expect(discoverOidcEndpoints(url)).rejects.toThrowError(
      /missing required field\(s\): device_authorization_endpoint/,
    );
  });

  it('throws an actionable error on a transport failure', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(discoverOidcEndpoints(`http://127.0.0.1:${deadPort}`)).rejects.toThrowError(
      /Could not reach IdP discovery.*KICI_OIDC_ISSUER/,
    );
  });
});
