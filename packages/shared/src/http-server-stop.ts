/**
 * Stopping an HTTP server that also serves WebSocket upgrades, within a bound.
 *
 * server.close() stops accepting connections and waits for the open ones, and
 * closeAllConnections() ends every HTTP connection, but neither touches an
 * upgraded socket. A WebSocket whose closing handshake does not complete keeps
 * its socket open until the ws library's own 30 s close timeout, which is as
 * long as the orchestrator's whole shutdown ceiling.
 */

import type { Server, Socket } from 'node:net';
import type { ShutdownLogger } from './graceful-shutdown.js';

/** How long {@link stopHttpServer} waits for open connections before it destroys them. */
export const DEFAULT_HTTP_STOP_GRACE_MS = 2_000;

/** How long it waits for the close to report once the sockets are destroyed. */
const HTTP_STOP_SETTLE_MS = 1_000;

/** A server {@link stopHttpServer} can stop. An HTTP/1 server also has closeAllConnections(). */
export type StoppableServer = Server & { closeAllConnections?: () => void };

/** Every socket a server accepted and has not closed, upgraded ones included. */
export interface OpenSocketTracker {
  readonly sockets: ReadonlySet<Socket>;
}

/**
 * Track a server's open sockets. Call it right after the server is created.
 * It listens for 'connection' only: an extra 'upgrade' listener would change
 * how @hono/node-server rejects an upgrade that no route matches.
 */
export function trackOpenSockets(server: StoppableServer): OpenSocketTracker {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return { sockets };
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Stop `server` and wait until it has closed. Connections still open after
 * `graceMs`, upgraded WebSocket sockets included, are destroyed, and each one
 * is logged by its remote address, so the connection that held the stop open
 * can be identified.
 */
export async function stopHttpServer(
  server: StoppableServer,
  tracker: OpenSocketTracker,
  options: { graceMs?: number; logger?: Pick<ShutdownLogger, 'warn'> } = {},
): Promise<{ destroyed: number }> {
  const graceMs = options.graceMs ?? DEFAULT_HTTP_STOP_GRACE_MS;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  if (await settlesWithin(closed, graceMs)) return { destroyed: 0 };

  const remaining = [...tracker.sockets];
  options.logger?.warn(
    'HTTP server still had open connections after its grace period; destroying them',
    {
      graceMs,
      count: remaining.length,
      connections: remaining.map((s) => `${s.remoteAddress ?? '?'}:${s.remotePort ?? '?'}`),
    },
  );
  for (const socket of remaining) socket.destroy();
  await settlesWithin(closed, HTTP_STOP_SETTLE_MS);
  return { destroyed: remaining.length };
}
