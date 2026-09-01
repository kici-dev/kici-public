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
  ScalerBackendType,
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
import type {
  ResourceRequest,
  ResourceSpec,
  ScalerCapacitySummary,
  ScalerPlatform,
} from '@kici-dev/engine';
import {
  normalizeLabelSet,
  findBackendForLabels,
  detectLabelSetOverlaps,
} from './label-matcher.js';
import { AgentLogForwarder } from './log-forwarder.js';
import { WarmPoolManager, type WarmPoolCallbacks } from './warm-pool.js';
import { parseMemoryString, DEFAULT_MAX_CONCURRENT_SPAWNS } from './config.js';
import { MachineLedger } from './machine-ledger.js';
import {
  setScalerUsageBreakdown,
  incScalerSpawnRefusals,
  scalerCapLockFailuresTotal,
  ScalerCapLockFailureReason,
  incScalerAdoptionLookupFailure,
  incScalerScaleDownEmitted,
  incScalerExternalProvisionTimeout,
  scalerSpawnFailuresTotal,
  ScalerSpawnFailureBound,
  setWarmPoolGauges,
  incWarmPoolSpawns,
  incWarmPoolReaped,
} from '../metrics/prometheus.js';
import { ScalerEventType } from './types.js';
import { ScaleDownReason } from './scaler-events.js';
import { EventScalerBackend } from './event-backend.js';
import type { ScalerEventEmitterLike } from './event-backend.js';
import type { ClaimStore, ClaimedCredentials } from './claim-store.js';
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
  ResolvedContainerSpawn,
  EffectiveLimits,
} from './types.js';
import type {
  ScalerStateStore,
  ScalerStateRecovery,
  ReapCandidate,
  SpawningAgentSnapshot,
} from './scaler-state-store.js';
import { PG_LOCK_NOT_AVAILABLE } from './scaler-state-store.js';

const logger = createLogger({ prefix: 'scaler' });

/**
 * Prefix every scaler-minted agent id carries. Load-bearing: it is the only
 * thing distinguishing a scaler-managed agent from a static one when the spawn
 * record cannot be read at all. See `ScalerManager.generateAgentId`.
 */
const SCALER_AGENT_ID_PREFIX = 'scaler-';

/**
 * Raised when a registering agent presents a scaler-minted id that the
 * orchestrator cannot back with a spawn record — either because the lookup
 * could not be completed (`cause` set) or because no record exists at all
 * (`cause` omitted). The WS handler answers it by refusing the registration, so
 * the agent reconnects rather than registering with no `mandatoryLabels` gate.
 */
export class ScalerAdoptionLookupError extends Error {
  constructor(
    readonly agentId: string,
    readonly cause?: unknown,
  ) {
    super(
      cause === undefined
        ? `no spawn record for scaler-managed agent ${agentId}`
        : `scaler adoption lookup failed for agent ${agentId}`,
    );
    this.name = 'ScalerAdoptionLookupError';
  }
}

/**
 * Floor for the stale-spawning-entry prune window, in ms. The effective window
 * is this or the configured spawn deadline, whichever is longer — see
 * `ScalerManager.stalePruneWindowMs`.
 */
const DEFAULT_STALE_SPAWN_PRUNE_MS = 300_000;

/**
 * How often a retiring scaler is checked for having drained. A retirement also
 * sweeps on each agent disconnect, so this interval only backstops the case
 * where the fire-and-forget teardown resolves after that check ran.
 */
const RETIREMENT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Classify a cluster-cap-lock failure for the metric.
 *
 * A wait budget that expired is a healthy database under contention; anything
 * else is a database the cap check could not use at all. Both refuse the
 * spawn, so only the label tells an operator which lever to reach for.
 */
function capLockFailureReason(err: unknown): ScalerCapLockFailureReason {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === PG_LOCK_NOT_AVAILABLE
    ? ScalerCapLockFailureReason.Contended
    : ScalerCapLockFailureReason.Unreachable;
}

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
  /**
   * The limits the agent was actually started at — what the kernel enforces on
   * it, and therefore the other half of the shape a job has to match to be
   * served by a pre-spawned one. Not persisted, so it is absent on a
   * reservation `recoverState` rehydrated after a restart;
   * {@link ScalerManager.canPrespawnedAgentServe} treats that as "cannot tell"
   * on the limits dimension alone rather than refusing.
   */
  limits?: { cpus: number; memBytes: number };
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
 * Turn resolved limits into the `effectiveLimits` argument `ScalerBackend.spawn`
 * takes, or `undefined` when neither dimension resolved to anything.
 *
 * A zero means "undeclared", so it is dropped rather than passed on: a backend
 * reads a present-but-zero field as a real limit on that dimension, and only an
 * absent one falls back to its own label-set or default limits.
 *
 * Both spawn paths use this. A warm agent's shape is fixed when it starts and
 * nothing reads a job's `resources` afterwards, so a pre-spawn that resolved a
 * shape has to carry it to the backend exactly as a job-bound spawn does —
 * otherwise the manager reserves (and later matches jobs against) a shape the
 * compute was never started at. It matters most on an event backend, whose
 * `scaler.scale-up` payload builds its `resources` hint from this and from
 * nothing else, so an omitted argument leaves the customer's provisioning
 * workflow to pick its own instance size.
 */
function spawnLimitsFor(limits: { cpus: number; memBytes: number }): EffectiveLimits | undefined {
  if (limits.cpus <= 0 && limits.memBytes <= 0) return undefined;
  return {
    cpus: limits.cpus > 0 ? limits.cpus : undefined,
    memBytes: limits.memBytes > 0 ? limits.memBytes : undefined,
  };
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
     * The union of every entry in {@link labelSetMandatoryLabels}. Surfaced in
     * heartbeat-side scaler capacity summaries for a peer that predates the
     * per-label-set gate.
     *
     * @deprecated Use {@link labelSetMandatoryLabels}. On a scaler whose label
     * sets declare different platforms this union names a taint no single set
     * can satisfy, which is what made a mixed-platform scaler unroutable.
     */
    mandatoryLabels: string[];
    /**
     * Labels a job MUST declare in `runsOn` to be allowed on each label set,
     * index-aligned with `labelSets`. An empty entry means that set has no
     * gate.
     */
    labelSetMandatoryLabels: string[][];
    /**
     * True when this scaler was removed from the config and is draining: it
     * accepts no new work, and disappears once its last agent goes away.
     */
    retiring: boolean;
  }>;
}

/** How each configured scaler relates to the currently loaded backends. */
interface ReloadPlan {
  /** Configured, with no backend loaded — the factory must build one. */
  added: ScalerEntry[];
  /** Configured and already loaded — the backend is reloaded in place. */
  kept: ScalerEntry[];
  /** Configured again while still draining from an earlier removal. */
  resurrected: ScalerEntry[];
  /** Loaded but no longer configured — retired. */
  removed: string[];
  /** Configured with a different `type` than the loaded backend — rejected. */
  typeChanged: Array<{ entry: ScalerEntry; currentType: string }>;
}

/**
 * What one kept backend held before a reload replaced it. `backend.reload`
 * validates and applies in one call, so this is the only way back when a later
 * stage of the same reload rejects.
 */
interface AppliedBackendReload {
  backend: ScalerBackend;
  labelSets: ScalerBackend['labelSets'];
  maxAgents: number;
  /** The entry the backend held, for a backend that keeps one. */
  entry: ScalerEntry | undefined;
}

/** Backends that can reap leftovers from a previous incarnation of the scaler. */
interface OrphanReaping {
  cleanupOrphans(): Promise<number>;
}

/** Backends that keep a periodic host-resource sweep running while they live. */
interface PeriodicSweeping {
  startPeriodicOrphanSweep(): void;
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
   * The backend type that spawned this agent, recorded at spawn time and
   * rehydrated from the durable row on recovery.
   *
   * Carried on the entry rather than looked up from `backends` at use time: a
   * scaler removed from this coordinator's config has no backend, and reading
   * "no backend" as "not an event scaler" is what makes the stale-spawn prune
   * delete a durable row whose customer cloud instance nothing else will tear
   * down.
   */
  backendType?: string;
  /**
   * The scaler's `provisioningTargets` as configured when this spawn started.
   *
   * The teardown is addressed to these, not to live config: an operator edit
   * between the spawn and the teardown would otherwise retarget an in-flight
   * teardown at a workflow that never provisioned anything. Same value the
   * durable row carries, so the coordinator that spawned the agent and a peer
   * that adopts it address the same targets.
   */
  provisioningTargets: string[];
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

/**
 * What the coordinator holding an event agent needs to tear its provision
 * down: enough to emit `kici.scaler.scale-down` with no local backend and no
 * config entry.
 *
 * Recorded on both registration paths — the agent adopted from a peer and the
 * one this coordinator spawned itself — so the teardown addresses the targets
 * recorded at spawn either way.
 */
export interface AdoptedSpec {
  scalerName: string;
  provisioningTargets: string[];
}

/**
 * Identity for a scaler event the manager's in-memory maps cannot resolve.
 *
 * Read from the durable spawn row by the one caller that has no live state to
 * work from — a teardown of a provision this coordinator never spawned and that
 * never registered anywhere.
 */
interface ScalerEventAttribution {
  runId?: string;
  jobId?: string;
  backendName?: string;
  backendType?: string;
}

/**
 * The three knobs bounding how often a repeatedly failing external scaler is
 * asked to provision again.
 */
export interface ProvisionBackoffSettings {
  /** First deferral after one consecutive failure; doubles per further failure. */
  baseMs: number;
  /** Ceiling on the doubling. */
  maxMs: number;
  /** Consecutive failures past which a refusal names repeated failure. */
  maxConsecutiveFailures: number;
}

/**
 * Fallback for a host that wires no resolver — the worker and the unit tests.
 * Mirrors the `config.ts` cluster defaults, which are what the resolver reads
 * when the operator has set no cluster_settings value.
 */
const DEFAULT_PROVISION_BACKOFF: ProvisionBackoffSettings = {
  baseMs: 30_000,
  maxMs: 900_000,
  maxConsecutiveFailures: 5,
};

/** Per-scaler consecutive-failure state driving the backoff. */
interface ProvisionFailureState {
  /** Consecutive provisioning failures with no successful registration between. */
  consecutive: number;
  /** Epoch ms before which a further spawn request for this scaler is deferred. */
  deferUntilMs: number;
  /**
   * Agent ids already counted, so two observers of the SAME dead provision
   * count it once.
   *
   * Two independent paths see it: the local stale-spawn prune, which every
   * coordinator runs over its own spawns, and the leader-gated reaper. On the
   * leader both fire for one provision, and without this the backoff would
   * double per failure there and nowhere else.
   *
   * Cleared with the rest of the state on a successful registration, and capped
   * so a multi-day outage cannot grow it without bound.
   */
  countedAgents: Set<string>;
}

/**
 * Ceiling on {@link ProvisionFailureState.countedAgents}.
 *
 * The set exists only to dedupe two observers of the same provision, which
 * observe within minutes of each other, so anything older is dead weight. A
 * long outage would otherwise add one id per attempt for as long as it lasts.
 */
const MAX_COUNTED_FAILED_AGENTS = 64;

/** Everything the {@link ScalerManager} is constructed from. */
export interface ScalerManagerDeps {
  config: ScalerConfig;
  backends: Array<{ name: string; backend: ScalerBackend }>;
  /**
   * Read-only view of the agent registry, for the warm pool's deficit
   * calculation. Structural on purpose — the scaler must not depend on the
   * agent layer's concrete class.
   *
   * Both hosts pass one, and a host that skips it does not get an inert warm
   * pool: the readiness count falls back to 0, so a configured pool never sees
   * the agents it started and keeps filling until `warmCapacityRemaining`
   * clamps it at `maxAgents` — starving the job-bound spawns that share the
   * cap. Optional only because the unit tests drive the spawn path without a
   * registry.
   */
  agentRegistry?: {
    findAvailable(
      requiredLabels: string[],
    ): Array<{ agentId: string; activeJobs: number; registeredAt: number }>;
  };
  /**
   * Id of the orchestrator instance this manager runs on. Rows this
   * coordinator writes to the shared scaler tables are attributed to it, so
   * every peer can tell which instance owns a given spawn.
   */
  instanceId: string;
  /** Callback for relaying scaler events with runId/jobId context. */
  onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void;
  /**
   * Optional DB-backed state store. Tests omit it; production wires it
   * up via the orchestrator-core bootstrap.
   */
  stateStore?: ScalerStateStore;
  /**
   * Late-bound reserved-event emitter, resolved per call because the event
   * router is built after the manager. Omitted where there is no event plane
   * (the worker, and unit tests that never emit).
   */
  eventEmitter?: () => ScalerEventEmitterLike;
  /**
   * Redemption-only claim store. Wired wherever the shared claim table is
   * reachable, so a provisioning code minted by any coordinator can be
   * redeemed here. Omitted where there is no database.
   */
  claimStore?: ClaimStore;
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
  /**
   * Live resolver for the external-provision backoff knobs, read once per spawn
   * request so an operator retunes a running cluster. Wired in
   * orchestrator-core from `ClusterSettingsReader` + the config defaults;
   * omitted by the worker and unit tests, which then get
   * {@link DEFAULT_PROVISION_BACKOFF}.
   */
  resolveProvisionBackoff?: () => Promise<ProvisionBackoffSettings>;
  /**
   * Constructs a backend for a scaler added by a config reload. Supplied by
   * both hosts from the shared backend factory, so a reload can only build
   * what startup already exercises. When omitted (unit tests), a reload that
   * adds a scaler is rejected rather than silently ignored.
   *
   * `config` is the config being reloaded, not the boot-time one. The factory
   * reads `defaults.resources` and the whole `firecracker` network block off
   * it, so an added scaler built from a stale config would allocate IPs from
   * the old CIDR and attach TAPs to the old bridge — silently unreachable.
   */
  createBackend?: (entry: ScalerEntry, config: ScalerConfig) => Promise<ScalerBackend | null>;
}

export class ScalerManager {
  private readonly backends = new Map<string, ScalerBackend>();
  private readonly backendRoles = new Map<string, string[] | undefined>();
  /**
   * Scalers deleted from the config that still have agents running. They stay
   * in `backends` — and so stay counted by `getGlobalActiveCount` and reachable
   * for destroy / log forwarding — but are filtered out of routing, and are
   * torn down once their last agent goes away.
   */
  private readonly retiring = new Set<string>();
  /** When each retiring scaler was marked, for the drain-duration log. */
  private readonly retiredAt = new Map<string, number>();
  /** Periodic sweep that tears down drained retiring backends. */
  private retirementSweep: ReturnType<typeof setInterval> | null = null;
  /** Recent scaler spawn failures, surfaced by `kici-admin diagnose`. */
  private readonly failureTracker = new ScalerFailureTracker();
  /**
   * Consecutive external-provision failures per scaler NAME, and the deferral
   * they earned.
   *
   * Keyed by name rather than by backend type so one failing scaler never
   * defers spawns for an unrelated one — two event scalers routinely drive two
   * different providers, and an outage at one says nothing about the other.
   *
   * In-memory and leader-local, like `ScalerFailureTracker`: the state resets on
   * restart, which is the conservative direction (a fresh coordinator retries
   * once immediately rather than inheriting a deferral it never observed).
   */
  private readonly provisionFailures = new Map<string, ProvisionFailureState>();
  private readonly resolveProvisionBackoff: () => Promise<ProvisionBackoffSettings>;
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
   * Initialized when at least one scaler entry references a pool — at
   * construction, or on the reload that first declares one.
   */
  private machineLedger: MachineLedger | null;
  /** Ledger options, retained so a reload that first declares a pool can build one. */
  private readonly machineLedgerOptions: { dir?: string; instanceId: string } | undefined;
  /** True between `start()` and `shutdownAll()`; a ledger built later must be started too. */
  private started = false;
  /** Builds a backend for a scaler a reload added. Absent in unit tests. */
  private readonly createBackend?: (
    entry: ScalerEntry,
    config: ScalerConfig,
  ) => Promise<ScalerBackend | null>;

  /**
   * Read-only agent-registry view backing the warm pool's deficit pass.
   * Absent in unit tests and in any host that has no registry.
   */
  private readonly agentRegistry?: ScalerManagerDeps['agentRegistry'];

  /** Per-scaler URL overrides from config, keyed by scaler name */
  private readonly scalerUrls = new Map<string, string | undefined>();

  /**
   * Per-scaler `provisioningTargets` from config, keyed by scaler name.
   *
   * Copied onto every spawn row, because it is the only thing that lets a
   * coordinator with no config entry for the scaler address the customer's
   * teardown workflow when the agent it adopted disconnects.
   */
  private readonly scalerProvisioningTargets = new Map<string, string[] | undefined>();

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
   * Agents this instance pre-spawned to wait for work, rather than for a
   * specific queued job. The agent registry tracks readiness (`activeJobs`,
   * `registeredAt`) and has never tracked provenance — it cannot derive this,
   * and the spawning entry that carries it is deleted at registration.
   *
   * This is not a second copy of the pool's readiness. It is provenance, which
   * nothing else knows, and only the reaper reads it: it may destroy an agent
   * the pool itself created, never one that registered for a bound job whose
   * dispatch has not yet arrived.
   */
  private readonly warmAgents = new Set<string>();

  /**
   * Warm agents whose destroy is issued but has not settled yet.
   *
   * An agent leaves `warmAgents` only once its destroy resolves, so until then
   * `listIdle` keeps returning it and the next reap pass — 30 seconds later,
   * or a reload that lowers the target — selects the very same agent again. A
   * backend whose teardown outlives a tick would be handed a second destroy for
   * an agent it is already destroying, and every extra pass would count another
   * `kici_orch_scaler_warm_pool_reaped_total`. One entry per agent, cleared
   * when the destroy settles either way.
   */
  private readonly warmDestroying = new Set<string>();

  /** Agents this instance adopted from another instance's spawn record. */
  private readonly adoptedAgents = new Map<string, AdoptedSpec>();

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
   * The callback set handed to `warmPool`, kept so the manager's own view of
   * pool capacity and reapability is reachable without a live agent registry.
   */
  private readonly warmPoolCallbacks: WarmPoolCallbacks;

  /**
   * Optional DB-backed state store. When wired (production path), every
   * mutation to `spawningAgents` / `agentJobCorrelation` / `reservations`
   * is write-through-cached to Postgres so a coord crash mid-spawn no
   * longer orphans agents, strands reservations, or loses correlation.
   * Unit tests can omit the store and operate from in-memory Maps only.
   */
  private readonly stateStore?: ScalerStateStore;

  /** Id of the orchestrator instance this manager runs on. */
  private readonly instanceId: string;

  /**
   * Late-bound reserved-event emitter. Undefined where there is no event
   * plane (the worker, and unit tests that never emit).
   */
  private readonly eventEmitter?: () => ScalerEventEmitterLike;

  /**
   * Redemption-only claim store, reading the shared `scaler_pending_claims`
   * table. Undefined where there is no database.
   */
  private readonly claimStore?: ClaimStore;

  /** Cluster-wide default deadline (ms) for a single `backend.spawn`. */
  private readonly spawnTimeoutMs: number;
  /** Optional per-org spawn-deadline resolver (production path; DB-backed). */
  private readonly resolveSpawnTimeoutMs?: (orgId: string | undefined) => Promise<number>;

  constructor(deps: ScalerManagerDeps) {
    this.stateStore = deps.stateStore;
    this.instanceId = deps.instanceId;
    this.eventEmitter = deps.eventEmitter;
    this.claimStore = deps.claimStore;
    this.spawnTimeoutMs = deps.spawnTimeoutMs;
    this.resolveSpawnTimeoutMs = deps.resolveSpawnTimeoutMs;
    this.globalMaxAgents = deps.config.globalMaxAgents;
    this.onScalerEvent = deps.onScalerEvent;
    this.resolveProvisionBackoff =
      deps.resolveProvisionBackoff ?? (async () => DEFAULT_PROVISION_BACKOFF);
    this.isDraining = deps.isDraining ?? (() => false);
    this.globalResourceCap = deps.config.globalResourceCap;
    this.createBackend = deps.createBackend;
    this.agentRegistry = deps.agentRegistry;
    this.machineLedgerOptions = deps.machineLedger;

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
      this.scalerProvisioningTargets.set(entry.name, entry.provisioningTargets);
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
    this.warmPoolCallbacks = {
      onSpawnRequest: (labelSet: string[], backendName: string) =>
        this.spawnWarmAgent(labelSet, backendName),
      onDestroyRequest: async (managedId: string, backendName: string) => {
        const backend = this.backends.get(backendName);
        if (!backend) return;

        // The agent stays in `warmAgents` — and therefore in `listIdle` — until
        // this destroy settles, so a teardown slower than one 30s tick is asked
        // for again on the next pass. Dropping the repeat keeps a backend from
        // being handed a second destroy for an agent it is already destroying,
        // and keeps the reaped counter at one per agent instead of one per tick.
        if (this.warmDestroying.has(managedId)) return;
        this.warmDestroying.add(managedId);

        incWarmPoolReaped(backendName);
        try {
          await backend.destroy(managedId);
          // Same rule as the disconnect path: the durable row goes only once
          // the teardown resolved. A warm-pool spawn persists a row, and an
          // event row survives both spawn and registration, so without this
          // every idle-reaped agent would leave a permanent row behind — one
          // that `recoverState` rehydrates on each restart and the stale-spawn
          // prune deliberately spares. A rejected destroy keeps the row.
          this.deleteSpawningAgentFromStore(managedId);
        } catch (err) {
          logger.error(`Warm pool destroy failed for ${managedId}: ${err}`);
        } finally {
          this.managedAgentIndex.delete(managedId);
          this.warmAgents.delete(managedId);
          this.warmDestroying.delete(managedId);
          // The idle reaper is the one teardown that never goes through
          // `onAgentDisconnected`, so this is where a reaped warm agent's
          // reservation is freed. `releaseAll` is idempotent, so a disconnect
          // arriving afterwards is a no-op.
          //
          // In the `finally`, so a REJECTED destroy releases too. The three
          // lines above already forget the agent unconditionally, and a
          // reservation for an agent nothing tracks any more can never be
          // released by any later path — it would hold cpu and memory against
          // `resourceCap`, `globalResourceCap` and the pool ledger for the
          // lifetime of the process. That is the permanent cap leak
          // `pruneStaleSpawningEntries` describes, and it is strictly worse
          // than briefly over-reporting headroom while a teardown is retried.
          // The durable row is the half that deliberately survives a rejected
          // destroy, because the reaper retries the teardown from it.
          this.releaseAll(managedId);
        }
      },
      // Deliberately unfiltered: the deficit asks how many agents could serve
      // the next job, and an agent about to be occupied by its bound job is
      // still capacity. Filtering it here would over-fill the pool.
      countAvailable: (labels: string[]) => this.agentRegistry?.findAvailable(labels).length ?? 0,
      listIdle: (labels: string[], backendName: string) =>
        (this.agentRegistry?.findAvailable(labels) ?? [])
          .filter(
            (a) =>
              // Provenance first: the reaper may only ever destroy agents the
              // pool itself created. An agent registered for a bound job whose
              // dispatch has not arrived also reports activeJobs === 0.
              this.warmAgents.has(a.agentId) &&
              a.activeJobs === 0 &&
              this.managedAgentIndex.get(a.agentId) === backendName,
          )
          .map((a) => ({ agentId: a.agentId, registeredAt: a.registeredAt })),
      capacityRemaining: (backendName: string) => this.warmCapacityRemaining(backendName),
      onTick: () => this.publishWarmPoolGauges(),
    };
    this.warmPool = new WarmPoolManager(this.warmPoolCallbacks);

    // Configure warm pools from scaler config
    for (const entry of deps.config.scalers) {
      if (!entry.warmPool?.enabled) continue;
      for (const ls of entry.labelSets) {
        // The readiness query has to carry the pool's taints, because the gate
        // it applies demands them — see `warmPoolLabelSetFillable`. The spawn
        // request does NOT: a backend resolves its image/binary by matching the
        // requested set against its own `labelSets` and rejects anything else,
        // so it only ever hears the declared set. The type comes from the config
        // entry rather than a backend lookup, for symmetry with the reload path.
        const queryLabels = this.warmPoolQueryLabels(entry.name, entry.type, ls.labels);
        if (!this.warmPoolLabelSetFillable(entry.name, ls.labels, queryLabels)) continue;
        if (!this.warmPoolShapeDeclared(entry.name, ls.labels, ls.resources)) continue;
        const normalized = normalizeLabelSet(ls.labels);
        this.warmPool.configure(normalized, entry.name, {
          size: entry.warmPool.size,
          idleTimeoutSeconds: entry.warmPool.idleTimeoutSeconds,
          labels: queryLabels,
          spawnLabels: ls.labels,
        });
      }
    }
  }

  /**
   * Pre-spawn one warm agent for a pool's label set.
   *
   * The pool's counterpart of `requestScale`, with the job term of every
   * resolution absent: no bound job, no run, and resources resolved
   * from the label set (then the scaler defaults) alone. It takes the same
   * reservations through the same {@link reserveForSpawn} helper — a warm
   * agent occupies the same cpu and memory as a job-bound one, and on an event
   * backend it claims a cluster slot too, so a pool can no longer carry a
   * scaler past `maxAgents` fleet-wide.
   *
   * A refused reservation is reported back to the pool as a failed spawn, so
   * the in-flight slot it holds is released and the deficit is retried on the
   * next tick rather than the pool stalling below target.
   */
  private async spawnWarmAgent(labelSet: string[], backendName: string): Promise<void> {
    const backend = this.backends.get(backendName);
    if (!backend) return;

    const agentId = this.generateAgentId(backend.type);
    const normalized = normalizeLabelSet(labelSet);
    const labelSetResources = backend.labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalized,
    )?.resources;
    const effective = this.resolveEffective(backendName, labelSetResources, undefined);

    const reserve = await this.reserveForSpawn(
      agentId,
      backendName,
      backend,
      labelSet,
      effective.requests,
      effective.limits,
      undefined,
    );
    if (!reserve.reserved) {
      this.warmPool.onWarmSpawnFailed(labelSet);
      logger.info('scaler: warm pre-spawn refused, no capacity for the pool shape', {
        scaler: backendName,
        labelSet,
        requestedCpus: effective.requests.cpus,
        requestedMemBytes: effective.requests.memBytes,
      });
      return;
    }

    // Counted once the spawn is admitted, not once it is asked for: a pool
    // held at a cap re-asks on every tick, and counting the refusals would
    // make the spawn counter climb without a single agent starting.
    incWarmPoolSpawns(backendName);
    this.spawningAgents.set(agentId, {
      labelSet,
      backendName,
      backendType: backend.type,
      provisioningTargets: this.scalerProvisioningTargets.get(backendName) ?? [],
      spawnedAt: Date.now(),
    });
    // A claimed cluster slot already wrote this row inside the cap transaction.
    if (!reserve.slotClaimed) this.persistSpawningAgent(agentId, labelSet, backendName, undefined);

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
            // The same resolved limits a job-bound spawn of this label set
            // would carry. A warm agent's shape is fixed when it starts, and
            // it is the shape this pre-spawn just reserved and that
            // `canPrespawnedAgentServe` matches jobs against — so the compute
            // has to be started at it.
            spawnLimitsFor(effective.limits),
            // Unbound spawn, so no job/run identity — but the pool's taints
            // still have to reach the agent, or the readiness query that
            // drives this very pool can never count what it just spawned.
            { platformTaints: this.platformTaintsFor(backendName, backend.type) },
            signal,
          ),
        );
      });
      // The spawning entry and its durable row both survive a successful
      // spawn, exactly as on the job-bound path: `spawn()` resolves when
      // the compute starts, well before the agent registers, and the entry
      // is what `onAgentRegistered` correlates against. Deleting it here
      // made a warm agent arrive looking static — never marked
      // scaler-managed, never gated by the pool's mandatory labels, and
      // never torn down on disconnect. `pruneStaleSpawningEntries` reaps
      // the entry if the agent never shows up.
      this.startLogForwarding(backend, agentId);
    } catch (err) {
      this.spawningAgents.delete(agentId);
      this.deleteSpawningAgentFromStore(agentId);
      this.releaseAll(agentId);
      this.warmPool.onWarmSpawnFailed(labelSet);
      logger.error(`Warm pool spawn failed for backend ${backendName}: ${err}`);
    }
  }

  /**
   * Whether a warm pool for this label set can count its own agents.
   *
   * The pool measures readiness with `AgentRegistry.findAvailable(labels)`, and
   * that query applies the agent's `mandatoryLabels` gate: an agent is dropped
   * unless every label in its gate also appears in the query. A scaler-spawned
   * agent's gate is `labelSetMandatoryLabels()` for the set it was spawned for,
   * which unions the configured gate with the pool's platform taints.
   * `warmPoolQueryLabels` puts the structured taints into the query, so that
   * part of the gate is satisfied by construction, and the legacy shim derives
   * from this label set's own labels, so it is satisfied by construction too.
   *
   * That leaves one residual case: a configured `mandatoryLabels` entry absent
   * from the label set, which `scaler/config.ts` validation already rejects.
   * The check stays as the fail-safe — without it a pool in that state would
   * spawn to `maxAgents` with `ready` stuck at 0, starving the on-demand spawns
   * that share the cap. A refused pool is inert, exactly as it is before it
   * fills at all — never partially filled.
   *
   * The gate derives from `declaredLabels` and is compared against
   * `queryLabels`. Deriving it from `queryLabels` would fold a structured taint
   * back in as a legacy one; comparing it against `declaredLabels` alone would
   * refuse every structurally-tainted pool.
   */
  private warmPoolLabelSetFillable(
    scalerName: string,
    declaredLabels: string[],
    queryLabels: string[],
  ): boolean {
    const backend = this.backends.get(scalerName);
    if (!backend) return false;
    const gate = this.labelSetMandatoryLabels(scalerName, backend, declaredLabels);
    const reachable = new Set(queryLabels.map((l) => l.toLowerCase()));
    const unreachable = gate.filter((l) => !reachable.has(l.toLowerCase()));
    if (unreachable.length === 0) return true;
    logger.warn('scaler: warm pool disabled for a label set its own gate excludes', {
      scaler: scalerName,
      labelSet: declaredLabels,
      missingFromLabelSet: unreachable,
      detail:
        'a gate label is absent from the label set, so the readiness query can never see ' +
        "this pool's own agents; declare these labels on the label set to enable it",
    });
    return false;
  }

  /**
   * Whether this scaler pre-spawned (warm-filled) the agent, i.e. whether
   * {@link canPrespawnedAgentServe} can ever answer false for it. A caller that
   * picks one agent at a time uses this to decide whether the suitability check
   * is worth carrying at all.
   */
  isPrespawnedAgent(agentId: string): boolean {
    return this.warmAgents.has(agentId);
  }

  /**
   * Whether a pre-spawned (warm) agent can serve this job.
   *
   * A warm agent is generic by construction: it was started before the job
   * existed, at the pool's declared shape and running the pool's agent image.
   * Both are applied when the agent starts and cannot be changed afterwards —
   * nothing in the agent reads a job's `resources`, and an already-running
   * container cannot become a different image. So a job that needs something
   * else must get its own agent instead of silently running with the pool's.
   *
   * Returns true for any agent this scaler did not pre-spawn: a job-bound or
   * static agent is not this predicate's business. {@link isPrespawnedAgent}
   * answers that half on its own.
   *
   * Only the fields the job actually declares are compared. `resolveEffective`
   * layers a job's declaration over the label set and the scaler defaults field
   * by field, and the warm agent's own reservation is what those two layers
   * resolve to — so a field the job leaves out already matches whatever the
   * agent was started at, and comparing it would refuse a job that fits.
   *
   * A field the job DOES declare must match exactly, in both directions. A
   * bigger ready agent is not a superset: limits are what the kernel enforces
   * on the running agent, so a job asking to be capped at 2 cpus, served by an
   * agent started at 4, runs uncapped. That is the same wrong execution
   * environment as the under-provisioned case, in the other direction, so `>=`
   * is not a safe relaxation.
   *
   * Both sides of the shape are compared, not just `requests`. The two answer
   * different questions — `requests` is what the agent bills against the caps,
   * `limits` is what the kernel enforces — and a declaration may legally set
   * them apart, so a job matched on `requests` alone can still land on an agent
   * capped somewhere else entirely.
   */
  canPrespawnedAgentServe(
    agentId: string,
    job: { resources?: ResourceRequest; hasOwnContainerImage: boolean },
  ): boolean {
    if (!this.isPrespawnedAgent(agentId)) return true;

    // A warm agent runs the pool's agent image; it cannot become the job's.
    if (job.hasOwnContainerImage) return false;

    // A job that declares nothing takes the pool's shape by definition.
    const wanted = mirrorRequestsLimits(job.resources);
    if (!wanted) return true;

    // A deliberate fail-open branch: no reservation means this cannot be told,
    // and blocking dispatch on missing information strands jobs — while
    // admitting on it only reproduces the behaviour that predates this
    // predicate.
    const reservation = this.reservations.get(agentId);
    if (!reservation) return true;

    // BOTH sides, because they are two different questions and a declaration
    // may set them apart (`requests <= limits` is all the schema enforces).
    // `requests` is what the agent bills against the caps; `limits` is what the
    // kernel enforces on it — so a job matched on requests alone can still be
    // admitted onto an agent capped somewhere else entirely, which is the
    // "silently runs with the pool's" defect on the other dimension.
    if (!this.shapeSideMatches(wanted.requests, reservation.requests)) return false;
    // `limits` is in-memory only, so a reservation rehydrated after a restart
    // has none. Same fail-open reading as a missing reservation, narrowed to
    // this one dimension.
    return this.shapeSideMatches(wanted.limits, reservation.limits);
  }

  /**
   * Whether one side (`requests` or `limits`) of a job's declared shape leaves
   * the agent's resolved side unchanged.
   *
   * True when the job declares nothing on this side, and true when `resolved`
   * is absent — both mean "this cannot be told", and the predicate's rule is to
   * fail open rather than strand a job.
   */
  private shapeSideMatches(
    declared: ResourceSpec | undefined,
    resolved: { cpus: number; memBytes: number } | undefined,
  ): boolean {
    if (!declared || !resolved) return true;
    if (declared.cpus !== undefined && declared.cpus !== resolved.cpus) return false;
    if (declared.memory === undefined) return true;
    // A memory string this cannot parse is the same "cannot tell", and it must
    // stay one: this runs on the ordinary dispatch path, so throwing here would
    // fail a dispatch that a malformed declaration only ever failed at spawn
    // time.
    let memBytes: number;
    try {
      memBytes = parseMemoryString(declared.memory);
    } catch {
      return true;
    }
    return memBytes === resolved.memBytes;
  }

  /**
   * Whether a warm pool for this label set has a declared agent shape.
   *
   * A warm agent starts before any job exists, so its cpu and memory come from
   * the label set (or the scaler defaults) and from nowhere else. Both are
   * applied when the agent starts and cannot be changed afterwards, so an
   * undeclared shape means the pool reserves a guess and no job can be tested
   * for fit against it. Refusing is the fail-safe reading, and it is what makes
   * a pool predictable — on a cloud backend it is what lets an operator reason
   * about instance size and cost at all.
   *
   * Limits alone count as a declaration: `resolveEffective` mirrors limits into
   * requests, so a label set naming only `limits` still resolves to a concrete
   * shape.
   *
   * A refused pool is inert, exactly as it was before it filled at all — never
   * partially filled.
   *
   * A declaration this cannot resolve is refused the same way, and must never
   * throw: the config schema types `resources.*.memory` as a plain string, so
   * an unparseable value such as `4Gi` reaches `resolveEffective` and
   * `parseMemoryString` rejects it. This runs inside the constructor and inside
   * the commit block of {@link reload}, where an exception would abort
   * orchestrator startup or leave a half-applied config behind.
   */
  private warmPoolShapeDeclared(
    scalerName: string,
    labels: string[],
    labelSetResources: ResourceRequest | undefined,
  ): boolean {
    let requests: { cpus: number; memBytes: number };
    try {
      ({ requests } = this.resolveEffective(scalerName, labelSetResources, undefined));
    } catch (err) {
      logger.warn('scaler: warm pool disabled for a label set whose resources cannot be resolved', {
        scaler: scalerName,
        labelSet: labels,
        error: toErrorMessage(err),
        detail:
          "the label set's or the scaler defaults' declared cpu/memory could not be resolved, " +
          'so the shape the pool would reserve is unknown; fix the declaration to enable it',
      });
      return false;
    }
    if (requests.cpus > 0 || requests.memBytes > 0) return true;
    logger.warn('scaler: warm pool disabled for a label set that declares no resources', {
      scaler: scalerName,
      labelSet: labels,
      detail:
        'a warm agent starts before any job exists, so its cpu/memory shape must be declared ' +
        'on the label set or on the scaler defaults; without it the pool would reserve a ' +
        'guess and no job could be matched to it',
    });
    return false;
  }

  /**
   * Agents this backend may still start before it reaches the scaler's
   * `maxAgents` or the orchestrator's `globalMaxAgents`, whichever binds first.
   *
   * The warm pool clamps its deficit to this, so a pool that has reached a
   * count cap asks for nothing at all rather than `size` spawns on every tick.
   * Only the count caps are visible here: a pool with count headroom but no
   * cpu/memory headroom still asks, and {@link reserveForSpawn} refuses each
   * request under the reservation lock. Those refusals cost a log line and a
   * `spawn_refusals` increment per tick, never a spawned agent.
   *
   * It is a best-effort read, not a reservation: the authority is
   * {@link reserveForSpawn}, which every warm pre-spawn goes through and which
   * re-checks both count caps under the reservation lock. The two backend
   * families read differently here. A local backend (container, bare-metal,
   * Firecracker) pins its compute to this host, so `getActiveCount()` is the
   * whole population and the room it reports is exact. An **event** backend is
   * capped cluster-wide — the reserve sequence claims a spawn row under
   * `withScalerCapLock` — while `getActiveCount()` sees only the provisions
   * this coordinator tracks, so the room reported here counts slots a peer may
   * already hold. The cluster-wide cap is still enforced, by that claim rather
   * than by this clamp.
   */
  private warmCapacityRemaining(backendName: string): number {
    const backend = this.backends.get(backendName);
    if (!backend) return 0;
    const globalRoom = this.globalMaxAgents - this.getGlobalActiveCount();
    const backendRoom = backend.maxAgents - backend.getActiveCount();
    return Math.max(0, Math.min(globalRoom, backendRoom));
  }

  /**
   * Publish the warm-pool gauges from the pool's current fill state.
   *
   * Called after each pool tick and after a config reload, so an operator sees
   * a newly configured target immediately rather than at the next tick.
   */
  private publishWarmPoolGauges(): void {
    setWarmPoolGauges(
      this.warmPool.getStats().map((row) => ({
        scaler: row.backendName,
        // The pool's own key, never the widened query set: two label sets on one
        // scaler can widen to the same query (one declaring the plain platform
        // label the other only gets from the taint), and a dimension built from
        // that widened set collapses them into a single series — the later row
        // overwrites the earlier one and a whole pool's fill state disappears
        // from the gauges.
        labelSet: row.key,
        target: row.target,
        ready: row.ready,
        inFlight: row.inFlight,
      })),
    );
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
   * The plain platform-taint tokens (`windows`, `macos`, `arm64`) for a scaler,
   * derived from the same resolved platform `labelSetMandatoryLabels` gates on.
   *
   * This is the single source for the taint: it feeds the matcher's view of the
   * label sets, the taint gate, the labels the spawned agent registers with, and
   * the warm-pool readiness query. Deriving it anywhere else — in a backend, say
   * — is what let the gate and the agent's labels disagree, so a tainted pool
   * spawned agents `AgentRegistry.findAvailable` could never return.
   *
   * `backendType` is passed rather than looked up because the constructor
   * configures warm pools from config entries whose backend may not be indexed.
   */
  private platformTaintsFor(name: string, backendType: string): string[] {
    const resolved = this.resolveScalerPlatform(name, backendType);
    return resolved ? platformToTaints(resolved) : [];
  }

  /**
   * The labels a warm pool measures its readiness with: the declared label set
   * plus the pool's platform taints.
   *
   * `AgentRegistry.findAvailable` drops an agent unless its whole
   * `mandatoryLabels` gate appears in the query, and a tainted pool's gate
   * carries the taints — so a query built from the declared labels alone counts
   * none of the pool's own agents and the pool fills to `maxAgents` with `ready`
   * stuck at 0. Both construction sites (the constructor and the reload path)
   * call this so the two can never diverge.
   *
   * These labels are for the QUERY only. The pool is keyed by, and spawns with,
   * the DECLARED label set: a backend matches the requested set against its own
   * `labelSets` to resolve the image / binary / VM config and throws on a set it
   * does not have, and every in-flight release path normalizes the spawn labels
   * back to the map key.
   */
  private warmPoolQueryLabels(name: string, backendType: string, labels: string[]): string[] {
    return [...new Set([...labels, ...this.platformTaintsFor(name, backendType)])];
  }

  /**
   * Taint gate for ONE of a scaler's label sets: the configured
   * `mandatoryLabels` plus the platform taints derived from the pool's resolved
   * structured platform, unioned with the legacy plain-label denylist shim read
   * from THIS label set alone.
   *
   * This is the gate every routing and stamping decision uses. Deriving the
   * legacy shim per label set is what keeps a mixed-platform scaler routable: a
   * pool declaring `[linux, gpu]` alongside `[macos, xcode]` gates only the
   * second set on `macos`, where the union would gate both and leave the linux
   * set unreachable by any sensible job.
   *
   * `backend` carries only `type` because the label set is passed in — a caller
   * that holds one label set never has to reach for the whole backend.
   */
  private labelSetMandatoryLabels(
    name: string,
    backend: { type: string },
    labelSetLabels: string[],
  ): string[] {
    const config = this.scalerMandatoryLabels.get(name) ?? [];
    const structuredTaints = this.platformTaintsFor(name, backend.type);
    // Legacy denylist shim: keep tainting un-migrated pools that still declare a
    // plain platform label without the structured field.
    const legacyTaints = derivePlatformTaints(labelSetLabels);
    return [...new Set([...config, ...structuredTaints, ...legacyTaints])];
  }

  /**
   * The scaler-wide taint gate: {@link labelSetMandatoryLabels} unioned across
   * every label set the backend declares.
   *
   * Its only remaining consumers are the deprecated scaler-wide fields — the
   * `mandatoryLabels` entry on `ScalerStatus['backends']` and the peer
   * scaler-capacity summary — which stay populated for a peer that predates the
   * per-label-set gate. Do NOT gate routing or stamp an agent with this: on a
   * scaler whose label sets declare different platforms the union names a taint
   * no single set can satisfy.
   */
  private effectiveMandatoryLabels(
    name: string,
    backend: { type: string; labelSets: { labels: string[] }[] },
  ): string[] {
    const declared = backend.labelSets.flatMap((ls) => ls.labels);
    return this.labelSetMandatoryLabels(name, backend, declared);
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
   *
   * Retiring scalers are skipped: they were removed from the config and must
   * take no new work while their remaining agents finish.
   */
  private getEnrichedScalerEntries() {
    return [...this.backends.entries()]
      .filter(([name]) => !this.retiring.has(name))
      .map(([name, backend]) => {
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
          // Index-aligned with `labelSets` by construction: both are
          // `backend.labelSets.map(...)` over the same array, in order. The
          // gate derives from the DECLARED labels, not the auto-labelled set
          // above — feeding the injected platform tokens back through
          // `derivePlatformTaints` would re-derive the structured taint as a
          // legacy one on every pool.
          labelSetMandatoryLabels: backend.labelSets.map((ls) =>
            this.labelSetMandatoryLabels(name, backend, ls.labels),
          ),
          mandatoryLabels: this.effectiveMandatoryLabels(name, backend),
        };
      });
  }

  /**
   * Mark a scaler retiring: routing stops immediately, but job-bound agents are
   * left to finish their work. The backend is torn down by
   * `sweepRetiredBackends` once its active count reaches zero.
   */
  private retireBackend(name: string): void {
    if (this.retiring.has(name)) return;
    // Idle warm agents are destroyed by the warm-pool refresh in `reload`'s
    // commit phase: the retired scaler's label sets are absent from the new
    // config, so `WarmPoolManager.reload` drops those keys and destroys them.
    this.retiring.add(name);
    this.retiredAt.set(name, Date.now());
    logger.info('scaler retiring', {
      scaler: name,
      activeAgents: this.backends.get(name)?.getActiveCount() ?? 0,
    });
  }

  /**
   * Tear down every retiring backend that has drained. Runs on an interval and
   * after each agent teardown, so a wind-down finishes promptly without a
   * dedicated per-backend watcher.
   */
  private async sweepRetiredBackends(): Promise<void> {
    // An in-flight spawn holds a retirement open (below), and a spawn that
    // died before registering never clears itself. Pruning here — not only on
    // the `requestScale` path, which a retiring scaler no longer takes — is
    // what bounds that wait: a crashed spawn ages out and the teardown runs.
    this.pruneStaleSpawningEntries();

    for (const name of [...this.retiring]) {
      const backend = this.backends.get(name);
      if (!backend) {
        this.retiring.delete(name);
        this.retiredAt.delete(name);
        continue;
      }
      if (backend.getActiveCount() > 0) continue;
      // A spawn the manager started is invisible to the backend until
      // `backend.spawn` runs — it may still be queued behind the per-backend
      // spawn semaphore, and the container/VM it will create does not exist
      // yet. Tearing the backend down on that zero would let the spawn land a
      // live agent on a backend nobody holds any more: routing cannot see it,
      // `shutdownAll` no longer reaches it, and `onAgentDisconnected` finds no
      // backend to destroy it through, so the container outlives the scaler.
      if (this.hasSpawnInFlight(name)) continue;

      // Drop every trace of the scaler BEFORE the await. `shutdownAll` yields,
      // and two things can run inside that window: a second sweep (the interval
      // racing an agent disconnect), which would shut the same backend down
      // twice; and a `reload` re-adding this name, whose resurrect branch would
      // then hand routing a backend this sweep is about to forget — leaving a
      // configured scaler with no backend at all. Forgetting first makes the
      // transition atomic: the second sweep no longer sees the name, and a
      // reload sees no backend and builds a fresh one.
      const startedAt = this.retiredAt.get(name);
      this.forgetScaler(name);

      try {
        await backend.shutdownAll();
      } catch (err) {
        logger.warn('retired scaler shutdown failed', {
          scaler: name,
          error: toErrorMessage(err),
        });
      }
      logger.info('scaler retired', {
        scaler: name,
        drainedInMs: startedAt === undefined ? undefined : Date.now() - startedAt,
      });
    }
  }

  /**
   * True while any spawn this manager started for `name` has neither registered
   * nor failed — including one still queued behind the spawn semaphore, which
   * has not reached `backend.spawn` at all. Such a spawn counts toward the
   * scaler's drain even though the backend reports no active agent.
   */
  private hasSpawnInFlight(name: string): boolean {
    for (const entry of this.spawningAgents.values()) {
      if (entry.backendName === name) return true;
    }
    return false;
  }

  /** Drop every trace of a scaler: the backend and all its per-scaler metadata. */
  private forgetScaler(name: string): void {
    // The provenance set is not keyed by scaler, so drop its entries while
    // `managedAgentIndex` can still say which agents belonged to this one.
    for (const [agentId, scaler] of this.managedAgentIndex) {
      if (scaler === name) this.warmAgents.delete(agentId);
    }
    this.backends.delete(name);
    this.retiring.delete(name);
    this.retiredAt.delete(name);
    this.scalerUrls.delete(name);
    this.backendRoles.delete(name);
    this.scalerProvisioningTargets.delete(name);
    this.resourceCaps.delete(name);
    this.scalerMachinePools.delete(name);
    this.scalerDefaults.delete(name);
    this.scalerMandatoryLabels.delete(name);
    this.scalerPlatform.delete(name);
    this.maxConcurrentSpawns.delete(name);
    this.spawnSemaphores.delete(name);
    this.perScalerUsage.delete(name);
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
    /**
     * The job's resolved container image + registry credentials, when it
     * declared one. Threaded to the backend so it can spawn the job's own
     * image instead of the pool's fixed agent image.
     */
    containerSpawn?: ResolvedContainerSpawn,
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

    // A scaler whose provisioning is repeatedly failing is deferred rather than
    // asked again immediately. Placed after the match so the deferral is scoped
    // to the one scaler that is failing; placed before the reservation so a
    // deferred request takes no capacity it will not use.
    const deferred = await this.provisionBackoffRefusal(backendName);
    if (deferred) return deferred;

    // The warm pool is not consulted here. `requestScale` runs only once the
    // dispatcher has already failed to find an available agent, so a ready warm
    // agent was dispatched through the ordinary path and there is nothing left
    // in a pool to claim.

    // 2. Resolve effective resources (job → label-set → scaler default → 0).
    const labelSetResources = backend.labelSets[match.labelSetIndex].resources;
    const effective = this.resolveEffective(backendName, labelSetResources, resources);

    // 3. Check + reserve. The agentId is minted here rather than after the
    // check because the cluster-slot claim writes the spawn row, and that row
    // is keyed by it. Minting one for a request that ends up refused costs a
    // discarded uuid.
    const agentId = this.generateAgentId(backend.type);
    const reserve = await this.reserveForSpawn(
      agentId,
      backendName,
      backend,
      spawnLabelSet,
      effective.requests,
      effective.limits,
      jobId,
      runId,
    );
    if (!reserve.reserved) {
      return { action: 'at-capacity' };
    }

    this.spawningAgents.set(agentId, {
      labelSet: spawnLabelSet,
      backendName,
      backendType: backend.type,
      provisioningTargets: this.scalerProvisioningTargets.get(backendName) ?? [],
      spawnedAt: Date.now(),
      boundJobId: jobId,
      runId,
    });
    // A claimed cluster slot already wrote this row inside the cap
    // transaction; re-writing it here would only reset `spawned_at`, which the
    // reaper ages every provision on.
    if (!reserve.slotClaimed)
      this.persistSpawningAgent(agentId, spawnLabelSet, backendName, jobId, runId);

    // 5. Spawn asynchronously (fire-and-forget), throttled by the per-backend
    // spawn semaphore. The reservation (steps 3-4a) is already taken, so the
    // agent stays reserved while queued in the semaphore — cap accounting is
    // unchanged; the semaphore only bounds the concurrent provisioning rate.
    // On failure, release reservations.
    const orchestratorUrl = this.getOrchestratorUrl(backendName);
    const onEvent = this.createEventEmitter(agentId);
    const effectiveLimits = spawnLimitsFor(effective.limits);
    const spawnContext = {
      boundJobId: jobId,
      runId,
      platformTaints: this.platformTaintsFor(backendName, backend.type),
      ...(containerSpawn ? { container: containerSpawn } : {}),
    };
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
   * Take every reservation one spawn needs, or take none at all.
   *
   * The single reserve sequence both spawn paths share — the job-bound
   * `requestScale` and the warm pool's pre-spawn. The only difference between
   * them is `boundJobId`, which is `undefined` for a pre-spawn; a warm agent
   * costs the same host resources as a job-bound one, so it takes the same
   * reservations.
   *
   * Ordering, and why:
   * - Count caps and the in-memory resource reservation run under the
   *   in-process reservation lock, so the check and the reserve are atomic
   *   against a concurrent caller. A local backend counts its own host's
   *   agents in process, which is what its cap means: the compute is pinned to
   *   this machine. An event backend provisions cloud instances any
   *   coordinator can start, so its cap is counted — and its slot claimed —
   *   cluster-wide, inside one advisory-locked transaction. The in-process
   *   lock stays the outer guard so the two never contend.
   * - The cross-process machine-pool ledger is taken outside that lock,
   *   because the ledger has its own cross-process mutex; holding both at once
   *   buys nothing.
   *
   * Every refusal rolls back exactly what it already took, so a `false` return
   * leaves no reservation behind. On success the caller owns the release,
   * which is always `releaseAll(agentId)`.
   */
  private async reserveForSpawn(
    agentId: string,
    backendName: string,
    backend: ScalerBackend,
    spawnLabelSet: string[],
    requests: { cpus: number; memBytes: number },
    limits: { cpus: number; memBytes: number },
    boundJobId: string | undefined,
    /** The bound job's run, or `undefined` for a warm pre-spawn. */
    runId?: string,
  ): Promise<{ reserved: false } | { reserved: true; slotClaimed: boolean }> {
    const clusterCapped = backend.type === ScalerBackendType.enum.event && this.stateStore != null;
    let slotClaimed = false;
    const reserveOutcome = await this.runWithReservationLock(async () => {
      // Count caps.
      if (this.getGlobalActiveCount() >= this.globalMaxAgents) {
        return 'at-capacity-count' as const;
      }
      if (!clusterCapped && backend.getActiveCount() >= backend.maxAgents) {
        return 'at-capacity-count' as const;
      }
      // Resource caps (in-memory: per-scaler + global).
      if (!this.tryReserveAll(backendName, requests)) {
        return 'at-capacity-resource' as const;
      }
      if (clusterCapped) {
        slotClaimed = await this.claimClusterSlot(
          agentId,
          spawnLabelSet,
          backendName,
          backend.maxAgents,
          boundJobId,
          runId,
        );
        if (!slotClaimed) {
          this.releaseInMemory(backendName, requests);
          return 'at-capacity-count' as const;
        }
      }
      return 'reserved' as const;
    });
    if (reserveOutcome !== 'reserved') return { reserved: false };

    const poolName = this.scalerMachinePools.get(backendName);
    if (poolName && this.machineLedger) {
      const ok = await this.machineLedger.tryReserve(
        poolName,
        agentId,
        requests.cpus,
        requests.memBytes,
      );
      if (!ok) {
        // Roll back the in-memory reservation we just took, and the
        // cluster-wide slot with it — an unreleased spawn row would count
        // against every coordinator's cap for an agent that never spawned.
        this.releaseInMemory(backendName, requests);
        if (slotClaimed) this.deleteSpawningAgentFromStore(agentId);
        return { reserved: false };
      }
    }

    // `limits` rides along in memory only. The caps this reservation bills
    // against are all `requests`, which is what `persistReservation` stores and
    // what recovery needs; `limits` is here so the suitability predicate can
    // compare the OTHER half of the shape — the half the kernel enforces.
    this.reservations.set(agentId, {
      scalerName: backendName,
      requests: { ...requests },
      limits: { ...limits },
    });
    this.persistReservation(agentId, backendName, requests);
    return { reserved: true, slotClaimed };
  }

  /**
   * Run a critical section under the reservation lock. Serializes concurrent
   * `requestScale()` calls so the check+reserve sequence is atomic.
   */
  private async runWithReservationLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.reservationLock;
    let release!: () => void;
    this.reservationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      // `return await`, not a bare `return`: in a `try`/`finally` the finally
      // block runs at the return statement, before the returned promise
      // settles. A bare return would release the lock the moment an async
      // critical section reached its first await, and two callers would sit
      // inside it at once — which is precisely what the event-scaler cap check
      // does when it goes to the database.
      return await fn();
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
   * Returns `null` for a static agent — no spawning entry exists, and no other
   * instance's spawn record claims the agent either. A warm-pool spawn is not
   * that case: its spawning entry (and durable row) survives until it
   * registers, so it resolves with `mandatoryLabels` and no `boundJobId`, which
   * is exactly what marks the agent warm on `register.ack`.
   *
   * A local hit (this instance spawned the agent) is answered from memory. A
   * miss falls back to the shared spawn record: on an HA cluster behind one
   * endpoint the agent routinely reaches an instance that did not spawn it,
   * and adopting is the normal path, not an exception. Adoption is a
   * conditional UPDATE, so exactly one instance can win.
   */
  async onAgentRegistered(
    agentId: string,
    labels: string[],
  ): Promise<{ boundJobId?: string; mandatoryLabels: string[] } | null> {
    const spawning = this.spawningAgents.get(agentId);
    if (spawning) return this.completeLocalRegistration(agentId, labels, spawning);

    if (!this.stateStore) {
      // A store-less manager (worker mode) keeps its spawn records in memory
      // only, so a restart erases them. The memory miss above is therefore the
      // same condition the `!adopted` branch below handles, reached without a
      // store to ask — and it needs the same answer, or a worker restart hands
      // every still-running scaler agent back as static with no
      // `mandatoryLabels` gate.
      if (agentId.startsWith(SCALER_AGENT_ID_PREFIX)) {
        logger.error('scaler: no spawn record for a scaler-managed agent; refusing registration', {
          agentId,
        });
        this.reclaimUnownedScalerAgent(agentId);
        throw new ScalerAdoptionLookupError(agentId);
      }
      return null;
    }
    let adopted: SpawningAgentSnapshot | null;
    try {
      adopted = await this.stateStore.adoptSpawningAgent(agentId, this.instanceId);
    } catch (err) {
      incScalerAdoptionLookupFailure();
      // A store error says nothing about whether this agent is scaler-managed,
      // and the two wrong answers are not symmetric. Registering a scaler agent
      // as static drops its `mandatoryLabels` gate for the agent's whole life,
      // so a queued job whose `runsOn` does not include the platform taint can
      // land on it — the wrong-OS dispatch this gate exists to stop. Refusing a
      // static agent costs it a reconnect.
      //
      // The agent id discriminates the two: every scaler-spawned id is minted by
      // `generateAgentId` as `scaler-<type>-<uuid>`, and an event agent cannot
      // present a different one because its ephemeral token is minted against
      // the claim keyed by that exact id.
      if (agentId.startsWith(SCALER_AGENT_ID_PREFIX)) {
        logger.error(
          'scaler: adoption lookup failed; refusing to register a scaler-managed agent',
          {
            agentId,
            error: toErrorMessage(err),
          },
        );
        // Deliberately NOT reclaimed, unlike the two branches that read a clean
        // "no such record". A store that failed to answer is not evidence the
        // agent is unowned — its spawn record may be intact behind a transient
        // fault, and reclaiming would destroy a healthy provision over a DB
        // hiccup. The agent reconnects, and the next read decides.
        throw new ScalerAdoptionLookupError(agentId, err);
      }
      logger.error('scaler: adoption lookup failed; treating agent as static', {
        agentId,
        error: toErrorMessage(err),
      });
      return null;
    }
    if (!adopted) {
      // Same asymmetry as the lookup-error branch above, reached by a different
      // route. `completeLocalRegistration` deletes a local-backend spawn row at
      // registration, so an orchestrator restart leaves a still-running scaler
      // agent with no row to adopt. Registering it as static drops its
      // `mandatoryLabels` gate for the agent's whole life, so a queued job whose
      // `runsOn` does not include the platform taint can land on it — the
      // wrong-OS dispatch this gate exists to stop. Refusing leaves the agent
      // retrying with backoff and receiving no work, and
      // `reclaimUnownedScalerAgent` below takes its compute back: a container
      // orphan is already gone, because `ContainerScalerBackend.cleanupOrphans`
      // removes every `kici-managed` container at orchestrator startup, and the
      // reclaim kills a Firecracker VM whose jailer chroot is on this host and
      // removes a bare-metal agent's container by its labels. A bare-metal
      // agent running as a plain process is the one that stays: its PID lives
      // in the in-memory entry alone, so a restart leaves nothing durable to
      // key a reclaim off, and it holds its host process until an operator
      // stops it. A refused agent never arms its own idle-shutdown timer
      // either — the agent arms that only once a registration succeeds.
      //
      // The id is the same discriminator the error branch uses: every
      // scaler-spawned id is minted by `generateAgentId` as
      // `scaler-<type>-<uuid>`, and an agent cannot present a different one
      // because its ephemeral token is minted against the claim keyed by that
      // exact id.
      if (agentId.startsWith(SCALER_AGENT_ID_PREFIX)) {
        logger.error('scaler: no spawn record for a scaler-managed agent; refusing registration', {
          agentId,
        });
        this.reclaimUnownedScalerAgent(agentId);
        throw new ScalerAdoptionLookupError(agentId);
      }
      return null;
    }

    this.managedAgentIndex.set(agentId, adopted.scalerName);
    // An adopted agent IS a successful provision — the coordinator that spawned
    // it is not the one it reached. Counting only local registrations
    // would leave a perfectly healthy scaler deferred on an HA cluster.
    this.clearProvisionFailures(adopted.scalerName);
    // Same provenance capture as the local path: a spawn record with no bound
    // job is a warm fill, and only such an agent may be reaped.
    if (adopted.boundJobId == null) {
      this.warmAgents.add(agentId);
    }
    this.adoptedAgents.set(agentId, {
      scalerName: adopted.scalerName,
      provisioningTargets: adopted.provisioningTargets ?? [],
    });

    // Seed the local backend's own agent map when the scaler IS configured here.
    // Without this `EventScalerBackend.destroy()` opens with
    // `if (!this.agents.has(managedId)) return;` and the teardown silently
    // no-ops — the VM leaks even though every other part of adoption worked.
    const backend = this.backends.get(adopted.scalerName);
    if (backend instanceof EventScalerBackend) {
      backend.adopt(agentId, adopted.labelSet);
    }

    logger.info(`Adopted spawned agent ${agentId} from instance ${adopted.ownerInstanceId}`, {
      scalerName: adopted.scalerName,
      boundJobId: adopted.boundJobId,
    });

    // The taint comes from the persisted spawn record, not from local config:
    // the coordinator the agent reached may have no entry for this scaler at
    // all, and an un-stamped gate lets a wrong-OS queued job land on it.
    const mandatoryLabels = adopted.mandatoryLabels ?? [];
    return adopted.boundJobId
      ? { boundJobId: adopted.boundJobId, mandatoryLabels: [...mandatoryLabels] }
      : { mandatoryLabels: [...mandatoryLabels] };
  }

  /**
   * Reclaim the host-local compute of a scaler-spawned agent this coordinator
   * refused for want of a spawn record.
   *
   * Refusing closes the WS before registration completes, so `onAgentDisconnected`
   * never runs for that agent, and `managedAgentIndex` never held it in the first
   * place — the two writes that populate it (`completeLocalRegistration` and the
   * adoption branch) both come after this point. So even the disconnect hook is a
   * no-op here: it reads that index, finds nothing, and takes the static-agent
   * exit. The agent keeps its VM or host process, reconnects, is refused again,
   * and loops until an operator stops it by hand.
   *
   * **This force-destroys a live instance, so read what makes it safe.**
   *
   * - **Local backends only.** An event agent's compute is a customer cloud
   *   instance, reachable from any coordinator, and its missing adoption is
   *   ambiguous: `adoptSpawningAgent` resolves `null` both when no row exists AND
   *   when a peer coordinator already holds the row, so an event agent that is
   *   alive and legitimately owned elsewhere reaches this exact branch. Tearing
   *   it down there would destroy a peer's healthy provision. A local backend's
   *   compute cannot be reached that way: it lives on the host that spawned it.
   * - **Host-local evidence decides, not this verdict.** The verdict alone is NOT
   *   evidence the agent is this host's: `adoptSpawningAgent` adopts `event` rows
   *   only, so a `container` / `bare-metal` / `firecracker` agent that reconnects
   *   to a peer behind a shared endpoint is refused here even though its spawn
   *   row is intact and its compute is alive on the peer's host. What keeps that
   *   harmless is that each backend reclaims only what its own tracking or its
   *   own on-host artifacts name — never a shared database row, which on an HA
   *   pair names an identically-configured scaler on both hosts. A wrongly-routed
   *   agent id finds nothing here and nothing is touched.
   * - **Never on a transient failure.** The caller must have positive evidence
   *   the agent is unowned. A store read that merely *failed* is not evidence —
   *   the record may exist and be perfectly healthy.
   *
   * Fire-and-forget, matching `onAgentDisconnected`'s own teardown: the caller
   * refuses the registration immediately rather than holding the agent's socket
   * open for a VM shutdown.
   */
  private reclaimUnownedScalerAgent(agentId: string): void {
    for (const [backendName, backend] of this.backends) {
      if (backend.type === ScalerBackendType.enum.event) continue;
      void (async () => {
        // In-memory first: when this process still tracks the agent, `destroy`
        // holds its live TAP and IP and is the complete teardown.
        await backend.destroy(agentId);
        // Then the restart-surviving half, for a backend that keeps durable
        // on-host artifacts. `destroy` above went through its own in-memory
        // miss, so this cannot double-reclaim.
        const reaped = (await backend.reapUnowned?.(agentId)) ?? false;
        if (reaped) {
          logger.warn('scaler: reclaimed an unowned agent left by a refused registration', {
            agentId,
            backendName,
          });
        }
      })().catch((err) => {
        logger.error('scaler: reclaim failed for a refused agent', {
          agentId,
          backendName,
          error: toErrorMessage(err),
        });
      });
    }
  }

  /**
   * Finish registration for an agent this instance spawned itself, from the
   * in-memory spawning entry.
   */
  private completeLocalRegistration(
    agentId: string,
    labels: string[],
    spawning: SpawningEntry,
  ): { boundJobId?: string; mandatoryLabels: string[] } {
    // A warm spawn binds no job. The spawning entry is the only carrier of that
    // fact and is deleted immediately below, so capture it now.
    if (spawning.boundJobId == null) {
      this.warmAgents.add(agentId);
    }

    // The in-memory entry always goes; what happens to the durable row depends
    // on the backend.
    this.spawningAgents.delete(agentId);

    const backend = this.backends.get(spawning.backendName);
    if (backend?.type === ScalerBackendType.enum.event) {
      // Seed the backend's own agent map, the same way the cross-instance
      // adoption path does. `spawn()` already seeded it in the common case, and
      // `adopt()` is a no-op then — but a spawning entry rehydrated by
      // `recoverState` after a restart has no backend entry at all, so without
      // this the disconnect's `destroy()` opens with
      // `if (!this.agents.has(id)) return;`, silently no-ops, and the row is
      // deleted by the `.then()` with no `scale-down` ever emitted.
      if (backend instanceof EventScalerBackend) backend.adopt(agentId, spawning.labelSet);
      // An event agent's row is the live ownership record, not spawn-time
      // scratch. Its compute is a customer cloud instance that only a
      // `scale-down` tears down, and if this coordinator dies mid-job the
      // agent's WS dies with it — the row is then the only thing left pointing
      // at the provision. Stamp it adopted by this instance, so registering
      // locally produces exactly the durable state the cross-instance path
      // produces, so the reaper reads one shape whichever coordinator the agent
      // reached. Local-backend rows keep today's delete: their compute is
      // pinned to a host this process manages, so the process dying IS the
      // teardown.
      this.markSpawningAgentAdopted(agentId);
      // Same spec the cross-instance path records, so the teardown addresses
      // the targets this provision was spawned with whichever coordinator the
      // agent reached — including this one. Without it the local path has no
      // recorded targets and falls back to live config, so an operator edit
      // between spawn and teardown retargets the scale-down.
      this.adoptedAgents.set(agentId, {
        scalerName: spawning.backendName,
        provisioningTargets: spawning.provisioningTargets,
      });
    } else {
      this.deleteSpawningAgentFromStore(agentId);
    }

    // Store in managed index
    this.managedAgentIndex.set(agentId, spawning.backendName);
    // The provision this coordinator asked for produced a live agent, so the
    // scaler is healthy again whatever it did before.
    this.clearProvisionFailures(spawning.backendName);

    // Use the same gate the local matcher and cross-peer advertisement apply to
    // THIS label set, so a platform-tainted pool (windows/macos/arm64) stamps
    // that taint onto the registered agent — the queue-drain and eager-dispatch
    // paths then reject an unqualified job that would otherwise land on a
    // wrong-OS scaler agent. The gate is derived from `spawning.labelSet`, the
    // set this agent was actually spawned for: a scaler-wide union would stamp a
    // sibling set's platform taint onto an agent that cannot satisfy it.
    const mandatoryLabels = backend
      ? this.labelSetMandatoryLabels(spawning.backendName, backend, spawning.labelSet)
      : (this.scalerMandatoryLabels.get(spawning.backendName) ?? []);

    logger.info(`Spawned agent ${agentId} registered, backend ${spawning.backendName}`, {
      boundJobId: spawning.boundJobId,
      mandatoryLabels,
    });

    // A spawn with no bound job is a warm fill. Releasing its in-flight slot
    // lets the next deficit pass count it as ready rather than still pending.
    // The registry is what holds it from here — there is no pool to add it to.
    if (!spawning.boundJobId) {
      this.warmPool.onWarmAgentRegistered(spawning.labelSet);
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
      // This instance adopted an agent for a scaler it does not configure, so
      // there is no backend to route the teardown through. Emit it straight
      // from the persisted spawn spec — read before the map entry goes, or the
      // customer's cloud instance is never torn down.
      //
      // The reason matches what the backend path emits for the same trigger
      // (`EventScalerBackend.destroy` defaults to `shutdown` when the caller
      // passes no context), so which coordinator the agent happened to reach is
      // invisible to the customer's teardown workflow.
      const adopted = this.adoptedAgents.get(agentId);
      if (adopted) {
        void this.emitScaleDownForSpec(adopted, agentId, ScaleDownReason.enum.shutdown);
      }
      this.managedAgentIndex.delete(agentId);
      this.warmAgents.delete(agentId);
      this.adoptedAgents.delete(agentId);
      this.releaseAll(agentId);
      return;
    }

    // All agents are single-use: always destroy on disconnect. The durable row
    // goes only once the teardown actually resolved: an event row outlives
    // registration (it is the sole pointer to a running cloud instance), so
    // dropping it before the scale-down lands would leave a failed teardown
    // with nothing for the reaper to retry from.
    // The teardown is addressed to the targets the spawn recorded, not to this
    // coordinator's live config: the record is what the provision was spawned
    // with, while live config may name a different — or since-edited —
    // `provisioningTargets` for the same scaler. Both registration paths record
    // it, so the addressing does not depend on which coordinator the agent
    // reached.
    const heldSpec = this.adoptedAgents.get(agentId);
    const destroyContext =
      heldSpec && heldSpec.provisioningTargets.length > 0
        ? { targets: heldSpec.provisioningTargets }
        : undefined;
    backend
      .destroy(agentId, destroyContext)
      .then(() => {
        this.deleteSpawningAgentFromStore(agentId);
      })
      .catch((err) => {
        logger.error(`Destroy failed for agent ${agentId}: ${err}`);
      });

    this.managedAgentIndex.delete(agentId);
    this.warmAgents.delete(agentId);
    this.adoptedAgents.delete(agentId);
    this.logForwarders.delete(agentId);
    this.agentJobCorrelation.delete(agentId);
    this.eventBuffer.delete(agentId);
    this.deleteAgentJobFromStore(agentId);
    this.releaseAll(agentId);

    // A retiring scaler may have just lost its last agent. `backend.destroy`
    // above is fire-and-forget, so `getActiveCount()` may not have dropped yet;
    // the periodic sweep armed in `start()` is the backstop that catches it.
    void this.sweepRetiredBackends();
  }

  /**
   * Tear down a stranded provision the `EventProvisionReaper` found.
   *
   * Public because the reaper is leader-gated and lives outside the manager,
   * while the emit and the row delete must stay in one place. The reason comes
   * from the reaper's verdict — a provision whose agent never registered is a
   * `spawn-timeout`, one whose agent went away is a `heartbeat-timeout` — so
   * unlike the disconnect path this does not default to `shutdown`.
   *
   * `kici_orch_scaler_external_provision_timeout_total` counts the spawn-timeout
   * arm. Nothing else increments it in production: `runSpawnWithTimeout` bounds
   * only the `spawn()` call, and an event backend's `spawn()` returns the moment
   * the scale-up event is emitted.
   *
   * The spawn-timeout arm is also where an external provisioning failure enters
   * the ordinary failure machinery. The local backends report a dead spawn
   * through the `scaler.failed` event their `spawn()` emits; an event scaler's
   * `spawn()` succeeds by definition (it only emits a scale-up), so the failure
   * is not observable until the provision it asked for never registers — which
   * is exactly this verdict. Synthesizing the event here gives the fleet
   * counter, the operator's `diagnose scaler` view, and `last_provisioning_error`
   * the same input every other backend already supplies, so a job whose external
   * provisioning failed settles with the provisioning cause instead of a
   * label-mismatch complaint that sends its operator to fix a correct `runsOn`.
   */
  async emitOrphanScaleDown(candidate: ReapCandidate, reason: ScaleDownReason): Promise<void> {
    const emitted = await this.emitScaleDownForSpec(
      { scalerName: candidate.scalerName, provisioningTargets: candidate.provisioningTargets },
      candidate.agentId,
      reason,
    );
    // Only a teardown that actually went out counts. A row that reaches no
    // emitter, or names nowhere to deliver to, keeps its record and is retried
    // — so counting the attempt would let one permanently undeliverable row
    // inflate the metric on every retry, forever. The same test gates the
    // durable verdict below: an undelivered teardown has reached no verdict.
    if (!emitted) return;
    // The durable verdict, for BOTH reasons — a `heartbeat-timeout` condemns a
    // provision that was adopted, and the record has to say so. Fire-and-forget
    // like every other store write on this path: a failure here degrades to the
    // behaviour of having no record at all (the prune reports), never to a
    // wrong suppression.
    void this.stateStore
      ?.recordProvisionCondemned(candidate.agentId, candidate.scalerName, reason)
      .catch((err) => {
        logger.warn('scaler: failed to record the provision-condemned verdict', {
          agentId: candidate.agentId,
          scaler: candidate.scalerName,
          reason,
          error: toErrorMessage(err),
        });
      });
    if (reason === ScaleDownReason.enum['spawn-timeout']) {
      incScalerExternalProvisionTimeout(candidate.scalerName);
      // The identity comes off the candidate, not off the in-memory maps: the
      // reaper is leader-gated, so the condemning coordinator often never
      // spawned this agent, and the agent never registered anywhere.
      this.reportProvisionFailure({
        scalerName: candidate.scalerName,
        agentId: candidate.agentId,
        ...(candidate.runId !== undefined && { runId: candidate.runId }),
        ...(candidate.boundJobId !== undefined && { jobId: candidate.boundJobId }),
      });
      // An unattributed failure is buffered for a correlation that establishes
      // itself only after the agent registers — which is precisely what this
      // provision never did, and never will now that its row is gone. Nothing
      // else ever clears the entry (`correlateAgentToJob` and
      // `onAgentDisconnected` are the only other erasers, and neither can fire
      // for an agent that never connected), so leaving it grows the buffer by
      // one dead entry per warm provision the reaper condemns, for the life of
      // the process.
      this.eventBuffer.delete(candidate.agentId);
    }
  }

  /**
   * Refuse a spawn request while the scaler is inside its backoff window.
   *
   * Returns the refusal to hand back, or null to proceed. The message names how
   * many consecutive failures produced the deferral and when it lifts. It
   * reaches the operator through this method's own log line: the dispatcher
   * branches on `action` alone and discards `reason`, so a job deferred here
   * carries no record of the deferral on its queue row. The job whose provision
   * actually failed is the one that gets `last_provisioning_error`, written by
   * the `scaler.failed` this backoff's own trigger emits.
   *
   * The knobs are read here per request rather than per process, so an operator
   * lowering the failure limit mid-outage sees the repeated-failure wording on
   * the next refusal. The window itself was armed by `recordProvisionFailure`
   * from the base and ceiling live at that moment, so a retuned window applies
   * from the next recorded failure.
   */
  private async provisionBackoffRefusal(backendName: string): Promise<ScaleResult | null> {
    const state = this.provisionFailures.get(backendName);
    if (!state || state.consecutive === 0) return null;
    const now = Date.now();
    if (now >= state.deferUntilMs) return null;

    const settings = await this.resolveProvisionBackoff();
    const waitMs = state.deferUntilMs - now;
    const repeated = state.consecutive >= settings.maxConsecutiveFailures;
    // Two distinct causes, because they send an operator to different places. A
    // handful of failures is plausibly one bad spawn; passing the configured
    // limit means provisioning for this scaler is broken, not unlucky.
    const reason = repeated
      ? `scaler \`${backendName}\` has failed to provision ${state.consecutive} times in a row; ` +
        `deferring for ${Math.ceil(waitMs / 1000)}s. Provisioning for this scaler is failing ` +
        `consistently — check the provisioning workflow and the provider it drives.`
      : `scaler \`${backendName}\` failed to provision; deferring for ${Math.ceil(waitMs / 1000)}s ` +
        `before asking again.`;
    logger.info('scaler: deferring a spawn request inside the provision backoff window', {
      scaler: backendName,
      consecutiveFailures: state.consecutive,
      waitMs,
    });
    return { action: 'skipped', reason };
  }

  /**
   * Record a consecutive provisioning failure for a scaler and arm its next
   * deferral.
   *
   * The delay doubles per consecutive failure and is capped, so a provider
   * outage settles into a steady retry cadence rather than either hammering the
   * provider or growing without bound. `2 ** (n - 1)` is bounded by the cap
   * before it is used, so a long outage cannot overflow the shift.
   */
  private async recordProvisionFailure(backendName: string): Promise<void> {
    // The settings read comes first so the get/set below is one uninterrupted
    // microtask: reading the count before awaiting would let two concurrent
    // reports read the same value and lose one increment.
    const settings = await this.resolveProvisionBackoff();
    const prior = this.provisionFailures.get(backendName);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const uncapped = settings.baseMs * 2 ** (consecutive - 1);
    // `uncapped` is Infinity once the exponent runs away; Math.min still yields
    // the cap, so the window stays finite for any failure count.
    const delayMs = Math.min(uncapped, settings.maxMs);
    this.provisionFailures.set(backendName, {
      consecutive,
      deferUntilMs: Date.now() + delayMs,
      countedAgents: prior?.countedAgents ?? new Set<string>(),
    });
    if (consecutive >= settings.maxConsecutiveFailures) {
      logger.warn('scaler: external provisioning is failing consistently', {
        scaler: backendName,
        consecutiveFailures: consecutive,
        maxConsecutiveFailures: settings.maxConsecutiveFailures,
        nextAttemptInMs: delayMs,
      });
    }
  }

  /**
   * Claim a dead provision as counted, or report that someone already did.
   *
   * The same provision is seen twice on the leader — once by its own
   * stale-spawn prune, once by the leader-gated reaper — and every consequence
   * of a failure is counted per provision, not per observer. The claim is
   * synchronous and happens before any await, so two observers arriving in the
   * same tick cannot both pass it.
   */
  private claimFailedProvision(backendName: string, agentId: string): boolean {
    const prior = this.provisionFailures.get(backendName);
    if (!prior) {
      // Seeded at zero: the count is incremented by `recordProvisionFailure`,
      // and a zero count is what `provisionBackoffRefusal` reads as "nothing to
      // defer" until it lands.
      this.provisionFailures.set(backendName, {
        consecutive: 0,
        deferUntilMs: 0,
        countedAgents: new Set([agentId]),
      });
      return true;
    }
    if (prior.countedAgents.has(agentId)) return false;
    prior.countedAgents.add(agentId);
    if (prior.countedAgents.size > MAX_COUNTED_FAILED_AGENTS) {
      // Insertion-ordered, so this drops the oldest — the one whose second
      // observer, if it were ever coming, arrived long ago.
      prior.countedAgents.delete(prior.countedAgents.values().next().value!);
    }
    return true;
  }

  /**
   * Report one dead external provision, wherever this coordinator noticed it.
   *
   * Everything a failed provision owes an operator happens here: the fleet
   * spawn-failure counter, the structured warn, the `ScalerFailureTracker`
   * record `kici-admin diagnose scaler` reads, the `last_provisioning_error`
   * that tells the waiting job why it never ran, and the backoff.
   *
   * It is deliberately reachable from BOTH observers rather than from the
   * reaper alone. `ScalerFailureTracker` and `provisionFailures` are
   * per-process, and the reaper is leader-gated — so a reaper-only report left
   * every non-leader with an empty `diagnose scaler` for a scaler failing
   * fleet-wide, and dispatching at the un-deferred cadence while only the
   * leader backed off. The local prune is the observation every coordinator has
   * of its own spawns.
   *
   * Synchronous up to the backoff arm, so a caller that must clean up after the
   * event (the prune drops the agent's event buffer) sees the effect
   * immediately.
   */
  private reportProvisionFailure(opts: {
    scalerName: string;
    agentId: string;
    runId?: string;
    jobId?: string;
  }): void {
    if (!this.claimFailedProvision(opts.scalerName, opts.agentId)) return;
    this.handleScalerEvent(
      {
        agentId: opts.agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail:
          `External provisioning for scaler \`${opts.scalerName}\` produced no agent: ` +
          `the scale-up was delivered, but agent ${opts.agentId} never registered before ` +
          `the spawn timeout. The provisioning workflow, or the provider it drives, did not ` +
          `deliver a running agent.`,
        timestampMs: Date.now(),
      },
      {
        ...(opts.runId !== undefined && { runId: opts.runId }),
        ...(opts.jobId !== undefined && { jobId: opts.jobId }),
        backendName: opts.scalerName,
        backendType: ScalerBackendType.enum.event,
      },
    );
    void this.recordProvisionFailure(opts.scalerName).catch((err) => {
      logger.warn('scaler: failed to arm the provision backoff', {
        scaler: opts.scalerName,
        error: toErrorMessage(err),
      });
    });
  }

  /**
   * Report a pruned event spawn as a dead provision — unless a peer adopted it.
   *
   * The prune is NOT proof of failure on an HA cluster. Nothing tells the
   * spawning coordinator that its agent registered on a peer, so the entry
   * survives adoption and lands in the prune the stale window later next to a
   * perfectly live agent — the same asymmetry `deleteUnadoptedSpawningAgent`
   * exists for. Reporting that as a dead provision writes a `scaler.failed` and
   * a `last_provisioning_error` onto a job that is running, and backs a healthy
   * scaler off, which is the misattribution this whole report exists to remove.
   * The reaper already applies the same test: it returns `spawn-timeout` only
   * for a candidate with no `adoptedBy`, so without this the two observers of
   * one provision disagree.
   *
   * The question is "was this provision ever adopted?", and the spawn row alone
   * cannot answer it: the row is deleted on teardown, so its absence is BOTH
   * "never adopted" and "adopted, then torn down". `provisionAdopter` reads the
   * live row first and the durable provision-outcome record second, which
   * survives the delete — so an adopted provision the reaper has since
   * condemned no longer reads as a dead one.
   *
   * The lookup is fire-and-forget so the prune stays off the request path, and
   * it fails open. Both "the store errored" and "there is no verdict" leave the
   * failure reported, deliberately: a provision with no positive evidence of
   * adoption is what a single coordinator sees on a real provisioning outage,
   * and suppressing there would disarm the per-coordinator backoff on every
   * follower — an invisible missing report in place of a visible false one. The
   * only rows with no verdict are those adopted before the outcome table
   * existed, and they age out within one stale-prune window of the deploy.
   */
  private reportPrunedProvisionFailure(agentId: string, entry: SpawningEntry): void {
    const report = (): void => {
      this.reportProvisionFailure({
        scalerName: entry.backendName,
        agentId,
        ...(entry.runId !== undefined && { runId: entry.runId }),
        ...(entry.boundJobId !== undefined && { jobId: entry.boundJobId }),
      });
      // The prune's own buffer drop has already run by the time an async report
      // lands, so an unbound failure would park a fresh entry nothing can ever
      // flush — the correlation it waits for needs the agent to register, which
      // this one never did.
      this.eventBuffer.delete(agentId);
    };
    if (!this.stateStore) {
      report();
      return;
    }
    void this.stateStore
      .provisionAdopter(agentId)
      .then((adoptedBy) => {
        if (adoptedBy !== null) {
          logger.info('scaler: pruned spawn was adopted by a peer, not a failed provision', {
            agentId,
            scaler: entry.backendName,
            adoptedBy,
          });
          return;
        }
        report();
      })
      .catch((err) => {
        logger.warn('scaler: adoption lookup failed for a pruned spawn; reporting it as failed', {
          agentId,
          scaler: entry.backendName,
          error: toErrorMessage(err),
        });
        report();
      });
  }

  /**
   * Clear a scaler's consecutive-failure state after a successful provision.
   *
   * Called from `onAgentRegistered`, which is the single entry point for BOTH a
   * locally-spawned agent and one this coordinator adopted from a peer. An
   * adopted agent is a successful provision — the instance that spawned it
   * is not the one it reached — so counting only local registrations
   * would leave a healthy scaler deferred on an HA cluster.
   */
  private clearProvisionFailures(backendName: string): void {
    if (this.provisionFailures.delete(backendName)) {
      logger.info('scaler: external provisioning recovered, cleared the backoff', {
        scaler: backendName,
      });
    }
  }

  /**
   * Emit `kici.scaler.scale-down` straight from a persisted spawn spec, then
   * drop the durable row.
   *
   * Used where the instance holding the agent has no local backend for its
   * scaler — the ordinary shape on an HA cluster behind one shared endpoint,
   * where the coordinator the agent reached may not configure the scaler that
   * spawned it. The row's own targets are therefore primary, with local config
   * as the fallback for a row that recorded none.
   *
   * A failed emit leaves the row in place: it is the only durable pointer at
   * the customer's running instance, so the reaper needs it to retry from.
   *
   * Returns whether the teardown was actually emitted, so a caller that counts
   * teardowns counts deliveries rather than attempts.
   */
  private async emitScaleDownForSpec(
    spec: AdoptedSpec,
    agentId: string,
    reason: ScaleDownReason,
  ): Promise<boolean> {
    const emitter = this.eventEmitter?.();
    if (!emitter) {
      logger.error('scaler: no event emitter to tear down an adopted provision', {
        agentId,
        scalerName: spec.scalerName,
      });
      return false; // leave the row so the reaper retries
    }
    // The row's own targets are primary — the instance holding the agent may
    // not configure this scaler at all, which is the whole reason they are
    // persisted. Local config is the fallback for a row that recorded none:
    // whichever coordinator does configure the scaler can then resolve it,
    // which is the only way such a row ever clears.
    const targets = spec.provisioningTargets.length
      ? spec.provisioningTargets
      : (this.scalerProvisioningTargets.get(spec.scalerName) ?? []);
    if (targets.length === 0) {
      // Neither the row nor this instance's config names anywhere to deliver
      // the teardown, so an emit would reach no subscriber while counting as a
      // scale-down and dropping the row. Keep the row instead — it is the only
      // pointer left at the customer's running instance — and say so loudly on
      // every attempt until a coordinator that configures the scaler picks it
      // up through the fallback above.
      logger.error('scaler: adopted provision has no provisioning targets to tear it down', {
        agentId,
        scalerName: spec.scalerName,
      });
      return false;
    }
    try {
      await emitter.emitScalerScaleDown(
        { scalerName: spec.scalerName, agentId, reason, requestId: randomUUID() },
        targets,
      );
      incScalerScaleDownEmitted(spec.scalerName, reason);
    } catch (err) {
      logger.error('scaler: failed to emit scale-down for an adopted provision', {
        agentId,
        scalerName: spec.scalerName,
        error: toErrorMessage(err),
      });
      return false; // leave the row so the reaper retries
    }
    this.deleteSpawningAgentFromStore(agentId);
    return true;
  }

  /**
   * Look up the scaler backend TYPE (a `ScalerBackendType` — `container`,
   * `firecracker`, `bare-metal`, `event`, …) for a registered agent.
   * Returns null if the agent is not scaler-managed (a static / stateful
   * agent).
   *
   * Used by AgentMetricsAggregator to stamp the `scaler` label on each
   * kici_agent_* series. The label MUST be the backend type, not the
   * operator-chosen scaler name: the Platform catalog filter constrains
   * it to the ScalerBackendType set (plus `stateful`), so a free-form name is
   * dropped as bad_label_value. `managedAgentIndex` stores the scaler
   * name, so resolve it through `backends` to the type.
   */
  getBackendType(agentId: string): string | null {
    const scalerName = this.managedAgentIndex.get(agentId);
    if (scalerName === undefined) return null;
    return this.backends.get(scalerName)?.type ?? null;
  }

  /**
   * Exchange a provisioning claim code for freshly minted ephemeral credentials.
   *
   * Reads the shared claim table directly rather than routing through the
   * backend that minted the code: the mint needs only the agent-token store,
   * which is already DB-backed, so redemption succeeds on an instance that has
   * never heard of the emitting scaler. That is what lets an HA cluster front
   * its coordinators with one shared endpoint — the provisioned agent reaches
   * whichever coordinator the load balancer picks.
   *
   * Returns `{ error }` when this instance has no claim store (no database), or
   * when the redeem is rejected (unknown / consumed / expired / minting error).
   * Called from the `scaler.claim-credentials` WS handler.
   */
  async claimScalerCredentials(
    code: string,
  ): Promise<{ credentials?: ClaimedCredentials; error?: string }> {
    if (!this.claimStore) {
      // A coordinator with no scaler config has no claim store, so it rejects
      // every claim a provisioned agent presents. Behind one shared endpoint
      // that is roughly half of them, and the agent only sees "invalid claim
      // code" — say what actually happened, on the one side that knows.
      logger.error(
        'scaler: refusing a provisioning claim because this coordinator has no scaler claim store; every event scaler must be configured on every coordinator',
      );
      return { error: 'invalid claim code' };
    }
    try {
      return { credentials: await this.claimStore.claim(code) };
    } catch (err) {
      return { error: toErrorMessage(err) };
    }
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
    this.started = false;
    if (this.capacityFreedTimer) {
      clearTimeout(this.capacityFreedTimer);
      this.capacityFreedTimer = null;
    }
    if (this.retirementSweep) {
      clearInterval(this.retirementSweep);
      this.retirementSweep = null;
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
    this.warmAgents.clear();
    this.warmDestroying.clear();
    this.adoptedAgents.clear();
    this.logForwarders.clear();
    this.agentJobCorrelation.clear();
    this.eventBuffer.clear();
  }

  /**
   * Classify every configured scaler against the currently loaded backends.
   * Pure — it reads state and writes none.
   */
  private planReload(newConfig: ScalerConfig): ReloadPlan {
    const plan: ReloadPlan = {
      added: [],
      kept: [],
      resurrected: [],
      removed: [],
      typeChanged: [],
    };

    const configured = new Set(newConfig.scalers.map((s) => s.name));
    for (const entry of newConfig.scalers) {
      const backend = this.backends.get(entry.name);
      if (!backend) {
        plan.added.push(entry);
      } else if (backend.type !== entry.type) {
        plan.typeChanged.push({ entry, currentType: backend.type });
      } else if (this.retiring.has(entry.name)) {
        plan.resurrected.push(entry);
      } else {
        plan.kept.push(entry);
      }
    }

    for (const name of this.backends.keys()) {
      if (!configured.has(name) && !this.retiring.has(name)) {
        plan.removed.push(name);
      }
    }

    return plan;
  }

  /**
   * Validate the new config: label-set overlaps, backend type changes, and
   * each kept backend's own view of its label sets.
   *
   * `backend.reload` validates and applies in one call, so a backend rejected
   * late in the loop would otherwise leave the ones before it holding the new
   * label sets and `maxAgents` while the commit never runs. Each successful
   * call's previous state is therefore snapshotted and restored when any
   * backend rejects — a rejected reload leaves every backend as it was.
   *
   * The snapshots are returned as well as used here: a later stage can still
   * fail (an added scaler whose backend does not construct), and the same
   * rollback is what keeps that rejection from half-applying too.
   */
  private validateReload(
    newConfig: ScalerConfig,
    plan: ReloadPlan,
  ): { errors: string[]; applied: AppliedBackendReload[] } {
    const errors: string[] = [];

    for (const o of detectLabelSetOverlaps(newConfig.scalers)) {
      errors.push(
        `Label set [${o.labels}] overlaps between scalers "${o.scaler1}" and "${o.scaler2}"`,
      );
    }

    for (const { entry, currentType } of plan.typeChanged) {
      errors.push(
        `scaler "${entry.name}": backend type cannot change from ${currentType} to ${entry.type} ` +
          `on reload; restart the orchestrator to apply`,
      );
    }
    if (errors.length > 0) return { errors, applied: [] };

    const applied: AppliedBackendReload[] = [];
    for (const entry of [...plan.kept, ...plan.resurrected]) {
      const backend = this.backends.get(entry.name);
      if (!backend) continue;
      const previous = {
        backend,
        labelSets: backend.labelSets,
        maxAgents: backend.maxAgents,
        entry: backend.currentEntry,
      };
      // The whole entry, not just labelSets + maxAgents: the event backend reads
      // roles, mandatoryLabels, agentTokenTtlSeconds and provisioningTargets off
      // it at every spawn, and the manager's own copies of those refresh here too.
      const result = backend.reload(entry.labelSets, { maxAgents: entry.maxAgents, entry });
      if (result.valid) {
        applied.push(previous);
      } else {
        errors.push(...result.errors);
      }
    }

    if (errors.length > 0) {
      this.restoreReloadedBackends(applied);
      return { errors, applied: [] };
    }

    return { errors, applied };
  }

  /** Put every backend a rejected reload had already mutated back as it was. */
  private restoreReloadedBackends(applied: AppliedBackendReload[]): void {
    for (const previous of applied) {
      previous.backend.reload(previous.labelSets, {
        maxAgents: previous.maxAgents,
        ...(previous.entry && { entry: previous.entry }),
      });
    }
  }

  /**
   * Construct every added backend into a staging list. On any failure the
   * partially built set is torn down and the caller keeps the old config.
   */
  private async buildAddedBackends(
    added: ScalerEntry[],
    newConfig: ScalerConfig,
  ): Promise<{ built: Array<{ name: string; backend: ScalerBackend }>; errors: string[] }> {
    const built: Array<{ name: string; backend: ScalerBackend }> = [];
    if (added.length === 0) return { built, errors: [] };

    const factory = this.createBackend;
    if (!factory) {
      return {
        built,
        errors: added.map(
          (e) => `scaler "${e.name}": cannot be added on reload (no backend factory configured)`,
        ),
      };
    }

    for (const entry of added) {
      try {
        const backend = await factory(entry, newConfig);
        if (!backend) {
          throw new Error(`scaler type "${entry.type}" is not supported on this host`);
        }
        built.push({ name: entry.name, backend });
      } catch (err) {
        for (const b of built) {
          await b.backend.shutdownAll().catch(() => {});
        }
        return { built: [], errors: [`scaler "${entry.name}": ${toErrorMessage(err)}`] };
      }
    }

    return { built, errors: [] };
  }

  /**
   * Host prep for backends added by a reload: bridge provisioning, a reap of
   * leftovers from a previous incarnation of the same scaler, and the periodic
   * TAP sweep a long-running Firecracker backend needs. Every failure degrades
   * that one scaler; none of them fails the reload.
   */
  private async prepareAddedBackends(
    built: Array<{ name: string; backend: ScalerBackend }>,
  ): Promise<void> {
    for (const { name, backend } of built) {
      if (backend.ensureHostReady) {
        await backend.ensureHostReady().catch((err: unknown) => {
          logger.error(
            `host self-provision failed for scaler "${name}": ${toErrorMessage(err)}; scaler will be degraded`,
          );
        });
      }

      if (
        backend.type === ScalerBackendType.enum.container ||
        backend.type === ScalerBackendType.enum.firecracker
      ) {
        try {
          const cleaned = await (backend as unknown as OrphanReaping).cleanupOrphans();
          if (cleaned > 0) {
            logger.info('reaped orphaned resources for added scaler', { scaler: name, cleaned });
          }
        } catch (err) {
          logger.warn('orphan cleanup failed for added scaler', {
            scaler: name,
            error: toErrorMessage(err),
          });
        }
      }

      if (backend.type === ScalerBackendType.enum.firecracker) {
        // Startup-only cleanup is not enough for a long-running orchestrator:
        // a leaked TAP under churn can wedge NetworkManager.
        (backend as unknown as PeriodicSweeping).startPeriodicOrphanSweep();
      }
    }
  }

  /**
   * Refresh per-scaler metadata from the new config. Keys are deleted only for
   * scalers that are neither configured nor retiring — a retiring scaler keeps
   * its cap, URL, roles and defaults until its last agent is gone.
   */
  private applyScalerMetadata(newConfig: ScalerConfig): void {
    const configured = new Set(newConfig.scalers.map((s) => s.name));
    for (const name of [...this.backends.keys()]) {
      if (configured.has(name) || this.retiring.has(name)) continue;
      this.forgetScaler(name);
    }

    for (const entry of newConfig.scalers) {
      this.scalerUrls.set(entry.name, entry.orchestratorUrl);
      this.backendRoles.set(entry.name, entry.roles);
      this.scalerProvisioningTargets.set(entry.name, entry.provisioningTargets);
      if (entry.resourceCap) {
        this.resourceCaps.set(entry.name, entry.resourceCap);
      } else {
        this.resourceCaps.delete(entry.name);
      }
      this.scalerMachinePools.set(entry.name, entry.machinePool);
      this.scalerDefaults.set(entry.name, this.resolveScalerDefaults(newConfig, entry));
      this.scalerMandatoryLabels.set(entry.name, entry.mandatoryLabels ?? []);
      this.scalerPlatform.set(entry.name, entry.platform);
      if (this.maxConcurrentSpawns.get(entry.name) !== entry.maxConcurrentSpawns) {
        this.maxConcurrentSpawns.set(entry.name, entry.maxConcurrentSpawns);
        // Drop the stale semaphore so the next spawn builds one at the new width.
        this.spawnSemaphores.delete(entry.name);
      }
      this.warnOnUnstructuredPlatformLabels(entry);
      // Preserve existing usage counters; only initialize for new scalers.
      if (!this.perScalerUsage.has(entry.name)) {
        this.perScalerUsage.set(entry.name, { cpus: 0, memBytes: 0 });
      }
    }

    this.applyMachinePools(newConfig);
  }

  /**
   * Register every configured machine pool with the ledger, building the
   * ledger when this reload is the first config to declare a pool. `cap` is
   * re-registered on every reload, so a changed cap applies without a restart.
   */
  private applyMachinePools(newConfig: ScalerConfig): void {
    const pools = newConfig.machinePools ?? [];
    if (pools.length === 0) return;

    if (!this.machineLedger) {
      const instanceId = this.machineLedgerOptions?.instanceId;
      if (!instanceId) {
        logger.error(
          'machinePools were added by a config reload but no machine-ledger instance id was ' +
            'configured; pools stay unregistered until the orchestrator is restarted',
        );
        return;
      }
      this.machineLedger = new MachineLedger({
        explicitDir: this.machineLedgerOptions?.dir,
        instanceId,
      });
      if (this.started) this.machineLedger.start();
    }

    for (const pool of pools) {
      this.machineLedger.registerPool(pool.name, pool.cap);
    }
  }

  /** Rebuild the warm-pool config map from the new config (see WarmPoolManager.reload). */
  private applyWarmPoolConfig(newConfig: ScalerConfig): void {
    const warmPoolConfigs = new Map<
      string,
      {
        backendName: string;
        size: number;
        idleTimeoutSeconds: number;
        labels: string[];
        spawnLabels: string[];
      }
    >();
    for (const entry of newConfig.scalers) {
      if (!entry.warmPool?.enabled) continue;
      for (const ls of entry.labelSets) {
        const queryLabels = this.warmPoolQueryLabels(entry.name, entry.type, ls.labels);
        if (!this.warmPoolLabelSetFillable(entry.name, ls.labels, queryLabels)) continue;
        if (!this.warmPoolShapeDeclared(entry.name, ls.labels, ls.resources)) continue;
        warmPoolConfigs.set(normalizeLabelSet(ls.labels), {
          backendName: entry.name,
          size: entry.warmPool.size,
          idleTimeoutSeconds: entry.warmPool.idleTimeoutSeconds,
          labels: queryLabels,
          spawnLabels: ls.labels,
        });
      }
    }
    this.warmPool.reload(warmPoolConfigs);
    this.publishWarmPoolGauges();
  }

  /**
   * Validate and reload configuration: plan → validate → build → commit.
   *
   * Either the whole new config applies, or nothing does and the previous one
   * keeps running. A scaler the new config no longer names is retired, not
   * dropped: it stops taking work at once, its idle warm agents are destroyed,
   * its job-bound agents finish, and its backend is torn down when it drains.
   */
  async reload(newConfig: ScalerConfig): Promise<ValidationResult> {
    const plan = this.planReload(newConfig);

    // Validate against live state. `backend.reload` applies as it validates, so
    // `applied` carries what each kept backend held before this call.
    const { errors, applied } = this.validateReload(newConfig, plan);
    if (errors.length > 0) return { valid: false, errors };

    // Build added backends into a staging list; a failure leaves the old config.
    const { built, errors: buildErrors } = await this.buildAddedBackends(plan.added, newConfig);
    if (buildErrors.length > 0) {
      // The kept backends already took the new label sets during validation.
      // Nothing else has moved, so putting them back is what keeps a scaler
      // that failed to construct from half-applying the rest of the file.
      this.restoreReloadedBackends(applied);
      return { valid: false, errors: buildErrors };
    }

    // Commit — synchronous, so no interleaved dispatch sees a half-applied config.
    for (const { name, backend } of built) {
      this.backends.set(name, backend);
    }
    for (const entry of plan.resurrected) {
      this.retiring.delete(entry.name);
      this.retiredAt.delete(entry.name);
    }
    for (const name of plan.removed) {
      this.retireBackend(name);
    }

    this.globalMaxAgents = newConfig.globalMaxAgents;
    this.globalResourceCap = newConfig.globalResourceCap;
    this.applyScalerMetadata(newConfig);
    this.applyWarmPoolConfig(newConfig);

    logger.info('scaler configuration reloaded', {
      added: built.map((b) => b.name),
      removed: plan.removed,
      retiring: [...this.retiring],
      unchanged: plan.kept.length,
    });

    // Post-commit, best-effort: host prep + orphan reap for the new backends.
    await this.prepareAddedBackends(built);

    // A scaler removed while it had no agents drains instantly — tear it down
    // now rather than leaving it visible until the next sweep tick.
    await this.sweepRetiredBackends();

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
        // A retiring scaler has no enriched entry, so both gate fields derive
        // directly — `labelSets` above falls back to `backend.labelSets` in the
        // same case, and all three must stay in step. The deprecated field is
        // the union of the per-set gates, so its fallback derives the same way:
        // reading the configured `mandatoryLabels` alone would drop the
        // platform taints a retiring pool still carries.
        mandatoryLabels: enriched?.mandatoryLabels ?? this.effectiveMandatoryLabels(name, backend),
        labelSetMandatoryLabels:
          enriched?.labelSetMandatoryLabels ??
          backend.labelSets.map((ls) => this.labelSetMandatoryLabels(name, backend, ls.labels)),
        retiring: this.retiring.has(name),
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
   * Scaler capacity advertised to peers in the cluster heartbeat.
   *
   * Retiring backends are excluded: they accept no new work locally, so a peer
   * that saw them would keep selecting this host for jobs it can no longer
   * serve. Agents still draining on a retiring backend stay visible through the
   * separate per-agent inventory, so in-flight work is unaffected.
   */
  getRoutableCapacity(): ScalerCapacitySummary[] {
    return this.getStatus()
      .backends.filter((b) => !b.retiring)
      .map((b) => ({
        name: b.name,
        type: b.type,
        labelSets: b.labelSets,
        maxAgents: b.maxAgents,
        activeCount: b.activeCount,
        spawnsOnLocalHost: b.spawnsOnLocalHost,
        // The scaler-wide union stays populated for a peer that predates the
        // per-label-set gate; a peer that understands the new field prefers it.
        mandatoryLabels: b.mandatoryLabels,
        labelSetMandatoryLabels: b.labelSetMandatoryLabels,
      }));
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
   * Start the warm pool idle check interval, the machine-pool ledger reaper,
   * and the retirement sweep that tears down drained retiring backends.
   */
  start(): void {
    this.started = true;
    this.warmPool.start();
    this.publishWarmPoolGauges();
    if (this.machineLedger) {
      this.machineLedger.start();
    }
    this.retirementSweep ??= setInterval(() => {
      void this.sweepRetiredBackends();
    }, RETIREMENT_SWEEP_INTERVAL_MS);
    this.retirementSweep.unref?.();
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
   * The window a spawning entry may sit unregistered before it is pruned.
   *
   * An entry cannot be stale before its own spawn deadline has passed, so the
   * window is floored at the configured deadline: an operator raising
   * `KICI_SCALER_SPAWN_TIMEOUT_MS` for a slow cloud must not have this prune
   * fire first and drop the correlation a provision booting inside the raised
   * deadline still needs. The floor only ever extends the window — a lowered
   * deadline keeps the default five minutes, because a local backend's agent
   * boots and registers well after `spawn()` itself returns.
   */
  private stalePruneWindowMs(): number {
    return Math.max(this.spawnTimeoutMs, DEFAULT_STALE_SPAWN_PRUNE_MS);
  }

  /**
   * Remove spawning entries whose `backend.spawn` started longer ago than the
   * stale window but never registered via WS (e.g., process/container crashed
   * on startup). Without cleanup, these entries would leak in spawningAgents
   * forever.
   *
   * The window is measured from `spawnStartedAt` (when the throttled spawn
   * actually began), NOT from `spawnedAt` (enqueue time): a spawn still waiting
   * behind the per-backend spawn semaphore has not started and must not be
   * reaped mid-queue during a large burst. Recovered orphan entries carry
   * `spawnStartedAt` set to their persisted enqueue time, so they are subject to
   * the normal window.
   *
   * What happens to the durable row depends on the backend type the spawn
   * recorded, which the entry carries so a scaler since removed from this
   * coordinator's config still resolves. A local backend's
   * compute is pinned to a host this process manages, so a pruned entry means
   * the spawn is dead and the row goes. An event backend's row is the only
   * durable pointer at a customer cloud instance, and it is precisely the
   * reaper's `spawn-timeout` candidate — so the row STAYS, and the reaper
   * decides. Deleting it here would beat the reaper by the flap grace on any
   * coordinator serving jobs, so the teardown the row exists to trigger would
   * never be emitted.
   */
  private pruneStaleSpawningEntries(): void {
    const staleThreshold = Date.now() - this.stalePruneWindowMs();
    for (const [id, entry] of this.spawningAgents) {
      // Skip spawns still queued in the semaphore (not yet started).
      if (entry.spawnStartedAt === undefined) continue;
      if (entry.spawnStartedAt < staleThreshold) {
        this.spawningAgents.delete(id);
        // A warm fill that never registered still holds an in-flight slot.
        // Release it here or the pool stays permanently below target.
        if (!entry.boundJobId) this.warmPool.onWarmSpawnFailed(entry.labelSet);
        const backend = this.backends.get(entry.backendName);
        // Branch on the type the spawn recorded, not on whether a backend is
        // configured here. A scaler removed from this coordinator's config has
        // no backend, and reading that as "not an event scaler" deletes the row
        // that is the only pointer at a running customer cloud instance —
        // `recoverState` rehydrates every owned row whether or not its scaler
        // still exists, so a restart after such an edit would leak every
        // in-flight provision. Live config resolves the type only for a row
        // that recorded none.
        const backendType = entry.backendType ?? backend?.type;
        if (backendType === ScalerBackendType.enum.event) {
          // Nothing tells this instance that a peer adopted the agent, so the
          // backend entry `spawn()` seeded would otherwise live until the
          // process exits — counting against the global cap forever and
          // handing `shutdownAll()` a peer's live agent. Forgetting emits
          // nothing: this coordinator stops tracking the provision, and the
          // adopter (or the reaper) owns the teardown. There is nothing to
          // forget when the scaler is no longer configured here — the backend
          // that held the entry went with it.
          if (backend instanceof EventScalerBackend) backend.forget(id);
          // A pruned event spawn is a failed external provision UNLESS the
          // durable provision-outcome record says it was adopted — a teardown
          // deletes the spawn row, so the row's absence proves nothing. See
          // `reportPrunedProvisionFailure`. Reporting it here
          // at all is what makes the backoff work on a multi-coordinator
          // cluster: the reaper is leader-gated and `provisionFailures` is
          // per-instance, so a non-leader would record nothing and keep
          // dispatching at the un-deferred cadence through the whole outage
          // while only the leader backed off. Deduped by agent id, so the
          // leader seeing the same provision twice still counts it once.
          this.reportPrunedProvisionFailure(id, entry);
        } else {
          // Conditional on `adopted_by IS NULL` for safety even here: a
          // local-backend row is never adoptable, so the predicate is a
          // belt-and-braces guard rather than a live branch.
          this.deleteUnadoptedSpawningAgentFromStore(id);
        }
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
        // Same argument, applied to the event buffer. A backend that emitted a
        // `scaler.failed` for an unbound spawn parked it here waiting for a
        // correlation, and the paragraph above is exactly the proof that the
        // correlation can never arrive — so the entry would sit in the map for
        // the life of the process, one per pruned warm spawn.
        this.eventBuffer.delete(id);
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

  /**
   * The spawn row for one agent, as every writer of it must build it.
   *
   * Ownership and self-describing columns are assembled only here.
   * `backend_type` is what `adoptSpawningAgent`'s conditional UPDATE matches
   * on, so a row without it can never be adopted by any instance — including
   * the one that spawned it. `owner_instance_id` scopes recovery to that
   * instance, and `mandatory_labels` carries the platform taint to a
   * coordinator that has no config entry for this scaler and can therefore
   * derive it from nothing else. `provisioning_targets` is the same story for
   * teardown: it is the only address such a coordinator has for the customer's
   * teardown workflow, and an emit to an empty target list reaches nobody, so
   * the provision would bill forever. `roles` travels with it so the row stays
   * a complete description of the spawn.
   */
  private spawningAgentSnapshot(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    boundJobId: string | undefined,
    /**
     * The run the bound job belongs to. Persisted so a coordinator that never
     * spawned this agent — the leader-gated reaper is routinely a different one
     * — can still attribute a provisioning failure back to the waiting job.
     * Absent for a warm pre-spawn, which has no run.
     */
    runId?: string,
  ): SpawningAgentSnapshot {
    const backend = this.backends.get(scalerName);
    const provisioningTargets = this.scalerProvisioningTargets.get(scalerName);
    const roles = this.backendRoles.get(scalerName);
    return {
      agentId,
      scalerName,
      labelSet,
      boundJobId: boundJobId ?? undefined,
      ...(runId !== undefined && { runId }),
      spawnedAt: new Date(),
      ownerInstanceId: this.instanceId,
      ...(provisioningTargets && { provisioningTargets }),
      ...(roles && { roles }),
      ...(backend && {
        backendType: backend.type,
        // The gate for the set this agent is spawned for, not the scaler-wide
        // union: the adopting coordinator stamps this row's value straight onto
        // the agent, so a union would carry a sibling set's platform taint.
        mandatoryLabels: this.labelSetMandatoryLabels(scalerName, backend, labelSet),
      }),
    };
  }

  /**
   * Claim one slot against an event scaler's cluster-wide `maxAgents`.
   *
   * The count and the claim share a single advisory-locked transaction, so the
   * row this writes is already visible to the next coordinator that takes the
   * lock. A store failure is never an admission: returning false costs a job a
   * queue wait, while admitting on a count nobody recorded provisions a cloud
   * instance the cap cannot see. Failing closed is not silent — a refusal
   * increments the spawn-refusal counter and a store failure its own counter,
   * labelled so a database outage, a contended lock, and a full cluster are
   * three distinguishable things rather than one.
   *
   * The failure arm bounds the admission, not the row: a transaction that
   * commits and then loses its acknowledgement leaves `slotClaimed` false, so
   * neither rollback path fires and the row counts against the cap for an
   * agent that never spawned. Closing that window needs two-phase commit; the
   * event-provision reaper is the backstop, clearing the row once the spawn
   * deadline passes with nothing adopted.
   */
  private async claimClusterSlot(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    maxAgents: number,
    /**
     * The job this spawn serves, or `undefined` for a warm pre-spawn. The
     * durable snapshot has always accepted an unbound spawn; only this
     * parameter was narrower.
     */
    boundJobId: string | undefined,
    /** The bound job's run, persisted alongside it so a failure stays attributable. */
    runId: string | undefined,
  ): Promise<boolean> {
    if (!this.stateStore) return false;
    try {
      return await this.stateStore.withScalerCapLock(scalerName, async (slot) => {
        if (slot.clusterActiveCount >= maxAgents) {
          logger.info('scaler.cap exceeded for scaler agents cluster-wide', {
            scaler: scalerName,
            used: slot.clusterActiveCount,
            max: maxAgents,
          });
          incScalerSpawnRefusals();
          return false;
        }
        await slot.reserve(
          this.spawningAgentSnapshot(agentId, labelSet, scalerName, boundJobId, runId),
        );
        return true;
      });
    } catch (err) {
      const reason = capLockFailureReason(err);
      logger.error('scaler: cluster-wide cap check failed, refusing the spawn', {
        agentId,
        scalerName,
        reason,
        error: toErrorMessage(err),
      });
      scalerCapLockFailuresTotal.add(1, { reason });
      return false;
    }
  }

  private persistSpawningAgent(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    boundJobId: string | undefined,
    runId?: string,
  ): void {
    if (!this.stateStore) return;
    this.stateStore
      .upsertSpawningAgent(
        this.spawningAgentSnapshot(agentId, labelSet, scalerName, boundJobId, runId),
      )
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

  /**
   * Stamp `adopted_by = this instance` on the spawning row of an agent that just
   * registered here. Reuses the cross-instance conditional UPDATE, so a row some
   * other instance already claimed is left exactly as it is.
   */
  private markSpawningAgentAdopted(agentId: string): void {
    if (!this.stateStore) return;
    this.stateStore.adoptSpawningAgent(agentId, this.instanceId).catch((err) => {
      logger.warn('scaler: failed to mark spawning-agent row adopted', {
        agentId,
        error: toErrorMessage(err),
      });
    });
  }

  /** Store-side half of the stale prune: drops the row only if nobody adopted it. */
  private deleteUnadoptedSpawningAgentFromStore(agentId: string): void {
    if (!this.stateStore) return;
    this.stateStore.deleteUnadoptedSpawningAgent(agentId).catch((err) => {
      logger.warn('scaler: failed to delete unadopted spawning-agent row', {
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
        // Recovery reads reservations owner-scoped, so an unstamped row belongs
        // to nobody: this instance would rehydrate zero usage after a restart
        // and its caps would under-count every agent it is still running.
        ownerInstanceId: this.instanceId,
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
   * Both reads are scoped to this instance's own rows. An unscoped read
   * hydrates a peer's in-flight spawns and reservations as our own, so our
   * spawn-timeout reaper destroys agents that peer is still legitimately
   * waiting on and our caps double-count its reservations. Rows owned by a
   * dead instance are the leader-gated reaper's business, not ours.
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
      const spawning = await this.stateStore.listSpawningAgentsForOwner(this.instanceId);
      for (const entry of spawning) {
        // A recovered entry is orphaned from this instance's previous life: no
        // live spawn backs it, so treat it as already-started (staleness
        // measured from its persisted enqueue time) rather than a still-queued
        // spawn we'd never reap.
        this.spawningAgents.set(entry.agentId, {
          labelSet: entry.labelSet,
          backendName: entry.scalerName,
          provisioningTargets: entry.provisioningTargets ?? [],
          spawnedAt: entry.spawnedAt.getTime(),
          spawnStartedAt: entry.spawnedAt.getTime(),
          ...(entry.backendType !== undefined && { backendType: entry.backendType }),
          ...(entry.boundJobId !== undefined && { boundJobId: entry.boundJobId }),
          // Without the run id a failure on a recovered spawn cannot be routed
          // to the job still waiting on it: `onScalerEvent` takes both halves,
          // and the correlation map is only populated post-registration — which
          // is exactly what never happened for a recovered spawning entry.
          ...(entry.runId !== undefined && { runId: entry.runId }),
        });
      }
      recovery.spawningAgentsRehydrated = spawning.length;

      const correlations = await this.stateStore.listAgentJobs();
      for (const c of correlations) {
        this.agentJobCorrelation.set(c.agentId, { runId: c.runId, jobId: c.jobId });
      }
      recovery.agentJobsRehydrated = correlations.length;

      const reservations = await this.stateStore.listReservationsForOwner(this.instanceId);
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

  /**
   * Mint a scaler-managed agent id.
   *
   * Built from {@link SCALER_AGENT_ID_PREFIX} rather than a second copy of the
   * literal: the registration guard in `onAgentRegistered` recognises a
   * scaler-managed agent by that prefix alone when the spawn-record lookup
   * fails, so a minting prefix that drifts from the constant leaves the guard
   * matching nothing and failing open.
   */
  private generateAgentId(backendType: string): string {
    return `${SCALER_AGENT_ID_PREFIX}${backendType}-${randomUUID().slice(0, 8)}`;
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
   *
   * `attribution` is the last resort for a failure this coordinator did not
   * spawn and never registered: the reaper is leader-gated, so the instance that
   * condemns a stranded external provision routinely has neither a spawning
   * entry nor a managed-agent index row for it, and every in-memory resolver
   * above comes back empty. It is read only where the maps are silent, so a live
   * local entry always wins over a durable row that may be a sweep behind.
   */
  private handleScalerEvent(event: ScalerEvent, attribution?: ScalerEventAttribution): void {
    const correlated = this.agentJobCorrelation.get(event.agentId);
    const spawning = this.spawningAgents.get(event.agentId);
    const runId = correlated?.runId ?? spawning?.runId ?? attribution?.runId;
    const jobId = correlated?.jobId ?? spawning?.boundJobId ?? attribution?.jobId;

    // Fleet-wide signal: count + warn on EVERY spawn failure, bound or not.
    if (event.eventType === ScalerEventType.enum['scaler.failed']) {
      const backendName =
        spawning?.backendName ??
        this.managedAgentIndex.get(event.agentId) ??
        attribution?.backendName;
      const backend =
        (backendName ? this.backends.get(backendName)?.type : undefined) ??
        attribution?.backendType ??
        'unknown';
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
