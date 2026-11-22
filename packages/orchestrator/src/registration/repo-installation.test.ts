import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubGithubFetch, TEST_APP_PRIVATE_KEY } from '../__test-helpers__/github-fetch.js';
import { createRepoInstallationResolver, InstallationLookupError } from './repo-installation.js';

/** A source store holding one GitHub App source at github:7 on `githubUrl` (github.com when unset). */
function storeWith(githubUrl?: string) {
  return {
    getSourceWithSecrets: async (routingKey: string) =>
      routingKey === 'github:7'
        ? ({
            routing_key: 'github:7',
            provider: 'github',
            config: { appId: '7' },
            github_url: githubUrl ?? null,
            privateKey: TEST_APP_PRIVATE_KEY,
          } as never)
        : null,
  };
}

describe('createRepoInstallationResolver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the source's own server for the App's installation on the repository", async () => {
    const requests = stubGithubFetch((req) =>
      req.url.endsWith('/repos/owner/repo/installation')
        ? { status: 200, body: { id: 31 } }
        : undefined,
    );
    const resolve = createRepoInstallationResolver(storeWith('https://ghe.corp.example'));
    expect(await resolve('github:7', 'owner/repo')).toBe(31);
    // fails-when: the installation is read from github.com for a GHES source
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://ghe.corp.example/api/v3/repos/owner/repo/installation',
    ]);
  });

  it('answers null when the App is not installed on the repository', async () => {
    stubGithubFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    // fails-when: a repository outside every installation is accepted
    expect(await createRepoInstallationResolver(storeWith())('github:7', 'other/repo')).toBeNull();
  });

  it.each([
    [401, 'Bad credentials'],
    [403, 'Forbidden'],
    [502, 'Bad gateway'],
  ])(
    'throws a lookup error, not "not installed", on a %i from the server',
    async (status, message) => {
      stubGithubFetch(() => ({ status, body: { message } }));
      const lookup = createRepoInstallationResolver(storeWith())('github:7', 'owner/repo');
      // fails-when: an outage or a refused App key reads as "the App is not installed"
      await expect(lookup).rejects.toBeInstanceOf(InstallationLookupError);
      await expect(
        createRepoInstallationResolver(storeWith())('github:7', 'owner/repo'),
      ).rejects.toThrow(message);
    },
  );

  it('throws a lookup error when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      createRepoInstallationResolver(storeWith('https://ghe.corp.example'))(
        'github:7',
        'owner/repo',
      ),
    ).rejects.toBeInstanceOf(InstallationLookupError);
  });

  it('refuses a GitHub routing key it cannot read the App of, never reading it as non-GitHub', async () => {
    // fails-when: a missing store or source lets the request's installation through unchecked
    await expect(createRepoInstallationResolver(null)('github:7', 'owner/repo')).rejects.toThrow(
      /no GitHub App source with its private key is stored at github:7/,
    );
    await expect(
      createRepoInstallationResolver(storeWith())('github:8', 'owner/repo'),
    ).rejects.toBeInstanceOf(InstallationLookupError);
    // breaks-if-wrong: a generic routing key needs no store
    expect(
      await createRepoInstallationResolver(null)('generic:org:src', 'owner/repo'),
    ).toBeUndefined();
  });

  it('answers null for an identifier that is not owner/repo, without asking', async () => {
    const requests = stubGithubFetch();
    const resolve = createRepoInstallationResolver(storeWith());
    expect(await resolve('github:7', 'just-a-name')).toBeNull();
    expect(await resolve('github:7', 'a/b/c')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('answers undefined for a routing key with no GitHub App source', async () => {
    const requests = stubGithubFetch();
    // breaks-if-wrong: a generic source's registration is not refused
    expect(
      await createRepoInstallationResolver(storeWith())('generic:org:src', 'owner/repo'),
    ).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
