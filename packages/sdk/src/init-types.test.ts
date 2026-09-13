import { describe, it, expect, expectTypeOf } from 'vitest';
import { job } from './job.js';
import type { InitConfig, MiseInitConfig, GenericInitConfig } from './types.js';

describe('init union types', () => {
  it('accepts string preset, object preset, auto, generic, arrays, false', () => {
    expectTypeOf<'mise'>().toMatchTypeOf<InitConfig>();
    expectTypeOf<{ mise: MiseInitConfig }>().toMatchTypeOf<InitConfig>();
    expectTypeOf<'auto'>().toMatchTypeOf<InitConfig>();
    expectTypeOf<GenericInitConfig>().toMatchTypeOf<InitConfig>();
    expectTypeOf<Array<'mise' | GenericInitConfig>>().toMatchTypeOf<InitConfig>();
    expectTypeOf<false>().toMatchTypeOf<InitConfig>();
  });

  it('rejects an unknown preset string', () => {
    // @ts-expect-error 'nix' is not a valid preset until the nix provider lands
    const bad: InitConfig = 'nix';
    void bad;
  });

  it('threads a string preset through job()', () => {
    const j = job('build', { runsOn: 'linux', init: 'mise', steps: [] });
    expect(j.init).toBe('mise');
  });

  it('threads an object preset with overrides through job()', () => {
    const j = job('build', {
      runsOn: 'linux',
      init: { mise: { timeout: 300_000, cache: false } },
      steps: [],
    });
    expect(j.init).toEqual({ mise: { timeout: 300_000, cache: false } });
  });
});
