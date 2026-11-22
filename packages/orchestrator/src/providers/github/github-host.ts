/**
 * The GitHub server a GitHub App lives on: github.com, or a GitHub Enterprise
 * Server named by its web URL. One definition of the URL shapes (the web URL,
 * the REST API base, the App install page) and of the identity namespace, for
 * every caller that talks to the server or names its users.
 */
import { STATUS_ID_MAX } from '@kici-dev/engine';

/** The GitHub web URL used when none is named. */
export const DEFAULT_GITHUB_URL = 'https://github.com';

/** The identity provider name of a github.com user. */
export const DEFAULT_GITHUB_IDENTITY_PROVIDER = 'github';

/**
 * Validate a GitHub web URL (`--github-url`) and return its origin: an
 * `https:` URL with no path, query, fragment or credentials beyond one
 * trailing slash. The host is lowercased and a port is kept.
 *
 * Refused with a hint: the github.com API URL (the web URL is wanted),
 * `www.github.com` (github.com is wanted), and a GHE.com host, whose API is not
 * served under `/api/v3`. An origin longer than the `execution.status` id
 * bound is refused too: runs send it as `repoWebUrl`, and their actors as
 * `github:<host>`.
 */
export function parseGithubWebUrl(value: string, label = '--github-url'): string {
  const trimmed = value.trim();
  const shape = `${label} must be the https:// web URL of a GitHub server, such as https://github.com or https://ghe.example.com`;
  // WHATWG URL parsing silently strips tabs and newlines; refuse them instead.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${shape} (got a value with whitespace or a control character)`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${shape} (got "${trimmed}")`);
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    trimmed.endsWith('?') ||
    trimmed.endsWith('#') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(`${shape} (got "${trimmed}")`);
  }
  // fails-when: api.github.com or www.github.com is accepted as a GitHub server and
  //   mapped to <host>/api/v3, where no API is served
  if (url.hostname === 'api.github.com') {
    throw new Error(`${label} takes the web URL, not the API URL: use ${DEFAULT_GITHUB_URL}`);
  }
  if (url.hostname === 'www.github.com') {
    throw new Error(`${label} takes github.com without www: use ${DEFAULT_GITHUB_URL}`);
  }
  if (url.hostname === 'ghe.com' || url.hostname.endsWith('.ghe.com')) {
    throw new Error(
      `${label} does not accept a GHE.com host: its API is not served at <url>/api/v3 (got "${trimmed}")`,
    );
  }
  // fails-when: an origin the execution.status frame cannot carry is stored, and
  //   every status frame of the source's runs is rejected
  if (url.origin.length > STATUS_ID_MAX) {
    throw new Error(
      `${label} must be at most ${STATUS_ID_MAX} characters (got ${url.origin.length})`,
    );
  }
  return url.origin;
}

/** Whether a stored GitHub web URL names github.com (unset counts as github.com). */
export function isDefaultGithubUrl(githubUrl: string | undefined): boolean {
  return githubUrl === undefined || githubUrl === DEFAULT_GITHUB_URL;
}

/** The REST API base of a GitHub web URL: api.github.com, or `<url>/api/v3` for a server. */
export function githubApiBaseUrl(githubUrl: string): string {
  return isDefaultGithubUrl(githubUrl) ? 'https://api.github.com' : `${githubUrl}/api/v3`;
}

/**
 * The Octokit options that point a client at the App's server. A github.com
 * client gets no options, so it keeps Octokit's own default base.
 */
export function githubOctokitOptions(githubUrl: string | undefined): { baseUrl?: string } {
  return isDefaultGithubUrl(githubUrl) ? {} : { baseUrl: githubApiBaseUrl(githubUrl!) };
}

/** The page where an operator installs the App `slug` on its server. */
export function githubAppInstallUrl(githubUrl: string | undefined, slug: string): string {
  return isDefaultGithubUrl(githubUrl)
    ? `${DEFAULT_GITHUB_URL}/apps/${slug}/installations/new`
    : `${githubUrl}/github-apps/${slug}/installations/new`;
}

/**
 * The identity provider name for users of the App's server: `github` for
 * github.com, `github:<host>` for a GitHub Enterprise Server. User ids are
 * numbered per server, so a user of one server never matches an identity
 * linked on another.
 */
export function githubIdentityProvider(githubUrl: string | undefined): string {
  return isDefaultGithubUrl(githubUrl)
    ? DEFAULT_GITHUB_IDENTITY_PROVIDER
    : `${DEFAULT_GITHUB_IDENTITY_PROVIDER}:${new URL(githubUrl!).host}`;
}
