import { describe, expect, it } from 'vitest';
import { ScalerVmStatus, ScalerVmTracker } from '@kici-dev/engine';
import { classifyLiveVm, ORPHANED_REASON, type LiveVmProbe } from './live-vms.js';

const probe = (over: Partial<LiveVmProbe> = {}): LiveVmProbe => ({
  vmId: 'scaler-firecracker-1',
  scaler: 'fc',
  pid: 7,
  startedAtMs: 1_000,
  chrootDir: '/srv/jailer/firecracker/scaler-firecracker-1/root',
  identityConfirmed: true,
  ...over,
});

describe('classifyLiveVm', () => {
  it('untracked + confirmed → orphaned, with its age', () => {
    const vm = classifyLiveVm(probe(), [], 61_000);
    expect(vm).toEqual({
      vmId: 'scaler-firecracker-1',
      scaler: 'fc',
      pid: 7,
      startedAt: new Date(1_000).toISOString(),
      ageSeconds: 60,
      chrootDir: '/srv/jailer/firecracker/scaler-firecracker-1/root',
      status: ScalerVmStatus.enum.orphaned,
      trackedBy: [],
      reason: ORPHANED_REASON,
    });
  });

  it('any tracker → tracked, naming it', () => {
    for (const tracker of ScalerVmTracker.options) {
      const vm = classifyLiveVm(probe(), [tracker]);
      expect(vm.status).toBe(ScalerVmStatus.enum.tracked);
      expect(vm.trackedBy).toEqual([tracker]);
      expect(vm.reason).toBe(`tracked: ${tracker}`);
    }
  });

  it('names each tracker once', () => {
    const vm = classifyLiveVm(probe(), [
      ScalerVmTracker.enum.backend,
      ScalerVmTracker.enum.backend,
      ScalerVmTracker.enum.registered,
    ]);
    expect(vm.trackedBy).toEqual([ScalerVmTracker.enum.backend, ScalerVmTracker.enum.registered]);
  });

  it('untracked + unconfirmed → unverified with the probe detail', () => {
    const vm = classifyLiveVm(probe({ identityConfirmed: false, detail: 'comm="sleep"' }), []);
    expect(vm.status).toBe(ScalerVmStatus.enum.unverified);
    expect(vm.reason).toContain('comm="sleep"');
  });

  // fails-when: an unverified identity outranks a tracker
  it('tracked wins over unverified', () => {
    const vm = classifyLiveVm(probe({ identityConfirmed: false, detail: 'x' }), [
      ScalerVmTracker.enum.spawning,
    ]);
    expect(vm.status).toBe(ScalerVmStatus.enum.tracked);
  });

  it('never reports a negative age for a clock that moved backwards', () => {
    expect(classifyLiveVm(probe({ startedAtMs: 5_000 }), [], 1_000).ageSeconds).toBe(0);
  });
});
