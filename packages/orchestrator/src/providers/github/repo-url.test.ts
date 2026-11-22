import { describe, it, expect } from 'vitest';
import { GitHubRepoUrlBuilder } from './repo-url.js';

describe('GitHubRepoUrlBuilder', () => {
  it('builds github.com URLs without a server', () => {
    const builder = new GitHubRepoUrlBuilder();
    // breaks-if-wrong: github.com sources keep today's clone URLs
    expect(builder.buildCloneUrl('acme/app')).toBe('https://github.com/acme/app.git');
    expect(builder.buildRawFileUrl('acme/app', 'abc', '.kici/kici.lock.json')).toBe(
      'https://github.com/acme/app/raw/abc/.kici/kici.lock.json',
    );
  });

  it('builds URLs on the server it is given', () => {
    const builder = new GitHubRepoUrlBuilder('https://ghe.corp.example:8443');
    // fails-when: an agent clones a GHES repository from github.com
    expect(builder.buildCloneUrl('acme/app')).toBe('https://ghe.corp.example:8443/acme/app.git');
    expect(builder.buildRawFileUrl('acme/app', 'abc', '.kici/kici.lock.json')).toBe(
      'https://ghe.corp.example:8443/acme/app/raw/abc/.kici/kici.lock.json',
    );
  });
});
