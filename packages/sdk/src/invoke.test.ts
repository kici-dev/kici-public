import { describe, it, expect } from 'vitest';
import { invokeSource } from './invoke.js';

describe('invokeSource', () => {
  it('builds a frozen source-scoped invoke config, required by default', () => {
    const cfg = invokeSource('myorg.repo-tests');
    expect(cfg).toEqual({ _tag: 'InvokeSource', event: 'myorg.repo-tests', scope: 'source' });
    expect(cfg.optional).toBeUndefined(); // absence == required
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('carries an optional payload', () => {
    const cfg = invokeSource('myorg.repo-tests', { payload: { sha: 'abc' } });
    expect(cfg.payload).toEqual({ sha: 'abc' });
  });

  it('carries optional:true when a repo may opt out', () => {
    const cfg = invokeSource('myorg.repo-tests', { optional: true });
    expect(cfg.optional).toBe(true);
  });

  it('rejects an empty event name', () => {
    expect(() => invokeSource('')).toThrow(/event name/i);
  });

  /**
   * A gate is a workflow-authored emit, so the same reservation `ctx.emit`
   * enforces applies: `__` names the orchestrator's own events, and `kici.`
   * names KiCI system events. Every name under either prefix skips the
   * event-storm rate limiter, and `__schedule_fire` is dispatched as a trusted
   * ref on top of that. Failing here means the author sees it at compile time;
   * the orchestrator refuses it again at dispatch.
   */
  it.each([
    ['__schedule_fire', '__'],
    ['__workflow_complete', '__'],
    ['kici.scaler.scale-up', 'kici.'],
  ])('rejects the reserved event name %s', (event, prefix) => {
    expect(() => invokeSource(event)).toThrow(
      `invokeSource: event name prefix "${prefix}" is reserved for KiCI internal events (got "${event}")`,
    );
  });

  it('allows a name that merely contains a reserved prefix', () => {
    // Prefix, not substring — reserving more would break working workflows for
    // no security gain. Also the control for the case above.
    expect(invokeSource('deploy__done').event).toBe('deploy__done');
    expect(invokeSource('my.kici.event').event).toBe('my.kici.event');
  });
});
