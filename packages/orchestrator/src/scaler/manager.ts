/**
 * ScalerManager: coordinator between the Dispatcher and the scaler backends.
 * Routes "no agent available" signals to a backend, enforces global limits,
 * tracks spawning agents against over-provisioning, and owns the agent
 * lifecycle from spawn to destroy.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  CommandError,
  createLogger,
  getRequestContext,
  requestContext,
  toErrorMessage,
} from '@kici-dev/shared';
import {
  ScalerBackendType,
  ScalerVmTracker,
  TERMINAL_JOB_STATES,
  deriveOsArchLabels,
  platformToOsArchLabels,
  platformToTaints,
  hostToScalerPlatform,
  AGENT_FEATURE_LABELS,
  agentTypeLabel,
  scalerLabel,
  resolveRoleLabels,
} from '@kici-dev/engine';
import type {
  ResourceRequest,
  ResourceSpec,
  ScalerCapacitySummary,
  ScalerLiveVm,
  ScalerPlatform,
  ScalerReloadPlan,
  ScalerVmStopResult,
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
import { spawnsInJobImage, type ScalerAgentView } from './agent-fit.js';
import { EventScalerBackend } from './event-backend.js';
import type { ScalerEventEmitterLike } from './event-backend.js';
import type { ClaimStore, ClaimedCredentials } from './claim-store.js';
import { ScalerFailureTracker } from './failure-tracker.js';

/**
 * How long a graceful shutdown waits for the scaler backends to stop their
 * agents: the first window inside the coordinator's 30 s shutdown limit, so the
 * later steps (HTTP stop grace, database drain) still fit after it.
 *
 * A container stop normally takes at most its own 10 s stop timeout, but a
 * Docker daemon that misses a container's exit waits out that timeout plus
 * another 10 s for its kill; one such container held the step for 29.7 s. Past
 * this window the orchestrator logs each backend still stopping and continues:
 * the runtime finishes the stop, and the next start's orphan cleanup removes
 * any agent container left behind.
 */
export const SCALER_SHUTDOWN_GRACE_MS = 15_000;
import type { BackendFailureSummary } from './failure-tracker.js';
import type {
  ScalerBackend,
  ScalerConfig,
  ScalerEntry,
  ScaleResult,
  ScalerEvent,
  ResourceCap,
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
import { ORCHESTRATOR_DEFAULT_PORT } from '@kici-dev/shared/env';
import { runDetached } from '../helpers/run-detached.js';
import { isDeterministicSpawnError } from './spawn-errors.js';
import {
  listClassifiedLiveVms,
  stopLiveVms,
  type LiveVmBackend,
  type NamedLiveVmBackend,
} from './live-vms.js';

/** The `skipped` reason for a job whose agent is already provisioning or registered. */
export const PROVISION_IN_FLIGHT = 'provision-in-flight';

/** Outcome of an event scaler's cluster-wide slot claim. */
const ClusterSlotClaim = {
  Claimed: 'claimed',
  Refused: 'refused',
  ProvisionInFlight: 'provision-in-flight',
} as const;
type ClusterSlotClaim = (typeof ClusterSlotClaim)[keyof typeof ClusterSlotClaim];

const logger = createLogger({ prefix: 'scaler' });

/**
 * Structured fields for a spawn-failure log line. A failed host command adds
 * its command, exit code, signal, timeout flag and duration, so a query can
 * filter on them; the message already carries its stderr tail.
 */
function spawnFailureFields(err: unknown): Record<string, unknown> {
  return err instanceof CommandError ? err.toLogFields() : {};
}

/**
 * Prefix every scaler-minted agent id carries. Load-bearing: it is the only
 * thing distinguishing a scaler-managed agent from a static one when the spawn
 * record cannot be read at all. See `ScalerManager.generateAgentId`.
 */
const SCALER_AGENT_ID_PREFIX = 'scaler-';

/**
 * Raised when a registering agent presents a scaler-minted id with no spawn
 * record behind it: the lookup failed (`cause` set) or no record exists
 * (`cause` omitted). The WS handler refuses the registration, so the agent
 * reconnects rather than registering with no `mandatoryLabels` gate.
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
 * Classify a cluster-cap-lock failure for the metric. An expired wait budget is
 * a healthy database under contention; anything else is a database the cap
 * check could not use. Both refuse the spawn, so only the label tells an
 * operator which lever to reach for.
 */
function capLockFailureReason(err: unknown): ScalerCapLockFailureReason {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === PG_LOCK_NOT_AVAILABLE
    ? ScalerCapLockFailureReason.Contended
    : ScalerCapLockFailureReason.Unreachable;
}

/**
 * Counting semaphore bounding how many `backend.spawn` operations (image pull +
 * container create + start) run at once per backend, so a burst of in-cap jobs
 * cannot storm the container socket / registry.
 *
 * Release hands the slot directly to the next waiter (rather than bumping a
 * counter the woken task re-decrements), so a task arriving in the microtask gap
 * cannot jump the queue and transiently exceed the cap. `run` releases in
 * `finally`, so a throwing operation never leaks a slot and wedges the queue.
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
 * Resolve the orchestrator WebSocket URL a scaler-spawned agent dials.
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
  return `ws://127.0.0.1:${port ?? ORCHESTRATOR_DEFAULT_PORT}/ws`;
}

/**
 * Resolved per-job `requests` and `limits` (cpus + bytes): the job's declared
 * resources over the scaler's `defaults.resources`, with request<->limit
 * mirroring applied. Caps aggregate `requests`; backends use `limits`.
 */
export interface ResolvedResources {
  requests: { cpus: number; memBytes: number };
  limits: { cpus: number; memBytes: number };
}

/** Per-scaler / per-orchestrator running totals of `requests` (cpus + bytes). */
interface UsageCounter {
  cpus: number;
  memBytes: number;
}

/** Tracking entry for an outstanding reservation (so we can release on agent disconnect). */
interface ReservationEntry {
  scalerName: string;
  requests: { cpus: number; memBytes: number };
  /**
   * The limits the agent was started at — what the kernel enforces, so the
   * other half of the shape a job must match to use a pre-spawned agent. Not
   * persisted, so absent on a reservation `recoverState` rehydrated;
   * {@link ScalerManager.agentView}'s shape check reads that as "cannot tell"
   * on the limits dimension alone rather than refusing.
   */
  limits?: { cpus: number; memBytes: number };
}

/**
 * Apply the request<->limit mirroring rule: a lone side is copied to the other,
 * both sides are kept, and neither side returns undefined.
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
 * A zero means "undeclared", so it is dropped: a backend reads a present-but-zero
 * field as a real limit, and only an absent one falls back to its own label-set
 * or default limits.
 *
 * Both spawn paths use this. A warm agent's shape is fixed at start, so a
 * pre-spawn must carry its resolved shape to the backend exactly as a job-bound
 * spawn does, or the manager reserves (and matches jobs against) a shape the
 * compute never started at. An event backend's `scaler.scale-up` payload builds
 * its `resources` hint from this alone, so an omitted argument leaves the
 * customer's provisioning workflow to pick its own instance size.
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

/** Status summary for metrics and health endpoints. */
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

/**
 * The outcome of `ScalerManager.reload`: the applied plan, or the errors of a
 * refused reload that changed nothing.
 */
export type ScalerReloadResult =
  { valid: true; plan: ScalerReloadPlan } | { valid: false; errors: string[] };

/**
 * A key-order-independent JSON rendering, so two scaler entries compare equal
 * when they hold the same values whatever order the YAML listed them in.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** Backends that can reap leftovers from a previous incarnation of the scaler. */
interface OrphanReaping {
  cleanupOrphans(): Promise<number>;
}

/** Backends that keep a periodic host-resource sweep running while they live. */
interface PeriodicSweeping {
  startPeriodicOrphanSweep(): void;
}

/** An agent being spawned but not yet registered. */
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
  /**
   * Set when `backend.spawn()` resolved: the compute exists and only its
   * agent's registration is outstanding. The stale-spawn prune destroys only a
   * settled spawn — an unsettled one is still inside `spawn()`, whose failure
   * path cleans up after itself — and `onSpawnSettled` destroys a spawn that
   * settles after the prune already dropped it. An entry `recoverState`
   * rehydrated is settled too: no `spawn()` of this process backs it.
   *
   * `withdrawEndedBoundProvisions` withdraws only a settled event spawn: for
   * one still inside `spawn()` the scale-up may not be out yet, and a
   * teardown sent ahead of it would leave the instance the provisioning
   * workflow then creates with nothing to remove it.
   */
  spawnSettled?: boolean;
  /**
   * The agent starts inside its bound job's own container image. Such an agent
   * may run only that job. Recorded here because the spawn is the one place
   * that knows it, and this entry is what registration reads.
   */
  jobImage?: boolean;
}

/**
 * The job a registered scaler agent was started for, and whether it runs
 * inside that job's own image.
 */
interface AgentBinding {
  jobId: string;
  jobImage: boolean;
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

/** Which kind of provisioning failure armed a scaler's backoff; picks the wording. */
enum ProvisionFailureKind {
  /** An event scaler's external provision never registered an agent. */
  External = 'external',
  /** A local backend's host refused to start the agent process. */
  Launch = 'launch',
}

/** Per-scaler consecutive-failure state driving the backoff. */
interface ProvisionFailureState {
  /** Consecutive provisioning failures with no successful registration between. */
  consecutive: number;
  /** Epoch ms before which a further spawn request for this scaler is deferred. */
  deferUntilMs: number;
  /**
   * Agent ids already counted, so two observers of the SAME dead provision count
   * it once: the local stale-spawn prune (every coordinator, over its own spawns)
   * and the leader-gated reaper both fire on the leader, which would otherwise
   * double the backoff there alone. Cleared on a successful registration, and
   * capped so a multi-day outage cannot grow it without bound.
   */
  countedAgents: Set<string>;
}

/**
 * Ceiling on {@link ProvisionFailureState.countedAgents}. The two observers it
 * dedupes fire within minutes of each other, so older ids are dead weight; a
 * long outage would otherwise add one id per attempt for as long as it lasts.
 */
const MAX_COUNTED_FAILED_AGENTS = 64;

/** A job a pending provision was requested for. */
export interface BoundJobRef {
  runId: string;
  jobId: string;
}

/** Everything the {@link ScalerManager} is constructed from. */
export interface ScalerManagerDeps {
  config: ScalerConfig;
  backends: Array<{ name: string; backend: ScalerBackend }>;
  /**
   * Read-only agent-registry view for the warm pool's deficit. Structural on
   * purpose: the scaler must not depend on the agent layer's concrete class.
   *
   * Both hosts pass one. Without it the readiness count falls back to 0, so a
   * configured pool never sees its own agents and fills until
   * `warmCapacityRemaining` clamps it at `maxAgents`, starving the job-bound
   * spawns that share the cap. Optional only for unit tests.
   */
  agentRegistry?: {
    findAvailable(
      requiredLabels: string[],
    ): Array<{ agentId: string; activeJobs: number; registeredAt: number }>;
    /** Whether one agent id is currently registered on this host. */
    isRegistered(agentId: string): boolean;
    /** Condemn an agent before tearing it down; returns its active-job count. */
    markDraining(agentId: string): number | undefined;
    /** Undo `markDraining` when the teardown did not happen. */
    clearDraining(agentId: string): void;
  };
  /**
   * Id of the orchestrator instance this manager runs on. Rows this
   * coordinator writes to the shared scaler tables are attributed to it, so
   * every peer can tell which instance owns a given spawn.
   */
  instanceId: string;
  /** Callback for relaying scaler events with runId/jobId context. */
  onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void;
  /** DB-backed state store, wired by the orchestrator-core bootstrap; tests omit it. */
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
   * Machine-ledger options. With `machinePools` configured, the manager builds a
   * `MachineLedger` keyed off this directory and the instance id; reservations
   * sum across orchestrators on the same host.
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
   * Per-org spawn-deadline resolver, keyed by the job's org
   * (jobConfig.cacheOrgId, undefined for warm-pool spawns); falls back to the
   * cluster default internally. Wired in orchestrator-core (has DB); the worker
   * and unit tests omit it and use spawnTimeoutMs.
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
   * Current `execution_jobs.status` of the jobs bound to pending event
   * provisions, keyed by job id. A job with no row is absent from the map.
   * Each job comes with its run so the read stays on the `(run_id, job_id)`
   * index. Wired in orchestrator-core (has DB); omitted by the worker and most
   * unit tests, which then withdraw nothing and report every pruned provision.
   */
  readJobStatuses?: (jobs: readonly BoundJobRef[]) => Promise<ReadonlyMap<string, string>>;
  /**
   * Builds a backend for a scaler a config reload adds. Both hosts supply it
   * from the shared backend factory, so a reload builds only what startup
   * exercises. When omitted (unit tests), a reload that adds a scaler is
   * rejected rather than silently ignored.
   *
   * `config` is the reloaded config, not the boot-time one: the factory reads
   * `defaults.resources` and the `firecracker` network block off it, and a
   * stale one would allocate IPs from the old CIDR and attach TAPs to the old
   * bridge, silently unreachable.
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
   * Consecutive provisioning failures per scaler NAME, and the deferral they
   * earned: an event provision that never registered an agent, or a local
   * launch that produced none (refused, or the agent stopped before
   * registering).
   *
   * Keyed by name, not backend type, so one failing scaler never defers an
   * unrelated one: two event scalers often drive two different providers.
   *
   * In-memory and leader-local, like `ScalerFailureTracker`: a restart resets
   * it, the conservative direction (a fresh coordinator retries once at once
   * rather than inheriting a deferral it never observed).
   */
  private readonly provisionFailures = new Map<string, ProvisionFailureState>();
  private readonly resolveProvisionBackoff: () => Promise<ProvisionBackoffSettings>;
  private readonly readJobStatuses?: ScalerManagerDeps['readJobStatuses'];
  private globalMaxAgents: number;
  /**
   * Each configured scaler's entry as last applied, in `stableJson` form. A
   * reload compares against it to report which kept scalers it updated; the
   * backends cannot answer that, since most of them keep no copy of their entry.
   */
  private readonly appliedEntries = new Map<string, string>();

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

  /** Agents spawned but not yet registered via WS, keyed by pre-generated agentId. */
  private readonly spawningAgents = new Map<string, SpawningEntry>();

  /** Registered agentId → backendName, for lifecycle events. */
  private readonly managedAgentIndex = new Map<string, string>();

  /**
   * Agents this instance pre-spawned to wait for work rather than for a queued
   * job. This is provenance, not readiness: the agent registry cannot derive it,
   * and the spawning entry that carries it is deleted at registration. Only the
   * reaper reads it, so it destroys agents the pool created, never one that
   * registered for a bound job whose dispatch has not arrived.
   */
  private readonly warmAgents = new Set<string>();

  /**
   * Registered agents this instance started for a queued job, keyed by agent
   * id. The spawning entry is deleted at registration, so {@link agentView}
   * reads the binding here: the agent always runs its own job, and one started
   * inside a job's image runs nothing else.
   */
  private readonly boundAgents = new Map<string, AgentBinding>();
  /** Jobs a `requestScale` call is provisioning right now, before its spawning entry exists. */
  private readonly jobsBeingProvisioned = new Set<string>();

  /**
   * Warm agents whose destroy is issued but not settled. Until it resolves the
   * agent stays in `warmAgents` and `listIdle`, so the next reap pass (30 s
   * later, or a reload lowering the target) would hand the backend a second
   * destroy and count another `kici_orch_scaler_warm_pool_reaped_total`.
   * Cleared when the destroy settles either way.
   */
  private readonly warmDestroying = new Set<string>();

  /** Agents this instance adopted from another instance's spawn record. */
  private readonly adoptedAgents = new Map<string, AdoptedSpec>();

  /** Log forwarders for scaler-managed agents (container/bare-metal), keyed by agentId. */
  private readonly logForwarders = new Map<string, AgentLogForwarder>();

  /** agentId → { runId, jobId }, set by correlateAgentToJob() after dispatch. */
  private readonly agentJobCorrelation = new Map<string, { runId: string; jobId: string }>();

  /** Events emitted before job correlation, by agentId; flushed by correlateAgentToJob(). */
  private readonly eventBuffer = new Map<string, ScalerEvent[]>();

  /** Relays correlated scaler events (e.g. to the execution tracker). */
  private readonly onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void;

  /** Coordinator drain predicate; when true, requestScale() no-ops (no fresh
   *  agents spawned for the held Pending backlog). Defaults to never-draining. */
  private readonly isDraining: () => boolean;

  /**
   * Fired (debounced) when scaler capacity frees: a reservation released on
   * disconnect, a failed spawn, or a managed agent finishing its job. Wired to
   * the dispatcher's capacity-freed re-drive, so `at-capacity` jobs are
   * re-offered the moment a slot opens instead of pending until timeout.
   * Assigned after construction: the dispatcher is built after the manager.
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
   * DB-backed state store. When wired (production), every mutation to
   * `spawningAgents` / `agentJobCorrelation` / `reservations` writes through
   * to Postgres, so a coordinator crash mid-spawn does not orphan agents,
   * strand reservations or lose correlation. Unit tests omit it.
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
    this.readJobStatuses = deps.readJobStatuses;
    this.isDraining = deps.isDraining ?? (() => false);
    this.globalResourceCap = deps.config.globalResourceCap;
    this.createBackend = deps.createBackend;
    this.agentRegistry = deps.agentRegistry;
    this.machineLedgerOptions = deps.machineLedger;

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

    for (const entry of deps.config.scalers) {
      this.appliedEntries.set(entry.name, stableJson(entry));
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
    }

    for (const { name, backend } of deps.backends) {
      this.backends.set(name, backend);
    }

    this.warmPoolCallbacks = {
      onSpawnRequest: (labelSet: string[], backendName: string) =>
        this.spawnWarmAgent(labelSet, backendName),
      onDestroyRequest: async (managedId: string, backendName: string) => {
        const backend = this.backends.get(backendName);
        if (!backend) return;

        // The agent stays in `listIdle` until this destroy settles, so a teardown
        // slower than one 30s tick is asked for again; drop the repeat (see
        // `warmDestroying`).
        if (this.warmDestroying.has(managedId)) return;
        this.warmDestroying.add(managedId);

        // Condemn the agent BEFORE the destroy. The registry entry survives until
        // the WebSocket closes, so through a container `stop({ t: 5 })` or a
        // Firecracker `SendCtrlAltDel` plus grace, `findAvailable` would return
        // it and a webhook in that window would land on an exiting agent as a
        // spurious infrastructure error.
        //
        // The returned count closes the other direction: `listIdle` read
        // `activeJobs` a tick earlier. Re-reading it under the mark makes
        // check-then-destroy safe, since no job can be claimed after the mark.
        const activeAtMark = this.agentRegistry?.markDraining(managedId);
        if (activeAtMark !== undefined && activeAtMark > 0) {
          logger.info(
            `Warm pool destroy skipped for ${managedId}: a job was claimed since the ` +
              'idle check; it will be reconsidered on the next tick',
          );
          this.agentRegistry?.clearDraining(managedId);
          this.warmDestroying.delete(managedId);
          return;
        }

        incWarmPoolReaped(backendName);
        try {
          await backend.destroy(managedId);
          // As on the disconnect path, the durable row goes only once the
          // teardown resolved; otherwise every idle-reaped agent leaves a row
          // `recoverState` rehydrates on each restart and the stale-spawn prune
          // spares. A rejected destroy keeps the row.
          this.deleteSpawningAgentFromStore(managedId);
        } catch (err) {
          logger.error(`Warm pool destroy failed for ${managedId}: ${err}`);
        } finally {
          this.managedAgentIndex.delete(managedId);
          this.warmAgents.delete(managedId);
          this.warmDestroying.delete(managedId);
          // A rejected destroy leaves the agent alive and dispatchable again; on
          // success the entry is gone with the WebSocket and this is a no-op.
          this.agentRegistry?.clearDraining(managedId);
          // The idle reaper never goes through `onAgentDisconnected`, so a reaped
          // warm agent's reservation is freed here; `releaseAll` is idempotent.
          //
          // In the `finally`, so a REJECTED destroy releases too: the agent is
          // already forgotten above, and a reservation nothing tracks would hold
          // cpu and memory against `resourceCap`, `globalResourceCap` and the
          // pool ledger for the process lifetime (the permanent cap leak
          // `pruneStaleSpawningEntries` describes). The durable row survives a
          // rejected destroy, because the reaper retries the teardown from it.
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

    for (const entry of deps.config.scalers) {
      if (!entry.warmPool?.enabled) continue;
      for (const ls of entry.labelSets) {
        // The readiness query carries the pool's taints, because its gate
        // demands them (see `warmPoolLabelSetFillable`). The spawn request does
        // NOT: a backend matches the requested set against its own `labelSets`
        // and rejects anything else. The type comes from the config entry, not a
        // backend lookup, for symmetry with the reload path.
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
   * Pre-spawn one warm agent for a pool's label set: `requestScale` with no
   * job term (no bound job, no run, resources from the label set then the
   * scaler defaults). It reserves through the same {@link reserveForSpawn}: a
   * warm agent occupies the same cpu and memory, and on an event backend claims
   * a cluster slot, so a pool cannot carry a scaler past `maxAgents` fleet-wide.
   *
   * A refused reservation reports a failed spawn to the pool, releasing its
   * in-flight slot so the deficit retries next tick instead of stalling.
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

    // Counted on admission, not request: a pool held at a cap re-asks every
    // tick, and counting refusals would climb with no agent starting.
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
      // Same per-backend throttle as on-demand spawns: a cold pool fill must
      // not storm the backend socket either.
      await this.spawnSemaphoreFor(backendName).run(() => {
        const entry = this.spawningAgents.get(agentId);
        if (entry) entry.spawnStartedAt = Date.now();
        // No bound job/org, so the cluster default spawn deadline applies.
        return this.runSpawnWithTimeout(undefined, (signal) =>
          backend.spawn(
            labelSet,
            agentId,
            this.getOrchestratorUrl(backendName),
            onEvent,
            // The limits a job-bound spawn of this label set would carry: the
            // shape just reserved and that the shape check matches jobs
            // against, fixed when the agent starts.
            spawnLimitsFor(effective.limits),
            // No job/run identity, but the pool's taints must reach the agent,
            // or the pool's readiness query never counts what it spawned. The
            // gate is the one `persistSpawningAgent` records for this set.
            {
              platformTaints: this.platformTaintsFor(backendName, backend.type),
              mandatoryLabels: this.mandatoryGate(backendName, backend),
            },
            signal,
          ),
        );
      });
      // The spawning entry and durable row survive a successful spawn, as on
      // the job-bound path: `spawn()` resolves when the compute starts, before
      // the agent registers, and `onAgentRegistered` correlates against the
      // entry. Without it a warm agent registers looking static: not
      // scaler-managed, not gated by the pool's mandatory labels, not torn down
      // on disconnect. `pruneStaleSpawningEntries` reaps an entry whose agent
      // never shows up.
      if (this.onSpawnSettled(agentId, backend)) this.startLogForwarding(backend, agentId);
    } catch (err) {
      this.spawningAgents.delete(agentId);
      this.deleteSpawningAgentFromStore(agentId);
      if (isDeterministicSpawnError(err)) this.deferRefusedLaunch(backendName, agentId);
      else this.releaseAll(agentId);
      this.warmPool.onWarmSpawnFailed(labelSet);
      logger.error(
        `Warm pool spawn failed for backend ${backendName}: ${err}`,
        spawnFailureFields(err),
      );
    }
  }

  /**
   * Whether a warm pool for this label set can count its own agents.
   *
   * Readiness is `AgentRegistry.findAvailable(labels)`, which drops an agent
   * unless its whole `mandatoryLabels` gate appears in the query. The gate is
   * `mandatoryGate()` (configured gate ∪ platform taints), and
   * `warmPoolQueryLabels` puts the taints into the query by construction.
   *
   * The residual case is a configured `mandatoryLabels` entry absent from the
   * label set, which `scaler/config.ts` validation already rejects. This check
   * is the fail-safe: such a pool would spawn to `maxAgents` with `ready` stuck
   * at 0, starving the on-demand spawns sharing the cap. A refused pool is
   * inert, never partially filled.
   *
   * The gate is compared against `queryLabels`: against `declaredLabels` alone
   * it would refuse every structurally-tainted pool.
   */
  private warmPoolLabelSetFillable(
    scalerName: string,
    declaredLabels: string[],
    queryLabels: string[],
  ): boolean {
    const backend = this.backends.get(scalerName);
    if (!backend) return false;
    const gate = this.mandatoryGate(scalerName, backend);
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

  /** Whether this scaler pre-spawned (warm-filled) the agent. */
  isPrespawnedAgent(agentId: string): boolean {
    return this.warmAgents.has(agentId);
  }

  /** Every local Firecracker backend, under its scaler name. */
  private firecrackerBackends(): NamedLiveVmBackend[] {
    return [...this.backends]
      .filter(([, backend]) => backend.type === ScalerBackendType.enum.firecracker)
      .map(([name, backend]) => [name, backend as unknown as LiveVmBackend] as const);
  }

  /** The names of this node's Firecracker scalers. */
  firecrackerScalerNames(): string[] {
    return this.firecrackerBackends().map(([name]) => name);
  }

  /**
   * What on this node tracks `vmId`. Synchronous on purpose: the Firecracker
   * stop calls it in the same tick as its kill, so it must not await.
   *
   * Every local Firecracker backend is asked, so two scalers sharing a chroot
   * base never see each other's VMs as orphans. `spawningAgents` includes the
   * entries `recoverState` rehydrated after a restart, which no backend tracks.
   */
  trackersOf(vmId: string): ScalerVmTracker[] {
    const trackers: ScalerVmTracker[] = [];
    if (this.firecrackerBackends().some(([, backend]) => backend.isTrackingVm(vmId))) {
      trackers.push(ScalerVmTracker.enum.backend);
    }
    if (this.spawningAgents.has(vmId)) trackers.push(ScalerVmTracker.enum.spawning);
    if (this.managedAgentIndex.has(vmId) || this.adoptedAgents.has(vmId)) {
      trackers.push(ScalerVmTracker.enum.registered);
    }
    return trackers;
  }

  /** Every live Firecracker VM on this host, classified against what tracks it. */
  listLiveVms(): Promise<ScalerLiveVm[]> {
    return listClassifiedLiveVms(this.firecrackerBackends(), (vmId) => this.trackersOf(vmId));
  }

  /**
   * Stop the approved VMs one at a time. Each stop re-checks {@link trackersOf}
   * in the tick of its kill, so a VM that became tracked since the listing is
   * refused, never signalled.
   */
  stopUntrackedVms(vmIds: readonly string[]): Promise<ScalerVmStopResult[]> {
    return stopLiveVms(this.firecrackerBackends(), vmIds, (vmId) => this.trackersOf(vmId));
  }

  /**
   * What this scaler knows about an agent it started, for `canAgentRunJob`,
   * or undefined for an agent it did not start.
   */
  agentView(agentId: string): ScalerAgentView | undefined {
    if (!this.managedAgentIndex.has(agentId)) return undefined;
    const binding = this.boundAgents.get(agentId);
    return {
      ...(binding ? { binding: { ...binding } } : {}),
      prespawned: this.isPrespawnedAgent(agentId),
      shapeFits: (resources) => this.prespawnedShapeFits(agentId, resources),
    };
  }

  /**
   * Whether a pre-spawned (warm) agent's shape fits the shape a job declares.
   *
   * A warm agent starts before the job exists, at the pool's declared shape,
   * and nothing in the agent reads a job's `resources` afterwards. So a job
   * needing another shape gets its own agent instead of silently running with
   * the pool's. True for any agent this scaler did not pre-spawn: a job-bound
   * agent started at its job's shape.
   *
   * Only fields the job declares are compared: `resolveEffective` layers the
   * job over the label set and scaler defaults field by field, so an omitted
   * field already matches the warm agent's reservation.
   *
   * A declared field must match exactly. A bigger agent is not a superset:
   * limits are kernel-enforced, so a job capped at 2 cpus on an agent started
   * at 4 runs uncapped, so `>=` is not a safe relaxation.
   *
   * Both `requests` (billed against the caps) and `limits` (kernel-enforced)
   * are compared: a declaration may set them apart, so matching `requests`
   * alone can land a job on an agent capped elsewhere.
   */
  private prespawnedShapeFits(agentId: string, resources: ResourceRequest | undefined): boolean {
    if (!this.isPrespawnedAgent(agentId)) return true;

    const wanted = mirrorRequestsLimits(resources);
    if (!wanted) return true;

    // Deliberate fail-open: with no reservation this cannot be told, and
    // blocking dispatch on missing information strands jobs.
    const reservation = this.reservations.get(agentId);
    if (!reservation) return true;

    // BOTH sides: the schema enforces only `requests <= limits`, so they can
    // differ (see the JSDoc).
    if (!this.shapeSideMatches(wanted.requests, reservation.requests)) return false;
    // A reservation rehydrated after a restart has no in-memory `limits`:
    // fail open on this dimension alone.
    return this.shapeSideMatches(wanted.limits, reservation.limits);
  }

  /**
   * Whether one side (`requests` or `limits`) of a job's declared shape leaves
   * the agent's resolved side unchanged. Fails open (true) when the job declares
   * nothing on this side or `resolved` is absent, rather than strand a job.
   */
  private shapeSideMatches(
    declared: ResourceSpec | undefined,
    resolved: { cpus: number; memBytes: number } | undefined,
  ): boolean {
    if (!declared || !resolved) return true;
    if (declared.cpus !== undefined && declared.cpus !== resolved.cpus) return false;
    if (declared.memory === undefined) return true;
    // An unparseable memory string is also "cannot tell": this runs on the
    // dispatch path, and throwing would fail a dispatch that a malformed
    // declaration otherwise fails only at spawn time.
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
   * A warm agent's cpu and memory come only from the label set (or the scaler
   * defaults) and are fixed at start, so an undeclared shape reserves a guess
   * no job can be tested against. Refusing is the fail-safe, and on a cloud
   * backend it is what lets an operator reason about instance size and cost.
   * Limits alone count: `resolveEffective` mirrors limits into requests. A
   * refused pool is inert, never partially filled.
   *
   * An unresolvable declaration is refused the same way and must never throw:
   * the schema types `resources.*.memory` as a plain string, so a value such as
   * `4Gi` reaches `parseMemoryString` and is rejected. This runs in the
   * constructor and in {@link reload}'s commit block, where an exception would
   * abort startup or leave a half-applied config.
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
   * The warm pool clamps its deficit to this, so a pool at a count cap asks for
   * nothing rather than `size` spawns every tick. Cpu/memory caps are not seen
   * here: {@link reserveForSpawn} refuses those under the reservation lock, at
   * the cost of a log line and a `spawn_refusals` increment per tick.
   *
   * A best-effort read, not a reservation: {@link reserveForSpawn} re-checks both
   * count caps under the lock. For a local backend (container, bare-metal,
   * Firecracker) `getActiveCount()` is the whole population, so the room is
   * exact. An **event** backend is capped cluster-wide (a spawn row claimed
   * under `withScalerCapLock`) while `getActiveCount()` sees only this
   * coordinator's provisions, so the room here may count slots a peer holds;
   * the claim, not this clamp, enforces the cluster-wide cap.
   */
  private warmCapacityRemaining(backendName: string): number {
    const backend = this.backends.get(backendName);
    if (!backend) return 0;
    const globalRoom = this.globalMaxAgents - this.getGlobalActiveCount();
    const backendRoom = backend.maxAgents - backend.getActiveCount();
    return Math.max(0, Math.min(globalRoom, backendRoom));
  }

  /**
   * Publish the warm-pool gauges. Called after each pool tick and after a
   * reload, so a newly configured target shows immediately.
   */
  private publishWarmPoolGauges(): void {
    setWarmPoolGauges(
      this.warmPool.getStats().map((row) => ({
        scaler: row.backendName,
        // The pool's own key, never the widened query set: two label sets on one
        // scaler can widen to the same query (one declaring the plain platform
        // label the other gets from the taint), collapsing into one series where
        // the later row hides a whole pool's fill state.
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
   * Resolve the pool's platform for label + taint derivation. Precedence:
   *   1. A declared `platform` field always wins (even on a linux host).
   *   2. Otherwise a bare-metal pool derives it from the host OS/arch.
   *   3. Otherwise (container / firecracker) null: linux agents, not
   *      auto-tainted unless a platform is declared.
   * Also null for a bare-metal host whose OS/arch is not a supported enum value
   * (the caller falls back to raw host labels).
   */
  private resolveScalerPlatform(name: string, backendType: string): ScalerPlatform | null {
    const declared = this.scalerPlatform.get(name);
    if (declared) return declared;
    if (backendType === 'bare-metal') return hostToScalerPlatform(os.platform(), os.arch());
    return null;
  }

  /**
   * The plain platform-taint tokens (`windows`, `macos`, `arm64`) for a scaler,
   * derived from the same resolved platform `mandatoryGate` gates on.
   *
   * The single source for the taint: the matcher's label sets, the taint gate,
   * the agent's registered labels and the warm-pool readiness query. Deriving it
   * elsewhere (in a backend, say) lets the gate and the agent's labels disagree,
   * so a tainted pool spawns agents `AgentRegistry.findAvailable` never returns.
   *
   * `backendType` is passed, not looked up: the constructor configures warm
   * pools from config entries whose backend may not be indexed.
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
   * `mandatoryLabels` gate (taints included) appears in the query, so declared
   * labels alone count none of the pool's agents and it fills to `maxAgents`
   * with `ready` stuck at 0. The constructor and the reload path both call this
   * so they never diverge.
   *
   * QUERY only. The pool is keyed by, and spawns with, the DECLARED set: a
   * backend resolves its image / binary / VM config by matching its own
   * `labelSets` and throws on any other set, and every in-flight release path
   * normalizes the spawn labels back to the map key.
   */
  private warmPoolQueryLabels(name: string, backendType: string, labels: string[]): string[] {
    return [...new Set([...labels, ...this.platformTaintsFor(name, backendType)])];
  }

  /**
   * Taint gate for a scaler's label sets: the configured `mandatoryLabels` plus
   * the platform taints derived from the pool's resolved structured platform.
   *
   * Every routing and stamping decision uses it. `backend` needs only `type`,
   * so a caller holding one label set never reaches for the whole backend.
   */
  private mandatoryGate(name: string, backend: { type: string }): string[] {
    const config = this.scalerMandatoryLabels.get(name) ?? [];
    const structuredTaints = this.platformTaintsFor(name, backend.type);
    return [...new Set([...config, ...structuredTaints])];
  }

  /**
   * Scaler entries with the auto-labels agents receive at spawn (kici:role:*,
   * kici:os:*, kici:arch:*, kici:agent:*, kici:scaler:*) injected into each
   * label set, so label matching accounts for them.
   *
   * os/arch derive from the resolved structured platform, and the mandatory
   * labels combine the config gate with the platform taint, so the matcher
   * applies the gate alongside subset matching. Retiring scalers are skipped:
   * they take no new work while their remaining agents finish.
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
        // The plain taint tokens (`windows`, `macos`, `arm64`) are matchable
        // labels too, so a job requesting the platform routes here without a
        // declared plain label: the structured field is the single source for
        // the taint gate AND the label that satisfies it.
        const platformTokens = resolved ? platformToTaints(resolved) : [];
        const autoLabels = [
          ...osArchLabels,
          ...platformTokens,
          agentTypeLabel(backend.type),
          scalerLabel(name),
          ...roleLabels,
          // Agent-feature labels this build self-reports at registration, so a
          // job routed by one (a global eval round that must skip result-aware
          // generators) matches a pool that can serve it.
          ...AGENT_FEATURE_LABELS,
        ];

        return {
          name,
          labelSets: backend.labelSets.map((ls) => ({
            ...ls,
            labels: [...new Set([...ls.labels, ...autoLabels])],
          })),
          // Index-aligned with `labelSets`: both map `backend.labelSets` in order.
          labelSetMandatoryLabels: backend.labelSets.map(() => this.mandatoryGate(name, backend)),
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
    // An in-flight spawn holds a retirement open (below), and one that died
    // before registering never clears itself. Pruning here, not only on the
    // `requestScale` path a retiring scaler no longer takes, bounds that wait.
    this.pruneStaleSpawningEntries();

    for (const name of [...this.retiring]) {
      const backend = this.backends.get(name);
      if (!backend) {
        this.retiring.delete(name);
        this.retiredAt.delete(name);
        continue;
      }
      if (backend.getActiveCount() > 0) continue;
      // A spawn still queued behind the semaphore is invisible to the backend.
      // Tearing down on that zero would land a live agent on a backend nobody
      // holds: invisible to routing and `shutdownAll`, with no backend for
      // `onAgentDisconnected` to destroy it through, so it outlives the scaler.
      if (this.hasSpawnInFlight(name)) continue;

      // Forget the scaler BEFORE the await. Inside `shutdownAll`'s yield, a
      // second sweep (interval racing a disconnect) would shut it down twice,
      // and a `reload` re-adding the name would resurrect a backend this sweep
      // then forgets, leaving a configured scaler with none. Forgetting first
      // makes the transition atomic: a reload sees no backend and builds one.
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
   * nor failed, including one still queued behind the spawn semaphore. Such a
   * spawn holds the drain open though the backend reports no active agent.
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
   * Run one backend spawn under the resolved spawn deadline. On deadline it
   * aborts the signal (so the backend's container-runtime/HTTP calls cancel and
   * its own catch cleans up) AND rejects, so the caller's semaphore `run()`
   * releases the slot even if the backend's unwind stalls somewhere
   * non-abortable.
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
    // The deadline may win the race; a later abort-rejection must not surface
    // as an unhandled rejection.
    spawnPromise.catch(() => {});

    try {
      return await Promise.race([spawnPromise, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Main entry point: called by the Dispatcher when no agent is available.
   * `resources` is the per-job request/limit declaration (`undefined` falls
   * back to scaler defaults), billed against the per-scaler, per-orchestrator
   * and per-machine resource caps.
   */
  async requestScale(
    labels: string[],
    jobId: string,
    runId: string,
    excludeLabels: string[] = [],
    resources?: ResourceRequest,
    orgId?: string,
    /**
     * The job's resolved container image + registry credentials, when declared,
     * so the backend can spawn the job's own image instead of the pool's.
     */
    containerSpawn?: ResolvedContainerSpawn,
  ): Promise<ScaleResult> {
    // Draining: no fresh capacity for the held Pending backlog. In-flight jobs
    // finish; scale-down / idle reaping is untouched.
    if (this.isDraining()) {
      return { action: 'skipped', reason: 'draining' };
    }
    // One job, one provision. The pending-scale re-drive re-offers a job whose
    // agent is still provisioning or registered but unclaimed; a second agent
    // would sit idle (and, on an event scaler, bill). Checked and marked before
    // the first await, so two concurrent offers of one job cannot both pass.
    if (this.hasLocalProvisionFor(jobId)) {
      return { action: 'skipped', reason: PROVISION_IN_FLIGHT };
    }
    this.jobsBeingProvisioned.add(jobId);
    try {
      return await this.provisionForJob(
        labels,
        jobId,
        runId,
        excludeLabels,
        resources,
        orgId,
        containerSpawn,
      );
    } finally {
      this.jobsBeingProvisioned.delete(jobId);
    }
  }

  /** Whether this coordinator already provisions, or holds an agent bound to, `jobId`. */
  private hasLocalProvisionFor(jobId: string): boolean {
    if (this.jobsBeingProvisioned.has(jobId)) return true;
    for (const entry of this.spawningAgents.values()) if (entry.boundJobId === jobId) return true;
    for (const binding of this.boundAgents.values()) if (binding.jobId === jobId) return true;
    return false;
  }

  /** `requestScale` past its drain and per-job checks: match, reserve, spawn. */
  private async provisionForJob(
    labels: string[],
    jobId: string,
    runId: string,
    excludeLabels: string[],
    resources: ResourceRequest | undefined,
    orgId: string | undefined,
    containerSpawn: ResolvedContainerSpawn | undefined,
  ): Promise<ScaleResult> {
    // Agents that crashed before WS registration.
    this.pruneStaleSpawningEntries();

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

    // A repeatedly failing scaler is deferred. After the match, so the deferral
    // is scoped to that scaler; before the reservation, so a deferred request
    // takes no capacity.
    const deferred = await this.provisionBackoffRefusal(backendName);
    if (deferred) return deferred;

    // The warm pool is not consulted: `requestScale` runs only after the
    // dispatcher found no available agent, so no ready warm agent is left.

    const labelSetResources = backend.labelSets[match.labelSetIndex].resources;
    const effective = this.resolveEffective(backendName, labelSetResources, resources);

    // The agentId is minted before the check because the cluster-slot claim
    // writes the spawn row keyed by it; a refusal costs a discarded uuid.
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
      return reserve.provisionInFlight
        ? { action: 'skipped', reason: PROVISION_IN_FLIGHT }
        : { action: 'at-capacity' };
    }

    this.spawningAgents.set(agentId, {
      labelSet: spawnLabelSet,
      backendName,
      backendType: backend.type,
      provisioningTargets: this.scalerProvisioningTargets.get(backendName) ?? [],
      spawnedAt: Date.now(),
      boundJobId: jobId,
      runId,
      jobImage:
        containerSpawn !== undefined &&
        spawnsInJobImage(backend.type, backend.labelSets[match.labelSetIndex]),
    });
    // A claimed cluster slot already wrote this row inside the cap
    // transaction; re-writing it would reset `spawned_at`, which the reaper
    // ages every provision on.
    if (!reserve.slotClaimed)
      this.persistSpawningAgent(agentId, spawnLabelSet, backendName, jobId, runId);

    // Fire-and-forget spawn, throttled by the per-backend semaphore. The
    // reservation is already in `this.reservations` (what the count caps read),
    // so an agent queued in the semaphore still counts against
    // `globalMaxAgents` and `maxAgents`; the semaphore bounds only the rate.
    const orchestratorUrl = this.getOrchestratorUrl(backendName);
    const onEvent = this.createEventEmitter(agentId);
    const effectiveLimits = spawnLimitsFor(effective.limits);
    const spawnContext = {
      boundJobId: jobId,
      runId,
      platformTaints: this.platformTaintsFor(backendName, backend.type),
      mandatoryLabels: this.mandatoryGate(backendName, backend),
      ...(containerSpawn ? { container: containerSpawn } : {}),
    };
    // The spawn outlives this call, so it runs in its own request store holding
    // the bound job: the caller's store is mutated per dispatched run
    // (`enrichRequestContext`), and a later read would log whichever run came
    // last. The snapshot keeps the caller's routing key and trace ids.
    const callerContext = getRequestContext();
    const logContext = {
      ...callerContext,
      requestId: callerContext.requestId ?? randomUUID(),
      runId,
      jobId,
    };
    const ids = { agentId, scaler: backendName, runId, jobId };
    requestContext.run(logContext, () => {
      this.spawnSemaphoreFor(backendName)
        .run(() => {
          // Admitted past the throttle: start the "never registered" staleness
          // clock now, not at enqueue time.
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
            logger.info(`Agent ${agentId} spawned successfully via ${backendName}`, ids);
            if (this.onSpawnSettled(agentId, backend)) this.startLogForwarding(backend, agentId);
          },
          (err) => {
            this.spawningAgents.delete(agentId);
            this.deleteSpawningAgentFromStore(agentId);
            if (isDeterministicSpawnError(err)) this.deferRefusedLaunch(backendName, agentId);
            else this.releaseAll(agentId);
            logger.error(`Failed to spawn agent ${agentId} via ${backendName}: ${err}`, {
              ...ids,
              ...spawnFailureFields(err),
            });
          },
        );
    });

    return { action: 'spawning', backendType: backend.type, agentId };
  }

  /**
   * Take every reservation one spawn needs, or none. Shared by `requestScale`
   * and the warm pre-spawn (`boundJobId` `undefined`): a warm agent costs the
   * same host resources, so it takes the same reservations.
   *
   * Ordering, and why:
   * - Count caps and the in-memory resource reservation run under the
   *   in-process reservation lock, so check and reserve are atomic. A local
   *   backend counts its own host's agents in process (its compute is pinned
   *   here). An event backend's cloud instances can be started by any
   *   coordinator, so its cap is counted, and its slot claimed, cluster-wide in
   *   one advisory-locked transaction; the in-process lock stays the outer
   *   guard so the two never contend.
   * - The machine-pool ledger is taken outside that lock: it has its own
   *   cross-process mutex, and holding both buys nothing.
   *
   * Every refusal rolls back what it took, so `false` leaves no reservation.
   * On success the caller owns the release: `releaseAll(agentId)`.
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
  ): Promise<
    { reserved: false; provisionInFlight?: boolean } | { reserved: true; slotClaimed: boolean }
  > {
    const clusterCapped = backend.type === ScalerBackendType.enum.event && this.stateStore != null;
    let slotClaimed = false;
    const reserveOutcome = await this.runWithReservationLock(async () => {
      // Count caps read `Math.max(<backend's own count>, <reserved>)`: the spawn
      // fires AFTER this lock, so while it waits in the semaphore it is invisible
      // to `getActiveCount()`, and one `retryPendingScaleRequests` batch could
      // admit ten agents against a cap of one. `max`, not a sum: the two views
      // cover the same agents at different lifecycle points.
      if (Math.max(this.getGlobalActiveCount(), this.reservations.size) >= this.globalMaxAgents) {
        this.reportCountCapRefusal(backendName, backend);
        return 'at-capacity-count' as const;
      }
      if (
        !clusterCapped &&
        Math.max(backend.getActiveCount(), this.reservedCountForScaler(backendName)) >=
          backend.maxAgents
      ) {
        this.reportCountCapRefusal(backendName, backend);
        return 'at-capacity-count' as const;
      }
      if (!this.tryReserveAll(backendName, requests)) {
        return 'at-capacity-resource' as const;
      }
      if (clusterCapped) {
        const claim = await this.claimClusterSlot(
          agentId,
          spawnLabelSet,
          backendName,
          backend.maxAgents,
          boundJobId,
          runId,
        );
        if (claim !== ClusterSlotClaim.Claimed) {
          this.releaseInMemory(backendName, requests);
          return claim === ClusterSlotClaim.ProvisionInFlight
            ? ('provision-in-flight' as const)
            : ('at-capacity-count' as const);
        }
        slotClaimed = true;
      }
      // Record the admission INSIDE the critical section: `this.reservations`
      // is the set the count caps read, so a write outside the lock is a cap
      // that cannot see what it just granted.
      //
      // `limits` is in memory only: the caps bill `requests` (what
      // `persistReservation` stores and recovery needs); `limits` lets the
      // suitability predicate compare the kernel-enforced half of the shape.
      this.reservations.set(agentId, {
        scalerName: backendName,
        requests: { ...requests },
        limits: { ...limits },
      });
      return 'reserved' as const;
    });
    if (reserveOutcome === 'provision-in-flight')
      return { reserved: false, provisionInFlight: true };
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
        // Roll back the in-memory reservation and the cluster-wide slot: an
        // unreleased spawn row counts against every coordinator's cap for an
        // agent that never spawned.
        this.releaseInMemory(backendName, requests);
        this.reservations.delete(agentId);
        if (slotClaimed) this.deleteSpawningAgentFromStore(agentId);
        return { reserved: false };
      }
    }

    this.persistReservation(agentId, backendName, requests);
    return { reserved: true, slotClaimed };
  }

  /**
   * Record a refusal on one of the two agent-count caps.
   *
   * The dispatcher gets `at-capacity`, which queues the job and logs nothing,
   * indistinguishable from a scaler that stopped spawning. So the counter the
   * metric's help text promises (`maxAgents`, `globalMaxAgents`) is
   * incremented here, beside the resource caps.
   *
   * The warning is narrower on purpose: ordinary saturation would warn per
   * queued job while busy. It fires only when the reservation ledger outruns
   * every backend's active count: capacity billed to agents not running, which
   * does not resolve on its own.
   */
  private reportCountCapRefusal(scalerName: string, backend: ScalerBackend): void {
    incScalerSpawnRefusals();
    const globalActive = this.getGlobalActiveCount();
    if (this.reservations.size <= globalActive) return;
    logger.warn('scaler: refused a spawn on reserved capacity no running agent accounts for', {
      scalerName,
      reservations: this.reservations.size,
      globalActiveCount: globalActive,
      globalMaxAgents: this.globalMaxAgents,
      scalerReservations: this.reservedCountForScaler(scalerName),
      scalerActiveCount: backend.getActiveCount(),
      scalerMaxAgents: backend.maxAgents,
    });
  }

  /**
   * Reservations one scaler holds, derived from `this.reservations` rather than
   * a separate counter: the map IS the admitted set, so the count cannot drift,
   * even on the boot/leader-switch rehydrate path that repopulates the map.
   */
  private reservedCountForScaler(scalerName: string): number {
    let n = 0;
    for (const entry of this.reservations.values()) {
      if (entry.scalerName === scalerName) n++;
    }
    return n;
  }

  /** Serializes concurrent `requestScale()` calls so check+reserve is atomic. */
  private async runWithReservationLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.reservationLock;
    let release!: () => void;
    this.reservationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      // `return await`, not a bare `return`: the finally runs at the return
      // statement, before the promise settles, so a bare return would release
      // the lock at the critical section's first await (as the event-scaler cap
      // check's database call does) and admit two callers at once.
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Lazily resolve the per-backend spawn throttle, sized by `maxConcurrentSpawns`
   * (else the cluster default). One per backend: each has its own container socket.
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
   * Layered per field, highest priority first:
   * 1. Job's own `resources` (after request<->limit mirroring).
   * 2. Label-set's `resources`.
   * 3. Scaler's `defaults.resources` (already merged from global defaults at construction).
   * 4. Zero.
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
   * Reserve `requests` against the per-scaler and per-orchestrator caps, or
   * return false with no state change. Caller must hold the reservation lock.
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
   * Push the `perScalerUsage` / `globalUsage` snapshot into the observable
   * gauges on every reservation / release. Gauge callbacks are synchronous and
   * MUST NOT touch this map; they read whatever was last published.
   *
   * Pool-level usage is deliberately not emitted: reading the on-disk ledger
   * needs async I/O + a file lock, and OTel gauge callbacks are synchronous. A
   * lower bound is the sum of `kici_orch_scaler_cpus_used` over the pool's
   * scalers.
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
   * Release an agent's reservation, and (best-effort) its cross-process pool
   * reservation. Idempotent.
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

    // Re-drive pending jobs. This one site covers the spawn-failure and every
    // onAgentDisconnected release.
    this.notifyCapacityFreed();
  }

  /**
   * Signal that scaler capacity freed. Trailing-debounced by
   * {@link CAPACITY_FREED_DEBOUNCE_MS} so a burst of releases (and a single-use
   * agent's onJobComplete → onAgentDisconnect pair) coalesces into one re-drive
   * after the last release. The timer is `unref`'d and cleared on shutdown.
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
   * Subtract `requests` from the per-scaler and global in-memory counters; used
   * by `releaseAll()` and by rollbacks after the in-memory reservation succeeded.
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
   * Resolve a scaler's default resources. Scaler entries carry no `defaults` of
   * their own (label sets do), so this is the global `defaults.resources`;
   * storing it per scaler leaves room for scaler-level defaults.
   */
  private resolveScalerDefaults(
    config: ScalerConfig,
    _entry: ScalerEntry,
  ): ResourceRequest | undefined {
    return config.defaults?.resources;
  }

  /**
   * Called from agent-handler.ts when an agent registers via WS; correlates it to
   * its spawning entry.
   *
   * Returns:
   * - `boundJobId` (optional): the queued job this agent was spawned for, which
   *   the caller dispatches eagerly before the idle timer fires, skipping the
   *   generic queue drain race.
   * - `mandatoryLabels` (always set for scaler-managed agents): the scaler's
   *   effective gate (configured labels plus the platform taint). Threaded into
   *   the AgentRegistry so both the queue-drain path (`onAgentAvailable` →
   *   `dequeueForLabels`) and the eager-dispatch path (`dispatchBoundJob` →
   *   `dequeueById`) reject jobs whose `runsOn` lacks a gate label.
   *
   * Returns `null` for a static agent: no spawning entry and no peer spawn
   * record. A warm-pool spawn keeps its entry (and durable row) until it
   * registers, so it resolves with `mandatoryLabels` and no `boundJobId`, which
   * marks the agent warm on `register.ack`.
   *
   * A local hit is answered from memory; a miss falls back to the shared spawn
   * record, since on an HA cluster behind one endpoint the agent routinely
   * reaches an instance that did not spawn it. Adoption is a conditional
   * UPDATE, so exactly one instance wins.
   */
  async onAgentRegistered(
    agentId: string,
    labels: string[],
  ): Promise<{ boundJobId?: string; mandatoryLabels: string[] } | null> {
    const spawning = this.spawningAgents.get(agentId);
    if (spawning) return this.completeLocalRegistration(agentId, labels, spawning);

    if (!this.stateStore) {
      // A store-less manager (worker mode) loses its spawn records on restart,
      // so this miss is the `!adopted` case below and needs the same answer, or
      // a worker restart hands every running scaler agent back as static with no
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
      // A store error says nothing about whether the agent is scaler-managed,
      // and the wrong answers are asymmetric: registering a scaler agent as
      // static drops its `mandatoryLabels` gate for life (letting a job lacking
      // the platform taint land on the wrong OS); refusing a static agent costs
      // a reconnect.
      //
      // The id discriminates: `generateAgentId` mints every scaler id as
      // `scaler-<type>-<uuid>`, and an event agent cannot present another
      // because its ephemeral token is minted against the claim keyed by it.
      if (agentId.startsWith(SCALER_AGENT_ID_PREFIX)) {
        logger.error(
          'scaler: adoption lookup failed; refusing to register a scaler-managed agent',
          {
            agentId,
            error: toErrorMessage(err),
          },
        );
        // Deliberately NOT reclaimed, unlike the clean "no such record"
        // branches: a failed read is not evidence the agent is unowned, and
        // reclaiming would destroy a healthy provision over a DB hiccup. The
        // agent reconnects and the next read decides.
        throw new ScalerAdoptionLookupError(agentId, err);
      }
      logger.error('scaler: adoption lookup failed; treating agent as static', {
        agentId,
        error: toErrorMessage(err),
      });
      return null;
    }
    if (!adopted) {
      // Same asymmetry and id discriminator as the lookup-error branch above.
      // `completeLocalRegistration` deletes a local-backend spawn row at
      // registration, so after an orchestrator restart a running scaler agent
      // has no row to adopt. Refusing leaves it retrying with backoff and no
      // work, and `reclaimUnownedScalerAgent` takes its compute back through
      // each backend's `reapUnowned`: the container backend removes the
      // container by its `kici-agent-id` label, the Firecracker backend kills a
      // VM whose jailer chroot is on this host, and the bare-metal backend
      // removes its agent's container by the same labels. A bare-metal agent
      // running as a plain process stays: its PID lives only in memory, so it
      // holds its host process until an operator stops it. A refused agent never
      // arms its idle-shutdown timer, which arms only on a successful
      // registration.
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
    // An adopted agent IS a successful provision; counting only local
    // registrations would leave a healthy scaler deferred on an HA cluster.
    this.clearProvisionFailures(adopted.scalerName);
    // As on the local path: no bound job means a warm fill, the only reapable kind.
    if (adopted.boundJobId == null) {
      this.warmAgents.add(agentId);
    } else {
      // Adoption takes event rows only, and an event spawn never starts inside
      // the job's image (`spawnsInJobImage`).
      this.boundAgents.set(agentId, { jobId: adopted.boundJobId, jobImage: false });
    }
    this.adoptedAgents.set(agentId, {
      scalerName: adopted.scalerName,
      provisioningTargets: adopted.provisioningTargets ?? [],
    });

    // Seed the local backend's agent map when the scaler is configured here, or
    // `EventScalerBackend.destroy()` returns early on the unknown id and the VM
    // leaks.
    const backend = this.backends.get(adopted.scalerName);
    if (backend instanceof EventScalerBackend) {
      backend.adopt(agentId, adopted.labelSet);
    }

    logger.info(`Adopted spawned agent ${agentId} from instance ${adopted.ownerInstanceId}`, {
      scalerName: adopted.scalerName,
      boundJobId: adopted.boundJobId,
    });

    // The taint comes from the persisted spawn record, not local config: this
    // coordinator may not configure the scaler, and an un-stamped gate lets a
    // wrong-OS job land on the agent.
    const mandatoryLabels = adopted.mandatoryLabels ?? [];
    return adopted.boundJobId
      ? { boundJobId: adopted.boundJobId, mandatoryLabels: [...mandatoryLabels] }
      : { mandatoryLabels: [...mandatoryLabels] };
  }

  /**
   * Reclaim the host-local compute of a scaler-spawned agent refused for want of
   * a spawn record.
   *
   * Refusing closes the WS before registration completes, and
   * `managedAgentIndex` is only populated after this point, so the disconnect
   * hook takes the static-agent exit. Without this the agent keeps its VM or
   * host process and loops reconnect-refuse until an operator stops it.
   *
   * **This force-destroys a live instance, so read what makes it safe.**
   *
   * - **Local backends only.** `adoptSpawningAgent` resolves `null` both when no
   *   row exists AND when a peer already holds it, so a live event agent owned
   *   elsewhere reaches this branch; tearing down its cloud instance would
   *   destroy a peer's healthy provision. Local compute lives on the host that
   *   spawned it.
   * - **Host-local evidence decides, not this verdict.** `adoptSpawningAgent`
   *   adopts `event` rows only, so a `container` / `bare-metal` / `firecracker`
   *   agent reconnecting to a peer behind a shared endpoint is refused here with
   *   its row intact and compute alive on the peer's host. Each backend reclaims
   *   only what its own tracking or on-host artifacts name, never a shared
   *   database row (which on an HA pair names an identically-configured scaler
   *   on both hosts), so a wrongly-routed id touches nothing.
   * - **Never on a transient failure.** The caller must have positive evidence
   *   the agent is unowned; a store read that merely *failed* is not evidence.
   *
   * Fire-and-forget, like `onAgentDisconnected`'s teardown: the registration is
   * refused immediately rather than holding the socket open for a VM shutdown.
   */
  private reclaimUnownedScalerAgent(agentId: string): void {
    for (const [backendName, backend] of this.backends) {
      if (backend.type === ScalerBackendType.enum.event) continue;
      void (async () => {
        // In-memory first: if still tracked, `destroy` holds its live TAP and IP
        // and is the complete teardown.
        await backend.destroy(agentId);
        // Then the durable on-host artifacts that survive a restart; `destroy`
        // already missed in memory, so this cannot double-reclaim.
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

  /** Finish registration for an agent this instance spawned, from its spawning entry. */
  private completeLocalRegistration(
    agentId: string,
    labels: string[],
    spawning: SpawningEntry,
  ): { boundJobId?: string; mandatoryLabels: string[] } {
    // Capture warm-vs-bound now: the spawning entry, the only carrier of that
    // fact, is deleted below.
    if (spawning.boundJobId == null) {
      this.warmAgents.add(agentId);
    } else {
      this.boundAgents.set(agentId, {
        jobId: spawning.boundJobId,
        jobImage: spawning.jobImage === true,
      });
    }

    // The durable row's fate depends on the backend.
    this.spawningAgents.delete(agentId);

    const backend = this.backends.get(spawning.backendName);
    backend?.markRegistered?.(agentId);
    if (backend?.type === ScalerBackendType.enum.event) {
      // Seed the backend's agent map as adoption does. Usually `spawn()` did
      // and `adopt()` no-ops, but an entry `recoverState` rehydrated has no
      // backend entry, so `destroy()` would return early and the `.then()`
      // delete the row with no `scale-down` emitted.
      if (backend instanceof EventScalerBackend) backend.adopt(agentId, spawning.labelSet);
      // An event agent's row is the live ownership record: only a `scale-down`
      // tears its cloud instance down, and if this coordinator dies mid-job
      // the row is the only pointer left. Stamp it adopted here, so the reaper
      // reads the same shape as the cross-instance path produces. Local-backend
      // rows are deleted: their compute is pinned to this host, so the process
      // dying IS the teardown.
      this.markSpawningAgentAdopted(agentId);
      // Record the spawn-time targets as the cross-instance path does, so an
      // operator edit between spawn and teardown cannot retarget the
      // scale-down via live config.
      this.adoptedAgents.set(agentId, {
        scalerName: spawning.backendName,
        provisioningTargets: spawning.provisioningTargets,
      });
    } else {
      this.deleteSpawningAgentFromStore(agentId);
    }

    this.managedAgentIndex.set(agentId, spawning.backendName);
    // A live agent: the scaler is healthy again.
    this.clearProvisionFailures(spawning.backendName);

    // `mandatoryGate` (what the local matcher and cross-peer advertisement
    // apply) stamps a platform taint (windows/macos/arm64) on the agent, so
    // queue-drain and eager dispatch reject an unqualified wrong-OS job.
    const mandatoryLabels = backend
      ? this.mandatoryGate(spawning.backendName, backend)
      : (this.scalerMandatoryLabels.get(spawning.backendName) ?? []);

    logger.info(`Spawned agent ${agentId} registered, backend ${spawning.backendName}`, {
      boundJobId: spawning.boundJobId,
      mandatoryLabels,
    });

    // A warm fill: release its in-flight slot so the next deficit pass counts it
    // as ready. From here the registry holds it.
    if (!spawning.boundJobId) {
      this.warmPool.onWarmAgentRegistered(spawning.labelSet);
    }

    return spawning.boundJobId
      ? { boundJobId: spawning.boundJobId, mandatoryLabels: [...mandatoryLabels] }
      : { mandatoryLabels: [...mandatoryLabels] };
  }

  /**
   * Called from agent-handler.ts when an agent disconnects. `reason` is what an
   * event scaler's scale-down carries: `shutdown` for an ordinary disconnect,
   * `heartbeat-timeout` for an agent the orchestrator dropped without waiting
   * for its socket.
   */
  onAgentDisconnected(
    agentId: string,
    reason: ScaleDownReason = ScaleDownReason.enum.shutdown,
  ): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) {
      this.releaseAll(agentId);
      return;
    }

    const backend = this.backends.get(backendName);
    if (!backend) {
      // Adopted for a scaler not configured here: emit the teardown from the
      // persisted spawn spec, read before the map entry goes, or the cloud
      // instance is never torn down. Same reason as the backend path, so the
      // teardown workflow cannot tell which coordinator the agent reached.
      const adopted = this.adoptedAgents.get(agentId);
      if (adopted) {
        runDetached(
          logger,
          'Scale-down emit',
          () => this.emitScaleDownForSpec(adopted, agentId, reason),
          { agentId },
        );
      }
      this.managedAgentIndex.delete(agentId);
      this.warmAgents.delete(agentId);
      this.boundAgents.delete(agentId);
      this.adoptedAgents.delete(agentId);
      this.releaseAll(agentId);
      return;
    }

    // A scaler agent never outlives its connection: always destroy on disconnect. The durable row
    // goes only once the teardown resolved: an event row is the sole pointer to
    // a running cloud instance, and the reaper retries a failed teardown from
    // it. The teardown targets the spawn-recorded `provisioningTargets`, not
    // live config, which may differ or have been edited since.
    const heldSpec = this.adoptedAgents.get(agentId);
    const destroyContext = {
      reason,
      ...(heldSpec &&
        heldSpec.provisioningTargets.length > 0 && { targets: heldSpec.provisioningTargets }),
    };
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
    this.boundAgents.delete(agentId);
    this.adoptedAgents.delete(agentId);
    this.logForwarders.delete(agentId);
    this.agentJobCorrelation.delete(agentId);
    this.eventBuffer.delete(agentId);
    this.deleteAgentJobFromStore(agentId);
    this.releaseAll(agentId);

    // A retiring scaler may have lost its last agent. `destroy` is
    // fire-and-forget, so `getActiveCount()` may lag; the periodic sweep armed
    // in `start()` is the backstop.
    runDetached(logger, 'Retired backend sweep', () => this.sweepRetiredBackends());
  }

  /**
   * Tear down a stranded provision the `EventProvisionReaper` found.
   *
   * Public because the reaper is leader-gated and lives outside the manager,
   * while the emit and the row delete stay in one place. The reason is the
   * reaper's verdict (never registered → `spawn-timeout`, went away →
   * `heartbeat-timeout`), never a `shutdown` default.
   *
   * `kici_orch_scaler_external_provision_timeout_total` counts the spawn-timeout
   * arm, and nothing else increments it in production: an event backend's
   * `spawn()` returns once the scale-up is emitted, inside
   * `runSpawnWithTimeout`'s bound.
   *
   * The spawn-timeout arm is also where an external provisioning failure enters
   * the failure machinery. Local backends emit `scaler.failed` from `spawn()`;
   * an event scaler's `spawn()` always succeeds, so the failure shows only when
   * the provision never registers. Synthesizing the event here feeds the fleet
   * counter, `diagnose scaler` and `last_provisioning_error`, so the job
   * settles with the provisioning cause instead of a label-mismatch complaint
   * that sends its operator to fix a correct `runsOn`.
   */
  async emitOrphanScaleDown(candidate: ReapCandidate, reason: ScaleDownReason): Promise<void> {
    // A provision whose bound job already ended did not fail: tear it down as
    // `job-complete` (as the withdrawal sweep does) and report nothing.
    const withdrawn =
      reason === ScaleDownReason.enum['spawn-timeout'] &&
      candidate.boundJobId !== undefined &&
      (await this.boundJobEnded(candidate.runId, candidate.boundJobId));
    const effective = withdrawn ? ScaleDownReason.enum['job-complete'] : reason;
    if (withdrawn) {
      logger.info(
        'scaler: reaper found a stranded provision whose job already ended; tearing it down as job-complete',
        {
          agentId: candidate.agentId,
          scaler: candidate.scalerName,
          jobId: candidate.boundJobId,
          runId: candidate.runId,
        },
      );
    }
    const emitted = await this.emitScaleDownForSpec(
      { scalerName: candidate.scalerName, provisioningTargets: candidate.provisioningTargets },
      candidate.agentId,
      effective,
    );
    // Only a teardown that went out counts: an undeliverable row keeps its
    // record and is retried, and counting attempts would inflate the metric on
    // every retry forever. An undelivered teardown has no durable verdict either.
    if (!emitted) return;
    // The durable verdict, for BOTH reasons (a `heartbeat-timeout` condemns an
    // adopted provision). Fire-and-forget: a failure degrades to having no
    // record (the prune reports), never to a wrong suppression.
    this.stateStore
      ?.recordProvisionCondemned(candidate.agentId, candidate.scalerName, effective)
      .catch((err) => {
        logger.warn('scaler: failed to record the provision-condemned verdict', {
          agentId: candidate.agentId,
          scaler: candidate.scalerName,
          reason: effective,
          error: toErrorMessage(err),
        });
      });
    if (withdrawn) this.eventBuffer.delete(candidate.agentId);
    if (effective === ScaleDownReason.enum['spawn-timeout']) {
      incScalerExternalProvisionTimeout(candidate.scalerName);
      // Identity from the candidate, not the in-memory maps: the leader-gated
      // reaper often never spawned this agent, which never registered anywhere.
      this.reportProvisionFailure({
        scalerName: candidate.scalerName,
        agentId: candidate.agentId,
        ...(candidate.runId !== undefined && { runId: candidate.runId }),
        ...(candidate.boundJobId !== undefined && { jobId: candidate.boundJobId }),
      });
      // An unattributed failure waits for a correlation that comes only after
      // registration, which this provision never reaches. The only other erasers
      // (`correlateAgentToJob`, `onAgentDisconnected`) never fire for an agent
      // that never connected, so the buffer would leak one entry per condemned
      // warm provision.
      this.eventBuffer.delete(candidate.agentId);
    }
  }

  /**
   * Refuse a spawn request while the scaler is inside its backoff window.
   *
   * Returns the refusal, or null to proceed. The operator sees it only through
   * this method's log line: the dispatcher branches on `action` and discards
   * `reason`, so a deferred job's queue row records nothing. The job whose
   * provision failed gets `last_provisioning_error` from the triggering
   * `scaler.failed`.
   *
   * The knobs are read per request, so a lowered failure limit changes the
   * wording on the next refusal; the window itself was armed from the base and
   * ceiling live at the last `recordProvisionFailure`, so a retuned window
   * applies from the next failure.
   */
  private async provisionBackoffRefusal(backendName: string): Promise<ScaleResult | null> {
    const state = this.provisionFailures.get(backendName);
    if (!state || state.consecutive === 0) return null;
    const now = Date.now();
    if (now >= state.deferUntilMs) return null;

    const settings = await this.resolveProvisionBackoff();
    const waitMs = state.deferUntilMs - now;
    const repeated = state.consecutive >= settings.maxConsecutiveFailures;
    // Distinct wording sends an operator to different places: past the limit,
    // provisioning is broken, not unlucky; an event scaler fails in its external
    // workflow, any other backend in a launch its own host refused.
    const seconds = Math.ceil(waitMs / 1000);
    const external = this.backends.get(backendName)?.type === ScalerBackendType.enum.event;
    let reason: string;
    if (external) {
      reason = repeated
        ? `scaler \`${backendName}\` has failed to provision ${state.consecutive} times in a row; ` +
          `deferring for ${seconds}s. Provisioning for this scaler is failing ` +
          `consistently — check the provisioning workflow and the provider it drives.`
        : `scaler \`${backendName}\` failed to provision; deferring for ${seconds}s ` +
          `before asking again.`;
    } else {
      reason = repeated
        ? `scaler \`${backendName}\` has failed to start an agent ${state.consecutive} times in a ` +
          `row; deferring for ${seconds}s. Its launch is failing consistently — ` +
          `\`kici-admin diagnose\` shows the cause on the \`scaler:${backendName}\` row.`
        : `scaler \`${backendName}\` failed to start an agent; deferring for ${seconds}s ` +
          `before asking again.`;
    }
    logger.info('scaler: deferring a spawn request inside the provision backoff window', {
      scaler: backendName,
      consecutiveFailures: state.consecutive,
      waitMs,
    });
    return { action: 'skipped', reason, retryAfterMs: waitMs };
  }

  /**
   * Record a consecutive provisioning failure and arm the next deferral. The
   * delay doubles per failure up to the cap, so an outage settles into a steady
   * retry cadence. `2 ** (n - 1)` is capped before use, so it cannot overflow.
   */
  private async recordProvisionFailure(
    backendName: string,
    kind: ProvisionFailureKind,
  ): Promise<void> {
    // Await first, so the get/set below is one uninterrupted microtask; two
    // concurrent reports would otherwise read one value and lose an increment.
    const settings = await this.resolveProvisionBackoff();
    const prior = this.provisionFailures.get(backendName);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const uncapped = settings.baseMs * 2 ** (consecutive - 1);
    // `uncapped` may be Infinity; Math.min still yields the finite cap.
    const delayMs = Math.min(uncapped, settings.maxMs);
    this.provisionFailures.set(backendName, {
      consecutive,
      deferUntilMs: Date.now() + delayMs,
      countedAgents: prior?.countedAgents ?? new Set<string>(),
    });
    if (consecutive >= settings.maxConsecutiveFailures) {
      logger.warn(
        kind === ProvisionFailureKind.External
          ? 'scaler: external provisioning is failing consistently'
          : 'scaler: agent launches are failing consistently',
        {
          scaler: backendName,
          consecutiveFailures: consecutive,
          maxConsecutiveFailures: settings.maxConsecutiveFailures,
          nextAttemptInMs: delayMs,
        },
      );
    }
  }

  /**
   * Claim a dead provision as counted, or report that someone already did. The
   * leader sees one provision twice (its stale-spawn prune and the reaper), and
   * a failure counts per provision, not per observer. Synchronous, before any
   * await, so two observers in the same tick cannot both pass.
   */
  private claimFailedProvision(backendName: string, agentId: string): boolean {
    const prior = this.provisionFailures.get(backendName);
    if (!prior) {
      // Seeded at zero, which `provisionBackoffRefusal` reads as "nothing to
      // defer" until `recordProvisionFailure` increments it.
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
      // Insertion-ordered: drops the oldest, whose second observer is long past.
      prior.countedAgents.delete(prior.countedAgents.values().next().value!);
    }
    return true;
  }

  /**
   * Report one dead external provision, wherever this coordinator noticed it.
   *
   * Everything a failed provision owes an operator: the fleet spawn-failure
   * counter, the structured warn, the `ScalerFailureTracker` record
   * `kici-admin diagnose scaler` reads, the job's `last_provisioning_error`,
   * and the backoff.
   *
   * Reachable from BOTH observers, not the reaper alone: the tracker and
   * `provisionFailures` are per-process and the reaper is leader-gated, so a
   * reaper-only report leaves every non-leader with an empty `diagnose scaler`
   * and an un-deferred cadence. The local prune is every coordinator's view of
   * its own spawns.
   *
   * Synchronous up to the backoff arm, so a caller cleaning up after the event
   * (the prune drops the agent's event buffer) sees the effect at once.
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
          `the scale-up event was emitted, but agent ${opts.agentId} never registered before ` +
          `the spawn timeout. Check that a provisioning workflow received the event ` +
          `(\`kici-admin event list --name kici.scaler.scale-up\`) and that the provider it ` +
          `drives started the agent.`,
        timestampMs: Date.now(),
      },
      {
        ...(opts.runId !== undefined && { runId: opts.runId }),
        ...(opts.jobId !== undefined && { jobId: opts.jobId }),
        backendName: opts.scalerName,
        backendType: ScalerBackendType.enum.event,
      },
    );
    void this.recordProvisionFailure(opts.scalerName, ProvisionFailureKind.External).catch(
      (err) => {
        logger.warn('scaler: failed to arm the provision backoff', {
          scaler: opts.scalerName,
          error: toErrorMessage(err),
        });
      },
    );
  }

  /**
   * Defer a scaler whose host refused to start an agent, then free the spawn's
   * reservation.
   *
   * Arm first: the release notifies freed capacity, and the re-drive 250 ms
   * later must meet the deferral rather than spawn into the same refusal. The
   * release still notifies, since it legitimately unblocks a job waiting on
   * another scaler or the global cap. Callers: a `spawn()` rejected with a
   * `DeterministicSpawnError`, and a settled spawn whose compute stopped before
   * its agent registered (`dropFailedSettledSpawn`). Any other rejection is
   * released at once and retried.
   */
  private deferRefusedLaunch(backendName: string, agentId: string): void {
    const claimed = this.claimFailedProvision(backendName, agentId);
    runDetached(
      logger,
      'Arm the launch-refusal backoff',
      async () => {
        try {
          if (claimed) await this.recordProvisionFailure(backendName, ProvisionFailureKind.Launch);
        } finally {
          this.releaseAll(agentId);
        }
      },
      { scaler: backendName, agentId },
    );
  }

  /**
   * Whether a bound job has ended. A read error, missing row, unknown run or
   * missing reader all read as "not ended", so the caller reports as usual.
   */
  private async boundJobEnded(runId: string | undefined, jobId: string): Promise<boolean> {
    if (!this.readJobStatuses || runId === undefined) return false;
    try {
      const status = (await this.readJobStatuses([{ runId, jobId }])).get(jobId);
      return status !== undefined && TERMINAL_JOB_STATES.has(status);
    } catch (err) {
      logger.warn('scaler: could not read a bound job’s status', {
        jobId,
        error: toErrorMessage(err),
      });
      return false;
    }
  }

  /**
   * Withdraw every settled, job-bound event provision on this coordinator
   * whose job already ended — cancelled, timed out, or run on another agent.
   *
   * The job's row is the shared truth: a cancel reaches whichever coordinator
   * the Platform picks, while the spawning entry lives on the one that asked.
   * A withdrawal is not a failure: nothing is reported, no backoff armed.
   * Returns the withdrawn count.
   */
  async withdrawEndedBoundProvisions(): Promise<number> {
    if (!this.readJobStatuses) return 0;
    const candidates = [...this.spawningAgents].filter(
      ([, e]) =>
        e.boundJobId !== undefined &&
        e.runId !== undefined &&
        e.spawnSettled === true &&
        (e.backendType ?? this.backends.get(e.backendName)?.type) === ScalerBackendType.enum.event,
    );
    if (candidates.length === 0) return 0;
    let statuses: ReadonlyMap<string, string>;
    try {
      statuses = await this.readJobStatuses(
        candidates.map(([, e]) => ({ runId: e.runId!, jobId: e.boundJobId! })),
      );
    } catch (err) {
      logger.warn('scaler: could not read bound job statuses; no provision withdrawn', {
        error: toErrorMessage(err),
      });
      return 0;
    }
    let withdrawn = 0;
    for (const [agentId, entry] of candidates) {
      const status = statuses.get(entry.boundJobId!);
      if (status === undefined || !TERMINAL_JOB_STATES.has(status)) continue;
      // The agent may have registered, or the prune taken the entry, while the
      // read was in flight.
      if (this.spawningAgents.get(agentId) !== entry) continue;
      this.withdrawProvision(agentId, entry, status);
      withdrawn++;
    }
    return withdrawn;
  }

  /**
   * Forget one pending provision and tear it down as `job-complete` — unless a
   * peer adopted its agent, in which case the adopter owns the teardown.
   *
   * Via `emitScaleDownForSpec`, which drops the spawn row only once the
   * scale-down is out; a failed emit leaves it for the reaper, whose
   * spawn-timeout verdict re-checks the job and also sends `job-complete`. Not
   * `backend.destroy`: the backend does not track a rehydrated entry, so it
   * would emit nothing.
   */
  private withdrawProvision(agentId: string, entry: SpawningEntry, jobStatus: string): void {
    this.spawningAgents.delete(agentId);
    this.releaseAll(agentId);
    this.eventBuffer.delete(agentId);
    const backend = this.backends.get(entry.backendName);
    if (backend instanceof EventScalerBackend) backend.forget(agentId);
    const claims = backend instanceof EventScalerBackend ? backend.claimStore : undefined;
    logger.info('scaler: withdrew a pending provision whose bound job ended', {
      agentId,
      scaler: entry.backendName,
      jobId: entry.boundJobId,
      runId: entry.runId,
      jobStatus,
    });
    runDetached(
      logger,
      'Withdraw provision',
      async () => {
        // The entry outlives a peer's adoption, and on the ordinary HA path the
        // job ended because it ran on that adopted agent. The adopter owns the
        // teardown; emitting here would delete a live instance and its row. A
        // failed lookup emits nothing: the reaper re-checks from the row.
        let adoptedBy: string | null;
        try {
          adoptedBy = (await this.stateStore?.provisionAdopter(agentId)) ?? null;
        } catch (err) {
          logger.warn(
            'scaler: adoption lookup failed for a withdrawn provision; left to the reaper',
            {
              agentId,
              error: toErrorMessage(err),
            },
          );
          return;
        }
        if (adoptedBy !== null) {
          logger.info(
            'scaler: withdrawn provision was adopted by a peer, which owns its teardown',
            {
              agentId,
              scaler: entry.backendName,
              adoptedBy,
            },
          );
          return;
        }
        await this.emitScaleDownForSpec(
          { scalerName: entry.backendName, provisioningTargets: entry.provisioningTargets },
          agentId,
          ScaleDownReason.enum['job-complete'],
        );
        // Nothing may redeem a withdrawn provision's single-use claim code.
        await claims?.invalidate(agentId).catch((err: unknown) => {
          logger.warn('scaler: could not invalidate a withdrawn provision’s claim', {
            agentId,
            error: toErrorMessage(err),
          });
        });
      },
      { agentId },
    );
  }

  /**
   * Report a pruned event spawn as a dead provision — unless a peer adopted it.
   *
   * The prune is NOT proof of failure on an HA cluster: the spawning coordinator
   * never learns its agent registered on a peer, so the entry reaches the prune
   * next to a live agent (the asymmetry `deleteUnadoptedSpawningAgent` exists
   * for). Reporting it would write `scaler.failed` and
   * `last_provisioning_error` onto a running job and back off a healthy scaler.
   * The reaper applies the same test (`spawn-timeout` only without
   * `adoptedBy`), so the two observers agree.
   *
   * The spawn row alone cannot say "ever adopted?": it is deleted on teardown.
   * `provisionAdopter` reads the live row, then the durable provision-outcome
   * record that survives the delete, so an adopted provision the reaper has
   * since condemned does not read as dead.
   *
   * The lookup is fire-and-forget (off the request path) and fails open: a
   * store error or no verdict leaves the failure reported, because that is what
   * a real outage looks like to one coordinator, and suppressing it would
   * disarm every follower's backoff. The only rows with no verdict were adopted
   * before the outcome table existed and age out within one stale-prune window
   * of the deploy.
   */
  private reportPrunedProvisionFailure(agentId: string, entry: SpawningEntry): void {
    const boundJobId = entry.boundJobId;
    if (boundJobId === undefined || !this.readJobStatuses) {
      this.reportPrunedUnlessAdopted(agentId, entry);
      return;
    }
    // An ended job's provision is withdrawn, not failed; the row stays for the
    // reaper, which tears it down as `job-complete`.
    runDetached(
      logger,
      'Pruned provision verdict',
      async () => {
        if (await this.boundJobEnded(entry.runId, boundJobId)) {
          logger.info('scaler: pruned spawn’s bound job already ended; not a failed provision', {
            agentId,
            scaler: entry.backendName,
            jobId: boundJobId,
            runId: entry.runId,
          });
          return;
        }
        this.reportPrunedUnlessAdopted(agentId, entry);
      },
      { agentId },
    );
  }

  /** The adoption half of {@link reportPrunedProvisionFailure}. */
  private reportPrunedUnlessAdopted(agentId: string, entry: SpawningEntry): void {
    const report = (): void => {
      this.reportProvisionFailure({
        scalerName: entry.backendName,
        agentId,
        ...(entry.runId !== undefined && { runId: entry.runId }),
        ...(entry.boundJobId !== undefined && { jobId: entry.boundJobId }),
      });
      // The prune's buffer drop ran before this async report, so an unbound
      // failure would park an entry nothing flushes: correlation needs a
      // registration that never happened.
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
   * Clear a scaler's consecutive-failure state after a successful provision,
   * from both the local and the adopted registration paths (see
   * `onAgentRegistered`).
   */
  private clearProvisionFailures(backendName: string): void {
    if (this.provisionFailures.delete(backendName)) {
      logger.info('scaler: provisioning recovered, cleared the backoff', {
        scaler: backendName,
      });
    }
  }

  /**
   * Emit `kici.scaler.scale-down` straight from a persisted spawn spec, then
   * drop the durable row.
   *
   * Used where the instance holding the agent has no local backend for its
   * scaler, the ordinary shape on an HA cluster behind one shared endpoint.
   *
   * A failed emit leaves the row: it is the only durable pointer at the
   * customer's running instance, and the reaper retries from it. Returns
   * whether the teardown was emitted, so callers count deliveries, not attempts.
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
    // The row's targets are primary (this instance may not configure the
    // scaler). Local config is the fallback for a row that recorded none: only
    // a coordinator that configures the scaler can ever clear such a row.
    const targets = spec.provisioningTargets.length
      ? spec.provisioningTargets
      : (this.scalerProvisioningTargets.get(spec.scalerName) ?? []);
    if (targets.length === 0) {
      // Nowhere to deliver: an emit would reach no subscriber yet count and drop
      // the row. Keep the row (the last pointer at the running instance) and say
      // so loudly until a coordinator configuring the scaler takes it up.
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
   * The backend TYPE (`container`, `firecracker`, `bare-metal`, `event`, …) of
   * a registered agent, or null for a static / stateful agent.
   *
   * AgentMetricsAggregator stamps it as the `scaler` label on each
   * kici_agent_* series. It MUST be the type, not the operator-chosen name: the
   * Platform catalog filter allows only the ScalerBackendType set (plus
   * `stateful`) and drops anything else as bad_label_value.
   */
  getBackendType(agentId: string): string | null {
    const scalerName = this.managedAgentIndex.get(agentId);
    if (scalerName === undefined) return null;
    return this.backends.get(scalerName)?.type ?? null;
  }

  /**
   * Exchange a provisioning claim code for freshly minted ephemeral credentials.
   *
   * Reads the shared claim table directly, not through the minting backend: the
   * mint needs only the DB-backed agent-token store, so redemption works on an
   * instance that never heard of the emitting scaler. That lets an HA cluster
   * front its coordinators with one shared endpoint.
   *
   * Returns `{ error }` with no claim store (no database) or a rejected redeem
   * (unknown / consumed / expired / minting error). Called from the
   * `scaler.claim-credentials` WS handler.
   */
  async claimScalerCredentials(
    code: string,
  ): Promise<{ credentials?: ClaimedCredentials; error?: string }> {
    if (!this.claimStore) {
      // A coordinator with no scaler config rejects every claim; behind a shared
      // endpoint that is about half, and the agent sees only "invalid claim
      // code", so log the real cause here.
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
   * Called from agent-handler.ts on config.ack. Clears a Firecracker agent's MMDS
   * data (belt-and-suspenders with in-VM iptables); a no-op for other agents.
   */
  onConfigAck(agentId: string): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) {
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

  /** Called when a scaler-managed agent completes a job. */
  onJobComplete(agentId: string): void {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) return;

    const backend = this.backends.get(backendName);
    if (!backend) return;

    // The single-job agent disconnects next, freeing its reservation. Signal
    // early to cut re-dispatch latency; the trailing debounce coalesces this
    // with the disconnect release, so the re-drive runs after the slot opens.
    this.notifyCapacityFreed();
  }

  /**
   * Correlate an agent to a runId/jobId after dispatch, flushing buffered
   * pre-dispatch events.
   */
  correlateAgentToJob(agentId: string, runId: string, jobId: string): void {
    this.agentJobCorrelation.set(agentId, { runId, jobId });
    this.persistAgentJob(agentId, runId, jobId);

    const buffered = this.eventBuffer.get(agentId);
    if (buffered && this.onScalerEvent) {
      for (const event of buffered) {
        this.onScalerEvent(runId, jobId, event);
      }
    }
    this.eventBuffer.delete(agentId);
  }

  /** Sum of all backends' active counts, which include spawning agents. */
  getGlobalActiveCount(): number {
    let total = 0;
    for (const backend of this.backends.values()) {
      total += backend.getActiveCount();
    }
    // spawningAgents is NOT added: the container, bare-metal and firecracker
    // backends add to their agents map synchronously at the start of spawn(),
    // so it would double-count; it serves only registration correlation.
    //
    // Still blind to an agent RESERVED but waiting in the spawn semaphore,
    // before `backend.spawn` starts. `reserveForSpawn` closes that window with
    // `Math.max` over this and the admitted set.
    return total;
  }

  /**
   * Shut every backend down in parallel, waiting at most
   * {@link SCALER_SHUTDOWN_GRACE_MS} for the slowest. A backend still stopping
   * when the window closes is logged by name and left to finish on its own.
   */
  private async shutdownBackendsWithinGrace(): Promise<void> {
    const pending = new Set<string>();
    const shutdowns = [...this.backends.entries()].map(async ([name, backend]) => {
      pending.add(name);
      try {
        await backend.shutdownAll();
      } catch (err) {
        logger.error(`Backend shutdown error: ${err}`);
      } finally {
        pending.delete(name);
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceElapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SCALER_SHUTDOWN_GRACE_MS);
    });
    try {
      await Promise.race([Promise.allSettled(shutdowns), graceElapsed]);
    } finally {
      clearTimeout(timer);
    }
    if (pending.size > 0) {
      logger.warn('Scaler backends still stopping their agents after the shutdown grace', {
        graceMs: SCALER_SHUTDOWN_GRACE_MS,
        backends: [...pending],
      });
    }
  }

  /** Stop the warm pool, shut down all backends, clear tracking maps. */
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
      // Best-effort, so peers need not wait for the next reaper tick.
      await this.machineLedger.releaseAllForInstance().catch((err) => {
        logger.warn('machine-ledger releaseAllForInstance failed', { error: String(err) });
      });
    }

    await this.shutdownBackendsWithinGrace();

    this.spawningAgents.clear();
    this.managedAgentIndex.clear();
    this.warmAgents.clear();
    this.boundAgents.clear();
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
   * `backend.reload` validates and applies in one call, so each successful
   * call's previous state is snapshotted and restored if any backend rejects:
   * a rejected reload leaves every backend as it was. The snapshots are also
   * returned, so a later failing stage (an added backend that does not
   * construct) can roll back the same way.
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
      // The whole entry: the event backend reads roles, mandatoryLabels,
      // agentTokenTtlSeconds and provisioningTargets off it at every spawn.
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
   * Construct every added backend into a staging list; on any failure the
   * partial set is torn down and the old config stays.
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
   * Refresh per-scaler metadata. A retiring scaler keeps its cap, URL, roles and
   * defaults until its last agent is gone.
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
        // The next spawn builds one at the new width.
        this.spawnSemaphores.delete(entry.name);
      }
      if (!this.perScalerUsage.has(entry.name)) {
        this.perScalerUsage.set(entry.name, { cpus: 0, memBytes: 0 });
      }
    }

    this.applyMachinePools(newConfig);
  }

  /**
   * Register every configured machine pool, building the ledger when this reload
   * first declares a pool. `cap` is re-registered every reload, so a changed cap
   * applies without a restart.
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
   * All or nothing: a rejected config leaves the previous one running. A scaler
   * the new config drops is retired: it stops taking work at once, its idle
   * warm agents are destroyed, its job-bound agents finish, and its backend is
   * torn down when it drains.
   */
  async reload(newConfig: ScalerConfig): Promise<ScalerReloadResult> {
    const plan = this.planReload(newConfig);

    // `backend.reload` applies as it validates; `applied` holds the prior state.
    const { errors, applied } = this.validateReload(newConfig, plan);
    if (errors.length > 0) return { valid: false, errors };

    const { built, errors: buildErrors } = await this.buildAddedBackends(plan.added, newConfig);
    if (buildErrors.length > 0) {
      // Kept backends already took the new label sets; put them back so a
      // failed construction does not half-apply the file.
      this.restoreReloadedBackends(applied);
      return { valid: false, errors: buildErrors };
    }

    const reloadPlan = this.describeReload(newConfig, plan);

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
    this.appliedEntries.clear();
    for (const entry of newConfig.scalers) this.appliedEntries.set(entry.name, stableJson(entry));
    this.applyScalerMetadata(newConfig);
    this.applyWarmPoolConfig(newConfig);

    logger.info('scaler configuration reloaded', {
      added: built.map((b) => b.name),
      removed: plan.removed,
      retiring: [...this.retiring],
      unchanged: plan.kept.length,
    });

    // Post-commit, best-effort.
    await this.prepareAddedBackends(built);

    // A scaler removed with no agents drains instantly; tear it down now.
    await this.sweepRetiredBackends();

    return { valid: true, plan: reloadPlan };
  }

  /**
   * What a validated reload is about to change, per scaler name. Runs before
   * the commit, while the previous entries and global limits are still in place.
   */
  private describeReload(newConfig: ScalerConfig, plan: ReloadPlan): ScalerReloadPlan {
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const entry of plan.kept) {
      if (this.appliedEntries.get(entry.name) === stableJson(entry)) unchanged.push(entry.name);
      else updated.push(entry.name);
    }
    const global: string[] = [];
    if (newConfig.globalMaxAgents !== this.globalMaxAgents) global.push('globalMaxAgents');
    if (stableJson(newConfig.globalResourceCap) !== stableJson(this.globalResourceCap)) {
      global.push('globalResourceCap');
    }
    return {
      added: plan.added.map((e) => e.name),
      updated,
      unchanged,
      retired: [...plan.removed],
      resurrected: plan.resurrected.map((e) => e.name),
      global,
    };
  }

  /** Recent spawn failures per backend instance, for the diagnose scaler check. */
  recentSpawnFailures(windowMs: number, nowMs: number): Map<string, BackendFailureSummary> {
    return this.failureTracker.recentByBackend(windowMs, nowMs);
  }

  /** Status summary for metrics and health endpoints. */
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
        // A retiring scaler has no enriched entry; derive the gate directly, in
        // step with the `labelSets` fallback above.
        labelSetMandatoryLabels:
          enriched?.labelSetMandatoryLabels ??
          backend.labelSets.map(() => this.mandatoryGate(name, backend)),
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
   * Retiring backends are excluded, or peers would keep selecting this host for
   * jobs it can no longer serve. Their draining agents stay visible through the
   * per-agent inventory, so in-flight work is unaffected.
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
        labelSetMandatoryLabels: b.labelSetMandatoryLabels,
      }));
  }

  /** The scaler name managing an agent, or null for a standalone agent. */
  getBackendForAgent(agentId: string): string | null {
    return this.managedAgentIndex.get(agentId) ?? null;
  }

  /**
   * A backend by scaler name, for diagnostics reaching backend-specific
   * accessors (e.g. the Firecracker backend's `getBridgeConfig()`).
   */
  getBackend(name: string): ScalerBackend | undefined {
    return this.backends.get(name);
  }

  /**
   * Whether some configured backend could spawn for this label set: the
   * `findBackendForLabels` match `requestScale` makes, without spawning.
   *
   * The queue-expiry sweep uses it to separate a label problem (no agent AND no
   * backend: `unroutable`) from a provisioning/capacity one (`timed_out_stale`),
   * so an operator is not told to fix a correct `runsOn`.
   *
   * Exact labels only, as in `requestScale`, so a regex `runsOn` is not
   * expressible. For a pattern-only `runsOn` a backend with no mandatory labels
   * matches the empty set, so the job settles `timed_out_stale` instead of
   * `unroutable`: less precise, never unsafe (the job is terminal and the run
   * fails either way). Tightening it means teaching scaler routing about
   * patterns, which would change where jobs spawn.
   */
  hasBackendForLabels(labels: string[], excludeLabels: string[] = []): boolean {
    return findBackendForLabels(labels, this.getEnrichedScalerEntries(), excludeLabels) !== null;
  }

  /**
   * Scaler-specific metadata for a managed agent (undefined for a static one),
   * used to enrich job.context before forwarding to the Platform.
   */
  getScalerContextForAgent(agentId: string): Record<string, unknown> | undefined {
    const backendName = this.managedAgentIndex.get(agentId);
    if (!backendName) return undefined;

    const backend = this.backends.get(backendName);
    if (!backend) return undefined;

    return backend.getScalerContext?.(agentId);
  }

  /**
   * Start the machine-pool ledger reaper and the retirement sweep, and publish
   * the warm-pool gauges so each target is visible before its first fill. The
   * warm pools themselves start in {@link startWarmPools}.
   */
  start(): void {
    this.started = true;
    this.publishWarmPoolGauges();
    if (this.machineLedger) {
      this.machineLedger.start();
    }
    this.retirementSweep ??= setInterval(() => {
      runDetached(logger, 'Retired backend sweep', () => this.sweepRetiredBackends());
      // Separate from the sweep, whose retirement half must reach its first
      // await without yielding to this job-status read. A provision the prune
      // meets first is not reported either (the prune re-checks the job), and
      // the reaper tears it down as job-complete.
      runDetached(logger, 'Bound provision withdrawal', () => this.withdrawEndedBoundProvisions());
    }, RETIREMENT_SWEEP_INTERVAL_MS);
    this.retirementSweep.unref?.();
  }

  /**
   * Run the warm pools' first deficit pass and arm their periodic tick.
   * Separate from {@link start}: the first pass spawns at once, and an event
   * backend's spawn needs the event emitter, which the coordinator assigns
   * after building the scaler. The worker (no event backend) calls it right
   * after `start()`.
   */
  startWarmPools(): void {
    this.warmPool.start();
  }

  /**
   * Provision/heal every backend's host prerequisites before spawning starts. A
   * failure degrades only that scaler (its spawns fail with clear errors and
   * the firecracker-network diagnostic reports it), never aborts startup.
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
   * Floored at the configured spawn deadline, so raising
   * `KICI_SCALER_SPAWN_TIMEOUT_MS` for a slow cloud never has the prune drop
   * the correlation of a provision still booting inside it. A lowered deadline
   * keeps the default five minutes: a local backend's agent registers well
   * after `spawn()` returns.
   */
  private stalePruneWindowMs(): number {
    return Math.max(this.spawnTimeoutMs, DEFAULT_STALE_SPAWN_PRUNE_MS);
  }

  /**
   * Remove spawning entries whose `backend.spawn` started longer ago than the
   * stale window and never registered via WS (e.g. a crash on startup), which
   * would otherwise leak forever.
   *
   * Measured from `spawnStartedAt`, NOT `spawnedAt` (enqueue): a spawn still
   * queued behind the semaphore must not be reaped mid-burst. Recovered entries
   * carry `spawnStartedAt` = their persisted enqueue time.
   *
   * The durable row's fate follows the backend type the spawn recorded. A local
   * backend's pruned spawn is dead, so the row goes. An event backend's row is
   * the only pointer at a customer cloud instance and is the reaper's
   * `spawn-timeout` candidate, so it STAYS: deleting it would beat the reaper by
   * the flap grace and the teardown would never be emitted.
   */
  private pruneStaleSpawningEntries(): void {
    const staleThreshold = Date.now() - this.stalePruneWindowMs();
    for (const [id, entry] of this.spawningAgents) {
      if (entry.spawnStartedAt === undefined) continue;
      if (entry.spawnStartedAt < staleThreshold) {
        this.spawningAgents.delete(id);
        // Release a warm fill's in-flight slot, or the pool stays below target.
        if (!entry.boundJobId) this.warmPool.onWarmSpawnFailed(entry.labelSet);
        const backend = this.backends.get(entry.backendName);
        // Branch on the recorded type, not on a configured backend: a removed
        // scaler has none, and reading that as "not event" deletes the only
        // pointer at a running cloud instance (`recoverState` rehydrates rows of
        // removed scalers too). Live config resolves only a row with no type.
        const backendType = entry.backendType ?? backend?.type;
        if (backendType === ScalerBackendType.enum.event) {
          // A peer may have adopted the agent unseen; the seeded backend entry
          // would count against the global cap forever and hand `shutdownAll()`
          // a peer's live agent. Forgetting emits nothing: the adopter (or the
          // reaper) owns the teardown.
          if (backend instanceof EventScalerBackend) backend.forget(id);
          // A failed external provision unless the provision-outcome record
          // says adopted (see `reportPrunedProvisionFailure`). Reporting here
          // arms the backoff on non-leaders too; deduped by agent id.
          this.reportPrunedProvisionFailure(id, entry);
        } else {
          // `adopted_by IS NULL` is belt-and-braces: a local row is never adoptable.
          this.deleteUnadoptedSpawningAgentFromStore(id);
          // The compute may still exist (a VM whose guest stopped after
          // `spawn()` resolved, a process that never connected); without a
          // teardown it counts against `maxAgents` and holds host resources.
          if (backend && entry.spawnSettled) {
            runDetached(
              logger,
              'Stale spawn teardown',
              () => backend.destroy(id, { reason: ScaleDownReason.enum['spawn-timeout'] }),
              { agentId: id },
            );
          }
        }
        // The only place a pruned spawn's reservation can be freed: neither the
        // spawn-failure path nor onAgentDisconnected fires for it. Otherwise the
        // caps (and the scaler_reservations row + machine-pool ledger slot) leak
        // permanently, and recoverState rehydrates them until every requestScale
        // is refused at-capacity with zero agents spawned.
        this.releaseAll(id);
        // Same for the event buffer: a `scaler.failed` parked for an unbound
        // spawn waits for a correlation that can never arrive.
        this.eventBuffer.delete(id);
        logger.warn(
          `Pruned stale spawning entry for agent ${id} (spawn started ${Math.round((Date.now() - entry.spawnStartedAt) / 1000)}s ago)`,
        );
      }
    }
  }

  // ── DB write-through helpers ─────────────────────────────────────
  // Store calls are fire-and-forget: other coordinators read the store on
  // recovery, and on a transient DB error the in-process cache stays
  // authoritative, so log and continue.

  /**
   * The spawn row for one agent, as every writer of it must build it.
   *
   * Ownership and self-describing columns are assembled only here:
   * `backend_type` is what `adoptSpawningAgent`'s conditional UPDATE matches, so
   * a row without it is never adoptable; `owner_instance_id` scopes recovery;
   * `mandatory_labels` and `provisioning_targets` give a coordinator with no
   * config entry for the scaler its platform taint and its only teardown
   * address (an empty target list reaches nobody, so the provision would bill
   * forever); `roles` keeps the row a complete description of the spawn.
   */
  private spawningAgentSnapshot(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    boundJobId: string | undefined,
    /**
     * The bound job's run, so a coordinator that never spawned the agent (often
     * the leader-gated reaper) can attribute a failure to the waiting job.
     * Absent for a warm pre-spawn.
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
        // The adopting coordinator stamps this straight onto the agent.
        mandatoryLabels: this.mandatoryGate(scalerName, backend),
      }),
    };
  }

  /**
   * Claim one slot against an event scaler's cluster-wide `maxAgents`.
   *
   * Count and claim share one advisory-locked transaction, so the row is visible
   * to the next coordinator taking the lock. A store failure never admits:
   * refusing costs a queue wait, admitting provisions an instance the cap
   * cannot see. Refusals and store failures are counted, labelled so a database
   * outage, a contended lock and a full cluster are distinguishable.
   *
   * A transaction that commits but loses its acknowledgement leaves
   * `slotClaimed` false, so the row counts against the cap for an agent that
   * never spawned. Closing that needs two-phase commit; the event-provision
   * reaper is the backstop, clearing the row once the spawn deadline passes
   * with nothing adopted.
   */
  private async claimClusterSlot(
    agentId: string,
    labelSet: string[],
    scalerName: string,
    maxAgents: number,
    /** The job this spawn serves, or `undefined` for a warm pre-spawn. */
    boundJobId: string | undefined,
    /** The bound job's run, persisted alongside it so a failure stays attributable. */
    runId: string | undefined,
  ): Promise<ClusterSlotClaim> {
    if (!this.stateStore) return ClusterSlotClaim.Refused;
    try {
      return await this.stateStore.withScalerCapLock(scalerName, async (slot) => {
        // The re-drive runs on any coordinator, so a peer may already provision
        // this job. Read under the claim's lock, so two cannot both admit it.
        if (boundJobId !== undefined && (await slot.hasProvisionForJob(boundJobId))) {
          return ClusterSlotClaim.ProvisionInFlight;
        }
        if (slot.clusterActiveCount >= maxAgents) {
          logger.info('scaler.cap exceeded for scaler agents cluster-wide', {
            scaler: scalerName,
            used: slot.clusterActiveCount,
            max: maxAgents,
          });
          incScalerSpawnRefusals();
          return ClusterSlotClaim.Refused;
        }
        await slot.reserve(
          this.spawningAgentSnapshot(agentId, labelSet, scalerName, boundJobId, runId),
        );
        return ClusterSlotClaim.Claimed;
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
      return ClusterSlotClaim.Refused;
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
   * Stamp `adopted_by = this instance` on a just-registered agent's row, via the
   * conditional UPDATE, so a row another instance claimed is left as it is.
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

  /**
   * Record that `backend.spawn()` resolved for a spawn this instance started.
   *
   * False when the prune dropped the entry while `spawn()` ran (a per-org
   * deadline can outlast the prune window). Nothing else would tear that
   * compute down, so a local backend's is destroyed here; an event provision is
   * left to the reaper.
   */
  private onSpawnSettled(agentId: string, backend: ScalerBackend): boolean {
    const entry = this.spawningAgents.get(agentId);
    if (entry) {
      entry.spawnSettled = true;
      return true;
    }
    // The agent registered before spawn() returned.
    if (this.managedAgentIndex.has(agentId)) return true;
    if (backend.type !== ScalerBackendType.enum.event) {
      logger.warn(`Spawn of agent ${agentId} finished after it was pruned; destroying it`);
      runDetached(
        logger,
        'Late spawn teardown',
        () => backend.destroy(agentId, { reason: ScaleDownReason.enum['spawn-timeout'] }),
        { agentId },
      );
    }
    return false;
  }

  /**
   * Drop a settled local spawn whose backend reported it failed.
   *
   * A backend whose compute dies before registration (a Firecracker guest or a
   * bare-metal agent process that exited) tears it down and emits
   * `scaler.failed`. The entry, durable row and reservation go now; waiting
   * for the prune would hold the slot for minutes.
   *
   * Like an event scaler's dead provision, it is a refused launch: the scaler is
   * deferred before the reservation is freed, so an agent dying at every
   * startup is not respawned at its startup cadence. Only an unregistered spawn
   * reaches here, so an agent that exits after registering never arms the
   * backoff.
   */
  private dropFailedSettledSpawn(agentId: string, spawning: SpawningEntry): void {
    this.spawningAgents.delete(agentId);
    this.deleteUnadoptedSpawningAgentFromStore(agentId);
    if (!spawning.boundJobId) this.warmPool.onWarmSpawnFailed(spawning.labelSet);
    this.deferRefusedLaunch(spawning.backendName, agentId);
    this.eventBuffer.delete(agentId);
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
        // Recovery is owner-scoped: an unstamped row rehydrates as zero usage,
        // and the caps under-count every agent still running.
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
   * Hydrate the in-memory maps from the state store after a coordinator boot
   * or Raft leader switch:
   *
   *   - `spawningAgents` (with `boundJobId` for eager-dispatch on register)
   *     — event-backend rows only; a local-backend row is dropped, see below
   *   - `agentJobCorrelation` (so scaler-lifecycle events route correctly)
   *   - `reservations` + `perScalerUsage` (so the cap check sees the real
   *     state, not an empty start)
   *
   * `globalUsage` is recomputed from `perScalerUsage`. `eventBuffer` is NOT
   * restored: its events are observability, and nothing waits on them.
   *
   * Both reads are scoped to this instance's own rows. An unscoped read would
   * hydrate a peer's in-flight spawns as ours, so our spawn-timeout reaper
   * destroys agents the peer still waits on and our caps double-count. A dead
   * instance's rows belong to the leader-gated reaper. No-op with no store.
   */
  async recoverState(): Promise<ScalerStateRecovery> {
    const recovery: ScalerStateRecovery = {
      spawningAgentsRehydrated: 0,
      spawningDropped: 0,
      agentJobsRehydrated: 0,
      reservationsRehydrated: 0,
      reservationsDropped: 0,
      bufferedEventsLost: 0,
    };
    if (!this.stateStore) return recovery;

    try {
      const spawning = await this.stateStore.listSpawningAgentsForOwner(this.instanceId);
      for (const entry of spawning) {
        // A recovered LOCAL-backend spawn can never register, so it is dropped,
        // not rehydrated: bootstrap's `cleanupOrphans` (right after this)
        // removes its container or VM, and `adoptSpawningAgent` adopts `event`
        // rows only, so an agent racing ahead of cleanup is refused and
        // reclaimed. Rehydrating would hold its reservation until the prune: on
        // a restart mid-burst, ten dead spawns in a ten-slot scaler refuse every
        // request for five minutes (`scalerActiveCount: 0`,
        // `scalerReservations: 10`). The row goes too, and the reservation loop
        // below drops its reservation row. A row of unknown type (neither
        // recorded nor in live config) is rehydrated for the prune to decide.
        const backendType = entry.backendType ?? this.backends.get(entry.scalerName)?.type;
        if (backendType !== undefined && backendType !== ScalerBackendType.enum.event) {
          this.deleteUnadoptedSpawningAgentFromStore(entry.agentId);
          recovery.spawningDropped += 1;
          continue;
        }
        // No live spawn backs a recovered entry: treat it as started (staleness
        // from its persisted enqueue time), or it would never be reaped.
        this.spawningAgents.set(entry.agentId, {
          labelSet: entry.labelSet,
          backendName: entry.scalerName,
          provisioningTargets: entry.provisioningTargets ?? [],
          spawnedAt: entry.spawnedAt.getTime(),
          spawnStartedAt: entry.spawnedAt.getTime(),
          ...(entry.backendType !== undefined && { backendType: entry.backendType }),
          ...(entry.boundJobId !== undefined && { boundJobId: entry.boundJobId }),
          // `onScalerEvent` needs the run id to route a failure to the waiting
          // job; the correlation map fills only after registration.
          ...(entry.runId !== undefined && { runId: entry.runId }),
          spawnSettled: true,
        });
      }
      recovery.spawningAgentsRehydrated = spawning.length - recovery.spawningDropped;

      const correlations = await this.stateStore.listAgentJobs();
      for (const c of correlations) {
        this.agentJobCorrelation.set(c.agentId, { runId: c.runId, jobId: c.jobId });
      }
      recovery.agentJobsRehydrated = correlations.length;

      const reservations = await this.stateStore.listReservationsForOwner(this.instanceId);
      for (const r of reservations) {
        // Every `releaseAll` route (spawn failure, disconnect, warm-pool destroy,
        // `pruneStaleSpawningEntries`) is keyed on `spawningAgents`, so a
        // reservation with no spawn behind it is never released: it bills
        // against the caps on every boot, and past the global cap every
        // `requestScale` is silently refused `at-capacity`.
        //
        // Keyed on the spawning map, not age: an in-flight spawn owns its
        // reservation whatever its age. Sound because `spawningAgents` is fully
        // rehydrated above.
        //
        // A REGISTERED local agent's reservation outlives its spawn row (deleted
        // at registration), so this test reads it as an orphan. Safe only
        // because this runs once at bootstrap, before any registration, and a
        // local agent cannot survive the restart (`adoptSpawningAgent` adopts
        // `event` rows only, so it is refused and reclaimed). An event row
        // survives registration, so its reservation is kept. Calling this on a
        // leader switch would drop reservations of running agents.
        if (!this.spawningAgents.has(r.agentId)) {
          this.deleteReservationFromStore(r.agentId);
          recovery.reservationsDropped += 1;
          continue;
        }
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
      recovery.reservationsRehydrated = reservations.length - recovery.reservationsDropped;

      logger.info('scaler: state hydrated from DB after boot/leader switch', recovery);
    } catch (err) {
      logger.error('scaler: failed to recover state from DB; starting with empty maps', {
        error: toErrorMessage(err),
      });
    }

    return recovery;
  }

  /**
   * Mint a scaler-managed agent id from {@link SCALER_AGENT_ID_PREFIX}, never a
   * copy of the literal: `onAgentRegistered`'s guard recognises scaler agents by
   * that prefix alone when the spawn-record lookup fails, so a drifted prefix
   * would fail open.
   */
  private generateAgentId(backendType: string): string {
    return `${SCALER_AGENT_ID_PREFIX}${backendType}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Start log forwarding if the backend supports LogCapture. Fire-and-forget:
   * forward() runs for the agent's lifetime.
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
   * Per-agent event emitter for backend.spawn(), routing through
   * handleScalerEvent().
   */
  private createEventEmitter(_agentId: string): (event: ScalerEvent) => void {
    return (event: ScalerEvent) => {
      this.handleScalerEvent(event);
    };
  }

  /**
   * Handle a scaler event from a backend.
   *
   * A spawn FAILURE usually resolves through the bound spawning entry, since
   * correlation is set only at dispatch. The correlation map wins in the rarer
   * post-registration window (e.g. a bare-metal child 'error' after
   * registration, when the spawning entry is gone). Unbound spawns resolve to
   * neither. An attributed event is relayed at once; otherwise it is buffered
   * until correlateAgentToJob() flushes it.
   *
   * Every `scaler.failed` increments the fleet-wide spawn-failure counter and
   * warns, attributed or not. The backend label comes from the spawning entry,
   * then the managed-agent index, so a late failure still buckets under the
   * real backend, not "unknown".
   *
   * `attribution` is the last resort for a failure this coordinator neither
   * spawned nor registered (typical for the leader-gated reaper). It is read
   * only where the maps are silent, so a live local entry beats a durable row
   * that may be a sweep behind.
   */
  private handleScalerEvent(event: ScalerEvent, attribution?: ScalerEventAttribution): void {
    const correlated = this.agentJobCorrelation.get(event.agentId);
    const spawning = this.spawningAgents.get(event.agentId);
    const runId = correlated?.runId ?? spawning?.runId ?? attribution?.runId;
    const jobId = correlated?.jobId ?? spawning?.boundJobId ?? attribution?.jobId;

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
      let buffer = this.eventBuffer.get(event.agentId);
      if (!buffer) {
        buffer = [];
        this.eventBuffer.set(event.agentId, buffer);
      }
      buffer.push(event);
    }

    if (
      event.eventType === ScalerEventType.enum['scaler.failed'] &&
      spawning?.spawnSettled &&
      (spawning.backendType ?? this.backends.get(spawning.backendName)?.type) !==
        ScalerBackendType.enum.event
    ) {
      this.dropFailedSettledSpawn(event.agentId, spawning);
    }
  }
}
