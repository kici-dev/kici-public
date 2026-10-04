import { describe, it, expect } from 'vitest';
import { OrchestratorMode } from '@kici-dev/engine';
import { createGithubWebhookRoutes, shouldServeGithubIngress } from './github-webhook.js';

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

describe('createGithubWebhookRoutes route table', () => {
  // With shouldServeGithubIngress above, this pins the mount matrix of both routes:
  // they live in one sub-app, mounted only in the own-ingress modes.
  it('registers the per-source and the org-scoped POST routes', () => {
    const app = createGithubWebhookRoutes({
      sourceStore: {} as never,
      verifyDeps: {} as never,
      onWebhook: async () => 'processed' as never,
    });
    const paths = app.routes.filter((r) => r.method === 'POST').map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/webhook/:orgId/github/:sourceId', '/webhook/:orgId/github']),
    );
  });
});
