import { describe, it, expect } from 'vitest';
import { createLocalProviderBundle } from './index.js';

describe('createLocalProviderBundle', () => {
  it('defaults localInPlace to false', () => {
    const bundle = createLocalProviderBundle({ repoBasePath: '/srv/kici/repo' });
    expect(bundle.localInPlace).toBe(false);
    expect(bundle.normalizer.provider).toBe('local');
  });

  it('sets localInPlace when inPlace is true', () => {
    const bundle = createLocalProviderBundle({ repoBasePath: '/srv/kici/repo', inPlace: true });
    expect(bundle.localInPlace).toBe(true);
  });
});
