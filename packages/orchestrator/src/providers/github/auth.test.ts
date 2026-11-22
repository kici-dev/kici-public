import { afterEach, describe, it, expect, vi } from 'vitest';
import { createAppOctokit, createInstallationOctokit, GitHubCloneTokenProvider } from './auth.js';
import { stubGithubFetch, TEST_APP_PRIVATE_KEY } from '../../__test-helpers__/github-fetch.js';

const GHES = 'https://ghe.corp.example';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createInstallationOctokit', () => {
  it('createInstallationOctokit mints at the GHES API', async () => {
    const requests = stubGithubFetch();
    const octokit = createInstallationOctokit(
      { appId: '1', privateKey: TEST_APP_PRIVATE_KEY, githubUrl: GHES },
      7,
    );
    await octokit.auth({ type: 'installation' });
    // fails-when: the auth strategy mints at api.github.com while the client calls the server
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://ghe.corp.example/api/v3/app/installations/7/access_tokens',
        auth: 'bearer',
      },
    ]);
  });

  it('… and at api.github.com without a server', async () => {
    const requests = stubGithubFetch();
    const octokit = createInstallationOctokit({ appId: '1', privateKey: TEST_APP_PRIVATE_KEY }, 7);
    await octokit.auth({ type: 'installation' });
    // breaks-if-wrong: github.com sources keep minting at api.github.com
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.github.com/app/installations/7/access_tokens',
    ]);
  });

  it('calls the server with the token it minted there', async () => {
    const requests = stubGithubFetch();
    const octokit = createInstallationOctokit(
      { appId: '1', privateKey: TEST_APP_PRIVATE_KEY, githubUrl: GHES },
      7,
    );
    await octokit.request('GET /installation/repositories');
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://ghe.corp.example/api/v3/app/installations/7/access_tokens',
        auth: 'bearer',
      },
      {
        method: 'GET',
        url: 'https://ghe.corp.example/api/v3/installation/repositories',
        auth: 'token',
      },
    ]);
  });
});

describe('createAppOctokit', () => {
  it('createAppOctokit calls GET /app on the GHES API', async () => {
    const requests = stubGithubFetch();
    await createAppOctokit({
      appId: '1',
      privateKey: TEST_APP_PRIVATE_KEY,
      githubUrl: GHES,
    }).request('GET /app');
    expect(requests).toEqual([
      { method: 'GET', url: 'https://ghe.corp.example/api/v3/app', auth: 'bearer' },
    ]);
  });

  it('calls GET /app on api.github.com without a server', async () => {
    const requests = stubGithubFetch();
    await createAppOctokit({ appId: '1', privateKey: TEST_APP_PRIVATE_KEY }).request('GET /app');
    // breaks-if-wrong: a github.com App keeps calling api.github.com
    expect(requests.map((r) => r.url)).toEqual(['https://api.github.com/app']);
  });
});

describe('GitHubCloneTokenProvider', () => {
  it('GitHubCloneTokenProvider.getAppConfig returns the server', () => {
    const config = { appId: '1', privateKey: 'pem', githubUrl: GHES };
    expect(new GitHubCloneTokenProvider(config).getAppConfig().githubUrl).toBe(GHES);
  });

  it('mints a clone token at the server', async () => {
    const requests = stubGithubFetch();
    const token = await new GitHubCloneTokenProvider({
      appId: '1',
      privateKey: TEST_APP_PRIVATE_KEY,
      githubUrl: GHES,
    }).createCloneToken('acme/app', { installationId: 7 });
    expect(token).toBe('ghs_test');
    expect(requests.map((r) => r.url)).toEqual([
      'https://ghe.corp.example/api/v3/app/installations/7/access_tokens',
    ]);
  });
});
