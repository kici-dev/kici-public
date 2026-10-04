import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { OrchRole } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import {
  INVALID_JOIN_TOKEN_MESSAGE,
  JOIN_TOKEN_ROUTING_CANDIDATE_CAP,
  JoinTokenManager,
  ResolvedJoinTokenStatus,
  TOKEN_ALREADY_USED_MESSAGE,
  TOKEN_EXPIRED_MESSAGE,
  parseToken,
  tokenHashOf,
} from './join-token.js';

/**
 * Real-PostgreSQL coverage for the hash-keyed join-token helpers: the routing
 * lookup over both shapes a `routing_info` row is written in, the one-time
 * claim and its race, and the role and routing a claim reads from the row.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_join_token_test_${process.pid}_${Date.now()}`;
const HOUR_MS = 3_600_000;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** Computed with node:crypto directly, independent of the module's `tokenHashOf`. */
function newSecret(): { secretHex: string; tokenHash: string } {
  const secretHex = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex');
  return { secretHex, tokenHash };
}

/** Insert a row with routing_info passed as a JSON string parameter, as a direct SQL insert does. */
async function insertStringShape(
  pool: pg.Pool,
  routing: Record<string, unknown>,
  role: string,
  expiresAt: Date,
): Promise<{ secretHex: string; tokenHash: string }> {
  const row = newSecret();
  await pool.query(
    `INSERT INTO join_tokens (id, token_hash, routing_info, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), row.tokenHash, JSON.stringify(routing), role, 'db-test', expiresAt],
  );
  return row;
}

/** Same, but the routing object handed to pg as an object (pg serialises it). */
async function insertObjectShape(
  pool: pg.Pool,
  routing: Record<string, unknown>,
  role: string,
  expiresAt: Date,
): Promise<{ secretHex: string; tokenHash: string }> {
  const row = newSecret();
  await pool.query(
    `INSERT INTO join_tokens (id, token_hash, routing_info, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), row.tokenHash, routing, role, 'db-test', expiresAt],
  );
  return row;
}

describeDb('JoinTokenManager hash-keyed helpers against Postgres', () => {
  let db: Kysely<any>;
  let pool: pg.Pool;
  let manager: JoinTokenManager;
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
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  });

  afterEach(async () => {
    await pool.query('DELETE FROM join_tokens');
  });

  const claimOf = (token: string) => {
    const { routing } = parseToken(token);
    return { orgId: routing.orgId, routingKey: routing.routingKey, expiry: routing.expiry };
  };

  // fails-when: the lookup compares routing_info as a whole (cast or ::text equality).
  // breaks-if-wrong: both real insert shapes must resolve.
  it('resolves a row written by createToken, by the string-param insert, and by the object-param insert', async () => {
    const token = await manager.createToken({
      orgId: 'org-a',
      routingKey: 'github:1',
      createdBy: 't',
    });
    const hash = tokenHashOf(parseToken(token).secretHex);
    expect(await manager.resolveLiveTokenByRouting(claimOf(token), (h) => h === hash)).toEqual({
      status: ResolvedJoinTokenStatus.enum.live,
      tokenHash: hash,
    });

    for (const insert of [insertStringShape, insertObjectShape]) {
      const routing = {
        orgId: 'org-b',
        routingKey: `github:${insert.name}`,
        expiry: Date.now() + HOUR_MS,
        role: OrchRole.enum.worker,
      };
      const row = await insert(pool, routing, OrchRole.enum.worker, new Date(routing.expiry));
      expect(await manager.resolveLiveTokenByRouting(routing, (h) => h === row.tokenHash)).toEqual({
        status: ResolvedJoinTokenStatus.enum.live,
        tokenHash: row.tokenHash,
      });
    }
  });

  // fails-when: createToken keeps a fractional --expiry-hours value in expiry; the
  //   routing lookup compares expiry as text, so it is stored as whole milliseconds.
  it('resolves a token minted with a fractional expiry', async () => {
    const token = await manager.createToken({
      orgId: 'org-a',
      routingKey: 'github:frac',
      createdBy: 't',
      expiryMs: 0.3333 * HOUR_MS + 0.37,
    });
    expect(Number.isInteger(parseToken(token).routing.expiry)).toBe(true);
    const hash = tokenHashOf(parseToken(token).secretHex);
    expect(
      (await manager.resolveLiveTokenByRouting(claimOf(token), (h) => h === hash)).status,
    ).toBe(ResolvedJoinTokenStatus.enum.live);
  });

  it('reports an accepted but expired row as expired, and consumes nothing', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:old',
      expiry: Date.now() - 1000,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    expect(await manager.resolveLiveTokenByRouting(routing, (h) => h === row.tokenHash)).toEqual({
      status: ResolvedJoinTokenStatus.enum.expired,
    });
    const { rows } = await pool.query('SELECT consumed_at FROM join_tokens WHERE token_hash = $1', [
      row.tokenHash,
    ]);
    expect(rows[0].consumed_at).toBeNull();
  });

  it('returns unknown when no candidate is accepted, and offers every candidate', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:2',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const a = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    const b = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    const offered: string[] = [];
    const result = await manager.resolveLiveTokenByRouting(routing, (h) => {
      offered.push(h);
      return false;
    });
    expect(result).toEqual({ status: ResolvedJoinTokenStatus.enum.unknown });
    expect(offered.sort()).toEqual([a.tokenHash, b.tokenHash].sort());
  });

  // fails-when: the first routing match wins regardless of the proof.
  it('picks the row the proof accepts when two rows share the routing triple', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:3',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const first = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    const wanted = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    for (const target of [first, wanted]) {
      expect(
        await manager.resolveLiveTokenByRouting(routing, (h) => h === target.tokenHash),
      ).toEqual({ status: ResolvedJoinTokenStatus.enum.live, tokenHash: target.tokenHash });
    }
  });

  // fails-when: the lookup has no candidate cap, so a flood of rows sharing one
  //   routing triple costs one HMAC per row.
  it('offers at most JOIN_TOKEN_ROUTING_CANDIDATE_CAP candidates', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:flood',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    for (let i = 0; i < JOIN_TOKEN_ROUTING_CANDIDATE_CAP + 4; i++) {
      await insertStringShape(pool, routing, OrchRole.enum.coordinator, new Date(routing.expiry));
    }
    let calls = 0;
    await manager.resolveLiveTokenByRouting(routing, () => {
      calls++;
      return false;
    });
    expect(calls).toBe(16);
  });

  // fails-when: claimByHash returns role or routing from anything but the row.
  it('claimByHash returns the role column and the stored routing', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:4',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.worker,
      new Date(routing.expiry),
    );
    const claimed = await manager.claimByHash(row.tokenHash, 'coord-A', 'peer-1');
    expect(claimed.role).toBe(OrchRole.enum.worker);
    expect(claimed.routing).toEqual({
      orgId: 'org-a',
      routingKey: 'github:4',
      expiry: routing.expiry,
      role: OrchRole.enum.worker,
    });
    expect(claimed.tokenHash).toBe(row.tokenHash);
  });

  it('claimByHash: of two concurrent claims by different instances exactly one wins', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:5',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    const settled = await Promise.allSettled([
      manager.claimByHash(row.tokenHash, 'coord-A', 'win-1'),
      manager.claimByHash(row.tokenHash, 'coord-B', 'mac-1'),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason.message).toBe(TOKEN_ALREADY_USED_MESSAGE);
  });

  it('claimByHash: same instance may reuse, a different instance may not', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:6',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    await manager.claimByHash(row.tokenHash, 'coord-A', 'peer-1');
    await expect(manager.claimByHash(row.tokenHash, 'coord-A', 'peer-1')).resolves.toMatchObject({
      role: OrchRole.enum.coordinator,
    });
    await expect(manager.claimByHash(row.tokenHash, 'coord-A', 'peer-2')).rejects.toThrow(
      TOKEN_ALREADY_USED_MESSAGE,
    );
    const { rows } = await pool.query(
      'SELECT consumed_by_instance FROM join_tokens WHERE token_hash = $1',
      [row.tokenHash],
    );
    expect(rows[0].consumed_by_instance).toBe('peer-1');
  });

  it('claimByHash: expired and unknown hashes keep their messages', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:7',
      expiry: Date.now() - 1000,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    await expect(manager.claimByHash(row.tokenHash, 'c', 'i')).rejects.toThrow(
      TOKEN_EXPIRED_MESSAGE,
    );
    await expect(manager.claimByHash('f'.repeat(64), 'c', 'i')).rejects.toThrow(
      INVALID_JOIN_TOKEN_MESSAGE,
    );
  });

  it('claimByHash: an expired token consumed by this instance is still refused as expired', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:7b',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.coordinator,
      new Date(routing.expiry),
    );
    await manager.claimByHash(row.tokenHash, 'coord-A', 'peer-1');
    await pool.query(
      `UPDATE join_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [row.tokenHash],
    );
    await expect(manager.claimByHash(row.tokenHash, 'coord-A', 'peer-1')).rejects.toThrow(
      TOKEN_EXPIRED_MESSAGE,
    );
  });

  // fails-when: validateAndConsumeToken takes the role from parseToken(token).routing.
  // breaks-if-wrong: an unedited coordinator token still claims as coordinator.
  it('validateAndConsumeToken ignores a role edited into the routing part', async () => {
    const workerToken = await manager.createToken({
      orgId: 'org-a',
      routingKey: 'github:9',
      createdBy: 't',
      role: OrchRole.enum.worker,
    });
    const [prefix, routingB64, secretHex] = workerToken.split('.');
    const routing = JSON.parse(Buffer.from(routingB64, 'base64url').toString('utf-8'));
    const edited = `${prefix}.${Buffer.from(
      JSON.stringify({ ...routing, role: OrchRole.enum.coordinator, routingKey: 'github:other' }),
    ).toString('base64url')}.${secretHex}`;
    const claimed = await manager.validateAndConsumeToken(edited, 'coord-A', 'peer-1');
    expect(claimed.role).toBe(OrchRole.enum.worker);
    expect(claimed.routing.role).toBe(OrchRole.enum.worker);
    expect(claimed.routing.routingKey).toBe('github:9');

    const coordToken = await manager.createToken({
      orgId: 'org-a',
      routingKey: 'github:10',
      createdBy: 't',
    });
    expect((await manager.validateAndConsumeToken(coordToken, 'coord-A', 'peer-2')).role).toBe(
      OrchRole.enum.coordinator,
    );
  });

  it('validateAndConsumeToken: same instance re-validates, another instance is refused, expiry wins', async () => {
    const token = await manager.createToken({
      orgId: 'org-a',
      routingKey: 'github:11',
      createdBy: 't',
      role: OrchRole.enum.worker,
    });
    await manager.validateAndConsumeToken(token, 'coord-A', 'arm-1');
    await expect(manager.validateAndConsumeToken(token, 'coord-A', 'arm-1')).resolves.toMatchObject(
      {
        role: OrchRole.enum.worker,
      },
    );
    await expect(manager.validateAndConsumeToken(token, 'coord-A', 'win-1')).rejects.toThrow(
      TOKEN_ALREADY_USED_MESSAGE,
    );
    await expect(
      manager.validateAndConsumeToken(
        `kici_join_v1.${parseToken(token).routingB64}.${'e'.repeat(64)}`,
        'coord-A',
        'arm-1',
      ),
    ).rejects.toThrow(INVALID_JOIN_TOKEN_MESSAGE);
  });

  it('readByHash returns the row role and routing, or null', async () => {
    const routing = {
      orgId: 'org-a',
      routingKey: 'github:8',
      expiry: Date.now() + HOUR_MS,
      role: OrchRole.enum.coordinator,
    };
    const row = await insertStringShape(
      pool,
      routing,
      OrchRole.enum.worker,
      new Date(routing.expiry),
    );
    expect(await manager.readByHash(row.tokenHash)).toMatchObject({
      role: OrchRole.enum.worker,
      routing: { routingKey: 'github:8', role: OrchRole.enum.worker },
    });
    expect(await manager.readByHash('0'.repeat(64))).toBeNull();
  });
});
