/**
 * Daily refresh of every GitHub source's display name + slug from GitHub.
 *
 * GitHub is the source of truth for a GitHub-App source's display name and
 * slug. They are captured at creation, but an operator can rename the App in
 * the GitHub UI afterwards — this periodic task re-fetches `GET /app` for each
 * GitHub source and, when the name or slug drifted, writes the new values to
 * the `sources` row. The `sources_change` DB trigger then fans the change out
 * (SourceManager reload → `platformClient.updateSources()` → re-register), so
 * the Platform `webhook_sources` row and the dashboard Sources tab pick up the
 * new name/slug without any extra plumbing here.
 *
 * Lifecycle mirrors `StaleRunDetector`: `start()` runs an immediate refresh
 * (so a rename made while the orchestrator was down propagates on next boot)
 * then a `setInterval`; `stop()` clears it. Per-source errors are logged and
 * never abort the loop.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'github-app-name-refresher' });

/** The slice of {@link SourceStore} this module needs. */
export interface RefreshableSourceStore {
  listSources(): Promise<
    Array<{ routing_key: string; provider: string; name: string; slug: string | null }>
  >;
  getSourceWithSecrets(
    routingKey: string,
  ): Promise<{ provider: string; config: string; privateKey: string } | null>;
  updateSource(
    routingKey: string,
    updates: { name?: string; slug?: string | null },
  ): Promise<unknown>;
}

/** Fetch a GitHub App's authoritative identity. Matches `fetchGithubAppIdentity`. */
export type FetchGithubAppIdentity = (creds: {
  appId: string;
  privateKey: string;
}) => Promise<{ name: string; slug: string }>;

/** Outcome of a single source refresh. */
export interface RefreshResult {
  routingKey: string;
  changed: boolean;
  oldName: string;
  newName: string;
  oldSlug: string | null;
  newSlug: string;
}

/**
 * Re-fetch one GitHub source's identity from GitHub and persist it when the
 * name or slug drifted. Shared by the daily task and `kici-admin source
 * refresh`. Throws for a missing or non-GitHub routing key.
 */
export async function refreshGithubSourceIdentity(
  sourceStore: RefreshableSourceStore,
  routingKey: string,
  fetchIdentity: FetchGithubAppIdentity,
): Promise<RefreshResult> {
  const all = await sourceStore.listSources();
  const row = all.find((s) => s.routing_key === routingKey);
  if (!row) {
    throw new Error(`Source not found: ${routingKey}`);
  }
  if (row.provider !== 'github') {
    throw new Error(
      `Source ${routingKey} is not a GitHub source (provider=${row.provider}); ` +
        'name/slug sync only applies to GitHub App sources.',
    );
  }

  const withSecrets = await sourceStore.getSourceWithSecrets(routingKey);
  if (!withSecrets) {
    throw new Error(`Source ${routingKey} has no stored credentials to authenticate with GitHub.`);
  }
  const config = JSON.parse(withSecrets.config) as { appId: string };
  const identity = await fetchIdentity({
    appId: config.appId,
    privateKey: withSecrets.privateKey,
  });

  const changed = identity.name !== row.name || identity.slug !== row.slug;
  if (changed) {
    await sourceStore.updateSource(routingKey, { name: identity.name, slug: identity.slug });
  }

  return {
    routingKey,
    changed,
    oldName: row.name,
    newName: identity.name,
    oldSlug: row.slug,
    newSlug: identity.slug,
  };
}

export interface GithubAppNameRefresherDeps {
  sourceStore: RefreshableSourceStore;
  fetchIdentity: FetchGithubAppIdentity;
  /** Refresh cadence in ms. Default cluster value: 24h (`config.githubAppNameRefreshIntervalMs`). */
  scanIntervalMs: number;
}

export class GithubAppNameRefresher {
  private readonly sourceStore: RefreshableSourceStore;
  private readonly fetchIdentity: FetchGithubAppIdentity;
  private readonly scanIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: GithubAppNameRefresherDeps) {
    this.sourceStore = deps.sourceStore;
    this.fetchIdentity = deps.fetchIdentity;
    this.scanIntervalMs = deps.scanIntervalMs;
  }

  /** Immediate refresh then periodic scans. */
  async start(): Promise<void> {
    await this.refresh();
    this.interval = setInterval(() => {
      this.refresh().catch((err) =>
        logger.error('GitHub app name refresh error (interval)', { error: toErrorMessage(err) }),
      );
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Refresh every GitHub source once. Per-source failures are isolated. */
  async refresh(): Promise<void> {
    const sources = await this.sourceStore.listSources();
    const githubSources = sources.filter((s) => s.provider === 'github');
    let updated = 0;
    for (const source of githubSources) {
      try {
        const result = await refreshGithubSourceIdentity(
          this.sourceStore,
          source.routing_key,
          this.fetchIdentity,
        );
        if (result.changed) {
          updated += 1;
          logger.info('Refreshed GitHub source identity', {
            routingKey: result.routingKey,
            oldName: result.oldName,
            newName: result.newName,
            oldSlug: result.oldSlug,
            newSlug: result.newSlug,
          });
        }
      } catch (err) {
        logger.warn('Failed to refresh GitHub source identity', {
          routingKey: source.routing_key,
          error: toErrorMessage(err),
        });
      }
    }
    if (githubSources.length > 0) {
      logger.info('GitHub app name refresh complete', {
        scanned: githubSources.length,
        updated,
      });
    }
  }
}
