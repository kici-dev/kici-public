/**
 * The GitHub App configuration of a stored GitHub source: the App id from its
 * `config` column, the GitHub Enterprise Server web URL from its `github_url`
 * column, and its private key from the secret store.
 */
import type { GitHubAppConfig } from '../providers/github/auth.js';
import type { SourceWithSecrets } from './source-store.js';
import { isDefaultGithubUrl, parseGithubWebUrl } from '../providers/github/github-host.js';

/** A stored source `config`: the jsonb column reads back as an object, though typed a string. */
type StoredConfig = string | Record<string, unknown>;

function parseConfig(config: StoredConfig): { appId?: unknown } {
  return (typeof config === 'string' ? JSON.parse(config) : config) as { appId?: unknown };
}

/**
 * A stored source `config` as the admin API and kici-admin show it: parsed,
 * without a `githubUrl` key, which is never read (an earlier release's
 * generic config update can still write one), so it cannot show beside the
 * real server, the top-level `githubUrl`.
 */
export function displayedSourceConfig(config: StoredConfig | null): Record<string, unknown> {
  const { githubUrl: _ignored, ...rest } = (
    typeof config === 'string' ? JSON.parse(config) : (config ?? {})
  ) as Record<string, unknown>;
  return rest;
}

/**
 * The GitHub Enterprise Server web URL a source's `github_url` column names;
 * undefined for github.com, including a stored `https://github.com`. Any
 * `config.githubUrl` is ignored: an earlier release's generic config update
 * lets a token scoped to the source write that key.
 *
 * Throws when the stored value is not a GitHub web URL. The App's JWT goes to
 * this server, so a value no admin API write could store (hand-edited)
 * refuses the source rather than becoming a base URL or falling back to
 * github.com.
 */
export function githubUrlOfSource(
  source: Pick<SourceWithSecrets, 'github_url'>,
): string | undefined {
  const githubUrl = source.github_url;
  if (githubUrl === undefined || githubUrl === null) return undefined;
  // fails-when: a planted http:, path-bearing or non-string value becomes the
  //   base URL of the App's JWT and installation-token calls
  if (typeof githubUrl !== 'string') {
    throw new Error('the stored GitHub server URL is not a string');
  }
  const origin = parseGithubWebUrl(githubUrl, 'the stored GitHub server URL');
  // fails-when: a stored default server makes a github.com run's frame gain repoWebUrl
  return isDefaultGithubUrl(origin) ? undefined : origin;
}

/**
 * Read a GitHub source's App configuration. `githubUrl` is present only when
 * the source stores one (an App on GitHub Enterprise Server). Throws, naming
 * the routing key, when the source stores no App id or a server that is not a
 * GitHub web URL. `ignoreStoredServer` reads the App alone, for a caller that
 * replaces the server.
 */
export function githubAppConfigOf(
  source: Pick<SourceWithSecrets, 'routing_key' | 'privateKey' | 'github_url'> & {
    config: StoredConfig;
  },
  options: { ignoreStoredServer?: boolean } = {},
): GitHubAppConfig {
  const config = parseConfig(source.config);
  // fails-when: a source with no App id builds a config that signs JWTs for App "undefined"
  if (typeof config.appId !== 'string' || config.appId === '') {
    throw new Error(`Source ${source.routing_key} has no stored GitHub App id`);
  }
  if (options.ignoreStoredServer) {
    return { appId: config.appId, privateKey: source.privateKey };
  }
  let githubUrl: string | undefined;
  try {
    githubUrl = githubUrlOfSource(source);
  } catch (err) {
    throw new Error(`Source ${source.routing_key} is refused: ${(err as Error).message}`);
  }
  return {
    appId: config.appId,
    privateKey: source.privateKey,
    ...(githubUrl && { githubUrl }),
  };
}
