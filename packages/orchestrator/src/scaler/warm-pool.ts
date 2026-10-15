/**
 * Warm pool manager for pre-provisioned idle agents.
 *
 * Each configured label set has a target `size`. Every tick the manager starts
 * `size - ready - inFlight` agents, where `ready` comes from the agent registry.
 * It holds no list of its own: the registry is the single source of truth for
 * what is ready, and the dispatcher reads it too, so the two never disagree.
 *
 * Callbacks avoid a circular dependency with ScalerManager.
 */

import { normalizeLabelSet } from './label-matcher.js';

export interface WarmPoolCallbacks {
  onSpawnRequest: (labelSet: string[], backendName: string) => Promise<void>;
  onDestroyRequest: (managedId: string, backendName: string) => Promise<void>;
  /**
   * Registered agents that could serve a job with this label set now, via
   * `AgentRegistry.findAvailable` — the dispatcher's own query. A matching
   * static agent counts: it removes the need for a warm one just as well.
   */
  countAvailable: (labels: string[]) => number;
  /**
   * Agents this backend spawned that match the label set and have never run a
   * job. `registeredAt` doubles as "idle since": scaler agents are single-use.
   *
   * Scoped to the backend because the reaper destroys what it is given; a
   * matching static agent is ready capacity, not this pool's to tear down.
   */
  listIdle: (
    labels: string[],
    backendName: string,
  ) => Array<{
    agentId: string;
    registeredAt: number;
  }>;
  /**
   * Headroom before the scaler's `maxAgents` or the orchestrator's
   * `globalMaxAgents`, whichever binds first. The deficit is clamped to it, so
   * a pool that cannot reach its target stops issuing spawns the caps refuse.
   */
  capacityRemaining: (backendName: string) => number;
  /**
   * Runs after each tick's reap and deficit pass; the ScalerManager publishes
   * the warm-pool gauges from it, so they follow the pool rather than the scrape.
   */
  onTick?: () => void;
}

interface WarmPoolConfigEntry {
  backendName: string;
  size: number;
  idleTimeoutSeconds: number;
  /**
   * The declared label set widened by the pool's platform taints, for the
   * readiness and idle queries. `AgentRegistry.findAvailable` applies each
   * agent's mandatory-labels gate, which carries the taints, so a query from
   * the declared set alone counts none of the pool's own agents.
   */
  labels: string[];
  /**
   * The declared label set, exactly as configured. Every backend resolves its
   * image / binary / VM config by matching against its own `labelSets` and
   * throws on anything else, so a spawn carries this — never the widened labels.
   *
   * The manager also hands it back to `onWarmAgentRegistered` /
   * `onWarmSpawnFailed`, so it must stay the array the `configs` map is keyed
   * by, or an in-flight slot is never released.
   */
  spawnLabels: string[];
}

export interface WarmPoolStats {
  /**
   * The normalized DECLARED label set (the `configs` key). Per-pool metric
   * dimensions key on this, not `labels`: two pools on one scaler can widen to
   * the SAME query set (one declares the platform label the other gets from the
   * taint), and keying on `labels` would silently drop a pool's fill state.
   */
  key: string;
  /** The widened query set the `ready` count was measured with. */
  labels: string[];
  backendName: string;
  target: number;
  ready: number;
  inFlight: number;
}

/** Deficit-pass and idle-reap interval. */
const WARM_POOL_TICK_MS = 30_000;

export class WarmPoolManager {
  private readonly callbacks: WarmPoolCallbacks;

  private readonly configs = new Map<string, WarmPoolConfigEntry>();

  /**
   * Warm spawns issued but not yet registered, per normalized label set.
   * Without it, two passes before the first spawn registers would each issue
   * `size` spawns.
   */
  private readonly inFlight = new Map<string, number>();

  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: WarmPoolCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * `normalizedLabels` keys the pool by its DECLARED label set, which is what
   * every in-flight release path normalizes back to.
   */
  configure(
    normalizedLabels: string,
    backendName: string,
    config: {
      size: number;
      idleTimeoutSeconds: number;
      labels: string[];
      spawnLabels: string[];
    },
  ): void {
    this.configs.set(normalizedLabels, {
      backendName,
      size: config.size,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      labels: config.labels,
      spawnLabels: config.spawnLabels,
    });
  }

  /**
   * One deficit pass. The per-backend budget spans the whole pass: two label
   * sets on one scaler draw from the same `maxAgents`, so clamping each against
   * the same starting headroom would let them jointly overshoot it.
   */
  evaluate(): void {
    const budgets = new Map<string, number>();

    for (const [normalized, config] of this.configs) {
      if (config.size <= 0) continue;

      let ready: number;
      try {
        ready = this.callbacks.countAvailable(config.labels);
      } catch {
        // A registry that cannot answer is not evidence of an empty pool —
        // skip this label set rather than spawning against a blind count.
        continue;
      }

      const pending = this.inFlight.get(normalized) ?? 0;
      let deficit = config.size - ready - pending;
      if (deficit <= 0) continue;

      if (!budgets.has(config.backendName)) {
        let headroom: number;
        try {
          headroom = this.callbacks.capacityRemaining(config.backendName);
        } catch {
          // Same rule as the registry: an unreadable cap is not headroom.
          continue;
        }
        budgets.set(config.backendName, headroom);
      }
      const budget = budgets.get(config.backendName) ?? 0;
      if (budget <= 0) continue;
      if (deficit > budget) deficit = budget;
      budgets.set(config.backendName, budget - deficit);

      this.inFlight.set(normalized, pending + deficit);
      for (let i = 0; i < deficit; i++) {
        this.callbacks.onSpawnRequest(config.spawnLabels, config.backendName).catch(() => {
          // A spawn failing inside the ScalerManager resolves and calls
          // `onWarmSpawnFailed` itself. A REJECTED request failed before that,
          // so nothing released the slot: release it here, or the pool sits
          // permanently below target.
          this.releaseInFlight(normalized);
        });
      }
    }
  }

  onWarmAgentRegistered(labels: string[]): void {
    this.releaseInFlight(normalizeLabelSet(labels));
  }

  /**
   * A warm spawn failed, timed out, or was pruned as never-registered: release
   * its in-flight slot so the next pass retries it.
   */
  onWarmSpawnFailed(labels: string[]): void {
    this.releaseInFlight(normalizeLabelSet(labels));
  }

  private releaseInFlight(normalized: string): void {
    const pending = this.inFlight.get(normalized) ?? 0;
    if (pending <= 1) this.inFlight.delete(normalized);
    else this.inFlight.set(normalized, pending - 1);
  }

  getStats(): WarmPoolStats[] {
    const rows: WarmPoolStats[] = [];
    for (const [normalized, config] of this.configs) {
      let ready = 0;
      try {
        ready = this.callbacks.countAvailable(config.labels);
      } catch {
        ready = 0;
      }
      rows.push({
        key: normalized,
        labels: config.labels,
        backendName: config.backendName,
        target: config.size,
        ready,
        inFlight: this.inFlight.get(normalized) ?? 0,
      });
    }
    return rows;
  }

  /**
   * Start the periodic tick: reap surplus idle agents, then top the pools up.
   *
   * The first pass runs immediately: waiting a tick would leave the pool empty
   * for 30 seconds after every restart, the cold start it exists to remove. It
   * is safe because the one caller, `ScalerManager.startWarmPools()`, runs only
   * after `ensureHostsReady()` and, on the coordinator, after the event emitter
   * is assigned.
   */
  start(): void {
    if (this.idleCheckInterval) return;

    const tick = () => {
      this.checkIdleTimeouts();
      this.evaluate();
      this.callbacks.onTick?.();
    };

    this.idleCheckInterval = setInterval(tick, WARM_POOL_TICK_MS);
    tick();
  }

  stop(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /** Ready agents across every pool; surfaced by `getStatus().warmPoolCount`. */
  getTotalPoolSize(): number {
    return this.getStats().reduce((sum, row) => sum + row.ready, 0);
  }

  /**
   * Destroy surplus agents in pools that shrunk, and drop pools whose config
   * disappeared (scaler removed, or `warmPool.enabled` set to false) — a warm
   * agent must not outlive the config that asked for it.
   */
  reload(
    newConfigs: Map<
      string,
      {
        backendName: string;
        size: number;
        idleTimeoutSeconds: number;
        labels: string[];
        spawnLabels: string[];
      }
    >,
  ): void {
    // Runs before the new configs land, so a label set in both is not read as removed.
    for (const [normalizedLabels, config] of [...this.configs]) {
      if (newConfigs.has(normalizedLabels)) continue;
      this.destroyIdle(config, 0);
      this.configs.delete(normalizedLabels);
      this.inFlight.delete(normalizedLabels);
    }

    for (const [normalizedLabels, config] of newConfigs) {
      this.configs.set(normalizedLabels, config);
    }

    // The idle reaper would wait a full idleTimeoutSeconds; an operator who
    // lowers `size` means now.
    for (const config of newConfigs.values()) {
      this.destroyIdle(config, config.size);
    }
  }

  /**
   * Destroy this pool's idle agents beyond `keep`, oldest first: the survivors
   * have the most time left before the idle reaper, so an arriving job is most
   * likely to find them still ready.
   */
  private destroyIdle(config: WarmPoolConfigEntry, keep: number): void {
    let idle: Array<{ agentId: string; registeredAt: number }>;
    try {
      idle = this.callbacks.listIdle(config.labels, config.backendName);
    } catch {
      // Destroying on a blind list could tear down agents that may not exist.
      return;
    }
    if (idle.length <= keep) return;

    const surplus = [...idle]
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .slice(0, idle.length - keep);
    for (const agent of surplus) {
      this.callbacks.onDestroyRequest(agent.agentId, config.backendName).catch(() => {
        // Destroy failures are logged by the ScalerManager
      });
    }
  }

  /**
   * Destroy agents that are BOTH surplus to the pool's target AND idle past
   * its timeout (`registeredAt` is the idle-since stamp).
   *
   * The target check stops the pool churning against itself. Reaping on age
   * alone makes a quiet pool destroy and re-spawn its agent every
   * `idleTimeoutSeconds`: the provisioning workflow runs forever on zero
   * traffic, and since an event-backend replacement takes minutes to boot, the
   * pool is below target for much of every cycle. So a pool at `size` never
   * reaps; `size: 0` still drains, since every ready agent is then surplus.
   *
   * Exposed for testing.
   */
  checkIdleTimeouts(): void {
    const now = Date.now();

    for (const config of this.configs.values()) {
      const timeoutMs = config.idleTimeoutSeconds * 1000;

      let idle: Array<{ agentId: string; registeredAt: number }>;
      try {
        idle = this.callbacks.listIdle(config.labels, config.backendName);
      } catch {
        continue;
      }

      const excess = Math.max(0, idle.length - config.size);
      if (excess === 0) continue;

      // Oldest first, as in destroyIdle.
      const candidates = [...idle].sort((a, b) => a.registeredAt - b.registeredAt).slice(0, excess);

      for (const agent of candidates) {
        if (now - agent.registeredAt <= timeoutMs) continue;
        this.callbacks.onDestroyRequest(agent.agentId, config.backendName).catch(() => {
          // Destroy failures are logged by the ScalerManager
        });
      }
    }
  }
}
