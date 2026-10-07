/**
 * Provider registry for the orchestrator.
 *
 * Maps routing keys to implementation bundles containing all provider capabilities.
 * Static registration (no dynamic loading) -- providers are registered at startup.
 *
 * Each routing key (e.g., "github:12345") maps to its own ProviderBundle instance
 * with per-app credentials. This supports multiple GitHub Apps (or other providers)
 * registered simultaneously, each with its own appId/privateKey pair.
 *
 * The registry is the single entry point for all provider-specific operations:
 * webhook normalization, lock file fetching, changed files retrieval,
 * clone token creation, and URL building.
 */

import { createLogger } from '@kici-dev/shared';
import type {
  WebhookNormalizer,
  LockFileFetcher,
  FileContentsFetcher,
  ChangedFilesFetcher,
  CloneTokenProvider,
  RepoUrlBuilder,
  CheckStatusPoster,
  ProviderType,
} from '@kici-dev/engine';

const logger = createLogger({ prefix: 'provider-registry' });

/**
 * Complete set of provider capabilities.
 *
 * Only normalizer is required -- non-Git providers (e.g., generic webhooks)
 * don't need lock file fetching, changed files, clone tokens, or URL building.
 * The pipeline processor already handles missing provider capabilities by
 * skipping operations.
 */
export interface ProviderBundle {
  normalizer: WebhookNormalizer;
  lockFileFetcher?: LockFileFetcher;
  /**
   * Fetches arbitrary file contents at a ref (content-match triggers). Unlike
   * the other fetchers, a GitHub instance is scoped to one installation, so the
   * per-delivery installation id must be known to construct it -- it is wired
   * where that id is in scope, not in the source-level bundle build. Providers
   * that can prebuild one (no per-delivery credential) may set this directly;
   * providers scoped per installation supply {@link fileContentsFetcherFactory}
   * instead.
   */
  fileContentsFetcher?: FileContentsFetcher;
  /**
   * Builds a per-delivery {@link FileContentsFetcher} from the event
   * credentials (e.g. a GitHub installation id). Returns undefined when the
   * credentials do not carry what the provider needs. The webhook pipeline
   * calls this once per delivery, where the credentials are already resolved.
   */
  fileContentsFetcherFactory?: (
    credentials: Record<string, unknown>,
  ) => FileContentsFetcher | undefined;
  changedFilesFetcher?: ChangedFilesFetcher;
  cloneTokenProvider?: CloneTokenProvider;
  repoUrlBuilder?: RepoUrlBuilder;
  /**
   * This provider has a fork model: a head ref can live outside the base repo,
   * so the fork trust policy applies to its pull-request events. True for
   * GitHub. Absent for providers whose trust boundary is something else — a
   * generic source's verification secret, a local source's on-disk ownership —
   * and for universal-git, which reports an `isForkPR` signal that must not
   * gate it.
   */
  hasForkModel?: boolean;
  checkStatusPoster?: CheckStatusPoster;
  /**
   * Local `file://` in-place profile: this bundle's `repoBasePath` is the
   * operator's real working tree, so a dispatched run against it skips the
   * source-pack `__build__` job (the tree is used directly by the agent's
   * `KICI_IN_PLACE` profile). Set only by `createLocalProviderBundle`. Undefined
   * for every non-local (or non-in-place local) bundle.
   */
  localInPlace?: boolean;
}

/**
 * Registry mapping routing keys to their implementation bundles.
 *
 * Routing keys have the format "{provider}:{id}" (e.g., "github:12345").
 * Each routing key gets its own ProviderBundle with per-app credentials.
 *
 * Usage (multi-app):
 *   const registry = new ProviderRegistry();
 *   registry.registerByRoutingKey('github:12345', bundleForApp1);
 *   registry.registerByRoutingKey('github:67890', bundleForApp2);
 *   const bundle = registry.getByRoutingKey('github:12345');
 *
 * A provider-wide default bundle, registered with `register(type)`, stands in
 * for every routing key of that type that has no bundle of its own:
 *   registry.register('generic', genericBundle);
 */
export class ProviderRegistry {
  private readonly bundles = new Map<string, ProviderBundle>();

  /**
   * Register a provider bundle by routing key.
   *
   * Each routing key gets its own bundle with per-app credentials.
   * Routing keys have the format "{provider}:{id}" (e.g., "github:12345").
   */
  registerByRoutingKey(routingKey: string, bundle: ProviderBundle): void {
    this.bundles.set(routingKey, bundle);
  }

  /**
   * Register the provider-wide default bundle for `type`, stored under the
   * synthetic routing key "{type}:default". It answers every routing key of
   * that type that has no bundle of its own.
   */
  register(type: ProviderType, bundle: ProviderBundle): void {
    this.bundles.set(`${type}:default`, bundle);
  }

  /**
   * Whether a bundle is registered at EXACTLY this routing key.
   *
   * `getByRoutingKey` cannot answer this: it falls back to the type's default
   * bundle, so it returns a bundle for a key it has never seen. A caller that
   * needs to know whether the source's OWN bundle is present — rather than
   * whether some bundle can be produced — has to ask here.
   */
  hasExact(routingKey: string): boolean {
    return this.bundles.has(routingKey);
  }

  /**
   * Get the provider bundle by routing key.
   * Routing keys have the format "{provider}:{id}" (e.g., "github:12345").
   *
   * A key with no bundle of its own falls back only to its type's default
   * bundle (`{type}:default`, e.g. `generic:default`, which stands in for every
   * plain generic source). It never falls back to another key's bundle: that
   * bundle belongs to a different App or source, possibly in a different
   * organization.
   */
  getByRoutingKey(routingKey: string): ProviderBundle | undefined {
    const providerType = routingKey.split(':')[0];
    return this.bundles.get(routingKey) ?? this.bundles.get(`${providerType}:default`);
  }

  /**
   * Get just the normalizer for a routing key.
   * Convenience method for webhook handling.
   */
  getNormalizerByRoutingKey(routingKey: string): WebhookNormalizer | undefined {
    return this.getByRoutingKey(routingKey)?.normalizer;
  }

  /**
   * Iterate over all registered bundles.
   */
  getAll(): IterableIterator<[string, ProviderBundle]> {
    return this.bundles.entries();
  }

  /**
   * Get all registered routing keys.
   */
  getRoutingKeys(): string[] {
    return [...this.bundles.keys()];
  }

  /**
   * Remove a routing key and its bundle.
   * Used during config reload when apps are removed.
   */
  unregister(routingKey: string): boolean {
    const existed = this.bundles.delete(routingKey);
    if (existed) {
      logger.info('Provider bundle unregistered', { routingKey });
    }
    return existed;
  }

  /**
   * Check if a routing key is for a generic webhook source.
   * Generic routing keys have the format "generic:{orgId}:{sourceId}".
   */
  static isGenericRoutingKey(routingKey: string): boolean {
    return routingKey.startsWith('generic:');
  }

  /**
   * Remove all registered bundles.
   * Used during full config rebuild on reload.
   */
  clear(): void {
    const count = this.bundles.size;
    this.bundles.clear();
    if (count > 0) {
      logger.info('Provider registry cleared', { previousCount: count });
    }
  }
}
