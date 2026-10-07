import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import type { Database } from '../types.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';
import {
  ORG_ID_TABLES,
  ORG_ID_TABLES_NOT_LISTED,
  OrgIdSource,
  PlatformAttachment,
  groupOrgIdRows,
  listHeldOrgIds,
  readPlatformAttachment,
  withPlatformOrg,
} from './org-ids-repo.js';

const S = OrgIdSource.enum;

describe('groupOrgIdRows', () => {
  // fails-when: rows are not grouped per org, or the order depends on the query's row order
  it('groups per org, sorts org ids bytewise and sources in enum order', () => {
    expect(
      groupOrgIdRows([
        { org_id: 'org_b', source: S.secret },
        { org_id: '__default__', source: S.source },
        { org_id: 'org_b', source: S['remote-source'] },
        { org_id: 'org_b', source: S.secret },
      ]),
    ).toEqual([
      { orgId: '__default__', sources: [S.source] },
      { orgId: 'org_b', sources: [S['remote-source'], S.secret] },
    ]);
  });
});

describe('withPlatformOrg', () => {
  const orgs = [{ orgId: 'org_a', sources: [S.context] }];

  // fails-when: an attached org with no table row yet is left out (Review Focus 4)
  it('adds the attached org with the platform source when no table names it', () => {
    expect(withPlatformOrg(orgs, 'org_new')).toEqual([
      { orgId: 'org_a', sources: [S.context] },
      { orgId: 'org_new', sources: [S.platform] },
    ]);
  });

  it('puts platform first on an org the tables already name', () => {
    expect(withPlatformOrg(orgs, 'org_a')).toEqual([
      { orgId: 'org_a', sources: [S.platform, S.context] },
    ]);
  });

  // breaks-if-wrong: an unattached orchestrator's listing is returned unchanged
  it('returns the listing unchanged when no org is attached', () => {
    expect(withPlatformOrg(orgs, null)).toEqual(orgs);
  });
});

describe('readPlatformAttachment', () => {
  it('reads none without a platform client, pending before auth, attached after', () => {
    expect(readPlatformAttachment(undefined)).toEqual({
      platformAttachment: PlatformAttachment.enum.none,
      attachedOrgId: null,
    });
    // fails-when: a platform client that has not authenticated reads as `none`
    expect(readPlatformAttachment(() => undefined)).toEqual({
      platformAttachment: PlatformAttachment.enum.pending,
      attachedOrgId: null,
    });
    expect(readPlatformAttachment(() => 'org_live')).toEqual({
      platformAttachment: PlatformAttachment.enum.attached,
      attachedOrgId: 'org_live',
    });
  });
});

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_orgids_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('listHeldOrgIds (real Postgres)', () => {
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

    await db
      .insertInto('remote_sources')
      .values({ customer_id: 'org_a', routing_key: 'remote:org_a', cluster_id: null })
      .execute();
    // No customer_id: the column default files it under __default__.
    await db
      .insertInto('sources')
      .values({ provider: 'github', name: 'gh', routing_key: 'github:1', config: '{}', slug: null })
      .execute();
    const generic = {
      event_type_header: null,
      event_type_path: null,
      idempotency_key_header: null,
      idempotency_key_path: null,
      allowed_events: null,
      git_config: null,
    };
    await db
      .insertInto('generic_webhook_sources')
      .values({
        ...generic,
        customer_id: 'org_b',
        name: 'live',
        routing_key: 'generic:org_b:live',
        deleted_at: null,
      })
      .execute();
    await db
      .insertInto('generic_webhook_sources')
      .values({
        ...generic,
        customer_id: 'org_gone',
        name: 'gone',
        routing_key: 'generic:org_gone:gone',
        deleted_at: new Date(),
      })
      .execute();
    await db
      .insertInto('contexts')
      .values({
        org_id: 'org_a',
        name: 'prod',
        glob_pattern: null,
        concurrency_limit: null,
        required_reviewers: null,
        wait_timer_seconds: null,
        minimum_trust: null,
        created_by: null,
      })
      .execute();
    await db
      .insertInto('scoped_secrets')
      .values({ org_id: 'org_a', scope: 'prod', key: 'K', encrypted_value: 'x' })
      .execute();
    await db.insertInto('org_settings').values({ customer_id: 'org_c' }).execute();
    await db
      .insertInto('org_trust_policy')
      .values({
        customer_id: 'org_c',
        fork_policy: 'hold',
        approval_expiry_seconds: 3600,
        source: 'local',
      })
      .execute();
    await db
      .insertInto('org_trust_directory')
      .values({
        customer_id: 'org_e',
        identity_links: '[]',
        member_ci_trust: '{}',
        team_memberships: '{}',
      })
      .execute();
    await db
      .insertInto('workflow_registrations')
      .values({
        repo_identifier: 'acme/app',
        workflow_name: 'ci',
        lock_entry: '{}',
        trigger_types: ['push'],
        customer_id: 'org_d',
      })
      .execute();
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

  // fails-when: a listed table drops out of the UNION (its org or its source disappears),
  // or the deleted_at filter is lost (org_gone appears)
  it('lists every org id with the tables that name it', async () => {
    expect(await listHeldOrgIds(db)).toEqual([
      { orgId: '__default__', sources: [S.source] },
      { orgId: 'org_a', sources: [S['remote-source'], S.context, S.secret] },
      { orgId: 'org_b', sources: [S['generic-source']] },
      { orgId: 'org_c', sources: [S['org-settings'], S['trust-policy']] },
      { orgId: 'org_d', sources: [S.registration] },
      { orgId: 'org_e', sources: [S['trust-policy']] },
    ]);
  });

  async function orgKeyedTablesInSchema(): Promise<string[]> {
    const { rows } = await sql<{ table_name: string }>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition
         AND a.attname IN ('org_id', 'customer_id')
         AND NOT a.attisdropped`.execute(db);
    return rows.map((r) => r.table_name).sort();
  }

  // fails-when: a migration adds a table with an org_id / customer_id column and
  // nobody decides whether the listing reads it (Review Focus 5)
  it('classifies every org-keyed table in the schema', async () => {
    const inSchema = await orgKeyedTablesInSchema();
    // positive control: the catalog query sees the schema at all
    expect(inSchema).toContain('contexts');
    const listed = ORG_ID_TABLES.map((t) => t.table as string);
    const notListed = Object.keys(ORG_ID_TABLES_NOT_LISTED);
    expect(listed.filter((t) => notListed.includes(t))).toEqual([]);
    expect([...new Set([...listed, ...notListed])].sort()).toEqual(inSchema);
  });

  // The guard above is only as good as its catalog query: a table a later
  // migration adds must show up in it, or the guard can never fail.
  it('sees an org-keyed table added after the baseline', async () => {
    await sql`CREATE TABLE org_ids_drift_probe (customer_id text NOT NULL)`.execute(db);
    try {
      expect(await orgKeyedTablesInSchema()).toContain('org_ids_drift_probe');
    } finally {
      await sql`DROP TABLE org_ids_drift_probe`.execute(db);
    }
  });
});
