/**
 * Warm pool manager for pre-provisioned idle agents.
 *
 * Tracks idle agents per label set, handles idle timeout expiry,
 * and triggers replenishment when a warm agent is consumed.
 * Uses callback pattern to avoid circular dependencies with ScalerManager.
 */

export interface WarmPoolCallbacks {
  /** Request the ScalerManager to spawn a new agent for the given label set */
  onSpawnRequest: (labelSet: string[], backendName: string) => Promise<void>;
  /** Request the ScalerManager to destroy an idle agent */
  onDestroyRequest: (managedId: string, backendName: string) => Promise<void>;
}

interface WarmPoolEntry {
  managedId: string;
  backendName: string;
  idleStartedAt: number;
}

interface WarmPoolConfigEntry {
  backendName: string;
  size: number;
  idleTimeoutSeconds: number;
  /** The original label set array for spawn requests */
  labels: string[];
}

export class WarmPoolManager {
  private readonly callbacks: WarmPoolCallbacks;

  /** Pools of idle agents keyed by normalized label set string */
  private readonly pools = new Map<string, WarmPoolEntry[]>();

  /** Configuration per normalized label set */
  private readonly configs = new Map<string, WarmPoolConfigEntry>();

  /** Periodic idle check interval */
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: WarmPoolCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Configure the warm pool for a label set.
   * Called during ScalerManager initialization based on YAML config.
   */
  configure(
    normalizedLabels: string,
    backendName: string,
    config: { size: number; idleTimeoutSeconds: number; labels: string[] },
  ): void {
    this.configs.set(normalizedLabels, {
      backendName,
      size: config.size,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      labels: config.labels,
    });

    // Ensure pool exists
    if (!this.pools.has(normalizedLabels)) {
      this.pools.set(normalizedLabels, []);
    }
  }

  /**
   * Add an agent to the warm pool.
   * Called when a freshly spawned warm pool agent has registered but has no job.
   */
  addIdleAgent(normalizedLabels: string, managedId: string, backendName: string): void {
    let pool = this.pools.get(normalizedLabels);
    if (!pool) {
      pool = [];
      this.pools.set(normalizedLabels, pool);
    }

    pool.push({
      managedId,
      backendName,
      idleStartedAt: Date.now(),
    });
  }

  /**
   * Consume an agent from the warm pool for the given label set.
   * Returns the managedId (FIFO order) or null if pool is empty.
   * After consuming, schedules replenishment on next tick.
   */
  consumeAgent(normalizedLabels: string): string | null {
    const pool = this.pools.get(normalizedLabels);
    if (!pool || pool.length === 0) return null;

    // FIFO: shift from front
    const entry = pool.shift()!;

    // Schedule replenishment on next tick to avoid blocking dispatch
    const config = this.configs.get(normalizedLabels);
    if (config) {
      queueMicrotask(() => {
        this.replenish(normalizedLabels);
      });
    }

    return entry.managedId;
  }

  /**
   * Check if pool is below configured size and request spawns for the deficit.
   */
  replenish(normalizedLabels: string): void {
    const config = this.configs.get(normalizedLabels);
    if (!config) return;

    const pool = this.pools.get(normalizedLabels) ?? [];
    const deficit = config.size - pool.length;

    for (let i = 0; i < deficit; i++) {
      this.callbacks.onSpawnRequest(config.labels, config.backendName).catch(() => {
        // Spawn failures are logged by the ScalerManager
      });
    }
  }

  /**
   * Start periodic idle check (every 30 seconds).
   * Destroys agents that have been idle past their timeout.
   */
  start(): void {
    if (this.idleCheckInterval) return;

    this.idleCheckInterval = setInterval(() => {
      this.checkIdleTimeouts();
    }, 30_000);
  }

  /**
   * Stop the periodic idle check interval.
   */
  stop(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Return current warm pool count for a label set.
   */
  getPoolSize(normalizedLabels: string): number {
    const pool = this.pools.get(normalizedLabels);
    return pool ? pool.length : 0;
  }

  /**
   * Return total warm agents across all pools.
   */
  getTotalPoolSize(): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      total += pool.length;
    }
    return total;
  }

  /**
   * Update configs. Drain excess agents from pools that shrunk.
   * Does NOT remove agents from pools whose config was removed --
   * let idle timeout handle that gracefully.
   */
  reload(
    newConfigs: Map<
      string,
      { backendName: string; size: number; idleTimeoutSeconds: number; labels: string[] }
    >,
  ): void {
    // Update existing configs and add new ones
    for (const [normalizedLabels, config] of newConfigs) {
      this.configs.set(normalizedLabels, config);

      if (!this.pools.has(normalizedLabels)) {
        this.pools.set(normalizedLabels, []);
      }
    }

    // Drain excess agents from pools that shrunk
    for (const [normalizedLabels, config] of newConfigs) {
      const pool = this.pools.get(normalizedLabels);
      if (pool && pool.length > config.size) {
        const excess = pool.splice(config.size);
        for (const entry of excess) {
          this.callbacks.onDestroyRequest(entry.managedId, entry.backendName).catch(() => {
            // Destroy failures are logged by the ScalerManager
          });
        }
      }
    }
  }

  /**
   * Check for idle agents past their timeout and destroy them.
   * Exposed for testing.
   */
  checkIdleTimeouts(): void {
    const now = Date.now();

    for (const [normalizedLabels, pool] of this.pools) {
      const config = this.configs.get(normalizedLabels);
      if (!config) continue;

      const timeoutMs = config.idleTimeoutSeconds * 1000;
      const expired: WarmPoolEntry[] = [];
      const remaining: WarmPoolEntry[] = [];

      for (const entry of pool) {
        if (now - entry.idleStartedAt > timeoutMs) {
          expired.push(entry);
        } else {
          remaining.push(entry);
        }
      }

      // Replace pool with non-expired entries
      this.pools.set(normalizedLabels, remaining);

      // Destroy expired agents
      for (const entry of expired) {
        this.callbacks.onDestroyRequest(entry.managedId, entry.backendName).catch(() => {
          // Destroy failures are logged by the ScalerManager
        });
      }
    }
  }
}
