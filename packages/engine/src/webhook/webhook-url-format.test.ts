import { describe, it, expect } from 'vitest';
import { githubWebhookPath } from './webhook-url-format.js';

describe('githubWebhookPath', () => {
  it('builds the org-scoped github webhook path', () => {
    expect(githubWebhookPath('org_abc')).toBe('/webhook/org_abc/github');
  });

  it('does not encode the org id (org ids are already url-safe slugs)', () => {
    expect(githubWebhookPath('acme-prod')).toBe('/webhook/acme-prod/github');
  });
});
