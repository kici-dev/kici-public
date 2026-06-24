/**
 * Source manager with LISTEN/NOTIFY hot reload.
 *
 * Subscribes to PostgreSQL LISTEN/NOTIFY on the `sources_change` channel
 * to detect source configuration changes. When a change is detected,
 * reloads sources from the database, rebuilds the ProviderRegistry,
 * and notifies the caller of added/removed sources via a callback.
 *
 * Debounces rapid changes to avoid excessive reloads.
 */
import type pg from 'pg';
import { ProviderRegistry } from '../provider-registry.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { ProviderSource } from '../entry-helpers.js';
import { diffProviderSources } from '../entry-helpers.js';
import { type SourceProvider, SourceSubtype } from '@kici-dev/engine';
import {
  GitHubWebhookNormalizer,
  GitHubLockFileFetcher,
  GitHubChangedFilesFetcher,
  GitHubCloneTokenProvider,
  GitHubRepoUrlBuilder,
  GitHubCheckStatusPoster,
  GitHubContributorResolver,
} from '../providers/github/index.js';
import { createInstallationOctokit } from '../providers/github/auth.js';
import type { SourceStore, SourceWithSecrets } from './source-store.js';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'sources' });

/**
 * Options for creating a SourceManager.
 */
export interface SourceManagerOptions {
  /** Raw pg pool for LISTEN/NOTIFY subscriber. */
  pool: pg.Pool;
  /** SourceStore for reading sources and secrets. */
  sourceStore: SourceStore;
  /** Callback invoked when source diff is detected (for Platform registration). */
  onSourcesChanged: (diff: { added: ProviderSource[]; removed: ProviderSource[] }) => void;
  /** Debounce interval in ms for coalescing rapid changes. Default: 200. */
  debounceMs?: number;
}

/**
 * Manages webhook sources from the database with hot reload support.
 *
 * On start, loads all sources, builds a ProviderRegistry, and subscribes
 * to LISTEN sources_change. On each NOTIFY, debounces and reloads,
 * rebuilding the registry and computing the diff for Platform registration.
 */
export class SourceManager {
  private client: pg.PoolClient | null = null;
  private registry: ProviderRegistry;
  private currentSources: ProviderSource[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  /**
   * Change callback. Stored in a mutable field (not read off `opts`) so a
   * mode-specific hook can rewire it after construction — the platform-mode
   * boot wires it to push the full source list to the Platform via
   * `platformClient.updateSources()`. Defaults to the (possibly no-op) value
   * passed at construction.
   */
  private onSourcesChanged: SourceManagerOptions['onSourcesChanged'];

  constructor(private readonly opts: SourceManagerOptions) {
    this.registry = new ProviderRegistry();
    this.debounceMs = opts.debounceMs ?? 200;
    this.onSourcesChanged = opts.onSourcesChanged;
  }

  /**
   * Replace the change callback after construction. The SourceManager is built
   * early (before the Platform client exists); the platform-mode boot calls
   * this once the client is ready so live source changes propagate upstream.
   */
  setOnSourcesChanged(cb: SourceManagerOptions['onSourcesChanged']): void {
    this.onSourcesChanged = cb;
  }

  /** Get current ProviderRegistry (rebuilt on each reload). */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  /** Get current sources for Platform registration. */
  getSources(): ProviderSource[] {
    return [...this.currentSources];
  }

  /** Initial load + subscribe to changes. */
  async start(): Promise<ProviderRegistry> {
    await this.reload();

    this.client = await this.opts.pool.connect();
    this.client.on('notification', (msg) => {
      if (msg.channel === 'sources_change') {
        logger.info('sources_change NOTIFY received', {
          routingKey: msg.payload ?? '<no-payload>',
          debounceMs: this.debounceMs,
        });
        this.scheduleReload();
      }
    });
    await this.client.query('LISTEN sources_change');

    logger.info(`Listening for source changes (debounce: ${this.debounceMs}ms)`);
    return this.registry;
  }

  /** Stop listening and release the dedicated pg client. */
  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.client) {
      try {
        await this.client.query('UNLISTEN sources_change');
      } catch {
        // Ignore errors during shutdown (connection may already be closed)
      }
      this.client.release();
      this.client = null;
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.reload().catch((err) => {
        logger.error('Failed to reload sources', { error: (err as Error).message });
      });
    }, this.debounceMs);
  }

  /** Reload sources from DB and rebuild the ProviderRegistry. */
  async reload(): Promise<void> {
    const sources = await this.opts.sourceStore.listSources();
    const newRegistry = new ProviderRegistry();
    const newSources: ProviderSource[] = [];

    for (const source of sources) {
      try {
        const withSecrets = await this.opts.sourceStore.getSourceWithSecrets(source.routing_key);
        if (!withSecrets) continue;

        const bundle = this.buildBundle(withSecrets);
        newRegistry.registerByRoutingKey(source.routing_key, bundle);
        // The `sources` table is GitHub App-only today (every row has
        // provider='github' — see SourceStore.addSource). The bundle
        // builder rejects anything else with `Unsupported provider`.
        // That's why `subtype` is a plain `github_app` literal here:
        // when we add gitlab/bitbucket native bundles, we'll branch on
        // `source.provider` to pick the right subtype.
        // The `sources` table stores `provider` as TEXT; the only value the
        // bundle builder accepts is 'github', so the cast to SourceProvider
        // is sound. If/when the DB constraint widens, this is the line to
        // update.
        newSources.push({
          provider: source.provider as SourceProvider,
          routingKey: source.routing_key,
          name: source.name,
          subtype: SourceSubtype.enum.github_app,
          ...(source.slug ? { slug: source.slug } : {}),
        });
      } catch (err) {
        logger.error('Failed to load source, skipping', {
          routingKey: source.routing_key,
          error: (err as Error).message,
        });
      }
    }

    const diff = diffProviderSources(this.currentSources, newSources);
    this.registry = newRegistry;
    this.currentSources = newSources;

    logger.info(`Loaded ${sources.length} source(s)`, {
      added: diff.added.length,
      removed: diff.removed.length,
    });

    if (diff.added.length > 0 || diff.removed.length > 0) {
      this.onSourcesChanged(diff);
    }
  }

  /**
   * Build a ProviderBundle for a source with decrypted secrets.
   * Currently only supports GitHub; throws for unknown providers.
   */
  private buildBundle(source: SourceWithSecrets): ProviderBundle {
    if (source.provider === 'github') {
      const config = (
        typeof source.config === 'string' ? JSON.parse(source.config) : source.config
      ) as { appId: string };
      const ghConfig = { appId: config.appId, privateKey: source.privateKey };
      return {
        normalizer: new GitHubWebhookNormalizer(),
        lockFileFetcher: new GitHubLockFileFetcher(ghConfig),
        changedFilesFetcher: new GitHubChangedFilesFetcher(ghConfig),
        cloneTokenProvider: new GitHubCloneTokenProvider(ghConfig),
        repoUrlBuilder: new GitHubRepoUrlBuilder(),
        checkStatusPoster: new GitHubCheckStatusPoster((credentials) => {
          const creds = credentials as { installationId: number };
          return createInstallationOctokit(ghConfig, creds.installationId);
        }),
        contributorResolver: new GitHubContributorResolver(ghConfig),
      };
    }
    throw new Error(`Unsupported provider: ${source.provider}`);
  }
}
