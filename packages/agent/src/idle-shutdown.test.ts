import { describe, it, expect } from 'vitest';
import { decideIdleShutdown, idleShutdownDelayMs } from './idle-shutdown.js';

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

describe('decideIdleShutdown for a single-job agent', () => {
  it('shuts down a single-job agent that has run its job, even when acked as warm', () => {
    // fails-when: a single-job agent that reconnects after its job stays up as a
    // warm agent, draining, where the warm-pool reaper never looks
    expect(
      decideIdleShutdown({
        scalerManaged: true,
        activeJobs: 0,
        warmPool: true,
        singleJobServed: true,
      }),
    ).toBe('idle');
    // breaks-if-wrong: a warm single-job agent that has not run its job waits for work
    expect(
      decideIdleShutdown({
        scalerManaged: true,
        activeJobs: 0,
        warmPool: true,
        singleJobServed: false,
      }),
    ).toBe('warm');
  });
});

describe('idleShutdownDelayMs', () => {
  it('exits at once once a single-job agent has run its job', () => {
    // fails-when: a single-job agent waits out the idle window and stays offerable
    expect(
      idleShutdownDelayMs({ scalerIdleTimeoutMs: 5000, singleJob: true, servedJob: true }),
    ).toBe(0);
  });

  it('keeps the idle window for every other agent', () => {
    // breaks-if-wrong: an ordinary scaler agent loses its follow-up window
    expect(
      idleShutdownDelayMs({ scalerIdleTimeoutMs: 5000, singleJob: false, servedJob: true }),
    ).toBe(5000);
    // A single-job agent that has not run a job yet (warm, or reconnecting) waits too.
    expect(
      idleShutdownDelayMs({ scalerIdleTimeoutMs: 5000, singleJob: true, servedJob: false }),
    ).toBe(5000);
  });
});
