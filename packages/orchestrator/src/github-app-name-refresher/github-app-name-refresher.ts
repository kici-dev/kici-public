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
 * The same pass checks each App against the events and permissions KiCI needs
 * (`GITHUB_APP_REQUIREMENTS`) and the permissions each installation has
 * accepted, and logs one warning per App with gaps. A gap never blocks the name
 * and slug sync.
 *
 * Lifecycle mirrors `StaleRunDetector`: `start()` runs an immediate refresh
 * (so a rename made while the orchestrator was down propagates on next boot)
 * then a `setInterval`; `stop()` clears it. Per-source errors are logged and
 * never abort the loop.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  findGithubAppRequirementGaps,
  hasRequirementGaps,
  type GithubAppIdentity,
  type GithubAppInstallationGrant,
  type GithubAppRequirementGaps,
} from '../providers/github/manifest.js';

const logger = createLogger({ prefix: 'github-app-name-refresher' });

/** A source row as returned by listSources() — the slice this module needs. */
export type SourceIdentityRow = {
  routing_key: string;
  provider: string;
  name: string;
  slug: string | null;
};

/** The slice of {@link SourceStore} this module needs. */
export interface RefreshableSourceStore {
  listSources(): Promise<SourceIdentityRow[]>;
  getSourceWithSecrets(routingKey: string): Promise<{
    provider: string;
    // The `sources.config` column is jsonb, so the driver hands it back as an
    // already-parsed object on read; only the write path stringifies it. Type it
    // as either so the parse below stays honest.
    config: string | Record<string, unknown>;
    privateKey: string;
  } | null>;
  updateSource(
    routingKey: string,
    updates: { name?: string; slug?: string | null },
  ): Promise<unknown>;
}

/** Fetch a GitHub App's authoritative identity. Matches `fetchGithubAppIdentity`. */
export type FetchGithubAppIdentity = (creds: {
  appId: string;
  privateKey: string;
}) => Promise<GithubAppIdentity>;

/** List a GitHub App's installations. Matches `listGithubAppInstallations`. */
export type FetchGithubAppInstallations = (creds: {
  appId: string;
  privateKey: string;
}) => Promise<GithubAppInstallationGrant[]>;

/** Outcome of a single source refresh: the name and slug sync plus the requirement gaps. */
export interface RefreshResult extends GithubAppRequirementGaps {
  routingKey: string;
  changed: boolean;
  oldName: string;
  newName: string;
  oldSlug: string | null;
  newSlug: string;
}

/**
 * Refresh one already-resolved GitHub source's identity from GitHub and persist
 * it when the name or slug drifted, then compare the App and its installations
 * with the required events and permissions. The caller supplies the row it
 * already holds, so this never lists the sources table. Throws for a non-GitHub
 * row or missing credentials. A failed installations listing throws after the
 * name and slug sync has been written, so the sync never waits on the gap check.
 */
export async function refreshResolvedGithubSource(
  sourceStore: Pick<RefreshableSourceStore, 'getSourceWithSecrets' | 'updateSource'>,
  row: SourceIdentityRow,
  fetchIdentity: FetchGithubAppIdentity,
  fetchInstallations: FetchGithubAppInstallations,
): Promise<RefreshResult> {
  if (row.provider !== 'github') {
    throw new Error(
      `Source ${row.routing_key} is not a GitHub source (provider=${row.provider}); ` +
        'name/slug sync only applies to GitHub App sources.',
    );
  }

  const withSecrets = await sourceStore.getSourceWithSecrets(row.routing_key);
  if (!withSecrets) {
    throw new Error(
      `Source ${row.routing_key} has no stored credentials to authenticate with GitHub.`,
    );
  }
  const config = (
    typeof withSecrets.config === 'string' ? JSON.parse(withSecrets.config) : withSecrets.config
  ) as { appId: string };
  const creds = { appId: config.appId, privateKey: withSecrets.privateKey };
  const identity = await fetchIdentity(creds);

  const changed = identity.name !== row.name || identity.slug !== row.slug;
  if (changed) {
    await sourceStore.updateSource(row.routing_key, { name: identity.name, slug: identity.slug });
  }

  // A gap never blocks the name and slug sync above; it is reported beside it.
  let installations: GithubAppInstallationGrant[];
  try {
    installations = await fetchInstallations(creds);
  } catch (err) {
    throw new Error(
      `${row.routing_key}: name and slug synced, but listing the GitHub App installations failed: ` +
        toErrorMessage(err),
      { cause: err },
    );
  }
  const gaps = findGithubAppRequirementGaps(identity, installations);

  return {
    routingKey: row.routing_key,
    changed,
    oldName: row.name,
    newName: identity.name,
    oldSlug: row.slug,
    newSlug: identity.slug,
    ...gaps,
  };
}

/**
 * Re-fetch one GitHub source's identity from GitHub and persist it when the
 * name or slug drifted, and report requirement gaps. Resolves the row by routing
 * key (one sources read) then delegates. Shared by `kici-admin source refresh`. Throws for a missing or
 * non-GitHub routing key.
 */
export async function refreshGithubSourceIdentity(
  sourceStore: RefreshableSourceStore,
  routingKey: string,
  fetchIdentity: FetchGithubAppIdentity,
  fetchInstallations: FetchGithubAppInstallations,
): Promise<RefreshResult> {
  const all = await sourceStore.listSources();
  const row = all.find((s) => s.routing_key === routingKey);
  if (!row) {
    throw new Error(`Source not found: ${routingKey}`);
  }
  return refreshResolvedGithubSource(sourceStore, row, fetchIdentity, fetchInstallations);
}

export interface GithubAppNameRefresherDeps {
  sourceStore: RefreshableSourceStore;
  fetchIdentity: FetchGithubAppIdentity;
  fetchInstallations: FetchGithubAppInstallations;
  /** Refresh cadence in ms. Default cluster value: 24h (`config.githubAppNameRefreshIntervalMs`). */
  scanIntervalMs: number;
}

export class GithubAppNameRefresher {
  private readonly sourceStore: RefreshableSourceStore;
  private readonly fetchIdentity: FetchGithubAppIdentity;
  private readonly fetchInstallations: FetchGithubAppInstallations;
  private readonly scanIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: GithubAppNameRefresherDeps) {
    this.sourceStore = deps.sourceStore;
    this.fetchIdentity = deps.fetchIdentity;
    this.fetchInstallations = deps.fetchInstallations;
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
        const result = await refreshResolvedGithubSource(
          this.sourceStore,
          source,
          this.fetchIdentity,
          this.fetchInstallations,
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
        if (hasRequirementGaps(result)) {
          logger.warn('GitHub App lacks events or permissions KiCI needs', {
            routingKey: result.routingKey,
            missingEvents: result.missingEvents,
            missingPermissions: result.missingPermissions,
            installationsPendingApproval: result.installationsPendingApproval.map(
              (i) => i.account || String(i.installationId),
            ),
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
