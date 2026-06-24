import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DashboardFleetWriteHandler } from './dashboard-fleet-write-handler.js';
import { invalidateDashboardWritePolicyCache } from '../policy/dashboard-write-policy.js';
import type { HostRosterStore } from '../agent/host-roster.js';
import type { Database } from '../db/types.js';

/**
 * Build a handler with a stubbed `db` whose `org_settings.dashboard_write_policy`
 * is `policy` (undefined ⇒ permissive). Mirrors the env-handler gate test.
 */
function buildHandler(policy: Record<string, boolean> | undefined): {
  handler: DashboardFleetWriteHandler;
  sent: unknown[];
  declareStatic: ReturnType<typeof vi.fn>;
  removeStatic: ReturnType<typeof vi.fn>;
} {
  const sent: unknown[] = [];
  const declareStatic = vi.fn().mockResolvedValue(undefined);
  const removeStatic = vi.fn().mockResolvedValue(1);
  const db = {
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi
      .fn()
      .mockResolvedValue(policy === undefined ? undefined : { dashboard_write_policy: policy }),
  };
  const handler = new DashboardFleetWriteHandler({
    db: db as unknown as Kysely<Database>,
    rosterStore: { declareStatic, removeStatic } as unknown as HostRosterStore,
    send: (msg) => sent.push(msg),
    orgId: 'cust-1',
  });
  return { handler, sent, declareStatic, removeStatic };
}

const ACTOR = { type: 'user', id: 'u-1', sub: 'sub-1' } as const;

describe('DashboardFleetWriteHandler', () => {
  beforeEach(() => invalidateDashboardWritePolicyCache());

  it('declare with a disabled policy short-circuits and emits operation_disabled', async () => {
    const { handler, sent, declareStatic } = buildHandler({ 'fleet.host.declare': false });

    await handler.handleMessage({
      type: 'dashboard.fleet.host.declare',
      requestId: 'req-1',
      actor: ACTOR,
      agentId: 'host-1',
      labels: ['role:db'],
    } as never);

    expect(declareStatic).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.type).toBe('dashboard.fleet.host.declare.response');
    expect(resp.error).toBe('operation_disabled');
    expect(resp.operation).toBe('fleet.host.declare');
    expect(resp.cliEquivalent).toBe('kici-admin host declare');
    expect(resp.requestId).toBe('req-1');
  });

  it('declare with a permissive policy calls declareStatic and answers declared:true', async () => {
    const { handler, sent, declareStatic } = buildHandler(undefined);

    await handler.handleMessage({
      type: 'dashboard.fleet.host.declare',
      requestId: 'req-2',
      actor: ACTOR,
      agentId: 'host-2',
      labels: ['role:web'],
      hostname: 'web-1',
    } as never);

    expect(declareStatic).toHaveBeenCalledTimes(1);
    expect(declareStatic).toHaveBeenCalledWith({
      agentId: 'host-2',
      labels: ['role:web'],
      hostname: 'web-1',
      properties: undefined,
    });
    expect(sent).toEqual([
      { type: 'dashboard.fleet.host.declare.response', requestId: 'req-2', declared: true },
    ]);
  });

  it('remove with a permissive policy calls removeStatic and reflects the count', async () => {
    const { handler, sent, removeStatic } = buildHandler(undefined);

    await handler.handleMessage({
      type: 'dashboard.fleet.host.remove',
      requestId: 'req-3',
      actor: ACTOR,
      agentId: 'host-3',
    } as never);

    expect(removeStatic).toHaveBeenCalledWith('host-3');
    expect(sent).toEqual([
      { type: 'dashboard.fleet.host.remove.response', requestId: 'req-3', removed: true },
    ]);
  });

  it('remove of a missing host answers removed:false without an error', async () => {
    const { handler, sent, removeStatic } = buildHandler(undefined);
    removeStatic.mockResolvedValueOnce(0);

    await handler.handleMessage({
      type: 'dashboard.fleet.host.remove',
      requestId: 'req-4',
      actor: ACTOR,
      agentId: 'nope',
    } as never);

    const resp = sent[0] as Record<string, unknown>;
    expect(resp).toMatchObject({
      type: 'dashboard.fleet.host.remove.response',
      requestId: 'req-4',
      removed: false,
    });
    expect(resp).not.toHaveProperty('error');
  });

  it('remove with a disabled policy short-circuits and never calls removeStatic', async () => {
    const { handler, sent, removeStatic } = buildHandler({ 'fleet.host.remove': false });

    await handler.handleMessage({
      type: 'dashboard.fleet.host.remove',
      requestId: 'req-5',
      actor: ACTOR,
      agentId: 'host-5',
    } as never);

    expect(removeStatic).not.toHaveBeenCalled();
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.error).toBe('operation_disabled');
    expect(resp.operation).toBe('fleet.host.remove');
    expect(resp.cliEquivalent).toBe('kici-admin host remove');
  });
});
