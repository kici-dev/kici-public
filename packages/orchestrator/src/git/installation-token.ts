/**
 * Mint a GitHub App installation access token, scoped to one repository and to
 * an explicit permission set.
 *
 * Shared deliberately: both the stored KiCI App and a customer's own App
 * (supplied through workflow secrets) mint the same way, and duplicating the
 * JWT dance across two code paths would leave two things to keep in sync as
 * GitHub evolves. It lives outside `providers/github/` for the same reason —
 * the workflow-supplied path must not import a provider it is not using.
 *
 * Installation tokens expire after one hour and cannot be renewed, so callers
 * must mint per use rather than caching. The credential helper does exactly
 * that, which is what makes an arbitrarily long job's `git push` succeed.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

/** A freshly minted installation token and what it can actually do. */
export interface MintedToken {
  token: string;
  /** ISO-8601 expiry, or null when the forge reported none. */
  expiresAt: string | null;
  /** Permissions GitHub ACTUALLY granted — never an echo of the request. */
  grantedPermissions: Readonly<Record<string, string>>;
  repositorySelection: string;
}

export interface MintInstallationTokenArgs {
  appId: string;
  /** PEM-encoded App private key. */
  privateKey: string;
  installationId: string;
  /** `owner/repo` for every repository the token must cover. Only the repo
   * half of each reaches the API. At least one. */
  repositories: readonly string[];
  permissions?: Readonly<Record<string, string>>;
  /** Seam for tests; production callers omit it. */
  octokitFactory?: (appId: string, privateKey: string) => Octokit;
}

function defaultOctokit(appId: string, privateKey: string): Octokit {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
}

export async function mintInstallationToken(args: MintInstallationTokenArgs): Promise<MintedToken> {
  const installationId = Number(args.installationId);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`Invalid GitHub App installation id: ${args.installationId}`);
  }

  if (args.repositories.length === 0) {
    throw new Error('mintInstallationToken requires at least one repository');
  }
  const repoNames = args.repositories.map((r) =>
    r.includes('/') ? r.slice(r.indexOf('/') + 1) : r,
  );

  const octokit = (args.octokitFactory ?? defaultOctokit)(args.appId, args.privateKey);
  const data = await createToken(octokit, {
    installationId,
    repoNames,
    repositories: args.repositories,
    ...(args.permissions ? { permissions: args.permissions } : {}),
  });

  return {
    token: data.token,
    expiresAt: data.expires_at ?? null,
    grantedPermissions: (data.permissions ?? {}) as Readonly<Record<string, string>>,
    repositorySelection: (data as { repository_selection?: string }).repository_selection ?? 'all',
  };
}

/** The shape `createInstallationAccessToken` returns that we actually read. */
interface TokenResponse {
  token: string;
  expires_at?: string | null;
  permissions?: Record<string, string>;
  repository_selection?: string;
}

/**
 * Call the create-token endpoint, translating GitHub's two refusal modes into
 * errors an author can act on.
 *
 * Verified against real GitHub on 2026-08-22: when you request a permission the
 * App does not hold, GitHub does NOT return a narrower token — it refuses the
 * whole mint with **422 "The permissions requested are not granted to this
 * installation."** Likewise a repository outside the installation's selection
 * is a 422, not a scoped-down grant. Left unwrapped, both surface to the
 * workflow as a raw Octokit stack trace naming neither the permission nor the
 * repository.
 */
async function createToken(
  octokit: Octokit,
  args: {
    installationId: number;
    repoNames: string[];
    repositories: readonly string[];
    permissions?: Readonly<Record<string, string>>;
  },
): Promise<TokenResponse> {
  try {
    const { data } = await octokit.rest.apps.createInstallationAccessToken({
      installation_id: args.installationId,
      repositories: args.repoNames,
      ...(args.permissions ? { permissions: args.permissions as never } : {}),
    });
    return data as TokenResponse;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) {
      const requested = args.permissions
        ? Object.entries(args.permissions)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '(none)';
      throw new Error(
        `GitHub refused to mint a token for ${args.repositories.map((r) => `'${r}'`).join(', ')} ` +
          `with permissions [${requested}]. Either the app was not granted one of ` +
          `them, or one of the repositories is outside its installation. Grant the ` +
          `permission on the app installation, add the repository to its selection, ` +
          `or request less.`,
      );
    }
    if (status === 404) {
      throw new Error(
        `GitHub App installation ${args.installationId} not found, or it has no ` +
          `access to ${args.repositories.map((r) => `'${r}'`).join(', ')}.`,
      );
    }
    throw err;
  }
}
