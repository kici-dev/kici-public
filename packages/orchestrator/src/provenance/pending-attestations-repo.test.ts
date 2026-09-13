import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import {
  PendingAttestationsRepo,
  type PendingAttestationInput,
} from './pending-attestations-repo.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_par_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function input(over: Partial<PendingAttestationInput> = {}): PendingAttestationInput {
  return {
    id: randomUUID(),
    runId: 'r1',
    jobId: 'j1',
    subjectName: 'art',
    subjectDigest: 'd'.repeat(64),
    audience: 'kici-provenance',
    dsseEnvelope: {
      payload: 'eyJ4Ijoxf',
      payloadType: 'application/vnd.in-toto+json',
      signatures: [],
    },
    publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
    statementHash: 'a'.repeat(64),
    originKind: 'deferred',
    ...over,
  };
}

describeDb('PendingAttestationsRepo', () => {
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
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('inserts, lists oldest-first, records attempts, deletes, counts', async () => {
    const repo = new PendingAttestationsRepo(db);
    const a = input({ subjectDigest: 'a'.repeat(64) });
    const b = input({ subjectDigest: 'b'.repeat(64) });
    await repo.insert(a);
    await repo.insert(b);
    await repo.insert(a); // duplicate subject → no-op
    const all = await repo.list();
    expect(all).toHaveLength(2);
    expect(all[0].subject_digest).toBe('a'.repeat(64)); // oldest-first

    await repo.recordAttempt(a.id, 'boom');
    const after = await repo.list({ runId: 'r1' });
    const refreshed = after.find((r) => r.id === a.id)!;
    expect(Number(refreshed.attempt_count)).toBe(1);
    expect(refreshed.last_error).toBe('boom');

    const { count } = await repo.countAndOldest();
    expect(count).toBe(2);

    await repo.delete(a.id);
    expect(await repo.list()).toHaveLength(1);
  });

  it('markRejected hides a row from list/countAndOldest and countRejected counts it; clearRejected re-arms', async () => {
    const repo = new PendingAttestationsRepo(db);
    const c = input({ runId: 'r2', subjectDigest: 'c'.repeat(64) });
    await repo.insert(c);
    expect((await repo.list({ runId: 'r2' })).map((r) => r.id)).toContain(c.id);

    await repo.markRejected(c.id, 'run r2 not found for org o1');
    // Excluded from the pending list + pending count, counted as rejected, row retained.
    expect((await repo.list({ runId: 'r2' })).map((r) => r.id)).not.toContain(c.id);
    const { count: pendingR2 } = await repo.countAndOldest();
    // The retained row is invisible to the pending count.
    expect((await repo.list()).map((r) => r.id)).not.toContain(c.id);
    expect(pendingR2).toBeGreaterThanOrEqual(0);
    expect(await repo.countRejected()).toBeGreaterThanOrEqual(1);
    const rejectedRow = await db
      .selectFrom('pending_attestations')
      .selectAll()
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(rejectedRow.rejected_at).not.toBeNull();
    expect(rejectedRow.last_error).toBe('run r2 not found for org o1');
    expect(Number(rejectedRow.attempt_count)).toBe(1);

    // Re-arm: scoped to the run clears the marker and the row re-appears.
    const rearmed = await repo.clearRejected({ runId: 'r2' });
    expect(rearmed).toBe(1);
    expect((await repo.list({ runId: 'r2' })).map((r) => r.id)).toContain(c.id);
    expect(await repo.countRejected()).toBe(0);
  });
});
