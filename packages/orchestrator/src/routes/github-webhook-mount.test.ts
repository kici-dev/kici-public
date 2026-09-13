import { describe, it, expect } from 'vitest';
import { OrchestratorMode } from '@kici-dev/engine';
import { shouldServeGithubIngress } from './github-webhook.js';

describe('shouldServeGithubIngress', () => {
  it('serves in independent mode', () => {
    expect(shouldServeGithubIngress(OrchestratorMode.enum.independent)).toBe(true);
  });
  it('serves in hybrid mode', () => {
    expect(shouldServeGithubIngress(OrchestratorMode.enum.hybrid)).toBe(true);
  });
  it('serves in observed mode (own ingress, never a Platform relay target)', () => {
    expect(shouldServeGithubIngress(OrchestratorMode.enum.observed)).toBe(true);
  });
  it('does NOT serve in platform mode', () => {
    expect(shouldServeGithubIngress(OrchestratorMode.enum.platform)).toBe(false);
  });
});
