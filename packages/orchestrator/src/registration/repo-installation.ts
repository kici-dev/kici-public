/**
 * The installation of a GitHub App source's App on one repository, read from
 * the App's server. A registration created through the admin API by a
 * routing-key-scoped token names its installation from here, never from the
 * request: the App may be installed on several accounts, and the installation
 * picks which account's repositories a run's tokens reach.
 */
import { SourceProvider } from '@kici-dev/engine';
import { toErrorMessage, createLogger } from '@kici-dev/shared';
import { createAppOctokit } from '../providers/github/auth.js';
import type { SourceStore } from '../sources/source-store.js';
import { githubAppConfigOf } from '../sources/github-source-config.js';

const logger = createLogger({ prefix: 'repo-installation' });

/**
 * The installation could not be read: the App's server failed or refused the
 * App, or the source is not stored with its key. Not the same as "the App has
 * no installation on the repository", which the server answers with 404.
 */
export class InstallationLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationLookupError';
  }
}

/**
 * The App's installation id on `repoIdentifier` (`owner/repo`), `null` when the
 * App is not installed on it (or the identifier is not `owner/repo`), and
 * `undefined` when `routingKey` is not a GitHub App routing key. Throws
 * {@link InstallationLookupError} when the installation cannot be read.
 */
export type RepoInstallationResolver = (
  routingKey: string,
  repoIdentifier: string,
) => Promise<number | null | undefined>;

/** `@octokit/request-error` carries the HTTP status. */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function createRepoInstallationResolver(
  sourceStore: Pick<SourceStore, 'getSourceWithSecrets'> | null | undefined,
): RepoInstallationResolver {
  return async (routingKey, repoIdentifier) => {
    if (!routingKey.startsWith(`${SourceProvider.enum.github}:`)) return undefined;
    // fails-when: a GitHub App source that cannot be read is treated as non-GitHub,
    //   and the request's installation is stored unchecked
    const source = sourceStore ? await sourceStore.getSourceWithSecrets(routingKey) : null;
    if (!source) {
      throw new InstallationLookupError(
        `no GitHub App source with its private key is stored at ${routingKey}`,
      );
    }
    const [owner, repo, ...rest] = repoIdentifier.split('/');
    if (!owner || !repo || rest.length > 0) return null;
    try {
      const { data } = await createAppOctokit(githubAppConfigOf(source)).apps.getRepoInstallation({
        owner,
        repo,
      });
      return data.id;
    } catch (err) {
      // fails-when: an outage or a refused App key reads as "not installed"
      if (httpStatusOf(err) === 404) {
        logger.info('The App has no installation on the repository', {
          routingKey,
          repoIdentifier,
        });
        return null;
      }
      logger.warn("The App's server did not answer the installation lookup", {
        routingKey,
        repoIdentifier,
        status: httpStatusOf(err),
        error: toErrorMessage(err),
      });
      throw new InstallationLookupError(
        `the App's server did not answer the installation lookup: ${toErrorMessage(err)}`,
      );
    }
  };
}
