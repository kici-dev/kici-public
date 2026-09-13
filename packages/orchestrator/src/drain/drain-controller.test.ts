import { describe, it, expect, vi } from 'vitest';
import { DrainController } from './drain-controller.js';

const makeCtrl = (active = 0, dispatched = 0, onChange?: (d: boolean) => void) =>
  new DrainController({
    activeJobsTotal: () => active,
    dispatchedJobsOwned: async () => dispatched,
    onChange,
  });

describe('DrainController', () => {
  it('defaults to not draining', () => {
    expect(makeCtrl().isDraining()).toBe(false);
  });

  it('startDrain / stopDrain are idempotent', () => {
    const c = makeCtrl();
    c.startDrain();
    c.startDrain();
    expect(c.isDraining()).toBe(true);
    c.stopDrain();
    c.stopDrain();
    expect(c.isDraining()).toBe(false);
  });

  it('onChange fires only on an actual transition', () => {
    const onChange = vi.fn();
    const c = makeCtrl(0, 0, onChange);
    c.startDrain();
    c.startDrain(); // no-op
    c.stopDrain();
    c.stopDrain(); // no-op
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('jobsRunning takes the max of live active jobs and owned Dispatched rows', async () => {
    const c = makeCtrl(3, 2);
    expect(await c.jobsRunning()).toBe(3);
  });

  it('jobsRunning catches the race window where Dispatched leads activeJobs', async () => {
    const c = makeCtrl(0, 2);
    expect(await c.jobsRunning()).toBe(2);
  });

  it('snapshot reflects draining + jobsRunning', async () => {
    const c = makeCtrl(1, 0);
    c.startDrain();
    expect(await c.snapshot()).toEqual({ draining: true, jobsRunning: 1 });
  });
});
