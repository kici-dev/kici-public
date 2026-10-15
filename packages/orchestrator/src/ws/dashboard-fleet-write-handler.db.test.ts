import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { FleetHostWriteRefusal } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { HostRosterStore, HostWriteAuthority, parseHostProperties } from '../agent/host-roster.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { DashboardFleetWriteHandler } from './dashboard-fleet-write-handler.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

const ACTOR = { type: 'user', id: 'u-1', sub: 'sub-1' } as const;

/**
 * The fleet write handler against the real roster store: the seam the mocked
 * handler test does not cross. Proves the handler's no-authority call lands on
 * the store's Platform default. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'DashboardFleetWriteHandler against the real roster store',
  { prefix: 'kici_fleet_write_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    let store: HostRosterStore;
    let sent: Array<Record<string, unknown>>;
    let record: ReturnType<typeof vi.fn>;
    let handler: DashboardFleetWriteHandler;

    beforeAll(() => {
      ({ db } = getDb());
      store = new HostRosterStore(db);
    });

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
  },
);
