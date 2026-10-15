import { describe, it, expect } from 'vitest';
import { CheckMode, CheckStepOutcome } from './check-mode.js';

describe('CheckMode', () => {
  it('enumerates the three run modes', () => {
    expect(CheckMode.options).toEqual(['apply', 'check', 'check-fail-on-drift']);
  });
});

describe('CheckStepOutcome', () => {
  it('is a superset of the primitive StepOutcome', () => {
    // @kici-dev/engine cannot depend on @kici-dev/core, so the primitive outcomes
    // are inlined; they mirror StepOutcome in packages/core/src/idempotency.ts.
    const primitiveOutcomes = ['skipped', 'applied', 'declined', 'dry-run'];
    for (const o of primitiveOutcomes) expect(CheckStepOutcome.options).toContain(o);
    expect(CheckStepOutcome.options).toContain('no_check');
  });
});
