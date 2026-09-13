import { describe, it, expect } from 'vitest';
import { genericWebhook } from './index.js';

describe('genericWebhook()', () => {
  it('creates frozen config with correct _tag', () => {
    const trigger = genericWebhook({ source: 'my-service' });
    expect(trigger._tag).toBe('GenericWebhookTrigger');
    expect(trigger.source).toBe('my-service');
    expect(Object.isFrozen(trigger)).toBe(true);
  });

  it('requires source field', () => {
    const trigger = genericWebhook({ source: 'slack' });
    expect(trigger.source).toBe('slack');
  });

  it('throws on empty source', () => {
    expect(() => genericWebhook({ source: '' })).toThrow('non-empty source');
  });

  it('throws on whitespace-only source', () => {
    expect(() => genericWebhook({ source: '   ' })).toThrow('non-empty source');
  });

  it('supports optional events with frozen array', () => {
    const trigger = genericWebhook({ source: 'my-service', events: ['deploy', 'rollback'] });
    expect(trigger.events).toEqual(['deploy', 'rollback']);
    expect(Object.isFrozen(trigger.events)).toBe(true);
  });

  it('supports optional match field', () => {
    const trigger = genericWebhook({ source: 'svc', match: { '$.env': 'prod' } });
    expect(trigger.match).toEqual({ '$.env': 'prod' });
  });

  it('supports optional not field', () => {
    const trigger = genericWebhook({ source: 'svc', not: { '$.dry_run': true } });
    expect(trigger.not).toEqual({ '$.dry_run': true });
  });

  it('supports optional description', () => {
    const trigger = genericWebhook({ source: 'svc', description: 'My service webhooks' });
    expect(trigger.description).toBe('My service webhooks');
  });

  it('omits undefined optional fields', () => {
    const trigger = genericWebhook({ source: 'svc' });
    expect('events' in trigger).toBe(false);
    expect('match' in trigger).toBe(false);
    expect('not' in trigger).toBe(false);
    expect('description' in trigger).toBe(false);
  });

  it('includes all provided fields', () => {
    const trigger = genericWebhook({
      source: 'my-service',
      events: ['deploy'],
      match: { '$.env': 'prod' },
      not: { '$.dry_run': true },
      description: 'Prod deploys only',
    });
    expect(trigger).toEqual({
      _tag: 'GenericWebhookTrigger',
      source: 'my-service',
      events: ['deploy'],
      match: { '$.env': 'prod' },
      not: { '$.dry_run': true },
      description: 'Prod deploys only',
    });
  });

  it('supports HMAC-SHA256 auth config', () => {
    const trigger = genericWebhook({
      source: 'stripe',
      auth: {
        method: 'hmac-sha256',
        secret: 'stripe-key',
        signatureHeader: 'stripe-signature',
      },
    });
    expect(trigger.auth).toEqual({
      method: 'hmac-sha256',
      secret: 'stripe-key',
      signatureHeader: 'stripe-signature',
    });
  });

  it('supports API key auth config', () => {
    const trigger = genericWebhook({
      source: 'slack',
      auth: {
        method: 'api-key',
        secret: 'slack-token',
      },
    });
    expect(trigger.auth).toEqual({
      method: 'api-key',
      secret: 'slack-token',
    });
  });

  it('supports API key auth with custom header', () => {
    const trigger = genericWebhook({
      source: 'custom',
      auth: {
        method: 'api-key',
        secret: 'my-token',
        header: 'x-api-key',
      },
    });
    expect(trigger.auth).toEqual({
      method: 'api-key',
      secret: 'my-token',
      header: 'x-api-key',
    });
  });

  it('freezes auth config on output', () => {
    const trigger = genericWebhook({
      source: 'stripe',
      auth: {
        method: 'hmac-sha256',
        secret: 'stripe-key',
        signatureHeader: 'stripe-signature',
      },
    });
    expect(Object.isFrozen(trigger.auth)).toBe(true);
  });

  it('supports path pattern', () => {
    const trigger = genericWebhook({
      source: 'stripe',
      path: 'stripe/payments',
    });
    expect(trigger.path).toBe('stripe/payments');
  });

  it('omits auth and path when not provided', () => {
    const trigger = genericWebhook({ source: 'svc' });
    expect('auth' in trigger).toBe(false);
    expect('path' in trigger).toBe(false);
  });

  it('defensively copies and freezes match and not objects', () => {
    const matchObj = { '$.env': 'prod' } as Record<string, unknown>;
    const notObj = { '$.dry_run': true } as Record<string, unknown>;
    const trigger = genericWebhook({ source: 'svc', match: matchObj, not: notObj });

    // Mutating the original should not affect the trigger config
    matchObj['$.env'] = 'staging';
    notObj['$.dry_run'] = false;

    expect(trigger.match).toEqual({ '$.env': 'prod' });
    expect(trigger.not).toEqual({ '$.dry_run': true });
    expect(Object.isFrozen(trigger.match)).toBe(true);
    expect(Object.isFrozen(trigger.not)).toBe(true);
  });

  it('includes all fields including auth and path', () => {
    const trigger = genericWebhook({
      source: 'stripe',
      events: ['payment.success'],
      auth: {
        method: 'hmac-sha256',
        secret: 'stripe-key',
        signatureHeader: 'stripe-signature',
      },
      path: 'stripe/payments',
      description: 'Stripe payment hooks',
    });
    expect(trigger).toEqual({
      _tag: 'GenericWebhookTrigger',
      source: 'stripe',
      events: ['payment.success'],
      auth: {
        method: 'hmac-sha256',
        secret: 'stripe-key',
        signatureHeader: 'stripe-signature',
      },
      path: 'stripe/payments',
      description: 'Stripe payment hooks',
    });
  });
});
