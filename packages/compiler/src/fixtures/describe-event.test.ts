import { describe, it, expect } from 'vitest';
import { push, pr, schedule, webhook } from '@kici-dev/sdk';
import { describeEvent } from './describe-event.js';

describe('describeEvent', () => {
  it('returns "push" for a push trigger', () => {
    expect(describeEvent({ _tag: 'PushTrigger' })).toBe('push');
  });

  it('returns "pr:<event>" for a pr trigger with events', () => {
    expect(describeEvent({ _tag: 'PrTrigger', events: ['synchronize'] })).toBe('pr:synchronize');
  });

  it('returns "pr" for a pr trigger with no events', () => {
    expect(describeEvent({ _tag: 'PrTrigger', events: [] })).toBe('pr');
  });

  it('returns the mapped label for other tags', () => {
    expect(describeEvent({ _tag: 'ScheduleTrigger' })).toBe('schedule');
    expect(describeEvent({ _tag: 'WebhookTrigger' })).toBe('webhook');
    expect(describeEvent({ _tag: 'TagTrigger' })).toBe('tag');
  });

  it('renders real trigger configs produced by the SDK factories', () => {
    // The actual runtime shape a fixture carries: `event: push(...)` etc.
    expect(describeEvent(push({ branches: ['main'] }))).toBe('push');
    expect(describeEvent(pr({ events: ['opened'] }))).toBe('pr:opened');
    expect(describeEvent(schedule({ cron: '0 0 * * *' }))).toBe('schedule');
    expect(describeEvent(webhook({ events: ['deploy'] }))).toBe('webhook');
  });

  it('returns "custom" for an unrecognized or missing tag', () => {
    expect(describeEvent({ _tag: 'NotARealTrigger' })).toBe('custom');
    expect(describeEvent({ foo: 'bar' })).toBe('custom');
  });

  it('returns "unknown" for non-object input', () => {
    expect(describeEvent(null)).toBe('unknown');
    expect(describeEvent('nope')).toBe('unknown');
  });
});
