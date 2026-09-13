import { describe, expect, it } from 'vitest';
import {
  PING_EVENT_TYPE,
  SUBSCRIBABLE_WEBHOOK_EVENT_TYPES,
  SubscribableWebhookEventType,
  WebhookEventType,
} from './event-types.js';

describe('webhook event-types', () => {
  it('full enum has the 6 subscribable values plus ping', () => {
    expect([...WebhookEventType.options].sort()).toEqual(
      [
        'job.completed',
        'job.failed',
        'job.started',
        'ping',
        'run.completed',
        'run.failed',
        'run.started',
      ].sort(),
    );
  });

  it('subscribable set excludes ping and has 6 members', () => {
    expect(SUBSCRIBABLE_WEBHOOK_EVENT_TYPES).toHaveLength(6);
    expect(SUBSCRIBABLE_WEBHOOK_EVENT_TYPES).not.toContain(PING_EVENT_TYPE);
  });

  it('exposes exactly the subscribable validator options, in order', () => {
    expect([...SUBSCRIBABLE_WEBHOOK_EVENT_TYPES]).toEqual([
      ...SubscribableWebhookEventType.options,
    ]);
  });

  it('is a frozen copy, not the live mutable validator options array', () => {
    expect(Object.isFrozen(SUBSCRIBABLE_WEBHOOK_EVENT_TYPES)).toBe(true);
    expect(SUBSCRIBABLE_WEBHOOK_EVENT_TYPES).not.toBe(SubscribableWebhookEventType.options);
  });

  it('subscribable is a subset of the full enum', () => {
    for (const t of SUBSCRIBABLE_WEBHOOK_EVENT_TYPES) {
      expect(WebhookEventType.options).toContain(t);
    }
  });

  it('full = subscribable + the ping type', () => {
    expect([...WebhookEventType.options].sort()).toEqual(
      [...SUBSCRIBABLE_WEBHOOK_EVENT_TYPES, PING_EVENT_TYPE].sort(),
    );
  });

  it('the ping type is a member of the full enum', () => {
    expect(WebhookEventType.options).toContain(PING_EVENT_TYPE);
  });

  it('subscribable validator accepts a subscribable value', () => {
    expect(SubscribableWebhookEventType.parse('run.started')).toBe('run.started');
  });

  it('subscribable validator rejects ping and unknown values', () => {
    expect(SubscribableWebhookEventType.safeParse(PING_EVENT_TYPE).success).toBe(false);
    expect(SubscribableWebhookEventType.safeParse('bogus').success).toBe(false);
  });

  it('full validator accepts ping and rejects unknown values', () => {
    expect(WebhookEventType.parse(PING_EVENT_TYPE)).toBe('ping');
    expect(WebhookEventType.safeParse('bogus').success).toBe(false);
  });
});
