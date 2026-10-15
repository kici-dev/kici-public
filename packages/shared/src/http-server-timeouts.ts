/**
 * Keep-alive timeouts for every KiCI HTTP listener behind a reverse proxy.
 *
 * Node closes an idle keep-alive socket after 5 s by default, while proxies
 * pool upstream connections far longer (Caddy two minutes, nginx and AWS load
 * balancers one) and Go's transport ignores Node's `Keep-Alive: timeout=` hint.
 * A proxy can then write into a socket Node is closing and read EOF: Go retries
 * an idempotent request, but answers 502 to a POST, and a provider webhook is
 * not redelivered.
 *
 * So the listener outlives every common proxy pool and the proxy always closes
 * first. `headersTimeout` stays above `keepAliveTimeout`, as Node requires, so
 * the header parser does not cut an idle connection early.
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
 * Accepts whatever `serve()` returns: an HTTP/1.1 server is adjusted; an HTTP/2
 * server has no keep-alive timeout and is returned as is.
 */
export function applyProxyKeepAliveTimeouts<T extends object>(server: T): T {
  if (isKeepAliveTimeoutTarget(server)) {
    server.keepAliveTimeout = PROXY_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS;
  }
  return server;
}
