import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProxyKeepAliveTimeouts,
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_KEEP_ALIVE_TIMEOUT_MS,
} from './http-server-timeouts.js';

describe('applyProxyKeepAliveTimeouts', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  });

  it('raises a real http.Server above Caddy default two-minute upstream pool', () => {
    const server = createServer();
    servers.push(server);
    // fails-when: the helper is not applied — Node's default is 5000 ms
    expect(server.keepAliveTimeout).toBe(5_000);
    applyProxyKeepAliveTimeouts(server);
    expect(server.keepAliveTimeout).toBe(PROXY_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(PROXY_HEADERS_TIMEOUT_MS);
  });

  it('outlives the proxy pools it sits behind and keeps headersTimeout above keepAliveTimeout', () => {
    // Caddy 2m, nginx 60s, AWS ALB 60s: the listener must close last.
    expect(PROXY_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(120_000);
    // breaks-if-wrong: Node cuts an idle keep-alive connection at
    // headersTimeout when it is the smaller of the two.
    expect(PROXY_HEADERS_TIMEOUT_MS).toBeGreaterThan(PROXY_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('returns the same server so it can wrap a serve() call', () => {
    const server = createServer();
    servers.push(server);
    expect(applyProxyKeepAliveTimeouts(server)).toBe(server);
  });
});
