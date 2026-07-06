import { describe, it, expect } from 'vitest';
import { shouldServeGithubIngress } from './github-webhook.js';

describe('shouldServeGithubIngress', () => {
  it('serves in independent mode', () => {
    expect(shouldServeGithubIngress('independent')).toBe(true);
  });
  it('serves in hybrid mode', () => {
    expect(shouldServeGithubIngress('hybrid')).toBe(true);
  });
  it('does NOT serve in platform mode', () => {
    expect(shouldServeGithubIngress('platform')).toBe(false);
  });
});
