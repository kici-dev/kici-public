import { afterEach, describe, it, expect, vi } from 'vitest';
import { validateGitHubSource } from './source-validator.js';
import { stubGithubFetch, TEST_APP_PRIVATE_KEY } from '../__test-helpers__/github-fetch.js';

const app = { appId: '12345', privateKey: TEST_APP_PRIVATE_KEY };

describe('validateGitHubSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns { valid: true, appName, slug } on successful validation', async () => {
    stubGithubFetch(() => ({ status: 200, body: { name: 'My KiCI App', slug: 'my-kici-app' } }));

    const result = await validateGitHubSource(app);

    expect(result).toEqual({ valid: true, appName: 'My KiCI App', slug: 'my-kici-app' });
  });

  it('returns { valid: false, error } on auth failure', async () => {
    stubGithubFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));

    const result = await validateGitHubSource(app);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Bad credentials');
  });

  it('returns { valid: false, error } on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com')),
    );

    const result = await validateGitHubSource(app);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/^GitHub API validation failed: /);
    // fails-when: the validator drops the underlying error and keeps only the prefix
    expect(result.error).toContain('getaddrinfo ENOTFOUND api.github.com');
  });

  it("validates against the server's API", async () => {
    const requests = stubGithubFetch();

    const result = await validateGitHubSource({ ...app, githubUrl: 'https://ghe.corp.example' });

    expect(result.valid).toBe(true);
    // fails-when: the validation still calls api.github.com for a server's App
    expect(requests).toEqual([
      { method: 'GET', url: 'https://ghe.corp.example/api/v3/app', auth: 'bearer' },
    ]);
  });

  it('validates against api.github.com without a server', async () => {
    const requests = stubGithubFetch();
    await validateGitHubSource(app);
    // breaks-if-wrong: github.com sources keep validating at api.github.com
    expect(requests.map((r) => r.url)).toEqual(['https://api.github.com/app']);
  });
});
