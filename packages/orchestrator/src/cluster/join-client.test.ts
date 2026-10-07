import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { z } from 'zod';
import {
  JOIN_PROTOCOL_UNSUPPORTED_MESSAGE,
  JoinErrorCode,
  PROTOCOL_VERSION,
  authRequestSchema,
  buildJoinRefusal,
  joinRequestSchema,
} from '@kici-dev/engine';

import { envDef, loadConfig } from '../config.js';
import { sharedConfigSchema } from '../config/schema.js';
import {
  SERVER_PROOF_MISMATCH_MESSAGE,
  deriveJoinKeys,
  requestTranscript,
  sealJoinResponse,
  verifyJoinerProof,
} from './join-protocol-v2.js';
import {
  JOIN_TIMEOUT_MS,
  JoinClient,
  STORAGE_ENV_VARS,
  buildEnvFile,
  joinEndpointUrl,
  writeEnvFile,
} from './join-client.js';

const BUNDLE = {
  databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
  clusterId: 'cluster-1',
  storage: { type: 's3' as const, bucket: 'kici-cache' },
  secretKey: 'c'.repeat(64),
};

/** A real-format token; the hash is computed with node:crypto, independent of the module. */
function makeToken(): { token: string; secretHex: string; tokenHash: Buffer } {
  const secret = randomBytes(32);
  const routing = Buffer.from(
    JSON.stringify({ orgId: 'org', routingKey: 'rk', expiry: Date.now() + 60_000 }),
  ).toString('base64url');
  return {
    token: `kici_join_v1.${routing}.${secret.toString('hex')}`,
    secretHex: secret.toString('hex'),
    tokenHash: createHash('sha256').update(secret).digest(),
  };
}

/** What an existing orchestrator holding `tokenHash` answers to a v2 request. */
function answerFor(tokenHash: Buffer, request: Record<string, unknown>, bundle: object = BUNDLE) {
  const req = joinRequestSchema.parse(request);
  const keys = deriveJoinKeys(tokenHash);
  const requestT = requestTranscript(
    req.routing,
    Buffer.from(req.joinerPublicKey, 'base64'),
    Buffer.from(req.joinerNonce, 'base64'),
  );
  if (!verifyJoinerProof(keys, requestT, req.joinerProof)) {
    return buildJoinRefusal(req.messageId, JoinErrorCode.enum.invalid_token, 'Invalid join token');
  }
  return {
    type: 'join.response' as const,
    messageId: req.messageId,
    success: true,
    ...sealJoinResponse({
      keys,
      requestT,
      joinerPublicKey: Buffer.from(req.joinerPublicKey, 'base64'),
      bundle,
    }),
  };
}

/** A Platform stand-in on a real WebSocket server that records every frame it receives. */
async function fakeRelay(onFrame: (frame: any, socket: WsSocket) => void) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const frames: any[] = [];
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      onFrame(frame, socket);
    }),
  );
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('JoinClient through the Platform relay', () => {
  // fails-when: the {apiKey, role} auth shape remains (an independently authored schema refuses it).
  it('authenticates with the auth.request the Platform accepts', async () => {
    const relay = await fakeRelay((frame, socket) => {
      if (frame.type === 'auth.request') {
        socket.send(JSON.stringify({ type: 'auth.failure', reason: 'nope' }));
      }
    });
    try {
      const { token } = makeToken();
      await expect(
        new JoinClient({ token, platformUrl: relay.url, apiKey: 'api-key-1' }).join(),
      ).rejects.toThrow('Platform auth failed: nope');
      expect(authRequestSchema.safeParse(relay.frames[0]).success).toBe(true);
      expect(relay.frames[0]).toMatchObject({
        token: 'api-key-1',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { orchRole: 'worker' },
      });
    } finally {
      await relay.close();
    }
  });

  // fails-when: the request carries the token or its hash, or the client retries with v1.
  it('sends no secret and does not fall back after join_protocol_unsupported', async () => {
    const relay = await fakeRelay((frame, socket) => {
      if (frame.type === 'auth.request') socket.send(JSON.stringify({ type: 'auth.success' }));
      if (frame.type === 'join.request') {
        socket.send(
          JSON.stringify(
            buildJoinRefusal(undefined, JoinErrorCode.enum.join_protocol_unsupported, 'old'),
          ),
        );
      }
    });
    try {
      const { token, secretHex, tokenHash } = makeToken();
      await expect(
        new JoinClient({ token, platformUrl: relay.url, apiKey: 'k' }).join(),
      ).rejects.toThrow(JOIN_PROTOCOL_UNSUPPORTED_MESSAGE);
      const wire = JSON.stringify(relay.frames);
      expect(wire).not.toContain(secretHex);
      expect(wire).not.toContain(tokenHash.toString('hex'));
      expect(relay.frames).toHaveLength(2);
      expect('token' in relay.frames[1]).toBe(false);
      expect(joinRequestSchema.safeParse(relay.frames[1]).success).toBe(true);
    } finally {
      await relay.close();
    }
  });

  // fails-when: the join timer is not cleared, so the process waits out 30 s.
  it('clears its join timer once the join completes', async () => {
    const { token, tokenHash } = makeToken();
    const relay = await fakeRelay((frame, socket) => {
      if (frame.type === 'auth.request') socket.send(JSON.stringify({ type: 'auth.success' }));
      if (frame.type === 'join.request') socket.send(JSON.stringify(answerFor(tokenHash, frame)));
    });
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-relay-'));
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await new JoinClient({
        token,
        platformUrl: relay.url,
        apiKey: 'k',
        envFilePath: join(dir, 'relay.env'),
      }).join();
      const index = setSpy.mock.calls.findIndex(([, delay]) => delay === JOIN_TIMEOUT_MS);
      expect(index).toBeGreaterThanOrEqual(0);
      const handle = setSpy.mock.results[index].value;
      expect(clearSpy).toHaveBeenCalledWith(handle);
      expect(await readFile(join(dir, 'relay.env'), 'utf-8')).toContain(
        `KICI_SECRET_KEY=${'c'.repeat(64)}`,
      );
    } finally {
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the close code and reason when the Platform closes before auth', async () => {
    const relay = await fakeRelay((frame, socket) => {
      if (frame.type === 'auth.request') socket.close(4008, 'Plan limit: maximum 5 orchestrators');
    });
    try {
      const { token } = makeToken();
      const err = await new JoinClient({ token, platformUrl: relay.url, apiKey: 'k' })
        .join()
        .catch((e: Error) => e);
      expect(String(err)).toContain('4008');
      expect(String(err)).toContain('Plan limit');
    } finally {
      await relay.close();
    }
  });

  it('fails at once when the socket closes after auth, before the join response', async () => {
    const relay = await fakeRelay((frame, socket) => {
      if (frame.type === 'auth.request') socket.send(JSON.stringify({ type: 'auth.success' }));
      if (frame.type === 'join.request') socket.close(1011, 'gone');
    });
    try {
      const { token } = makeToken();
      const started = Date.now();
      await expect(
        new JoinClient({ token, platformUrl: relay.url, apiKey: 'k' }).join(),
      ).rejects.toThrow(/before the join response/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await relay.close();
    }
  }, 5_000);
});

describe('JoinClient directly to a peer', () => {
  function mockFetch(status: number, body: unknown) {
    const fn = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('posts the v2 request to the join endpoint', async () => {
    const fn = mockFetch(401, buildJoinRefusal(undefined, JoinErrorCode.enum.invalid_token, 'x'));
    const { token } = makeToken();
    await expect(
      new JoinClient({ token, peerUrl: 'https://orch-1:8080' }).join(),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledWith(
      'https://orch-1:8080/api/v1/cluster/join',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    );
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(joinRequestSchema.safeParse(body).success).toBe(true);
    expect('token' in body).toBe(false);
  });

  it('names an orchestrator that predates join protocol v2, without a fallback', async () => {
    const fn = mockFetch(400, { type: 'join.response', success: false, error: 'Missing token' });
    const { token } = makeToken();
    await expect(new JoinClient({ token, peerUrl: 'https://old:8080' }).join()).rejects.toThrow(
      /https:\/\/old:8080 predates join protocol v2/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal with its message and code', async () => {
    mockFetch(
      401,
      buildJoinRefusal(undefined, JoinErrorCode.enum.invalid_token, 'Invalid join token'),
    );
    const { token } = makeToken();
    await expect(new JoinClient({ token, peerUrl: 'https://orch-1:8080' }).join()).rejects.toThrow(
      'Join rejected: Invalid join token (invalid_token)',
    );
  });

  // fails-when: the client opens the bundle or writes the file before checking the server proof.
  it('writes nothing when the server proof is forged', async () => {
    const { token, tokenHash } = makeToken();
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-forged-'));
    const envPath = join(dir, 'forged.env');
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...answerFor(tokenHash, JSON.parse(init.body)),
        serverProof: 'a'.repeat(64),
      }),
    })) as unknown as typeof fetch;
    try {
      await expect(
        new JoinClient({ token, peerUrl: 'https://orch-1:8080', envFilePath: envPath }).join(),
      ).rejects.toThrow(SERVER_PROOF_MISMATCH_MESSAGE);
      expect(existsSync(envPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the base path of a peer URL', () => {
    expect(joinEndpointUrl('https://h/kici')).toBe('https://h/kici/api/v1/cluster/join');
    expect(joinEndpointUrl('https://h/kici/')).toBe('https://h/kici/api/v1/cluster/join');
    expect(joinEndpointUrl('https://h:8080')).toBe('https://h:8080/api/v1/cluster/join');
  });
});

describe('JoinClient constructor validation', () => {
  it('throws when neither --platform nor --peer is specified', async () => {
    const { JoinClient } = await import('./join-client.js');
    expect(() => new JoinClient({ token: 'kici_join_v1.x.y' })).toThrow(
      'Either --platform or --peer must be specified',
    );
  });

  it('throws when both --platform and --peer are specified', async () => {
    const { JoinClient } = await import('./join-client.js');
    expect(
      () =>
        new JoinClient({
          token: 'kici_join_v1.x.y',
          platformUrl: 'wss://platform',
          peerUrl: 'https://peer',
        }),
    ).toThrow('--platform and --peer are mutually exclusive');
  });
});

/**
 * Parse an env file the way systemd's `EnvironmentFile=` and
 * `docker --env-file` do: skip blanks and `#` comments, split on the first
 * `=`. Used to cross the seam between the join writer and `loadConfig()`
 * instead of asserting the writer's own output back at itself.
 */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

describe('buildEnvFile', () => {
  // fails-when: sharedConfigSchema.storage gains a field with no STORAGE_ENV_VARS
  //   entry. The join would then carry that field across the wire and drop it
  //   on the floor — silently, which is the whole defect this projection closes.
  //   The two sides are authored independently (a Zod schema vs a hand-written
  //   map), so agreement is a real claim rather than a restatement.
  it('projects every field the shared storage schema accepts', () => {
    const storageShape = (sharedConfigSchema.shape.storage.unwrap() as z.ZodObject<z.ZodRawShape>)
      .shape;

    expect(Object.keys(STORAGE_ENV_VARS).sort()).toEqual(Object.keys(storageShape).sort());
  });

  // fails-when: a variable in the projection is not one the startup path reads
  //   — the value would be written and then rejected by the boot-time
  //   unknown-KICI_* check, or accepted and ignored.
  it('names only variables the startup env definition declares', () => {
    const declared = new Set(envDef.describe().map((row) => row.envVar));

    for (const envVar of [
      'KICI_DATABASE_URL',
      'KICI_SECRET_KEY',
      ...Object.values(STORAGE_ENV_VARS),
    ]) {
      expect(declared.has(envVar), `${envVar} is not a startup variable`).toBe(true);
    }
  });

  // fails-when: nothing delivers the bundle to the boot path. Before this
  //   change no artifact reached loadConfig() with any of these three values —
  //   the YAML was ignored at startup and stripped by the one loader that read
  //   it. Asserting the emitted lines back at the writer would prove nothing.
  it('delivers the bundle to loadConfig() through the environment', () => {
    const bundle = {
      databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
      clusterId: 'cluster-1',
      storage: {
        type: 's3' as const,
        bucket: 'kici-cache',
        prefix: 'kici/',
        region: 'us-east-1',
        endpoint: 'http://s3:9000',
        externalEndpoint: 'http://s3.example:9000',
        forcePathStyle: true,
        logBucket: 'kici-logs',
      },
      secretKey: 'a'.repeat(64),
    };

    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv };
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('KICI_')) delete process.env[key];
      }
      process.env.KICI_MODE = 'independent';
      Object.assign(process.env, parseEnvFile(buildEnvFile(bundle)));

      const config = loadConfig();

      expect(config.databaseUrl).toBe(bundle.databaseUrl);
      expect(config.secretKey).toBe(bundle.secretKey);
      expect(config.storage).toMatchObject({
        type: 's3',
        bucket: 'kici-cache',
        prefix: 'kici/',
        region: 'us-east-1',
        endpoint: 'http://s3:9000',
        externalEndpoint: 'http://s3.example:9000',
        forcePathStyle: true,
        logBucket: 'kici-logs',
      });
    } finally {
      process.env = originalEnv;
    }
  });

  // breaks-if-wrong: a fresh cluster whose shared document is empty must still
  //   produce a bootable env file. An unguarded projection would emit
  //   `KICI_STORAGE_TYPE=undefined`, which is fatal at startup — the exact
  //   failure shape this change exists to remove.
  it('emits only the database URL for an empty shared document', () => {
    const content = buildEnvFile({
      databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
      clusterId: 'cluster-1',
    });

    expect(parseEnvFile(content)).toEqual({
      KICI_DATABASE_URL: 'postgresql://joiner:pw@db:5432/kici',
    });

    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv };
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('KICI_')) delete process.env[key];
      }
      process.env.KICI_MODE = 'independent';
      Object.assign(process.env, parseEnvFile(content));

      expect(() => loadConfig()).not.toThrow();
    } finally {
      process.env = originalEnv;
    }
  });

  // fails-when: a value carrying a line break is written verbatim, which
  //   truncates the file at that point and silently drops every later line.
  it('refuses a value carrying a line break', () => {
    expect(() =>
      buildEnvFile({
        databaseUrl: 'postgresql://db/kici\nKICI_SECRET_KEY=injected',
        clusterId: 'c1',
      }),
    ).toThrow(/KICI_DATABASE_URL contains a line break/);
  });
});

describe('writeEnvFile', () => {
  // fails-when: the file is written under the ambient umask (0644 by default)
  //   while carrying the cluster's master secret key and database URL.
  it('writes the env file readable by its owner only', async () => {
    const envPath = join(tmpdir(), `kici-test-join-${Date.now()}.env`);
    try {
      await writeEnvFile(envPath, {
        databaseUrl: 'postgresql://db/kici',
        clusterId: 'c1',
        secretKey: 'b'.repeat(64),
      });

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      // breaks-if-wrong: the installing user must still be able to read it back
      // and hand it to `orchestrator install --env-file`.
      expect(await readFile(envPath, 'utf-8')).toContain('KICI_DATABASE_URL=postgresql://db/kici');
    } finally {
      await unlink(envPath).catch(() => {});
    }
  });

  it('tightens a file that already existed with looser permissions', async () => {
    const envPath = join(tmpdir(), `kici-test-join-loose-${Date.now()}.env`);
    const keeperPath = `${envPath}.keeper`;
    try {
      await writeFile(envPath, 'stale\n', { encoding: 'utf-8', mode: 0o644 });
      await chmod(envPath, 0o644);
      // A second name for the same inode. If the write goes through it, the
      // database URL and the secret key land on a 0644 file and stay there
      // until a chmod behind the write catches up.
      // fails-when: writeSecretFile writes in place and chmods afterwards.
      linkSync(envPath, keeperPath);

      await writeEnvFile(envPath, { databaseUrl: 'postgresql://db/kici', clusterId: 'c1' });

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      expect(await readFile(keeperPath, 'utf-8')).toBe('stale\n');
      expect(statSync(envPath).ino).not.toBe(statSync(keeperPath).ino);
    } finally {
      await unlink(envPath).catch(() => {});
      await unlink(keeperPath).catch(() => {});
    }
  });
});

describe('JoinClient artifact', () => {
  async function runJoin(options: { envFilePath?: string }): Promise<void> {
    const { token, tokenHash } = makeToken();
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => answerFor(tokenHash, JSON.parse(init.body)),
    })) as unknown as typeof fetch;
    await new JoinClient({ token, peerUrl: 'https://orch-1:8080', ...options }).join();
  }

  // fails-when: a YAML artifact is written beside the env file again. The env
  //   file is the only artifact: it is what `orchestrator install --env-file`
  //   consumes, and no boot path ever read the YAML.
  it('writes only the env file when no artifact flag is passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-default-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await runJoin({});
      expect(existsSync(join(dir, 'kici-orchestrator.env'))).toBe(true);
      expect(existsSync(join(dir, 'kici-orchestrator.yaml'))).toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the env file where --env-file points', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-env-'));
    try {
      await runJoin({ envFilePath: join(dir, 'peer.env') });
      expect(existsSync(join(dir, 'peer.env'))).toBe(true);
      expect(await readFile(join(dir, 'peer.env'), 'utf-8')).toContain(
        'KICI_DATABASE_URL=postgresql://joiner:pw@db:5432/kici',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
