import { describe, it, expect } from 'vitest';
import { githubWebhookPath, githubIngressPath } from './webhook-url-format.js';

describe('githubWebhookPath', () => {
  it('builds the org-scoped github webhook path', () => {
    expect(githubWebhookPath('org_abc')).toBe('/webhook/org_abc/github');
  });

  it('does not encode the org id (org ids are already url-safe slugs)', () => {
    expect(githubWebhookPath('acme-prod')).toBe('/webhook/acme-prod/github');
  });
});

describe('githubIngressPath', () => {
  it('builds the per-source direct-ingress path', () => {
    expect(githubIngressPath('org_abc', 'src-123')).toBe('/webhook/org_abc/github/src-123');
  });
  it('is the githubWebhookPath plus the source segment', () => {
    expect(githubIngressPath('acme', 's1')).toBe(`${githubWebhookPath('acme')}/s1`);
  });
});
