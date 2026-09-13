import { describe, it, expect } from 'vitest';
import { CacheRefScope } from '@kici-dev/engine';
import type { TrustResolution } from '../security/trust-resolver.js';
import { deriveCacheRefScope } from './dispatch-matched-workflow.js';

function trust(tier: TrustResolution['tier']): TrustResolution {
  return { tier } as TrustResolution;
}

describe('deriveCacheRefScope', () => {
  it('maps a trusted ref to the shared scope', () => {
    expect(deriveCacheRefScope(trust('trusted'))).toBe(CacheRefScope.enum.shared);
  });

  it('maps a known ref to the isolated scope', () => {
    expect(deriveCacheRefScope(trust('known'))).toBe(CacheRefScope.enum.isolated);
  });

  it('maps an unknown ref to the isolated scope', () => {
    expect(deriveCacheRefScope(trust('unknown'))).toBe(CacheRefScope.enum.isolated);
  });

  it('fails closed (isolated) when trust resolution is absent', () => {
    expect(deriveCacheRefScope(undefined)).toBe(CacheRefScope.enum.isolated);
  });
});
