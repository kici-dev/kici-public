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
   * The `__` namespace is a PRIVILEGE boundary, not a naming convention: every
   * name under it skips the event-storm rate limiter, and `__schedule_fire` is
   * additionally dispatched as a trusted ref (no run causes it), so a step that
   * could emit `__schedule_fire` would grant itself both. The lifecycle names
   * inherit the tier of the run behind them, so emitting one forges the
   * exemption alone. Each minted name is listed rather than one representative
   * so a future addition cannot quietly fall outside the check.
   */
  it.each([
    ['__schedule_fire'],
    ['__workflow_complete'],
    ['__job_complete'],
    ['__workflows_failed_batch'],
    ['__anything_else'],
  ])('rejects the reserved internal event name %s', (name) => {
    // The full phrase, not `/reserved/`: a TypeError from a mis-wired import
    // reads "reservedEventNamePrefix is not a function" and matches the loose
    // pattern, so the loose pattern proves nothing.
    expect(() => assertUserEmittableEventName(name)).toThrow(
      /is reserved for KiCI internal events/,
    );
  });

  it('names the prefix that was actually reserved', () => {
    // The message has to tell the author WHICH namespace they hit — the two
    // reservations have different reasons, and a generic "reserved" leaves them
    // guessing.
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
