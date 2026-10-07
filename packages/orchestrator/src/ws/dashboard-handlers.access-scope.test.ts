/**
 * Pins the org / routing key each dashboard WS handler attributes its
 * access_log rows to, including after the handler is re-bound.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ActorPrincipal } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import type { HostRosterStore } from '../agent/host-roster.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import { DashboardBackendsHandler } from './dashboard-backends-handler.js';
import { DashboardFleetWriteHandler } from './dashboard-fleet-write-handler.js';
import { DashboardRegistrationsHandler } from './dashboard-registrations-handler.js';
import { DashboardGlobalWorkflowsHandler } from './dashboard-global-workflows-handler.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

const actor: ActorPrincipal = { type: 'user', sub: 'u-scope' };

/** A db whose policy read is permissive (no org_settings row). */
function permissiveDb(): Kysely<Database> {
  return createMockDb().db;
}
function writer() {
  const record = vi.fn().mockResolvedValue(undefined);
  return { record, accessLog: { record } as unknown as AccessLogWriter };
}

async function rowOf(record: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(record).toHaveBeenCalled());
  return record.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('dashboard handler access_log scope', () => {
  // fails-when: the backends handler stops reading its (re-bindable) org / routing key
  it('backends: bound orgId + routingKey, following setOrgContext', async () => {
    const { record, accessLog } = writer();
    const handler = new DashboardBackendsHandler({
      db: permissiveDb(),
      registry: {
        getBackend: vi.fn().mockResolvedValue(null),
      } as unknown as BackendRegistry,
      healthChecker: {} as unknown as BackendHealthChecker,
      send: vi.fn(),
      orgId: 'cust-1',
      routingKey: 'rk-1',
      accessLog,
    });
    const get = { type: 'dashboard.backends.get', requestId: 'r1', actor, name: 'b' } as never;
    await handler.handleMessage(get);
    expect(await rowOf(record)).toMatchObject({
      orgId: 'cust-1',
      routingKey: 'rk-1',
      action: 'backend.get.read',
      target: { type: 'backend', id: 'b' },
      outcome: 'allowed',
      errorMessage: 'backend not found',
    });
    handler.setOrgContext('cust-2', 'rk-2');
    await handler.handleMessage(get);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(await rowOf(record)).toMatchObject({ orgId: 'cust-2', routingKey: 'rk-2' });
  });

  // fails-when: the fleet-write handler stops reading its (re-bindable) org / routing key
  it('fleet-write: bound orgId + routingKey, following setOrgContext', async () => {
    const { record, accessLog } = writer();
    const handler = new DashboardFleetWriteHandler({
      db: permissiveDb(),
      rosterStore: {
        removeStatic: vi.fn().mockResolvedValue(1),
      } as unknown as HostRosterStore,
      send: vi.fn(),
      orgId: 'cust-1',
      routingKey: 'rk-1',
      accessLog,
    });
    handler.setOrgContext('cust-2', 'rk-2');
    await handler.handleMessage({
      type: 'dashboard.fleet.host.remove',
      requestId: 'r1',
      actor,
      agentId: 'h1',
    } as never);
    expect(await rowOf(record)).toMatchObject({
      orgId: 'cust-2',
      routingKey: 'rk-2',
      action: 'fleet.host.remove',
      target: { type: 'fleet', id: 'h1' },
      outcome: 'allowed',
    });
  });

  // fails-when: the registrations handler reads a stale routing key after setRoutingKey
  it('registrations: deps.orgId + routingKey, following setRoutingKey', async () => {
    const { record, accessLog } = writer();
    const handler = new DashboardRegistrationsHandler({
      db: permissiveDb(),
      registrationStore: {
        getById: vi.fn().mockResolvedValue(undefined),
      } as unknown as RegistrationStore,
      registrationIndex: { loadFromDb: vi.fn() } as unknown as RegistrationIndex,
      send: vi.fn(),
      orgId: 'cust-1',
      routingKey: 'rk-1',
      accessLog,
    });
    handler.setRoutingKey('rk-2');
    await handler.handle({
      type: 'dashboard.registration.disable',
      requestId: 'r1',
      actor,
      registrationId: 'reg-1',
      disabled: true,
    } as never);
    expect(await rowOf(record)).toMatchObject({
      orgId: 'cust-1',
      routingKey: 'rk-2',
      action: 'registration.disable',
      target: { type: 'registration', id: 'reg-1' },
      outcome: 'allowed',
      errorMessage: 'registration not found',
    });
  });

  // fails-when: global-workflows rows gain a routing key, or an empty customerId is not null
  it.each([
    ['acme', 'acme'],
    ['', null],
  ])(
    'global-workflows: customerId %j attributes orgId %j and a null routing key',
    async (customerId, orgId) => {
      const { record, accessLog } = writer();
      const { db } = createMockDb({ selectFirstRow: undefined });
      const handler = new DashboardGlobalWorkflowsHandler({
        customerId,
        send: vi.fn(),
        db,
        clusterSettings: {
          tryGetBoolean: async () => ({ ok: true, value: null }),
        } as unknown as ClusterSettingsReader,
        globalWorkflowsEnabledDefault: false,
        accessLog,
      });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.get',
        requestId: 'r1',
        actor,
      } as never);
      expect(await rowOf(record)).toMatchObject({
        orgId,
        routingKey: null,
        action: 'global_workflows.get.read',
        target: { type: 'context', id: customerId },
        outcome: 'allowed',
        source: 'platform_proxy',
      });
    },
  );
});
