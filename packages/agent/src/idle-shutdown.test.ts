import { describe, it, expect } from 'vitest';
import { decideIdleShutdown } from './idle-shutdown.js';

describe('decideIdleShutdown', () => {
  it('does nothing for a static agent', () => {
    expect(decideIdleShutdown({ scalerManaged: false, activeJobs: 0 })).toBe('none');
    expect(decideIdleShutdown({ scalerManaged: false, activeJobs: 0, warmPool: true })).toBe(
      'none',
    );
  });

  it('does nothing while a job is running', () => {
    expect(decideIdleShutdown({ scalerManaged: true, activeJobs: 1 })).toBe('none');
  });

  it('does not arm the idle shutdown timer for a warm agent', () => {
    expect(decideIdleShutdown({ scalerManaged: true, activeJobs: 0, warmPool: true })).toBe('warm');
  });

  it('still arms the idle shutdown timer for a non-warm idle agent', () => {
    expect(decideIdleShutdown({ scalerManaged: true, activeJobs: 0 })).toBe('idle');
  });

  it('arms the pending-dispatch safety timeout for a job-bound agent', () => {
    expect(decideIdleShutdown({ scalerManaged: true, activeJobs: 0, pendingDispatch: true })).toBe(
      'pending-dispatch',
    );
  });

  it('prefers warm over pendingDispatch when an ack carries both', () => {
    expect(
      decideIdleShutdown({
        scalerManaged: true,
        activeJobs: 0,
        pendingDispatch: true,
        warmPool: true,
      }),
    ).toBe('warm');
  });
});
