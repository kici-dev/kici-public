/**
 * Warm pool manager for pre-provisioned idle agents.
 *
 * Each configured label set has a target `size`. On every tick the manager asks
 * the agent registry how many agents could already serve a job with those
 * labels, subtracts the spawns it has issued but not yet seen register, and
 * starts the difference. It holds no list of its own: the agent registry is the
 * single source of truth for what is ready, which is also what the dispatcher
 * reads, so the two can never disagree.
 *
 * Uses a callback pattern to avoid circular dependencies with ScalerManager.
 */

import { normalizeLabelSet } from './label-matcher.js';

export interface WarmPoolCallbacks {
  /** Request the ScalerManager to spawn a new agent for the given label set */
  onSpawnRequest: (labelSet: string[], backendName: string) => Promise<void>;
  /** Request the ScalerManager to destroy an idle agent */
  onDestroyRequest: (managedId: string, backendName: string) => Promise<void>;
  /**
   * How many registered agents could serve a job with this label set right
   * now. Backed by `AgentRegistry.findAvailable`, which is the same query the
   * dispatcher uses — so the warm pool and the dispatcher can never disagree
   * about what "ready" means.
   *
   * A static agent that matches the labels counts: it removes the need for a
   * warm one just as well as a spawned agent does.
   */
  countAvailable: (labels: string[]) => number;
  /**
   * Agents this backend spawned that match the label set and have never run a
   * job, with the timestamp they registered at. `registeredAt` doubles as
   * "idle since": scaler agents are single-use, so an agent still registered
   * with no active job has been idle since it came up.
   *
   * Scoped to the backend because the result feeds the reaper, and the reaper
   * destroys what it is given. A static agent that happens to match the labels
   * is ready capacity, not this pool's to tear down.
   */
  listIdle: (
    labels: string[],
    backendName: string,
  ) => Array<{
    agentId: string;
    registeredAt: number;
  }>;
  /**
   * How many more agents this backend may still start before it reaches the
   * scaler's `maxAgents` or the orchestrator's `globalMaxAgents`, whichever
   * binds first. The deficit is clamped to it, so a pool that cannot reach its
   * target stops asking instead of issuing a spawn the caps refuse every tick.
   */
  capacityRemaining: (backendName: string) => number;
  /**
   * Called at the end of each tick, once the reap and the deficit pass have
   * run. The ScalerManager publishes the warm-pool gauges from it, so they
   * follow the pool rather than the scrape.
   */
  onTick?: () => void;
}

interface WarmPoolConfigEntry {
  backendName: string;
  size: number;
  idleTimeoutSeconds: number;
  /**
   * The labels the readiness and idle queries run with: the declared label set
   * widened by the pool's platform taints. `AgentRegistry.findAvailable` applies
   * each agent's mandatory-labels gate, and a tainted pool's gate carries the
   * taints — so a query built from the declared set alone counts none of the
   * pool's own agents.
   */
  labels: string[];
  /**
   * The declared label set, exactly as the backend has it configured. Every
   * backend resolves the image / binary / VM config by matching the requested
   * set against its own `labelSets` and throws on anything else, so a spawn
   * request carries this — never the widened query labels above.
   *
   * It is also what the manager records on the spawning agent and hands back to
   * `onWarmAgentRegistered` / `onWarmSpawnFailed`, so it must stay the array the
   * `configs` map is keyed by, or an in-flight slot is never released.
   */
  spawnLabels: string[];
}

/** One label set's fill state, as the warm-pool metrics report it. */
export interface WarmPoolStats {
  /**
   * The pool's identity: its normalized DECLARED label set, which is the
   * `configs` map key.
   *
   * This — not `labels` — is what a per-pool metric dimension keys on. Two
   * pools on one scaler can widen to the SAME query set (one label set
   * declaring the plain platform label the other only gets from the taint), so
   * a dimension built from `labels` collapses them into one series and silently
   * drops a pool's fill state.
   */
  key: string;
  /** The widened query set the `ready` count was measured with. */
  labels: string[];
  backendName: string;
  target: number;
  ready: number;
  inFlight: number;
}

/** How often the manager runs a deficit pass and reaps timed-out agents. */
const WARM_POOL_TICK_MS = 30_000;

export class WarmPoolManager {
  private readonly callbacks: WarmPoolCallbacks;

  /** Configuration per normalized label set */
  private readonly configs = new Map<string, WarmPoolConfigEntry>();

  /**
   * Warm spawns issued but not yet registered, per normalized label set.
   *
   * Load-bearing: without it, two passes landing before the first spawn
   * registers would each see the full deficit and issue `size` spawns apiece.
   */
  private readonly inFlight = new Map<string, number>();

  /** Periodic deficit + idle check interval */
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: WarmPoolCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Configure the warm pool for a label set.
   * Called during ScalerManager initialization based on YAML config.
   *
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
   * One deficit pass. For each configured label set, top the pool up to its
   * target: `size - ready - inFlight`, clamped by the backend's remaining cap
   * headroom.
   *
   * The per-backend budget is tracked across the whole pass: two label sets on
   * one scaler draw from the same `maxAgents`, so clamping each against the
   * same starting headroom would let them jointly overshoot it.
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
          // A spawn that fails inside the ScalerManager is logged there, and it
          // calls `onWarmSpawnFailed` itself — that path resolves, so this
          // handler never sees it. A REJECTED request is the other case: it
          // failed before reaching that handler, so nothing released the slot.
          // Release it here, or it is held forever and the pool sits
          // permanently below target.
          this.releaseInFlight(normalized);
        });
      }
    }
  }

  /** A warm spawn registered: release its in-flight slot. */
  onWarmAgentRegistered(labels: string[]): void {
    this.releaseInFlight(normalizeLabelSet(labels));
  }

  /**
   * A warm spawn failed, timed out, or was pruned as never-registered: release
   * its in-flight slot so the next pass retries it. Without this the slot is
   * held forever and the pool sits permanently below target.
   */
  onWarmSpawnFailed(labels: string[]): void {
    this.releaseInFlight(normalizeLabelSet(labels));
  }

  private releaseInFlight(normalized: string): void {
    const pending = this.inFlight.get(normalized) ?? 0;
    if (pending <= 1) this.inFlight.delete(normalized);
    else this.inFlight.set(normalized, pending - 1);
  }

  /** Per-label-set fill state, for the warm-pool metrics. */
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
   * Start the periodic tick: reap surplus agents past their idle timeout, then
   * top the pools back up.
   *
   * The first pass runs immediately rather than a tick later. Both hosts call
   * this only after `ensureHostsReady()`, so spawning here is safe — and
   * waiting would leave the pool empty for 30 seconds after every restart,
   * which is precisely the cold start it exists to remove.
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

  /**
   * Stop the periodic tick.
   */
  stop(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Total ready agents across every configured pool. Surfaced by
   * `getStatus().warmPoolCount`.
   */
  getTotalPoolSize(): number {
    return this.getStats().reduce((sum, row) => sum + row.ready, 0);
  }

  /**
   * Update configs. Destroy surplus agents in pools that shrunk, and drop
   * pools whose config disappeared (the scaler was removed from the config,
   * or its `warmPool.enabled` flipped to false) — a warm agent must not
   * outlive the config that asked for it.
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
    // Drop configs that disappeared and destroy their idle agents. Done before
    // the new configs land so a label set present in both is not read as
    // removed.
    for (const [normalizedLabels, config] of [...this.configs]) {
      if (newConfigs.has(normalizedLabels)) continue;
      this.destroyIdle(config, 0);
      this.configs.delete(normalizedLabels);
      this.inFlight.delete(normalizedLabels);
    }

    // Update existing configs and add new ones.
    for (const [normalizedLabels, config] of newConfigs) {
      this.configs.set(normalizedLabels, config);
    }

    // Destroy the surplus in pools that shrunk. The idle reaper would get to
    // them eventually, but only after a full idleTimeoutSeconds — an operator
    // who lowers `size` means now.
    for (const config of newConfigs.values()) {
      this.destroyIdle(config, config.size);
    }
  }

  /**
   * Destroy this pool's idle agents beyond `keep`, oldest first.
   *
   * Oldest-first because the survivors are the ones with the most time left
   * before the idle reaper takes them, which is the set an arriving job is
   * most likely to find still ready.
   */
  private destroyIdle(config: WarmPoolConfigEntry, keep: number): void {
    let idle: Array<{ agentId: string; registeredAt: number }>;
    try {
      idle = this.callbacks.listIdle(config.labels, config.backendName);
    } catch {
      // An unreadable registry says nothing about what is idle; destroying on a
      // blind list would tear down agents that may not even exist.
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
   * its timeout. `registeredAt` is the idle-since stamp: scaler agents are
   * single-use, so an agent still registered with no active job has never run
   * one.
   *
   * The target check is what stops the pool churning against itself. Reaping
   * on age alone means a quiet pool destroys its own agent every
   * `idleTimeoutSeconds` and immediately re-spawns it: the provisioning
   * workflow runs forever on zero traffic, and — because an event-backend
   * replacement takes minutes to boot — the pool is below target for much of
   * every cycle. A warm pool that is cold most of the time is worse than none.
   * So the timeout trims surplus only: a pool sitting at `size` never reaps.
   *
   * `size: 0` still drains, because then every ready agent is surplus.
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

      // Oldest first: the survivors are the ones with the most time left, which
      // is the set an arriving job is most likely to find still ready.
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
