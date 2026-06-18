import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEvent } from './define-event.js';

describe('defineEvent()', () => {
  it('creates a frozen EventDefinition', () => {
    const event = defineEvent('deploy-complete', z.object({ env: z.string() }));
    expect(event._tag).toBe('EventDefinition');
    expect(event.name).toBe('deploy-complete');
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('attaches schema for validation', () => {
    const schema = z.object({ env: z.string(), version: z.string() });
    const event = defineEvent('deploy', schema);

    const valid = event.schema.safeParse({ env: 'prod', version: '1.0.0' });
    expect(valid.success).toBe(true);

    const invalid = event.schema.safeParse({ env: 123 });
    expect(invalid.success).toBe(false);
  });

  it('works with string schema', () => {
    const event = defineEvent('simple-event', z.string());
    expect(event.name).toBe('simple-event');

    const valid = event.schema.safeParse('hello');
    expect(valid.success).toBe(true);

    const invalid = event.schema.safeParse(123);
    expect(invalid.success).toBe(false);
  });

  it('works with number schema', () => {
    const event = defineEvent('counter', z.number().int().positive());
    expect(event.name).toBe('counter');

    const valid = event.schema.safeParse(42);
    expect(valid.success).toBe(true);

    const invalid = event.schema.safeParse(-1);
    expect(invalid.success).toBe(false);
  });

  it('works with complex object schema', () => {
    const schema = z.object({
      env: z.string(),
      services: z.array(z.string()),
      metadata: z.object({
        region: z.string(),
        timestamp: z.number(),
      }),
    });

    const event = defineEvent('complex-deploy', schema);
    expect(event._tag).toBe('EventDefinition');

    const valid = event.schema.safeParse({
      env: 'prod',
      services: ['api', 'web'],
      metadata: { region: 'us-east-1', timestamp: Date.now() },
    });
    expect(valid.success).toBe(true);
  });

  it('preserves schema type inference', () => {
    const event = defineEvent(
      'typed',
      z.object({
        count: z.number(),
        label: z.string(),
      }),
    );

    // Schema parse returns correctly typed data
    const result = event.schema.parse({ count: 1, label: 'test' });
    expect(result.count).toBe(1);
    expect(result.label).toBe('test');
  });
});
