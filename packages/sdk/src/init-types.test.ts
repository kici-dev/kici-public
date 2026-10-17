import { describe, it, expect, expectTypeOf } from 'vitest';
import { job } from './job.js';
import type { AptInitConfig, InitConfig, MiseInitConfig, GenericInitConfig } from './types.js';

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

describe('mise preset version', () => {
  it('types version as an optional string', () => {
    expectTypeOf<MiseInitConfig['version']>().toEqualTypeOf<string | undefined>();
  });

  it.each(['2026.5.1', 'v2026.5.1', 'v2026.10.12'])(
    'accepts %s and threads it through job()',
    (version) => {
      const j = job('build', { runsOn: 'linux', init: { mise: { version } }, steps: [] });
      expect(j.init).toEqual({ mise: { version } });
    },
  );

  it.each(['latest', '2026.5', 'v2026.5.1; rm -rf /', '', '26.5.1', 'v2026.5.1-rc1'])(
    'rejects %j at job() time',
    (version) => {
      // fails-when: job() does not validate mise.version (the call returns a job)
      expect(() =>
        job('build', { runsOn: 'linux', init: { mise: { version } }, steps: [] }),
      ).toThrow(/init\[0\]\.mise\.version must be a mise release/);
    },
  );

  it('names the failing array index', () => {
    expect(() =>
      job('build', {
        runsOn: 'linux',
        init: [{ run: 'true' }, { mise: { version: 'bad' } }],
        steps: [],
      }),
    ).toThrow(/init\[1\]\.mise\.version/);
  });

  it('still validates a generic run beside a pinned preset', () => {
    // breaks-if-wrong: the preset branch swallows the generic-run check for later items
    expect(() =>
      job('build', {
        runsOn: 'linux',
        init: [{ mise: { version: '2026.5.1' } }, { run: '  ' }],
        steps: [],
      }),
    ).toThrow(/init\[1\]\.run must be a non-empty command/);
  });
});

describe('normalizeMiseVersion', () => {
  it('strips the tag v and refuses anything else', async () => {
    const { normalizeMiseVersion } = await import('./internal.js');
    expect(normalizeMiseVersion('v2026.5.1')).toBe('2026.5.1');
    expect(normalizeMiseVersion('2026.5.1')).toBe('2026.5.1');
    // fails-when: the pattern is unanchored and a shell suffix rides along
    expect(normalizeMiseVersion('2026.5.1 && curl evil')).toBeUndefined();
  });
});

describe('apt preset', () => {
  it('is an init preset', () => {
    expectTypeOf<{ apt: AptInitConfig }>().toMatchTypeOf<InitConfig>();
    expectTypeOf<AptInitConfig['cache']>().toEqualTypeOf<boolean | undefined>();
  });

  it.each([
    ['make'],
    ['build-essential', 'libssl-dev'],
    ['g++'],
    ['make=4.4.1-2'],
    ['libc6=2.41-12+deb13u1'],
  ])('threads %j through job()', (...packages) => {
    // breaks-if-wrong: a real Debian name or pin is refused
    const j = job('build', { runsOn: 'linux', init: { apt: { packages } }, steps: [] });
    expect(j.init).toEqual({ apt: { packages } });
  });

  it.each(['Make', 'm', '-make', 'make; rm -rf /', 'make=', 'make=latest', 'make tree', ''])(
    'rejects %j at job() time',
    (bad) => {
      // fails-when: job() lets a name through that the agent would hand to apt-get
      expect(() =>
        job('build', { runsOn: 'linux', init: { apt: { packages: ['make', bad] } }, steps: [] }),
      ).toThrow(/init\[0\]\.apt\.packages\[1\] must be a Debian package name/);
    },
  );

  it('rejects an empty list and a non-boolean cache', () => {
    expect(() => job('b', { runsOn: 'linux', init: { apt: { packages: [] } }, steps: [] })).toThrow(
      /init\[0\]\.apt\.packages must list at least one Debian package/,
    );
    expect(() =>
      job('b', {
        runsOn: 'linux',
        init: [{ run: 'true' }, { apt: { packages: ['make'], cache: 'yes' as never } }],
        steps: [],
      }),
    ).toThrow(/init\[1\]\.apt\.cache must be true or false/);
  });

  it('still validates a generic run beside an apt preset', () => {
    // breaks-if-wrong: the apt branch swallows the generic-run check
    expect(() =>
      job('b', {
        runsOn: 'linux',
        init: [{ apt: { packages: ['make'] } }, { run: ' ' }],
        steps: [],
      }),
    ).toThrow(/init\[1\]\.run must be a non-empty command/);
  });
});

describe('isAptPackageSpec', () => {
  it('anchors both ends', async () => {
    const { isAptPackageSpec } = await import('./internal.js');
    expect(isAptPackageSpec('make')).toBe(true);
    // fails-when: the pattern is unanchored and a shell suffix rides along
    expect(isAptPackageSpec('make && curl evil')).toBe(false);
    expect(isAptPackageSpec('make=4.4.1-2\nrm')).toBe(false);
  });
});
