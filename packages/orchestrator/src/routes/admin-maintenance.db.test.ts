import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { createMaintenanceRoutes } from './admin-maintenance.js';

/**
 * Real-Postgres coverage for `POST /sources/purge-stale`: the counts a dry run
 * reports are what the purge then deletes, and a registration under an org's
 * remote source (`remote:<orgId>`) survives the purge.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_maint_purge_test_${process.pid}_${Date.now()}`;
const CURRENT_KEY = 'github:99999';
/** The routing key of org_a's remote source, a `remote_sources` row. */
const REMOTE_KEY = 'remote:org_a';
/** A remote-shaped routing key with no `remote_sources` row behind it. */
const GONE_REMOTE_KEY = 'remote:org_gone';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('POST /sources/purge-stale (real DB)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
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
  }, 120_000);

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

  /** A source row of `table` with one `__system__` secret and one registration. */
  async function seedSource(
    table: 'sources' | 'generic_webhook_sources',
    routingKey: string,
  ): Promise<void> {
    const id = randomUUID();
    if (table === 'sources') {
      await sql`INSERT INTO sources (id, provider, name, routing_key, config, customer_id)
        VALUES (${id}, 'github', ${`src-${id}`}, ${routingKey}, '{}', 'org_a')`.execute(db);
    } else {
      await sql`INSERT INTO generic_webhook_sources (id, customer_id, name, routing_key)
        VALUES (${id}, 'org_a', ${`src-${id}`}, ${routingKey})`.execute(db);
    }
    await sql`INSERT INTO scoped_secrets (org_id, scope, key, encrypted_value)
      VALUES ('__system__', ${`__source__/${id}`}, 'webhookSecret', 'sealed')`.execute(db);
    await seedRegistration(id, routingKey);
  }

  async function seedRegistration(workflowName: string, routingKey: string): Promise<void> {
    await sql`INSERT INTO workflow_registrations
        (repo_identifier, workflow_name, lock_entry, trigger_types, routing_key, customer_id)
      VALUES ('acme/repo', ${workflowName}, '{}', ARRAY['push'], ${routingKey}, 'org_a')`.execute(
      db,
    );
  }

  async function registrationKeys(): Promise<string[]> {
    const rows = await sql<{ routing_key: string }>`
      SELECT routing_key FROM workflow_registrations ORDER BY routing_key
    `.execute(db);
    return rows.rows.map((r) => r.routing_key);
  }

  beforeEach(async () => {
    await sql`DELETE FROM workflow_registrations`.execute(db);
    await sql`DELETE FROM scoped_secrets WHERE org_id = '__system__'`.execute(db);
    await sql`DELETE FROM sources`.execute(db);
    await sql`DELETE FROM generic_webhook_sources`.execute(db);
    await sql`DELETE FROM remote_sources`.execute(db);
    await seedSource('sources', CURRENT_KEY);
    await seedSource('sources', 'github:777');
    await seedSource('generic_webhook_sources', `generic:org_a:${randomUUID()}`);
    await seedSource('generic_webhook_sources', `generic:org_a:${randomUUID()}`);
    // org_a's remote source and a registration under it, as `kici-admin workflow
    // register-manual --routing-key remote:org_a` writes one.
    await sql`INSERT INTO remote_sources (customer_id, routing_key)
      VALUES ('org_a', ${REMOTE_KEY})`.execute(db);
    await seedRegistration('under-remote-source', REMOTE_KEY);
    // The same key shape with no remote source behind it: an orphan.
    await seedRegistration('under-gone-remote-source', GONE_REMOTE_KEY);
  });

  async function purge(dryRun: boolean): Promise<Record<string, unknown>> {
    const app = createMaintenanceRoutes({ db });
    const res = await app.request('/sources/purge-stale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routingKey: CURRENT_KEY, dryRun }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('counts in a dry run exactly what the purge then deletes', async () => {
    const planned = await purge(true);
    const done = await purge(false);

    // fails-when: the dry run skips the generic sources' registrations the purge deletes,
    // or counts the remote source's registration the purge keeps
    expect(planned).toEqual({
      dryRun: true,
      staleSecrets: done.secretsDeleted,
      staleSources: done.sourcesDeleted,
      genericSources: done.genericDeleted,
      orphanRegistrations: done.registrationsDeleted,
    });
    // Every source fixture but the current routing key's is purged, two of them
    // generic, and so is the registration under the gone remote source.
    expect(done).toEqual({
      secretsDeleted: 3,
      sourcesDeleted: 1,
      genericDeleted: 2,
      registrationsDeleted: 4,
    });
  });

  it("keeps a registration under an org's remote source and deletes one under no source", async () => {
    await purge(false);

    // fails-when: the purge treats a `remote:<orgId>` registration as orphaned
    // because its source row lives in remote_sources, not sources
    // breaks-if-wrong: a `remote:` registration with no remote_sources row behind it
    // must still be deleted, so the exclusion keys on the row, not the prefix
    expect(await registrationKeys()).toEqual([CURRENT_KEY, REMOTE_KEY]);
    const remote = await sql<{ routing_key: string }>`
      SELECT routing_key FROM remote_sources
    `.execute(db);
    expect(remote.rows.map((r) => r.routing_key)).toEqual([REMOTE_KEY]);
  });
});
