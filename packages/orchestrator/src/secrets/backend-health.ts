/**
 * Backend health checker for multi-source secret management.
 *
 * Probes PG and Vault backends for connectivity and reports health status.
 * Used on orchestrator startup and periodically to detect degraded backends.
 */
import type { BackendHealthStatus, AddBackendParams } from '@kici-dev/engine';
import { serializeError, toErrorMessage } from '@kici-dev/shared';
import type { Logger } from '@kici-dev/shared';
import type { BackendRegistry } from './backend-registry.js';

/** Health check timeout in milliseconds. */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/** PG probe function type — injectable for testing. */
export type PgProbe = (connectionString?: string) => Promise<void>;

/**
 * Default PG probe: creates a pool via the shared factory (which attaches
 * the connection-error handlers), runs SELECT 1, ends the pool.
 */
async function defaultPgProbe(connectionString?: string): Promise<void> {
  const { createPool } = await import('@kici-dev/shared');
  const pool = createPool(connectionString ?? '', {
    config: {
      connectionTimeoutMillis: HEALTH_CHECK_TIMEOUT_MS,
      max: 1,
    },
  });
  try {
    await pool.query('SELECT 1');
  } finally {
    await pool.end();
  }
}

/**
 * Probes secret backends for connectivity and tracks health status.
 */
export class BackendHealthChecker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly pgProbe: PgProbe;

  constructor(
    private readonly registry: BackendRegistry,
    private readonly logger: Logger,
    pgProbe?: PgProbe,
  ) {
    this.pgProbe = pgProbe ?? defaultPgProbe;
  }

  /**
   * Check health of a single backend by name.
   * Updates the registry with the result.
   */
  async checkHealth(name: string): Promise<BackendHealthStatus> {
    const config = await this.registry.getBackendConfig(name);
    if (!config) {
      this.logger.warn('Backend not found for health check', { name });
      return 'unknown';
    }

    const backend = await this.registry.getBackend(name);
    if (!backend) return 'unknown';

    const status = await this.probeBackend(backend.backendType, config);

    await this.registry.updateHealthStatus(
      name,
      status,
      status === 'unreachable' ? 'Health check failed' : undefined,
    );

    this.logger.info('Backend health check completed', { name, status });
    return status;
  }

  /**
   * Check health of all enabled backends in parallel.
   */
  async checkAllBackends(): Promise<Map<string, BackendHealthStatus>> {
    const backends = await this.registry.listBackends();
    const enabledBackends = backends.filter((b) => b.enabled);
    const results = new Map<string, BackendHealthStatus>();

    await Promise.all(
      enabledBackends.map(async (backend) => {
        try {
          const status = await this.checkHealth(backend.name);
          results.set(backend.name, status);
        } catch (err) {
          const errorCtx = serializeError(err);
          this.logger.error('Health check failed for backend', {
            name: backend.name,
            ...errorCtx,
          });
          results.set(backend.name, 'unreachable');
          await this.registry.updateHealthStatus(
            backend.name,
            'unreachable',
            String(errorCtx.message ?? ''),
          );
        }
      }),
    );

    return results;
  }

  /**
   * Start periodic health checks at the given interval.
   */
  startPeriodicCheck(intervalMs = 60000): void {
    this.stopPeriodicCheck();
    this.intervalHandle = setInterval(() => {
      this.checkAllBackends().catch((err) => {
        this.logger.error('Periodic health check failed', serializeError(err));
      });
    }, intervalMs);

    // Don't block process exit
    if (
      this.intervalHandle &&
      typeof this.intervalHandle === 'object' &&
      'unref' in this.intervalHandle
    ) {
      this.intervalHandle.unref();
    }
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicCheck(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Test connectivity to a backend without persisting it.
   * Creates an ephemeral connection and probes it.
   */
  async testConnection(
    params: AddBackendParams,
  ): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    const start = Date.now();
    try {
      const status = await this.probeBackend(params.backendType, params.config);
      const latencyMs = Date.now() - start;
      if (status === 'healthy') {
        return { ok: true, latencyMs };
      }
      return { ok: false, error: `Backend status: ${status}`, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return { ok: false, error: toErrorMessage(err), latencyMs };
    }
  }

  /**
   * Probe a backend by type and return its health status.
   */
  private async probeBackend(
    backendType: string,
    config: Record<string, unknown>,
  ): Promise<BackendHealthStatus> {
    switch (backendType) {
      case 'pg':
        return this.probePg(config);
      case 'vault':
        return this.probeVault(config);
      default:
        return 'unknown';
    }
  }

  /**
   * Probe a PG backend by running SELECT 1.
   */
  private async probePg(_config: Record<string, unknown>): Promise<BackendHealthStatus> {
    try {
      // Built-in PG backend has empty config — fall back to the orchestrator's
      // own KICI_DATABASE_URL.
      const connectionString =
        (_config.connectionString as string) || process.env.KICI_DATABASE_URL || undefined;
      await this.pgProbe(connectionString);
      return 'healthy';
    } catch (err) {
      this.logger.warn('PG probe failed', serializeError(err));
      return 'unreachable';
    }
  }

  /**
   * Probe a Vault backend by checking /v1/sys/health.
   */
  private async probeVault(config: Record<string, unknown>): Promise<BackendHealthStatus> {
    const vaultUrl = config.vaultUrl as string;
    if (!vaultUrl) {
      this.logger.warn('Vault probe skipped: missing vaultUrl in config');
      return 'unreachable';
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      try {
        const response = await fetch(`${vaultUrl}/v1/sys/health`, {
          signal: controller.signal,
        });

        // Vault /sys/health returns different status codes:
        // 200: initialized, unsealed, active
        // 429: unsealed, standby
        // 472: disaster recovery secondary
        // 473: performance standby
        // 501: not initialized
        // 503: sealed
        if (response.ok || response.status === 429 || response.status === 473) {
          const body = (await response.json()) as Record<string, unknown>;
          if (body.sealed === true) {
            return 'degraded';
          }
          return 'healthy';
        }

        if (response.status === 503) {
          return 'degraded';
        }

        this.logger.warn('Vault probe returned unexpected status', {
          vaultUrl,
          status: response.status,
          statusText: response.statusText,
        });
        return 'unreachable';
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      this.logger.warn('Vault probe failed', { vaultUrl, ...serializeError(err) });
      return 'unreachable';
    }
  }
}
