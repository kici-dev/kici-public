import { describe, it, expect } from 'vitest';
import { describeEvent } from './describe-event.js';

describe('describeEvent', () => {
  it('returns "push" for a push trigger', () => {
    expect(describeEvent({ _type: 'push' })).toBe('push');
  });

  it('returns "pr:<action>" for a pr trigger, defaulting to open', () => {
    expect(describeEvent({ _type: 'pr', action: 'synchronize' })).toBe('pr:synchronize');
    expect(describeEvent({ _type: 'pr' })).toBe('pr:open');
  });

  it('returns the raw _type for other string types', () => {
    expect(describeEvent({ _type: 'schedule' })).toBe('schedule');
  });

  it('returns "custom" when _type is not a string', () => {
    expect(describeEvent({ foo: 'bar' })).toBe('custom');
  });

  it('returns "unknown" for non-object input', () => {
    expect(describeEvent(null)).toBe('unknown');
    expect(describeEvent('nope')).toBe('unknown');
  });
});
