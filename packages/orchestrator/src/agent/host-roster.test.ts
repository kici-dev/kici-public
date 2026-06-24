import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import { deriveHostStatus, HostRosterStore, HostStatus } from './host-roster.js';
import type { LabelMatcher } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

/** An exact-match matcher, the post-compile equivalent of a plain label string. */
const exact = (value: string): LabelMatcher => ({ kind: 'exact', value });

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_roster_test_${process.pid}_${Date.now()}`;
const withDatabase = (url: string, n: string) => {
  const u = new URL(url);
  u.pathname = `/${n}`;
  return u.toString();
};

describeDb('HostRosterStore', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;
  let store: HostRosterStore;

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
    store = new HostRosterStore(db);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await sql`TRUNCATE public.host_roster`.execute(db);
  });

  it('upsert inserts then updates the same agent_id (no duplicate)', async () => {
    await store.upsert({
      agentId: 'a1',
      tokenId: null,
      lifecycleClass: 'static',
      labels: ['role:web'],
      hostname: 'web-01',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
    });
    await store.upsert({
      agentId: 'a1',
      tokenId: null,
      lifecycleClass: 'static',
      labels: ['role:web', 'gpu'],
      hostname: 'web-01',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-B',
    });
    const row = await store.get('a1');
    expect(row?.connected_instance_id).toBe('orch-B');
    expect(JSON.parse(row!.labels)).toEqual(['role:web', 'gpu']);
    expect((await store.listAll()).length).toBe(1);
  });

  it('markDisconnected nulls connected_instance_id but keeps the row', async () => {
    await store.upsert({
      agentId: 'a1',
      tokenId: null,
      lifecycleClass: 'static',
      labels: [],
      hostname: null,
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
    });
    await store.markDisconnected('a1', 'orch-A');
    const row = await store.get('a1');
    expect(row?.connected_instance_id).toBeNull();
  });

  it('markDisconnected is a no-op if a different instance now owns the row', async () => {
    await store.upsert({
      agentId: 'a1',
      tokenId: null,
      lifecycleClass: 'static',
      labels: [],
      hostname: null,
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-B',
    });
    await store.markDisconnected('a1', 'orch-A'); // stale disconnect from old instance
    expect((await store.get('a1'))?.connected_instance_id).toBe('orch-B');
  });

  it('reapEphemeralPastTtl deletes only stale ephemeral rows', async () => {
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels, last_seen)
      VALUES ('eph-old','ephemeral','[]', now() - interval '30 minutes'),
             ('eph-new','ephemeral','[]', now()),
             ('stat-old','static','[]', now() - interval '30 minutes')`.execute(db);
    const deleted = await store.reapEphemeralPastTtl(20 * 60_000);
    expect(deleted).toBe(1);
    expect(await store.get('eph-old')).toBeNull();
    expect(await store.get('eph-new')).not.toBeNull();
    expect(await store.get('stat-old')).not.toBeNull();
  });

  it('countStaticUnreachable counts only static, not-connected-past-grace rows', async () => {
    const grace = 5 * 60_000;
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels, connected_instance_id, last_seen) VALUES
      ('s-up','static','[]','orch-A', now()),
      ('s-down','static','[]', null, now() - interval '10 minutes'),
      ('s-grace','static','[]', null, now() - interval '1 minute'),
      ('e-down','ephemeral','[]', null, now() - interval '10 minutes')
    `.execute(db);
    // s-down + s-grace are both unreachable (not connected → unreachable
    // regardless of grace). s-up is ready; e-down is ephemeral (stale, not counted).
    expect(await store.countStaticUnreachable(grace)).toBe(2);
  });

  it('countStaticUnreachable returns 0 when every static host is connected + fresh', async () => {
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels, connected_instance_id, last_seen) VALUES
      ('s-up-1','static','[]','orch-A', now()),
      ('s-up-2','static','[]','orch-A', now())
    `.execute(db);
    expect(await store.countStaticUnreachable(5 * 60_000)).toBe(0);
  });

  it('declareStatic inserts a pre-declared static row (never-connected)', async () => {
    await store.declareStatic({ agentId: 'web-09', labels: ['role:web'], hostname: 'web-09' });
    const row = await store.get('web-09');
    expect(row?.lifecycle_class).toBe('static');
    expect(row?.connected_instance_id).toBeNull();
    expect(JSON.parse(row!.labels)).toEqual(['role:web']);
  });

  it('declareStatic is idempotent on agent_id (does not clobber a live row)', async () => {
    await store.upsert({
      agentId: 'web-09',
      tokenId: null,
      lifecycleClass: 'static',
      labels: ['role:web'],
      hostname: 'web-09',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
    });
    await store.declareStatic({ agentId: 'web-09', labels: [] });
    // The pre-declare must not overwrite the connected row.
    expect((await store.get('web-09'))?.connected_instance_id).toBe('orch-A');
  });

  it('removeStatic deletes the row and returns the count', async () => {
    await store.declareStatic({ agentId: 'h1', labels: ['role:db'] });
    expect(await store.removeStatic('h1')).toBe(1);
    expect(await store.get('h1')).toBeNull();
    expect(await store.removeStatic('nope')).toBe(0);
  });

  describe('reboot-pending flag', () => {
    it('set / clear / isRebootPending round-trips with the deadline', async () => {
      await store.declareStatic({ agentId: 'h1', labels: [] });
      const now = Date.now();
      await store.setRebootPending('h1', new Date(now + 600_000));
      expect(await store.isRebootPending('h1', now)).toBe(true);
      // Past the deadline ⇒ no longer pending.
      expect(await store.isRebootPending('h1', now + 700_000)).toBe(false);
      await store.clearRebootPending('h1');
      expect(await store.isRebootPending('h1', now)).toBe(false);
    });

    it('listExpiredRebootPending returns only hosts past their deadline', async () => {
      await store.declareStatic({ agentId: 'expired', labels: [] });
      await store.declareStatic({ agentId: 'live', labels: [] });
      await store.declareStatic({ agentId: 'none', labels: [] });
      const now = Date.now();
      await store.setRebootPending('expired', new Date(now - 1));
      await store.setRebootPending('live', new Date(now + 600_000));
      // 'none' never set ⇒ NULL ⇒ excluded.
      const expired = await store.listExpiredRebootPending(now);
      expect(expired).toContain('expired');
      expect(expired).not.toContain('live');
      expect(expired).not.toContain('none');
    });

    it('isRebootPending is false for a host with no flag set', async () => {
      await store.declareStatic({ agentId: 'h1', labels: [] });
      expect(await store.isRebootPending('h1', Date.now())).toBe(false);
    });
  });

  describe('findMatching', () => {
    const grace = 5 * 60_000;

    it('honors include (OR-of-AND) and exclude', async () => {
      await store.upsert({
        agentId: 'a1',
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['role:web', 'kici:os:linux'],
        hostname: 'web-01',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });
      await store.upsert({
        agentId: 'a2',
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['role:db'],
        hostname: 'db-01',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });
      await store.declareStatic({ agentId: 'a3', labels: ['role:web', 'kici:host:web-09'] });

      const web = await store.findMatching([[exact('role:web')]], [], grace);
      expect(web.map((h) => h.agentId)).toEqual(['a1', 'a3']);

      const excluded = await store.findMatching(
        [[exact('role:web')]],
        [exact('kici:host:web-09')],
        grace,
      );
      expect(excluded.map((h) => h.agentId)).toEqual(['a1']);

      const orGroups = await store.findMatching(
        [[exact('role:web')], [exact('role:db')]],
        [],
        grace,
      );
      expect(orGroups.map((h) => h.agentId)).toEqual(['a1', 'a2', 'a3']);
    });

    it('resolves glob include + regex exclude', async () => {
      const seed = async (agentId: string, labels: string[]) =>
        store.upsert({
          agentId,
          tokenId: null,
          lifecycleClass: 'static',
          labels,
          hostname: agentId,
          platform: 'linux',
          arch: 'x64',
          instanceId: 'orch-A',
        });
      await seed('box-01', ['role:web', 'kici:host:box-01']);
      await seed('box-02', ['role:web', 'kici:host:box-02']);
      await seed('web-canary', ['role:web', 'kici:host:web-canary']);

      const matched = await store.findMatching(
        [[{ kind: 'regex', source: '^kici:host:box-', flags: '' }]],
        [{ kind: 'regex', source: '-canary$', flags: '' }],
        grace,
      );
      expect(matched.map((m) => m.agentId).sort()).toEqual(['box-01', 'box-02']);
    });

    it('returns a connected fresh host as ready', async () => {
      await store.upsert({
        agentId: 'a1',
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['role:web'],
        hostname: 'web-01',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });
      const [host] = await store.findMatching([[exact('role:web')]], [], grace);
      expect(host.status).toBe(HostStatus.ready);
      expect(host.connectedInstanceId).toBe('orch-A');
      expect(host.host).toBe('web-01');
      expect(host.lifecycleClass).toBe('static');
    });

    it('returns a declared-but-absent static host as unreachable', async () => {
      await store.declareStatic({ agentId: 'web-09', labels: ['role:web'], hostname: 'web-09' });
      const [host] = await store.findMatching([[exact('role:web')]], [], grace);
      expect(host.status).toBe(HostStatus.unreachable);
      expect(host.connectedInstanceId).toBeNull();
    });

    it('returns a disconnected ephemeral host as stale', async () => {
      await store.upsert({
        agentId: 'eph-1',
        tokenId: null,
        lifecycleClass: 'ephemeral',
        labels: ['role:web'],
        hostname: 'eph-1',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });
      await store.markDisconnected('eph-1', 'orch-A');
      const [host] = await store.findMatching([[exact('role:web')]], [], grace);
      expect(host.status).toBe(HostStatus.stale);
      expect(host.lifecycleClass).toBe('ephemeral');
    });
  });

  describe('host properties + inventory', () => {
    const grace = 5 * 60_000;
    const baseUpsert = (over: Partial<Parameters<HostRosterStore['upsert']>[0]>) => ({
      agentId: 'h1',
      tokenId: null,
      lifecycleClass: 'static' as const,
      labels: ['role:db'],
      hostname: 'h1',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
      ...over,
    });

    it('upsert stores properties; a second upsert shallow-merges (agent keys win)', async () => {
      await store.upsert(baseUpsert({ properties: { region: 'eu', cores: 4 } }));
      await store.upsert(baseUpsert({ properties: { cores: 8, gpu: true } }));
      const row = await store.get('h1');
      // region preserved (operator/earlier key the second report omits), cores
      // overwritten by the second report, gpu added.
      expect(row?.host_properties).toEqual({ region: 'eu', cores: 8, gpu: true });
    });

    it('declareStatic sets properties to the provided bag (default {})', async () => {
      await store.declareStatic({
        agentId: 'd1',
        labels: ['role:db'],
        properties: { region: 'us' },
      });
      expect((await store.get('d1'))?.host_properties).toEqual({ region: 'us' });
      await store.declareStatic({ agentId: 'd2', labels: [] });
      expect((await store.get('d2'))?.host_properties).toEqual({});
    });

    it('findMatching exposes parsed properties on MatchedHost', async () => {
      await store.upsert(baseUpsert({ properties: { region: 'eu', cores: 8 } }));
      const [host] = await store.findMatching([[exact('role:db')]], [], grace);
      expect(host.properties).toEqual({ region: 'eu', cores: 8 });
    });

    it('queryInventory(undefined) returns every host as a HostInventoryEntry', async () => {
      await store.upsert(baseUpsert({ agentId: 'inv-a', properties: { region: 'eu' } }));
      await store.declareStatic({ agentId: 'inv-b', labels: ['role:web'] });
      const all = await store.queryInventory(undefined, grace);
      expect(all.map((h) => h.agentId).sort()).toEqual(['inv-a', 'inv-b']);
      const a = all.find((h) => h.agentId === 'inv-a')!;
      expect(a.properties).toEqual({ region: 'eu' });
      expect(a.labels).toEqual(['role:db']);
      expect(a.status).toBe(HostStatus.ready);
      expect(a.lifecycleClass).toBe('static');
      expect(typeof a.lastSeen).toBe('string');
      const b = all.find((h) => h.agentId === 'inv-b')!;
      expect(b.status).toBe(HostStatus.unreachable);
    });

    it('queryInventory(selector) filters by label', async () => {
      await store.upsert(baseUpsert({ agentId: 'db-1', labels: ['role:db'] }));
      await store.upsert(baseUpsert({ agentId: 'web-1', labels: ['role:web'] }));
      const dbs = await store.queryInventory({ include: [[exact('role:db')]] }, grace);
      expect(dbs.map((h) => h.agentId)).toEqual(['db-1']);
    });

    it('getInventory returns the entry or null', async () => {
      await store.upsert(baseUpsert({ agentId: 'g1', properties: { gpu: true } }));
      const entry = await store.getInventory('g1', grace);
      expect(entry?.agentId).toBe('g1');
      expect(entry?.properties).toEqual({ gpu: true });
      expect(await store.getInventory('missing', grace)).toBeNull();
    });
  });
});

// deriveHostStatus is a pure function — test it without a DB.
describe('deriveHostStatus', () => {
  const grace = 5 * 60_000;
  const row = (
    over: Partial<{ connected: string | null; lc: 'static' | 'ephemeral'; ageMs: number }>,
  ) =>
    ({
      connected_instance_id: over.connected ?? null,
      lifecycle_class: over.lc ?? 'static',
      last_seen: new Date(Date.now() - (over.ageMs ?? 0)),
    }) as Parameters<typeof deriveHostStatus>[0];

  it('connected + fresh → ready', () => {
    expect(deriveHostStatus(row({ connected: 'orch-A', ageMs: 0 }), Date.now(), grace)).toBe(
      HostStatus.ready,
    );
  });
  it('connected but last_seen stale (crashed instance) → NOT ready', () => {
    expect(
      deriveHostStatus(
        row({ connected: 'orch-A', lc: 'static', ageMs: 10 * 60_000 }),
        Date.now(),
        grace,
      ),
    ).toBe(HostStatus.unreachable);
  });
  it('REGRESSION: static, not connected, WITHIN grace → unreachable, never ready', () => {
    expect(
      deriveHostStatus(row({ connected: null, lc: 'static', ageMs: 60_000 }), Date.now(), grace),
    ).toBe(HostStatus.unreachable);
  });
  it('declared-but-never-connected static → unreachable, never ready', () => {
    expect(
      deriveHostStatus(row({ connected: null, lc: 'static', ageMs: 0 }), Date.now(), grace),
    ).toBe(HostStatus.unreachable);
  });
  it('ephemeral, not connected → stale', () => {
    expect(
      deriveHostStatus(row({ connected: null, lc: 'ephemeral', ageMs: 0 }), Date.now(), grace),
    ).toBe(HostStatus.stale);
  });
});
