/**
 * Host side of the git credential helper.
 *
 * Git spawns the helper as its own process, so it cannot call into the agent
 * directly. This module gives it a route: a per-job unix socket the agent
 * listens on, plus a tiny executable shim that connects to it and speaks git's
 * credential protocol on stdin/stdout.
 *
 * The shim is deliberately self-contained — no imports beyond `node:net` — so it
 * needs no module resolution, no bundle, and no dependency on where the agent
 * was installed. Its only job is to move bytes.
 *
 * Scope: this is the HOST path, which covers bare-metal jobs. A container job
 * clones and executes inside the container today and has no route to this
 * socket; that is fixed by the dual-mode container work, which moves the clone
 * to the host and injects `/opt/kici` read-only.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What the shim asks for, and what it gets back. */
export interface HelperQuery {
  protocol?: string;
  host?: string;
  path?: string;
}
export type HelperAnswer = { username: string; password: string } | null;

/** The shim source. Kept inline so the helper has no build step of its own. */
export function shimSource(socketPath: string): string {
  // Self-contained on purpose: a require of anything agent-owned would tie the
  // helper to an install layout git knows nothing about.
  return `#!/usr/bin/env node
'use strict';
const net = require('node:net');
const op = process.argv[2];
// We persist nothing, so 'store' and 'erase' have nothing to do. Exiting
// non-zero here would break pushes that are otherwise working.
if (op !== 'get') process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const query = {};
  for (const line of input.split('\\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    if (k === 'protocol' || k === 'host' || k === 'path') query[k] = line.slice(eq + 1);
  }
  const sock = net.createConnection(${JSON.stringify(socketPath)});
  let reply = '';
  const bail = () => { try { sock.destroy(); } catch {} process.exit(0); };
  sock.on('error', bail);
  sock.on('connect', () => sock.end(JSON.stringify(query) + '\\n'));
  sock.on('data', (d) => { reply += d.toString('utf8'); });
  sock.on('close', () => {
    let out = '';
    try {
      const parsed = JSON.parse(reply || 'null');
      if (parsed && parsed.username) {
        out = 'username=' + parsed.username + '\\npassword=' + parsed.password + '\\n';
      }
    } catch {
      // An unparseable reply is a miss, not a crash: git falls through.
    }
    // Exit only once stdout has flushed. process.exit() truncates a pending
    // pipe write, which silently produced an empty credential reply.
    if (out === '') process.exit(0);
    process.stdout.write(out, () => process.exit(0));
  });
});
`;
}

export interface CredentialHelperHost {
  /** Absolute path to pass as `credential.helper`. */
  helperPath: string;
  /** Stop listening and release the socket. */
  close(): Promise<void>;
}

/**
 * Start the per-job helper socket and materialize the shim.
 *
 * `answer` is the agent's resolver: it consults the grant table and asks the
 * orchestrator broker. Returning null means "no credential", which the shim
 * turns into an empty reply so git falls through to its own mechanisms.
 */
export async function startCredentialHelperHost(args: {
  /** Job-scoped directory to hold the socket and the shim. */
  dir: string;
  answer: (query: HelperQuery) => Promise<HelperAnswer>;
}): Promise<CredentialHelperHost> {
  await mkdir(args.dir, { recursive: true, mode: 0o700 });
  const socketPath = join(args.dir, 'git-credential.sock');
  // `.cjs` on purpose: the shim uses `require`, and a job directory may sit
  // under a package.json declaring `"type": "module"`, which would otherwise
  // make Node parse it as ESM and fail before it ever connects.
  const helperPath = join(args.dir, 'git-credential-kici.cjs');

  await writeFile(helperPath, shimSource(socketPath), { mode: 0o700 });
  await chmod(helperPath, 0o700);

  // `allowHalfOpen` is required, not a tuning knob. The shim half-closes its
  // write side to signal end-of-query; without this Node ends our writable side
  // at the same moment, so the reply — resolved asynchronously by the broker —
  // is written to an already-closed socket and git silently sees no credential.
  const server = createServer({ allowHalfOpen: true }, (socket) =>
    handleConnection(socket, args.answer),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { helperPath, close: () => closeServer(server) };
}

/** Read one newline-terminated query, answer it, close. */
function handleConnection(socket: Socket, answer: (q: HelperQuery) => Promise<HelperAnswer>): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* a helper that died mid-request is a miss, not an agent failure */
  });
  socket.on('data', (chunk: string) => {
    buf += chunk;
  });
  socket.on('end', () => {
    let query: HelperQuery;
    try {
      query = JSON.parse(buf || '{}') as HelperQuery;
    } catch {
      socket.end('null\n');
      return;
    }
    answer(query).then(
      (result) => socket.end(JSON.stringify(result) + '\n'),
      // Never surface the error text: it can carry forge output. The miss is
      // enough — the orchestrator side logs the detail.
      () => socket.end('null\n'),
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
