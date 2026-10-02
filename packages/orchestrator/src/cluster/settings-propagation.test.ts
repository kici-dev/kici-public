import { describe, it, expect } from 'vitest';
import {
  SettingsPropagationStatus as Status,
  buildSettingsPropagationReport,
  classifySettingsVersion,
  settingsPropagationReportSchema,
  type PropagationPeer,
} from './settings-propagation.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function peer(overrides: Partial<PropagationPeer> & { instanceId: string }): PropagationPeer {
  return {
    role: 'worker',
    connected: true,
    lastHeartbeatAt: NOW - 3_000,
    clusterSettingsVersion: 5,
    ...overrides,
  };
}

function report(peers: PropagationPeer[], opts: { current?: number; selfVersion?: number } = {}) {
  return buildSettingsPropagationReport({
    currentVersion: opts.current ?? 5,
    self: { instanceId: 'coord-a', appliedVersion: opts.selfVersion ?? 5 },
    peers,
    now: NOW,
  });
}

function row(r: ReturnType<typeof report>, id: string) {
  const found = r.orchestrators.find((o) => o.instanceId === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

describe('classifySettingsVersion', () => {
  it('reads equal, lower and higher versions', () => {
    expect(classifySettingsVersion(5, 5)).toBe(Status['in-sync']);
    expect(classifySettingsVersion(3, 5)).toBe(Status.behind);
    expect(classifySettingsVersion(7, 5)).toBe(Status.ahead);
  });
});

describe('buildSettingsPropagationReport', () => {
  // breaks-if-wrong: an orchestrator on the current version reads in-sync
  it('marks a peer on the current version in-sync', () => {
    expect(row(report([peer({ instanceId: 'arm-1' })]), 'arm-1').status).toBe(Status['in-sync']);
  });

  // fails-when: the builder writes currentVersion into each row instead of the peer's own
  it('reports a lagging worker with its own version and flags it behind', () => {
    const r = row(report([peer({ instanceId: 'arm-1', clusterSettingsVersion: 3 })]), 'arm-1');
    expect(r.appliedVersion).toBe(3);
    expect(r.status).toBe(Status.behind);
  });

  it('flags a peer above the row version as ahead', () => {
    const r = row(report([peer({ instanceId: 'arm-1', clusterSettingsVersion: 7 })]), 'arm-1');
    expect(r.status).toBe(Status.ahead);
  });

  it('treats a peer reporting 0 as behind once the row has a version', () => {
    const r = row(report([peer({ instanceId: 'old', clusterSettingsVersion: 0 })]), 'old');
    expect(r.status).toBe(Status.behind);
  });

  // breaks-if-wrong: a cluster whose row was never patched is not reported as lagging
  it('reads a never-patched cluster as in-sync everywhere', () => {
    const r = report([peer({ instanceId: 'w1', clusterSettingsVersion: 0 })], {
      current: 0,
      selfVersion: 0,
    });
    expect(r.orchestrators).toHaveLength(2);
    expect(r.orchestrators.every((o) => o.status === Status['in-sync'])).toBe(true);
  });

  // fails-when: disconnected entries are dropped, or the age ignores lastHeartbeatAt
  it('keeps a disconnected worker with its last version and heartbeat age', () => {
    const r = row(
      report([
        peer({
          instanceId: 'mac-1',
          connected: false,
          clusterSettingsVersion: 4,
          lastHeartbeatAt: NOW - 7_200_000,
        }),
      ]),
      'mac-1',
    );
    expect(r).toMatchObject({
      connected: false,
      appliedVersion: 4,
      status: Status.behind,
      lastHeartbeatAt: new Date(NOW - 7_200_000).toISOString(),
      lastHeartbeatAgeMs: 7_200_000,
    });
  });

  // breaks-if-wrong: a connected peer still reports connected
  it('keeps a connected peer connected', () => {
    expect(row(report([peer({ instanceId: 'arm-1' })]), 'arm-1').connected).toBe(true);
  });

  // fails-when: the self row uses currentVersion instead of the coordinator's own version
  it('lists the reporting coordinator first with its own version', () => {
    const r = report([peer({ instanceId: 'arm-1' })], { current: 5, selfVersion: 4 });
    expect(r.reportedBy).toBe('coord-a');
    expect(r.currentVersion).toBe(5);
    expect(r.orchestrators[0]).toEqual({
      instanceId: 'coord-a',
      role: 'coordinator',
      self: true,
      connected: true,
      appliedVersion: 4,
      status: Status.behind,
      lastHeartbeatAt: null,
      lastHeartbeatAgeMs: null,
    });
  });

  it('orders self, then coordinators, then workers, each by instance id', () => {
    const r = report([
      peer({ instanceId: 'w-b' }),
      peer({ instanceId: 'coord-c', role: 'coordinator' }),
      peer({ instanceId: 'w-a' }),
      peer({ instanceId: 'coord-b', role: 'coordinator' }),
    ]);
    expect(r.orchestrators.map((o) => o.instanceId)).toEqual([
      'coord-a',
      'coord-b',
      'coord-c',
      'w-a',
      'w-b',
    ]);
  });

  it('floors the age at 0 when the peer clock runs ahead', () => {
    const r = row(report([peer({ instanceId: 'skewed', lastHeartbeatAt: NOW + 5_000 })]), 'skewed');
    expect(r.lastHeartbeatAgeMs).toBe(0);
  });

  it('stamps generatedAt from now', () => {
    expect(report([]).generatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('settingsPropagationReportSchema', () => {
  it('keeps an unknown field and rejects a report with no orchestrators list', () => {
    const r = { ...report([peer({ instanceId: 'w' })]), extra: 1 };
    expect(settingsPropagationReportSchema.parse(r)).toMatchObject({ extra: 1 });
    const { orchestrators: _drop, ...broken } = r;
    expect(settingsPropagationReportSchema.safeParse(broken).success).toBe(false);
  });
});
