import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { defineDispatchInputs } from './dispatch-inputs.js';

describe('defineDispatchInputs', () => {
  const inputs = defineDispatchInputs({
    target: z.string().optional(),
    skipCveScan: z.boolean().default(false),
    mode: z.enum(['full', 'edge-only']).default('full'),
  });

  it('is accepted as a dispatch inputs handle', () => {
    expect(inputs.__kiciDispatchInputs).toBe(true);
    expect(Object.keys(inputs.map)).toEqual(['target', 'skipCveScan', 'mode']);
  });

  it('from(ctx) returns the runtime dispatchInputs values', () => {
    const ctx = { dispatchInputs: { skipCveScan: true, mode: 'full' } };
    expect(inputs.from(ctx)).toEqual({ skipCveScan: true, mode: 'full' });
  });

  it('from(ctx) returns {} when no dispatchInputs present', () => {
    expect(inputs.from({})).toEqual({});
  });

  it('from(ctx) is typed per-key', () => {
    const ctx = { dispatchInputs: {} };
    expectTypeOf(inputs.from(ctx).skipCveScan).toEqualTypeOf<boolean>();
    expectTypeOf(inputs.from(ctx).mode).toEqualTypeOf<'full' | 'edge-only'>();
    expectTypeOf(inputs.from(ctx).target).toEqualTypeOf<string | undefined>();
  });
});
