/**
 * Source manager with LISTEN/NOTIFY hot reload.
 *
 * Subscribes to PostgreSQL LISTEN/NOTIFY on the `sources_change` channel
 * to detect source configuration changes. When a change is detected,
 * reloads sources from the database, updates the ProviderRegistry in place,
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
  GitHubFileContentsFetcher,
  GitHubCloneTokenProvider,
  GitHubRepoUrlBuilder,
  GitHubCheckStatusPoster,
} from '../providers/github/index.js';
import { createInstallationOctokit } from '../providers/github/auth.js';
import type { SourceStore, SourceWithSecrets } from './source-store.js';
import type { Source } from '../db/types.js';
import { githubAppConfigOf } from './github-source-config.js';
import { createLogger } from '@kici-dev/shared';
import { NotifyListener } from '../db/notify-listener.js';

const logger = createLogger({ prefix: 'sources' });

export interface SourceManagerOptions {
  /** Raw pg pool for LISTEN/NOTIFY subscriber. */
  pool: pg.Pool;
  /** SourceStore for reading sources and secrets. */
  sourceStore: SourceStore;
  /** Callback invoked when source diff is detected (for Platform registration). */
  onSourcesChanged: (diff: { added: ProviderSource[]; removed: ProviderSource[] }) => void;
  /** Debounce interval in ms for coalescing rapid changes. Default: 200. */
  debounceMs?: number;
  /**
   * Longest a reload's DB read may take before that reload fails; the initial
   * load in `start()` has no bound. Default: 30000.
   */
  reloadTimeoutMs?: number;
}

/**
 * Manages webhook sources from the database with hot reload support.
 *
 * On start, loads all sources into its ProviderRegistry and subscribes to
 * LISTEN sources_change. On each NOTIFY, debounces and reloads, updating the
 * same registry in place and computing the diff for Platform registration.
 *
 * The registry is one instance for the manager's lifetime: the webhook
 * pipeline, the dispatcher and the check-run reporter hold it from boot, and
 * other bundles (the generic default, local sources) live in it too. A reload
 * changes only the routing keys of the `sources` table.
 */
export class SourceManager {
  private listener: NotifyListener | null = null;
  private readonly registry: ProviderRegistry;
  /** The routing keys this manager registered in `registry` at its last reload. */
  private ownedRoutingKeys = new Set<string>();
  private currentSources: ProviderSource[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly reloadTimeoutMs: number;
  /** The reload that is running, if any. */
  private runningReload: Promise<void> | null = null;
  /** The one reload waiting for the running one; later requests join it. */
  private queuedReload: Promise<void> | null = null;
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
    this.reloadTimeoutMs = opts.reloadTimeoutMs ?? 30_000;
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

  /** The ProviderRegistry this manager keeps current (the same instance on every call). */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  /** Get current sources for Platform registration. */
  getSources(): ProviderSource[] {
    return [...this.currentSources];
  }

  /**
   * Initial load + subscribe to changes. The initial load has no time bound:
   * no other reload waits behind it, and a slow database or a long list of
   * sources to decrypt must delay startup, not fail it. It logs a line before
   * it starts and its elapsed time when done, so a read that hangs is visible.
   */
  async start(): Promise<ProviderRegistry> {
    const startedAt = Date.now();
    logger.info('Loading sources from the database');
    // fails-when: a boot read slower than reloadTimeoutMs fails startup
    await this.startReload({ bounded: false });
    logger.info('Loaded sources', {
      count: this.currentSources.length,
      elapsedMs: Date.now() - startedAt,
    });

    this.listener = new NotifyListener({
      pool: this.opts.pool,
      channel: 'sources_change',
      onNotification: (msg) => {
        logger.info('sources_change NOTIFY received', {
          routingKey: msg.payload ?? '<no-payload>',
          debounceMs: this.debounceMs,
        });
        this.scheduleReload();
      },
      // Reloading is what a NOTIFY triggers anyway, so a reconnect is just a
      // re-boot of this subscription.
      onReconnect: () => this.reload(),
    });
    await this.listener.start();

    logger.info(`Listening for source changes (debounce: ${this.debounceMs}ms)`);
    return this.registry;
  }

  /** Stop listening and release the dedicated pg client. */
  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.listener) {
      await this.listener.stop();
      this.listener = null;
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

  /**
   * Reload sources from the DB and update the ProviderRegistry in place.
   * Reloads run one at a time. A request made while one runs queues one more
   * reload, and further requests join that queued reload. It starts after the
   * running one settles, so it reads the DB after the last request and its
   * view is the one that stays.
   */
  reload(): Promise<void> {
    // fails-when: every request made during a running reload reads the DB again
    if (this.queuedReload) return this.queuedReload;
    if (!this.runningReload) return this.startReload();
    // fails-when: two overlapping reloads apply out of order and a stale one
    //   re-registers a source the newer one removed
    // A failed reload is reported to its caller and does not block the next one.
    const queued = this.runningReload
      .catch(() => undefined)
      .then(() => {
        this.queuedReload = null;
        return this.startReload();
      });
    this.queuedReload = queued;
    return queued;
  }

  private startReload(options: { bounded: boolean } = { bounded: true }): Promise<void> {
    const run = this.reloadNow(options.bounded);
    this.runningReload = run;
    const settle = () => {
      if (this.runningReload === run) this.runningReload = null;
    };
    run.then(settle, settle);
    return run;
  }

  private async reloadNow(bounded: boolean): Promise<void> {
    // fails-when: a DB read that never answers holds every later reload forever
    const { sources, withSecrets } = bounded
      ? await this.readSourcesBounded()
      : await this.readSources();
    const bundles = new Map<string, ProviderBundle>();
    const newSources: ProviderSource[] = [];

    for (const source of sources) {
      try {
        const secretSource = withSecrets.get(source.routing_key);
        if (!secretSource) continue;

        bundles.set(source.routing_key, this.buildBundle(secretSource));
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
    // fails-when: a reload swaps in a new registry the webhook pipeline never sees,
    //   so a source added while the orchestrator runs is "Unknown provider"
    for (const key of this.ownedRoutingKeys) {
      if (!bundles.has(key)) this.registry.unregister(key);
    }
    for (const [key, bundle] of bundles) this.registry.registerByRoutingKey(key, bundle);
    this.ownedRoutingKeys = new Set(bundles.keys());
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
   * Read every source and its secrets, or fail once `reloadTimeoutMs` passes.
   * A read that answers after the timeout is discarded: its reload has failed.
   */
  private async readSourcesBounded(): Promise<{
    sources: Source[];
    withSecrets: Map<string, SourceWithSecrets>;
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Source reload timed out after ${this.reloadTimeoutMs}ms`)),
        this.reloadTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.readSources(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSources(): Promise<{
    sources: Source[];
    withSecrets: Map<string, SourceWithSecrets>;
  }> {
    const sources = await this.opts.sourceStore.listSources();
    const withSecrets = new Map<string, SourceWithSecrets>();
    for (const source of sources) {
      try {
        const secretSource = await this.opts.sourceStore.getSourceWithSecrets(source.routing_key);
        if (secretSource) withSecrets.set(source.routing_key, secretSource);
      } catch (err) {
        logger.error('Failed to load source, skipping', {
          routingKey: source.routing_key,
          error: (err as Error).message,
        });
      }
    }
    return { sources, withSecrets };
  }

  /**
   * Build a ProviderBundle for a source with decrypted secrets.
   * Currently only supports GitHub; throws for unknown providers. Every
   * GitHub call and clone URL of the bundle uses the App's server.
   */
  private buildBundle(source: SourceWithSecrets): ProviderBundle {
    if (source.provider === 'github') {
      const ghConfig = githubAppConfigOf(source);
      return {
        normalizer: new GitHubWebhookNormalizer(),
        lockFileFetcher: new GitHubLockFileFetcher(ghConfig),
        changedFilesFetcher: new GitHubChangedFilesFetcher(ghConfig),
        // A GitHub file-contents fetcher is scoped to one installation, so it is
        // built per delivery from the webhook credentials (installation id).
        fileContentsFetcherFactory: (credentials) => {
          const installationId = (credentials as { installationId?: number }).installationId;
          if (typeof installationId !== 'number') return undefined;
          return new GitHubFileContentsFetcher(ghConfig, installationId);
        },
        cloneTokenProvider: new GitHubCloneTokenProvider(ghConfig),
        repoUrlBuilder: new GitHubRepoUrlBuilder(ghConfig.githubUrl),
        checkStatusPoster: new GitHubCheckStatusPoster((credentials) => {
          const creds = credentials as { installationId: number };
          return createInstallationOctokit(ghConfig, creds.installationId);
        }),
        hasForkModel: true,
        ...(ghConfig.githubUrl && { githubUrl: ghConfig.githubUrl }),
      };
    }
    throw new Error(`Unsupported provider: ${source.provider}`);
  }
}
