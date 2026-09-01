import { describe, it, expect, vi } from 'vitest';
import { mintInstallationToken } from './installation-token.js';

function fakeOctokit(response: unknown) {
  return {
    rest: {
      apps: { createInstallationAccessToken: vi.fn().mockResolvedValue({ data: response }) },
    },
  };
}

describe('mintInstallationToken', () => {
  it('scopes the mint to the requested repository and permissions', async () => {
    const octokit = fakeOctokit({
      token: 'ghs_x',
      expires_at: '2026-08-22T05:51:29Z',
      permissions: { contents: 'write' },
      repository_selection: 'selected',
    });
    const result = await mintInstallationToken({
      appId: '1',
      privateKey: 'pem',
      installationId: '2',
      repositories: ['kici-dev/kici-forge-app-token-tester'],
      permissions: { contents: 'write' },
      octokitFactory: () => octokit as never,
    });

    expect(octokit.rest.apps.createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 2,
      repositories: ['kici-forge-app-token-tester'],
      permissions: { contents: 'write' },
    });
    expect(result.token).toBe('ghs_x');
    expect(result.expiresAt).toBe('2026-08-22T05:51:29Z');
    expect(result.grantedPermissions).toEqual({ contents: 'write' });
  });

  it('mints one token covering every requested repository', async () => {
    const octokit = fakeOctokit({
      token: 'ghs_multi',
      expires_at: '2026-08-22T05:51:29Z',
      permissions: { contents: 'write' },
    });

    await mintInstallationToken({
      appId: '1',
      privateKey: 'pem',
      installationId: '2',
      repositories: [
        'kici-dev/kici-forge-app-token-tester',
        'kici-dev/kici-forge-app-token-tester-2',
      ],
      permissions: { contents: 'write' },
      octokitFactory: () => octokit as never,
    });

    // One mint, both repositories — a GitHub App token is per installation, so
    // covering several repositories costs one call rather than one per repo.
    expect(octokit.rest.apps.createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 2,
      repositories: ['kici-forge-app-token-tester', 'kici-forge-app-token-tester-2'],
      permissions: { contents: 'write' },
    });
  });

  it('refuses an empty repository list rather than minting across the installation', async () => {
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: 'pem',
        installationId: '2',
        repositories: [],
        octokitFactory: () => ({}) as never,
      }),
    ).rejects.toThrow(/at least one repository/i);
  });

  it('reports the granted permissions even when narrower than requested', async () => {
    const octokit = fakeOctokit({
      token: 'ghs_x',
      expires_at: '2026-08-22T05:51:29Z',
      permissions: { contents: 'read' },
      repository_selection: 'selected',
    });
    const result = await mintInstallationToken({
      appId: '1',
      privateKey: 'pem',
      installationId: '2',
      repositories: ['a/b'],
      permissions: { contents: 'write' },
      octokitFactory: () => octokit as never,
    });
    // Never an echo of the request — this is what lets withWrite pre-flight.
    expect(result.grantedPermissions).toEqual({ contents: 'read' });
  });

  it('omits the permissions parameter when none is requested', async () => {
    const octokit = fakeOctokit({
      token: 't',
      expires_at: null,
      permissions: {},
      repository_selection: 'all',
    });
    await mintInstallationToken({
      appId: '1',
      privateKey: 'pem',
      installationId: '2',
      repositories: ['a/b'],
      octokitFactory: () => octokit as never,
    });
    const call = octokit.rest.apps.createInstallationAccessToken.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call).not.toHaveProperty('permissions');
  });

  it('rejects a non-numeric installation id rather than sending NaN', async () => {
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: 'pem',
        installationId: 'not-a-number',
        repositories: ['a/b'],
        octokitFactory: () => fakeOctokit({}) as never,
      }),
    ).rejects.toThrow(/installation id/i);
  });

  it('translates a 422 into an error naming the repo and the requested permissions', async () => {
    // Verified against real GitHub: requesting a permission the app lacks is
    // refused outright with 422, NOT granted narrower. Left unwrapped this
    // reaches the workflow as a raw Octokit stack trace.
    const octokit = {
      rest: {
        apps: {
          createInstallationAccessToken: vi
            .fn()
            .mockRejectedValue(
              Object.assign(
                new Error('The permissions requested are not granted to this installation.'),
                { status: 422 },
              ),
            ),
        },
      },
    };
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: 'pem',
        installationId: '2',
        repositories: ['kici-dev/tester'],
        permissions: { contents: 'write', pull_requests: 'write' },
        octokitFactory: () => octokit as never,
      }),
    ).rejects.toThrow(/kici-dev\/tester.*pull_requests=write/s);
  });

  it('names the installation on a 404', async () => {
    const octokit = {
      rest: {
        apps: {
          createInstallationAccessToken: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
        },
      },
    };
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: 'pem',
        installationId: '99',
        repositories: ['a/b'],
        octokitFactory: () => octokit as never,
      }),
    ).rejects.toThrow(/installation 99 not found/i);
  });

  it('rethrows an unexpected status untouched', async () => {
    const octokit = {
      rest: {
        apps: {
          createInstallationAccessToken: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
        },
      },
    };
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: 'pem',
        installationId: '2',
        repositories: ['a/b'],
        octokitFactory: () => octokit as never,
      }),
    ).rejects.toThrow(/boom/);
  });
});
