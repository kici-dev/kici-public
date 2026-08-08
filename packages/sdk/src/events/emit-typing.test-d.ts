import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { defineEvent } from './define-event.js';
import type { StepContext } from '../context.js';

const deployComplete = defineEvent(
  'deploy-complete',
  z.object({ env: z.string(), version: z.string() }),
);

describe('ctx.emit typed overload', () => {
  it('accepts a matching payload when called with a definition', () => {
    const emit = (null as unknown as StepContext).emit;
    expectTypeOf(emit).toBeCallableWith(deployComplete, {
      env: 'prod',
      version: '1.2.3',
    });
  });

  it('rejects a payload missing a schema field (definition form)', () => {
    const ctx = null as unknown as StepContext;
    // @ts-expect-error — `version` is required by the deploy-complete schema
    void ctx.emit(deployComplete, { env: 'prod' });
  });

  it('rejects a payload with a wrong field type (definition form)', () => {
    const ctx = null as unknown as StepContext;
    // @ts-expect-error — `env` must be a string, not a number
    void ctx.emit(deployComplete, { env: 1, version: '1.2.3' });
  });

  it('still accepts the string-name signature with a loose payload', () => {
    const ctx = null as unknown as StepContext;
    expectTypeOf(ctx.emit).toBeCallableWith('ad-hoc-event', { anything: true });
    expectTypeOf(ctx.emit('ad-hoc-event')).resolves.toEqualTypeOf<{
      deliveryId: string;
    }>();
  });
});
