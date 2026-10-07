import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import {
  PeerCredentialIssuance,
  PeerCredentialStore,
  RETIRED_BY_INSTANCE_KEY,
  readCredentialFile,
} from './peer-credentials.js';
import { PeerAuthCoordinator } from './peer-auth-coordinator.js';
import {
  COORDINATOR_CREDENTIAL_REVOKED_MESSAGE,
  CoordinatorCredentialOutcome as Outcome,
  RejectionCorroboration,
  coordinatorRejectionCorroborator,
  coordinatorSelfIssuer,
  ensureCoordinatorCredential,
} from './coordinator-credential.js';

/**
 * Real-PostgreSQL coverage for a coordinator's own peer credential: every
 * branch of the reconciliation between `peer_credentials` and the credential
 * file, and the retirement of the previous run's self-issued row.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_coord_cred_test_${process.pid}_${Date.now()}`;
const INSTANCE = 'coord-a';
const PREVIOUS = 'coord-a-previous-boot';
const DAY_MS = 24 * 60 * 60 * 1000;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** Computed with node:crypto directly, independent of the module's `sha256` helper. */
function hashOf(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

describeDb('ensureCoordinatorCredential against Postgres', () => {
  let db: Kysely<any>;
  let pool: pg.Pool;
  let store: PeerCredentialStore;
  let dir: string;
  let file: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    store = new PeerCredentialStore(db);
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
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('peer_credentials').execute();
    await db.deleteFrom('cluster_instances').execute();
    dir = await mkdtemp(join(tmpdir(), 'kici-coord-cred-'));
    file = join(dir, 'kici', 'peer-credential');
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (
    o: {
      instanceId?: string;
      credentialFile?: string;
      live?: (id: string) => Promise<boolean>;
    } = {},
  ) =>
    ensureCoordinatorCredential({
      store,
      credentialFile: o.credentialFile ?? file,
      instanceId: o.instanceId ?? INSTANCE,
      isInstanceLive: o.live ?? (async () => false),
      logger,
    });

  async function unrevokedRows(instanceId = INSTANCE) {
    return db
      .selectFrom('peer_credentials')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  describe('coordinatorRejectionCorroborator', () => {
    it('holds the file credential valid until the row is revoked', async () => {
      expect(await run()).toBe(Outcome.Issued);
      const written = await readCredentialFile(file);
      const corroborate = coordinatorRejectionCorroborator({ db, instanceId: INSTANCE, logger });
      // fails-when: the check ignores the row and lets any rejection delete the file
      expect(await corroborate(written!.credential)).toBe(RejectionCorroboration.HeldValid);
      expect(await corroborate('not-the-credential')).toBe(RejectionCorroboration.NotHeld);
      await store.revoke(INSTANCE);
      // breaks-if-wrong: an operator revoke must still let the file go
      expect(await corroborate(written!.credential)).toBe(RejectionCorroboration.NotHeld);
    });

    it('does not hold an expired row valid', async () => {
      expect(await run()).toBe(Outcome.Issued);
      const written = await readCredentialFile(file);
      await sql`UPDATE peer_credentials SET expires_at = now() - interval '1 minute'`.execute(db);
      const corroborate = coordinatorRejectionCorroborator({ db, instanceId: INSTANCE, logger });
      expect(await corroborate(written!.credential)).toBe(RejectionCorroboration.NotHeld);
    });

    it('reports an unreadable database', async () => {
      const broken = new Kysely<any>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({
            connectionString: withDatabase(adminUrl, 'kici_no_such_database_for_corroboration'),
          }),
        }),
      });
      try {
        const corroborate = coordinatorRejectionCorroborator({
          db: broken,
          instanceId: INSTANCE,
          logger,
        });
        expect(await corroborate('anything')).toBe(RejectionCorroboration.Unreadable);
        expect(logger.warn).toHaveBeenCalled();
      } finally {
        await broken.destroy();
      }
    });
  });

  describe('store primitives', () => {
    it('findUnrevokedByInstanceId returns an expired unrevoked row', async () => {
      await store.save({
        instanceId: INSTANCE,
        credentialHash: 'a'.repeat(64),
        role: 'coordinator',
        routingKeys: [],
      });
      await sql`UPDATE peer_credentials SET expires_at = now() - interval '1 minute'`.execute(db);
      expect((await store.findUnrevokedByInstanceId(INSTANCE))?.credentialHash).toBe(
        'a'.repeat(64),
      );
      expect(await store.findByInstanceId(INSTANCE)).toBeNull();
    });

    /** Issue credential 'a', replace it with 'b', then revoke 'b'. */
    async function saveTwoThenRevoke(): Promise<void> {
      for (const h of ['a', 'b']) {
        await store.save({
          instanceId: INSTANCE,
          credentialHash: h.repeat(64),
          role: 'coordinator',
          routingKeys: [],
        });
      }
      await store.revoke(INSTANCE);
    }

    it('findLatestRevokedByInstanceId returns the newest revoked row, or null', async () => {
      expect(await store.findLatestRevokedByInstanceId(INSTANCE)).toBeNull();
      await saveTwoThenRevoke();
      expect((await store.findLatestRevokedByInstanceId(INSTANCE))?.credentialHash).toBe(
        'b'.repeat(64),
      );
    });

    // fails-when: rows revoked in the same millisecond come back in arbitrary order
    it('findLatestRevokedByInstanceId breaks a revoked_at tie by the newer credential', async () => {
      await saveTwoThenRevoke();
      await sql`UPDATE peer_credentials SET revoked_at = now()`.execute(db);
      expect((await store.findLatestRevokedByInstanceId(INSTANCE))?.credentialHash).toBe(
        'b'.repeat(64),
      );
    });

    it('save records metadata, and a row without it reads as {}', async () => {
      await store.save({
        instanceId: INSTANCE,
        credentialHash: 'a'.repeat(64),
        role: 'coordinator',
        routingKeys: [],
        metadata: { issuance: PeerCredentialIssuance.Self },
      });
      await store.save({
        instanceId: PREVIOUS,
        credentialHash: 'b'.repeat(64),
        role: 'coordinator',
        routingKeys: [],
      });
      expect((await store.findByInstanceId(INSTANCE))?.metadata).toEqual({ issuance: 'self' });
      expect((await store.findByInstanceId(PREVIOUS))?.metadata).toEqual({});
    });
  });

  // fails-when: nothing writes a row for a tokenless coordinator (the defect),
  // or the mint hashes a string other than the one the proof uses.
  it('issues a self-issued credential when the instance has none', async () => {
    expect(await run()).toBe(Outcome.Issued);

    const data = await readCredentialFile(file);
    expect(data).toMatchObject({ instanceId: INSTANCE, role: 'coordinator' });
    expect(data!.credential).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const rows = await unrevokedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_hash).toBe(hashOf(data!.credential));
    expect(rows[0].role).toBe('coordinator');
    expect(rows[0].metadata).toEqual({ issuance: 'self' });
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  // breaks-if-wrong: the issued file must be usable by the auth path as is.
  it('lets a fresh auth coordinator prove with the issued credential', async () => {
    await run();
    const decision = await new PeerAuthCoordinator({
      credentialFile: file,
      instanceId: INSTANCE,
    }).decideAuth();
    expect(decision.mode).toBe('credential');
    if (decision.mode !== 'credential') return;
    const [row] = await unrevokedRows();
    expect(hashOf(decision.credential.credential)).toBe(row.credential_hash);
  });

  it('is a no-op when the file matches the unrevoked row', async () => {
    await run();
    const [before] = await unrevokedRows();
    const fileBefore = await readFile(file, 'utf-8');
    expect(await run()).toBe(Outcome.Valid);
    const [after] = await unrevokedRows();
    expect(after.id).toBe(before.id);
    expect(await readFile(file, 'utf-8')).toBe(fileBefore);
  });

  // fails-when: "revoked" is derived from the newest row being revoked, so the
  // supersede that replaces a lost file reads as an operator revoke.
  it('replaces a credential whose file is missing, and the next run reads it as valid', async () => {
    await run();
    const [old] = await unrevokedRows();
    await rm(file);
    expect(await run()).toBe(Outcome.Replaced);
    const rows = await unrevokedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(old.id);
    expect(rows[0].credential_hash).toBe(hashOf((await readCredentialFile(file))!.credential));
    expect(await run()).toBe(Outcome.Valid);
  });

  it('replaces a credential whose file does not match the row', async () => {
    await run();
    await writeFile(
      file,
      JSON.stringify({
        instanceId: INSTANCE,
        credential: 'f'.repeat(64),
        role: 'coordinator',
        issuedAt: new Date(0).toISOString(),
      }),
    );
    expect(await run()).toBe(Outcome.Replaced);
    const [row] = await unrevokedRows();
    expect(row.credential_hash).toBe(hashOf((await readCredentialFile(file))!.credential));
  });

  it('treats a corrupt credential file as absent', async () => {
    await run();
    await writeFile(file, '{not json');
    expect(await run()).toBe(Outcome.Replaced);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unreadable peer credential file'),
      expect.objectContaining({ credentialFile: file }),
    );
  });

  it('issues again after the unrevoked row expired', async () => {
    await run();
    await sql`UPDATE peer_credentials SET expires_at = now() - interval '1 minute'`.execute(db);
    expect(await run()).toBe(Outcome.Issued);
    const live = await store.findByInstanceId(INSTANCE);
    expect(live?.credentialHash).toBe(hashOf((await readCredentialFile(file))!.credential));
  });

  // fails-when: the issuer ignores an operator revoke and re-issues.
  it('refuses to re-issue a revoked credential', async () => {
    await run();
    await rm(file);
    await store.revoke(INSTANCE);
    expect(await run()).toBe(Outcome.Revoked);
    expect(await unrevokedRows()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      COORDINATOR_CREDENTIAL_REVOKED_MESSAGE,
      expect.objectContaining({
        instanceId: INSTANCE,
        remedy: expect.stringContaining('kici-admin peer create-token --role coordinator'),
      }),
    );
  });

  it('refuses after revoke-all too', async () => {
    await run();
    await store.revokeAll();
    expect(await run()).toBe(Outcome.Revoked);
  });

  // Guard input: with the revoked-row lookup blinded, the same revoked state
  // issues — so `revoked` above depends on that lookup. A class instance cannot
  // be spread (its methods live on the prototype), so the store is wrapped.
  it('issues when no revoked row is visible (guard input)', async () => {
    await run();
    await store.revoke(INSTANCE);
    const outcome = await ensureCoordinatorCredential({
      store: {
        save: (o) => store.save(o),
        findUnrevokedByInstanceId: (id) => store.findUnrevokedByInstanceId(id),
        findLatestRevokedByInstanceId: async () => null,
        retireSelfIssued: (o) => store.retireSelfIssued(o),
      },
      credentialFile: file,
      instanceId: INSTANCE,
      isInstanceLive: async () => false,
      logger,
    });
    expect(outcome).toBe(Outcome.Issued);
  });

  // breaks-if-wrong: a prune (rows deleted) is not a revoke and must re-issue.
  it('issues after the instance rows were deleted', async () => {
    await run();
    await db.deleteFrom('peer_credentials').execute();
    expect(await run()).toBe(Outcome.Issued);
  });

  it('returns failed when the credential file cannot be written, leaving one unrevoked row', async () => {
    // An existing directory as the credential path: reading warns, writing throws EISDIR.
    expect(await run({ credentialFile: dir })).toBe(Outcome.Failed);
    expect(await unrevokedRows()).toHaveLength(1);
  });

  it('concurrent runs of one instance leave exactly one unrevoked row', async () => {
    await Promise.all([run(), run()]);
    expect(await unrevokedRows()).toHaveLength(1);
  });

  describe('retiring the previous boot', () => {
    // fails-when: the retirement reads as an operator revoke, or the revoke
    // check is not keyed by instance — the current id refuses, or the previous
    // id can never issue again.
    // breaks-if-wrong: a later operator revoke of the previous id still reads revoked.
    it("retires the previous boot's self-issued credential without blocking either id", async () => {
      await run({ instanceId: PREVIOUS });
      expect(await run()).toBe(Outcome.Issued);

      expect(await unrevokedRows(PREVIOUS)).toHaveLength(0);
      const retired = await store.findLatestRevokedByInstanceId(PREVIOUS);
      expect(retired?.metadata[RETIRED_BY_INSTANCE_KEY]).toBe(INSTANCE);
      expect(await run()).toBe(Outcome.Valid);

      const otherFile = join(dir, 'other', 'peer-credential');
      expect(await run({ instanceId: PREVIOUS, credentialFile: otherFile })).toBe(Outcome.Issued);

      await store.revoke(PREVIOUS);
      await rm(otherFile);
      expect(await run({ instanceId: PREVIOUS, credentialFile: otherFile })).toBe(Outcome.Revoked);
    });

    // fails-when: retirement ignores liveness and revokes a running sibling
    // that shares this credential file. Uses the real cluster_instances read.
    it('does not retire a live previous instance', async () => {
      await run({ instanceId: PREVIOUS });
      await db.insertInto('cluster_instances').values({ instance_id: PREVIOUS }).execute();
      const issue = coordinatorSelfIssuer({
        db,
        credentialFile: file,
        instanceId: INSTANCE,
        agentMaxReconnectDelayMs: 60_000,
        clusterInstanceHeartbeatMs: 10_000,
      });
      expect(await issue()).toBe(Outcome.Issued);
      expect(await unrevokedRows(PREVIOUS)).toHaveLength(1);
    });

    // breaks-if-wrong: a stale heartbeat reads as not live, so the row is retired.
    it('retires once the previous heartbeat is past the grace window', async () => {
      await run({ instanceId: PREVIOUS });
      await db
        .insertInto('cluster_instances')
        .values({ instance_id: PREVIOUS, last_heartbeat_at: sql`now() - interval '1 hour'` })
        .execute();
      const issue = coordinatorSelfIssuer({
        db,
        credentialFile: file,
        instanceId: INSTANCE,
        agentMaxReconnectDelayMs: 60_000,
        clusterInstanceHeartbeatMs: 10_000,
      });
      expect(await issue()).toBe(Outcome.Issued);
      expect(await unrevokedRows(PREVIOUS)).toHaveLength(0);
    });

    it('does not retire a token-issued previous credential', async () => {
      await store.save({
        instanceId: PREVIOUS,
        credentialHash: hashOf('token-issued'),
        role: 'coordinator',
        routingKeys: [],
      });
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          instanceId: PREVIOUS,
          credential: 'token-issued',
          role: 'coordinator',
          issuedAt: new Date(0).toISOString(),
        }),
      );
      expect(await run()).toBe(Outcome.Issued);
      expect(await unrevokedRows(PREVIOUS)).toHaveLength(1);
    });

    it('does not retire when the file no longer holds the previous credential', async () => {
      await run({ instanceId: PREVIOUS });
      await writeFile(
        file,
        JSON.stringify({
          instanceId: PREVIOUS,
          credential: 'e'.repeat(64),
          role: 'coordinator',
          issuedAt: new Date(0).toISOString(),
        }),
      );
      expect(await run()).toBe(Outcome.Issued);
      expect(await unrevokedRows(PREVIOUS)).toHaveLength(1);
    });
  });

  // No dial → no row: building the issuer writes nothing.
  it('coordinatorSelfIssuer writes nothing until it is called', async () => {
    const issue = coordinatorSelfIssuer({
      db,
      credentialFile: file,
      instanceId: INSTANCE,
      agentMaxReconnectDelayMs: 60_000,
      clusterInstanceHeartbeatMs: 10_000,
    });
    expect(await unrevokedRows()).toHaveLength(0);
    expect(await issue()).toBe(Outcome.Issued);
    expect(await unrevokedRows()).toHaveLength(1);
  });
});
