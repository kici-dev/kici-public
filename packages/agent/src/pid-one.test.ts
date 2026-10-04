import { describe, expect, it } from 'vitest';
import { PID_ONE_WARNING, pidOneWarning } from './pid-one.js';

describe('pidOneWarning', () => {
  it('warns when the agent is PID 1', () => {
    // fails-when: an agent started with no init stays silent, and the
    // operator never learns why a step's orphans pile up.
    expect(pidOneWarning(1)).toBe(PID_ONE_WARNING);
    expect(PID_ONE_WARNING).toContain('PID 1');
  });

  it('says nothing under an init', () => {
    // breaks-if-wrong: every agent under tini, systemd or a service wrapper
    // would log a false warning.
    expect(pidOneWarning(2)).toBeUndefined();
    expect(pidOneWarning(4242)).toBeUndefined();
  });
});
