/**
 * Hot-reload infrastructure for orchestrator configuration.
 *
 * ConfigReloader handles SIGHUP, HTTP endpoint, and programmatic reload triggers
 * with debounce, mutex serialization, validation-before-swap, drain mode,
 * and Prometheus metrics.
 *
 * Safety guarantees:
 * - Concurrent reloads serialized via mutex (no partial state)
 * - Validation before swap (old config preserved on failure)
 * - Restart-required fields detected but not applied (database.url, server.port)
 * - Drain mode for zero-disruption reload
 */

import type { Logger } from '@kici-dev/shared';
import type { AppConfig, SharedConfig } from './types.js';
import type { SharedConfigStore } from './shared-store.js';
import { configReloadTotal, setConfigVersion } from '../metrics/prometheus.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Source of a reload trigger.
 */
export type ReloadSource = 'sighup' | 'http' | 'cluster' | 'cli';

/**
 * Result of a reload operation.
 */
export interface ReloadResult {
  success: boolean;
  version?: number;
  errors?: string[];
  /** Fields that changed but need restart to apply */
  restartRequired?: string[];
  /** Fields that were hot-reloaded */
  fieldsChanged?: string[];
}

/**
 * Options for executeReload.
 */
export interface ReloadOptions {
  /** Whether to drain in-flight work before reloading */
  drain?: boolean;
  /** Reload trigger source for metrics */
  source: ReloadSource;
}

/**
 * Dependencies injected into ConfigReloader.
 */
export interface ConfigReloaderDeps {
  /** Load local config from YAML + env */
  resolveLocalConfig: () => Promise<{ local: Record<string, unknown> }>;
  /** Merge all layers into AppConfig */
  resolveFullConfig: (local: Record<string, unknown>, dbConfig: SharedConfig | null) => AppConfig;
  /** Shared config store (null if no DB config) */
  sharedStore: SharedConfigStore | null;

  /** Called after successful reload when provider config changed */
  onProviderChange?: (newConfig: AppConfig, oldConfig: AppConfig) => Promise<void>;
  /** Called to reload scaler configuration */
  onScalerReload?: () => Promise<void>;
  /** Called when Platform connection settings changed */
  onPlatformReconnect?: (newConfig: AppConfig) => Promise<void>;
  /** Atomic swap callback -- replaces the config reference */
  onConfigApplied?: (newConfig: AppConfig) => void;

  /** Start draining in-flight work */
  startDrain?: () => Promise<void>;
  /** Stop drain and resume accepting work */
  stopDrain?: () => void;

  logger: Logger;
}

/**
 * Fields that require a process restart to take effect.
 * These cannot be hot-reloaded because they affect bound resources
 * (database connections, listening port, storage backends).
 */
const RESTART_REQUIRED_FIELDS: (keyof AppConfig)[] = [
  'databaseUrl',
  'port',
  'instanceId',
  'storage',
];

/**
 * ConfigReloader manages hot-reload of orchestrator configuration.
 *
 * Handles SIGHUP signals, HTTP-triggered reloads, and cluster-triggered reloads
 * with debounce, mutex, validation-before-swap, and Prometheus metrics.
 */
export class ConfigReloader {
  private currentConfig: AppConfig;
  private reloading = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentVersion = 0;
  private readonly deps: ConfigReloaderDeps;

  /** Debounce interval in milliseconds */
  static DEBOUNCE_MS = 500;

  constructor(initialConfig: AppConfig, deps: ConfigReloaderDeps) {
    this.currentConfig = initialConfig;
    this.deps = deps;
  }

  /**
   * Trigger a reload (debounced).
   * Multiple rapid triggers will be collapsed into a single reload.
   */
  triggerReload(source: ReloadSource, opts?: { drain?: boolean }): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeReload({ source, drain: opts?.drain }).catch((err) => {
        this.deps.logger.error('Reload execution failed unexpectedly', {
          error: toErrorMessage(err),
        });
      });
    }, ConfigReloader.DEBOUNCE_MS);
  }

  /**
   * Execute reload immediately (no debounce).
   * Used by tests and direct API calls that need synchronous results.
   */
  async executeReload(opts: ReloadOptions): Promise<ReloadResult> {
    // Acquire mutex
    if (this.reloading) {
      return { success: false, errors: ['Reload already in progress'] };
    }

    this.reloading = true;
    configReloadTotal.add(1, { result: 'attempted', source: opts.source });

    try {
      // 1. Load new config
      const localResult = await this.deps.resolveLocalConfig();
      let dbConfig: SharedConfig | null = null;
      let dbVersion = 0;

      if (this.deps.sharedStore) {
        const latest = await this.deps.sharedStore.getLatest();
        if (latest) {
          dbConfig = latest.config;
          dbVersion = latest.version;
        }
      }

      // 2. Validate: resolve new config (throws on schema failure)
      let newConfig: AppConfig;
      try {
        newConfig = this.deps.resolveFullConfig(localResult.local, dbConfig);
      } catch (err) {
        const errorMsg = toErrorMessage(err);
        this.deps.logger.error('Config reload validation failed, keeping old config', {
          error: errorMsg,
          source: opts.source,
        });
        configReloadTotal.add(1, { result: 'failed', source: opts.source });
        return { success: false, errors: [errorMsg] };
      }

      // 3. Check restart-required fields
      const restartRequired: string[] = [];
      for (const field of RESTART_REQUIRED_FIELDS) {
        const oldVal = this.currentConfig[field];
        const newVal = newConfig[field];
        // Use JSON comparison for object fields (e.g. storage) to avoid
        // false positives from reference inequality on fresh objects
        const changed =
          typeof oldVal === 'object' || typeof newVal === 'object'
            ? JSON.stringify(oldVal) !== JSON.stringify(newVal)
            : oldVal !== newVal;
        if (changed) {
          restartRequired.push(field);
          // Preserve old value for restart-required fields
          (newConfig as unknown as Record<string, unknown>)[field] = oldVal;
        }
      }

      if (restartRequired.length > 0) {
        this.deps.logger.warn('Config fields changed but require restart to apply', {
          fields: restartRequired,
          source: opts.source,
        });
      }

      // 4. Diff old vs new to identify changed fields
      const fieldsChanged = diffConfigs(this.currentConfig, newConfig);

      // 5. Drain if requested
      if (opts.drain && this.deps.startDrain) {
        this.deps.logger.info('Starting drain before config reload', { source: opts.source });
        await this.deps.startDrain();
      }

      // 6. Atomic swap
      const oldConfig = this.currentConfig;
      this.currentConfig = newConfig;
      this.currentVersion = dbVersion;

      if (this.deps.onConfigApplied) {
        this.deps.onConfigApplied(newConfig);
      }

      // 7. Re-initialize subsystems based on what changed
      if (this.deps.onProviderChange && hasProviderChanges(oldConfig, newConfig)) {
        await this.deps.onProviderChange(newConfig, oldConfig);
      }

      if (this.deps.onScalerReload) {
        await this.deps.onScalerReload();
      }

      if (this.deps.onPlatformReconnect && hasPlatformChanges(oldConfig, newConfig)) {
        await this.deps.onPlatformReconnect(newConfig);
      }

      // 8. Stop drain
      if (opts.drain && this.deps.stopDrain) {
        this.deps.stopDrain();
        this.deps.logger.info('Drain complete, resuming work', { source: opts.source });
      }

      // 9. Update metrics
      configReloadTotal.add(1, { result: 'success', source: opts.source });
      if (dbVersion > 0) {
        setConfigVersion(dbVersion);
      }

      // 10. Log success
      this.deps.logger.info('Config reloaded successfully', {
        source: opts.source,
        version: dbVersion,
        fieldsChanged,
        restartRequired: restartRequired.length > 0 ? restartRequired : undefined,
      });

      return {
        success: true,
        version: dbVersion,
        fieldsChanged,
        restartRequired: restartRequired.length > 0 ? restartRequired : undefined,
      };
    } catch (err) {
      const errorMsg = toErrorMessage(err);
      this.deps.logger.error('Config reload failed', {
        error: errorMsg,
        source: opts.source,
      });
      configReloadTotal.add(1, { result: 'failed', source: opts.source });
      return { success: false, errors: [errorMsg] };
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Get the current effective config.
   */
  getCurrentConfig(): AppConfig {
    return this.currentConfig;
  }

  /**
   * Get the current shared config version.
   */
  getCurrentVersion(): number {
    return this.currentVersion;
  }

  /**
   * Install SIGHUP handler for signal-triggered reload.
   * SIGHUP triggers unified reload of both orchestrator config AND scaler config.
   */
  installSignalHandler(): void {
    process.on('SIGHUP', () => {
      this.deps.logger.info('SIGHUP received, triggering config reload');
      this.triggerReload('sighup');
    });
  }

  /**
   * Clean up timers and resources.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

/**
 * Compute a list of top-level config fields that differ between old and new config.
 */
function diffConfigs(oldConfig: AppConfig, newConfig: AppConfig): string[] {
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

  for (const key of allKeys) {
    const oldVal = (oldConfig as unknown as Record<string, unknown>)[key];
    const newVal = (newConfig as unknown as Record<string, unknown>)[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Check if provider config has changed between old and new configs.
 * Provider config is now managed via the sources table, not AppConfig.
 * This always returns false but is kept for the ConfigReloader callback interface.
 */
function hasProviderChanges(_oldConfig: AppConfig, _newConfig: AppConfig): boolean {
  return false;
}

/**
 * Check if Platform connection config has changed between old and new configs.
 */
function hasPlatformChanges(oldConfig: AppConfig, newConfig: AppConfig): boolean {
  return (
    oldConfig.platformUrl !== newConfig.platformUrl ||
    oldConfig.platformToken !== newConfig.platformToken
  );
}
