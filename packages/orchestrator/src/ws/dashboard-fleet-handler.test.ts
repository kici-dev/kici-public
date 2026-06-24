import { describe, it, expect, vi } from 'vitest';
import {
  handleFleetHostsRequest,
  handleFleetHostRequest,
  handleFleetPreviewRequest,
  type FleetHandlerDeps,
  type ResolvedRunsOnAll,
} from './dashboard-fleet-handler.js';
import { HostStatus } from '../agent/host-roster.js';
import type { HostInventoryEntry } from '@kici-dev/engine';

function entry(agentId: string, status: 'ready' | 'unreachable' | 'stale'): HostInventoryEntry {
  return {
    agentId,
    labels: ['role:db'],
    properties: {},
    hostname: agentId,
    platform: 'linux',
    arch: 'x64',
    lifecycleClass: status === 'stale' ? 'ephemeral' : 'static',
    status,
    lastSeen: '2026-06-23T00:00:00.000Z',
  };
}

/** Build deps with a stubbed roster store + a stubbed Kysely query chain. */
function makeDeps(overrides: Partial<FleetHandlerDeps> = {}): FleetHandlerDeps {
  const rosterStore = {
    queryInventory: vi.fn().mockResolvedValue([]),
    getInventory: vi.fn().mockResolvedValue(null),
    findMatching: vi.fn().mockResolvedValue([]),
  } as unknown as FleetHandlerDeps['rosterStore'];
  // Minimal Kysely stub: returns an empty pinned-runs result.
  const db = {
    selectFrom: () => ({
      innerJoin: () => ({
        select: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({ execute: () => Promise.resolve([]) }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as FleetHandlerDeps['db'];
  return {
    db,
    rosterStore,
    rosterGraceMs: 300_000,
    resolveRunsOnAll: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('handleFleetHostsRequest', () => {
  it('returns queryInventory output verbatim', async () => {
    const hosts = [entry('a1', 'ready'), entry('a2', 'unreachable')];
    const deps = makeDeps();
    (deps.rosterStore.queryInventory as ReturnType<typeof vi.fn>).mockResolvedValue(hosts);
    const res = await handleFleetHostsRequest(deps, 'req-1');
    expect(res.type).toBe('dashboard.fleet.hosts.response');
    expect(res.requestId).toBe('req-1');
    expect(res.hosts).toEqual(hosts);
    expect(deps.rosterStore.queryInventory).toHaveBeenCalledWith(undefined, 300_000);
  });
});

describe('handleFleetHostRequest', () => {
  it('returns the single host and an empty runs list', async () => {
    const deps = makeDeps();
    (deps.rosterStore.getInventory as ReturnType<typeof vi.fn>).mockResolvedValue(
      entry('a1', 'ready'),
    );
    const res = await handleFleetHostRequest(deps, 'req-2', 'a1');
    expect(res.type).toBe('dashboard.fleet.host.response');
    expect(res.host?.agentId).toBe('a1');
    expect(res.runs).toEqual([]);
  });

  it('returns null host when the agent is not in the roster', async () => {
    const deps = makeDeps();
    const res = await handleFleetHostRequest(deps, 'req-3', 'missing');
    expect(res.host).toBeNull();
    expect(res.runs).toEqual([]);
  });

  it('dedups pinned runs by run id, newest-first, capped at 20', async () => {
    const now = '2026-06-23T00:00:00.000Z';
    const rows = [
      { run_id: 'r1', workflow_name: 'wf', status: 'success', created_at: new Date(now) },
      { run_id: 'r1', workflow_name: 'wf', status: 'success', created_at: new Date(now) },
      { run_id: 'r2', workflow_name: null, status: 'failed', created_at: new Date(now) },
    ];
    const db = {
      selectFrom: () => ({
        innerJoin: () => ({
          select: () => ({
            where: () => ({
              orderBy: () => ({ limit: () => ({ execute: () => Promise.resolve(rows) }) }),
            }),
          }),
        }),
      }),
    } as unknown as FleetHandlerDeps['db'];
    const deps = makeDeps({ db });
    (deps.rosterStore.getInventory as ReturnType<typeof vi.fn>).mockResolvedValue(
      entry('a1', 'ready'),
    );
    const res = await handleFleetHostRequest(deps, 'req-4', 'a1');
    expect(res.runs.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(res.runs[1].workflowName).toBeNull();
  });
});

describe('handleFleetPreviewRequest', () => {
  it('returns empty match + hold when the workflow has no runsOnAll', async () => {
    const deps = makeDeps();
    const res = await handleFleetPreviewRequest(deps, 'req-5', 'no-fanout');
    expect(res.matched).toEqual([]);
    expect(res.onUnreachable).toBe('hold');
    expect(res.estimatedChildCount).toBe(0);
  });

  it('partitions matched hosts and honors onUnreachable=hold', async () => {
    const predicate: ResolvedRunsOnAll = { include: [], exclude: [], onUnreachable: 'hold' };
    const matched = [
      { agentId: 'ready1', status: HostStatus.ready, lifecycleClass: 'static' as const },
      { agentId: 'absent1', status: HostStatus.unreachable, lifecycleClass: 'static' as const },
      { agentId: 'stale1', status: HostStatus.stale, lifecycleClass: 'ephemeral' as const },
    ];
    const deps = makeDeps({ resolveRunsOnAll: vi.fn().mockResolvedValue(predicate) });
    (deps.rosterStore.findMatching as ReturnType<typeof vi.fn>).mockResolvedValue(matched);
    (deps.rosterStore.getInventory as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) =>
        entry(id, id === 'ready1' ? 'ready' : id === 'absent1' ? 'unreachable' : 'stale'),
    );
    const res = await handleFleetPreviewRequest(deps, 'req-6', 'fanout');
    const byDisposition = Object.fromEntries(
      res.matched.map((m) => [m.entry.agentId, m.disposition]),
    );
    expect(byDisposition).toEqual({
      ready1: 'target',
      absent1: 'unreachable-durable',
      stale1: 'skipped-ephemeral',
    });
    // ready1 (target) + absent1 (unreachable-durable counted under hold) = 2.
    expect(res.estimatedChildCount).toBe(2);
  });

  it('does not count unreachable-durable hosts when onUnreachable=skip', async () => {
    const predicate: ResolvedRunsOnAll = { include: [], exclude: [], onUnreachable: 'skip' };
    const matched = [
      { agentId: 'ready1', status: HostStatus.ready, lifecycleClass: 'static' as const },
      { agentId: 'absent1', status: HostStatus.unreachable, lifecycleClass: 'static' as const },
    ];
    const deps = makeDeps({ resolveRunsOnAll: vi.fn().mockResolvedValue(predicate) });
    (deps.rosterStore.findMatching as ReturnType<typeof vi.fn>).mockResolvedValue(matched);
    (deps.rosterStore.getInventory as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => entry(id, id === 'ready1' ? 'ready' : 'unreachable'),
    );
    const res = await handleFleetPreviewRequest(deps, 'req-7', 'fanout');
    expect(res.estimatedChildCount).toBe(1);
    expect(res.onUnreachable).toBe('skip');
  });
});
