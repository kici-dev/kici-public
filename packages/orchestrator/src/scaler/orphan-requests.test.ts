import { describe, expect, it, vi } from 'vitest';
import { ScalerOrphansAction, ScalerVmStatus, ScalerVmStopOutcome } from '@kici-dev/engine';
import { answerScalerOrphansRequest } from './orphan-requests.js';

const VM = {
  vmId: 'scaler-firecracker-1',
  scaler: 'fc',
  pid: 7,
  startedAt: new Date(0).toISOString(),
  ageSeconds: 1,
  chrootDir: '/srv/jailer/firecracker/scaler-firecracker-1/root',
  status: ScalerVmStatus.enum.orphaned,
  trackedBy: [],
  reason: 'x',
};

function fakeManager() {
  return {
    firecrackerScalerNames: vi.fn(() => ['fc']),
    listLiveVms: vi.fn(async () => [VM]),
    stopUntrackedVms: vi.fn(async (vmIds: readonly string[]) =>
      vmIds.map((vmId) => ({ vmId, outcome: ScalerVmStopOutcome.enum.stopped, detail: 'stopped' })),
    ),
  };
}

describe('answerScalerOrphansRequest', () => {
  it('a node with no scaler manager lists nothing', async () => {
    expect(
      await answerScalerOrphansRequest(null, { action: ScalerOrphansAction.enum.list }),
    ).toEqual({ ok: true, firecrackerScalers: [], vms: [] });
  });

  it('a node with no scaler manager holds none of the VMs a stop names', async () => {
    const answer = await answerScalerOrphansRequest(null, {
      action: ScalerOrphansAction.enum.stop,
      vmIds: ['a', 'b'],
    });
    expect(answer.ok).toBe(true);
    expect(answer.results?.map((r) => [r.vmId, r.outcome])).toEqual([
      ['a', ScalerVmStopOutcome.enum['not-found']],
      ['b', ScalerVmStopOutcome.enum['not-found']],
    ]);
  });

  it('list delegates to the manager', async () => {
    const manager = fakeManager();
    expect(
      await answerScalerOrphansRequest(manager, { action: ScalerOrphansAction.enum.list }),
    ).toEqual({ ok: true, firecrackerScalers: ['fc'], vms: [VM] });
  });

  it('stop passes exactly the requested ids', async () => {
    const manager = fakeManager();
    const answer = await answerScalerOrphansRequest(manager, {
      action: ScalerOrphansAction.enum.stop,
      vmIds: ['a'],
    });
    expect(manager.stopUntrackedVms).toHaveBeenCalledWith(['a']);
    expect(answer.results).toEqual([
      { vmId: 'a', outcome: ScalerVmStopOutcome.enum.stopped, detail: 'stopped' },
    ]);
  });

  // fails-when: a stop with no ids reaches the manager
  it('refuses a stop without vmIds', async () => {
    const manager = fakeManager();
    for (const vmIds of [undefined, []]) {
      expect(
        await answerScalerOrphansRequest(manager, {
          action: ScalerOrphansAction.enum.stop,
          ...(vmIds ? { vmIds } : {}),
        }),
      ).toEqual({ ok: false, error: 'stop needs vmIds' });
    }
    expect(manager.stopUntrackedVms).not.toHaveBeenCalled();
  });

  it('answers a manager failure with ok false, never a throw', async () => {
    const manager = fakeManager();
    manager.listLiveVms.mockRejectedValue(new Error('readdir failed'));
    expect(
      await answerScalerOrphansRequest(manager, { action: ScalerOrphansAction.enum.list }),
    ).toEqual({ ok: false, error: 'readdir failed' });
  });
});
