import { describe, it, expect, expectTypeOf } from 'vitest';
import type { StepSecretsTyped, KnownSecretKeys, RepoInfo, StepContext } from './context.js';
import { isMatrixJobOutputs, isHostJobOutputs } from './context.js';
import type { StepSecrets } from './secrets.js';

describe('isMatrixJobOutputs', () => {
  it('returns true for a matrix outputs envelope', () => {
    expect(isMatrixJobOutputs({ byMatrix: { a: { v: '1' } }, merged: { v: '1' } })).toBe(true);
  });

  it('returns false for a flat outputs object', () => {
    expect(isMatrixJobOutputs({ version: '1.2.3' })).toBe(false);
  });

  it('returns false when byMatrix is not an object', () => {
    expect(isMatrixJobOutputs({ byMatrix: 'nope', merged: {} } as never)).toBe(false);
  });

  it('returns false for a host envelope', () => {
    expect(
      isMatrixJobOutputs({
        byHost: {},
        summary: { succeededHosts: [], failedHosts: [], outputs: {} },
      }),
    ).toBe(false);
  });
});

describe('isHostJobOutputs', () => {
  it('returns true for a host outputs envelope', () => {
    expect(
      isHostJobOutputs({
        byHost: { 'web-01': { v: '1' } },
        summary: { succeededHosts: ['web-01'], failedHosts: [], outputs: { v: ['1'] } },
      }),
    ).toBe(true);
  });

  it('returns false for a flat outputs object', () => {
    expect(isHostJobOutputs({ version: '1.2.3' })).toBe(false);
  });

  it('returns false for a matrix envelope', () => {
    expect(isHostJobOutputs({ byMatrix: { a: { v: '1' } }, merged: { v: '1' } })).toBe(false);
  });
});

describe('context types', () => {
  describe('KnownSecretKeys', () => {
    it('KnownSecretKeys is an empty interface by default', () => {
      expectTypeOf<KnownSecretKeys>().toEqualTypeOf<KnownSecretKeys>();
      // Verify it has no keys when not augmented
      expectTypeOf<keyof KnownSecretKeys>().toEqualTypeOf<never>();
    });
  });

  describe('StepSecrets (unaugmented)', () => {
    it('has get method returning Promise<string>', () => {
      expectTypeOf<StepContext['secrets']['get']>().toBeFunction();
      expectTypeOf<StepContext['secrets']['get']>().returns.toEqualTypeOf<Promise<string>>();
    });

    it('has expose method returning Promise<void>', () => {
      expectTypeOf<StepContext['secrets']['expose']>().toBeFunction();
      expectTypeOf<StepContext['secrets']['expose']>().returns.toEqualTypeOf<Promise<void>>();
    });

    it('has has method returning boolean', () => {
      expectTypeOf<StepContext['secrets']['has']>().toBeFunction();
      expectTypeOf<StepContext['secrets']['has']>().parameter(0).toBeString();
      expectTypeOf<StepContext['secrets']['has']>().returns.toBeBoolean();
    });

    it('StepSecretsTyped equals StepSecrets when unaugmented', () => {
      expectTypeOf<StepSecretsTyped>().toEqualTypeOf<StepSecrets>();
    });
  });

  describe('RepoInfo', () => {
    it('has required identifier and path fields', () => {
      expectTypeOf<RepoInfo['identifier']>().toBeString();
      expectTypeOf<RepoInfo['path']>().toBeString();
    });

    it('has optional ref and sha fields', () => {
      expectTypeOf<RepoInfo['ref']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<RepoInfo['sha']>().toEqualTypeOf<string | undefined>();
    });
  });

  describe('StepContext.workflowRepo and sourceRepo', () => {
    it('workflowRepo is optional RepoInfo', () => {
      expectTypeOf<StepContext['workflowRepo']>().toEqualTypeOf<RepoInfo | undefined>();
    });

    it('sourceRepo is optional RepoInfo', () => {
      expectTypeOf<StepContext['sourceRepo']>().toEqualTypeOf<RepoInfo | undefined>();
    });
  });

  describe('StepContext.environment', () => {
    it('has environment property that is string or undefined', () => {
      expectTypeOf<StepContext['environment']>().toEqualTypeOf<string | undefined>();
    });

    it('does not have contexts property', () => {
      type HasContexts = 'contexts' extends keyof StepContext ? true : false;
      expectTypeOf<HasContexts>().toEqualTypeOf<false>();
    });

    it('still has secrets property with StepSecrets type', () => {
      expectTypeOf<StepContext['secrets']>().toEqualTypeOf<StepSecrets>();
    });
  });

  describe('StepContext.needs', () => {
    it('exposes an optional needs map', () => {
      expectTypeOf<StepContext['needs']>().toEqualTypeOf<
        import('./needs-context.js').NeedsContext | undefined
      >();
    });
  });
});

describe('dispatchInputs on contexts', () => {
  it('StepContext + RuleContext expose dispatchInputs', () => {
    expectTypeOf<StepContext>().toHaveProperty('dispatchInputs');
    expectTypeOf<import('./rules/types.js').RuleContext>().toHaveProperty('dispatchInputs');
  });
});

describe('ctx.fanout', () => {
  it('is present on step + rule contexts as FanoutPosition | undefined', () => {
    expectTypeOf<StepContext['fanout']>().toEqualTypeOf<
      import('./fanout-context.js').FanoutPosition | undefined
    >();
    expectTypeOf<import('./rules/types.js').RuleContext['fanout']>().toEqualTypeOf<
      import('./fanout-context.js').FanoutPosition | undefined
    >();
  });
});
