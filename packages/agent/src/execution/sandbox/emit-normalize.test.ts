import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '@kici-dev/sdk';
import { resolveEmitEventName, assertUserEmittableEventName } from './workflow-runner.js';

describe('resolveEmitEventName', () => {
  it('resolves a defineEvent() definition to its name', () => {
    const deployComplete = defineEvent('deploy-complete', z.object({ env: z.string() }));
    expect(resolveEmitEventName(deployComplete)).toBe('deploy-complete');
  });

  it('passes an ad-hoc event-name string through unchanged', () => {
    expect(resolveEmitEventName('build-done')).toBe('build-done');
  });
});

describe('assertUserEmittableEventName', () => {
  it('rejects a reserved kici. event name', () => {
    expect(() => assertUserEmittableEventName('kici.scaler.scale-up')).toThrow(
      /is reserved for KiCI internal events/,
    );
  });

  /**
   * `__` is a PRIVILEGE boundary: every name under it skips the event-storm rate
   * limiter, and `__schedule_fire` also dispatches as a trusted ref (no run
   * causes it). Lifecycle names inherit their run's tier, so emitting one
   * forges the exemption alone. Every minted name is listed, so an addition
   * cannot quietly fall outside the check.
   */
  it.each([
    ['__schedule_fire'],
    ['__workflow_complete'],
    ['__job_complete'],
    ['__workflows_failed_batch'],
    ['__anything_else'],
  ])('rejects the reserved internal event name %s', (name) => {
    // Not `/reserved/`: a mis-wired import's TypeError ("reservedEventNamePrefix
    // is not a function") matches that too.
    expect(() => assertUserEmittableEventName(name)).toThrow(
      /is reserved for KiCI internal events/,
    );
  });

  it('names the prefix that was actually reserved', () => {
    // The message names WHICH namespace: the two reservations have different reasons.
    expect(() => assertUserEmittableEventName('__schedule_fire')).toThrow(/"__"/);
    expect(() => assertUserEmittableEventName('kici.scaler.scale-up')).toThrow(/"kici\."/);
  });

  it('allows an ordinary custom event name', () => {
    expect(() => assertUserEmittableEventName('deploy.done')).not.toThrow();
  });

  it('allows a name that merely CONTAINS the reserved prefixes', () => {
    // Prefix, not substring: reserving too much would break working workflows
    // for no security gain.
    expect(() => assertUserEmittableEventName('deploy__done')).not.toThrow();
    expect(() => assertUserEmittableEventName('my.kici.event')).not.toThrow();
  });
});
