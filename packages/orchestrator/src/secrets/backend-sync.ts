/**
 * Backend sync manager for multi-source secret management.
 *
 * Discovers scopes from external secret backends (Vault) via recursive
 * listing and updates the backend registry with discovered scope counts.
 * Supports periodic sync with configurable intervals per backend.
 */
import picomatch from 'picomatch';
import { serializeError } from '@kici-dev/shared';
import type { Logger } from '@kici-dev/shared';
import type { BackendRegistry } from './backend-registry.js';

/**
 * Filter scopes against a glob pattern (scopeFilter).
 * Returns only scopes that match the filter.
 */
function filterScopes(scopes: string[], scopeFilter: string): string[] {
  if (scopeFilter === '**') return scopes;
  const isMatch = picomatch(scopeFilter);
  return scopes.filter((scope) => isMatch(scope));
}

/**
 * Manages scope discovery and sync for all registered secret backends.
 *
 * On each sync cycle, lists scopes from each backend's store, applies
 * the scope filter, and updates the registry with the discovered count.
 */
export class BackendSyncManager {
  private readonly intervalHandles = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly registry: BackendRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * Sync a single backend by name. Discovers scopes via listing,
   * applies the scope filter, and updates the registry.
   */
  async syncBackend(name: string): Promise<{ scopeCount: number; error?: string }> {
    const backend = await this.registry.getBackend(name);
    if (!backend) {
      return { scopeCount: 0, error: `Backend '${name}' not found` };
    }

    try {
      const config = await this.registry.getBackendConfig(name);
      if (!config) {
        return { scopeCount: 0, error: `Backend '${name}' config not found` };
      }

      // Create ephemeral store for this backend
      const store = this.registry.createStoreForBackend(backend.backendType, config, null as any);
      if (!store) {
        return {
          scopeCount: 0,
          error: `Cannot create store for backend type '${backend.backendType}'`,
        };
      }

      // Discover all leaf scopes. VaultSecretStore.listScopes now recurses
      // into directories, so listScopes('') returns full paths like
      // 'kiciStg00001/cloud/aws'. PG stores return flat scope names.
      const rawScopes = await store.listScopes('');

      // Apply scope filter
      const filteredScopes = filterScopes(rawScopes, backend.scopeFilter);

      // Update registry with results
      await this.registry.updateSyncStatus(name, filteredScopes.length);

      this.logger.info('Backend sync completed', {
        name,
        rawScopes: rawScopes.length,
        filteredScopes: filteredScopes.length,
        scopeFilter: backend.scopeFilter,
      });

      return { scopeCount: filteredScopes.length };
    } catch (err: unknown) {
      const errorCtx = serializeError(err);
      const errorMsg = String(errorCtx.message ?? '');
      this.logger.error('Backend sync failed', { name, ...errorCtx });
      await this.registry.updateSyncStatus(name, 0, errorMsg);
      return { scopeCount: 0, error: errorMsg };
    }
  }

  /**
   * Sync all enabled backends in parallel via Promise.allSettled.
   */
  async syncAllBackends(): Promise<Array<{ name: string; scopeCount: number; error?: string }>> {
    const backends = await this.registry.listBackends();
    const enabledBackends = backends.filter((b) => b.enabled);

    const results = await Promise.allSettled(
      enabledBackends.map(async (backend) => {
        const result = await this.syncBackend(backend.name);
        return { name: backend.name, ...result };
      }),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const errorCtx = serializeError(r.reason);
      this.logger.error('Backend sync rejected', {
        name: enabledBackends[i].name,
        ...errorCtx,
      });
      return {
        name: enabledBackends[i].name,
        scopeCount: 0,
        error: String(errorCtx.message ?? ''),
      };
    });
  }

  /**
   * Start periodic sync for each enabled backend at its configured interval.
   */
  startPeriodicSync(): void {
    this.stopPeriodicSync();

    // Start async to load backends, but don't block
    void this.startPeriodicSyncAsync();
  }

  private async startPeriodicSyncAsync(): Promise<void> {
    try {
      const backends = await this.registry.listBackends();
      const enabledBackends = backends.filter(
        (b) => b.enabled && b.backendType !== 'pg', // PG doesn't need sync
      );

      for (const backend of enabledBackends) {
        const handle = setInterval(() => {
          this.syncBackend(backend.name).catch((err) => {
            this.logger.error('Periodic sync failed', {
              name: backend.name,
              ...serializeError(err),
            });
          });
        }, backend.syncIntervalMs);

        // Don't block process exit
        if (handle && typeof handle === 'object' && 'unref' in handle) {
          handle.unref();
        }

        this.intervalHandles.set(backend.name, handle);
        this.logger.info('Started periodic sync', {
          name: backend.name,
          intervalMs: backend.syncIntervalMs,
        });
      }
    } catch (err) {
      this.logger.error('Failed to start periodic sync', serializeError(err));
    }
  }

  /**
   * Stop all periodic sync intervals.
   */
  stopPeriodicSync(): void {
    for (const [name, handle] of this.intervalHandles) {
      clearInterval(handle);
      this.logger.info('Stopped periodic sync', { name });
    }
    this.intervalHandles.clear();
  }
}
