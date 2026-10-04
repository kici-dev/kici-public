import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { JoinErrorCode, authRequestSchema } from '@kici-dev/engine';

import { createMigrationProvider } from '../db/migration-provider.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { JoinClient } from './join-client.js';
import { JoinHandler } from './join-handler.js';
import {
  SERVER_PROOF_MISMATCH_MESSAGE,
  createJoinRequest,
  deriveJoinKeys,
  openBundle,
  requestTranscript,
  responseTranscript,
  sealBundle,
} from './join-protocol-v2.js';
import { generateEcdhKeyPair } from './peer-crypto.js';
import { JoinTokenManager, parseToken, tokenHashOf } from './join-token.js';

/**
 * The real joiner, a recording relay and the real join handler over real
 * PostgreSQL: what a relay that keeps every frame can learn, and what it can forge.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_join_v2_test_${process.pid}_${Date.now()}`;
const SECRET_KEY = 'b'.repeat(64);
const DATABASE_URL = 'postgres://joined/kici';
const HKDF_SALT = Buffer.from('kici-join-v2');

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

type Frame = Record<string, any>;

/**
 * A Platform stand-in: authenticates any auth.request the Platform schema accepts,
 * hands each join.request to the handler (after `toHandler`), and returns the
 * answer (after `toJoiner`). Records every frame in both directions.
 */
async function recordingRelay(
  handler: JoinHandler,
  opts: { toHandler?: (f: Frame) => Frame; toJoiner?: (f: Frame) => Frame } = {},
) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const frames: Frame[] = [];
  server.on('connection', (socket) => {
    const send = (frame: Frame) => {
      frames.push(frame);
      socket.send(JSON.stringify(frame));
    };
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      frames.push(frame);
      if (frame.type === 'auth.request') {
        if (authRequestSchema.safeParse(frame).success) send({ type: 'auth.success' });
        else socket.close(4002, 'Invalid auth message');
        return;
      }
      if (frame.type === 'join.request') {
        const forwarded = opts.toHandler ? opts.toHandler(frame) : frame;
        void handler.handleJoinRequest(forwarded).then((answer) => {
          send(opts.toJoiner ? opts.toJoiner(answer as Frame) : (answer as Frame));
        });
      }
    });
  });
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The response transcript, recomputed from the recorded request and response. */
function recordedT2(frames: Frame[]): Buffer {
  const request = frames.find((f) => f.type === 'join.request')!;
  const response = frames.find((f) => f.type === 'join.response')!;
  const t1 = requestTranscript(
    request.routing,
    Buffer.from(request.joinerPublicKey, 'base64'),
    Buffer.from(request.joinerNonce, 'base64'),
  );
  return responseTranscript(
    t1,
    Buffer.from(response.serverPublicKey, 'base64'),
    Buffer.from(response.serverNonce, 'base64'),
  );
}

/**
 * Every key a recorder holding the token secret, or only the frames, could try:
 * the version-1 key of the secret, the three keys of H = SHA-256(secret), and a
 * bundle key derived from each recorded base64 field.
 */
function recorderCandidateKeys(secretHex: string, frames: Frame[]): Buffer[] {
  const secret = Buffer.from(secretHex, 'hex');
  const v1 = Buffer.from(
    hkdfSync('sha256', secret, Buffer.from('kici-join-encrypt'), Buffer.from('v1'), 32),
  );
  const keys = deriveJoinKeys(Buffer.from(tokenHashOf(secretHex), 'hex'));
  const t2 = recordedT2(frames);
  const fieldKeys: Buffer[] = [];
  for (const frame of frames) {
    for (const value of Object.values(frame)) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
      fieldKeys.push(
        Buffer.from(
          hkdfSync(
            'sha256',
            Buffer.from(value, 'base64'),
            HKDF_SALT,
            Buffer.concat([Buffer.from('kici-join-v2/bundle'), t2]),
            32,
          ),
        ),
      );
    }
  }
  return [v1, keys.requestKey, keys.responseKey, keys.bindingKey, ...fieldKeys];
}

function tryOpen(encryptedBundle: string, key: Buffer, frames: Frame[]): string | null {
  try {
    return openBundle(Buffer.from(encryptedBundle, 'base64'), key, recordedT2(frames));
  } catch {
    return null;
  }
}

describeDb('join protocol v2 through a recording relay', () => {
  let db: Kysely<any>;
  let pool: pg.Pool;
  let manager: JoinTokenManager;
  let handler: JoinHandler;
  let dir: string;
  let envPath: string;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    manager = new JoinTokenManager({ db });
    handler = new JoinHandler({
      db,
      sharedConfigStore: {
        getLatest: async () => ({
          config: { storage: { type: 's3', bucket: 'b' }, secrets: { key: SECRET_KEY } },
          version: 1,
        }),
      } as never,
      clusterIdentity: { getClusterId: async () => 'cluster-1' } as never,
      databaseUrl: DATABASE_URL,
    });
    dir = await mkdtemp(join(tmpdir(), 'kici-join-v2-'));
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await db?.destroy();
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  });

  let envCounter = 0;
  afterEach(async () => {
    await pool.query('DELETE FROM join_tokens');
    envPath = join(dir, `joined-${++envCounter}.env`);
  });
  beforeAll(() => {
    envPath = join(dir, 'joined-0.env');
  });

  const mint = () =>
    manager.createToken({ orgId: 'org-1', routingKey: 'github:42', createdBy: 'db-test' });

  async function consumedAt(token: string): Promise<Date | null> {
    const { rows } = await pool.query('SELECT consumed_at FROM join_tokens WHERE token_hash = $1', [
      tokenHashOf(parseToken(token).secretHex),
    ]);
    return rows[0].consumed_at;
  }

  // fails-when: the request carries `token`, or the bundle key derives from the secret or H alone.
  // breaks-if-wrong: the joiner writes an env file with the cluster's database URL and secret key.
  it('a recording relay learns neither the secret nor a key that opens the bundle', async () => {
    const token = await mint();
    const { secretHex } = parseToken(token);
    const relay = await recordingRelay(handler);
    try {
      await new JoinClient({
        token,
        platformUrl: relay.url,
        apiKey: 'k',
        envFilePath: envPath,
      }).join();
    } finally {
      await relay.close();
    }
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`KICI_DATABASE_URL=${DATABASE_URL}`);
    expect(env).toContain(`KICI_SECRET_KEY=${SECRET_KEY}`);

    const wire = JSON.stringify(relay.frames);
    expect(wire).not.toContain(secretHex);
    expect(wire).not.toContain(tokenHashOf(secretHex));
    expect(relay.frames.some((f) => 'token' in f && f.type === 'join.request')).toBe(false);

    const response = relay.frames.find((f) => f.type === 'join.response')!;
    expect(response.success).toBe(true);
    const keys = recorderCandidateKeys(secretHex, relay.frames);
    expect(keys.length).toBeGreaterThan(4);
    for (const key of keys) {
      expect(tryOpen(response.encryptedBundle, key, relay.frames)).toBeNull();
    }
    // Positive control: the same opener opens a bundle sealed under one of those keys.
    const control = sealBundle('{}', keys[0], recordedT2(relay.frames)).toString('base64');
    expect(tryOpen(control, keys[0], relay.frames)).toBe('{}');
  });

  // fails-when: the proof is checked after the claim, or T1 omits the joiner key.
  // breaks-if-wrong: the same token, unmodified, then succeeds and is consumed.
  it('refuses a request whose joiner key the relay swapped, and consumes nothing', async () => {
    const token = await mint();
    const { routingB64, secretHex } = parseToken(token);
    const other = createJoinRequest({
      routingB64,
      tokenHash: Buffer.from(tokenHashOf(secretHex), 'hex'),
    });
    const relay = await recordingRelay(handler, {
      toHandler: (f) => ({ ...f, joinerPublicKey: other.fields.joinerPublicKey }),
    });
    try {
      await expect(
        new JoinClient({ token, platformUrl: relay.url, apiKey: 'k', envFilePath: envPath }).join(),
      ).rejects.toThrow(JoinErrorCode.enum.invalid_token);
    } finally {
      await relay.close();
    }
    expect(await consumedAt(token)).toBeNull();
    expect(existsSync(envPath)).toBe(false);

    const honest = await recordingRelay(handler);
    try {
      await new JoinClient({
        token,
        platformUrl: honest.url,
        apiKey: 'k',
        envFilePath: envPath,
      }).join();
    } finally {
      await honest.close();
    }
    expect(await consumedAt(token)).not.toBeNull();
  });

  // fails-when: the joiner opens the bundle before it checks the server proof.
  it('refuses a response the relay forged, and writes nothing', async () => {
    const token = await mint();
    const relay = await recordingRelay(handler, {
      toJoiner: (f) => {
        const relayKey = generateEcdhKeyPair();
        const t2 = randomBytes(32);
        return {
          ...f,
          serverPublicKey: relayKey.publicKey.toString('base64'),
          encryptedBundle: sealBundle(
            JSON.stringify({ databaseUrl: 'postgres://attacker', clusterId: 'x' }),
            randomBytes(32),
            t2,
          ).toString('base64'),
        };
      },
    });
    try {
      await expect(
        new JoinClient({ token, platformUrl: relay.url, apiKey: 'k', envFilePath: envPath }).join(),
      ).rejects.toThrow(SERVER_PROOF_MISMATCH_MESSAGE);
    } finally {
      await relay.close();
    }
    expect(existsSync(envPath)).toBe(false);
  });

  it('a replayed request gets a fresh server key, and the recorder still opens nothing', async () => {
    const token = await mint();
    const { secretHex } = parseToken(token);
    const relay = await recordingRelay(handler);
    try {
      await new JoinClient({
        token,
        platformUrl: relay.url,
        apiKey: 'k',
        envFilePath: envPath,
      }).join();
    } finally {
      await relay.close();
    }
    const request = relay.frames.find((f) => f.type === 'join.request')!;
    const first = relay.frames.find((f) => f.type === 'join.response')!;
    const replayed = (await handler.handleJoinRequest(request)) as Frame;
    expect(replayed.success).toBe(true);
    expect(replayed.serverPublicKey).not.toBe(first.serverPublicKey);
    const replayFrames = [request, replayed];
    for (const key of recorderCandidateKeys(secretHex, replayFrames)) {
      expect(tryOpen(replayed.encryptedBundle, key, replayFrames)).toBeNull();
    }
  });

  it('refuses a token with the right routing part and the wrong secret', async () => {
    const token = await mint();
    const forged = `kici_join_v1.${parseToken(token).routingB64}.${randomBytes(32).toString('hex')}`;
    const relay = await recordingRelay(handler);
    try {
      await expect(
        new JoinClient({
          token: forged,
          platformUrl: relay.url,
          apiKey: 'k',
          envFilePath: envPath,
        }).join(),
      ).rejects.toThrow(JoinErrorCode.enum.invalid_token);
    } finally {
      await relay.close();
    }
    expect(await consumedAt(token)).toBeNull();
  });

  // breaks-if-wrong: a joiner that retries its own unexpired token joins again.
  it('lets a joiner retry its own token', async () => {
    const token = await mint();
    for (let i = 0; i < 2; i++) {
      const relay = await recordingRelay(handler);
      try {
        await new JoinClient({
          token,
          platformUrl: relay.url,
          apiKey: 'k',
          envFilePath: join(dir, `retry-${i}.env`),
        }).join();
      } finally {
        await relay.close();
      }
    }
    expect(readFileSync(join(dir, 'retry-1.env'), 'utf-8')).toContain(
      `KICI_SECRET_KEY=${SECRET_KEY}`,
    );
  });
});
