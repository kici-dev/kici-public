/**
 * ScalerManager: central coordinator for all scaler backends.
 *
 * Sits between the orchestrator's Dispatcher and individual scaler backends.
 * Receives "no agent available" signals, routes to the correct backend,
 * enforces global limits, tracks spawning agents to prevent over-provisioning,
 * and manages the agent lifecycle from spawn to destroy.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  deriveOsArchLabels,
  derivePlatformTaints,
  platformToOsArchLabels,
  platformToTaints,
  hostToScalerPlatform,
  PLATFORM_TAINT_LABELS,
  agentTypeLabel,
  scalerLabel,
  resolveRoleLabels,
} from '@kici-dev/engine';
import type { ResourceRequest, ScalerPlatform } from '@kici-dev/engine';
import {
  normalizeLabelSet,
  findBackendForLabels,
  detectLabelSetOverlaps,
} from './label-matcher.js';
import { AgentLogForwarder } from './log-forwarder.js';
import { WarmPoolManager } from './warm-pool.js';
import { parseMemoryString, DEFAULT_MAX_CONCURRENT_SPAWNS } from './config.js';
import { MachineLedger } from './machine-ledger.js';
import {
  setScalerUsageBreakdown,
  incScalerSpawnRefusals,
  scalerSpawnFailuresTotal,
  ScalerSpawnFailureBound,
} from '../metrics/prometheus.js';
import { ScalerEventType } from './types.js';
import { ScalerFailureTracker } from './failure-tracker.js';
import type { BackendFailureSummary } from './failure-tracker.js';
import type {
  ScalerBackend,
  ScalerConfig,
  ScalerEntry,
  ScaleResult,
  ScalerEvent,
  ResourceCap,
  ValidationResult,
  ManagedAgent,
} from './types.js';
import type { ScalerStateStore, ScalerStateRecovery } from './scaler-state-store.js';

const logger = createLogger({ prefix: 'scaler' });

/**
 * Counting semaphore that throttles the number of concurrent async operations.
 *
 * Used to bound how many `backend.spawn` provisioning operations (image pull +
 * container create + start) run at once per backend, so a burst of in-cap jobs
 * cannot storm the container socket / registry.
 *
 * Slots are handed directly to the next waiter on release (rather than bumping a
 * counter the woken task re-decrements), so a task arriving in the microtask gap
 * between a release and a woken waiter cannot jump the queue and transiently
 * exceed the cap. The slot is always released in `run`'s `finally`, so a failed
 * or throwing operation never leaks a slot and wedges the queue.
 */
export class SpawnSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    // No slot free: queue and wait for release() to hand one over directly.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the waiter; `available` stays decremented.
      next();
    } else {
      this.available += 1;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Resolved per-job resource amounts (cpus + bytes) for both `requests` and
 * `limits`. The scaler manager produces this from the job's declared resources
 * combined with the scaler's `defaults.resources`, applying the request<->limit
 * mirroring rule. Caps aggregate `requests`; backends use `limits`.
 */
/**
 * Resolve the orchestrator WebSocket URL a scaler-spawned agent should dial.
 *
 * 1. Per-scaler `orchestratorUrl` (scalers.yaml) wins — required for container
 *    agents (host.docker.internal / LAN IP) and Firecracker VMs (bridge gateway
 *    IP), which cannot reach the orchestrator over the host's loopback.
 * 2. `KICI_ORCHESTRATOR_URL` env override.
 * 3. Default `ws://127.0.0.1:<orchestrator-port>/ws` — for local (bare-metal)
 *    agents that share the host. The port is the orchestrator's own bind port
 *    (`KICI_PORT`, default 4000), NOT the agent's 8080 default; pointing local
 *    agents at 8080 leaves them unable to reach the orchestrator.
 */
export function resolveScalerOrchestratorUrl(
  configUrl: string | undefined,
  envUrl: string | undefined,
  port: string | number | undefined,
): string {
  if (configUrl) return configUrl;
  if (envUrl) return envUrl;
  return `ws://127.0.0.1:${port ?? '4000'}/ws`;
}

export interface ResolvedResources {
  requests: { cpus: number; memBytes: number };
  limits: { cpus: number; memBytes: number };
}

/** Per-scaler / per-orchestrator running totals (cpus + bytes). Always reflects sums of `requests`. */
interface UsageCounter {
  cpus: number;
  memBytes: number;
}

/** Tracking entry for an outstanding reservation (so we can release on agent disconnect). */
interface ReservationEntry {
  scalerName: string;
  requests: { cpus: number; memBytes: number };
}

/**
 * Apply the request<->limit mirroring rule: if only one side is set, copy it
 * to the other; if neither is set, return undefined; if both are set, leave them.
 *
 * Returns a fully nested `{ requests, limits }` shape, or undefined if the
 * input doesn't declare anything.
 */
function mirrorRequestsLimits(resources: ResourceRequest | undefined): ResourceRequest | undefined {
  if (!resources) return undefined;
  const hasReq = resources.requests !== undefined;
  const hasLim = resources.limits !== undefined;
  if (!hasReq && !hasLim) return undefined;
  if (hasReq && hasLim) return resources;
  if (hasReq) return { requests: resources.requests, limits: resources.requests };
  return { requests: resources.limits, limits: resources.limits };
}

/**
 * Build the scaler-usage metric rows: one per active scaler (stamped with its
 * backend type) plus a `__global__` rollup row. Pure so it is unit-testable
 * without constructing a full ScalerManager.
 */
export function buildScalerUsageRows(
  perScalerUsage: ReadonlyMap<string, { cpus: number; memBytes: number }>,
  globalUsage: { cpus: number; memBytes: number },
  scalerTypeOf: (name: string) => string | undefined,
): Array<{ scaler: string; scalerType?: string; cpus: number; memBytes: number }> {
  const rows: Array<{ scaler: string; scalerType?: string; cpus: number; memBytes: number }> = [];
  for (const [scaler, usage] of perScalerUsage.entries()) {
    rows.push({
      scaler,
      scalerType: scalerTypeOf(scaler),
      cpus: usage.cpus,
      memBytes: usage.memBytes,
    });
  }
  rows.push({
    scaler: '__global__',
    scalerType: '__global__',
    cpus: globalUsage.cpus,
    memBytes: globalUsage.memBytes,
  });
  return rows;
}

/**
 * Status summary for metrics and health endpoints.
 */
export interface ScalerStatus {
  globalMaxAgents: number;
  globalActiveCount: number;
  spawningCount: number;
  warmPoolCount: number;
  /** Sum of `requests.cpus` / `requests.memBytes` reserved across all scalers. */
  globalUsage: { cpus: number; memBytes: number };
  /** Per-orchestrator resource cap, if configured. */
  globalResourceCap?: ResourceCap;
  backends: Array<{
    name: string;
    type: string;
    activeCount: number;
    maxAgents: number;
    /** Whether this backend spawns its agents on the orchestrator's own host. */
    spawnsOnLocalHost: boolean;
    /** Label sets this backend can provision (each entry is a string[] of labels) */
    labelSets: string[][];
    /** Sum of `requests` reserved by this scaler's active agents. */
    usage: { cpus: number; memBytes: number };
    /** Per-scaler resource cap, if configured. */
    resourceCap?: ResourceCap;
    /** Machine-pool reference, if any. */
    machinePool?: string;
    /**
     * Labels a job MUST declare in `runsOn` to be allowed on this backend.
     * Empty array = no gate. Surfaced in heartbeat-side scaler capacity
     * summaries so cross-peer routing applies the same gate.
     */
    mandatoryLabels: string[];
  }>;
}

/**
 * Internal tracking for agents being spawned but not yet registered.
 */
interface SpawningEntry {
  labelSet: string[];
  backendName: string;
  /** When this entry was enqueued (created + reserved). Persisted for recovery. */
  spawnedAt: number;
  /**
   * When the throttled `backend.spawn` actually started (semaphore admitted it).
   * Undefined while the spawn is still queued behind the per-backend spawn
   * semaphore. The stale-prune measures the "spawned but never registered"
   * window from here, NOT from `spawnedAt` — a spawn waiting in the semaphore
   * queue has not started yet and must not be reaped as a crashed startup.
   */
  spawnStartedAt?: number;
  /**
   * Queue jobId this agent was spawned for. When the agent registers, the
   * orchestrator dispatches this job eagerly instead of going through the
   * generic queue drain, eliminating the dispatch-vs-idle-timer race.
   * Undefined for warm-pool replenishment spawns (no specific job).
   */
  boundJobId?: string;
  /** Run this spawn's bound job belongs to. Undefined for warm-pool spawns. */
  runId?: string;
}

export class ScalerManager {
  private readonly backends = new Map<string, ScalerBackend>();
  private readonly backendRoles = new Map<string, string[] | undefined>();
  /** Recent scaler spawn failures, surfaced by `kici-admin diagnose`. */
  private readonly failureTracker = new ScalerFailureTracker();
  private globalMaxAgents: number;

  /** Per-scaler resource caps (`{ maxCpu, maxMemoryBytes }`), keyed by scaler name. */
  private readonly resourceCaps = new Map<string, ResourceCap>();
  /** Per-scaler default resources (used when neither job nor label-set declares them). */
  private readonly scalerDefaults = new Map<string, ResourceRequest | undefined>();
  /** Per-scaler usage counters (sum of `requests` for active + spawning agents). */
  private readonly perScalerUsage = new Map<string, UsageCounter>();
  /** Orchestrator-wide cap on summed `requests`. */
  private globalResourceCap: ResourceCap | undefined;
  /** Orchestrator-wide usage counter. */
  private readonly globalUsage: UsageCounter = { cpus: 0, memBytes: 0 };
  /** Per-scaler machine-pool name (set when scalers reference a pool). */
  private readonly scalerMachinePools = new Map<string, string | undefined>();
  /** Per-scaler cap on concurrent `backend.spawn` operations (provisioning-rate throttle). */
  private readonly maxConcurrentSpawns = new Map<string, number>();
  /** Per-scaler spawn throttles, created lazily from `maxConcurrentSpawns`. */
  private readonly spawnSemaphores = new Map<string, SpawnSemaphore>();
  /** Outstanding reservations keyed by agentId; used to release on disconnect. */
  private readonly reservations = new Map<string, ReservationEntry>();
  /**
   * Serialization queue for the check+reserve critical section. A simple
   * promise chain is sufficient because every reservation runs on the same
   * Node.js event loop and the work inside the critical section is purely
   * synchronous (`tryReserveAll`).
   */
  private reservationLock: Promise<void> = Promise.resolve();

  /**
   * File-backed cross-process ledger for named machine pools (optional).
   * Lazily initialized in the constructor when at least one scaler entry
   * references a pool.
   */
  private readonly machineLedger: MachineLedger | null;

  /** Per-scaler URL overrides from config, keyed by scaler name */
  private readonly scalerUrls = new Map<string, string | undefined>();

  /**
   * Tracks agents being spawned but not yet registered via WS.
   * Keyed by pre-generated agentId.
   */
  private readonly spawningAgents = new Map<string, SpawningEntry>();

  /**
   * Maps registered agentId to backendName for lifecycle events.
   */
  private readonly managedAgentIndex = new Map<string, string>();

  /**
   * Active log forwarders for scaler-managed agents (container/bare-metal).
   * Keyed by agentId. Each forwarder consumes a LogCapture stream.
   */
  private readonly logForwarders = new Map<string, AgentLogForwarder>();

  /**
   * Correlation map: agentId -> { runId, jobId }.
   * Populated by correlateAgentToJob() after job dispatch to a scaler-managed agent.
   */
  private readonly agentJobCorrelation = new Map<string, { runId: string; jobId: string }>();

  /**
   * Buffer for scaler events emitted before job correlation is established.
   * Keyed by agentId. Flushed when correlateAgentToJob() is called.
   */
  private readonly eventBuffer = new Map<string, ScalerEvent[]>();

  /**
   * External callback for relaying correlated scaler events (e.g. to execution tracker).
   */
  private readonly onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void;

  /** Coordinator drain predicate; when true, requestScale() no-ops (no fresh
   *  agents spawned for the held Pending backlog). Defaults to never-draining. */
  private readonly isDraining: () => boolean;

  /**
   * Optional callback fired (debounced) whenever scaler capacity frees — an
   * ephemeral agent released its reservation on disconnect, a spawn failed, or a
   * managed agent completed its job. Wired by the composition roots to the
   * dispatcher's capacity-freed re-drive so jobs that got an `at-capacity`
   * verdict get re-offered to the scaler the moment a slot opens, instead of
   * sitting pending until they time out. Assigned after construction because it
   * references the dispatcher, which is built after the manager.
   */
  onCapacityFreed?: () => void;

  /** Trailing-debounce timer coalescing a burst of releases into one re-drive. */
  private capacityFreedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Trailing debounce window for {@link notifyCapacityFreed}. */
  private static readonly CAPACITY_FREED_DEBOUNCE_MS = 250;

  private readonly warmPool: WarmPoolManager;

  /**
   * Optional DB-backed state store. When wired (production path), every
   * mutation to `spawningAgents` / `agentJobCorrelation` / `reservations`
   * is write-through-cached to Postgres so a coord crash mid-spawn no
   * longer orphans agents, strands reservations, or loses correlation.
   * Unit tests can omit the store and operate from in-memory Maps only.
   */
  private readonly stateStore?: ScalerStateStore;

  /** Cluster-wide default deadline (ms) for a single `backend.spawn`. */
  private readonly spawnTimeoutMs: number;
  /** Optional per-org spawn-deadline resolver (production path; DB-backed). */
  private readonly resolveSpawnTimeoutMs?: (orgId: string | undefined) => Promise<number>;

  constructor(deps: {
    config: ScalerConfig;
    backends: Array<{ name: string; backend: ScalerBackend }>;
    /** Callback for relaying scaler events with runId/jobId context. */
    onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void;
    /**
     * Optional DB-backed state store. Tests omit it; production wires it
     * up via the orchestrator-core bootstrap.
     */
    stateStore?: ScalerStateStore;
    /**
     * Optional machine-ledger options. When `machinePools` are configured,
     * the manager initializes a `MachineLedger` keyed off this directory and
     * the orchestrator's instance id; reservations sum across orchestrators
     * on the same host.
     */
    machineLedger?: {
      /** Override the on-disk ledger directory. Falls back to `KICI_MACHINE_LEDGER_DIR`. */
      dir?: string;
      /** Orchestrator instance id (used in ledger rows for ownership). */
      instanceId: string;
    };
    /** Coordinator drain predicate. When true, requestScale() declines to spawn
     *  fresh capacity for the held Pending backlog. Defaults to never-draining. */
    isDraining?: () => boolean;
    /**
     * Cluster-wide default deadline (ms) for a single `backend.spawn`. Always
     * supplied (from config.scalerSpawnTimeoutMs); the per-org resolver, when
     * present, overrides it per tenant.
     */
    spawnTimeoutMs: number;
    /**
     * Optional per-org resolver for the spawn deadline: given the job's org
     * (jobConfig.cacheOrgId, undefined for warm-pool spawns), returns the
     * effective timeout, falling back to the cluster default internally. Wired
     * in orchestrator-core (has DB); omitted by the worker + unit tests → the
     * cluster default spawnTimeoutMs is used.
     */
    resolveSpawnTimeoutMs?: (orgId: string | undefined) => Promise<number>;
  }) {
    this.stateStore = deps.stateStore;
    this.spawnTimeoutMs = deps.spawnTimeoutMs;
    this.resolveSpawnTimeoutMs = deps.resolveSpawnTimeoutMs;
    this.globalMaxAgents = deps.config.globalMaxAgents;
    this.onScalerEvent = deps.onScalerEvent;
    this.isDraining = deps.isDraining ?? (() => false);
    this.globalResourceCap = deps.config.globalResourceCap;

    // Initialize the file-backed cross-process ledger when any pools are configured.
    if (deps.config.machinePools && deps.config.machinePools.length > 0) {
      if (!deps.machineLedger?.instanceId) {
        throw new Error(
          'ScalerManager: machinePools are configured but no instanceId was passed; ' +
            'cross-process coordination requires a stable instance id.',
        );
      }
      this.machineLedger = new MachineLedger({
        explicitDir: deps.machineLedger.dir,
        instanceId: deps.machineLedger.instanceId,
      });
      for (const pool of deps.config.machinePools) {
        this.machineLedger.registerPool(pool.name, pool.cap);
      }
    } else {
      this.machineLedger = null;
    }

    // Index per-scaler orchestratorUrl overrides and roles
    for (const entry of deps.config.scalers) {
      this.scalerUrls.set(entry.name, entry.orchestratorUrl);
      this.backendRoles.set(entry.name, entry.roles);
      if (entry.resourceCap) this.resourceCaps.set(entry.name, entry.resourceCap);
      this.scalerMachinePools.set(entry.name, entry.machinePool);
      this.maxConcurrentSpawns.set(entry.name, entry.maxConcurrentSpawns);
      this.scalerDefaults.set(entry.name, this.resolveScalerDefaults(deps.config, entry));
      this.perScalerUsage.set(entry.name, { cpus: 0, memBytes: 0 });
      this.scalerMandatoryLabels.set(entry.name, entry.mandatoryLabels ?? []);
      this.scalerPlatform.set(entry.name, entry.platform);
      this.warnOnUnstructuredPlatformLabels(entry);
    }

    // Index backends by name
    for (const { name, backend } of deps.backends) {
      this.backends.set(name, backend);
    }

    // Initialize warm pool with callbacks
    this.warmPool = new WarmPoolManager({
      onSpawnRequest: async (labelSet: string[], backendName: string) => {
        const backend = this.backends.get(backendName);
        if (!backend) return;

        const agentId = this.generateAgentId(backend.type);
        this.spawningAgents.set(agentId, {
          labelSet,
          backendName,
          spawnedAt: Date.now(),
        });
        this.persistSpawningAgent(agentId, labelSet, backendName, undefined);

        try {
          const onEvent = this.createEventEmitter(agentId);
          // Warm-pool spawns hit the same backend socket as on-demand spawns, so
          // they go through the same per-backend throttle — a cold pool fill must
          // not storm the socket either.
          await this.spawnSemaphoreFor(backendName).run(() => {
            const entry = this.spawningAgents.get(agentId);
            if (entry) entry.spawnStartedAt = Date.now();
            // Warm-pool replenishment has no bound job/org, so the cluster
            // default spawn deadline applies (orgId undefined).
            return this.runSpawnWithTimeout(undefined, (signal) =>
              backend.spawn(
                labelSet,
                agentId,
                this.getOrchestratorUrl(backendName),
                onEvent,
                undefined,
                undefined,
                signal,
              ),
            );
          });
          this.spawningAgents.delete(agentId);
          this.deleteSpawningAgentFromStore(agentId);
          this.startLogForwarding(backend, agentId);
        } catch (err) {
          this.spawningAgents.delete(agentId);
          this.deleteSpawningAgentFromStore(agentId);
          logger.error(`Warm pool spawn failed for backend ${backendName}: ${err}`);
        }
      },
      onDestroyRequest: async (managedId: string, backendName: string) => {
        const backend = this.backends.get(backendName);
        if (!backend) return;

        try {
          await backend.destroy(managedId);
        } catch (err) {
          logger.error(`Warm pool destroy failed for ${managedId}: ${err}`);
        }

        this.managedAgentIndex.delete(managedId);
      },
    });

    // Configure warm pools from scaler config
    for (const entry of deps.config.scalers) {
      if (entry.warmPool?.enabled) {
        for (const ls of entry.labelSets) {
          const normalized = normalizeLabelSet(ls.labels);
          this.warmPool.configure(normalized, entry.name, {
            size: entry.warmPool.size,
            idleTimeoutSeconds: entry.warmPool.idleTimeoutSeconds,
            labels: ls.labels,
          });
        }
      }
    }
  }

  /** Per-scaler mandatoryLabels (taint-style opt-in gate). */
  private readonly scalerMandatoryLabels = new Map<string, string[]>();

  /** Declared structured platform per scaler (undefined = host-derive / linux default). */
  private readonly scalerPlatform = new Map<string, ScalerPlatform | undefined>();

  /**
   * Warn when a pool declares a plain platform-ish label (matched by the legacy
   * denylist) but omits the structured `platform` field. The denylist is a
   * migration shim; declaring `platform` is the canonical way to taint a pool.
   */
  private warnOnUnstructuredPlatformLabels(entry: {
    name: string;
    platform?: ScalerPlatform;
    labelSets: { labels: string[] }[];
  }): void {
    if (entry.platform) return;
    const plain = entry.labelSets
      .flatMap((ls) => ls.labels)
      .filter((l) => PLATFORM_TAINT_LABELS.has(l.toLowerCase()));
    if (plain.length > 0) {
      logger.warn(
        `Scaler '${entry.name}' declares platform label(s) ${plain.join(', ')} without a structured 'platform' field. ` +
          `Add 'platform: { os, arch }' to make the taint explicit; the plain-label denylist is a migration shim.`,
      );
    }
  }

  /**
   * Resolve the pool's platform for label + taint derivation. Precedence:
   *   1. A declared `platform` field always wins (even on a linux host).
   *   2. Otherwise a bare-metal pool derives its platform from the host OS/arch.
   *   3. Otherwise (container / firecracker, undeclared) returns null — those
   *      pools run linux agents and are not auto-tainted; only an explicit
   *      declared platform or a legacy denylist label taints them.
   * Returns null when a bare-metal host's OS/arch is not a supported enum value
   * (the caller falls back to the raw host-label derivation for labels).
   */
  private resolveScalerPlatform(name: string, backendType: string): ScalerPlatform | null {
    const declared = this.scalerPlatform.get(name);
    if (declared) return declared;
    if (backendType === 'bare-metal') return hostToScalerPlatform(os.platform(), os.arch());
    return null;
  }

  /**
   * Effective taint gate for a scaler: its configured mandatoryLabels plus the
   * platform-taint labels derived from the pool's resolved structured platform,
   * unioned with the legacy plain-label denylist shim. A pool declaring a
   * non-default platform (`windows`, `macos`, `arm64`, …) only accepts jobs that
   * request that platform. Container / firecracker pools resolve to linux and
   * carry no taint; calling it uniformly is safe.
   */
  private effectiveMandatoryLabels(
    name: string,
    backend: { type: string; labelSets: { labels: string[] }[] },
  ): string[] {
    const config = this.scalerMandatoryLabels.get(name) ?? [];
    const declared = backend.labelSets.flatMap((ls) => ls.labels);
    const resolved = this.resolveScalerPlatform(name, backend.type);
    const structuredTaints = resolved ? platformToTaints(resolved) : [];
    // Legacy denylist shim: keep tainting un-migrated pools that still declare a
    // plain platform label without the structured field.
    const legacyTaints = derivePlatformTaints(declared);
    return [...new Set([...config, ...structuredTaints, ...legacyTaints])];
  }

  /**
   * Build enriched scaler entries with auto-labels injected into each label set.
   * This ensures label matching accounts for auto-injected labels (kici:role:*,
   * kici:os:*, kici:arch:*, kici:agent:*, kici:scaler:*) that agents receive
   * at spawn time.
   *
   * The os/arch labels derive from the pool's resolved structured platform
   * (declared field wins, else host-derive for bare-metal, else linux), and the
   * mandatory labels combine the per-scaler config gate with the platform taint,
   * so the label matcher applies the gate alongside subset matching.
   */
  private getEnrichedScalerEntries() {
    return [...this.backends.entries()].map(([name, backend]) => {
      const resolved = this.resolveScalerPlatform(name, backend.type);
      const osArchLabels = resolved
        ? platformToOsArchLabels(resolved)
        : backend.type === 'bare-metal'
          ? // Bare-metal host whose OS/arch is not a supported enum value: fall
            // back to the raw host labels so exotic hosts still self-report.
            deriveOsArchLabels(os.platform(), os.arch())
          : // Container / firecracker always run linux agents.
            deriveOsArchLabels('linux', os.arch());
      const roleLabels = resolveRoleLabels(this.backendRoles.get(name));
      // The plain platform-taint tokens (`windows`, `macos`, `arm64`) derived
      // from the structured field are injected as matchable labels so a job that
      // requests the platform can route here without the operator also declaring
      // a plain platform label — the structured field is the single source for
      // the taint gate AND the label that satisfies it.
      const platformTokens = resolved ? platformToTaints(resolved) : [];
      const autoLabels = [
        ...osArchLabels,
        ...platformTokens,
        agentTypeLabel(backend.type),
        scalerLabel(name),
        ...roleLabels,
      ];

      return {
        name,
        labelSets: backend.labelSets.map((ls) => ({
          ...ls,
          labels: [...new Set([...ls.labels, ...autoLabels])],
        })),
        mandatoryLabels: this.effectiveMandatoryLabels(name, backend),
      };
    });
  }

  /**
   * Main entry point: called by the Dispatcher when no agent is available.
   *
   * `resources` is the per-job request/limit declaration (or `undefined` to fall
   * back to scaler defaults). Used by per-scaler / per-orchestrator / per-machine
   * resource caps; the cap math is wired up by ScalerManager itself.
   */
  /**
   * Run a single backend spawn under the resolved spawn deadline. Returns the
   * ManagedAgent on success. On deadline: aborts the signal (so the backend's
   * threaded container-runtime/HTTP calls cancel and its own catch cleans up)
   * AND rejects, so the caller's semaphore `run()` finally releases the slot
   * even if the backend's unwind stalls in a non-abortable spot. The backing
   * spawn promise gets a no-op catch attached so a late abort-rejection doesn't
   * surface as an unhandled rejection.
   */
  private async runSpawnWithTimeout(
    orgId: string | undefined,
    spawn: (signal: AbortSignal) => Promise<ManagedAgent>,
  ): Promise<ManagedAgent> {
    const timeoutMs = this.resolveSpawnTimeoutMs
      ? await this.resolveSpawnTimeoutMs(orgId)
      : this.spawnTimeoutMs;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`scaler spawn timed out after ${timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    });

    const spawnPromise = spawn(controller.signal);
    // Prevent an unhandled rejection when the deadline wins the race but the
    // backing spawn later rejects (via the abort) or resolves.
    spawnPromise.catch(() => {});

    try {
      return await Promise.race([spawnPromise, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async requestScale(
    labels: string[],
    jobId: string,
    runId: string,
    excludeLabels: string[] = [],
    resources?: ResourceRequest,
    orgId?: string,
  ): Promise<ScaleResult> {
    // Coordinator draining: do not spawn fresh capacity for the held Pending
    // backlog. In-flight jobs on existing agents finish; scale-down / idle
    // reaping is untouched.
    if (this.isDraining()) {
      return { action: 'skipped', reason: 'draining' };
    }

    // 0. Prune stale spawning entries (agents that crashed before WS registration).
    this.pruneStaleSpawningEntries();

    // 1. Find which backend handles this label set (filtering excluded).
    const scalerEntries = this.getEnrichedScalerEntries();
    const match = findBackendForLabels(labels, scalerEntries, excludeLabels);

    if (!match) {
      logger.warn('No scaler backend matches requested labels', {
        requestedLabels: labels,
        excludeLabels,
        availableBackends: scalerEntries.map((e) => ({
          name: e.name,
          labelSets: e.labelSets.map((ls) => ls.labels),
        })),
      });
      return { action: 'no-backend', labels };
    }

    const backendName = match.scalerName;
    const backend = this.backends.get(backendName)!;
    const spawnLabelSet = backend.labelSets[match.labelSetIndex].labels;

    // 2. Warm pool: a warm agent doesn't go through cap accounting because the
    // reservation was made when the warm agent was originally spawned.
    const normalizedLabels = normalizeLabelSet(spawnLabelSet);
    const warmAgentId = this.warmPool.consumeAgent(normalizedLabels);
    if (warmAgentId) {
      logger.info(
        `Consumed warm pool agent ${warmAgentId} for labels [${spawnLabelSet.join(',')}]`,
      );
      return { action: 'spawning', backendType: backend.type };
    }

    // 3. Resolve effective resources (job → label-set → scaler default → 0).
    const labelSetResources = backend.labelSets[match.labelSetIndex].resources;
    const effective = this.resolveEffective(backendName, labelSetResources, resources);

    // 4. Check + reserve under the serialization lock.
    const reserveOutcome = await this.runWithReservationLock(() => {
      // Count caps.
      if (this.getGlobalActiveCount() >= this.globalMaxAgents) {
        return 'at-capacity-count' as const;
      }
      if (backend.getActiveCount() >= backend.maxAgents) {
        return 'at-capacity-count' as const;
      }
      // Resource caps (in-memory: per-scaler + global).
      if (!this.tryReserveAll(backendName, effective.requests)) {
        return 'at-capacity-resource' as const;
      }
      return 'reserved' as const;
    });
    if (reserveOutcome !== 'reserved') {
      return { action: 'at-capacity' };
    }

    // 5. Generate agentId and track as spawning. Bind the queued jobId so the
    // orchestrator can eagerly dispatch it on register.
    const agentId = this.generateAgentId(backend.type);

    // 5a. Cross-process pool reservation (file-backed ledger). Done outside
    // the in-process lock because the ledger has its own cross-process
    // mutex; holding both at once buys nothing.
    const poolName = this.scalerMachinePools.get(backendName);
    if (poolName && this.machineLedger) {
      const ok = await this.machineLedger.tryReserve(
        poolName,
        agentId,
        effective.requests.cpus,
        effective.requests.memBytes,
      );
      if (!ok) {
        // Roll back the in-memory reservation we just took.
        this.releaseInMemory(backendName, effective.requests);
        return { action: 'at-capacity' };
      }
    }

    this.spawningAgents.set(agentId, {
      labelSet: spawnLabelSet,
      backendName,
      spawnedAt: Date.now(),
      boundJobId: jobId,
      runId,
    });
    this.reservations.set(agentId, {
      scalerName: backendName,
      requests: { ...effective.requests },
    });
    this.persistSpawningAgent(agentId, spawnLabelSet, backendName, jobId);
    this.persistReservation(agentId, backendName, effective.requests);

    // 6. Spawn asynchronously (fire-and-forget), throttled by the per-backend
    // spawn semaphore. The reservation (steps 4-5a) is already taken, so the
    // agent stays reserved while queued in the semaphore — cap accounting is
    // unchanged; the semaphore only bounds the concurrent provisioning rate.
    // On failure, release reservations.
    const orchestratorUrl = this.getOrchestratorUrl(backendName);
    const onEvent = this.createEventEmitter(agentId);
    const effectiveLimits =
      effective.limits.cpus > 0 || effective.limits.memBytes > 0
        ? {
            cpus: effective.limits.cpus > 0 ? effective.limits.cpus : undefined,
            memBytes: effective.limits.memBytes > 0 ? effective.limits.memBytes : undefined,
          }
        : undefined;
    const spawnContext = { boundJobId: jobId, runId };
    this.spawnSemaphoreFor(backendName)
      .run(() => {
        // The spawn has been admitted past the throttle: start the "never
        // registered" staleness clock now, not at enqueue time.
        const entry = this.spawningAgents.get(agentId);
        if (entry) entry.spawnStartedAt = Date.now();
        return this.runSpawnWithTimeout(orgId, (signal) =>
          backend.spawn(
            spawnLabelSet,
            agentId,
            orchestratorUrl,
            onEvent,
            effectiveLimits,
            spawnContext,
            signal,
          ),
        );
      })
      .then(
        () => {
          logger.info(`Agent ${agentId} spawned successfully via ${backendName}`);
          this.startLogForwarding(backend, agentId);
        },
        (err) => {
          this.spawningAgents.delete(agentId);
          this.deleteSpawningAgentFromStore(agentId);
          this.releaseAll(agentId);
          logger.error(`Failed to spawn agent ${agentId} via ${backendName}: ${err}`);
        },
      );

    return { action: 'spawning', backendType: backend.type };
  }

  /**
   * Run a critical section under the reservation lock. Serializes concurrent
   * `requestScale()` calls so the check+reserve sequence is atomic.
   */
  private async runWithReservationLock<T>(fn: () => T): Promise<T> {
    const previous = this.reservationLock;
    let release!: () => void;
    this.reservationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return fn();
    } finally {
      release();
    }
  }

  /**
   * Lazily resolve the per-backend spawn throttle, sized by the scaler's
   * `maxConcurrentSpawns` (falling back to the cluster default). One semaphore
   * per backend name, since each backend has its own container socket.
   */
  private spawnSemaphoreFor(backendName: string): SpawnSemaphore {
    let semaphore = this.spawnSemaphores.get(backendName);
    if (!semaphore) {
      const max = this.maxConcurrentSpawns.get(backendName) ?? DEFAULT_MAX_CONCURRENT_SPAWNS;
      semaphore = new SpawnSemaphore(max);
      this.spawnSemaphores.set(backendName, semaphore);
    }
    return semaphore;
  }

  /**
   * Resolve the effective `{ requests, limits }` for a job at this scaler.
   *
   * Layered defaults (highest priority first):
   * 1. Job's own `resources` (after request<->limit mirroring).
   * 2. Label-set's `resources`.
   * 3. Scaler's `defaults.resources` (already merged from global defaults at construction).
   * 4. Zero (`{ cpus: 0, memBytes: 0 }`).
   *
   * Returns both sides fully resolved as numeric `{ cpus, memBytes }` pairs.
   */
  private resolveEffective(
    backendName: string,
    labelSetResources: ResourceRequest | undefined,
    jobResources: ResourceRequest | undefined,
  ): ResolvedResources {
    const scalerDefault = this.scalerDefaults.get(backendName);
    const jobMirrored = mirrorRequestsLimits(jobResources);
    const labelSetMirrored = mirrorRequestsLimits(labelSetResources);
    const scalerMirrored = mirrorRequestsLimits(scalerDefault);

    const pickSpec = (side: 'requests' | 'limits'): { cpus: number; memBytes: number } => {
      const job = jobMirrored?.[side];
      const ls = labelSetMirrored?.[side];
      const sc = scalerMirrored?.[side];

      const cpusVal = job?.cpus ?? ls?.cpus ?? sc?.cpus ?? 0;
      const memVal = job?.memory ?? ls?.memory ?? sc?.memory;
      const memBytes = memVal !== undefined ? parseMemoryString(memVal) : 0;
      return { cpus: cpusVal, memBytes };
    };

    return { requests: pickSpec('requests'), limits: pickSpec('limits') };
  }

  /**
   * Attempt to reserve `requests` against the per-scaler and per-orchestrator
   * caps. Returns false (no state change) if any cap would be exceeded.
   *
   * Caller must hold the reservation lock.
   */
  private tryReserveAll(scalerName: string, requests: { cpus: number; memBytes: number }): boolean {
    const cap = this.resourceCaps.get(scalerName);
    const usage = this.perScalerUsage.get(scalerName) ?? { cpus: 0, memBytes: 0 };

    if (cap?.maxCpu !== undefined && usage.cpus + requests.cpus > cap.maxCpu) {
      logger.info('scaler.cap exceeded for scaler cpu', {
        scaler: scalerName,
        requested: requests.cpus,
        used: usage.cpus,
        max: cap.maxCpu,
      });
      incScalerSpawnRefusals();
      return false;
    }
    if (
      cap?.maxMemoryBytes !== undefined &&
      usage.memBytes + requests.memBytes > cap.maxMemoryBytes
    ) {
      logger.info('scaler.cap exceeded for scaler memory', {
        scaler: scalerName,
        requested: requests.memBytes,
        used: usage.memBytes,
        max: cap.maxMemoryBytes,
      });
      incScalerSpawnRefusals();
      return false;
    }
    if (
      this.globalResourceCap?.maxCpu !== undefined &&
      this.globalUsage.cpus + requests.cpus > this.globalResourceCap.maxCpu
    ) {
      logger.info('scaler.cap exceeded for global cpu', {
        requested: requests.cpus,
        used: this.globalUsage.cpus,
        max: this.globalResourceCap.maxCpu,
      });
      incScalerSpawnRefusals();
      return false;
    }
    if (
      this.globalResourceCap?.maxMemoryBytes !== undefined &&
      this.globalUsage.memBytes + requests.memBytes > this.globalResourceCap.maxMemoryBytes
    ) {
      logger.info('scaler.cap exceeded for global memory', {
        requested: requests.memBytes,
        used: this.globalUsage.memBytes,
        max: this.globalResourceCap.maxMemoryBytes,
      });
      incScalerSpawnRefusals();
      return false;
    }

    usage.cpus += requests.cpus;
    usage.memBytes += requests.memBytes;
    this.perScalerUsage.set(scalerName, usage);
    this.globalUsage.cpus += requests.cpus;
    this.globalUsage.memBytes += requests.memBytes;
    this.publishUsageMetrics();
    return true;
  }

  /**
   * Push the current `perScalerUsage` and `globalUsage` snapshot into the
   * Prometheus observable gauges. Called on every successful reservation /
   * release so the gauge callback always reflects the latest state without
   * doing any work itself (gauge callbacks are synchronous and MUST NOT
   * touch this map directly — they just read whatever was last published).
   *
   * Note: pool-level usage is intentionally not emitted here. The on-disk
   * machine-pool ledger requires async I/O + a file lock to read accurately,
   * and OTel observable-gauge callbacks must be synchronous. Operators
   * dashboarding pool utilization can derive a lower bound from the sum of
   * `kici_orch_scaler_cpus_used` rows whose scaler belongs to the pool.
   */
  private publishUsageMetrics(): void {
    setScalerUsageBreakdown(
      buildScalerUsageRows(
        this.perScalerUsage,
        this.globalUsage,
        (name) => this.backends.get(name)?.type,
      ),
    );
  }

  /**
   * Release the reservation tracked for an agent. Idempotent. Also releases
   * the cross-process pool reservation (best-effort) when the scaler
   * references a pool.
   */
  private releaseAll(agentId: string): void {
    const entry = this.reservations.get(agentId);
    if (!entry) return;
    this.releaseInMemory(entry.scalerName, entry.requests);
    this.reservations.delete(agentId);
    this.deleteReservationFromStore(agentId);

    const poolName = this.scalerMachinePools.get(entry.scalerName);
    if (poolName && this.machineLedger) {
      this.machineLedger.release(poolName, agentId).catch((err) => {
        logger.warn('machine-ledger release failed', {
          agentId,
          pool: poolName,
          error: String(err),
        });
      });
    }

    // Capacity just freed: signal the dispatcher to re-drive pending jobs. This
    // single site covers the spawn-failure release and every onAgentDisconnected
    // release (both route through releaseAll).
    this.notifyCapacityFreed();
  }

  /**
   * Signal that scaler capacity freed. Trailing-debounced by
   * {@link CAPACITY_FREED_DEBOUNCE_MS} so a burst of simultaneous releases (and
   * the onJobComplete → onAgentDisconnect pair for a single-use agent) coalesces
   * into one re-drive pass that runs after the last release settles. No-op when
   * no callback is wired. The timer is `unref`'d so it never keeps the process
   * alive, and cleared on shutdown.
   */
  private notifyCapacityFreed(): void {
    if (!this.onCapacityFreed) return;
    if (this.capacityFreedTimer) clearTimeout(this.capacityFreedTimer);
    this.capacityFreedTimer = setTimeout(() => {
      this.capacityFreedTimer = null;
      const cb = this.onCapacityFreed;
      if (!cb) return;
      try {
        cb();
      } catch (err) {
        logger.warn('onCapacityFreed callback threw', { error: toErrorMessage(err) });
      }
    }, ScalerManager.CAPACITY_FREED_DEBOUNCE_MS);
    this.capacityFreedTimer.unref();
  }

  /**
   * Subtract the given `requests` from the per-scaler and global in-memory
   * counters. Used both by `releaseAll()` and by the rollback path when a
   * machine-pool reservation refuses after the in-memory reservation
   * already succeeded.
   */
  private releaseInMemory(scalerName: string, requests: { cpus: number; memBytes: number }): void {
    const usage = this.perScalerUsage.get(scalerName);
    if (usage) {
      usage.cpus = Math.max(0, usage.cpus - requests.cpus);
      usage.memBytes = Math.max(0, usage.memBytes - requests.memBytes);
    }
    this.globalUsage.cpus = Math.max(0, this.globalUsage.cpus - requests.cpus);
    this.globalUsage.memBytes = Math.max(0, this.globalUsage.memBytes - requests.memBytes);
    this.publishUsageMetrics();
  }

  /**
   * Resolve the scaler-level default resources, merging the global
   * `defaults.resources` underneath any scaler-specific override.
   *
   * Currently scaler entries themselves do not carry their own `defaults` (the
   * label-set level does). The merged result is stored per-scaler so that
   * future scaler-level defaults can be added without touching the resolver.
   */
  private resolveScalerDefaults(
    config: ScalerConfig,
    _entry: ScalerEntry,
  ): ResourceRequest | undefined {
    return config.defaults?.resources;
  }

  /**
   * Called from agent-handler.ts when an agent registers via WS.
   * Correlates the registered agent to a spawned tracking entry.
   *
   * Returns:
   * - `boundJobId` (optional): the queued jobId this agent was spawned for.
   *   Used by the caller to eagerly dispatch the bound job before the
   *   agent's idle timer fires, skipping the generic queue drain race.
   * - `mandatoryLabels` (always populated for scaler-managed agents): the
   *   spawning scaler's effective `mandatoryLabels` gate — its configured
   *   labels plus the platform taint derived from the pool's declared OS/arch.
   *   Threaded into the
   *   AgentRegistry so the queue-drain path (`onAgentAvailable` →
   *   `dequeueForLabels`) and the eager-dispatch path
   *   (`dispatchBoundJob` → `dequeueById`) both reject queued jobs whose
   *   `runsOn` does not include every gate label.
   *
   * Returns `null` for static agents and warm-pool replenishment spawns
   * (no spawning entry exists).
   */
  onAgentRegistered(
    agentId: string,
    labels: string[],
  ): { boundJobId?: string; mandatoryLabels: string[] } | null {
    const spawning = this.spawningAgents.get(agentId);
    if (!spawning) {
      // Not a scaler-managed agent (could be a static agent)
      return null;
    }

    // Remove from spawning tracking
    this.spawningAgents.delete(agentId);
    this.deleteSpawningAgentFromStore(agentId);

    // Store in managed index
    this.managedAgentIndex.set(agentId, spawning.backendName);

    // Use the same effective gate the local matcher and cross-peer advertisement
    // use, so a platform-tainted pool (windows/macos/arm64) stamps that taint onto
    // the registered agent — the queue-drain and eager-dispatch paths then reject
    // an unqualified job that would otherwise land on a wrong-OS scaler agent.
    const backend = this.backends.get(spawning.backendName);
    const mandatoryLabels = backend
      ? this.effectiveMandatoryLabels(spawning.backendName, backend)
      : (this.scalerMandatoryLabels.get(spawning.backendName) ?? []);

    logger.info(`Spawned agent ${agentId} registered, backend ${spawning.backendName}`, {
      boundJobId: spawning.boundJobId,
      mandatoryLabels,
    });

    // If warm pool is configured for this label set, add as idle
    const normalizedLabels = normalizeLabelSet(labels);
    if (this.warmPool.getPoolSize(normalizedLabels) >= 0) {
      // Check if warm pool has config for this label set
      // (the pool exists even if empty -- check by trying to see if it's configured)
      // We add to warm pool only if the agent was spawned for warm pool purposes
      // For now, non-warm-pool agents go straight to regular dispatch
    }

    return spawning.boundJobId
      ? { boundJobId: spawning.boundJobId, mandatoryLabels: [...mandatoryLabels] }
      : { mandatoryLabels: [...mandatoryLabels] };
  }

  /**
   * Called from agent-handler.ts when an agent disconnects.
   */
  onAgentDisconnected(agentId: string): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) {
      // Not a scaler-managed agent (static agent)
      this.releaseAll(agentId);
      return;
    }

    const backend = this.backends.get(backendName);
    if (!backend) {
      this.managedAgentIndex.delete(agentId);
      this.releaseAll(agentId);
      return;
    }

    // All agents are single-use: always destroy on disconnect
    backend.destroy(agentId).catch((err) => {
      logger.error(`Destroy failed for agent ${agentId}: ${err}`);
    });

    this.managedAgentIndex.delete(agentId);
    this.logForwarders.delete(agentId);
    this.agentJobCorrelation.delete(agentId);
    this.eventBuffer.delete(agentId);
    this.deleteAgentJobFromStore(agentId);
    this.releaseAll(agentId);

    // Trigger warm pool replenishment if configured
    // (warm pool's consume already schedules this, but disconnect may also need it)
  }

  /**
   * Look up the scaler backend TYPE (`container`, `firecracker`,
   * `bare-metal`) for a registered agent. Returns null if the agent is
   * not scaler-managed (a static / stateful agent).
   *
   * Used by AgentMetricsAggregator to stamp the `scaler` label on each
   * kici_agent_* series. The label MUST be the backend type, not the
   * operator-chosen scaler name: the Platform catalog filter constrains
   * it to AGENT_SCALER_VALUES (the four types), so a free-form name is
   * dropped as bad_label_value. `managedAgentIndex` stores the scaler
   * name, so resolve it through `backends` to the type.
   */
  getBackendType(agentId: string): string | null {
    const scalerName = this.managedAgentIndex.get(agentId);
    if (scalerName === undefined) return null;
    return this.backends.get(scalerName)?.type ?? null;
  }

  /**
   * Called from agent-handler.ts when an agent sends config.ack.
   * For Firecracker agents, clears MMDS data (belt-and-suspenders with in-VM iptables).
   * For non-Firecracker agents, this is a no-op.
   */
  onConfigAck(agentId: string): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) {
      // Not a scaler-managed agent (static agent) -- config.ack is a no-op
      logger.debug(`config.ack from non-managed agent ${agentId}, ignoring`);
      return;
    }

    const backend = this.backends.get(backendName);
    if (!backend) return;

    if (backend.type === 'firecracker' && 'clearAgentMmds' in backend) {
      logger.info(`Clearing MMDS for Firecracker agent ${agentId} after config.ack`);
      (backend as { clearAgentMmds: (id: string) => Promise<void> })
        .clearAgentMmds(agentId)
        .catch((err) => {
          // Non-fatal: MMDS only contains orchestrator URL, and in-VM iptables blocks access
          logger.warn(`Failed to clear MMDS for agent ${agentId}: ${err}`);
        });
    } else {
      logger.debug(`config.ack from ${backend.type} agent ${agentId}, no MMDS to clear`);
    }
  }

  /**
   * Called when a scaler-managed agent completes a job.
   */
  onJobComplete(agentId: string): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) return;

    const backend = this.backends.get(backendName);
    if (!backend) return;

    // Single-job model: the agent disconnects on its own after completion, which
    // frees its reservation via releaseAll. Signal capacity-freed early to shave
    // re-dispatch latency; the trailing debounce coalesces this with the
    // subsequent disconnect release so the re-drive still runs after the slot
    // actually opens.
    this.notifyCapacityFreed();
  }

  /**
   * Correlate an agentId to a runId/jobId after the dispatcher assigns a job
   * to a scaler-managed agent. Flushes any buffered pre-dispatch events.
   */
  correlateAgentToJob(agentId: string, runId: string, jobId: string): void {
    this.agentJobCorrelation.set(agentId, { runId, jobId });
    this.persistAgentJob(agentId, runId, jobId);

    // Flush buffered events for this agent
    const buffered = this.eventBuffer.get(agentId);
    if (buffered && this.onScalerEvent) {
      for (const event of buffered) {
        this.onScalerEvent(runId, jobId, event);
      }
    }
    this.eventBuffer.delete(agentId);
  }

  /**
   * Sum of all backends' active count + spawning agents.
   */
  getGlobalActiveCount(): number {
    let total = 0;
    for (const backend of this.backends.values()) {
      total += backend.getActiveCount();
    }
    // Note: spawningAgents is NOT added here. Real backends (container, bare-metal,
    // firecracker) all add to their internal agents map synchronously at the start
    // of spawn(), so getActiveCount() already includes spawning agents. Adding
    // spawningAgents.size would double-count them. spawningAgents is used only
    // for registration correlation (onAgentRegistered), not capacity tracking.
    return total;
  }

  /**
   * Stop warm pool, shutdown all backends, clear tracking maps.
   */
  async shutdownAll(): Promise<void> {
    if (this.capacityFreedTimer) {
      clearTimeout(this.capacityFreedTimer);
      this.capacityFreedTimer = null;
    }
    this.warmPool.stop();
    if (this.machineLedger) {
      this.machineLedger.stop();
      // Best-effort: release this orchestrator's reservations from every pool
      // so peers don't have to wait for the next reaper tick.
      await this.machineLedger.releaseAllForInstance().catch((err) => {
        logger.warn('machine-ledger releaseAllForInstance failed', { error: String(err) });
      });
    }

    const shutdowns = [...this.backends.values()].map((backend) =>
      backend.shutdownAll().catch((err) => {
        logger.error(`Backend shutdown error: ${err}`);
      }),
    );
    await Promise.allSettled(shutdowns);

    this.spawningAgents.clear();
    this.managedAgentIndex.clear();
    this.logForwarders.clear();
    this.agentJobCorrelation.clear();
    this.eventBuffer.clear();
  }

  /**
   * Validate and reload configuration.
   */
  async reload(newConfig: ScalerConfig): Promise<ValidationResult> {
    // 1. Validate label-set overlaps
    const overlaps = detectLabelSetOverlaps(newConfig.scalers);
    if (overlaps.length > 0) {
      return {
        valid: false,
        errors: overlaps.map(
          (o) =>
            `Label set [${o.labels}] overlaps between scalers "${o.scaler1}" and "${o.scaler2}"`,
        ),
      };
    }

    // 2. Reload each backend
    const errors: string[] = [];
    for (const entry of newConfig.scalers) {
      const backend = this.backends.get(entry.name);
      if (backend) {
        const result = backend.reload(entry.labelSets);
        if (!result.valid) {
          errors.push(...result.errors);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 3. Update global max, per-scaler URLs, roles, and resource caps
    this.globalMaxAgents = newConfig.globalMaxAgents;
    this.globalResourceCap = newConfig.globalResourceCap;
    this.scalerUrls.clear();
    this.backendRoles.clear();
    this.resourceCaps.clear();
    this.scalerMachinePools.clear();
    this.scalerDefaults.clear();
    this.scalerMandatoryLabels.clear();
    this.scalerPlatform.clear();
    for (const entry of newConfig.scalers) {
      this.scalerUrls.set(entry.name, entry.orchestratorUrl);
      this.backendRoles.set(entry.name, entry.roles);
      if (entry.resourceCap) this.resourceCaps.set(entry.name, entry.resourceCap);
      this.scalerMachinePools.set(entry.name, entry.machinePool);
      this.scalerDefaults.set(entry.name, this.resolveScalerDefaults(newConfig, entry));
      this.scalerMandatoryLabels.set(entry.name, entry.mandatoryLabels ?? []);
      this.scalerPlatform.set(entry.name, entry.platform);
      this.warnOnUnstructuredPlatformLabels(entry);
      // Preserve existing usage counters; only initialize for new scalers.
      if (!this.perScalerUsage.has(entry.name)) {
        this.perScalerUsage.set(entry.name, { cpus: 0, memBytes: 0 });
      }
    }

    // 4. Reload warm pool configs
    const warmPoolConfigs = new Map<
      string,
      { backendName: string; size: number; idleTimeoutSeconds: number; labels: string[] }
    >();
    for (const entry of newConfig.scalers) {
      if (entry.warmPool?.enabled) {
        for (const ls of entry.labelSets) {
          const normalized = normalizeLabelSet(ls.labels);
          warmPoolConfigs.set(normalized, {
            backendName: entry.name,
            size: entry.warmPool.size,
            idleTimeoutSeconds: entry.warmPool.idleTimeoutSeconds,
            labels: ls.labels,
          });
        }
      }
    }
    this.warmPool.reload(warmPoolConfigs);

    return { valid: true };
  }

  /**
   * Return status summary for metrics and health endpoints.
   */
  /**
   * Recent scaler spawn failures grouped per backend instance, for the
   * diagnose scaler check. `nowMs` is injected by the caller.
   */
  recentSpawnFailures(windowMs: number, nowMs: number): Map<string, BackendFailureSummary> {
    return this.failureTracker.recentByBackend(windowMs, nowMs);
  }

  getStatus(): ScalerStatus {
    const backendStatuses: ScalerStatus['backends'] = [];
    const enrichedEntries = this.getEnrichedScalerEntries();

    for (const [name, backend] of this.backends) {
      const enriched = enrichedEntries.find((e) => e.name === name);
      const usage = this.perScalerUsage.get(name) ?? { cpus: 0, memBytes: 0 };
      backendStatuses.push({
        name,
        type: backend.type,
        activeCount: backend.getActiveCount(),
        maxAgents: backend.maxAgents,
        spawnsOnLocalHost: backend.spawnsOnLocalHost,
        labelSets:
          enriched?.labelSets.map((ls) => ls.labels) ?? backend.labelSets.map((ls) => ls.labels),
        usage: { cpus: usage.cpus, memBytes: usage.memBytes },
        resourceCap: this.resourceCaps.get(name),
        machinePool: this.scalerMachinePools.get(name),
        mandatoryLabels: enriched?.mandatoryLabels ?? this.scalerMandatoryLabels.get(name) ?? [],
      });
    }

    return {
      globalMaxAgents: this.globalMaxAgents,
      globalActiveCount: this.getGlobalActiveCount(),
      spawningCount: this.spawningAgents.size,
      warmPoolCount: this.warmPool.getTotalPoolSize(),
      globalUsage: { cpus: this.globalUsage.cpus, memBytes: this.globalUsage.memBytes },
      globalResourceCap: this.globalResourceCap,
      backends: backendStatuses,
    };
  }

  /**
   * Get the backend name managing a specific agent.
   * Returns null if the agent is not scaler-managed (standalone).
   */
  getBackendForAgent(agentId: string): string | null {
    return this.managedAgentIndex.get(agentId) ?? null;
  }

  /**
   * Get a backend instance by scaler name. Returns undefined for an unknown
   * name. Used by diagnostics to reach backend-specific accessors (e.g. the
   * Firecracker backend's `getBridgeConfig()`).
   */
  getBackend(name: string): ScalerBackend | undefined {
    return this.backends.get(name);
  }

  /**
   * Whether some configured backend could spawn capacity for this label set —
   * the same `findBackendForLabels` match `requestScale` makes, asked without
   * spawning anything.
   *
   * Read by the queue-expiry sweep to tell a fleet/label problem apart from a
   * capacity one: a job whose labels no agent AND no backend can serve could
   * never have run (`unroutable`), while a job whose backend matched but whose
   * spawn kept failing is a provisioning/capacity problem (`timed_out_stale`),
   * and mislabelling the latter would tell an operator to fix a `runsOn` that
   * is perfectly correct.
   *
   * Exact labels only — the scaler's own routing (`requestScale`) matches on
   * exact labels, so a regex `runsOn` matcher is not expressible here. On a
   * scaler-configured orchestrator that makes the answer conservative for a
   * pattern-only `runsOn`: a backend whose labelSets carry no mandatory labels
   * matches the empty exact set, so such a job is reported routable and settles
   * `timed_out_stale` rather than `unroutable`. That loses precision, never
   * safety — the job is still terminal and the run still fails, which is the
   * invariant that matters. Tightening it means teaching scaler routing about
   * patterns, which would change where jobs actually spawn.
   */
  hasBackendForLabels(labels: string[], excludeLabels: string[] = []): boolean {
    return findBackendForLabels(labels, this.getEnrichedScalerEntries(), excludeLabels) !== null;
  }

  /**
   * Get scaler-specific configuration metadata for a managed agent.
   * Returns undefined for non-scaler-managed (static) agents.
   * Used to enrich job.context before forwarding to Platform.
   */
  getScalerContextForAgent(agentId: string): Record<string, unknown> | undefined {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) return undefined;

    const backend = this.backends.get(backendName);
    if (!backend) return undefined;

    return backend.getScalerContext?.(agentId);
  }

  /**
   * Start the warm pool idle check interval and the machine-pool ledger reaper.
   */
  start(): void {
    this.warmPool.start();
    if (this.machineLedger) {
      this.machineLedger.start();
    }
  }

  /**
   * Provision/heal every backend's host prerequisites before spawning starts.
   * Awaits each backend's optional ensureHostReady, catching per-backend so one
   * scaler's host-prep failure degrades only that scaler (its spawns will fail
   * with clear errors + the firecracker-network diagnostic reports it) rather
   * than aborting orchestrator startup.
   */
  async ensureHostsReady(): Promise<void> {
    for (const [name, backend] of this.backends.entries()) {
      if (!backend.ensureHostReady) continue;
      try {
        await backend.ensureHostReady();
      } catch (err) {
        logger.error(
          `host self-provision failed for scaler "${name}": ${toErrorMessage(err)}; scaler will be degraded`,
        );
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Remove spawning entries whose `backend.spawn` started more than 5 minutes
   * ago but never registered via WS (e.g., process/container crashed on
   * startup). Without cleanup, these entries would leak in spawningAgents
   * forever.
   *
   * The window is measured from `spawnStartedAt` (when the throttled spawn
   * actually began), NOT from `spawnedAt` (enqueue time): a spawn still waiting
   * behind the per-backend spawn semaphore has not started and must not be
   * reaped mid-queue during a large burst. Recovered orphan entries carry
   * `spawnStartedAt` set to their persisted enqueue time, so they are subject to
   * the normal window.
   */
  private pruneStaleSpawningEntries(): void {
    const staleThreshold = Date.now() - 300_000; // 5 minutes
    for (const [id, entry] of this.spawningAgents) {
      // Skip spawns still queued in the semaphore (not yet started).
      if (entry.spawnStartedAt === undefined) continue;
      if (entry.spawnStartedAt < staleThreshold) {
        this.spawningAgents.delete(id);
        this.deleteSpawningAgentFromStore(id);
        // Release the reservation this spawn is holding. A spawn that is pruned
        // never registered an agent (otherwise it would have left the spawning
        // map on WS register) and never will, so neither the spawn-failure path
        // nor onAgentDisconnected will ever fire for it — this is the only place
        // its reservation can be freed. Without this the per-scaler / global cap
        // (and the persisted scaler_reservations row + machine-pool ledger slot)
        // leak permanently, and on a boot/leader switch recoverState rehydrates
        // the orphaned rows, inflating `used` until every future requestScale is
        // rejected at-capacity with zero agents ever spawned.
        this.releaseAll(id);
        logger.warn(
          `Pruned stale spawning entry for agent ${id} (spawn started ${Math.round((Date.now() - entry.spawnStartedAt) / 1000)}s ago)`,
        );
      }
    }
  }

  // ── DB write-through helpers ─────────────────────────────────────
  // All store calls are fire-and-forget: HA correctness lives in the
  // post-write fan-out (other coords read from the store on recovery)
  // and a transient DB error is fine to log + continue — the L1 cache
  // is still the authoritative view inside this process.

  private persistSpawningAgent(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    boundJobId: string | undefined,
  ): void {
    if (!this.stateStore) return;
    this.stateStore
      .upsertSpawningAgent({
        agentId,
        scalerName,
        labelSet,
        boundJobId: boundJobId ?? undefined,
        spawnedAt: new Date(),
      })
      .catch((err) => {
        logger.warn('scaler: failed to persist spawning-agent row (cache-only fallback)', {
          agentId,
          scalerName,
          error: toErrorMessage(err),
        });
      });
  }

  private deleteSpawningAgentFromStore(agentId: string): void {
    if (!this.stateStore) return;
    this.stateStore.deleteSpawningAgent(agentId).catch((err) => {
      logger.warn('scaler: failed to delete spawning-agent row', {
        agentId,
        error: toErrorMessage(err),
      });
    });
  }

  private persistReservation(
    agentId: string,
    scalerName: string,
    requests: { cpus: number; memBytes: number },
  ): void {
    if (!this.stateStore) return;
    this.stateStore
      .upsertReservation({
        agentId,
        scalerName,
        cpus: requests.cpus,
        memBytes: requests.memBytes,
      })
      .catch((err) => {
        logger.warn('scaler: failed to persist reservation row (cache-only fallback)', {
          agentId,
          scalerName,
          error: toErrorMessage(err),
        });
      });
  }

  private deleteReservationFromStore(agentId: string): void {
    if (!this.stateStore) return;
    this.stateStore.deleteReservation(agentId).catch((err) => {
      logger.warn('scaler: failed to delete reservation row', {
        agentId,
        error: toErrorMessage(err),
      });
    });
  }

  private persistAgentJob(agentId: string, runId: string, jobId: string): void {
    if (!this.stateStore) return;
    this.stateStore.upsertAgentJob({ agentId, runId, jobId }).catch((err) => {
      logger.warn('scaler: failed to persist agent-job correlation', {
        agentId,
        runId,
        jobId,
        error: toErrorMessage(err),
      });
    });
  }

  private deleteAgentJobFromStore(agentId: string): void {
    if (!this.stateStore) return;
    this.stateStore.deleteAgentJob(agentId).catch((err) => {
      logger.warn('scaler: failed to delete agent-job row', {
        agentId,
        error: toErrorMessage(err),
      });
    });
  }

  /**
   * Hydrate the in-memory Maps from the DB-backed state store after a
   * coord boot or Raft leader switch. Reconstructs:
   *
   *   - `spawningAgents` (with `boundJobId` preserved for eager-dispatch on register)
   *   - `agentJobCorrelation` (so scaler-lifecycle events route correctly)
   *   - `reservations` + `perScalerUsage` (so the cap-check critical
   *     section reflects the cluster-wide truth, not the local empty
   *     starting state)
   *
   * The `globalUsage` counter is recomputed from `perScalerUsage` to
   * keep the cap math consistent. `eventBuffer` is NOT restored — events
   * emitted by the previous coord before correlation are lost (see
   * wishlist for the rationale).
   *
   * No-op when no store is wired (unit-test path).
   */
  async recoverState(): Promise<ScalerStateRecovery> {
    const recovery: ScalerStateRecovery = {
      spawningAgentsRehydrated: 0,
      agentJobsRehydrated: 0,
      reservationsRehydrated: 0,
      bufferedEventsLost: 0,
    };
    if (!this.stateStore) return recovery;

    try {
      const spawning = await this.stateStore.listSpawningAgents();
      for (const entry of spawning) {
        // A recovered entry is orphaned from a dead coord: no live spawn backs
        // it, so treat it as already-started (staleness measured from its
        // persisted enqueue time) rather than a still-queued spawn we'd never
        // reap.
        this.spawningAgents.set(entry.agentId, {
          labelSet: entry.labelSet,
          backendName: entry.scalerName,
          spawnedAt: entry.spawnedAt.getTime(),
          spawnStartedAt: entry.spawnedAt.getTime(),
          ...(entry.boundJobId !== undefined && { boundJobId: entry.boundJobId }),
        });
      }
      recovery.spawningAgentsRehydrated = spawning.length;

      const correlations = await this.stateStore.listAgentJobs();
      for (const c of correlations) {
        this.agentJobCorrelation.set(c.agentId, { runId: c.runId, jobId: c.jobId });
      }
      recovery.agentJobsRehydrated = correlations.length;

      const reservations = await this.stateStore.listReservations();
      for (const r of reservations) {
        this.reservations.set(r.agentId, {
          scalerName: r.scalerName,
          requests: { cpus: r.cpus, memBytes: r.memBytes },
        });
        const usage = this.perScalerUsage.get(r.scalerName) ?? { cpus: 0, memBytes: 0 };
        usage.cpus += r.cpus;
        usage.memBytes += r.memBytes;
        this.perScalerUsage.set(r.scalerName, usage);
        this.globalUsage.cpus += r.cpus;
        this.globalUsage.memBytes += r.memBytes;
      }
      recovery.reservationsRehydrated = reservations.length;

      logger.info('scaler: state hydrated from DB after boot/leader switch', recovery);
    } catch (err) {
      logger.error('scaler: failed to recover state from DB; starting with empty maps', {
        error: toErrorMessage(err),
      });
    }

    return recovery;
  }

  private generateAgentId(backendType: string): string {
    return `scaler-${backendType}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Start log forwarding for a scaler-managed agent if its backend supports LogCapture.
   * Fire-and-forget: the forward() promise runs for the agent's lifetime.
   */
  private startLogForwarding(backend: ScalerBackend, agentId: string): void {
    const capture = backend.getLogCapture?.(agentId);
    if (!capture) return;

    const logsSource = backend.logsSource ?? backend.type;
    const forwarder = new AgentLogForwarder(agentId);
    this.logForwarders.set(agentId, forwarder);

    forwarder.forward(capture, undefined, logsSource).then(
      () => {
        logger.debug(`Log forwarding ended for agent ${agentId}`);
        this.logForwarders.delete(agentId);
      },
      (err) => {
        logger.error(`Log forwarding error for agent ${agentId}: ${err}`);
        this.logForwarders.delete(agentId);
      },
    );
  }

  private getOrchestratorUrl(backendName: string): string {
    return resolveScalerOrchestratorUrl(
      this.scalerUrls.get(backendName),
      process.env.KICI_ORCHESTRATOR_URL,
      process.env.KICI_PORT,
    );
  }

  /**
   * Create a per-agent event emitter closure to pass to backend.spawn().
   * The closure captures agentId and routes events through handleScalerEvent().
   */
  private createEventEmitter(_agentId: string): (event: ScalerEvent) => void {
    return (event: ScalerEvent) => {
      this.handleScalerEvent(event);
    };
  }

  /**
   * Handle a scaler event from a backend.
   *
   * For spawn FAILURES the bound spawning entry is the usual resolver, since
   * correlation isn't set until a job is dispatched post-registration. The
   * correlation map wins only in the rarer post-registration failure window
   * (e.g. a bare-metal child 'error' firing after the agent already
   * registered, by which point the spawning entry is gone). Warm-pool /
   * unbound spawns resolve to neither. When attributed, the event is relayed
   * immediately; otherwise it is buffered until correlateAgentToJob() flushes
   * it.
   *
   * Every `scaler.failed` also increments the fleet-wide spawn-failure counter
   * and emits a structured warn, regardless of whether it could be attributed.
   * The backend label is resolved from the spawning entry first, then the
   * managed-agent index — so a late failure after the spawning entry is gone
   * still buckets under the real backend instead of "unknown".
   */
  private handleScalerEvent(event: ScalerEvent): void {
    const correlated = this.agentJobCorrelation.get(event.agentId);
    const spawning = this.spawningAgents.get(event.agentId);
    const runId = correlated?.runId ?? spawning?.runId;
    const jobId = correlated?.jobId ?? spawning?.boundJobId;

    // Fleet-wide signal: count + warn on EVERY spawn failure, bound or not.
    if (event.eventType === ScalerEventType.enum['scaler.failed']) {
      const backendName = spawning?.backendName ?? this.managedAgentIndex.get(event.agentId);
      const backend = backendName ? (this.backends.get(backendName)?.type ?? 'unknown') : 'unknown';
      scalerSpawnFailuresTotal.add(1, {
        backend,
        bound: jobId ? ScalerSpawnFailureBound.Bound : ScalerSpawnFailureBound.Unbound,
      });
      logger.warn('Scaler spawn failed', {
        agentId: event.agentId,
        backend,
        runId: runId ?? null,
        jobId: jobId ?? null,
        detail: event.detail,
      });
      this.failureTracker.record({
        backendName: backendName ?? 'unknown',
        backendType: backend,
        bound: Boolean(jobId),
        detail: event.detail ?? '',
        timestampMs: event.timestampMs,
      });
    }

    if (runId && jobId && this.onScalerEvent) {
      this.onScalerEvent(runId, jobId, event);
    } else if (this.onScalerEvent) {
      // Not attributable yet → buffer until correlateAgentToJob() flushes it.
      let buffer = this.eventBuffer.get(event.agentId);
      if (!buffer) {
        buffer = [];
        this.eventBuffer.set(event.agentId, buffer);
      }
      buffer.push(event);
    }
  }
}
