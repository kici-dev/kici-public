import { describe, it, expect } from 'vitest';
import { LocalSourceConfigSchema } from './local-source-config.js';

describe('LocalSourceConfigSchema', () => {
  it('accepts an absolute repoBasePath', () => {
    const parsed = LocalSourceConfigSchema.parse({ repoBasePath: '/srv/kici/policy-repo' });
    expect(parsed.repoBasePath).toBe('/srv/kici/policy-repo');
    expect(parsed.cloneUrlBase).toBeUndefined();
  });

  it('accepts an optional cloneUrlBase', () => {
    const parsed = LocalSourceConfigSchema.parse({
      repoBasePath: '/srv/kici/policy-repo',
      cloneUrlBase: 'git://host/path',
    });
    expect(parsed.cloneUrlBase).toBe('git://host/path');
  });

  it('rejects a relative repoBasePath', () => {
    expect(() => LocalSourceConfigSchema.parse({ repoBasePath: 'relative/path' })).toThrow();
  });

  it('rejects a missing repoBasePath', () => {
    expect(() => LocalSourceConfigSchema.parse({})).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      LocalSourceConfigSchema.parse({ repoBasePath: '/srv/kici', bogus: true }),
    ).toThrow();
  });
});
