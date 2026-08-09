import { describe, expect, it } from 'vitest';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { classifyUnroutable, unroutableMessage } from './terminalize-unroutable.js';

const base = {
  lastProvisioningError: null,
  runsOnLabels: ['linux', 'gpu'],
  runsOnPatterns: [],
  excludeLabels: [],
  excludePatterns: [],
};

describe('classifyUnroutable', () => {
  it('is unroutable when nothing in the fleet can route the labels', () => {
    const r = classifyUnroutable(base, () => false);
    expect(r.unroutable).toBe(true);
    expect(r.status).toBe(ExecutionJobStatus.enum.unroutable);
    expect(r.errorMessage).toContain('runsOn [linux, gpu]');
  });

  it('is timed_out_stale when something could route it', () => {
    const r = classifyUnroutable(base, () => true);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
  });

  it('is never unroutable when a provisioning error was recorded', () => {
    // The scaler got far enough to attempt (and fail) a spawn, so the labels
    // DID route — the real cause is that failure, not the `runsOn`.
    const r = classifyUnroutable(
      { ...base, lastProvisioningError: 'image pull failed' },
      () => false,
    );
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toBe('image pull failed');
  });

  it('falls back to timed_out_stale when no probe is wired', () => {
    const r = classifyUnroutable(base, undefined);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toContain('Queue timeout expired');
  });

  it('renders regex matchers readably rather than as [object Object]', () => {
    const r = classifyUnroutable(
      {
        ...base,
        runsOnLabels: [],
        runsOnPatterns: [{ kind: 'regex', source: 'gpu-.*', flags: 'i' }],
      },
      () => false,
    );
    expect(r.errorMessage).toContain('/gpu-.*/i');
    expect(r.errorMessage).not.toContain('[object Object]');
  });
});

describe('unroutableMessage', () => {
  it('names the excluded selectors when the job has any', () => {
    const msg = unroutableMessage({ ...base, excludeLabels: ['spot'] });
    expect(msg).toContain('runsOn [linux, gpu]');
    expect(msg).toContain('excluding [spot]');
  });

  it('says any agent would do when the job declares no runsOn', () => {
    const msg = unroutableMessage({ ...base, runsOnLabels: [] });
    expect(msg).toContain('it declares no runsOn, so any agent would do');
  });
});
