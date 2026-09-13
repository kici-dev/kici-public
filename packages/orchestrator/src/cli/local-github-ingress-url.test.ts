import { describe, it, expect } from 'vitest';
import { buildLocalGithubIngressUrl } from './local-github-ingress-url.js';

describe('buildLocalGithubIngressUrl', () => {
  it('composes <base>/webhook/<orgId>/github/<sourceId> and trims a trailing slash', () => {
    expect(buildLocalGithubIngressUrl('https://ci.example.com/', 'org_a', 'src-1')).toBe(
      'https://ci.example.com/webhook/org_a/github/src-1',
    );
  });
  it('composes without a trailing slash on the base', () => {
    expect(buildLocalGithubIngressUrl('https://ci.example.com', 'org_a', 'src-1')).toBe(
      'https://ci.example.com/webhook/org_a/github/src-1',
    );
  });
  it('returns null when no public base url is configured', () => {
    expect(buildLocalGithubIngressUrl(undefined, 'org_a', 'src-1')).toBeNull();
  });
});
