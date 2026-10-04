import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  deriveHostStatus,
  HostConfirmedError,
  HostExistsError,
  HostRosterStore,
  HostStatus,
  HostWriteAuthority,
  isReservedHostKey,
  parseHostProperties,
  ReservedHostKeyError,
  stripReservedProperties,
} from './host-roster.js';
import { resolveRestartSpec } from '../ws/bringup-api.js';
import type { LabelMatcher } from '@kici-dev/engine';
import { matchHostPattern } from '@kici-dev/engine/context/host-match';
import { type Database, HostIdentitySource } from '../db/types.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/** An exact-match matcher, the post-compile equivalent of a plain label string. */
const exact = (value: string): LabelMatcher => ({ kind: 'exact', value });
const OP = HostWriteAuthority.operator;

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
      await terminateTestDbBackends(admin, TEST_DB);
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

  it('upsert folds the hostname but never the agent id', async () => {
    await store.upsert({
      agentId: 'Build-Box-01',
      tokenId: null,
      lifecycleClass: 'static',
      labels: [],
      hostname: 'Build-Box-01',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
    });
    const row = await store.get('Build-Box-01');
    expect(row!.hostname).toBe('build-box-01');
    // The agent id is an opaque identifier and stays verbatim — folding it
    // would let a binding written for one agent reach another.
    expect(row!.agent_id).toBe('Build-Box-01');
  });

  it('upsert re-registration keeps the folded hostname', async () => {
    const base = {
      agentId: 'a1',
      tokenId: null,
      lifecycleClass: 'static' as const,
      labels: [],
      platform: 'linux',
      arch: 'x64',
    };
    await store.upsert({ ...base, hostname: 'Web-01', instanceId: 'orch-A' });
    await store.upsert({ ...base, hostname: 'WEB-01', instanceId: 'orch-B' });
    expect((await store.get('a1'))!.hostname).toBe('web-01');
  });

  it('upsert keeps a null hostname null', async () => {
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
    expect((await store.get('a1'))!.hostname).toBeNull();
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
    await store.declareStatic({
      authority: OP,
      agentId: 'web-09',
      labels: ['role:web'],
      hostname: 'web-09',
    });
    const row = await store.get('web-09');
    expect(row?.lifecycle_class).toBe('static');
    expect(row?.connected_instance_id).toBeNull();
    expect(JSON.parse(row!.labels)).toEqual(['role:web']);
  });

  it('declareStatic persists reach metadata (incl. s3Reachable) and getReach reads it back', async () => {
    await store.declareStatic({
      authority: OP,
      agentId: 'box-00007',
      labels: ['role:fresh'],
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 2222,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: true,
    });
    expect(await store.getReach('box-00007')).toEqual({
      agentId: 'box-00007',
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 2222,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: true,
    });
  });

  it('getReach returns nulls for a host declared without reach metadata', async () => {
    await store.declareStatic({ authority: OP, agentId: 'no-reach', labels: [] });
    expect(await store.getReach('no-reach')).toEqual({
      agentId: 'no-reach',
      address: null,
      sshUser: null,
      sshPort: null,
      sshKeySecret: null,
      s3Reachable: null,
    });
  });

  it('getReach returns null for an unknown host', async () => {
    expect(await store.getReach('does-not-exist')).toBeNull();
  });

  it('declareStatic returns created:true on insert, created:false on update', async () => {
    expect(
      (await store.declareStatic({ authority: OP, agentId: 'web-09', labels: ['role:web'] }))
        .created,
    ).toBe(true);
    expect(
      (
        await store.declareStatic({
          authority: OP,
          agentId: 'web-09',
          labels: ['role:web', 'region:eu'],
        })
      ).created,
    ).toBe(false);
  });

  it('declareStatic re-declare updates operator fields', async () => {
    await store.declareStatic({
      authority: OP,
      agentId: 'web-09',
      labels: ['role:web'],
      hostname: 'old',
    });
    await store.declareStatic({
      authority: OP,
      agentId: 'web-09',
      labels: ['role:web', 'region:eu'],
      hostname: 'new',
    });
    const row = await store.get('web-09');
    expect(JSON.parse(row!.labels)).toEqual(['role:web', 'region:eu']);
    expect(row!.hostname).toBe('new');
  });

  it('declareStatic folds the hostname on insert and on re-declare', async () => {
    await store.declareStatic({ authority: OP, agentId: 'web-09', hostname: 'Web-09.Prod' });
    expect((await store.get('web-09'))!.hostname).toBe('web-09.prod');
    await store.declareStatic({ authority: OP, agentId: 'web-09', hostname: 'WEB-09.STAGING' });
    expect((await store.get('web-09'))!.hostname).toBe('web-09.staging');
  });

  it('declareStatic re-declare preserves a live row liveness and agent identity', async () => {
    const tokenId = '11111111-1111-1111-1111-111111111111';
    await store.upsert({
      agentId: 'web-09',
      tokenId,
      lifecycleClass: 'static',
      labels: ['role:web'],
      hostname: 'web-09',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
    });
    await store.declareStatic({ authority: OP, agentId: 'web-09', labels: ['role:db'] });
    const row = await store.get('web-09');
    // Operator labels DID update...
    expect(JSON.parse(row!.labels)).toEqual(['role:db']);
    // ...but agent-reported liveness/identity survived.
    expect(row!.connected_instance_id).toBe('orch-A');
    expect(row!.platform).toBe('linux');
    expect(row!.arch).toBe('x64');
    expect(row!.token_id).toBe(tokenId);
  });

  it('declareStatic re-declare with omitted labels preserves existing labels', async () => {
    await store.declareStatic({ authority: OP, agentId: 'web-09', labels: ['role:web'] });
    await store.declareStatic({ authority: OP, agentId: 'web-09', hostname: 'h' });
    expect(JSON.parse((await store.get('web-09'))!.labels)).toEqual(['role:web']);
  });

  it('declareStatic re-declare with omitted reach preserves CLI-set reach', async () => {
    await store.declareStatic({
      authority: OP,
      agentId: 'box-7',
      labels: [],
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 2222,
      sshKeySecret: 'prod/bootstrap/ssh',
    });
    await store.declareStatic({ authority: OP, agentId: 'box-7', labels: ['role:fresh'] });
    expect(await store.getReach('box-7')).toEqual({
      agentId: 'box-7',
      address: '10.0.0.7',
      sshUser: 'root',
      sshPort: 2222,
      sshKeySecret: 'prod/bootstrap/ssh',
      s3Reachable: null,
    });
  });

  it('declareStatic re-declare shallow-merges host_properties', async () => {
    await store.declareStatic({
      authority: OP,
      agentId: 'web-09',
      labels: [],
      properties: { region: 'eu', tier: 'gold' },
    });
    await store.declareStatic({
      authority: OP,
      agentId: 'web-09',
      labels: [],
      properties: { tier: 'silver' },
    });
    expect(parseHostProperties((await store.get('web-09'))!.host_properties)).toEqual({
      region: 'eu',
      tier: 'silver',
    });
  });

  it('removeStatic deletes the row and returns the count', async () => {
    await store.declareStatic({ authority: OP, agentId: 'h1', labels: ['role:db'] });
    expect(await store.removeStatic('h1', { authority: OP })).toBe(1);
    expect(await store.get('h1')).toBeNull();
    expect(await store.removeStatic('nope', { authority: OP })).toBe(0);
  });

  describe('write authority', () => {
    const agentReg = (
      agentId: string,
      extra: Partial<Parameters<HostRosterStore['upsert']>[0]> = {},
    ) =>
      store.upsert({
        agentId,
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['role:web'],
        hostname: 'agent-reported',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
        ...extra,
      });

    it('a default (platform) declare with a reserved property throws and writes nothing', async () => {
      // fails-when: the default authority is operator, or the reserved check is removed.
      await expect(
        store.declareStatic({
          agentId: 'h-res',
          properties: { region: 'eu', 'kici:agent-restart-start': 'touch /tmp/pwn' },
        }),
      ).rejects.toBeInstanceOf(ReservedHostKeyError);
      expect(await store.get('h-res')).toBeNull();
    });

    it('refuses reserved keys case- and whitespace-insensitively', async () => {
      // fails-when: the predicate is case-sensitive or skips the trim canonicalizeLabel applies.
      const err = await store
        .declareStatic({
          agentId: 'h-case',
          labels: [' KICI:host:x'],
          properties: { 'KICI:agent-service': 'x' },
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReservedHostKeyError);
      expect((err as ReservedHostKeyError).keys).toEqual([' KICI:host:x', 'KICI:agent-service']);
      expect(await store.get('h-case')).toBeNull();
      expect(isReservedHostKey('kici:x')).toBe(true);
      expect(isReservedHostKey('region')).toBe(false);
    });

    it('stores a kici: label under operator and refuses it under platform', async () => {
      await expect(
        store.declareStatic({ agentId: 'h-lbl', labels: ['kici:host:x'] }),
      ).rejects.toBeInstanceOf(ReservedHostKeyError);
      await store.declareStatic({ agentId: 'h-lbl', labels: ['kici:host:x'], authority: OP });
      expect(JSON.parse((await store.get('h-lbl'))!.labels)).toEqual(['kici:host:x']);
    });

    it('operator stores every restart, install and service key, and the re-stage reads them', async () => {
      // breaks-if-wrong: kici-admin declares that set the restart commands must still work.
      const props = {
        'kici:agent-restart-stop': 'stop-cmd',
        'kici:agent-restart-start': 'start-cmd',
        'kici:agent-install-dir': '/opt/kici-agent',
        'kici:agent-service': 'kici-agent.service',
      };
      await store.declareStatic({ agentId: 'h-op', properties: props, authority: OP });
      const stored = parseHostProperties((await store.get('h-op'))!.host_properties);
      expect(stored).toEqual(props);
      expect(resolveRestartSpec(stored)).toEqual({
        stop: 'stop-cmd',
        start: 'start-cmd',
        installDir: '/opt/kici-agent',
      });
    });

    it('a platform create stamps platform and stores ordinary properties', async () => {
      // breaks-if-wrong: ordinary non-kici: properties from the dashboard must still be stored.
      expect(
        await store.declareStatic({
          agentId: 'h-new',
          labels: ['role:db'],
          properties: { region: 'eu' },
        }),
      ).toEqual({ created: true });
      const row = await store.get('h-new');
      expect(row?.identity_source).toBe(HostIdentitySource.platform);
      expect(parseHostProperties(row!.host_properties)).toEqual({ region: 'eu' });
    });

    it('a platform declare refuses reach fields', async () => {
      await expect(
        store.declareStatic({ agentId: 'h-reach', address: '10.0.0.1' }),
      ).rejects.toThrow(/operator/);
      expect(await store.get('h-reach')).toBeNull();
    });

    for (const source of [
      HostIdentitySource.agent,
      HostIdentitySource.operator,
      HostIdentitySource.platform,
    ]) {
      it(`a platform declare onto an existing ${source} row throws HostExistsError and changes nothing`, async () => {
        // fails-when: the platform branch still runs ON CONFLICT DO UPDATE.
        if (source === HostIdentitySource.agent) await agentReg('h-ex');
        if (source === HostIdentitySource.operator)
          await store.declareStatic({
            agentId: 'h-ex',
            labels: ['role:web'],
            hostname: 'agent-reported',
            authority: OP,
          });
        if (source === HostIdentitySource.platform)
          await store.declareStatic({
            agentId: 'h-ex',
            labels: ['role:web'],
            hostname: 'agent-reported',
          });
        const before = await store.get('h-ex');
        await expect(
          store.declareStatic({ agentId: 'h-ex', labels: ['env:prod'], hostname: 'b' }),
        ).rejects.toBeInstanceOf(HostExistsError);
        const after = await store.get('h-ex');
        expect(after?.labels).toBe(before?.labels);
        expect(after?.hostname).toBe(before?.hostname);
        expect(after?.identity_source).toBe(source);
      });
    }

    it('an agent registration confirms a platform row and keeps none of its properties', async () => {
      // fails-when: upsert still merges host_properties for platform rows.
      await store.declareStatic({
        agentId: 'h-conf',
        labels: ['env:prod'],
        hostname: 'b',
        properties: { tier: 'gold' },
      });
      await agentReg('h-conf', { properties: { region: 'eu' } });
      const row = await store.get('h-conf');
      expect(row?.identity_source).toBe(HostIdentitySource.agent);
      expect(JSON.parse(row!.labels)).toEqual(['role:web']);
      expect(row?.hostname).toBe('agent-reported');
      expect(parseHostProperties(row!.host_properties)).toEqual({ region: 'eu' });
    });

    it('an agent registration onto an operator row keeps the operator properties', async () => {
      // breaks-if-wrong: the operator-declared region must survive a re-register (the shallow merge).
      await store.declareStatic({ agentId: 'h-keep', properties: { region: 'eu' }, authority: OP });
      await agentReg('h-keep', { properties: { cores: 8 } });
      const row = await store.get('h-keep');
      expect(row?.identity_source).toBe(HostIdentitySource.agent);
      expect(parseHostProperties(row!.host_properties)).toEqual({ region: 'eu', cores: 8 });
    });

    it('race: platform create then agent registration ends with the agent identity', async () => {
      await store.declareStatic({ agentId: 'h-race1', labels: ['env:prod'] });
      await agentReg('h-race1');
      const row = await store.get('h-race1');
      expect(row?.identity_source).toBe(HostIdentitySource.agent);
      expect(JSON.parse(row!.labels)).toEqual(['role:web']);
    });

    it('race: agent registration then platform create is refused', async () => {
      await agentReg('h-race2');
      await expect(
        store.declareStatic({ agentId: 'h-race2', labels: ['env:prod'] }),
      ).rejects.toBeInstanceOf(HostExistsError);
      expect(JSON.parse((await store.get('h-race2'))!.labels)).toEqual(['role:web']);
    });

    it('adopt: an operator declare onto a platform row replaces labels, hostname and properties', async () => {
      // fails-when: COALESCE preserves the Platform values.
      await store.declareStatic({
        agentId: 'h-adopt',
        labels: ['env:prod'],
        hostname: 'b',
        properties: { tier: 'gold' },
      });
      await store.declareStatic({ agentId: 'h-adopt', labels: [], authority: OP });
      const row = await store.get('h-adopt');
      expect(row?.identity_source).toBe(HostIdentitySource.operator);
      expect(JSON.parse(row!.labels)).toEqual([]);
      expect(row?.hostname).toBeNull();
      expect(parseHostProperties(row!.host_properties)).toEqual({});
    });

    it('adopt: an operator re-declare of an operator row keeps an omitted hostname', async () => {
      // breaks-if-wrong: preserve-on-omit must still hold for operator rows.
      await store.declareStatic({
        agentId: 'h-keep2',
        labels: [],
        hostname: 'kept',
        authority: OP,
      });
      await store.declareStatic({ agentId: 'h-keep2', labels: [], authority: OP });
      expect((await store.get('h-keep2'))?.hostname).toBe('kept');
    });

    it('an operator declare onto an agent row keeps agent', async () => {
      // fails-when: the declare overwrites the source unconditionally.
      await agentReg('h-agent');
      await store.declareStatic({ agentId: 'h-agent', labels: ['role:db'], authority: OP });
      expect((await store.get('h-agent'))?.identity_source).toBe(HostIdentitySource.agent);
    });

    it('a platform remove refuses a confirmed row and deletes a platform row', async () => {
      await agentReg('h-rm-agent');
      await store.declareStatic({ agentId: 'h-rm-op', authority: OP });
      await store.declareStatic({ agentId: 'h-rm-plat' });
      await expect(store.removeStatic('h-rm-agent')).rejects.toBeInstanceOf(HostConfirmedError);
      await expect(store.removeStatic('h-rm-op')).rejects.toBeInstanceOf(HostConfirmedError);
      expect(await store.get('h-rm-agent')).not.toBeNull();
      expect(await store.get('h-rm-op')).not.toBeNull();
      expect(await store.removeStatic('h-rm-plat')).toBe(1);
      expect(await store.removeStatic('h-rm-missing')).toBe(0);
      // breaks-if-wrong: an operator remove deletes any row.
      expect(await store.removeStatic('h-rm-agent', { authority: OP })).toBe(1);
    });
  });

  describe('unconfirmed placeholders', () => {
    const seed = async () => {
      await store.declareStatic({ agentId: 'p-db', labels: ['role:db'] }); // platform
      await store.declareStatic({ agentId: 'o-db', labels: ['role:db'], authority: OP });
      await store.upsert({
        agentId: 'a-db',
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['role:db'],
        hostname: null,
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });
    };
    const ids = (hosts: Array<{ agentId: string }>) => hosts.map((h) => h.agentId).sort();
    const roleDb = [[exact('role:db')]];

    it('targeting and inventory reads skip a platform row', async () => {
      // fails-when: matchRows or the inventory methods lack the filter.
      await seed();
      expect(ids(await store.findFanoutTargets(roleDb, [], 60_000))).toEqual(['a-db', 'o-db']);
      expect(ids(await store.findMatching(roleDb, [], 60_000))).toEqual(['a-db', 'o-db']);
      expect(ids(await store.queryInventory(undefined, 60_000))).toEqual(['a-db', 'o-db']);
      expect(ids(await store.queryInventory({ include: roleDb }, 60_000))).toEqual([
        'a-db',
        'o-db',
      ]);
      expect(await store.getInventory('p-db', 60_000)).toBeNull();
      // breaks-if-wrong: operator and agent rows are still matched (above) and readable.
      expect(await store.getInventory('o-db', 60_000)).not.toBeNull();
    });

    it('the dashboard reads include a platform row flagged unconfirmed', async () => {
      await seed();
      const hosts = await store.listFleetHosts(60_000);
      expect(Object.fromEntries(hosts.map((h) => [h.agentId, h.confirmed]))).toEqual({
        'a-db': true,
        'o-db': true,
        'p-db': false,
      });
      expect((await store.getFleetHost('p-db', 60_000))?.confirmed).toBe(false);
      expect(await store.getFleetHost('missing', 60_000)).toBeNull();
    });

    it('countStaticUnreachable ignores a platform row', async () => {
      // fails-when: the alarm query lacks the filter (p-db and o-db are both static and unconnected).
      await seed();
      expect(await store.countStaticUnreachable(60_000)).toBe(1);
    });
  });

  describe('reboot-pending flag', () => {
    it('set / clear / isRebootPending round-trips with the deadline', async () => {
      await store.declareStatic({ authority: OP, agentId: 'h1', labels: [] });
      const now = Date.now();
      await store.setRebootPending('h1', new Date(now + 600_000));
      expect(await store.isRebootPending('h1', now)).toBe(true);
      // Past the deadline ⇒ no longer pending.
      expect(await store.isRebootPending('h1', now + 700_000)).toBe(false);
      await store.clearRebootPending('h1');
      expect(await store.isRebootPending('h1', now)).toBe(false);
    });

    it('listExpiredRebootPending returns only hosts past their deadline', async () => {
      await store.declareStatic({ authority: OP, agentId: 'expired', labels: [] });
      await store.declareStatic({ authority: OP, agentId: 'live', labels: [] });
      await store.declareStatic({ authority: OP, agentId: 'none', labels: [] });
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
      await store.declareStatic({ authority: OP, agentId: 'h1', labels: [] });
      expect(await store.isRebootPending('h1', Date.now())).toBe(false);
    });
  });

  describe('findMatching', () => {
    const grace = 5 * 60_000;

    // Both roster writers fold now, so raw SQL is the only way to produce the
    // row a pre-fold orchestrator left behind — and a declared-only host has no
    // agent to re-register it, so such a row outlives any number of upgrades.
    const seedLegacyRow = (agentId: string, hostname: string | null) =>
      sql`INSERT INTO public.host_roster
            (agent_id, lifecycle_class, labels, hostname, connected_instance_id, last_seen)
          VALUES (${agentId}, 'static', '["role:web"]', ${hostname}, 'orch-A', now())`.execute(db);

    const legacyById = async () =>
      new Map(
        (await store.findMatching([[exact('role:web')]], [], grace)).map((h) => [h.agentId, h]),
      );

    it('folds a legacy mixed-case hostname on read, never the agent-id fallback', async () => {
      await seedLegacyRow('Legacy-Agent', 'Build-Box-01');
      await seedLegacyRow('No-Hostname', null);

      const byId = await legacyById();
      expect(byId.get('Legacy-Agent')!.host).toBe('build-box-01');
      expect(byId.get('Legacy-Agent')!.agentId).toBe('Legacy-Agent');
      // The fallback stays raw so `matchHostPattern` still recognises it as an
      // identifier and skips its host arm.
      expect(byId.get('No-Hostname')!.host).toBe('No-Hostname');
    });

    it('host facts from a legacy row match a lowercase host_pattern', async () => {
      await seedLegacyRow('Legacy-Agent', 'Build-Box-01');
      await seedLegacyRow('No-Hostname', null);
      const byId = await legacyById();

      const legacy = byId.get('Legacy-Agent')!;
      expect(matchHostPattern(legacy, 'build-box-01')).toBe(true);
      expect(matchHostPattern(legacy, 'Build-Box-01')).toBe(true);

      // The guard survives the read fold: an agent id reached through the
      // fallback still never matches case-insensitively.
      const fallback = byId.get('No-Hostname')!;
      expect(matchHostPattern(fallback, 'no-hostname')).toBe(false);
      expect(matchHostPattern(fallback, 'No-Hostname')).toBe(true);
    });

    it('queryInventory folds a legacy mixed-case hostname', async () => {
      await seedLegacyRow('inv-mixed', 'Build-Box-01');
      await seedLegacyRow('inv-null', null);

      const byId = new Map(
        (await store.queryInventory({ include: [[exact('role:web')]] }, grace)).map((e) => [
          e.agentId,
          e,
        ]),
      );
      expect(byId.get('inv-mixed')!.hostname).toBe('build-box-01');
      expect(byId.get('inv-null')!.hostname).toBeNull();
    });

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
      await store.declareStatic({
        authority: OP,
        agentId: 'a3',
        labels: ['role:web', 'kici:host:web-09'],
      });

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

    it('matches a roster row persisted with mixed-case labels', async () => {
      // `upsert` writes the labels it is handed, so seeding through it stores
      // exactly what a row written before the fold shipped carries.
      await store.upsert({
        agentId: 'a1',
        tokenId: null,
        lifecycleClass: 'static',
        labels: ['Docker'],
        hostname: 'web-01',
        platform: 'linux',
        arch: 'x64',
        instanceId: 'orch-A',
      });

      const hosts = await store.findMatching([[exact('docker')]], [], grace);
      expect(hosts.map((h) => h.agentId)).toEqual(['a1']);
      // The read folds, so the label the fan-out and `ctx.agent.labels` see is
      // canonical — not the case the row happens to hold.
      expect(hosts[0].labels).toEqual(['docker']);

      // The exclusion arm reads the same folded set.
      const excluded = await store.findMatching([[exact('docker')]], [exact('DOCKER')], grace);
      expect(excluded).toEqual([]);

      // …and so does the SDK-facing inventory shape.
      const inventory = await store.queryInventory({ include: [[exact('docker')]] }, grace);
      expect(inventory.map((h) => h.agentId)).toEqual(['a1']);
      expect(inventory[0].labels).toEqual(['docker']);
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
      await store.declareStatic({
        authority: OP,
        agentId: 'web-09',
        labels: ['role:web'],
        hostname: 'web-09',
      });
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

  describe('findFanoutTargets', () => {
    const grace = 5 * 60_000;

    /** A live, label-matching roster row; `over` varies only what a test asserts on. */
    const host = (over: Partial<Parameters<HostRosterStore['upsert']>[0]>) => ({
      agentId: 'h1',
      tokenId: null,
      lifecycleClass: 'static' as const,
      labels: ['role:web'],
      hostname: 'h1',
      platform: 'linux',
      arch: 'x64',
      instanceId: 'orch-A',
      ...over,
    });

    it('omits a scaler-spawned host', async () => {
      await store.upsert(host({ agentId: 'fleet-1' }));
      await store.upsert(host({ agentId: 'scaler-1', scalerManaged: true }));

      const targets = await store.findFanoutTargets([[exact('role:web')]], [], grace);
      expect(targets.map((h) => h.agentId)).toEqual(['fleet-1']);
    });

    it('KEEPS an ephemeral-classed host that no scaler spawned', async () => {
      // The auth-none guard. `lifecycle_class` snapshots the auth TOKEN's type,
      // and every agent registers as `ephemeral` when the auth mode is `none`.
      // Keying fan-out eligibility on the class would match nothing in an
      // auth-none deployment and fail every `runsOnAll` with "matched zero
      // usable hosts". Eligibility keys on `scaler_managed`, so an
      // ephemeral-classed fleet host stays a target.
      await store.upsert(host({ agentId: 'authnone-1', lifecycleClass: 'ephemeral' }));

      const targets = await store.findFanoutTargets([[exact('role:web')]], [], grace);
      expect(targets.map((h) => h.agentId)).toEqual(['authnone-1']);
    });

    it('findMatching still returns BOTH, so inventory.query is unaffected', async () => {
      // The `ctx.kici.inventory` guard. `findMatching` also backs the SDK's
      // `inventory.query`, where filtering scaler agents out would make a
      // selector return FEWER hosts than no selector at all — and would drop
      // auto-scaler agents from a surface whose `lifecycleClass` field exists to
      // distinguish them. The fan-out filter lives on its own method only.
      await store.upsert(host({ agentId: 'fleet-1' }));
      await store.upsert(host({ agentId: 'scaler-1', scalerManaged: true }));

      const all = await store.findMatching([[exact('role:web')]], [], grace);
      expect(all.map((h) => h.agentId)).toEqual(['fleet-1', 'scaler-1']);

      const inventory = await store.queryInventory({ include: [[exact('role:web')]] }, grace);
      expect(inventory.map((h) => h.agentId)).toEqual(['fleet-1', 'scaler-1']);
    });

    it('re-registration converges scaler_managed rather than keeping a stale value', async () => {
      // Guards the `onConflict` branch of `upsert`: writing the column only in
      // `values()` would leave a re-registering agent on whatever it was first
      // enrolled as, in both directions.
      await store.upsert(host({ agentId: 'h1', scalerManaged: true }));
      expect(await store.findFanoutTargets([[exact('role:web')]], [], grace)).toEqual([]);

      await store.upsert(host({ agentId: 'h1', scalerManaged: false }));
      const targets = await store.findFanoutTargets([[exact('role:web')]], [], grace);
      expect(targets.map((h) => h.agentId)).toEqual(['h1']);

      await store.upsert(host({ agentId: 'h1', scalerManaged: true }));
      expect(await store.findFanoutTargets([[exact('role:web')]], [], grace)).toEqual([]);
    });

    it('a host declared by the operator is never scaler-managed', async () => {
      await store.declareStatic({ authority: OP, agentId: 'declared-1', labels: ['role:web'] });
      const targets = await store.findFanoutTargets([[exact('role:web')]], [], grace);
      expect(targets.map((h) => h.agentId)).toEqual(['declared-1']);
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

    it('SECURITY: an agent register cannot forge orchestrator-reserved kici: keys', async () => {
      // Orchestrator records the staged version + a restart command.
      await store.upsert(baseUpsert({ properties: { region: 'eu' } }));
      await store.recordStagedVersion('h1', '1.0.0');
      // A malicious agent re-registers trying to forge the reserved keys.
      await store.upsert(
        baseUpsert({
          properties: {
            region: 'us',
            'kici:staged-agent-version': '2.0.0',
            'kici:agent-restart-start': 'rm -rf /',
            // fails-when: the strip is case-sensitive.
            'KICI:agent-restart-start': 'x',
          },
        }),
      );
      const row = await store.get('h1');
      // Reserved keys are untouched by the agent; only the non-reserved key merged.
      expect(row?.host_properties).toEqual({
        region: 'us',
        'kici:staged-agent-version': '1.0.0',
      });
      expect(await store.getStagedVersion('h1')).toBe('1.0.0');
    });

    it('declareStatic sets properties to the provided bag (default {})', async () => {
      await store.declareStatic({
        authority: OP,
        agentId: 'd1',
        labels: ['role:db'],
        properties: { region: 'us' },
      });
      expect((await store.get('d1'))?.host_properties).toEqual({ region: 'us' });
      await store.declareStatic({ authority: OP, agentId: 'd2', labels: [] });
      expect((await store.get('d2'))?.host_properties).toEqual({});
    });

    it('findMatching exposes parsed properties on MatchedHost', async () => {
      await store.upsert(baseUpsert({ properties: { region: 'eu', cores: 8 } }));
      const [host] = await store.findMatching([[exact('role:db')]], [], grace);
      expect(host.properties).toEqual({ region: 'eu', cores: 8 });
    });

    it('queryInventory(undefined) returns every host as a HostInventoryEntry', async () => {
      await store.upsert(baseUpsert({ agentId: 'inv-a', properties: { region: 'eu' } }));
      await store.declareStatic({ authority: OP, agentId: 'inv-b', labels: ['role:web'] });
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

// stripReservedProperties is a pure function — test it without a DB.
describe('stripReservedProperties', () => {
  it('drops every kici:-namespaced key, keeps the rest', () => {
    expect(
      stripReservedProperties({
        region: 'eu',
        cores: 8,
        'kici:staged-agent-version': '2.0.0',
        'kici:agent-restart-start': 'rm -rf /',
        'kici:agent-service': 'evil',
      }),
    ).toEqual({ region: 'eu', cores: 8 });
  });
  it('is a no-op on a bag with no reserved keys', () => {
    expect(stripReservedProperties({ region: 'us' })).toEqual({ region: 'us' });
  });
  it('drops a reserved key in any case', () => {
    expect(stripReservedProperties({ 'KICI:a': 1, ok: 2 })).toEqual({ ok: 2 });
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
