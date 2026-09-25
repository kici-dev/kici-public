import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import type { Database } from '../types.js';
import {
  ACTIVE_SIGNING_KEY_LOCK,
  OrchestratorSigningKeyRepo,
  type UpsertActiveInput,
} from './signing-keys-repo.js';
import { SigningKeyStatus } from '../../oidc/signing-key-status.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_skr_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function input(kid: string, over: Partial<UpsertActiveInput> = {}): UpsertActiveInput {
  return {
    kid,
    public_jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', alg: 'ES256', use: 'sig', kid },
    encrypted_private_jwk: `enc-${kid}`,
    alg: 'ES256',
    signer_kind: 'db',
    key_ref: null,
    ...over,
  };
}

describeDb('OrchestratorSigningKeyRepo', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('activate → rotate demotes prior active to retiring; listTrusted returns both oldest-first', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    expect(await repo.upsertActive(input('kid-1'))).toBe(true);
    expect((await repo.getActiveRow())?.kid).toBe('kid-1');

    expect(await repo.upsertActive(input('kid-2'))).toBe(true);
    const active = await repo.getActiveRow();
    expect(active?.kid).toBe('kid-2');

    const trusted = await repo.listTrusted();
    expect(trusted.map((r) => r.kid)).toEqual(['kid-1', 'kid-2']);
    expect(trusted.find((r) => r.kid === 'kid-1')?.status).toBe('retiring');
    expect(trusted.find((r) => r.kid === 'kid-2')?.status).toBe('active');
    // db custody persists the wrapped private half
    expect(trusted.find((r) => r.kid === 'kid-2')?.encrypted_private_jwk).toBe('enc-kid-2');
  });

  it('re-activating the same active kid is a no-op', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-a'));
    expect(await repo.upsertActive(input('kid-a'))).toBe(false);
  });

  it('revoke removes a kid from listTrusted and refuses reactivation', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-x'));
    await repo.revoke('kid-x', 'compromised');
    const trusted = await repo.listTrusted();
    expect(trusted.map((r) => r.kid)).not.toContain('kid-x');
    await expect(repo.upsertActive(input('kid-x'))).rejects.toThrow(/revoked/);
  });

  it('retire moves a retiring key to retired (still trusted)', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-r1'));
    await repo.upsertActive(input('kid-r2')); // demotes r1 → retiring
    await repo.retire('kid-r1');
    const trusted = await repo.listTrusted();
    expect(trusted.find((r) => r.kid === 'kid-r1')?.status).toBe('retired');
  });

  describe('activateIfCurrent', () => {
    beforeEach(async () => {
      await db.deleteFrom('orchestrator_signing_keys').execute();
    });

    async function activeKids(): Promise<string[]> {
      const rows = await db
        .selectFrom('orchestrator_signing_keys')
        .select('kid')
        .where('status', '=', SigningKeyStatus.enum.active)
        .execute();
      return rows.map((r) => r.kid);
    }

    /**
     * Hold the active-key lock from a separate connection, insert an active row
     * inside that transaction, and return a commit handle. A writer that honours
     * the lock blocks until the commit and then sees the row; a writer that does
     * not runs straight through and cannot see the uncommitted row.
     */
    async function holdLockWithUncommittedActive(kid: string): Promise<() => Promise<void>> {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ACTIVE_SIGNING_KEY_LOCK]);
      await client.query(
        `INSERT INTO orchestrator_signing_keys
           (kid, public_jwk, encrypted_private_jwk, alg, signer_kind, key_ref, status, activated_at)
         VALUES ($1, $2, $3, 'ES256', 'db', NULL, $4, now())`,
        [kid, JSON.stringify({ kid }), `enc-${kid}`, SigningKeyStatus.enum.active],
      );
      return async () => {
        await client.query('COMMIT');
        client.release();
      };
    }

    it('activates the new key when none is active and the caller expected none', async () => {
      const repo = new OrchestratorSigningKeyRepo(db);
      const outcome = await repo.activateIfCurrent(null, input('kid-new'));
      expect(outcome.activated).toBe(true);
      expect(outcome.active?.kid).toBe('kid-new');
      expect(outcome.active?.encrypted_private_jwk).toBe('enc-kid-new');
      expect(await activeKids()).toEqual(['kid-new']);
    });

    it('returns the current active row instead of replacing it when the expectation is stale', async () => {
      // breaks-if-wrong: a node that read "no key" and lost the race must be handed
      // the winner's row, not a second active key of its own.
      const repo = new OrchestratorSigningKeyRepo(db);
      await repo.activateIfCurrent(null, input('kid-winner'));
      const outcome = await repo.activateIfCurrent(null, input('kid-loser'));
      expect(outcome.activated).toBe(false);
      expect(outcome.active?.kid).toBe('kid-winner');
      expect(outcome.active?.encrypted_private_jwk).toBe('enc-kid-winner');
      expect(await activeKids()).toEqual(['kid-winner']);
      const loser = await db
        .selectFrom('orchestrator_signing_keys')
        .select('kid')
        .where('kid', '=', 'kid-loser')
        .executeTakeFirst();
      expect(loser).toBeUndefined();
    });

    it('replaces the expected active key, demoting it to retiring', async () => {
      // breaks-if-wrong: the status guard on the demote must still let a custody
      // switch demote the active key it read.
      const repo = new OrchestratorSigningKeyRepo(db);
      await repo.activateIfCurrent(null, input('kid-external', { encrypted_private_jwk: null }));
      const outcome = await repo.activateIfCurrent('kid-external', input('kid-db'));
      expect(outcome.activated).toBe(true);
      expect(await activeKids()).toEqual(['kid-db']);
      const demoted = await db
        .selectFrom('orchestrator_signing_keys')
        .select('status')
        .where('kid', '=', 'kid-external')
        .executeTakeFirstOrThrow();
      expect(demoted.status).toBe(SigningKeyStatus.enum.retiring);
    });

    it('waits on the active-key lock and sees a key another writer activated meanwhile', async () => {
      // fails-when: activateIfCurrent reads without taking the lock — the read
      // cannot see the uncommitted row, so it inserts its own key and the table
      // ends with two active rows.
      const repo = new OrchestratorSigningKeyRepo(db);
      const commit = await holdLockWithUncommittedActive('kid-concurrent');
      const pending = repo.activateIfCurrent(null, input('kid-late'));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      const settledBeforeCommit = settled;
      await commit();
      expect(settledBeforeCommit).toBe(false);
      const outcome = await pending;
      expect(outcome.activated).toBe(false);
      expect(outcome.active?.kid).toBe('kid-concurrent');
      expect(await activeKids()).toEqual(['kid-concurrent']);
    });

    /** Seed an active key and return a connection holding an uncommitted revoke of it. */
    async function uncommittedRevoke(
      kid: string,
      opts: { takeLock: boolean },
    ): Promise<() => Promise<void>> {
      await new OrchestratorSigningKeyRepo(db).activateIfCurrent(
        null,
        input(kid, { encrypted_private_jwk: null }),
      );
      const client = await pool.connect();
      await client.query('BEGIN');
      if (opts.takeLock) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ACTIVE_SIGNING_KEY_LOCK]);
      }
      await client.query(
        `UPDATE orchestrator_signing_keys SET status = $2, revoked_at = now() WHERE kid = $1`,
        [kid, SigningKeyStatus.enum.revoked],
      );
      return async () => {
        await client.query('COMMIT');
        client.release();
      };
    }

    async function statusOf(kid: string): Promise<string> {
      const row = await db
        .selectFrom('orchestrator_signing_keys')
        .select('status')
        .where('kid', '=', kid)
        .executeTakeFirstOrThrow();
      return row.status;
    }

    it('never demotes a key a concurrent revoke committed while the switch waited on its row', async () => {
      // A writer outside the lock revoked the key after the switch read it as
      // active. The switch's demote re-reads the row once the revoke commits.
      // fails-when: the demote matches on kid alone — it rewrites `revoked` to
      // `retiring`, which puts a compromised key back in the JWKS.
      const repo = new OrchestratorSigningKeyRepo(db);
      const commit = await uncommittedRevoke('kid-compromised', { takeLock: false });
      const pending = repo.activateIfCurrent('kid-compromised', input('kid-replacement'));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      const settledBeforeCommit = settled;
      await commit();
      // Positive control: the switch really reached the row and waited on it.
      expect(settledBeforeCommit).toBe(false);
      await pending;
      expect(await statusOf('kid-compromised')).toBe(SigningKeyStatus.enum.revoked);
      // breaks-if-wrong: the switch still activates its own key.
      expect(await activeKids()).toEqual(['kid-replacement']);
    });

    it('a switch queued behind a locked revoke activates nothing and leaves the key revoked', async () => {
      // The revoke holds the active-key lock, as repo.revoke does.
      // fails-when: the switch reads the active row before taking the lock — it
      // still sees the key as active and activates a replacement.
      const repo = new OrchestratorSigningKeyRepo(db);
      const commit = await uncommittedRevoke('kid-revoked-first', { takeLock: true });
      const pending = repo.activateIfCurrent('kid-revoked-first', input('kid-after-revoke'));
      await new Promise((r) => setTimeout(r, 300));
      await commit();
      const outcome = await pending;
      expect(outcome).toEqual({ activated: false, active: null });
      expect(await statusOf('kid-revoked-first')).toBe(SigningKeyStatus.enum.revoked);
      expect(await activeKids()).toEqual([]);
    });

    it('revoke waits on the active-key lock and revokes a key activated meanwhile', async () => {
      // fails-when: revoke runs outside the lock — its UPDATE cannot see the
      // uncommitted row, revokes nothing, and the key stays active.
      const repo = new OrchestratorSigningKeyRepo(db);
      const commit = await holdLockWithUncommittedActive('kid-to-revoke');
      const revoking = repo.revoke('kid-to-revoke', 'compromised');
      let settled = false;
      void revoking.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      const settledBeforeCommit = settled;
      await commit();
      expect(settledBeforeCommit).toBe(false);
      await revoking;
      expect(await statusOf('kid-to-revoke')).toBe(SigningKeyStatus.enum.revoked);
      expect(await activeKids()).toEqual([]);
    });

    it('upsertActive takes the same lock, so a rotation never leaves two active keys', async () => {
      // fails-when: upsertActive skips the lock — its demote cannot see the
      // uncommitted row, so both keys end active after the commit.
      const repo = new OrchestratorSigningKeyRepo(db);
      const commit = await holdLockWithUncommittedActive('kid-created');
      const rotation = repo.upsertActive(input('kid-rotated'));
      await new Promise((r) => setTimeout(r, 300));
      await commit();
      expect(await rotation).toBe(true);
      expect(await activeKids()).toEqual(['kid-rotated']);
      const demoted = await db
        .selectFrom('orchestrator_signing_keys')
        .select('status')
        .where('kid', '=', 'kid-created')
        .executeTakeFirstOrThrow();
      expect(demoted.status).toBe(SigningKeyStatus.enum.retiring);
    });
  });
});
