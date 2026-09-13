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
 * Usage (backward-compatible single-app):
 *   registry.register('github', bundle);
 *   const bundle = registry.get('github');
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
   * Register a provider implementation bundle by provider type.
   *
   * Backward-compatible: stores the bundle under a synthetic routing key
   * "{type}:default". Only works for single-app scenarios.
   *
   * For multi-app support, use registerByRoutingKey() instead.
   */
  register(type: ProviderType, bundle: ProviderBundle): void {
    this.bundles.set(`${type}:default`, bundle);
  }

  /**
   * Get the provider bundle for a given type.
   *
   * Backward-compatible: returns the first bundle matching the provider type
   * prefix. For multi-app, use getByRoutingKey() instead.
   */
  get(type: ProviderType): ProviderBundle | undefined {
    // Check the synthetic default key first
    const defaultBundle = this.bundles.get(`${type}:default`);
    if (defaultBundle) return defaultBundle;

    // Fall back to first bundle matching the provider type prefix
    const prefix = `${type}:`;
    for (const [key, bundle] of this.bundles) {
      if (key.startsWith(prefix)) {
        return bundle;
      }
    }
    return undefined;
  }

  /**
   * Whether a bundle is registered at EXACTLY this routing key.
   *
   * `getByRoutingKey` cannot answer this: it falls back to a provider-type
   * lookup, so it returns a bundle for a key it has never seen. A caller that
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
   * Falls back to get(providerType) if the exact key is not found, for
   * backward compatibility with single-app registration.
   *
   * The fallback is deliberately narrower for a `generic:` key. Such a key is
   * fully qualified (`generic:{orgId}:{sourceId}`), so the type-prefix scan in
   * `get()` cannot be a "the single configured app" shortcut the way it is for
   * `github:` — it returns whichever `generic:`-prefixed bundle happens to sit
   * first in insertion order, which may belong to a different source, or to a
   * different ORGANIZATION. Only the shared default bundle (`generic:default`,
   * the one that genuinely stands in for every plain generic source) is an
   * acceptable stand-in, so that is the only fallback offered here.
   */
  getByRoutingKey(routingKey: string): ProviderBundle | undefined {
    const exact = this.bundles.get(routingKey);
    if (exact) return exact;

    if (ProviderRegistry.isGenericRoutingKey(routingKey)) {
      return this.bundles.get('generic:default');
    }

    // Fallback: try provider type lookup for backward compat
    const providerType = routingKey.split(':')[0] as ProviderType;
    return this.get(providerType);
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
   * Check if a provider type has at least one registered bundle.
   */
  has(type: ProviderType): boolean {
    if (this.bundles.has(`${type}:default`)) return true;
    const prefix = `${type}:`;
    for (const key of this.bundles.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Get all registered routing keys.
   */
  getRoutingKeys(): string[] {
    return [...this.bundles.keys()];
  }

  /**
   * Get routing keys matching a specific provider type.
   *
   * @param type - Provider type (e.g., "github")
   * @returns Array of routing keys matching the type prefix
   */
  getRoutingKeysForProvider(type: ProviderType): string[] {
    const prefix = `${type}:`;
    return [...this.bundles.keys()].filter((key) => key.startsWith(prefix));
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
