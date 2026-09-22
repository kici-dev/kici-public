/**
 * Keep-alive timeouts for every KiCI HTTP listener that sits behind a
 * reverse proxy.
 *
 * Node closes an idle keep-alive socket after `keepAliveTimeout` (5 s by
 * default). A proxy pools its upstream connections for far longer — Caddy
 * keeps one idle for two minutes, nginx and the AWS load balancers for a
 * minute — and Go's transport does not read the `Keep-Alive: timeout=`
 * hint Node sends. So the proxy can pick a pooled connection at the very
 * instant Node is closing it, write the request, and read EOF. Go retries
 * that for an idempotent request; for a POST it answers 502, and a
 * provider webhook is not redelivered. One staging push webhook landed
 * exactly six seconds after the previous delivery on the same connection
 * and was lost this way.
 *
 * The listener therefore outlives every common proxy pool: the proxy always
 * closes first, on its own schedule, and never writes into a socket the
 * server is tearing down. `headersTimeout` stays above `keepAliveTimeout`,
 * as Node requires, so an idle connection is not cut by the header parser
 * before the keep-alive window ends.
 */
export const PROXY_KEEP_ALIVE_TIMEOUT_MS = 130_000;
export const PROXY_HEADERS_TIMEOUT_MS = PROXY_KEEP_ALIVE_TIMEOUT_MS + 5_000;

export interface KeepAliveTimeoutTarget {
  keepAliveTimeout: number;
  headersTimeout: number;
}

function isKeepAliveTimeoutTarget(server: object): server is KeepAliveTimeoutTarget {
  return 'keepAliveTimeout' in server && 'headersTimeout' in server;
}

/**
 * Apply the proxy-safe keep-alive timeouts to a listener. Accepts whatever
 * `serve()` returns: an HTTP/1.1 server carries both fields and is
 * adjusted; an HTTP/2 server has no keep-alive timeout and is returned as
 * is.
 */
export function applyProxyKeepAliveTimeouts<T extends object>(server: T): T {
  if (isKeepAliveTimeoutTarget(server)) {
    server.keepAliveTimeout = PROXY_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS;
  }
  return server;
}
