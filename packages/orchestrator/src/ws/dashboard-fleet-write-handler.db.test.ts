import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { FleetHostWriteRefusal } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { HostRosterStore, HostWriteAuthority, parseHostProperties } from '../agent/host-roster.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { DashboardFleetWriteHandler } from './dashboard-fleet-write-handler.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * The fleet write handler against the real roster store: the seam the mocked
 * handler test does not cross. Proves the handler's no-authority call lands on
 * the store's Platform default. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_fleet_write_test_${process.pid}_${Date.now()}`;
const ACTOR = { type: 'user', id: 'u-1', sub: 'sub-1' } as const;

describeDb('DashboardFleetWriteHandler against the real roster store', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let store: HostRosterStore;
  let sent: Array<Record<string, unknown>>;
  let record: ReturnType<typeof vi.fn>;
  let handler: DashboardFleetWriteHandler;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${TEST_DB}`;
    pool = new pg.Pool({ connectionString: u.toString() });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    store = new HostRosterStore(db);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await sql`TRUNCATE public.host_roster`.execute(db);
    sent = [];
    record = vi.fn().mockResolvedValue(undefined);
    // No bound org ⇒ the dashboard-write policy gate is open; the store decides.
    handler = new DashboardFleetWriteHandler({
      db,
      rosterStore: store,
      send: (m) => sent.push(m as Record<string, unknown>),
      accessLog: { record } as unknown as AccessLogWriter,
      orgId: null,
    });
  });

  const declare = (agentId: string, extra: Record<string, unknown> = {}) =>
    handler.handleMessage({
      type: 'dashboard.fleet.host.declare',
      requestId: `d-${agentId}`,
      actor: ACTOR,
      agentId,
      ...extra,
    } as never);
  const remove = (agentId: string) =>
    handler.handleMessage({
      type: 'dashboard.fleet.host.remove',
      requestId: `r-${agentId}`,
      actor: ACTOR,
      agentId,
    } as never);
  const deniedRow = async (code: string) => {
    await vi.waitFor(() =>
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'denied',
          errorMessage: expect.stringMatching(new RegExp(`^${code}:`)),
        }),
      ),
    );
  };

  it('refuses a reserved restart property with its keys and writes no row', async () => {
    // fails-when: the store's default authority is operator, or the handler passes operator.
    await declare('h1', {
      properties: { region: 'eu', 'kici:agent-restart-start': 'touch /tmp/pwn' },
    });
    expect(sent[0]).toMatchObject({
      error: FleetHostWriteRefusal.enum.reserved_property,
      reservedKeys: ['kici:agent-restart-start'],
    });
    expect(await store.get('h1')).toBeNull();
    await deniedRow(FleetHostWriteRefusal.enum.reserved_property);
  });

  it('refuses a rename of an existing host and leaves it unchanged', async () => {
    await store.declareStatic({
      agentId: 'h2',
      labels: ['role:db'],
      hostname: 'a',
      authority: HostWriteAuthority.operator,
    });
    await declare('h2', { labels: ['env:prod'], hostname: 'b' });
    expect(sent[0]).toMatchObject({ error: FleetHostWriteRefusal.enum.host_exists });
    const row = await store.get('h2');
    expect(row?.hostname).toBe('a');
    expect(JSON.parse(row!.labels)).toEqual(['role:db']);
    await deniedRow(FleetHostWriteRefusal.enum.host_exists);
  });

  it('refuses to remove a confirmed host', async () => {
    await store.declareStatic({ agentId: 'h3', authority: HostWriteAuthority.operator });
    await remove('h3');
    expect(sent[0]).toMatchObject({ error: FleetHostWriteRefusal.enum.host_confirmed });
    expect(await store.get('h3')).not.toBeNull();
    await deniedRow(FleetHostWriteRefusal.enum.host_confirmed);
  });

  it('creates and removes a new unconfirmed host', async () => {
    // breaks-if-wrong: the dashboard must still declare a new host and remove its own placeholder.
    await declare('h4', { properties: { region: 'eu' } });
    expect(sent[0]).toEqual({
      type: 'dashboard.fleet.host.declare.response',
      requestId: 'd-h4',
      declared: true,
      created: true,
    });
    expect(parseHostProperties((await store.get('h4'))!.host_properties)).toEqual({
      region: 'eu',
    });
    await remove('h4');
    expect(sent[1]).toMatchObject({ removed: true });
    expect(await store.get('h4')).toBeNull();
  });
});
