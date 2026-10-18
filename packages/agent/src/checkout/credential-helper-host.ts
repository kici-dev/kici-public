/**
 * Host side of the git credential helper. Git spawns the helper as its own
 * process, so it reaches the agent through a per-job unix socket plus a tiny
 * executable shim that speaks git's credential protocol on stdin/stdout.
 *
 * The shim imports only `node:net`, so it needs no module resolution, no
 * bundle, and no knowledge of where the agent was installed.
 *
 * Scope: the HOST path, which covers bare-metal jobs. A container job clones on
 * the host, but its steps run inside the container, which has no route to this
 * socket.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmod, chown, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What the shim asks for, and what it gets back. */
export interface HelperQuery {
  protocol?: string;
  host?: string;
  path?: string;
}
export type HelperAnswer = { username: string; password: string } | null;

/** Kept inline so the helper has no build step of its own. */
export function shimSource(socketPath: string): string {
  // A require of anything agent-owned would tie the helper to an install
  // layout git knows nothing about.
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
  close(): Promise<void>;
}

/**
 * `answer` returning null means "no credential": the shim sends an empty reply
 * and git falls through to its own mechanisms.
 */
export async function startCredentialHelperHost(args: {
  /** Job-scoped directory for the socket and the shim. */
  dir: string;
  answer: (query: HelperQuery) => Promise<HelperAnswer>;
  /**
   * The runner's identity under `KICI_RUNNER_USER`. The directory, shim and
   * socket are created `0700` by the agent, so a runner with another uid could
   * neither run the shim nor connect without this.
   */
  owner?: { uid: number; gid: number };
}): Promise<CredentialHelperHost> {
  await mkdir(args.dir, { recursive: true, mode: 0o700 });
  const socketPath = join(args.dir, 'git-credential.sock');
  // `.cjs`: the shim uses `require`, and a job directory under a
  // `"type": "module"` package.json would otherwise make Node parse it as ESM.
  const helperPath = join(args.dir, 'git-credential-kici.cjs');

  await writeFile(helperPath, shimSource(socketPath), { mode: 0o700 });
  await chmod(helperPath, 0o700);

  // `allowHalfOpen` is required: the shim half-closes to signal end-of-query,
  // and without it Node ends our side too, so the async broker reply hits a
  // closed socket and git silently sees no credential.
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

  if (args.owner) {
    try {
      for (const path of [args.dir, helperPath, socketPath]) {
        await chown(path, args.owner.uid, args.owner.gid);
      }
    } catch (err) {
      await closeServer(server);
      throw err;
    }
  }

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
      // Never surface the error text (it can carry forge output); the
      // orchestrator side logs the detail.
      () => socket.end('null\n'),
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
