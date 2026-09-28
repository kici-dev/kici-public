import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { stopHttpServer, trackOpenSockets } from './http-server-stop.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** A server that answers HTTP and accepts any upgrade, then holds the socket open. */
async function serverWithUpgrades() {
  const server = http.createServer((_req, res) => res.end('ok'));
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  const tracker = trackOpenSockets(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => {
    server.closeAllConnections();
    for (const socket of tracker.sockets) socket.destroy();
    server.close();
  });
  return { server, tracker, port: (server.address() as AddressInfo).port };
}

/** A client that upgrades and then never reads, answers or closes. */
async function stuckUpgrade(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  cleanups.push(() => socket.destroy());
  socket.on('error', () => {});
  socket.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await once(socket, 'data');
  return socket;
}

describe('stopHttpServer', () => {
  // Positive control: the defect this guards. close() + closeAllConnections()
  // leaves an upgraded socket open, so the close never completes.
  it('a plain close waits on an upgraded socket', async () => {
    const { server, port } = await serverWithUpgrades();
    await stuckUpgrade(port);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
    ]);
    expect(outcome).toBe('waiting');
  });

  // fails-when: the stop waits for an upgraded socket instead of destroying it.
  it('destroys an upgraded socket that outlives the grace, and names it', async () => {
    const { server, tracker, port } = await serverWithUpgrades();
    const client = await stuckUpgrade(port);
    const [serverSide] = tracker.sockets;
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      warn: (msg: string, meta?: Record<string, unknown>) => void warnings.push({ msg, meta }),
    };
    const started = Date.now();
    const result = await stopHttpServer(server, tracker, { graceMs: 200, logger });
    expect(result.destroyed).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(serverSide?.destroyed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta?.connections).toEqual([`127.0.0.1:${client.localPort}`]);
  });

  // breaks-if-wrong: a server with only finished HTTP traffic stops at once, destroying nothing.
  it('stops at once when only HTTP connections were open', async () => {
    const { server, tracker, port } = await serverWithUpgrades();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => void warnings.push(msg) };
    const started = Date.now();
    const result = await stopHttpServer(server, tracker, { graceMs: 2_000, logger });
    expect(result.destroyed).toBe(0);
    expect(warnings).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
