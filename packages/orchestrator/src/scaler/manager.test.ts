import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import type {
  ScalerBackend,
  ManagedAgent,
  LabelSetConfig,
  ValidationResult,
  ScalerConfig,
  ScalerEntry,
  ScalerEvent,
  SpawnContext,
} from './types.js';
import type { WarmPoolStats } from './warm-pool.js';
import { ScalerEventType } from './types.js';
import { ScalerManager, resolveScalerOrchestratorUrl, buildScalerUsageRows } from './manager.js';
import type { ProvisionBackoffSettings, ScalerManagerDeps } from './manager.js';
import { normalizeLabelSet } from './label-matcher.js';
import { EventScalerBackend } from './event-backend.js';
import { MachineLedger } from './machine-ledger.js';
import { DEFAULT_MAX_CONCURRENT_SPAWNS } from './config.js';
import { ClaimStore, DEFAULT_CLAIM_TTL_SECONDS } from './claim-store.js';
import type { ScalerStateStore, ReapCandidate } from './scaler-state-store.js';
import { ScaleDownReason } from './scaler-events.js';
import { makeFakeScalerStateStore } from '../__test-helpers__/fake-scaler-state-store.js';
import {
  incScalerExternalProvisionTimeout,
  incScalerSpawnRefusals,
  scalerCapLockFailuresTotal,
  ScalerCapLockFailureReason,
  setWarmPoolGauges,
} from '../metrics/prometheus.js';

// Partial mock: only the instruments these tests assert on are replaced, so
// every other metric call in the manager keeps hitting the real registry.
vi.mock('../metrics/prometheus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metrics/prometheus.js')>()),
  incScalerExternalProvisionTimeout: vi.fn(),
  incScalerSpawnRefusals: vi.fn(),
  scalerCapLockFailuresTotal: { add: vi.fn() },
  setWarmPoolGauges: vi.fn(),
}));

/**
 * Creates a mock ScalerBackend for testing.
 */
function createMockBackend(
  overrides: Partial<ScalerBackend> & {
    type: ScalerBackend['type'];
    labelSets: LabelSetConfig[];
    maxAgents: number;
  },
): ScalerBackend {
  let activeCount = 0;

  return {
    type: overrides.type,
    labelSets: overrides.labelSets,
    maxAgents: overrides.maxAgents,
    getActiveCount: overrides.getActiveCount ?? (() => activeCount),
    spawn:
      overrides.spawn ??
      vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
        activeCount++;
        return {
          id: agentId,
          labelSet,
          backendRef: `ref-${agentId}`,
          spawnedAt: Date.now(),
          state: 'running',
        };
      }),
    destroy:
      overrides.destroy ??
      vi.fn(async () => {
        activeCount = Math.max(0, activeCount - 1);
      }),
    shutdownAll:
      overrides.shutdownAll ??
      vi.fn(async () => {
        activeCount = 0;
      }),
    reload:
      overrides.reload ??
      vi.fn((): ValidationResult => {
        return { valid: true };
      }),
    ...(overrides.ensureHostReady ? { ensureHostReady: overrides.ensureHostReady } : {}),
    ...(overrides.reapUnowned ? { reapUnowned: overrides.reapUnowned } : {}),
  };
}

function createDefaultConfig() {
  return {
    version: 1 as const,
    globalMaxAgents: 10,
    scalers: [
      {
        name: 'container-prod',
        type: 'container' as const,
        maxAgents: 5,
        maxConcurrentSpawns: 2,
        labelSets: [
          { labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' },
          { labels: ['linux', 'node20'], image: 'ghcr.io/org/agent-node20:latest' },
        ],
      },
      {
        name: 'bare-metal-gpu',
        type: 'bare-metal' as const,
        maxAgents: 3,
        maxConcurrentSpawns: 2,
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
      },
    ],
  };
}

/**
 * The bare-metal label set every warm-pool fixture uses, carrying a declared
 * shape. A pool whose label set declares no resources is refused, so both the
 * config entry and the backend that serves it have to name one — the backend
 * factory hands a backend the very label sets its config entry declared, so
 * the two can never disagree in production.
 */
const WARM_GPU_LABEL_SET: LabelSetConfig = {
  labels: ['linux', 'gpu'],
  binaryPath: '/usr/local/bin/kici-agent',
  resources: { requests: { cpus: 1, memory: '1g' } },
};

/** One cpu and one gibibyte: what {@link WARM_GPU_LABEL_SET} reserves per agent. */
const WARM_GPU_USAGE = { cpus: 1, memBytes: 1024 * 1024 * 1024 };

/**
 * Scaler-level defaults a warm-pool fixture declares when its label sets are
 * about something else (taints, gauge dimensions, durable rows). A warm pool is
 * refused unless its resolved shape is declared, and the scaler defaults are
 * the second of the two places that declaration may live.
 */
const WARM_POOL_DEFAULTS = { resources: { requests: { cpus: 1, memory: '1g' } } };

/**
 * A config whose single (bare-metal) scaler runs a warm pool at a declared
 * shape.
 */
function warmConfigWithResources(resourceCap?: { maxCpu?: number; maxMemoryBytes?: number }) {
  const cfg = createDefaultConfig();
  return {
    ...cfg,
    scalers: [
      {
        ...cfg.scalers[1],
        ...(resourceCap ? { resourceCap } : {}),
        warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
        labelSets: [WARM_GPU_LABEL_SET],
      },
    ],
  };
}

type NamedBackend = { name: string; backend: ScalerBackend };

/** A spawn row as the manager built it, however it reached the store. */
type ClaimedSnapshot = Record<string, unknown> & { agentId: string };

/** The `ScalerCapSlot` shape the store hands a cap-check callback. */
type FakeCapSlot = {
  clusterActiveCount: number;
  reserve: (snapshot: ClaimedSnapshot) => Promise<void>;
};

/**
 * Seed a store double's cluster-wide spawn count with `seedCount` rows a peer
 * already holds, and make it grow with every slot claimed through the lock.
 *
 * A constant count would let a manager that checks the cap but never claims
 * its slot pass a test about the cap bounding a cluster — which is the whole
 * defect: the spawn row is what the next holder of the lock counts.
 */
function seedClusterCount<T extends ReturnType<typeof fakeStateStore>>(
  store: T,
  seedCount: number,
): T {
  store.withScalerCapLock = vi.fn(async (_name: string, fn: (slot: FakeCapSlot) => unknown) =>
    fn({
      clusterActiveCount: seedCount + store.upsertSpawningAgent.mock.calls.length,
      reserve: (snapshot) => store.upsertSpawningAgent(snapshot),
    }),
  );
  return store;
}

/**
 * A `ScalerStateStore` double built from spies, for asserting WHICH calls the
 * manager made. Every method resolves to an inert value by default.
 *
 * This is deliberately not the behavioural fake in
 * `__test-helpers__/fake-scaler-state-store.ts`: that one reproduces the real
 * consume-once / TTL / invalidation semantics of `scaler_pending_claims` and is
 * what a test drives when it wants those properties executed. Use this one to
 * observe calls, that one to exercise behaviour — and where a test needs both,
 * spread the behavioural fake's claim methods over this one.
 *
 * `overrides` is checked at runtime against the base shape: a typo'd key
 * (`redeemClam`) would otherwise apply nothing and leave the permissive default
 * in place, and nothing else can catch it — this repo neither lints nor
 * typechecks test files, and the parameter is deliberately untyped so a store
 * method added in a later change is accepted without editing this signature.
 *
 * Every spawn-row write lands on the `upsertSpawningAgent` spy, the cap lock's
 * in-transaction claim included: the real store has one writer for that row, so
 * a double with two would let a test assert against a writer the manager no
 * longer uses and still pass.
 */
function fakeStateStore(overrides: Record<string, unknown> = {}) {
  const upsertSpawningAgent = vi.fn().mockResolvedValue(undefined);
  const base = {
    upsertSpawningAgent,
    deleteSpawningAgent: vi.fn().mockResolvedValue(undefined),
    deleteUnadoptedSpawningAgent: vi.fn().mockResolvedValue(undefined),
    provisionAdopter: vi.fn().mockResolvedValue(null),
    recordProvisionCondemned: vi.fn().mockResolvedValue(undefined),
    purgeProvisionOutcomes: vi.fn().mockResolvedValue(0),
    listSpawningAgents: vi.fn().mockResolvedValue([]),
    listSpawningAgentsForOwner: vi.fn().mockResolvedValue([]),
    adoptSpawningAgent: vi.fn().mockResolvedValue(null),
    listReapCandidates: vi.fn().mockResolvedValue([]),
    withScalerCapLock: vi.fn(async (_name: string, fn: (slot: FakeCapSlot) => unknown) =>
      fn({ clusterActiveCount: 0, reserve: (snapshot) => upsertSpawningAgent(snapshot) }),
    ),
    upsertAgentJob: vi.fn().mockResolvedValue(undefined),
    deleteAgentJob: vi.fn().mockResolvedValue(undefined),
    listAgentJobs: vi.fn().mockResolvedValue([]),
    upsertReservation: vi.fn().mockResolvedValue(undefined),
    deleteReservation: vi.fn().mockResolvedValue(undefined),
    listReservations: vi.fn().mockResolvedValue([]),
    listReservationsForOwner: vi.fn().mockResolvedValue([]),
    registerClaim: vi.fn().mockResolvedValue(undefined),
    redeemClaim: vi.fn().mockResolvedValue(null),
    describeClaim: vi.fn().mockResolvedValue(null),
    invalidateClaimsForAgent: vi.fn().mockResolvedValue(undefined),
  };
  for (const key of Object.keys(overrides)) {
    if (!(key in base)) {
      throw new Error(
        `fakeStateStore: override "${key}" is not a ScalerStateStore method — ` +
          `did you mean one of: ${Object.keys(base).join(', ')}?`,
      );
    }
  }
  return { ...base, ...overrides };
}

/**
 * In-memory stand-in for the `scaler_spawning_agents` table.
 *
 * Spread its `overrides` into a `fakeStateStore` and a test can assert what
 * durably **survives** rather than which method was called — which is the whole
 * question for a row that is the only record of a running cloud instance. Every
 * method mirrors the real SQL predicate, `adoptSpawningAgent`'s
 * `(adopted_by IS NULL OR adopted_by = $instanceId) AND backend_type = 'event'`
 * included: a fake that dropped the backend-type half would adopt rows Postgres
 * refuses to, and one that dropped the self-arm would refuse rows Postgres
 * accepts.
 */
function spawningRowTable() {
  const rows = new Map<string, Record<string, unknown> & { adoptedBy: string | null }>();
  /**
   * The `scaler_provision_outcomes` half. Separate from `rows` on purpose: the
   * whole point of the real table is that it OUTLIVES the spawn row, so a fake
   * that stored the verdict on the spawn row could not reproduce the bug at all.
   */
  const outcomes = new Map<string, { adoptedBy: string | null; condemnedReason: string | null }>();
  const writeRow = async (snapshot: ClaimedSnapshot): Promise<void> => {
    const existing = rows.get(snapshot.agentId);
    // `adopted_by` is never touched by the upsert (see the store's own note).
    rows.set(snapshot.agentId, { ...snapshot, adoptedBy: existing?.adoptedBy ?? null });
  };
  const overrides = {
    upsertSpawningAgent: vi.fn(writeRow),
    // The cap lock's claim writes the same row the plain upsert does — in the
    // real store both are one `INSERT … ON CONFLICT` against
    // `scaler_spawning_agents`. A fake that let the claim land anywhere else
    // would make every spawn through an event backend invisible to this table,
    // and its count would never reflect what the cluster already holds.
    withScalerCapLock: vi.fn(async (scalerName: string, fn: (slot: FakeCapSlot) => unknown) =>
      fn({
        clusterActiveCount: [...rows.values()].filter(
          (row) =>
            row.scalerName === scalerName && row.backendType === ScalerBackendType.enum.event,
        ).length,
        reserve: (snapshot) => overrides.upsertSpawningAgent(snapshot),
      }),
    ),
    listSpawningAgents: vi.fn(async () => [...rows.values()]),
    listSpawningAgentsForOwner: vi.fn(async (instanceId: string) =>
      [...rows.values()].filter((row) => row.ownerInstanceId === instanceId),
    ),
    deleteSpawningAgent: vi.fn(async (agentId: string) => {
      rows.delete(agentId);
    }),
    deleteUnadoptedSpawningAgent: vi.fn(async (agentId: string) => {
      if (rows.get(agentId)?.adoptedBy === null) rows.delete(agentId);
    }),
    // Live row first, surviving outcome second — the real `provisionAdopter`.
    // A row nobody claimed and one that is gone with no outcome both answer
    // null; a torn-down row whose adoption was recorded answers its adopter.
    provisionAdopter: vi.fn(
      async (agentId: string) =>
        rows.get(agentId)?.adoptedBy ?? outcomes.get(agentId)?.adoptedBy ?? null,
    ),
    adoptSpawningAgent: vi.fn(async (agentId: string, instanceId: string) => {
      const row = rows.get(agentId);
      if (!row || row.backendType !== ScalerBackendType.enum.event) return null;
      if (row.adoptedBy !== null && row.adoptedBy !== instanceId) return null;
      row.adoptedBy = instanceId;
      // Mirrors the real store, which writes the outcome in the same
      // transaction as the stamp — a fake that skipped it would let every
      // adopted-then-reaped assertion pass for the wrong reason. First
      // adoption wins, as the real ON CONFLICT's COALESCE does.
      const existing = outcomes.get(agentId);
      outcomes.set(agentId, {
        adoptedBy: existing?.adoptedBy ?? instanceId,
        condemnedReason: existing?.condemnedReason ?? null,
      });
      return { ...row };
    }),
    recordProvisionCondemned: vi.fn(async (agentId: string, _scaler: string, reason: string) => {
      const existing = outcomes.get(agentId);
      // Never clears `adoptedBy` — the real `ON CONFLICT` clause does not touch
      // the adoption columns, and a fake that did would hide the regression.
      outcomes.set(agentId, { adoptedBy: existing?.adoptedBy ?? null, condemnedReason: reason });
    }),
    purgeProvisionOutcomes: vi.fn().mockResolvedValue(0),
  };
  return { rows, outcomes, overrides };
}

/** An event-emitter double matching `ScalerEventEmitterLike`. */
function fakeEmitter() {
  return {
    emitScalerScaleUp: vi.fn().mockResolvedValue('evt-up'),
    emitScalerScaleDown: vi.fn().mockResolvedValue('evt-down'),
  };
}

/**
 * The `github-actions` event-scaler entry the event harness is built around.
 * A fresh object per call: the backend keeps a reference to `labelSets`, so a
 * shared literal would let one test's `reload` bleed into the next.
 */
function eventScalerEntry(): ScalerEntry {
  return {
    name: 'github-actions',
    type: 'event',
    maxAgents: 10,
    maxConcurrentSpawns: DEFAULT_MAX_CONCURRENT_SPAWNS,
    labelSets: [{ labels: ['github-actions'] }],
    provisioningTargets: ['e2e/provision'],
    mandatoryLabels: ['kici:os:linux'],
  };
}

/**
 * A **real** `EventScalerBackend` over the doubles above.
 *
 * It has to be the real class, not a `createMockBackend` look-alike: the
 * manager reaches the event-only lifecycle calls through
 * `instanceof EventScalerBackend`, and a structural stand-in makes that branch
 * silently unreachable — every test built on it would pass without ever
 * entering the code it claims to cover. Building the real thing costs four
 * constructor arguments and additionally exercises the true claim-registration
 * and event-emission paths instead of a spy standing in for them.
 */
function makeEventBackend(
  opts: {
    entry?: ScalerEntry;
    emitter?: ReturnType<typeof fakeEmitter>;
    stateStore?: ReturnType<typeof fakeStateStore>;
  } = {},
): EventScalerBackend {
  const entry = opts.entry ?? eventScalerEntry();
  return new EventScalerBackend({
    entry,
    emitter: opts.emitter ?? fakeEmitter(),
    claimStore: new ClaimStore({
      // Three-arg, so a test redeeming through this backend can observe the
      // TTL the claim carried rather than a two-arg stub silently dropping it.
      createEphemeral: async (agentId, labels, ttlMs) =>
        `kat_${agentId}_${labels.join('+')}_${ttlMs}`,
      stateStore: (opts.stateStore ?? fakeStateStore()) as unknown as ScalerStateStore,
      scalerName: entry.name,
      ttlDefaultSec: DEFAULT_CLAIM_TTL_SECONDS,
    }),
    requestId: () => 'req-1',
  });
}

interface ManagerHarnessOptions {
  backends?: NamedBackend[];
  stateStore?: ReturnType<typeof fakeStateStore>;
  emitter?: ReturnType<typeof fakeEmitter>;
  instanceId?: string;
  claimStore?: { claim: (code: string) => Promise<unknown> };
  config?: ScalerConfig;
  /**
   * Override the event backend `makeManagerWithEventBackend` would build.
   *
   * Typed as the concrete class, not `ScalerBackend`: the manager reaches the
   * event-only lifecycle calls through `instanceof EventScalerBackend`, so a
   * structural stand-in accepted here would make every one of those branches
   * silently unreachable in the test that injected it.
   */
  eventBackend?: EventScalerBackend;
  /** Passed straight through, so a test can configure `machinePools`. */
  machineLedger?: { dir?: string; instanceId: string };
  /** The cluster-wide spawn deadline, which also floors the stale-entry prune. */
  spawnTimeoutMs?: number;
  /**
   * Read-only agent-registry view. Omitted by default, which is what a host
   * with no registry looks like: the warm pool then sees zero ready agents and
   * nothing idle to reap.
   */
  agentRegistry?: ScalerManagerDeps['agentRegistry'];
  /** Relay for attributed scaler events. Defaults to a bare spy. */
  onScalerEvent?: ScalerManagerDeps['onScalerEvent'];
  /** Live external-provision backoff knobs. Omitted → the manager's defaults. */
  resolveProvisionBackoff?: ScalerManagerDeps['resolveProvisionBackoff'];
}

/** Build a `ScalerManager` with the doubles above. */
function makeManager(opts: ManagerHarnessOptions = {}) {
  const stateStore = opts.stateStore ?? fakeStateStore();
  const emitter = opts.emitter ?? fakeEmitter();
  return new ScalerManager({
    config: opts.config ?? createDefaultConfig(),
    backends: opts.backends ?? [],
    stateStore: stateStore as unknown as ScalerStateStore,
    instanceId: opts.instanceId ?? 'orch-test',
    eventEmitter: () => emitter,
    onScalerEvent: opts.onScalerEvent ?? vi.fn(),
    isDraining: () => false,
    spawnTimeoutMs: opts.spawnTimeoutMs ?? 300_000,
    ...(opts.agentRegistry ? { agentRegistry: opts.agentRegistry } : {}),
    ...(opts.resolveProvisionBackoff
      ? { resolveProvisionBackoff: opts.resolveProvisionBackoff }
      : {}),
    ...(opts.claimStore ? { claimStore: opts.claimStore as never } : {}),
    ...(opts.machineLedger ? { machineLedger: opts.machineLedger } : {}),
  });
}

/** Manager with zero backends — the coordinator that never heard of the scaler. */
function makeManagerWithNoBackends(opts: ManagerHarnessOptions = {}) {
  return makeManager({ ...opts, backends: [] });
}

/**
 * Manager whose single backend is a real event backend serving
 * `github-actions`. The manager's config carries the very same entry object, so
 * the name-keyed lookups it makes (`mandatoryLabels`, `roles`) resolve rather
 * than silently falling back to empty, and the backend's own view of the entry
 * can never drift from the manager's.
 */
function makeManagerWithEventBackend(opts: ManagerHarnessOptions = {}) {
  const stateStore = opts.stateStore ?? fakeStateStore();
  const emitter = opts.emitter ?? fakeEmitter();
  const entry = eventScalerEntry();
  const backend = opts.eventBackend ?? makeEventBackend({ entry, emitter, stateStore });
  return makeManager({
    ...opts,
    stateStore,
    emitter,
    backends: [{ name: entry.name, backend }],
    config: opts.config ?? {
      version: 1 as const,
      globalMaxAgents: 100,
      scalers: [entry],
    },
  });
}

/** Manager whose single backend is a local container backend. */
function makeManagerWithContainerBackend(opts: ManagerHarnessOptions = {}) {
  const backend = createMockBackend({
    type: 'container',
    labelSets: [{ labels: ['default'], image: 'ghcr.io/org/agent:latest' }],
    maxAgents: 5,
  });
  return makeManager({
    ...opts,
    backends: [{ name: 'container-prod', backend }],
    config: opts.config ?? {
      version: 1 as const,
      globalMaxAgents: 100,
      scalers: [
        {
          name: 'container-prod',
          type: 'container' as const,
          maxAgents: 5,
          labelSets: [{ labels: ['default'], image: 'ghcr.io/org/agent:latest' }],
        },
      ],
    },
  });
}

describe('ScalerManager', () => {
  let containerBackend: ScalerBackend;
  let bareMetalBackend: ScalerBackend;

  beforeEach(() => {
    vi.useFakeTimers();

    containerBackend = createMockBackend({
      type: 'container',
      labelSets: [
        { labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' },
        { labels: ['linux', 'node20'], image: 'ghcr.io/org/agent-node20:latest' },
      ],
      maxAgents: 5,
    });

    bareMetalBackend = createMockBackend({
      type: 'bare-metal',
      labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
      maxAgents: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(
    configOverrides?: Partial<ReturnType<typeof createDefaultConfig>>,
    backendsOverride?: NamedBackend[],
    onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void,
    createBackend?: (entry: ScalerEntry) => Promise<ScalerBackend | null>,
  ): ScalerManager {
    const config = { ...createDefaultConfig(), ...configOverrides };
    return new ScalerManager({
      instanceId: 'orch-test',
      config,
      backends: backendsOverride ?? [
        { name: 'container-prod', backend: containerBackend },
        { name: 'bare-metal-gpu', backend: bareMetalBackend },
      ],
      onScalerEvent,
      spawnTimeoutMs: 300_000,
      createBackend,
    });
  }

  describe('requestScale()', () => {
    it('routes to correct backend by label set', async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      expect(result).toEqual({ action: 'spawning', backendType: 'container' });
      expect(containerBackend.spawn).toHaveBeenCalled();
    });

    it('is a no-op while draining (no fresh capacity spawned)', async () => {
      const manager = new ScalerManager({
        instanceId: 'orch-test',
        config: createDefaultConfig(),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        isDraining: () => true,
        spawnTimeoutMs: 300_000,
      });

      const result = await manager.requestScale(['linux', 'docker'], 'job-drain', 'run-test');

      expect(result).toEqual({ action: 'skipped', reason: 'draining' });
      expect(containerBackend.spawn).not.toHaveBeenCalled();
    });

    it('routes to bare-metal backend for gpu labels', async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'gpu'], 'job-2', 'run-test');

      expect(result).toEqual({ action: 'spawning', backendType: 'bare-metal' });
      expect(bareMetalBackend.spawn).toHaveBeenCalled();
    });

    it("returns 'no-backend' when no backend matches labels", async () => {
      const manager = createManager();

      const result = await manager.requestScale(['windows', 'arm64'], 'job-3', 'run-test');

      expect(result).toEqual({ action: 'no-backend', labels: ['windows', 'arm64'] });
    });

    it("returns 'at-capacity' when global cap reached", async () => {
      const fullContainerBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 20,
        getActiveCount: () => 10,
      });

      const manager = createManager(
        {
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 20,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: fullContainerBackend }],
      );

      const result = await manager.requestScale(['linux', 'docker'], 'job-4', 'run-test');

      expect(result).toEqual({ action: 'at-capacity' });
    });

    it("returns 'at-capacity' when per-backend cap reached", async () => {
      const fullContainerBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 3,
        getActiveCount: () => 3,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 3,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: fullContainerBackend }],
      );

      const result = await manager.requestScale(['linux', 'docker'], 'job-5', 'run-test');

      expect(result).toEqual({ action: 'at-capacity' });
    });

    it('counts spawning agents toward per-backend capacity via backend.getActiveCount()', async () => {
      // Real backends (container, bare-metal, firecracker) add to their internal
      // agents map synchronously at the start of spawn(). This means getActiveCount()
      // reflects spawning agents immediately, before the spawn promise resolves.
      // The manager relies solely on backend.getActiveCount() for capacity checks
      // and does NOT separately count spawningAgents to avoid double-counting.
      let activeCount = 4;
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        getActiveCount: () => activeCount,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Synchronously increment, matching real backend behavior
          activeCount++;
          return new Promise<ManagedAgent>((resolve) => {
            setTimeout(() => {
              resolve({
                id: agentId,
                labelSet,
                backendRef: `ref-${agentId}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            }, 5000);
          });
        }),
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // First request: activeCount=4, backend increments to 5 during spawn
      const result1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test');
      expect(result1.action).toBe('spawning');

      // Second request: activeCount=5 >= maxAgents(5) -> at-capacity
      const result2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test');
      expect(result2.action).toBe('at-capacity');
    });

    it("returns 'spawning' and triggers async spawn", async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'docker'], 'job-6', 'run-test');

      expect(result.action).toBe('spawning');
      expect((result as { backendType: string }).backendType).toBe('container');
      expect(containerBackend.spawn).toHaveBeenCalledWith(
        ['linux', 'docker'],
        expect.stringMatching(/^scaler-container-[a-f0-9]{8}$/),
        expect.any(String),
        expect.any(Function),
        undefined,
        // A container pool with no declared platform resolves to no taint.
        { boundJobId: 'job-6', runId: 'run-test', platformTaints: [] },
        expect.any(AbortSignal),
      );
    });
  });

  describe('warm pool', () => {
    /** A scaler whose single label set keeps two agents ready. */
    function warmConfig(size = 2) {
      return {
        version: 1 as const,
        globalMaxAgents: 10,
        defaults: WARM_POOL_DEFAULTS,
        scalers: [
          {
            name: 'container-prod',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            warmPool: { enabled: true, size, idleTimeoutSeconds: 300 },
          },
        ],
      };
    }

    function warmPoolOf(manager: ScalerManager) {
      return (manager as unknown as { warmPool: { evaluate(): void } }).warmPool;
    }

    /** Reach the `listIdle` callback the manager handed the warm pool. */
    function listIdleFor(manager: ScalerManager, labels: string[], backendName: string) {
      return (
        manager as unknown as {
          warmPoolCallbacks: {
            listIdle(l: string[], b: string): Array<{ agentId: string; registeredAt: number }>;
          };
        }
      ).warmPoolCallbacks.listIdle(labels, backendName);
    }

    /** A bare-metal backend serving the shape-declaring warm label set. */
    function warmGpuBackend(overrides: Partial<ScalerBackend> = {}): ScalerBackend {
      return createMockBackend({
        type: 'bare-metal',
        labelSets: [WARM_GPU_LABEL_SET],
        maxAgents: 3,
        ...overrides,
      });
    }

    /** Fill a warm pool once, at its declared shape. */
    async function fillWarmPool(
      config = warmConfigWithResources(),
      backend: ScalerBackend = warmGpuBackend(),
    ) {
      const manager = createManager(config, [{ name: 'bare-metal-gpu', backend }]);
      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);
      return { manager, backend, spawn: backend.spawn as ReturnType<typeof vi.fn> };
    }

    /** The bare-metal scaler's in-memory reservation usage. */
    function gpuUsage(manager: ScalerManager) {
      return manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu')?.usage;
    }

    /** How many pools this manager configured. */
    function poolCount(manager: ScalerManager) {
      return (
        manager as unknown as { warmPool: { getStats(): WarmPoolStats[] } }
      ).warmPool.getStats().length;
    }

    it('refuses a warm pool whose label set declares no resources', () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          scalers: [
            { ...cfg.scalers[1], warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 } },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );

      expect(poolCount(manager)).toBe(0);
    });

    it('accepts a warm pool declaring only limits', () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          scalers: [
            {
              ...cfg.scalers[1],
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
              labelSets: [
                {
                  labels: ['linux', 'gpu'],
                  binaryPath: '/usr/local/bin/kici-agent',
                  // Limits alone are a declared shape: they mirror into requests.
                  resources: { limits: { cpus: 2, memory: '2g' } },
                },
              ],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );

      expect(poolCount(manager)).toBe(1);
    });

    it('accepts a warm pool whose shape comes from the scaler defaults', () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          defaults: WARM_POOL_DEFAULTS,
          scalers: [
            { ...cfg.scalers[1], warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 } },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );

      expect(poolCount(manager)).toBe(1);
    });

    it('refuses a shapeless warm pool on a config reload too', async () => {
      const manager = createManager(warmConfigWithResources(), [
        { name: 'bare-metal-gpu', backend: warmGpuBackend() },
      ]);
      expect(poolCount(manager)).toBe(1);

      const shapeless = warmConfigWithResources();
      shapeless.scalers[0].labelSets = [
        { labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' },
      ] as unknown as (typeof shapeless.scalers)[0]['labelSets'];
      const result = await manager.reload(shapeless);

      expect(result.valid).toBe(true);
      expect(poolCount(manager)).toBe(0);
    });

    // The config schema types `memory` as a plain string, so a value like the
    // Kubernetes-style `4Gi` reaches the shape check unvalidated. Constructing
    // at all is the assertion: an unguarded parse throws out of the constructor
    // and takes orchestrator startup with it.
    it('refuses a warm pool whose declared memory cannot be parsed', () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          scalers: [
            {
              ...cfg.scalers[1],
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
              labelSets: [
                {
                  labels: ['linux', 'gpu'],
                  binaryPath: '/usr/local/bin/kici-agent',
                  resources: { requests: { cpus: 2, memory: '4Gi' } },
                },
              ],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );

      expect(poolCount(manager)).toBe(0);
    });

    // Same unparseable declaration, arriving by reload: the throw would escape
    // `applyWarmPoolConfig` after the commit block has already mutated backends
    // and scaler metadata, so `reload` would reject instead of reporting.
    it('refuses an unparseable warm-pool memory on a config reload too', async () => {
      const manager = createManager(warmConfigWithResources(), [
        { name: 'bare-metal-gpu', backend: warmGpuBackend() },
      ]);
      expect(poolCount(manager)).toBe(1);

      const unparseable = warmConfigWithResources();
      unparseable.scalers[0].labelSets = [
        {
          labels: ['linux', 'gpu'],
          binaryPath: '/usr/local/bin/kici-agent',
          resources: { requests: { cpus: 1, memory: '1024' } },
        },
      ] as unknown as (typeof unparseable.scalers)[0]['labelSets'];
      const result = await manager.reload(unparseable);

      expect(result.valid).toBe(true);
      expect(poolCount(manager)).toBe(0);
    });

    it('reserves the label-set shape for a warm spawn', async () => {
      const { manager, spawn } = await fillWarmPool();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(gpuUsage(manager)).toEqual(WARM_GPU_USAGE);
    });

    it('starts the warm agent at the shape it reserved', async () => {
      const { spawn } = await fillWarmPool();

      // The 5th argument is `effectiveLimits`. It is the only carrier of the
      // shape for an event backend (its `scale-up` payload builds `resources`
      // from this and nothing else), so a pre-spawn that reserved a shape and
      // passed `undefined` here would provision an agent of some other size and
      // then match jobs against the reservation.
      expect(spawn.mock.calls[0][4]).toEqual({
        cpus: WARM_GPU_USAGE.cpus,
        memBytes: WARM_GPU_USAGE.memBytes,
      });
    });

    it('does not spawn when the scaler resource cap refuses the warm reservation', async () => {
      const { manager, spawn } = await fillWarmPool(warmConfigWithResources({ maxCpu: 0.5 }));

      expect(spawn).not.toHaveBeenCalled();
      expect(gpuUsage(manager)?.cpus).toBe(0);
    });

    it('releases the reservation when a warm spawn fails', async () => {
      const { manager } = await fillWarmPool(
        warmConfigWithResources(),
        warmGpuBackend({
          spawn: vi.fn(async () => {
            throw new Error('spawn refused');
          }),
        }),
      );

      expect(gpuUsage(manager)?.cpus).toBe(0);
    });

    it('releases the reservation when the idle reaper destroys a warm agent', async () => {
      const { manager, spawn } = await fillWarmPool();
      const agentId = spawn.mock.calls[0][1] as string;
      await manager.onAgentRegistered(agentId, ['linux', 'gpu']);
      expect(gpuUsage(manager)?.cpus).toBe(1);

      await (
        manager as unknown as {
          warmPoolCallbacks: { onDestroyRequest(id: string, backendName: string): Promise<void> };
        }
      ).warmPoolCallbacks.onDestroyRequest(agentId, 'bare-metal-gpu');

      expect(gpuUsage(manager)?.cpus).toBe(0);
    });

    describe('canPrespawnedAgentServe()', () => {
      /** Fill the pool and register its agent, returning the manager + agent id. */
      async function readyWarmAgent() {
        const { manager, spawn } = await fillWarmPool();
        const warmId = spawn.mock.calls[0][1] as string;
        await manager.onAgentRegistered(warmId, ['linux', 'gpu']);
        return { manager, warmId };
      }

      it('allows any agent this scaler did not pre-spawn', async () => {
        const { manager } = await readyWarmAgent();

        expect(
          manager.canPrespawnedAgentServe('static-agent', { hasOwnContainerImage: false }),
        ).toBe(true);
      });

      it('refuses a warm agent for a job that brings its own container image', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(manager.canPrespawnedAgentServe(warmId, { hasOwnContainerImage: true })).toBe(false);
      });

      it('refuses a warm agent for a job asking for a different shape', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 8, memory: '16g' } },
          }),
        ).toBe(false);
      });

      it('allows a warm agent for a job asking for the shape it was spawned at', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 1, memory: '1g' } },
          }),
        ).toBe(true);
      });

      it('allows a warm agent for a job that declares no resources', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(manager.canPrespawnedAgentServe(warmId, { hasOwnContainerImage: false })).toBe(true);
      });

      it('compares only the fields the job declares', async () => {
        const { manager, warmId } = await readyWarmAgent();

        // cpus matches the pool and memory is left to the label set, so this
        // job resolves to exactly the shape the agent already has.
        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 1 } },
          }),
        ).toBe(true);
        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 4 } },
          }),
        ).toBe(false);
      });

      it('reads a limits-only declaration as a shape', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { limits: { cpus: 4 } },
          }),
        ).toBe(false);
      });

      it('refuses a job whose declared limits differ from the shape the agent runs at', async () => {
        const { manager, warmId } = await readyWarmAgent();

        // The pool resolves to 1 cpu on BOTH sides, so requests alone would
        // admit this job — onto an agent the kernel caps at 1 while the job
        // asked for 8. That is the same defect on the other dimension.
        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 1 }, limits: { cpus: 8 } },
          }),
        ).toBe(false);
      });

      it('fails open on the limits side of a rehydrated reservation', async () => {
        const { manager, warmId } = await readyWarmAgent();
        // What `recoverState` produces: the persisted row carries requests only.
        const reservations = (
          manager as unknown as { reservations: Map<string, { limits?: unknown }> }
        ).reservations;
        delete reservations.get(warmId)!.limits;

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 1 }, limits: { cpus: 8 } },
          }),
        ).toBe(true);
        // The requests half is still compared — only the limits half went dark.
        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 8 }, limits: { cpus: 8 } },
          }),
        ).toBe(false);
      });

      it('fails open on a memory string it cannot parse', async () => {
        const { manager, warmId } = await readyWarmAgent();

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { memory: 'not-a-size' } },
          }),
        ).toBe(true);
      });

      it('fails open on a warm agent holding no reservation', async () => {
        const { manager, warmId } = await readyWarmAgent();
        (manager as unknown as { reservations: Map<string, unknown> }).reservations.delete(warmId);

        expect(
          manager.canPrespawnedAgentServe(warmId, {
            hasOwnContainerImage: false,
            resources: { requests: { cpus: 8 } },
          }),
        ).toBe(true);
      });
    });

    it('pre-spawns up to the target with no job pending', async () => {
      const manager = makeManager({
        config: warmConfig(2),
        backends: [{ name: 'container-prod', backend: containerBackend }],
      });
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);

      expect(containerBackend.spawn).toHaveBeenCalledTimes(2);
      // A warm spawn carries no bound job — that is what makes it a pre-spawn
      // rather than a reaction to a queued job. It still carries the pool's
      // platform taints, so the agent it starts is one the pool can count.
      const warmContext = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][5] as SpawnContext;
      expect(warmContext.boundJobId).toBeUndefined();
      expect(warmContext.runId).toBeUndefined();
    });

    it('offers a warm agent to the reaper', async () => {
      const registered: Array<{ agentId: string; activeJobs: number; registeredAt: number }> = [];
      const manager = makeManager({
        config: warmConfig(1),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        agentRegistry: { findAvailable: () => registered },
      });
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await manager.onAgentRegistered(agentId, ['linux', 'docker']);
      registered.push({ agentId, activeJobs: 0, registeredAt: Date.now() });

      expect(
        listIdleFor(manager, ['linux', 'docker'], 'container-prod').map((a) => a.agentId),
      ).toContain(agentId);
    });

    it('does not offer a job-bound agent to the reaper', async () => {
      const registered: Array<{ agentId: string; activeJobs: number; registeredAt: number }> = [];
      const manager = makeManager({
        config: warmConfig(1),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        agentRegistry: { findAvailable: () => registered },
      });
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      // A job-bound spawn: registered, but its dispatch has not arrived yet, so
      // it still reports activeJobs === 0.
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await manager.onAgentRegistered(agentId, ['linux', 'docker']);
      registered.push({ agentId, activeJobs: 0, registeredAt: Date.now() });

      expect(
        listIdleFor(manager, ['linux', 'docker'], 'container-prod').map((a) => a.agentId),
      ).not.toContain(agentId);
      // It is still capacity, though — the deficit must not spawn over it.
      expect(manager.getStatus().warmPoolCount).toBe(1);
    });

    it('marks a registered warm agent scaler-managed and releases its slot', async () => {
      const registered: Array<{ agentId: string; activeJobs: number; registeredAt: number }> = [];
      const manager = makeManager({
        config: warmConfig(1),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        agentRegistry: { findAvailable: () => registered },
      });
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;

      // The spawning entry survived the successful spawn, so registration
      // correlates and the agent is adopted as scaler-managed.
      const result = await manager.onAgentRegistered(agentId, ['linux', 'docker']);
      expect(result).not.toBeNull();
      registered.push({ agentId, activeJobs: 0, registeredAt: Date.now() });

      // At target now: the next pass must not spawn a second agent.
      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);
      expect(containerBackend.spawn).toHaveBeenCalledTimes(1);
    });

    it('does not fill past the scaler cap', async () => {
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 1,
      });
      const manager = makeManager({
        config: {
          ...warmConfig(4),
          scalers: [{ ...warmConfig(4).scalers[0], maxAgents: 1 }],
        },
        backends: [{ name: 'container-prod', backend }],
      });

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);

      // Warm spawns take no reservation, so the cap has to be honoured here or
      // a pool with an unreachable target spawns `size` agents every tick.
      expect(backend.spawn).toHaveBeenCalledTimes(1);
    });

    it('reports the registry-backed ready count as warmPoolCount', () => {
      const registered = [
        { agentId: 'warm-1', activeJobs: 0, registeredAt: 1000 },
        { agentId: 'warm-2', activeJobs: 0, registeredAt: 2000 },
      ];
      const manager = makeManager({
        config: warmConfig(2),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        agentRegistry: { findAvailable: () => registered },
      });

      expect(manager.getStatus().warmPoolCount).toBe(2);
    });

    it('reports zero ready on a host with no registry', () => {
      const manager = makeManager({
        config: warmConfig(2),
        backends: [{ name: 'container-prod', backend: containerBackend }],
      });

      expect(manager.getStatus().warmPoolCount).toBe(0);
    });

    it('does not re-destroy a warm agent whose teardown is still in flight', async () => {
      // A backend whose destroy outlives a tick. The agent stays idle-listed
      // until the teardown settles, so the next reap pass selects it again —
      // and without the in-flight guard the backend is handed a second destroy
      // and the reaped counter advances twice for one agent.
      let settle!: () => void;
      const destroy = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        destroy,
      });
      const manager = makeManager({
        config: warmConfig(1),
        backends: [{ name: 'container-prod', backend }],
      });
      const destroyRequest = (
        manager as unknown as {
          warmPoolCallbacks: { onDestroyRequest(id: string, backendName: string): Promise<void> };
        }
      ).warmPoolCallbacks.onDestroyRequest;

      const first = destroyRequest('warm-1', 'container-prod');
      const second = destroyRequest('warm-1', 'container-prod');
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).toHaveBeenCalledTimes(1);

      // The guard releases on settle, so the same agent can be reaped again if
      // it ever comes back — the entry is not held for the manager's lifetime.
      settle();
      await Promise.all([first, second]);
      void destroyRequest('warm-1', 'container-prod');
      await vi.advanceTimersByTimeAsync(0);
      expect(destroy).toHaveBeenCalledTimes(2);
      settle();
    });

    it('fills a pool whose taint is not on its declared label set', async () => {
      // A bare-metal pool declaring a structured windows platform without also
      // declaring `windows` as a label. The taint lands on every agent's
      // mandatoryLabels gate, so the readiness query has to carry it too — and
      // the agent has to register with it. Both now hold, so the pool fills
      // instead of being refused as unfillable.
      const backend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows-2022'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 5,
      });
      const manager = makeManager({
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win-pool',
              type: 'bare-metal' as const,
              maxAgents: 5,
              platform: { os: 'windows' as const, arch: 'x64' as const },
              labelSets: [
                {
                  labels: ['windows-2022'],
                  binaryPath: '/kici-agent.exe',
                  resources: { requests: { cpus: 1, memory: '1g' } },
                },
              ],
              warmPool: { enabled: true, size: 3, idleTimeoutSeconds: 300 },
            },
          ],
        },
        backends: [{ name: 'win-pool', backend }],
      });

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);

      expect(backend.spawn).toHaveBeenCalledTimes(3);
      // Every spawn carries the taint, so the agents it starts are ones this
      // pool's own readiness query — and the dispatcher — can find.
      for (const call of (backend.spawn as ReturnType<typeof vi.fn>).mock.calls) {
        expect((call[5] as SpawnContext).platformTaints).toEqual(['windows']);
        // The taint travels in the spawn context, never in the requested label
        // set: a backend resolves its binary by matching that set against its
        // own `labelSets` and throws on one it does not have.
        expect(call[0]).toEqual(['windows-2022']);
      }
      // The query the pool measures readiness with carries it too.
      const stats = (
        manager as unknown as { warmPool: { getStats(): WarmPoolStats[] } }
      ).warmPool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].labels).toEqual(expect.arrayContaining(['windows-2022', 'windows']));
    });

    it('fills a tainted pool that declares its taint on the label set', async () => {
      // The positive control: same structured platform, but `windows` is also a
      // declared label, so the gate is satisfied and the query sees its agents.
      const backend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows', 'windows-2022'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 5,
      });
      const manager = makeManager({
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win-pool',
              type: 'bare-metal' as const,
              maxAgents: 5,
              platform: { os: 'windows' as const, arch: 'x64' as const },
              labelSets: [
                {
                  labels: ['windows', 'windows-2022'],
                  binaryPath: '/kici-agent.exe',
                  resources: { requests: { cpus: 1, memory: '1g' } },
                },
              ],
              warmPool: { enabled: true, size: 2, idleTimeoutSeconds: 300 },
            },
          ],
        },
        backends: [{ name: 'win-pool', backend }],
      });

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);

      expect(backend.spawn).toHaveBeenCalledTimes(2);
    });

    it('does not consult the pool from requestScale', async () => {
      const manager = makeManager({
        config: warmConfig(2),
        backends: [{ name: 'container-prod', backend: containerBackend }],
      });
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      // `requestScale` runs only once the dispatcher found no available agent,
      // so a ready warm agent was already dispatched: there is nothing to claim
      // and the request must spawn.
      const result = await manager.requestScale(['linux', 'docker'], 'job-warm', 'run-test');

      expect(result.action).toBe('spawning');
      expect(containerBackend.spawn).toHaveBeenCalledTimes(1);
    });

    it('enables a warm pool on a tainted scaler and queries with the taint', () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          defaults: WARM_POOL_DEFAULTS,
          scalers: [
            {
              ...cfg.scalers[1],
              platform: { os: 'linux' as const, arch: 'arm64' as const },
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );

      const stats = (
        manager as unknown as { warmPool: { getStats(): WarmPoolStats[] } }
      ).warmPool.getStats();

      // The pool used to be refused outright: its agents' gate carries `arm64`,
      // which the readiness query built from the declared labels alone never
      // contained.
      expect(stats).toHaveLength(1);
      expect(stats[0].labels).toContain('arm64');
      expect(stats[0].labels).toEqual(expect.arrayContaining(['linux', 'gpu']));
    });

    it('spawns a warm agent carrying the pool taint the readiness query demands', async () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          defaults: WARM_POOL_DEFAULTS,
          scalers: [
            {
              ...cfg.scalers[1],
              platform: { os: 'linux' as const, arch: 'arm64' as const },
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );
      (bareMetalBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      (manager as unknown as { warmPool: { evaluate(): void } }).warmPool.evaluate();
      await vi.advanceTimersByTimeAsync(0);

      const call = (bareMetalBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      // The spawn is still unbound — a warm pre-spawn, not a reaction to a job.
      expect((call[5] as SpawnContext).boundJobId).toBeUndefined();
      // …but it carries the taints, so the agent registers with the label its
      // own pool's readiness query and the dispatcher both ask for.
      expect((call[5] as SpawnContext).platformTaints).toEqual(['arm64']);
      // The backend is still asked for its own declared label set — the widened
      // readiness query is not a set it has configured.
      expect(call[0]).toEqual(['linux', 'gpu']);
    });

    it('asks a tainted pool for a label set its backend actually has configured', async () => {
      // Every real backend resolves the image / binary / VM config by matching
      // the requested set against its own `labelSets` and throws on anything
      // else, so a request widened by the pool's taint is a spawn that can never
      // succeed. This backend enforces that contract, so a widened request fails
      // the test instead of being silently accepted by a permissive double.
      const cfg = createDefaultConfig();
      const declared = cfg.scalers[1].labelSets[0].labels;
      const refused: string[][] = [];
      const backend = createMockBackend({
        type: 'bare-metal',
        labelSets: cfg.scalers[1].labelSets,
        maxAgents: 3,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          if (normalizeLabelSet(labelSet) !== normalizeLabelSet(declared)) {
            refused.push(labelSet);
            throw new Error(`Label set [${labelSet.join(', ')}] not supported`);
          }
          return {
            id: agentId,
            labelSet,
            backendRef: `ref-${agentId}`,
            spawnedAt: Date.now(),
            state: 'running',
          };
        }),
      });
      const manager = createManager(
        {
          defaults: WARM_POOL_DEFAULTS,
          scalers: [
            {
              ...cfg.scalers[1],
              platform: { os: 'linux' as const, arch: 'arm64' as const },
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend }],
      );

      warmPoolOf(manager).evaluate();
      await vi.advanceTimersByTimeAsync(0);

      expect(refused).toEqual([]);
      expect(backend.spawn).toHaveBeenCalledTimes(1);
    });

    it('gives each pool of a tainted scaler its own gauge series', async () => {
      // Two label sets on one tainted scaler can widen to the SAME readiness
      // query — here `[linux, gpu]` gains `arm64` from the taint, which the
      // other set already declares. They are still two pools with their own
      // target and fill, so the gauge dimension has to key on the pool rather
      // than on the widened query: an identical dimension makes the second row
      // overwrite the first and a whole pool vanishes from the gauges.
      const labelSets = [
        {
          labels: ['linux', 'gpu'],
          binaryPath: '/usr/local/bin/kici-agent',
          resources: { requests: { cpus: 1, memory: '1g' } },
        },
        {
          labels: ['linux', 'gpu', 'arm64'],
          binaryPath: '/usr/local/bin/kici-agent',
          resources: { requests: { cpus: 1, memory: '1g' } },
        },
      ];
      const backend = createMockBackend({ type: 'bare-metal', labelSets, maxAgents: 3 });
      const manager = createManager(
        {
          scalers: [
            {
              name: 'bare-metal-gpu',
              type: 'bare-metal' as const,
              maxAgents: 3,
              maxConcurrentSpawns: 2,
              platform: { os: 'linux' as const, arch: 'arm64' as const },
              labelSets,
              warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend }],
      );
      vi.mocked(setWarmPoolGauges).mockClear();

      (manager as unknown as { publishWarmPoolGauges(): void }).publishWarmPoolGauges();

      const rows = vi.mocked(setWarmPoolGauges).mock.calls.at(-1)![0];
      // Both pools are reported, each under the label set the operator declared.
      expect(rows.map((r) => r.labelSet).sort()).toEqual(['arm64,gpu,linux', 'gpu,linux']);
    });

    it('supplies the pool taints on a job-bound spawn too', async () => {
      const cfg = createDefaultConfig();
      const manager = createManager(
        {
          scalers: [
            {
              ...cfg.scalers[1],
              platform: { os: 'linux' as const, arch: 'arm64' as const },
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'bare-metal-gpu', backend: bareMetalBackend }],
      );
      (bareMetalBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      const result = await manager.requestScale(['linux', 'gpu', 'arm64'], 'job-arm', 'run-test');

      expect(result.action).toBe('spawning');
      const call = (bareMetalBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((call[5] as SpawnContext).platformTaints).toEqual(['arm64']);
    });
  });

  describe('spawn throttling (maxConcurrentSpawns)', () => {
    /** Yield a macrotask so all pending microtasks (semaphore hand-offs) flush. */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('never runs more than maxConcurrentSpawns concurrent backend.spawn per backend', async () => {
      // Real timers: the semaphore hand-off is a microtask chain, not a timer.
      vi.useRealTimers();

      let inFlight = 0;
      let peak = 0;
      const releasers: Array<() => void> = [];
      const spawn = vi.fn((labelSet: string[], agentId: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise<ManagedAgent>((resolve) => {
          releasers.push(() => {
            inFlight--;
            resolve({
              id: agentId,
              labelSet,
              backendRef: `ref-${agentId}`,
              spawnedAt: Date.now(),
              state: 'running',
            });
          });
        });
      });

      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        // Population cap never hit — isolate the provisioning-rate throttle.
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 3,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      // Fire 20 in-cap scale requests. Each reserves + kicks a throttled spawn.
      for (let i = 0; i < 20; i++) {
        const result = await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
        expect(result.action).toBe('spawning');
      }
      await flush();

      // Only maxConcurrentSpawns (3) provision at once; the rest queue.
      expect(peak).toBeLessThanOrEqual(3);
      expect(spawn).toHaveBeenCalledTimes(3);

      // Drain: release the in-flight spawns in batches; each release lets the
      // semaphore admit the next queued spawn. Peak must stay at or below 3.
      let released = 0;
      while (released < 20) {
        await flush();
        const batch = releasers.splice(0);
        if (batch.length === 0) break;
        batch.forEach((release) => release());
        released += batch.length;
      }
      await flush();

      // All 20 eventually spawned; the cap was never exceeded.
      expect(spawn).toHaveBeenCalledTimes(20);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('releases a semaphore slot when a spawn rejects (no permanent starvation)', async () => {
      vi.useRealTimers();

      let inFlight = 0;
      let peak = 0;
      let call = 0;
      const releasers: Array<() => void> = [];
      const rejecters: Array<() => void> = [];
      const spawn = vi.fn(() => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const mine = call++;
        return new Promise<ManagedAgent>((resolve, reject) => {
          // Every 2nd spawn rejects; its slot must still be freed via finally.
          if (mine % 2 === 0) {
            rejecters.push(() => {
              inFlight--;
              reject(new Error('boom'));
            });
          } else {
            releasers.push(() => {
              inFlight--;
              resolve({
                id: `agent-${mine}`,
                labelSet: ['linux', 'docker'],
                backendRef: `ref-${mine}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            });
          }
        });
      });

      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 2,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      for (let i = 0; i < 6; i++) {
        await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
      }
      await flush();
      expect(spawn).toHaveBeenCalledTimes(2);

      // Drain a mix of rejects and resolves; a rejected spawn must free its slot
      // so the next queued spawn proceeds — otherwise the queue would wedge.
      let settled = 0;
      while (settled < 6) {
        await flush();
        const toReject = rejecters.splice(0);
        const toResolve = releasers.splice(0);
        if (toReject.length === 0 && toResolve.length === 0) break;
        toReject.forEach((r) => r());
        toResolve.forEach((r) => r());
        settled += toReject.length + toResolve.length;
      }
      await flush();

      expect(spawn).toHaveBeenCalledTimes(6);
      expect(peak).toBeLessThanOrEqual(2);
    });

    it('does not prune spawns still queued behind the semaphore, only started-and-stale ones', async () => {
      // Fake timers (the suite default) so we can advance past the 5-min
      // stale-prune threshold. One slot, a spawn that never resolves — it holds
      // the slot so the other two requests stay queued.
      const spawn = vi.fn(() => new Promise<ManagedAgent>(() => {}));
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 1,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      // 3 in-cap requests: 1 spawn starts (occupies the only slot), 2 queue.
      for (let i = 0; i < 3; i++) {
        await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
      }
      await vi.advanceTimersByTimeAsync(0); // let the admitted spawn start
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().spawningCount).toBe(3);

      // Advance well past the 5-min stale window, then trigger a prune via a
      // no-match request (prunes first, then returns without adding an entry).
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const noMatch = await manager.requestScale(['windows', 'arm64'], 'job-x', 'run-x');
      expect(noMatch.action).toBe('no-backend');

      // The started-but-never-registered spawn is reaped; the two still-queued
      // spawns survive (they had not started, so the stale clock never began).
      expect(manager.getStatus().spawningCount).toBe(2);
    });

    it('drops the buffered failure of a pruned spawn, whose correlation can never arrive', async () => {
      // A warm spawn's `scaler.failed` resolves to no run/job, so it is parked
      // waiting for a correlation. The prune is the moment that wait becomes
      // provably futile — the same reasoning that makes the prune the only
      // place the reservation can be freed — so the entry has to go with it, or
      // the buffer keeps one dead event per pruned warm spawn forever.
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      await manager.requestScale(['linux', 'docker'], undefined, undefined);
      await vi.advanceTimersByTimeAsync(0);
      const spawnCall = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const agentId = spawnCall[1] as string;
      const onEvent = spawnCall[3] as (event: ScalerEvent) => void;

      onEvent({
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'agent process error: spawn node ENOENT',
        timestampMs: Date.now(),
      });
      expect(onScalerEvent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect((await manager.requestScale(['windows', 'arm64'], 'job-x', 'run-x')).action).toBe(
        'no-backend',
      );

      // Nothing is left to hand a late correlation naming the same agent.
      manager.correlateAgentToJob(agentId, 'run-late', 'job-late');
      expect(onScalerEvent).not.toHaveBeenCalled();
    });
  });

  describe('onAgentRegistered()', () => {
    it('correlates spawned agent to tracking entry', async () => {
      const manager = createManager();

      // Trigger a spawn
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      // Get the agentId from the spawn call
      const spawnCall = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const agentId = spawnCall[1] as string;

      // Let spawn complete
      await vi.advanceTimersToNextTimerAsync();

      // Register the agent
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Verify agent is now in managedAgentIndex (check via getStatus)
      const status = manager.getStatus();
      expect(status.spawningCount).toBe(0);
    });

    it('returns the bound jobId so the orchestrator can eager-dispatch it', async () => {
      const manager = createManager();

      // Trigger a spawn for a specific queued jobId
      await manager.requestScale(['linux', 'docker'], 'queued-job-42', 'run-test');

      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();

      // Registration should hand back the queued jobId so the agent-handler
      // can dispatch it directly, bypassing the generic queue drain race.
      // mandatoryLabels is always returned (empty here — this scaler has no gate).
      const result = await manager.onAgentRegistered(agentId, ['linux', 'docker']);
      expect(result).toEqual({ boundJobId: 'queued-job-42', mandatoryLabels: [] });
    });

    it('returns null for unknown (static) agents', async () => {
      const manager = createManager();
      const result = await manager.onAgentRegistered('static-agent-1', ['linux', 'docker']);
      expect(result).toBeNull();
    });

    it('removes from spawningAgents on registration', async () => {
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        spawn: vi.fn(
          async (labelSet: string[], agentId: string): Promise<ManagedAgent> =>
            new Promise<ManagedAgent>((resolve) => {
              setTimeout(() => {
                resolve({
                  id: agentId,
                  labelSet,
                  backendRef: `ref-${agentId}`,
                  spawnedAt: Date.now(),
                  state: 'running',
                });
              }, 10_000);
            }),
        ),
      });

      const manager = createManager(
        {
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (slowBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

      // Before registration, spawning count = 1
      expect(manager.getStatus().spawningCount).toBe(1);

      // Agent registers (before spawn promise resolves)
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Spawning count should be 0
      expect(manager.getStatus().spawningCount).toBe(0);
    });

    it('ignores non-scaler-managed agents', () => {
      const manager = createManager();

      // This should not throw
      manager.onAgentRegistered('static-agent-1', ['linux', 'docker']);

      // Status should show 0 spawning
      expect(manager.getStatus().spawningCount).toBe(0);
    });
  });

  describe('onAgentRegistered() — adoption across instances', () => {
    /** The spawn row instance `orch-a` wrote for an event-scaler agent. */
    function spawnRow(overrides: Record<string, unknown> = {}) {
      return {
        agentId: 'agent-77',
        scalerName: 'github-actions',
        labelSet: ['github-actions'],
        boundJobId: 'job-1',
        mandatoryLabels: ['kici:os:linux'],
        provisioningTargets: ['e2e/provision'],
        backendType: 'event',
        spawnedAt: new Date(),
        ownerInstanceId: 'orch-a',
        ...overrides,
      };
    }

    it('stamps the ownership columns onto the spawn row, or nothing can adopt it', async () => {
      // `adoptSpawningAgent` matches on `backend_type = 'event'`, so a row
      // written without it is unadoptable by every instance — including the one
      // that spawned it — and the whole path below is inert. `mandatory_labels`
      // is likewise the only source of the taint for a coordinator that has no
      // config entry for this scaler, and `owner_instance_id` is what scopes
      // recovery to the spawner.
      const stateStore = fakeStateStore();
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');

      expect(stateStore.upsertSpawningAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerInstanceId: 'orch-a',
          backendType: ScalerBackendType.enum.event,
          mandatoryLabels: ['kici:os:linux'],
          boundJobId: 'job-1',
        }),
      );
    });

    it('stamps the run id onto the spawn row, or a failure has nothing to attribute to', async () => {
      // The reaper is leader-gated, so the coordinator that condemns a stranded
      // provision is routinely not the one that spawned it and has no in-memory
      // spawning entry to read the identity from. `onScalerEvent` needs BOTH
      // halves, so a row missing the run id leaves the waiting job with a
      // label-mismatch message instead of the provisioning cause.
      const stateStore = fakeStateStore();
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');

      expect(stateStore.upsertSpawningAgent).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', boundJobId: 'job-1' }),
      );
    });

    it('adopts a registering agent whose spawn row belongs to another instance', async () => {
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(spawnRow()),
      });
      const manager = makeManager({ stateStore, instanceId: 'orch-b' });

      const result = await manager.onAgentRegistered('agent-77', ['github-actions']);

      expect(stateStore.adoptSpawningAgent).toHaveBeenCalledWith('agent-77', 'orch-b');
      expect(result).toEqual({ boundJobId: 'job-1', mandatoryLabels: ['kici:os:linux'] });
    });

    it('stamps the persisted mandatory labels even with no local backend for that scaler', async () => {
      // The coordinator the agent reached has an empty scalers.yaml, so the
      // taint can come only from the persisted spawn record. This is the
      // wrong-OS-job hole.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(spawnRow()),
      });
      const manager = makeManagerWithNoBackends({ stateStore, instanceId: 'orch-b' });

      const result = await manager.onAgentRegistered('agent-77', ['github-actions']);

      expect(result?.mandatoryLabels).toEqual(['kici:os:linux']);
    });

    it('seeds the local event backend so a disconnect still tears the provision down', async () => {
      // Adoption without seeding leaves `EventScalerBackend.destroy()` at its
      // unknown-id guard: every other part of adoption works and the customer's
      // cloud instance still leaks, silently.
      const emitter = fakeEmitter();
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(spawnRow()),
      });
      const manager = makeManagerWithEventBackend({ stateStore, emitter, instanceId: 'orch-b' });

      await manager.onAgentRegistered('agent-77', ['github-actions']);
      manager.onAgentDisconnected('agent-77');

      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({
          scalerName: 'github-actions',
          agentId: 'agent-77',
          reason: 'shutdown',
        }),
        ['e2e/provision'],
      );
    });

    it('returns null when another instance already adopted the agent', async () => {
      // `agent-77` deliberately carries no `scaler-` prefix, so it takes the
      // static path. A scaler-minted id is refused here instead — see the
      // `no spawn record for a scaler-minted id` block.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(null),
      });
      const manager = makeManager({ stateStore, instanceId: 'orch-b' });

      expect(await manager.onAgentRegistered('agent-77', ['github-actions'])).toBeNull();
      // `null` is also what a never-consulted store would produce, so pin that
      // the losing conditional UPDATE is what returned it.
      expect(stateStore.adoptSpawningAgent).toHaveBeenCalledWith('agent-77', 'orch-b');
    });

    it('treats the agent as static when the adoption lookup throws', async () => {
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockRejectedValue(new Error('connection terminated')),
      });
      const manager = makeManager({ stateStore, instanceId: 'orch-b' });

      expect(await manager.onAgentRegistered('agent-77', ['github-actions'])).toBeNull();
      expect(stateStore.adoptSpawningAgent).toHaveBeenCalledTimes(1);
    });

    it('keeps the durable row when an event agent registers on its own spawner', async () => {
      // The single-coordinator shape: spawn and register on the same instance.
      // The row is the only pointer to the customer's cloud instance, so it must
      // survive registration — stamped as adopted here — rather than being
      // deleted the way a local-backend row is.
      const table = spawningRowTable();
      const stateStore = fakeStateStore(table.overrides);
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...table.rows.keys()][0]!;

      const result = await manager.onAgentRegistered(agentId, ['github-actions']);

      // The local in-memory entry answered, so this is not the adoption path…
      expect(result).toEqual({ boundJobId: 'job-1', mandatoryLabels: ['kici:os:linux'] });
      // …and yet the row is still there, now owned by this instance.
      expect(table.rows.has(agentId)).toBe(true);
      expect(table.rows.get(agentId)?.adoptedBy).toBe('orch-a');
      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
    });

    it('spares a self-adopted row when a restart rehydrates it into the prune', async () => {
      // The only shape in which the prune can reach a registered agent at all:
      // `completeLocalRegistration` drops the in-memory entry first, so the
      // prune loop skips the agent entirely while this process lives. A restart
      // rehydrates the row — already stale, because `recoverState` measures
      // staleness from the persisted enqueue time — and the next `requestScale`
      // genuinely prunes it. Only the `adopted_by IS NULL` predicate saves the
      // row, and with it the pointer to the customer's running instance.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const spawner = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      await spawner.onAgentRegistered(agentId, ['github-actions']);
      expect(rows.get(agentId)?.adoptedBy).toBe('orch-a');

      const restarted = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });
      await restarted.recoverState();
      // The row really is back in the map the prune walks — without this the
      // assertions below would hold over an agent the loop never visits.
      expect(restarted.getStatus().spawningCount).toBe(1);

      await vi.advanceTimersByTimeAsync(301_000);
      await restarted.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');

      // The prune reached it — the in-memory entry is gone…
      expect(restarted.getStatus().spawningCount).toBe(1); // the job-2 spawn, not this one
      // …and the row survived, because the prune deletes no event row at all.
      expect(rows.has(agentId)).toBe(true);
      expect(stateStore.deleteUnadoptedSpawningAgent).not.toHaveBeenCalled();
    });

    it('spares a stale event row whose scaler is no longer configured here', async () => {
      // Removing an event scaler from the config leaves its in-flight rows
      // behind, and `recoverState` rehydrates every row this instance owns
      // whether or not the scaler still exists. Reading "no backend configured"
      // as "not an event scaler" would delete each one on the first prune after
      // the restart — and with the row goes the only pointer at the customer's
      // running cloud instance, so nothing ever tears it down.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const spawner = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      expect(rows.get(agentId)?.backendType).toBe(ScalerBackendType.enum.event);

      // The restart: same instance id, but the scaler is gone from its config,
      // so it has no backend to recognise the row by.
      const restarted = makeManagerWithNoBackends({ stateStore, instanceId: 'orch-a' });
      await restarted.recoverState();
      // The row really is in the map the prune walks — without this the
      // assertions below would hold over an entry the loop never visits.
      expect(restarted.getStatus().spawningCount).toBe(1);

      await vi.advanceTimersByTimeAsync(301_000);
      // A request that matches nothing still prunes first.
      await restarted.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');

      // The prune reached the entry…
      expect(restarted.getStatus().spawningCount).toBe(0);
      // …and left the row for the reaper, exactly as it does when the scaler is
      // still configured.
      expect(rows.has(agentId)).toBe(true);
      expect(stateStore.deleteUnadoptedSpawningAgent).not.toHaveBeenCalled();
      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
    });

    it('still deletes the durable row when a local-backend agent registers', async () => {
      // The complement: a container agent's compute is pinned to this host, so
      // the process dying IS the teardown and the row is spawn-time scratch.
      const table = spawningRowTable();
      const stateStore = fakeStateStore(table.overrides);
      const manager = makeManagerWithContainerBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['default'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...table.rows.keys()][0]!;

      await manager.onAgentRegistered(agentId, ['default']);

      expect(table.rows.has(agentId)).toBe(false);
      expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith(agentId);
      expect(stateStore.adoptSpawningAgent).not.toHaveBeenCalled();
    });

    it('leaves a warm-pool event spawn row for the registering coordinator to adopt', async () => {
      // An event `spawn()` resolves when the scale-up event is emitted, long
      // before any agent registers — so the warm-pool success path must not
      // treat "spawn returned" as "this row is finished".
      const table = spawningRowTable();
      const stateStore = fakeStateStore(table.overrides);
      const emitter = fakeEmitter();
      const entry: ScalerEntry = {
        ...eventScalerEntry(),
        // A validated config can never gate on a `kici:` label (they are reserved
        // in both `labelSets` and `mandatoryLabels`), and every configured gate
        // label must appear in every label set. The shared fixture's
        // `kici:os:linux` gate satisfies neither, and a warm pool whose gate
        // escapes its label set is refused as unfillable — correctly, since the
        // readiness query could never see its own agents.
        mandatoryLabels: ['github-actions'],
        // A warm pool needs a declared shape: it starts an agent before any job
        // exists, so its cpu/memory can come from nowhere else.
        labelSets: [
          { labels: ['github-actions'], resources: { requests: { cpus: 1, memory: '1g' } } },
        ],
        warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
      };
      const manager = makeManager({
        stateStore,
        emitter,
        instanceId: 'orch-a',
        backends: [{ name: entry.name, backend: makeEventBackend({ entry, emitter, stateStore }) }],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [entry] },
      });

      // The manager exposes no public pool-fill trigger, so drive the pool's own
      // deficit pass — the same call its 30-second tick makes.
      (manager as unknown as { warmPool: { evaluate(): void } }).warmPool.evaluate();
      await vi.advanceTimersByTimeAsync(0);

      const agentId = [...table.rows.keys()][0]!;
      expect(agentId).toBeDefined();
      // The in-memory entry survives a successful spawn, exactly as on the
      // job-bound path: it is what `onAgentRegistered` correlates against, so a
      // warm agent is marked scaler-managed instead of arriving as a static one.
      expect(manager.getStatus().spawningCount).toBe(1);
      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
      // Still present and unclaimed — exactly what an adopt needs to find.
      expect(table.rows.get(agentId)?.adoptedBy).toBeNull();

      const adopted = await manager.onAgentRegistered(agentId, ['github-actions']);

      expect(adopted).not.toBeNull();
      expect(table.rows.get(agentId)?.adoptedBy).toBe('orch-a');
    });

    it('answers from the local spawning entry, not from the store reply', async () => {
      // The store is still touched on this path — `markSpawningAgentAdopted`
      // stamps the row as owned here — but its reply is ignored. The default
      // fake resolves `adoptSpawningAgent` to null, so a non-null result can
      // only have come from the in-memory entry.
      const stateStore = fakeStateStore();
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });
      // Drive a real spawn so the agent lands in the local spawning map, rather
      // than reaching into private state.
      // `kici:os:linux` is the scaler's mandatory (taint) label, so the request
      // has to tolerate it for the label matcher to route here at all.
      const scaled = await manager.requestScale(
        ['github-actions', 'kici:os:linux'],
        'job-1',
        'run-1',
      );
      expect(scaled.action).toBe('spawning');
      const agentId = stateStore.upsertSpawningAgent.mock.calls[0][0].agentId as string;

      const result = await manager.onAgentRegistered(agentId, ['github-actions']);

      // The local path answered in full, despite the store replying null.
      expect(result).toEqual({ boundJobId: 'job-1', mandatoryLabels: ['kici:os:linux'] });
    });

    it('re-adopts its own row after a restart, while still refusing a peer', async () => {
      // The silent-leak shape. A restart rehydrates the row, the stale prune
      // drops the in-memory entry but spares the row, and the still-live agent's
      // next registration therefore has only the adoption path left. An
      // `adopted_by IS NULL`-only predicate refuses it — because `adopted_by` is
      // already this very instance — so the agent reads as static: no
      // `scale-down` on disconnect, and the reaper spares it because the agent
      // is registered and its adopter is alive.
      //
      // The SQL predicate itself is pinned in `scaler-state-store.test.ts`; this
      // covers the consequence the manager draws once the store answers, which
      // is the half a reader of the store test cannot see.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const emitter = fakeEmitter();
      const spawner = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      await spawner.onAgentRegistered(agentId, ['github-actions']);
      expect(rows.get(agentId)?.adoptedBy).toBe('orch-a');

      const restarted = makeManagerWithEventBackend({ stateStore, emitter, instanceId: 'orch-a' });
      await restarted.recoverState();
      expect(restarted.getStatus().spawningCount).toBe(1);
      await vi.advanceTimersByTimeAsync(301_000);
      await restarted.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');
      // The prune reached the rehydrated entry and spared the row — the exact
      // state in which only the adoption path can answer the re-registration.
      expect(rows.has(agentId)).toBe(true);
      expect(stateStore.deleteUnadoptedSpawningAgent).not.toHaveBeenCalled();

      // The negative control, run first so it cannot be a leftover of the
      // positive one: a peer is still refused a row this instance holds. The
      // refusal is now a throw rather than a `null`, because `null` means
      // "register as static" and this id is scaler-minted.
      const peer = makeManagerWithNoBackends({ stateStore, instanceId: 'orch-b' });
      await expect(peer.onAgentRegistered(agentId, ['github-actions'])).rejects.toThrow(
        /no spawn record/,
      );
      expect(rows.get(agentId)?.adoptedBy).toBe('orch-a');

      // …and the owner re-adopts its own row.
      expect(await restarted.onAgentRegistered(agentId, ['github-actions'])).toEqual({
        boundJobId: 'job-1',
        mandatoryLabels: ['kici:os:linux'],
      });

      // Proof it is scaler-managed again rather than static: the disconnect
      // tears the customer's provision down.
      restarted.onAgentDisconnected(agentId);
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId, scalerName: 'github-actions' }),
        ['e2e/provision'],
      );
    });
  });

  describe('registration seeds the backend map', () => {
    it('lets a locally re-registered agent be torn down after a restart', async () => {
      // `recoverState` rehydrates `spawningAgents` but not the backend's own
      // agent map, so a restarted coordinator answers the re-registration from
      // memory (`completeLocalRegistration`, not the adoption path). Without a
      // seed there, `EventScalerBackend.destroy()` opens with
      // `if (!this.agents.has(id)) return;` and silently no-ops on disconnect
      // while the `.then()` still deletes the row — the customer's instance
      // runs forever with nothing left pointing at it.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const emitter = fakeEmitter();
      const spawner = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;

      const restarted = makeManagerWithEventBackend({ stateStore, emitter, instanceId: 'orch-a' });
      await restarted.recoverState();
      // The local path is the one under test: the entry is in memory, so the
      // registration is answered from it rather than from the spawn record.
      // Its bound job is the tell — the adoption path reads that from the row.
      expect(restarted.getStatus().spawningCount).toBe(1);
      expect(await restarted.onAgentRegistered(agentId, ['github-actions'])).toEqual({
        boundJobId: 'job-1',
        mandatoryLabels: ['kici:os:linux'],
      });
      expect(restarted.getStatus().spawningCount).toBe(0);

      restarted.onAgentDisconnected(agentId);
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId, scalerName: 'github-actions' }),
        ['e2e/provision'],
      );
      // The teardown resolved, so the row goes with it.
      await vi.waitFor(() => expect(rows.has(agentId)).toBe(false));
    });
  });

  describe('teardown addressing', () => {
    it('delivers to the spawn-time targets when this coordinator also holds the agent', async () => {
      // The local path: one coordinator spawned the agent AND holds it, so no
      // adoption is involved and the in-memory spawn entry is the only record of
      // where the teardown goes. Falling back to live config here makes the
      // "which coordinator the agent reached is invisible" promise conditional
      // on the deployment — and wrong on every single-coordinator one, where the
      // local path is the ONLY path.
      const { rows, overrides } = spawningRowTable();
      const entry = { ...eventScalerEntry(), provisioningTargets: ['org/at-spawn-time'] };
      const emitter = fakeEmitter();
      const stateStore = fakeStateStore(overrides);
      const manager = makeManager({
        stateStore,
        emitter,
        instanceId: 'orch-a',
        backends: [{ name: entry.name, backend: makeEventBackend({ entry, emitter, stateStore }) }],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [entry] },
      });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      expect(await manager.onAgentRegistered(agentId, ['github-actions'])).not.toBeNull();

      // The operator edits the scaler's targets while the agent is running. The
      // entry object is the one the backend holds, so this moves live config on
      // both sides — exactly what the teardown must not read.
      entry.provisioningTargets = ['org/edited-since'];
      expect(await manager.reload({ version: 1, globalMaxAgents: 100, scalers: [entry] })).toEqual({
        valid: true,
      });

      manager.onAgentDisconnected(agentId);

      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId }),
        ['org/at-spawn-time'],
      );
    });

    it('delivers to the targets recorded at spawn time, not to live config', async () => {
      // Both coordinators configure the scaler, so the adopter routes the
      // teardown through its own backend rather than through the spec path. Its
      // live `provisioningTargets` differ from the spawner's — an operator edit
      // between the spawn and the teardown — and the recorded ones must win.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);

      const spawnerEntry = { ...eventScalerEntry(), provisioningTargets: ['org/at-spawn-time'] };
      const spawner = makeManager({
        stateStore,
        instanceId: 'orch-a',
        backends: [
          {
            name: spawnerEntry.name,
            backend: makeEventBackend({ entry: spawnerEntry, stateStore }),
          },
        ],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [spawnerEntry] },
      });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      expect(rows.get(agentId)?.provisioningTargets).toEqual(['org/at-spawn-time']);

      const adopterEntry = { ...eventScalerEntry(), provisioningTargets: ['org/edited-since'] };
      const adopterEmitter = fakeEmitter();
      const adopter = makeManager({
        stateStore,
        instanceId: 'orch-b',
        emitter: adopterEmitter,
        backends: [
          {
            name: adopterEntry.name,
            backend: makeEventBackend({
              entry: adopterEntry,
              emitter: adopterEmitter,
              stateStore,
            }),
          },
        ],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [adopterEntry] },
      });

      expect(await adopter.onAgentRegistered(agentId, ['github-actions'])).not.toBeNull();
      adopter.onAgentDisconnected(agentId);

      await vi.waitFor(() => expect(adopterEmitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      expect(adopterEmitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId }),
        ['org/at-spawn-time'],
      );
    });
  });

  describe('adoption lookup failure', () => {
    it('refuses a scaler-minted agent id rather than registering it ungated', async () => {
      // Registering it as static drops its `mandatoryLabels` gate for the
      // agent's whole life, so a queued job whose `runsOn` omits the platform
      // taint can land on it. Refusing costs the agent a reconnect.
      //
      // The id under test is the one the manager actually mints, read back off
      // the spawn row — not a hand-written look-alike. A hand-written id keeps
      // this test green while the minting prefix drifts away from the constant
      // the guard matches on, which is exactly how the guard would go inert.
      const { rows, overrides } = spawningRowTable();
      const spawner = makeManagerWithEventBackend({
        stateStore: fakeStateStore(overrides),
        instanceId: 'orch-a',
      });
      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const mintedAgentId = [...rows.keys()][0]!;
      expect(mintedAgentId).toBeDefined();

      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockRejectedValue(new Error('connection terminated')),
      });
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-b' });

      await expect(manager.onAgentRegistered(mintedAgentId, ['github-actions'])).rejects.toThrow(
        /adoption lookup failed/,
      );
    });

    it('still registers a static agent as static', async () => {
      // The negative control: every static agent takes this branch on a memory
      // miss, so failing the whole path closed would refuse them all.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockRejectedValue(new Error('connection terminated')),
      });
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-b' });

      expect(await manager.onAgentRegistered('build-box-1', ['github-actions'])).toBeNull();
    });
  });

  describe('no spawn record for a scaler-minted id', () => {
    it('refuses a scaler-minted agent id rather than registering it as static', async () => {
      // `completeLocalRegistration` deletes a local-backend spawn row at
      // registration, so after an orchestrator restart a still-running scaler
      // agent re-registers with nothing left to adopt. Returning `null` there
      // registers it as static and drops its `mandatoryLabels` gate for the
      // rest of its life, so a queued job whose `runsOn` omits the platform
      // taint can land on it. Refusing costs the agent a reconnect.
      //
      // Same convention as the sibling lookup-failure block: the id under test
      // is the one the manager actually mints, read back off the spawn row, so
      // the test cannot stay green while the minting prefix drifts away from
      // the constant the guard matches on.
      const { rows, overrides } = spawningRowTable();
      const spawner = makeManagerWithEventBackend({
        stateStore: fakeStateStore(overrides),
        instanceId: 'orch-a',
      });
      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const mintedAgentId = [...rows.keys()][0]!;
      expect(mintedAgentId).toBeDefined();

      // A fresh coordinator with no row to adopt: the conditional UPDATE finds
      // nothing and resolves `null`.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(null),
      });
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-b' });

      await expect(manager.onAgentRegistered(mintedAgentId, ['github-actions'])).rejects.toThrow(
        /no spawn record/,
      );
      // `null` is also what a never-consulted store would produce, so pin that
      // the store was actually asked before the guard fired.
      expect(stateStore.adoptSpawningAgent).toHaveBeenCalledWith(mintedAgentId, 'orch-b');
    });

    it('still registers a genuinely static agent as static', async () => {
      // The negative control, and the safe-direction proof: every static agent
      // takes this branch on a memory miss, so failing the path closed would
      // refuse them all. No agent gains capability from this change — an id
      // without the prefix behaves exactly as it did before.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(null),
      });
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-b' });

      expect(await manager.onAgentRegistered('build-box-1', ['github-actions'])).toBeNull();
    });

    it('refuses a scaler-minted id on a store-less manager too', async () => {
      // Worker mode builds a manager with no state store, so its spawn records
      // live in memory only and a restart erases every one of them. That memory
      // miss is the same condition the adoption branch handles, reached with no
      // store to ask — so without the guard it falls straight through to the
      // static path and drops the gate exactly as an adoption miss would.
      //
      // The id is minted by a real spawn on a separate store-backed manager, so
      // the assertion cannot stay green while the minting prefix drifts away
      // from the constant the guard matches on.
      const { rows, overrides } = spawningRowTable();
      const spawner = makeManagerWithEventBackend({
        stateStore: fakeStateStore(overrides),
        instanceId: 'orch-a',
      });
      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const mintedAgentId = [...rows.keys()][0]!;

      const worker = new ScalerManager({
        config: createDefaultConfig(),
        backends: [],
        instanceId: 'worker-a',
        spawnTimeoutMs: 300_000,
      });

      await expect(worker.onAgentRegistered(mintedAgentId, ['github-actions'])).rejects.toThrow(
        /no spawn record/,
      );
      // The negative control on the same store-less manager: a static agent
      // still registers, so the branch did not fail closed for everybody.
      expect(await worker.onAgentRegistered('build-box-1', ['github-actions'])).toBeNull();
    });
  });

  describe('reclaiming an agent refused for a missing spawn record', () => {
    /**
     * Mint a real scaler agent id by spawning through an event backend, then
     * read it back off the spawn row — the same convention the sibling refusal
     * block uses, so these tests cannot stay green while the minting prefix
     * drifts away from the constant the guard matches on.
     */
    async function mintScalerAgentId(): Promise<string> {
      const { rows, overrides } = spawningRowTable();
      const spawner = makeManagerWithEventBackend({
        stateStore: fakeStateStore(overrides),
        instanceId: 'orch-a',
      });
      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const minted = [...rows.keys()][0];
      expect(minted).toBeDefined();
      return minted!;
    }

    function localBackend(overrides: Partial<ScalerBackend> = {}) {
      const destroy = vi.fn().mockResolvedValue(undefined);
      const reapUnowned = vi.fn().mockResolvedValue(true);
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        destroy,
        reapUnowned,
        ...overrides,
      });
      return { backend, destroy, reapUnowned };
    }

    it('reclaims the host-local compute of the agent it refuses', async () => {
      // The leak this closes: refusing returns before registration, so
      // `onAgentDisconnected` never runs — and could not help if it did, since
      // `managedAgentIndex` is only written after this point. Without the
      // reclaim the VM or host process keeps its RAM and its IP, the agent
      // reconnects, is refused again, and loops until an operator intervenes.
      const mintedAgentId = await mintScalerAgentId();
      const { backend, destroy, reapUnowned } = localBackend();
      const manager = makeManager({
        stateStore: fakeStateStore({ adoptSpawningAgent: vi.fn().mockResolvedValue(null) }),
        backends: [{ name: 'container-prod', backend }],
        instanceId: 'orch-b',
      });

      await expect(manager.onAgentRegistered(mintedAgentId, ['linux'])).rejects.toThrow(
        /no spawn record/,
      );
      // The reclaim is fire-and-forget, matching the disconnect path's teardown.
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).toHaveBeenCalledWith(mintedAgentId);
      // `destroy` alone is not enough: it is keyed off the backend's in-memory
      // agent map, which an orchestrator restart empties — which is exactly the
      // situation that produces this refusal.
      expect(reapUnowned).toHaveBeenCalledWith(mintedAgentId);
    });

    it('never reclaims through an event backend, whose missing adoption is ambiguous', async () => {
      // THE DANGEROUS DIRECTION. `adoptSpawningAgent` resolves `null` both when
      // no row exists and when a PEER coordinator already holds the row, so an
      // event agent that is alive and legitimately owned elsewhere reaches this
      // very branch. Reclaiming there destroys a healthy provision the peer is
      // still running jobs on.
      const mintedAgentId = await mintScalerAgentId();
      const { backend, destroy, reapUnowned } = localBackend({ type: 'event' });
      const manager = makeManager({
        stateStore: fakeStateStore({ adoptSpawningAgent: vi.fn().mockResolvedValue(null) }),
        backends: [{ name: 'gh-actions', backend }],
        instanceId: 'orch-b',
      });

      await expect(manager.onAgentRegistered(mintedAgentId, ['linux'])).rejects.toThrow(
        /no spawn record/,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).not.toHaveBeenCalled();
      expect(reapUnowned).not.toHaveBeenCalled();
    });

    it('does not reclaim when the adoption lookup merely failed', async () => {
      // The second safe direction: a store that could not answer is not
      // evidence the agent is unowned. Its spawn record may be intact behind a
      // transient fault, so reclaiming would destroy a healthy provision over a
      // DB hiccup. Same refusal, deliberately no teardown.
      const mintedAgentId = await mintScalerAgentId();
      const { backend, destroy, reapUnowned } = localBackend();
      const manager = makeManager({
        stateStore: fakeStateStore({
          adoptSpawningAgent: vi.fn().mockRejectedValue(new Error('connection reset')),
        }),
        backends: [{ name: 'container-prod', backend }],
        instanceId: 'orch-b',
      });

      await expect(manager.onAgentRegistered(mintedAgentId, ['linux'])).rejects.toThrow(
        /adoption lookup failed/,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).not.toHaveBeenCalled();
      expect(reapUnowned).not.toHaveBeenCalled();
    });

    it('does not reclaim for a static agent, which registers normally', async () => {
      // The negative control. A static agent takes the same `null` adoption
      // branch on every register, so a reclaim that fired here would tear down
      // an operator's own long-lived machine.
      const { backend, destroy, reapUnowned } = localBackend();
      const manager = makeManager({
        stateStore: fakeStateStore({ adoptSpawningAgent: vi.fn().mockResolvedValue(null) }),
        backends: [{ name: 'container-prod', backend }],
        instanceId: 'orch-b',
      });

      expect(await manager.onAgentRegistered('build-box-1', ['linux'])).toBeNull();
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).not.toHaveBeenCalled();
      expect(reapUnowned).not.toHaveBeenCalled();
    });

    it('reclaims on a store-less manager too, where a restart erases every record', async () => {
      // Worker mode keeps spawn records in memory only, so a restart loses them
      // all and every still-running scaler agent takes this branch.
      const mintedAgentId = await mintScalerAgentId();
      const { backend, destroy, reapUnowned } = localBackend();
      const worker = new ScalerManager({
        config: createDefaultConfig(),
        backends: [{ name: 'container-prod', backend }],
        instanceId: 'worker-a',
        spawnTimeoutMs: 300_000,
      });

      await expect(worker.onAgentRegistered(mintedAgentId, ['linux'])).rejects.toThrow(
        /no spawn record/,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).toHaveBeenCalledWith(mintedAgentId);
      expect(reapUnowned).toHaveBeenCalledWith(mintedAgentId);
    });
  });

  describe('recoverState() — owner-scoped hydration', () => {
    it('reads only the rows this instance owns', async () => {
      const stateStore = fakeStateStore({
        listSpawningAgentsForOwner: vi.fn().mockResolvedValue([]),
        listReservationsForOwner: vi.fn().mockResolvedValue([]),
      });
      const manager = makeManager({ stateStore, instanceId: 'orch-b' });

      await manager.recoverState();

      expect(stateStore.listSpawningAgentsForOwner).toHaveBeenCalledWith('orch-b');
      expect(stateStore.listReservationsForOwner).toHaveBeenCalledWith('orch-b');
      // The unscoped reads would hydrate a peer's live spawns as our own and let
      // our spawn-timeout reaper destroy agents that peer is still waiting on.
      expect(stateStore.listSpawningAgents).not.toHaveBeenCalled();
      expect(stateStore.listReservations).not.toHaveBeenCalled();
    });

    it('leaves a peer-owned spawn row out of the map the reaper walks', async () => {
      // The behavioural half: the scoped read is driven by the owner column the
      // spawn write stamps, so a peer's row is invisible here while our own is
      // rehydrated. Both directions in one run — a filter that returned nothing
      // would fail the positive, one that returned everything the negative.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const peer = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-b' });
      const ours = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await peer.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await ours.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(rows.size).toBe(2);
      // Read the ids now: the prune below deletes the unadopted row it reaches,
      // so a lookup afterwards would name whichever row survived.
      const idOwnedBy = (instanceId: string) =>
        [...rows.values()].find((row) => row.ownerInstanceId === instanceId)?.agentId;
      const ourAgentId = idOwnedBy('orch-a');
      const peerAgentId = idOwnedBy('orch-b');
      expect(ourAgentId).toBeDefined();
      expect(peerAgentId).toBeDefined();

      const restartedBackend = makeEventBackend({ stateStore });
      const restarted = makeManagerWithEventBackend({
        stateStore,
        instanceId: 'orch-a',
        eventBackend: restartedBackend,
      });
      const recovery = await restarted.recoverState();

      expect(recovery.spawningAgentsRehydrated).toBe(1);
      expect(restarted.getStatus().spawningCount).toBe(1);

      // Which row it was: the stale prune walks exactly the rehydrated entries
      // and releases each one's backend entry, so seeding the backend with BOTH
      // ids makes the survivor identifiable. Ours is pruned; the peer's was
      // never in the map to begin with.
      restartedBackend.adopt(ourAgentId!, ['github-actions']);
      restartedBackend.adopt(peerAgentId!, ['github-actions']);
      expect(restartedBackend.getActiveCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(301_000);
      await restarted.requestScale(['nothing-matches-this'], 'job-3', 'run-3');

      expect(restartedBackend.getActiveCount()).toBe(1);
      // …and the one still tracked is the peer's, not ours.
      restartedBackend.forget(peerAgentId!);
      expect(restartedBackend.getActiveCount()).toBe(0);
    });

    it('stamps the reservation owner, or the scoped read recovers no usage', async () => {
      // Scoping the read without stamping the write is strictly worse than the
      // bug it fixes: every instance would rehydrate zero reservations and
      // under-count its own caps forever.
      const reservations = new Map<string, Record<string, unknown>>();
      const stateStore = fakeStateStore({
        upsertReservation: vi.fn(async (snapshot: { agentId: string }) => {
          reservations.set(snapshot.agentId, snapshot);
        }),
        listReservationsForOwner: vi.fn(async (instanceId: string) =>
          [...reservations.values()].filter((row) => row.ownerInstanceId === instanceId),
        ),
      });
      const manager = makeManagerWithContainerBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['default'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(reservations.size).toBe(1);

      const restarted = makeManagerWithContainerBackend({ stateStore, instanceId: 'orch-a' });
      const recovery = await restarted.recoverState();

      expect(stateStore.listReservationsForOwner).toHaveBeenCalledWith('orch-a');
      expect(recovery.reservationsRehydrated).toBe(1);
      // The complement: the same rows are invisible to any other instance, so
      // the count above came from the owner match rather than an unfiltered read.
      const peer = makeManagerWithContainerBackend({ stateStore, instanceId: 'orch-b' });
      expect((await peer.recoverState()).reservationsRehydrated).toBe(0);
    });
  });

  describe('onAgentDisconnected()', () => {
    it('triggers destroy on agent disconnect', async () => {
      const manager = createManager();

      // Spawn and register an agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Disconnect
      manager.onAgentDisconnected(agentId);

      // The second argument is the adopted-agent teardown context, undefined for
      // an agent this instance spawned itself.
      expect(containerBackend.destroy).toHaveBeenCalledWith(agentId, undefined);
    });

    it('ignores non-managed (static) agents', () => {
      const manager = createManager();

      // Should not throw or call destroy
      manager.onAgentDisconnected('static-agent-123');

      expect(containerBackend.destroy).not.toHaveBeenCalled();
      expect(bareMetalBackend.destroy).not.toHaveBeenCalled();
    });

    it('cleans up managedAgentIndex even when destroy fails', async () => {
      const failingBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        destroy: vi.fn(async () => {
          throw new Error('Container not found');
        }),
      });

      const manager = createManager(
        {
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: failingBackend }],
      );

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (failingBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Disconnect -- destroy will fail but managedAgentIndex should still be cleaned
      manager.onAgentDisconnected(agentId);

      // Verify the agent is no longer tracked (a second disconnect is a no-op)
      manager.onAgentDisconnected(agentId);
      expect(failingBackend.destroy).toHaveBeenCalledTimes(1); // Only first call triggers destroy
    });
  });

  describe('onAgentDisconnected() — teardown from the adopting instance', () => {
    /** The spawn record orch A wrote, as orch B reads it back on adoption. */
    function adoptedRow(overrides: Record<string, unknown> = {}) {
      return {
        agentId: 'agent-77',
        scalerName: 'github-actions',
        labelSet: ['github-actions'],
        boundJobId: 'job-1',
        mandatoryLabels: ['kici:os:linux'],
        provisioningTargets: ['e2e/provision'],
        backendType: ScalerBackendType.enum.event,
        spawnedAt: new Date(),
        ownerInstanceId: 'orch-a',
        ...overrides,
      };
    }

    /**
     * The flush both emit-outcome tests below share. The resolving case asserts
     * a delete *did* land after exactly this much settling, which is what pins
     * the rejecting case's "no delete" as a real absence rather than an
     * under-flush.
     */
    async function settleTeardown(): Promise<void> {
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
    }

    it('emits scale-down for an adopted agent even with no local backend', async () => {
      const emitter = fakeEmitter();
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow()),
      });
      const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });
      await manager.onAgentRegistered('agent-77', ['github-actions']);

      manager.onAgentDisconnected('agent-77');
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));

      expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({
          scalerName: 'github-actions',
          agentId: 'agent-77',
          reason: 'shutdown',
        }),
        ['e2e/provision'],
      );
      await vi.waitFor(() =>
        expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith('agent-77'),
      );
    });

    it('emits the same payload whether or not this instance configures the scaler', async () => {
      // The premise of the whole HA change: which coordinator the load balancer
      // happened to hand the agent to must not be visible to the customer's
      // teardown workflow. `requestId` is the one field that legitimately
      // differs — it correlates a single request, not a class of them.
      async function tearDownVia(build: (opts: ManagerHarnessOptions) => ScalerManager) {
        const emitter = fakeEmitter();
        const stateStore = fakeStateStore({
          adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow()),
        });
        const manager = build({ emitter, stateStore, instanceId: 'orch-b' });
        expect(await manager.onAgentRegistered('agent-77', ['github-actions'])).not.toBeNull();

        manager.onAgentDisconnected('agent-77');
        await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
        const [payload, targets] = emitter.emitScalerScaleDown.mock.calls[0]!;
        return { payload: payload as Record<string, unknown>, targets };
      }

      const noBackend = await tearDownVia(makeManagerWithNoBackends);
      const localBackend = await tearDownVia(makeManagerWithEventBackend);

      // Full equality with only `requestId` transplanted: a differing `reason`,
      // `scalerName` or `agentId` — or a field one path forgets — fails here.
      expect(noBackend.payload).toEqual({
        ...localBackend.payload,
        requestId: noBackend.payload.requestId,
      });
      expect(noBackend.targets).toEqual(localBackend.targets);
      // Pin the shared value too, so moving both paths to a different reason is
      // a deliberate edit here rather than a silently still-equal pair.
      expect(noBackend.payload).toMatchObject({
        scalerName: 'github-actions',
        agentId: 'agent-77',
        reason: 'shutdown',
      });
      expect(noBackend.payload.requestId).toEqual(expect.any(String));
    });

    it('does not emit twice when the local backend already tore the agent down', async () => {
      // Backend present: the real `EventScalerBackend.destroy()` emits the
      // teardown itself, so exactly one scale-down must reach the emitter — the
      // no-local-backend fallback must not add a second.
      const emitter = fakeEmitter();
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow()),
      });
      const manager = makeManagerWithEventBackend({ emitter, stateStore, instanceId: 'orch-b' });
      await manager.onAgentRegistered('agent-77', ['github-actions']);

      manager.onAgentDisconnected('agent-77');
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));

      await settleTeardown();
      expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1);
    });

    it("carries the spawner's provisioning targets to an instance that lacks the scaler", async () => {
      // The whole cross-instance chain in one pass: orch-a writes the row,
      // orch-b (empty scalers.yaml) adopts it and tears it down. The targets can
      // only have come off the row — orch-b has no config entry to read them
      // from — and an emit to an empty target list reaches no subscriber, so
      // the customer's instance would bill forever.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const spawner = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await spawner.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      expect(agentId).toBeDefined();

      const emitter = fakeEmitter();
      const adopter = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });
      expect(await adopter.onAgentRegistered(agentId, ['github-actions'])).not.toBeNull();

      adopter.onAgentDisconnected(agentId);
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));

      expect(emitter.emitScalerScaleDown.mock.calls[0]![1]).toEqual(['e2e/provision']);
      // …and the row goes, so a rehydrated copy cannot pressure the caps forever.
      await vi.waitFor(() => expect(rows.has(agentId)).toBe(false));
    });

    it('persists the scaler roles alongside the targets, keeping the row self-describing', async () => {
      const stateStore = fakeStateStore();
      const entry: ScalerEntry = { ...eventScalerEntry(), roles: ['builder'] };
      const emitter = fakeEmitter();
      const manager = makeManager({
        stateStore,
        emitter,
        instanceId: 'orch-a',
        backends: [{ name: entry.name, backend: makeEventBackend({ entry, emitter, stateStore }) }],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [entry] },
      });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');

      expect(stateStore.upsertSpawningAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          provisioningTargets: ['e2e/provision'],
          roles: ['builder'],
        }),
      );
    });

    it("deletes the durable row once the local backend's teardown resolves", async () => {
      // An event row survives registration, so nothing else ever removes it:
      // without this delete every completed provision leaves a row that
      // `recoverState` rehydrates on the next restart, forever.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      await manager.onAgentRegistered(agentId, ['github-actions']);
      // The row really did outlive registration — otherwise the delete below
      // would be observing a row that was already gone.
      expect(rows.has(agentId)).toBe(true);

      manager.onAgentDisconnected(agentId);

      await vi.waitFor(() => expect(rows.has(agentId)).toBe(false));
    });

    it('keeps the durable row when the teardown emit fails, so a retry still has it', async () => {
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow()),
      });
      const emitter = {
        ...fakeEmitter(),
        emitScalerScaleDown: vi.fn().mockRejectedValue(new Error('event router unavailable')),
      };
      const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });
      await manager.onAgentRegistered('agent-77', ['github-actions']);

      manager.onAgentDisconnected('agent-77');
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      await settleTeardown();

      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
    });

    it('deletes the durable row when that same emit resolves', async () => {
      // The complement of the test above, run through the identical flush: the
      // delete IS observable here, so its absence there is a real absence.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow()),
      });
      const emitter = fakeEmitter();
      const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });
      await manager.onAgentRegistered('agent-77', ['github-actions']);

      manager.onAgentDisconnected('agent-77');
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));
      await settleTeardown();

      expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith('agent-77');
    });

    it('falls back to local config for a row that recorded no targets', async () => {
      // A row written by a coordinator that never recorded its targets. This
      // instance has no *backend* for the scaler but does carry its config
      // entry, so the teardown is still deliverable — and this is the only way
      // such a row ever clears, since the reaper funnels back through the same
      // resolution.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow({ provisioningTargets: [] })),
      });
      const emitter = fakeEmitter();
      const manager = makeManager({
        emitter,
        stateStore,
        instanceId: 'orch-b',
        backends: [],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [eventScalerEntry()] },
      });
      expect(await manager.onAgentRegistered('agent-77', ['github-actions'])).not.toBeNull();

      manager.onAgentDisconnected('agent-77');
      await vi.waitFor(() => expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1));

      expect(emitter.emitScalerScaleDown.mock.calls[0]![1]).toEqual(['e2e/provision']);
      await vi.waitFor(() =>
        expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith('agent-77'),
      );
    });

    it('emits nothing and keeps the row when neither the row nor config names a target', async () => {
      // The complement of the test above, over the identical row: here the
      // instance has no config entry for `github-actions` either (the default
      // harness config carries only the container / bare-metal scalers), so
      // there is nowhere to deliver the teardown. An emit with an empty target
      // list reaches no subscriber, so reporting a scale-down and dropping the
      // row would erase the only pointer left at a still-running instance.
      const stateStore = fakeStateStore({
        adoptSpawningAgent: vi.fn().mockResolvedValue(adoptedRow({ provisioningTargets: [] })),
      });
      const emitter = fakeEmitter();
      const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });
      // Adoption is what puts the agent on the fallback path at all; a null here
      // would make both absences below vacuous.
      expect(await manager.onAgentRegistered('agent-77', ['github-actions'])).not.toBeNull();

      manager.onAgentDisconnected('agent-77');
      await settleTeardown();

      expect(emitter.emitScalerScaleDown).not.toHaveBeenCalled();
      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
    });

    describe('emitOrphanScaleDown', () => {
      /** A stranded row as the reaper hands it over. */
      function reapCandidate(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
        return {
          agentId: 'agent-77',
          scalerName: 'github-actions',
          provisioningTargets: ['e2e/provision'],
          spawnedAt: new Date('2026-08-21T11:00:00Z'),
          ...overrides,
        };
      }

      beforeEach(() => {
        vi.mocked(incScalerExternalProvisionTimeout).mockClear();
      });

      it('emits the teardown from the row, drops it, and counts the timeout', async () => {
        const stateStore = fakeStateStore();
        const emitter = fakeEmitter();
        const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

        await manager.emitOrphanScaleDown(reapCandidate(), ScaleDownReason.enum['spawn-timeout']);

        expect(emitter.emitScalerScaleDown).toHaveBeenCalledWith(
          expect.objectContaining({
            scalerName: 'github-actions',
            agentId: 'agent-77',
            reason: ScaleDownReason.enum['spawn-timeout'],
          }),
          ['e2e/provision'],
        );
        expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith('agent-77');
        expect(incScalerExternalProvisionTimeout).toHaveBeenCalledWith('github-actions');
      });

      // Both reasons, asserted per reason rather than in one aggregate pass: a
      // loop that only checked "called at least once" would stay green with the
      // record wired into the `spawn-timeout` arm alone, which is exactly the
      // half-fix this pair exists to catch.
      for (const reason of [
        ScaleDownReason.enum['spawn-timeout'],
        ScaleDownReason.enum['heartbeat-timeout'],
      ]) {
        it(`records the durable condemn verdict for a delivered ${reason} teardown`, async () => {
          const stateStore = fakeStateStore();
          const emitter = fakeEmitter();
          const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

          await manager.emitOrphanScaleDown(reapCandidate(), reason);

          expect(stateStore.recordProvisionCondemned).toHaveBeenCalledWith(
            'agent-77',
            'github-actions',
            reason,
          );
        });

        it(`records no ${reason} verdict when the teardown reached nobody`, async () => {
          // The row names nowhere to deliver to, so it is KEPT for the reaper to
          // retry — no verdict has been reached yet to record.
          const stateStore = fakeStateStore();
          const emitter = fakeEmitter();
          const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

          await manager.emitOrphanScaleDown(reapCandidate({ provisioningTargets: [] }), reason);

          expect(emitter.emitScalerScaleDown).not.toHaveBeenCalled();
          expect(stateStore.recordProvisionCondemned).not.toHaveBeenCalled();
        });
      }

      it('records no verdict when the emit itself fails', async () => {
        const stateStore = fakeStateStore();
        const emitter = {
          ...fakeEmitter(),
          emitScalerScaleDown: vi.fn().mockRejectedValue(new Error('event router unavailable')),
        };
        const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

        await manager.emitOrphanScaleDown(
          reapCandidate(),
          ScaleDownReason.enum['heartbeat-timeout'],
        );

        expect(stateStore.recordProvisionCondemned).not.toHaveBeenCalled();
      });

      it('does not count the timeout for a heartbeat teardown', async () => {
        const emitter = fakeEmitter();
        const manager = makeManagerWithNoBackends({ emitter, instanceId: 'orch-b' });

        await manager.emitOrphanScaleDown(
          reapCandidate(),
          ScaleDownReason.enum['heartbeat-timeout'],
        );

        expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1);
        expect(incScalerExternalProvisionTimeout).not.toHaveBeenCalled();
      });

      // The metric must count teardowns, not attempts. This row names nowhere
      // to deliver to, so it keeps its record and the reaper retries it every
      // re-attempt window — counting the attempt would inflate the counter
      // forever off one permanently undeliverable provision.
      it('does not count the timeout when the teardown could not be emitted', async () => {
        const stateStore = fakeStateStore();
        const emitter = fakeEmitter();
        const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

        await manager.emitOrphanScaleDown(
          reapCandidate({ provisioningTargets: [] }),
          ScaleDownReason.enum['spawn-timeout'],
        );

        expect(emitter.emitScalerScaleDown).not.toHaveBeenCalled();
        expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
        expect(incScalerExternalProvisionTimeout).not.toHaveBeenCalled();
      });

      it('does not count the timeout when the emit itself fails', async () => {
        const stateStore = fakeStateStore();
        const emitter = {
          ...fakeEmitter(),
          emitScalerScaleDown: vi.fn().mockRejectedValue(new Error('event router unavailable')),
        };
        const manager = makeManagerWithNoBackends({ emitter, stateStore, instanceId: 'orch-b' });

        await manager.emitOrphanScaleDown(reapCandidate(), ScaleDownReason.enum['spawn-timeout']);

        expect(emitter.emitScalerScaleDown).toHaveBeenCalledTimes(1);
        expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
        expect(incScalerExternalProvisionTimeout).not.toHaveBeenCalled();
      });
      // An event scaler's `spawn()` succeeds the moment the scale-up is
      // emitted, so a failed external provision is only observable as "the
      // agent never registered" — this verdict. Reporting it as a
      // `scaler.failed` is what gives the job the provisioning cause instead of
      // a label-mismatch complaint about a `runsOn` that is already correct.
      it('reports the stranded provision as a spawn failure attributed to its job', async () => {
        const onScalerEvent = vi.fn();
        const emitter = fakeEmitter();
        const manager = makeManagerWithNoBackends({
          emitter,
          stateStore: fakeStateStore(),
          instanceId: 'orch-b',
          onScalerEvent,
        });

        await manager.emitOrphanScaleDown(
          reapCandidate({ runId: 'run-77', boundJobId: 'job-77' }),
          ScaleDownReason.enum['spawn-timeout'],
        );

        expect(onScalerEvent).toHaveBeenCalledTimes(1);
        const [runId, jobId, event] = onScalerEvent.mock.calls[0]!;
        expect(runId).toBe('run-77');
        expect(jobId).toBe('job-77');
        expect(event.eventType).toBe(ScalerEventType.enum['scaler.failed']);
        expect(event.agentId).toBe('agent-77');
        expect(event.detail).toContain('github-actions');
        expect(event.detail).toContain('never registered');

        // The operator's first-line tool reads this. Before the event existed,
        // `diagnose scaler` was empty for the one backend that was failing.
        const failures = manager.recentSpawnFailures(60_000, Date.now());
        expect(failures.get('github-actions')).toMatchObject({
          backendType: ScalerBackendType.enum.event,
          boundCount: 1,
          unboundCount: 0,
        });
      });

      // A heartbeat teardown means the agent DID register and later went away,
      // so the provision succeeded — calling that a spawn failure would blame
      // provisioning for a mid-run disconnect.
      it('does not report a heartbeat teardown as a spawn failure', async () => {
        const onScalerEvent = vi.fn();
        const manager = makeManagerWithNoBackends({
          emitter: fakeEmitter(),
          instanceId: 'orch-b',
          onScalerEvent,
        });

        await manager.emitOrphanScaleDown(
          reapCandidate({ runId: 'run-77', boundJobId: 'job-77' }),
          ScaleDownReason.enum['heartbeat-timeout'],
        );

        expect(onScalerEvent).not.toHaveBeenCalled();
        expect(manager.recentSpawnFailures(60_000, Date.now()).size).toBe(0);
      });

      // Same reason the counter is gated: an undeliverable row is retried every
      // re-attempt window forever, so reporting per attempt would flood the
      // tracker and keep rewriting the job's provisioning error.
      it('does not report a failure when the teardown could not be emitted', async () => {
        const onScalerEvent = vi.fn();
        const manager = makeManagerWithNoBackends({
          emitter: fakeEmitter(),
          stateStore: fakeStateStore(),
          instanceId: 'orch-b',
          onScalerEvent,
        });

        await manager.emitOrphanScaleDown(
          reapCandidate({ provisioningTargets: [], runId: 'run-77', boundJobId: 'job-77' }),
          ScaleDownReason.enum['spawn-timeout'],
        );

        expect(onScalerEvent).not.toHaveBeenCalled();
        expect(manager.recentSpawnFailures(60_000, Date.now()).size).toBe(0);
      });

      // A warm fill has no job waiting, so there is nothing to attribute to —
      // but the fleet counter and the operator's diagnose view still need it.
      it('records an unbound warm provision failure without relaying it', async () => {
        const onScalerEvent = vi.fn();
        const manager = makeManagerWithNoBackends({
          emitter: fakeEmitter(),
          stateStore: fakeStateStore(),
          instanceId: 'orch-b',
          onScalerEvent,
        });

        await manager.emitOrphanScaleDown(reapCandidate(), ScaleDownReason.enum['spawn-timeout']);

        expect(onScalerEvent).not.toHaveBeenCalled();
        expect(manager.recentSpawnFailures(60_000, Date.now()).get('github-actions')).toMatchObject(
          {
            backendType: ScalerBackendType.enum.event,
            boundCount: 0,
            unboundCount: 1,
          },
        );
      });

      // The unattributed branch of `handleScalerEvent` parks the event for a
      // correlation, and the only two things that ever clear that park —
      // `correlateAgentToJob` and `onAgentDisconnected` — both require the
      // agent to have connected, which is the one thing this provision did not
      // do. Left alone the buffer keeps a dead entry per condemned warm
      // provision for the life of the process, and hands the stale failure to
      // whatever correlation does eventually name the id.
      it('does not park the unbound failure waiting for a correlation that cannot arrive', async () => {
        const onScalerEvent = vi.fn();
        const manager = makeManagerWithNoBackends({
          emitter: fakeEmitter(),
          stateStore: fakeStateStore(),
          instanceId: 'orch-b',
          onScalerEvent,
        });

        await manager.emitOrphanScaleDown(reapCandidate(), ScaleDownReason.enum['spawn-timeout']);
        manager.correlateAgentToJob('agent-77', 'run-late', 'job-late');

        expect(onScalerEvent).not.toHaveBeenCalled();
      });
    });

    it('deletes the durable row when the warm pool reaps an idle event agent', async () => {
      // The other door onto a live event row. A warm-pool spawn persists a row
      // and an event row survives registration, so an idle reap that skipped
      // the delete would leave a permanent row per reaped agent — rehydrated by
      // `recoverState` on every restart and spared by the stale-spawn prune.
      // The pool is driven directly, the way `warm-pool.test.ts` drives it.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const emitter = fakeEmitter();
      const entry: ScalerEntry = {
        ...eventScalerEntry(),
        // A validated config can never gate on a `kici:` label (they are reserved
        // in both `labelSets` and `mandatoryLabels`), and every configured gate
        // label must appear in every label set. The shared fixture's
        // `kici:os:linux` gate satisfies neither, and a warm pool whose gate
        // escapes its label set is refused as unfillable — correctly, since the
        // readiness query could never see its own agents.
        mandatoryLabels: ['github-actions'],
        // A warm pool needs a declared shape: it starts an agent before any job
        // exists, so its cpu/memory can come from nowhere else.
        labelSets: [
          { labels: ['github-actions'], resources: { requests: { cpus: 1, memory: '1g' } } },
        ],
        warmPool: { enabled: true, size: 1, idleTimeoutSeconds: 300 },
      };
      // The registry the reaper reads. Filled once the agent registers, which
      // is what makes it visible as idle.
      const registered: Array<{ agentId: string; activeJobs: number; registeredAt: number }> = [];
      const manager = makeManager({
        stateStore,
        emitter,
        instanceId: 'orch-a',
        backends: [{ name: entry.name, backend: makeEventBackend({ entry, emitter, stateStore }) }],
        config: { version: 1 as const, globalMaxAgents: 100, scalers: [entry] },
        agentRegistry: { findAvailable: () => registered },
      });
      const pool = (
        manager as unknown as {
          warmPool: { evaluate(): void; checkIdleTimeouts(): void };
        }
      ).warmPool;

      // Two passes with a registration between them, so the pool ends up
      // holding two agents against a target of 1. The reaper only ever takes
      // surplus — an agent that IS the pool is never destroyed, or a quiet pool
      // would churn forever — so one agent alone would be reaped by nothing.
      pool.evaluate();
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;
      await manager.onAgentRegistered(agentId, ['github-actions']);
      const registeredAt = Date.now();

      pool.evaluate();
      await vi.advanceTimersByTimeAsync(0);
      const youngerId = [...rows.keys()].find((id) => id !== agentId)!;
      expect(youngerId).toBeDefined();
      await manager.onAgentRegistered(youngerId, ['github-actions']);

      // Present before the reap: without this the deletion below could be
      // observing a row that some earlier step had already removed.
      expect(rows.has(agentId)).toBe(true);

      registered.push(
        { agentId, activeJobs: 0, registeredAt },
        { agentId: youngerId, activeJobs: 0, registeredAt: Date.now() },
      );
      await vi.advanceTimersByTimeAsync(301_000);
      pool.checkIdleTimeouts();

      // …and absent after it, through the unconditional delete rather than the
      // prune's `adopted_by IS NULL` one, which would have spared this row.
      await vi.waitFor(() => expect(rows.has(agentId)).toBe(false));
      expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith(agentId);
      expect(stateStore.deleteUnadoptedSpawningAgent).not.toHaveBeenCalled();
    });
  });

  describe('onJobComplete()', () => {
    it('does not destroy agent on job completion (agent disconnects on its own)', async () => {
      const manager = createManager();

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      manager.onJobComplete(agentId);

      // Single-job model: agent disconnects on its own, no destroy called
      expect(containerBackend.destroy).not.toHaveBeenCalled();
    });
  });

  describe('onCapacityFreed hook', () => {
    async function spawnAndRegister(manager: ScalerManager): Promise<string> {
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);
      return agentId;
    }

    it('fires (debounced) when a reserved agent releases on disconnect', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onAgentDisconnected(agentId);

      // Debounced: not fired synchronously.
      expect(onCapacityFreed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of releases into a single call', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onJobComplete(agentId);
      manager.onJobComplete(agentId);
      manager.onJobComplete(agentId);
      await vi.advanceTimersByTimeAsync(250);

      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('fires from onJobComplete for a managed agent', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onJobComplete(agentId);
      await vi.advanceTimersByTimeAsync(250);

      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no callback is configured', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);

      expect(() => manager.onAgentDisconnected(agentId)).not.toThrow();
      await vi.advanceTimersByTimeAsync(250);
    });
  });

  describe('onConfigAck()', () => {
    it('calls clearAgentMmds on Firecracker backend', async () => {
      const clearAgentMmds = vi.fn(async () => {});
      const firecrackerBackend = createMockBackend({
        type: 'firecracker',
        labelSets: [{ labels: ['linux', 'vm'], rootfsPath: '/rootfs.ext4' }],
        maxAgents: 5,
      });
      // Add clearAgentMmds to the mock
      (firecrackerBackend as any).clearAgentMmds = clearAgentMmds;

      const manager = createManager(
        {
          scalers: [
            {
              name: 'fc-prod',
              type: 'firecracker' as any,
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'vm'], rootfsPath: '/rootfs.ext4' }],
            },
          ],
        },
        [{ name: 'fc-prod', backend: firecrackerBackend }],
      );

      // Spawn and register an agent
      await manager.requestScale(['linux', 'vm'], 'job-1', 'run-test');
      const agentId = (firecrackerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'vm']);

      // Send config.ack
      manager.onConfigAck(agentId);

      expect(clearAgentMmds).toHaveBeenCalledWith(agentId);
    });

    it('does not call clearAgentMmds on non-Firecracker backends', async () => {
      const manager = createManager();

      // Spawn and register a container agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Send config.ack -- should not throw
      manager.onConfigAck(agentId);

      // No clearAgentMmds should exist on container backend
      expect((containerBackend as any).clearAgentMmds).toBeUndefined();
    });

    it('ignores config.ack from non-managed (static) agents', () => {
      const manager = createManager();

      // Should not throw
      manager.onConfigAck('static-agent-123');
    });
  });

  describe('getBackendType()', () => {
    it('returns the backend TYPE, not the operator-chosen scaler name', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Scaler is named 'container-prod' but its type is 'container'. The metrics
      // scaler label must carry the type, which is what the Platform catalog
      // enum (AGENT_SCALER_VALUES) admits -- never the free-form name.
      expect(manager.getBackendType(agentId)).toBe('container');
    });

    it('returns null for an agent that is not scaler-managed', () => {
      const manager = createManager();
      expect(manager.getBackendType('static-agent-not-managed')).toBeNull();
    });
  });

  describe('getGlobalActiveCount()', () => {
    it('sums all backends active counts without double-counting spawning', async () => {
      // Realistic mock: getActiveCount reflects spawning agents (like real backends).
      // Real backends (container, bare-metal, firecracker) add to their internal agents
      // map synchronously at the start of spawn(), so getActiveCount() already includes
      // spawning agents. The manager must NOT add spawningAgents.size on top.
      let dockerActive = 2;
      let bmActive = 1;

      const containerBE = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 10,
        getActiveCount: () => dockerActive,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Synchronously increment active count, matching real backend behavior
          dockerActive++;
          return new Promise<ManagedAgent>((resolve) => {
            setTimeout(() => {
              resolve({
                id: agentId,
                labelSet,
                backendRef: `ref-${agentId}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            }, 10_000);
          });
        }),
      });

      const bmBE = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/bin/agent' }],
        maxAgents: 10,
        getActiveCount: () => bmActive,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
            {
              name: 'bare-metal-gpu',
              type: 'bare-metal',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/bin/agent' }],
            },
          ],
        },
        [
          { name: 'container-prod', backend: containerBE },
          { name: 'bare-metal-gpu', backend: bmBE },
        ],
      );

      // Before spawning: docker(2) + bm(1) = 3
      expect(manager.getGlobalActiveCount()).toBe(3);

      // Trigger a slow spawn (backend increments active count synchronously)
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      // docker(3) + bm(1) = 4 -- no double-count from spawningAgents
      expect(manager.getGlobalActiveCount()).toBe(4);
    });
  });

  describe('stale spawning entry pruning', () => {
    it('prunes spawning entries older than 5 minutes on next requestScale', async () => {
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 10,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Never resolve: simulates agent that crashes before WS registration
          return new Promise(() => {});
        }),
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // Spawn an agent (stays in spawningAgents forever since spawn never resolves)
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      expect(manager.getStatus().spawningCount).toBe(1);

      // Advance time past the 5-minute stale threshold
      vi.advanceTimersByTime(301_000);

      // Next requestScale prunes the stale entry
      await manager.requestScale(['linux', 'docker'], 'job-2', 'run-test');
      // The stale entry was pruned, new one was added
      expect(manager.getStatus().spawningCount).toBe(1);
    });

    it('leaves every event spawn row for the reaper, adopted or not', async () => {
      // Nothing tells the spawning instance that a peer adopted its agent, so
      // both entries are still in its in-memory map when the prune fires. The
      // row must survive either way. An adopted event agent runs for hours and
      // its row is the only durable record of a live provision. An UNADOPTED
      // one is precisely the reaper's `spawn-timeout` candidate: the reaper
      // cannot condemn it until the flap grace has also elapsed, so a prune
      // that deleted it would win by minutes on any coordinator serving jobs
      // and the teardown the row exists to trigger would never be emitted.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const manager = makeManagerWithEventBackend({ stateStore, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');
      await vi.advanceTimersByTimeAsync(0);
      const [adoptedId, orphanId] = [...rows.keys()];
      expect(adoptedId).toBeDefined();
      expect(orphanId).toBeDefined();

      // A peer registered and adopted the first agent; the second never came up.
      rows.get(adoptedId)!.adoptedBy = 'orch-b';

      // Cross the stale window, then drive the prune (requestScale runs it).
      await vi.advanceTimersByTimeAsync(301_000);
      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-3', 'run-3');
      await vi.advanceTimersByTimeAsync(0);

      // Both were pruned from memory — this instance owns neither any more…
      expect(manager.getStatus().spawningCount).toBe(1);
      // …and BOTH rows survived. The unadopted one is the regression: it is the
      // reaper's spawn-timeout candidate, and deleting it here erases the only
      // pointer at a cloud instance nobody would ever tear down.
      expect(rows.has(adoptedId)).toBe(true);
      expect(rows.has(orphanId)).toBe(true);
      // Neither delete may be reachable from the prune for an event backend.
      expect(stateStore.deleteUnadoptedSpawningAgent).not.toHaveBeenCalled();
      expect(stateStore.deleteSpawningAgent).not.toHaveBeenCalled();
    });

    it('releases the backend entry for a pruned spawn, so the global count stops ratcheting', async () => {
      // The spawning coordinator is never told that a peer adopted its agent,
      // so without an explicit release its `EventScalerBackend.agents` entry is
      // immortal: `getGlobalActiveCount` sums it against `globalMaxAgents` on
      // EVERY requestScale for EVERY backend, so a coordinator behind a shared
      // endpoint eventually refuses every spawn it is asked for.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const backend = makeEventBackend();
      const manager = makeManagerWithEventBackend({
        stateStore,
        instanceId: 'orch-a',
        eventBackend: backend,
      });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.getActiveCount()).toBe(2);
      const spawnedIds = [...rows.keys()];

      // A peer adopted one of them; the other never came up. Neither fact ever
      // reaches this coordinator.
      rows.get(spawnedIds[0]!)!.adoptedBy = 'orch-b';

      await vi.advanceTimersByTimeAsync(301_000);
      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-3', 'run-3');
      await vi.advanceTimersByTimeAsync(0);

      // Only the third spawn is still tracked here.
      expect(backend.getActiveCount()).toBe(1);
      expect(manager.getGlobalActiveCount()).toBe(1);
    });

    it('emits no teardown for a pruned spawn, whoever adopted it', async () => {
      // Forgetting is silent by construction: the adopter owns the teardown,
      // and the leader-gated reaper is the backstop. An emit here would tear
      // down a peer's running agent.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      rows.get([...rows.keys()][0]!)!.adoptedBy = 'orch-b';

      await vi.advanceTimersByTimeAsync(301_000);
      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2');
      await vi.advanceTimersByTimeAsync(0);

      expect(emitter.emitScalerScaleDown).not.toHaveBeenCalled();
    });

    it('takes its window from the configured spawn deadline when that is longer', async () => {
      // An operator raising KICI_SCALER_SPAWN_TIMEOUT_MS for a slow cloud must
      // not have the prune fire first: a provision booting inside the raised
      // deadline still needs its in-memory entry to correlate its bound job.
      const { rows, overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const manager = makeManagerWithEventBackend({
        stateStore,
        instanceId: 'orch-a',
        spawnTimeoutMs: 900_000,
      });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      const agentId = [...rows.keys()][0]!;

      // The prune runs before label matching, so an unmatched request drives it
      // without adding an entry of its own.
      await vi.advanceTimersByTimeAsync(301_000);
      await manager.requestScale(['nothing-matches-this'], 'job-2', 'run-2');
      await vi.advanceTimersByTimeAsync(0);
      // Past the historical five-minute literal, inside the configured deadline.
      expect(manager.getStatus().spawningCount).toBe(1);

      // Past the configured deadline: now it prunes.
      await vi.advanceTimersByTimeAsync(700_000);
      await manager.requestScale(['nothing-matches-this'], 'job-3', 'run-3');
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getStatus().spawningCount).toBe(0);
      // The row is still the reaper's, either way.
      expect(rows.has(agentId)).toBe(true);
    });
  });

  describe('shutdownAll()', () => {
    it('emits no scale-down for an event provision', async () => {
      // The backend map carries provisions a peer has already adopted — the
      // spawner is never told — so emitting on shutdown makes a routine
      // coordinator restart tear down a peer's running customer instances.
      // Teardown belongs to whichever coordinator holds the agent, and to the
      // leader-gated reaper for one that reaches nobody.
      const { overrides } = spawningRowTable();
      const stateStore = fakeStateStore(overrides);
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter, instanceId: 'orch-a' });

      await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      // The provision really is tracked, so the assertion below is not vacuous.
      expect(manager.getGlobalActiveCount()).toBe(1);

      await manager.shutdownAll();
      await vi.advanceTimersByTimeAsync(0);

      expect(emitter.emitScalerScaleDown).not.toHaveBeenCalled();
    });

    it('stops warm pool and shuts down all backends', async () => {
      const manager = createManager();
      manager.start();

      await manager.shutdownAll();

      expect(containerBackend.shutdownAll).toHaveBeenCalled();
      expect(bareMetalBackend.shutdownAll).toHaveBeenCalled();

      // Status should show 0 spawning after shutdown
      expect(manager.getStatus().spawningCount).toBe(0);
    });

    it('clears all tracking maps', async () => {
      const manager = createManager();

      // Spawn an agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      await manager.shutdownAll();

      expect(manager.getStatus().spawningCount).toBe(0);
    });
  });

  /** Reach the private retirement entry point that `reload` drives. */
  function retire(manager: ScalerManager, name: string): void {
    (manager as unknown as { retireBackend(n: string): void }).retireBackend(name);
  }

  describe('retirement', () => {
    it('stops routing to a retiring scaler', () => {
      const manager = createManager();
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(true);

      retire(manager, 'bare-metal-gpu');

      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(false);
      expect(manager.hasBackendForLabels(['linux', 'docker'])).toBe(true);
    });

    it('keeps a retiring backend visible and counted while it drains', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      // `requestScale` spawns fire-and-forget through the spawn semaphore, so
      // the mock's activeCount only rises once the admitted spawn runs.
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getGlobalActiveCount()).toBe(1);

      retire(manager, 'bare-metal-gpu');

      const gpu = manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu');
      expect(gpu?.retiring).toBe(true);
      expect(gpu?.activeCount).toBe(1);
      expect(manager.getGlobalActiveCount()).toBe(1);
    });

    it('stops advertising a retiring scaler to peers while it drains', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getRoutableCapacity().map((c) => c.name)).toContain('bare-metal-gpu');

      retire(manager, 'bare-metal-gpu');

      // Still on the diagnose row (it is draining) but no longer advertised, so
      // a peer cannot select this host for work the scaler will refuse.
      expect(manager.getStatus().backends.map((b) => b.name)).toContain('bare-metal-gpu');
      expect(manager.getRoutableCapacity().map((c) => c.name)).not.toContain('bare-metal-gpu');
      expect(manager.getRoutableCapacity().length).toBeGreaterThan(0);
    });

    it('tears the backend down once its last agent goes away', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      // `ScaleResult` carries no agent id, so read it off the spawn call.
      const agentId = (bareMetalBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      // The teardown path keys off the managed index, which registration fills.
      await manager.onAgentRegistered(agentId, ['linux', 'gpu']);

      manager.start(); // arms the retirement sweep interval
      retire(manager, 'bare-metal-gpu');
      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(true);

      manager.onAgentDisconnected(agentId);
      await vi.advanceTimersByTimeAsync(31_000); // one retirement sweep tick

      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(false);
      expect(bareMetalBackend.shutdownAll).toHaveBeenCalled();

      await manager.shutdownAll(); // clears the interval so the suite can exit
    });

    it('leaves a retiring backend in place while an agent is still bound', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      manager.start();
      retire(manager, 'bare-metal-gpu');
      await vi.advanceTimersByTimeAsync(31_000);

      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(true);
      expect(bareMetalBackend.shutdownAll).not.toHaveBeenCalled();

      await manager.shutdownAll();
    });

    it('keeps a scaler re-added by a reload that lands mid-teardown', async () => {
      // `shutdownAll` yields, and a reload can commit inside that window. The
      // sweep must not forget the name afterwards, or the operator's re-add
      // leaves a configured scaler with no backend at all.
      let releaseShutdown!: () => void;
      const shutdownGate = new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      });
      const draining = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
        shutdownAll: vi.fn(async () => {
          await shutdownGate;
        }),
      });
      const rebuilt = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
      });
      const manager = createManager(
        undefined,
        [
          { name: 'container-prod', backend: containerBackend },
          { name: 'bare-metal-gpu', backend: draining },
        ],
        undefined,
        vi.fn(async () => rebuilt),
      );

      retire(manager, 'bare-metal-gpu');
      const sweep = (
        manager as unknown as { sweepRetiredBackends(): Promise<void> }
      ).sweepRetiredBackends();

      // The operator puts the scaler back while the teardown is still pending.
      const result = await manager.reload(createDefaultConfig());
      expect(result.valid).toBe(true);

      releaseShutdown();
      await sweep;

      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(true);
      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(true);
      // The re-add is served by a fresh backend, not the one being torn down.
      expect(draining.shutdownAll).toHaveBeenCalledTimes(1);

      await manager.shutdownAll();
    });
  });

  describe('reload()', () => {
    it('validates new config and updates backends', async () => {
      const manager = createManager();

      const newConfig = {
        ...createDefaultConfig(),
        globalMaxAgents: 20,
      };

      const result = await manager.reload(newConfig);

      expect(result).toEqual({ valid: true });
      expect(containerBackend.reload).toHaveBeenCalledWith(newConfig.scalers[0].labelSets, {
        maxAgents: newConfig.scalers[0].maxAgents,
        entry: newConfig.scalers[0],
      });
      expect(bareMetalBackend.reload).toHaveBeenCalledWith(newConfig.scalers[1].labelSets, {
        maxAgents: newConfig.scalers[1].maxAgents,
        entry: newConfig.scalers[1],
      });
    });

    it('restores an already-reloaded backend when a later one rejects', async () => {
      // A real backend applies inside `reload`, so the mock must too: the
      // assertion is about the state a rejected reload left behind, not about
      // which calls it made.
      type MutableBackend = Omit<ScalerBackend, 'labelSets'> & { labelSets: LabelSetConfig[] };
      const originalLabelSets = [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:v1' }];
      const applying = createMockBackend({
        type: 'container',
        labelSets: originalLabelSets,
        maxAgents: 5,
      }) as MutableBackend;
      applying.reload = vi.fn(
        (labelSets: LabelSetConfig[], opts?: { maxAgents?: number }): ValidationResult => {
          applying.labelSets = labelSets;
          if (opts?.maxAgents !== undefined) applying.maxAgents = opts.maxAgents;
          return { valid: true };
        },
      );

      const rejecting = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
      });
      rejecting.reload = vi.fn((): ValidationResult => ({
        valid: false,
        errors: ['label set [0] requires a binaryPath'],
      }));

      const manager = createManager(undefined, [
        { name: 'container-prod', backend: applying },
        { name: 'bare-metal-gpu', backend: rejecting },
      ]);

      const cfg = createDefaultConfig();
      const result = await manager.reload({
        ...cfg,
        scalers: [
          {
            ...cfg.scalers[0],
            maxAgents: 9,
            labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:v2' }],
          },
          cfg.scalers[1],
        ],
      });

      expect(result.valid).toBe(false);
      // Called twice: once applying the new config, once restoring the old one.
      // Without the restore the first call's `maxAgents: 9` would still stand.
      expect(applying.reload).toHaveBeenCalledTimes(2);
      expect(applying.maxAgents).toBe(5);
      expect(applying.labelSets).toEqual(originalLabelSets);
    });

    /** The added scaler every add/remove test below reloads with. */
    function armEntry() {
      return {
        name: 'container-arm',
        type: 'container' as const,
        maxAgents: 4,
        maxConcurrentSpawns: 2,
        labelSets: [{ labels: ['linux', 'arm64'], image: 'arm:latest' }],
      };
    }

    it('constructs a backend for a newly added scaler', async () => {
      const added = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'arm64'], image: 'arm:latest' }],
        maxAgents: 4,
      });
      const createBackend = vi.fn(async () => added);
      const manager = createManager(undefined, undefined, undefined, createBackend);

      const cfg = createDefaultConfig();
      const result = await manager.reload({ ...cfg, scalers: [...cfg.scalers, armEntry()] });

      expect(result).toEqual({ valid: true });
      expect(createBackend).toHaveBeenCalledTimes(1);
      expect(manager.hasBackendForLabels(['linux', 'arm64'])).toBe(true);
      expect(manager.getStatus().backends.map((b) => b.name)).toContain('container-arm');
    });

    it('builds an added scaler from the reloaded config, not the boot-time one', async () => {
      const added = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'arm64'], image: 'arm:latest' }],
        maxAgents: 4,
      });
      const createBackend = vi.fn(async () => added);
      const manager = createManager(undefined, undefined, undefined, createBackend);

      // The factory reads `defaults.resources` and the firecracker network
      // block off the config it is handed; a boot-time config would build the
      // added scaler on the old CIDR and the old bridge.
      const cfg = createDefaultConfig();
      const reloaded = {
        ...cfg,
        firecracker: { cidr: '10.9.0.0/24', gateway: '10.9.0.1', bridgeName: 'kici-br9' },
        scalers: [...cfg.scalers, armEntry()],
      };
      await manager.reload(reloaded as never);

      expect(createBackend).toHaveBeenCalledTimes(1);
      const passedConfig = createBackend.mock.calls[0][1] as unknown as typeof reloaded;
      expect(passedConfig.firecracker).toEqual(reloaded.firecracker);
      expect(passedConfig.scalers.map((s) => s.name)).toContain('container-arm');
    });

    it('rejects an added scaler when no backend factory is configured', async () => {
      const manager = createManager();
      const cfg = createDefaultConfig();

      const result = await manager.reload({ ...cfg, scalers: [...cfg.scalers, armEntry()] });

      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors[0]).toContain('no backend factory configured');
      expect(manager.hasBackendForLabels(['linux', 'arm64'])).toBe(false);
    });

    it('keeps the previous config when a new backend fails to construct', async () => {
      const createBackend = vi.fn(async () => {
        throw new Error('container socket unreachable');
      });
      const manager = createManager(undefined, undefined, undefined, createBackend);
      const before = manager.getStatus().backends.map((b) => b.name);

      const cfg = createDefaultConfig();
      const result = await manager.reload({
        ...cfg,
        globalMaxAgents: 999,
        scalers: [...cfg.scalers, armEntry()],
      });

      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors[0]).toContain('container socket unreachable');
      expect(manager.getStatus().backends.map((b) => b.name)).toEqual(before);
      // The commit phase never ran, so globalMaxAgents is untouched.
      expect(manager.getStatus().globalMaxAgents).toBe(10);
    });

    it('restores a kept backend when a new backend fails to construct', async () => {
      // Validation applies as it validates, so a build failure after it lands
      // is the second way a reload can half-apply: the kept backends would keep
      // the new label sets while nothing else moved.
      type MutableBackend = Omit<ScalerBackend, 'labelSets'> & { labelSets: LabelSetConfig[] };
      const originalLabelSets = [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:v1' }];
      const applying = createMockBackend({
        type: 'container',
        labelSets: originalLabelSets,
        maxAgents: 5,
      }) as MutableBackend;
      applying.reload = vi.fn(
        (labelSets: LabelSetConfig[], opts?: { maxAgents?: number }): ValidationResult => {
          applying.labelSets = labelSets;
          if (opts?.maxAgents !== undefined) applying.maxAgents = opts.maxAgents;
          return { valid: true };
        },
      );

      const createBackend = vi.fn(async () => {
        throw new Error('container socket unreachable');
      });
      const manager = createManager(
        undefined,
        [{ name: 'container-prod', backend: applying }],
        undefined,
        createBackend,
      );

      const cfg = createDefaultConfig();
      const result = await manager.reload({
        ...cfg,
        scalers: [
          {
            ...cfg.scalers[0],
            maxAgents: 9,
            labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:v2' }],
          },
          armEntry(),
        ],
      });

      expect(result.valid).toBe(false);
      expect(applying.labelSets).toEqual(originalLabelSets);
      expect(applying.maxAgents).toBe(5);
    });

    it('rejects a scaler whose backend type changed', async () => {
      const manager = createManager();
      const cfg = createDefaultConfig();
      const result = await manager.reload({
        ...cfg,
        scalers: [{ ...cfg.scalers[0], type: 'bare-metal' as const }, cfg.scalers[1]],
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain('container-prod');
        expect(result.errors[0]).toContain('backend type cannot change');
      }
    });

    it('retires a removed scaler that still has an agent', async () => {
      const manager = createManager();
      const cfg = createDefaultConfig();
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      const result = await manager.reload({ ...cfg, scalers: [cfg.scalers[0]] });

      expect(result).toEqual({ valid: true });
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(false);
      const gpu = manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu');
      expect(gpu?.retiring).toBe(true);
      expect(gpu?.activeCount).toBe(1);
    });

    it('keeps a removed scaler alive while a spawn is still in flight', async () => {
      // A spawn the manager started but that has not reached `backend.spawn`
      // yet (or is mid-create) leaves the backend reporting zero active agents.
      // Tearing it down on that zero orphans the agent the spawn is about to
      // land: nothing would be left to destroy its process/container.
      bareMetalBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
        getActiveCount: () => 0,
        spawn: vi.fn(() => new Promise<ManagedAgent>(() => {})),
      });
      const manager = createManager();
      const cfg = createDefaultConfig();

      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(bareMetalBackend.spawn).toHaveBeenCalled();

      const result = await manager.reload({ ...cfg, scalers: [cfg.scalers[0]] });

      expect(result).toEqual({ valid: true });
      // Retired (no new routing) but NOT torn down — the in-flight spawn still
      // needs a backend to own the agent it lands.
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(false);
      const gpu = manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu');
      expect(gpu?.retiring).toBe(true);
      expect(bareMetalBackend.shutdownAll).not.toHaveBeenCalled();
    });

    it('tears down a removed scaler that has no agents', async () => {
      const manager = createManager();
      const cfg = createDefaultConfig();

      await manager.reload({ ...cfg, scalers: [cfg.scalers[0]] });

      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(false);
      expect(bareMetalBackend.shutdownAll).toHaveBeenCalled();
    });

    it('resurrects a still-draining scaler that reappears in the config', async () => {
      const createBackend = vi.fn(async () => {
        throw new Error('must not be called — the draining backend is reused');
      });
      const manager = createManager(undefined, undefined, undefined, createBackend);
      const cfg = createDefaultConfig();

      // Give it a live agent, so removing it leaves it draining rather than
      // tearing it down instantly (reload sweeps a scaler that drained to zero).
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      await manager.reload({ ...cfg, scalers: [cfg.scalers[0]] });
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(false);

      const result = await manager.reload(cfg);

      expect(result).toEqual({ valid: true });
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(true);
      expect(createBackend).not.toHaveBeenCalled();
      expect(manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu')?.retiring).toBe(
        false,
      );
    });

    it('re-adds a fully drained scaler through the factory', async () => {
      const rebuilt = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
      });
      const createBackend = vi.fn(async () => rebuilt);
      const manager = createManager(undefined, undefined, undefined, createBackend);
      const cfg = createDefaultConfig();

      // No agents: the removal drains instantly and the backend is torn down.
      await manager.reload({ ...cfg, scalers: [cfg.scalers[0]] });
      expect(manager.getStatus().backends.some((b) => b.name === 'bare-metal-gpu')).toBe(false);

      await manager.reload(cfg);

      expect(createBackend).toHaveBeenCalledTimes(1);
      expect(manager.hasBackendForLabels(['linux', 'gpu'])).toBe(true);
    });

    it('keeps a retiring scaler resource cap and orchestrator url', async () => {
      const cfg = createDefaultConfig();
      const withCap = {
        ...cfg,
        scalers: [
          cfg.scalers[0],
          {
            ...cfg.scalers[1],
            orchestratorUrl: 'ws://gpu-host:4000/ws',
            resourceCap: { maxCpu: 8, maxMemoryBytes: 1024 },
          },
        ],
      };
      const manager = createManager(withCap);
      await manager.requestScale(['linux', 'gpu'], 'job-1', 'run-1');
      // The backend must be non-idle to retire rather than vanish.
      await vi.advanceTimersByTimeAsync(0);

      await manager.reload({ ...withCap, scalers: [withCap.scalers[0]] });

      const gpu = manager.getStatus().backends.find((b) => b.name === 'bare-metal-gpu');
      expect(gpu?.retiring).toBe(true);
      expect(gpu?.resourceCap).toEqual({ maxCpu: 8, maxMemoryBytes: 1024 });
      // The url has no public getter; it is read straight off the map at spawn.
      const urls = (manager as unknown as { scalerUrls: Map<string, string | undefined> })
        .scalerUrls;
      expect(urls.get('bare-metal-gpu')).toBe('ws://gpu-host:4000/ws');
    });

    it('passes maxAgents to each kept backend', async () => {
      const manager = createManager();
      const cfg = createDefaultConfig();
      await manager.reload({
        ...cfg,
        scalers: [{ ...cfg.scalers[0], maxAgents: 12 }, cfg.scalers[1]],
      });

      expect(containerBackend.reload).toHaveBeenCalledWith(cfg.scalers[0].labelSets, {
        maxAgents: 12,
        entry: { ...cfg.scalers[0], maxAgents: 12 },
      });
    });

    it('rejects config with label-set overlaps', async () => {
      const manager = createManager();

      const overlappingConfig = {
        version: 1 as const,
        globalMaxAgents: 10,
        scalers: [
          {
            name: 'container-a',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'a:latest' }],
          },
          {
            name: 'container-b',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'b:latest' }],
          },
        ],
      };

      const result = await manager.reload(overlappingConfig);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain('docker,linux');
        expect(result.errors[0]).toContain('container-a');
        expect(result.errors[0]).toContain('container-b');
      }
    });

    it('updates globalMaxAgents', async () => {
      const manager = createManager();

      await manager.reload({
        ...createDefaultConfig(),
        globalMaxAgents: 50,
      });

      expect(manager.getStatus().globalMaxAgents).toBe(50);
    });
  });

  describe('getStatus()', () => {
    it('returns summary with correct backend information', () => {
      const manager = createManager();

      const status = manager.getStatus();

      expect(status.globalMaxAgents).toBe(10);
      expect(status.globalActiveCount).toBe(0);
      expect(status.spawningCount).toBe(0);
      expect(status.backends).toHaveLength(2);
      expect(status.backends[0].type).toBe('container');
      expect(status.backends[1].type).toBe('bare-metal');
    });

    it('reports usage and resource caps in status', async () => {
      const manager = createManager({
        globalResourceCap: { maxCpu: 8, maxMemoryBytes: 8 * 1024 ** 3 },
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 5,
            resourceCap: { maxCpu: 4, maxMemoryBytes: 4 * 1024 ** 3 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      await manager.requestScale(['linux', 'docker'], 'job-cap-1', 'run-test', [], {
        requests: { cpus: 1, memory: '1g' },
      });
      const status = manager.getStatus();
      expect(status.globalUsage.cpus).toBe(1);
      expect(status.globalUsage.memBytes).toBe(1024 ** 3);
      expect(status.backends[0].usage.cpus).toBe(1);
      expect(status.backends[0].resourceCap?.maxCpu).toBe(4);
      expect(status.globalResourceCap?.maxCpu).toBe(8);
    });
  });

  describe('platform taints', () => {
    function createPlatformManager(): ScalerManager {
      const winBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 2,
      });
      const linBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'bare-metal'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 2,
      });
      return new ScalerManager({
        instanceId: 'orch-test',
        spawnTimeoutMs: 300_000,
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win-pool',
              type: 'bare-metal',
              maxAgents: 2,
              labelSets: [{ labels: ['windows', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
            },
            {
              name: 'linux-pool',
              type: 'bare-metal',
              maxAgents: 2,
              labelSets: [
                { labels: ['linux', 'bare-metal'], binaryPath: '/usr/local/bin/kici-agent' },
              ],
            },
          ],
        },
        backends: [
          { name: 'win-pool', backend: winBackend },
          { name: 'linux-pool', backend: linBackend },
        ],
      });
    }

    it('taints a windows bare-metal backend mandatoryLabels (advertisement)', () => {
      const status = createPlatformManager().getStatus();
      const win = status.backends.find((b) => b.name === 'win-pool');
      expect(win?.mandatoryLabels).toContain('windows');
      const lin = status.backends.find((b) => b.name === 'linux-pool');
      expect(lin?.mandatoryLabels ?? []).not.toContain('windows');
    });

    it('rejects an unqualified bare-metal job on the windows pool (local matcher)', async () => {
      const manager = createPlatformManager();
      // Unqualified: no `windows` in required labels → windows pool must not match.
      const result = await manager.requestScale(['bare-metal'], 'job-u', 'run-u');
      expect(result.action).toBe('spawning');
      const status = manager.getStatus();
      // Only the linux pool may have an active/spawning agent.
      const win = status.backends.find((b) => b.name === 'win-pool');
      expect(win?.activeCount).toBe(0);
    });

    it('routes an OS-qualified job to the windows pool', async () => {
      const manager = createPlatformManager();
      const result = await manager.requestScale(['windows', 'bare-metal'], 'job-w', 'run-w');
      expect(result.action).toBe('spawning');
      expect(result).toMatchObject({ backendType: 'bare-metal' });
    });

    it('stamps the platform taint onto a registered windows-pool agent gate', async () => {
      const manager = createPlatformManager();
      // Spawn a windows-pool agent for an OS-qualified job.
      await manager.requestScale(['windows', 'bare-metal'], 'job-w', 'run-w');
      // On registration, the returned gate must include the derived `windows`
      // taint even though the pool declared no explicit mandatoryLabels — so the
      // local queue-drain and eager-dispatch paths reject an unqualified job that
      // would otherwise land on this wrong-OS agent.
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = await manager.onAgentRegistered(spawnedId, ['windows', 'bare-metal']);
      expect(registered?.mandatoryLabels).toContain('windows');
    });

    // A pool that declares a non-canonical OS label (`windows-2022`) that the
    // denylist would NOT catch, but supplies the structured platform field so
    // the taint still applies. Proves the synonym-escape gap is closed.
    function createStructuredPlatformManager(): ScalerManager {
      const winBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows-2022', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 2,
      });
      return new ScalerManager({
        instanceId: 'orch-test',
        spawnTimeoutMs: 300_000,
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win2022-pool',
              type: 'bare-metal',
              maxAgents: 2,
              platform: { os: 'windows', arch: 'x64' },
              labelSets: [
                { labels: ['windows-2022', 'bare-metal'], binaryPath: '/kici-agent.exe' },
              ],
            },
          ],
        },
        backends: [{ name: 'win2022-pool', backend: winBackend }],
      });
    }

    it('taints a synonym-labeled pool via the structured platform field (closes the denylist gap)', () => {
      const status = createStructuredPlatformManager().getStatus();
      const pool = status.backends.find((b) => b.name === 'win2022-pool');
      // Without the structured field, `windows-2022` escapes PLATFORM_TAINT_LABELS
      // and the pool would carry no taint. With it, the pool is tainted.
      expect(pool?.mandatoryLabels).toContain('windows');
    });

    it('injects the declared-platform os/arch labels into the pool label set', () => {
      const status = createStructuredPlatformManager().getStatus();
      const pool = status.backends.find((b) => b.name === 'win2022-pool');
      const flat = pool?.labelSets.flat() ?? [];
      expect(flat).toContain('kici:os:windows');
      expect(flat).toContain('kici:os:win32');
    });

    it('rejects an unqualified job on the structured-field windows pool', async () => {
      const manager = createStructuredPlatformManager();
      const result = await manager.requestScale(['bare-metal'], 'job-u2', 'run-u2');
      // No windows pool matches an unqualified job → no backend.
      expect(result.action).toBe('no-backend');
    });

    it('routes an os-qualified job to the structured-field windows pool', async () => {
      const manager = createStructuredPlatformManager();
      const result = await manager.requestScale(['windows', 'bare-metal'], 'job-w2', 'run-w2');
      expect(result.action).toBe('spawning');
    });

    it('stamps the structured-field taint onto a registered agent gate', async () => {
      const manager = createStructuredPlatformManager();
      await manager.requestScale(['windows', 'bare-metal'], 'job-w3', 'run-w3');
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = await manager.onAgentRegistered(spawnedId, ['windows', 'bare-metal']);
      expect(registered?.mandatoryLabels).toContain('windows');
    });
  });

  describe('mixed-platform label sets', () => {
    // `container` with no declared `platform` resolves to null on every host,
    // so the only taints in play are the legacy ones derived from each label
    // set's own labels — and the assertions stay machine-independent. A
    // bare-metal fixture would host-derive `arm64` on an arm64 box.
    function createMixedManager(): ScalerManager {
      const labelSets = [
        { labels: ['linux', 'gpu'], image: 'gpu:latest' },
        { labels: ['macos', 'xcode'], image: 'mac:latest' },
      ];
      const backend = createMockBackend({ type: 'container', labelSets, maxAgents: 4 });
      return new ScalerManager({
        instanceId: 'orch-test',
        spawnTimeoutMs: 300_000,
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'mixed-pool',
              type: 'container' as const,
              maxAgents: 4,
              maxConcurrentSpawns: 8,
              labelSets,
            },
          ],
        },
        backends: [{ name: 'mixed-pool', backend }],
      });
    }

    it('advertises a gate per label set, and the union on the deprecated field', () => {
      const status = createMixedManager().getStatus();
      const mixed = status.backends.find((b) => b.name === 'mixed-pool');
      expect(mixed?.labelSetMandatoryLabels).toEqual([[], ['macos']]);
      // The scaler-wide field stays the union, for a peer that predates the
      // per-label-set gate.
      expect(mixed?.mandatoryLabels).toEqual(['macos']);
    });

    it('keeps labelSetMandatoryLabels index-aligned with labelSets', () => {
      const mixed = createMixedManager()
        .getStatus()
        .backends.find((b) => b.name === 'mixed-pool');
      expect(mixed?.labelSetMandatoryLabels).toHaveLength(mixed?.labelSets.length ?? -1);
    });

    it('routes a linux job to the linux label set despite the macos sibling', async () => {
      const manager = createMixedManager();
      // Under the scaler-wide union this asked the job to declare `macos`,
      // so the linux label set was unroutable.
      const result = await manager.requestScale(['linux', 'gpu'], 'job-l', 'run-l');
      expect(result.action).toBe('spawning');
    });

    it('still refuses an unqualified job on the macos label set', async () => {
      const manager = createMixedManager();
      const result = await manager.requestScale(['xcode'], 'job-x', 'run-x');
      expect(result.action).toBe('no-backend');
    });

    it('stamps only the spawning label set gate onto the registered agent', async () => {
      const manager = createMixedManager();
      await manager.requestScale(['linux', 'gpu'], 'job-l2', 'run-l2');
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = await manager.onAgentRegistered(spawnedId, ['linux', 'gpu']);
      // The sibling set's `macos` taint must not reach a linux agent, or
      // `AgentRegistry.findAvailable` could never return it.
      expect(registered?.mandatoryLabels).toEqual([]);
    });

    it('stamps the macos gate onto an agent spawned for the macos label set', async () => {
      const manager = createMixedManager();
      await manager.requestScale(['macos', 'xcode'], 'job-m', 'run-m');
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = await manager.onAgentRegistered(spawnedId, ['macos', 'xcode']);
      expect(registered?.mandatoryLabels).toEqual(['macos']);
    });

    it('advertises the per-label-set gate to peers alongside the union', () => {
      const capacity = createMixedManager().getRoutableCapacity();
      const mixed = capacity.find((c) => c.name === 'mixed-pool');
      expect(mixed?.labelSetMandatoryLabels).toEqual([[], ['macos']]);
      expect(mixed?.mandatoryLabels).toEqual(['macos']);
    });

    it('keeps the deprecated union in step with the per-set gates while retiring', () => {
      const manager = createMixedManager();
      retire(manager, 'mixed-pool');
      const mixed = manager.getStatus().backends.find((b) => b.name === 'mixed-pool');
      // A retiring scaler has no enriched entry, so both gate fields take their
      // fallback branch. `mandatoryLabels` is documented as the union of the
      // per-set gates, and a fallback reading only the configured gate (empty
      // here) would drop the `macos` taint the second label set carries.
      expect(mixed?.retiring).toBe(true);
      expect(mixed?.labelSetMandatoryLabels).toEqual([[], ['macos']]);
      expect(mixed?.mandatoryLabels).toEqual(['macos']);
    });
  });

  describe('resource caps', () => {
    it('refuses spawn when per-scaler cpu cap would be exceeded', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 1.5 },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');
    });

    it('refuses spawn when global resource cap would be exceeded', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        globalResourceCap: { maxMemoryBytes: 2 * 1024 ** 3 },
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { memory: '1500m' },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { memory: '1g' },
      });
      expect(r2.action).toBe('at-capacity');
    });

    it('releases reservation on agent disconnect', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      // First reservation maxes out the per-scaler cpu cap.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');

      // Second is denied.
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');

      // Find the spawn'd agent's id and call onAgentDisconnected.
      const spawnArgs = vi.mocked(containerBackend.spawn).mock.calls;
      const spawnedAgentId = spawnArgs[0][1] as string;
      // Simulate registration to populate managedAgentIndex (so the destroy path runs).
      manager.onAgentRegistered(spawnedAgentId, ['linux', 'docker']);
      manager.onAgentDisconnected(spawnedAgentId);

      // Now the third request should succeed since the reservation was released.
      const r3 = await manager.requestScale(['linux', 'docker'], 'job-c', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r3.action).toBe('spawning');
    });

    it('releases the reservation when a stale spawning entry is pruned', async () => {
      // A spawn that never resolves models an agent that was created but never
      // registered its WS — so neither the spawn-failure path nor
      // onAgentDisconnected ever fires. The only cleanup is the stale-entry
      // prune, which must release the held reservation or the per-scaler cap
      // leaks capacity forever (the cross-process machine-pool E2E's real
      // failure: a warm-reused orch DB accumulated orphaned scaler_reservations
      // and every requestScale was rejected at-capacity with zero agents).
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 100,
        spawn: vi.fn((): Promise<ManagedAgent> => new Promise(() => {})),
      });
      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 100,
              resourceCap: { maxCpu: 2 },
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // First reservation maxes out the per-scaler cpu cap; it never registers.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');
      expect(manager.getStatus().backends[0].usage.cpus).toBe(2);

      // A second request is denied while the stale reservation is held.
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');

      // Advance past the 5-minute stale threshold, then a request prunes the
      // stale entry — which must free its reservation so the cap math recovers.
      vi.advanceTimersByTime(301_000);
      const r3 = await manager.requestScale(['linux', 'docker'], 'job-c', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r3.action).toBe('spawning');
      // Only the freshly reserved 1 cpu remains; the pruned 2 were released.
      expect(manager.getStatus().backends[0].usage.cpus).toBe(1);
    });

    it('mirrors limits-only resources into requests for cap math', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      // Limits-only: requests = limits per the mirroring rule.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        limits: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        limits: { cpus: 0.5 },
      });
      expect(r2.action).toBe('at-capacity');
    });
  });

  describe('handleScalerEvent() — failure attribution', () => {
    /**
     * Pull the per-agent event emitter the manager handed to backend.spawn().
     * The closure ignores the agentId it captured and routes whatever event it
     * receives through handleScalerEvent(), so a single captured emitter can
     * synthesize an event for any agentId.
     */
    function captureOnEvent(backend: ScalerBackend): (event: ScalerEvent) => void {
      const call = (backend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      return call[3] as (event: ScalerEvent) => void;
    }

    it('attributes a bound pre-registration failure via the spawning entry', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // Spawn a job-bound agent but do NOT register or correlate it: this is a
      // spawn that dies before the agent ever connects via WS.
      await manager.requestScale(['linux', 'docker'], 'job-77', 'run-77');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);

      const event: ScalerEvent = {
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'node not found (ENOENT)',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // The failure is routed to the bound job via the spawning entry's
      // runId/boundJobId even though no correlation was established.
      expect(onScalerEvent).toHaveBeenCalledWith('run-77', 'job-77', event);
    });

    it('does not route an unbound/warm-pool failure (count + warn only)', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // A spawn gives us a real emitter closure; firing it with an event for a
      // DIFFERENT agentId (no spawning entry, no correlation) exercises the
      // unattributable path.
      await manager.requestScale(['linux', 'docker'], 'job-88', 'run-88');
      const onEvent = captureOnEvent(containerBackend);

      const event: ScalerEvent = {
        agentId: 'orphan-agent',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'spawn failed for an agent the manager never tracked',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // No attribution → not relayed, only counted + warned. The event is
      // buffered for a (never-arriving) correlation, but onScalerEvent must
      // not fire for it.
      expect(onScalerEvent).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), event);
    });

    it('attributes a post-registration failure via the correlation map after the spawning entry is gone', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // Spawn an agent, then register it: registration deletes the spawning
      // entry and records the backend in managedAgentIndex, mimicking the state
      // a long-lived bare-metal child 'error' listener sees if it fires after
      // the agent has already connected via WS.
      await manager.requestScale(['linux', 'docker'], undefined, undefined);
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // A job is then dispatched to the registered agent, establishing
      // correlation — the only remaining attribution source now that the
      // spawning entry is gone.
      manager.correlateAgentToJob(agentId, 'run-99', 'job-99');

      const event: ScalerEvent = {
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'bare-metal child error after registration',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // The failure routes to the correlated job even though no spawning entry
      // remains.
      expect(onScalerEvent).toHaveBeenCalledWith('run-99', 'job-99', event);
    });
  });

  describe('recentSpawnFailures()', () => {
    function captureOnEvent(backend: ScalerBackend): (event: ScalerEvent) => void {
      const call = (backend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      return call[3] as (event: ScalerEvent) => void;
    }

    it('records scaler.failed events grouped per backend with bound/unbound counts', async () => {
      const manager = createManager();

      // A job-bound spawn that fails before the agent ever connects.
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);

      const ts = Date.now();
      onEvent({
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'no such image',
        timestampMs: ts,
      });

      const map = manager.recentSpawnFailures(300_000, ts + 1);
      expect(map).toBeInstanceOf(Map);
      const summary = map.get('container-prod');
      expect(summary).toMatchObject({
        backendType: 'container',
        boundCount: 1,
        unboundCount: 0,
        lastError: 'no such image',
        lastAtMs: ts,
      });
    });
  });

  describe('spawn timeout', () => {
    function makeContainerConfig(maxConcurrentSpawns = 1) {
      return {
        version: 1 as const,
        globalMaxAgents: 10,
        scalers: [
          {
            name: 'c',
            type: 'container' as const,
            maxAgents: 5,
            maxConcurrentSpawns,
            labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
          },
        ],
      };
    }

    it('rejects a hung spawn at the deadline, releases the semaphore slot and lets the next spawn proceed', async () => {
      const spawnCalls: string[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        // The spawn never actually completes, so the backend stays "empty".
        getActiveCount: () => 0,
        spawn: vi.fn((_ls, agentId, _url, _ev, _lim, _ctx, signal) => {
          spawnCalls.push(agentId);
          signals.push(signal);
          return new Promise<never>(() => {}); // hangs forever
        }),
      });
      const manager = new ScalerManager({
        instanceId: 'orch-test',
        config: makeContainerConfig(1),
        backends: [{ name: 'c', backend }],
        spawnTimeoutMs: 50,
      });

      const r1 = await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1');
      expect(r1.action).toBe('spawning');

      // Let the fire-and-forget spawn start; job-2 then queues behind the
      // single-slot semaphore.
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnCalls.length).toBe(1);

      const r2 = await manager.requestScale(['linux', 'docker'], 'job-2', 'run-2');
      expect(r2.action).toBe('spawning');
      await vi.advanceTimersByTimeAsync(1);
      // Still head-of-line blocked behind the hung first spawn.
      expect(spawnCalls.length).toBe(1);

      // Blow the first spawn's deadline: it aborts, rejects, and frees the slot.
      await vi.advanceTimersByTimeAsync(60);
      expect(signals[0]?.aborted).toBe(true);
      // Reservation released so cap accounting is back to zero usage.
      expect(manager.getGlobalActiveCount()).toBe(0);

      // The second spawn was admitted the moment the slot freed.
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnCalls.length).toBe(2);
    });

    it('uses the per-org resolved timeout when resolveSpawnTimeoutMs is provided', async () => {
      const resolve = vi.fn(async (orgId?: string) => (orgId === 'org-fast' ? 20 : 5000));
      let aborted = false;
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        getActiveCount: () => 0,
        spawn: vi.fn((_ls, _id, _url, _ev, _lim, _ctx, signal) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise<never>(() => {});
        }),
      });
      const manager = new ScalerManager({
        instanceId: 'orch-test',
        config: makeContainerConfig(1),
        backends: [{ name: 'c', backend }],
        spawnTimeoutMs: 5000,
        resolveSpawnTimeoutMs: resolve,
      });

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1', [], undefined, 'org-fast');
      await vi.advanceTimersByTimeAsync(30);
      expect(resolve).toHaveBeenCalledWith('org-fast');
      // The 20ms per-org deadline fired, not the 5000ms cluster default.
      expect(aborted).toBe(true);
    });
  });

  describe('ensureHostsReady()', () => {
    it('runs every backend and continues past a throwing one', async () => {
      const calls: string[] = [];
      const good = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        ensureHostReady: async () => {
          calls.push('good');
        },
      });
      const bad = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
        ensureHostReady: async () => {
          calls.push('bad');
          throw new Error('no sudo');
        },
      });
      const manager = createManager(undefined, [
        { name: 'container-prod', backend: good },
        { name: 'bare-metal-gpu', backend: bad },
      ]);
      await expect(manager.ensureHostsReady()).resolves.toBeUndefined();
      expect(calls).toEqual(['good', 'bad']);
    });

    it('skips a backend without ensureHostReady', async () => {
      const manager = createManager();
      await expect(manager.ensureHostsReady()).resolves.toBeUndefined();
    });
  });

  describe('cluster-wide maxAgents (event backends)', () => {
    // The event scaler's `github-actions` entry carries `maxAgents: 10` and the
    // mandatory `kici:os:linux` taint, so a request has to tolerate the taint
    // for the label matcher to route to it at all.
    const EVENT_LABELS = ['github-actions', 'kici:os:linux'];

    /** Every spawn row the manager wrote through the store double. */
    const rowsWritten = (store: ReturnType<typeof fakeStateStore>): ClaimedSnapshot[] =>
      store.upsertSpawningAgent.mock.calls.map((call) => call[0] as ClaimedSnapshot);

    beforeEach(() => {
      vi.mocked(incScalerSpawnRefusals).mockClear();
      vi.mocked(scalerCapLockFailuresTotal.add).mockClear();
    });

    it('refuses an event spawn once peers already hold the whole cap', async () => {
      // The negative control. The local agent map is empty and
      // `backend.getActiveCount()` is 0, so an in-process cap check admits —
      // only the cluster-wide count refuses.
      const stateStore = seedClusterCount(fakeStateStore(), 10);
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter });

      const result = await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(result).toEqual({ action: 'at-capacity' });
      expect(rowsWritten(stateStore)).toHaveLength(0);
      // No cloud instance was asked for — the refusal is what the operator pays.
      expect(emitter.emitScalerScaleUp).not.toHaveBeenCalled();
      // A full cluster moves the refusal series, exactly as the resource caps
      // two functions away do — and NOT the cap-lock failure series.
      expect(incScalerSpawnRefusals).toHaveBeenCalledTimes(1);
      expect(scalerCapLockFailuresTotal.add).not.toHaveBeenCalled();
    });

    it('admits an event spawn below the cap and claims the slot in the same lock', async () => {
      // The positive control for the case above: same harness, one fewer peer.
      const stateStore = seedClusterCount(fakeStateStore(), 9);
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter });

      const result = await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(result).toEqual({ action: 'spawning', backendType: 'event' });
      expect(emitter.emitScalerScaleUp).toHaveBeenCalledTimes(1);
      // Exactly one row write, and it happened through the lock — a second
      // write outside the transaction would only reset the `spawned_at` the
      // reaper ages the provision on.
      expect(stateStore.withScalerCapLock).toHaveBeenCalledTimes(1);
      expect(rowsWritten(stateStore)).toHaveLength(1);
      // The claim carries the whole self-describing row: one that dropped
      // `backendType` would be uncountable by the next holder of the lock, and
      // unadoptable by every instance.
      expect(rowsWritten(stateStore)[0]).toMatchObject({
        scalerName: 'github-actions',
        backendType: ScalerBackendType.enum.event,
        boundJobId: 'job-1',
        ownerInstanceId: 'orch-test',
      });
    });

    it('bounds a burst at maxAgents because each admission claims its slot', async () => {
      // The cap only bounds anything if the check and the claim are one step.
      // Seeded at 8 of 10: two admissions, then the third reads the count its
      // own predecessors wrote. A manager that counted without claiming would
      // read 8 forever and admit all three.
      const stateStore = seedClusterCount(fakeStateStore(), 8);
      const manager = makeManagerWithEventBackend({ stateStore });

      const first = await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1');
      const second = await manager.requestScale(EVENT_LABELS, 'job-2', 'run-1');
      const third = await manager.requestScale(EVENT_LABELS, 'job-3', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(first).toEqual({ action: 'spawning', backendType: 'event' });
      expect(second).toEqual({ action: 'spawning', backendType: 'event' });
      expect(third).toEqual({ action: 'at-capacity' });
      // Two distinct agents, not one row upserted twice.
      expect(new Set(rowsWritten(stateStore).map((row) => row.agentId)).size).toBe(2);
    });

    it('holds the in-process lock across the whole cap round trip', async () => {
      // The cluster-wide check is the first `await` inside the reservation
      // lock's critical section, and a critical section is only critical if the
      // lock outlives it. With one slot left, a second request that slipped in
      // while the first was still at the database would read the same count and
      // admit too.
      const stateStore = fakeStateStore();
      let capLockCalls = 0;
      let openGate!: () => void;
      const gateOpened = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      stateStore.withScalerCapLock = vi.fn(
        async (_name: string, fn: (slot: FakeCapSlot) => unknown) => {
          // The first caller stays inside the lock until the test releases it.
          if (++capLockCalls === 1) await gateOpened;
          return fn({
            clusterActiveCount: 9 + stateStore.upsertSpawningAgent.mock.calls.length,
            reserve: (snapshot) => stateStore.upsertSpawningAgent(snapshot),
          });
        },
      );
      const manager = makeManagerWithEventBackend({ stateStore });

      const first = manager.requestScale(EVENT_LABELS, 'job-1', 'run-1');
      const second = manager.requestScale(EVENT_LABELS, 'job-2', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      // The second request has not reached the store at all — it is queued
      // behind the first on the in-process lock.
      expect(capLockCalls).toBe(1);

      openGate();
      expect(await first).toEqual({ action: 'spawning', backendType: 'event' });
      expect(await second).toEqual({ action: 'at-capacity' });
      expect(rowsWritten(stateStore)).toHaveLength(1);
    });

    it('refuses rather than provisioning when the cap lock itself fails', async () => {
      // A count nobody recorded is not an admission: spawning here bills for a
      // cloud instance the cluster-wide cap cannot see.
      const stateStore = fakeStateStore({
        withScalerCapLock: vi.fn().mockRejectedValue(new Error('connection terminated')),
      });
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter });

      const result = await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(result).toEqual({ action: 'at-capacity' });
      expect(emitter.emitScalerScaleUp).not.toHaveBeenCalled();
      // The outcome is the same `at-capacity` a full cluster produces, so the
      // two must be distinguishable on the series or a database outage reads
      // as a busy cluster on every dashboard.
      expect(scalerCapLockFailuresTotal.add).toHaveBeenCalledWith(1, {
        reason: ScalerCapLockFailureReason.Unreachable,
      });
      expect(incScalerSpawnRefusals).not.toHaveBeenCalled();
    });

    it('releases the claimed cluster slot when the spawn itself fails', async () => {
      // The claim is written before the spawn is attempted, so a failed spawn
      // that left the row behind would count against every coordinator's cap
      // for an agent that never existed — until the reaper's spawn deadline.
      const stateStore = seedClusterCount(fakeStateStore(), 0);
      const entry = eventScalerEntry();
      const emitter = fakeEmitter();
      const backend = makeEventBackend({ entry, emitter, stateStore });
      vi.spyOn(backend, 'spawn').mockRejectedValue(new Error('provisioning target unreachable'));
      const manager = makeManagerWithEventBackend({ stateStore, emitter, eventBackend: backend });

      expect(await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1')).toEqual({
        action: 'spawning',
        backendType: 'event',
      });
      // The slot really was claimed, so the delete below is undoing something.
      expect(rowsWritten(stateStore)).toHaveLength(1);
      const agentId = rowsWritten(stateStore)[0].agentId;

      await vi.advanceTimersByTimeAsync(0);

      expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith(agentId);
    });

    it('labels a contended lock apart from an unreachable database', async () => {
      // `SET LOCAL lock_timeout` gives the cap check a third outcome: the
      // database was reached and is healthy, but the advisory lock was still
      // held when the budget expired. Both refuse the spawn, so only the label
      // tells an operator whether to fix Postgres or raise the scaler's cap.
      const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      });
      const stateStore = fakeStateStore({
        withScalerCapLock: vi.fn().mockRejectedValue(lockTimeout),
      });
      const manager = makeManagerWithEventBackend({ stateStore });

      expect(await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1')).toEqual({
        action: 'at-capacity',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(scalerCapLockFailuresTotal.add).toHaveBeenCalledWith(1, {
        reason: ScalerCapLockFailureReason.Contended,
      });
      // Not the other reason, and not a capacity refusal — three distinct
      // faults, three distinct signals.
      expect(scalerCapLockFailuresTotal.add).not.toHaveBeenCalledWith(1, {
        reason: ScalerCapLockFailureReason.Unreachable,
      });
      expect(incScalerSpawnRefusals).not.toHaveBeenCalled();
    });

    it('releases the claimed cluster slot when the machine ledger refuses', async () => {
      // The cross-process pool reservation runs AFTER the slot is claimed, so a
      // refusal there is the other path that can leave a row counting against
      // every coordinator's cap for an agent that never spawned. The ledger's
      // own arithmetic is covered in machine-ledger.test.ts; what matters here
      // is only that the manager unwinds its claim when the answer is no.
      const tryReserve = vi
        .spyOn(MachineLedger.prototype, 'tryReserve')
        .mockResolvedValue(false as never);
      try {
        const stateStore = seedClusterCount(fakeStateStore(), 0);
        const emitter = fakeEmitter();
        const entry: ScalerEntry = { ...eventScalerEntry(), machinePool: 'pool-a' };
        const backend = makeEventBackend({ entry, emitter, stateStore });
        const manager = makeManager({
          stateStore,
          emitter,
          backends: [{ name: entry.name, backend }],
          machineLedger: { dir: '/nonexistent-ledger-dir', instanceId: 'orch-test' },
          config: {
            version: 1 as const,
            globalMaxAgents: 100,
            machinePools: [{ name: 'pool-a', cap: { maxCpu: 8 } }],
            scalers: [entry],
          },
        });

        expect(await manager.requestScale(EVENT_LABELS, 'job-1', 'run-1')).toEqual({
          action: 'at-capacity',
        });

        expect(tryReserve).toHaveBeenCalledTimes(1);
        // The slot really was claimed before the ledger was asked, so the
        // delete below is undoing something.
        expect(rowsWritten(stateStore)).toHaveLength(1);
        expect(stateStore.deleteSpawningAgent).toHaveBeenCalledWith(
          rowsWritten(stateStore)[0].agentId,
        );
        // And no cloud instance was ever asked for.
        expect(emitter.emitScalerScaleUp).not.toHaveBeenCalled();
      } finally {
        tryReserve.mockRestore();
      }
    });

    it('keeps the in-process cap path for local backends', async () => {
      // A container / bare-metal / firecracker cap bounds this host's own
      // compute, which is what the operator asked for — it must not become a
      // cluster-wide number.
      const stateStore = fakeStateStore();
      const manager = makeManagerWithContainerBackend({ stateStore });

      const result = await manager.requestScale(['default'], 'job-1', 'run-1');
      await vi.advanceTimersByTimeAsync(0);

      // Asserting the outcome too: a `no-backend` result would satisfy the
      // not-called assertion without ever reaching the cap check.
      expect(result).toEqual({ action: 'spawning', backendType: 'container' });
      expect(stateStore.withScalerCapLock).not.toHaveBeenCalled();
      // The row is still persisted, just outside any cluster-wide lock.
      expect(rowsWritten(stateStore)).toHaveLength(1);
    });
  });

  describe('test harness', () => {
    it('gives the manager a real EventScalerBackend, not a look-alike', async () => {
      // The manager branches on `instanceof EventScalerBackend` to reach the
      // event-only lifecycle calls (claim registration, scale-up/scale-down
      // emission, adoption). A structural look-alike fails that check silently,
      // so every test built on this helper would pass while never entering the
      // branch. Assert through the manager's own public path: only a real event
      // backend registers a claim row and emits a scale-up.
      const stateStore = fakeStateStore();
      const emitter = fakeEmitter();
      const manager = makeManagerWithEventBackend({ stateStore, emitter });

      // `kici:os:linux` is the scaler's mandatory (taint) label, so the request
      // has to tolerate it for the label matcher to route here at all.
      const result = await manager.requestScale(
        ['github-actions', 'kici:os:linux'],
        'job-1',
        'run-1',
      );
      // The manager reports `spawning` without awaiting the backend, so let the
      // claim registration and the scale-up emission settle before asserting.
      await vi.advanceTimersByTimeAsync(0);

      expect(result).toEqual({ action: 'spawning', backendType: 'event' });
      expect(stateStore.registerClaim).toHaveBeenCalledTimes(1);
      expect(emitter.emitScalerScaleUp).toHaveBeenCalledTimes(1);
    });

    it('rejects a fakeStateStore override that names no real store method', () => {
      // Without the guard this typo applies nothing, leaves the permissive
      // default in place, and the test that wrote it passes for the wrong
      // reason — with no lint or typecheck pass over this file to catch it.
      expect(() => fakeStateStore({ redeemClam: vi.fn() })).toThrow(/redeemClam/);
      expect(() => fakeStateStore({ redeemClaim: vi.fn() })).not.toThrow();
    });
  });

  describe('claimScalerCredentials()', () => {
    it('redeems a claim on an instance that has no event backend at all', async () => {
      const manager = makeManagerWithNoBackends({
        stateStore: fakeStateStore(),
        claimStore: {
          claim: vi.fn().mockResolvedValue({
            agentToken: 'kat_x',
            agentId: 'agent-77',
            orchestratorUrl: 'wss://h/ws',
            labels: ['github-actions'],
          }),
        },
      });

      const creds = await manager.claimScalerCredentials('a-code-minted-elsewhere');

      expect(creds.error).toBeUndefined();
      expect(creds.credentials?.agentId).toBe('agent-77');
    });

    it('reports the store error verbatim when redemption fails', async () => {
      const manager = makeManagerWithNoBackends({
        claimStore: { claim: vi.fn().mockRejectedValue(new Error('claim code expired')) },
      });

      const creds = await manager.claimScalerCredentials('old');

      expect(creds.error).toMatch(/expired/);
      expect(creds.credentials).toBeUndefined();
    });

    it('hands the store the code verbatim', async () => {
      const claim = vi.fn().mockResolvedValue({
        agentToken: 'kat_x',
        agentId: 'agent-77',
        orchestratorUrl: 'wss://h/ws',
        labels: ['github-actions'],
      });
      const manager = makeManagerWithNoBackends({ claimStore: { claim } });

      await manager.claimScalerCredentials('deadbeef-code');

      expect(claim).toHaveBeenCalledWith('deadbeef-code');
    });

    it('refuses when the instance carries no claim store, even with an event scaler configured', async () => {
      // A configured event backend is not itself a redemption path any more:
      // without the shared claim table this instance can mint nothing.
      const manager = makeManagerWithEventBackend();

      const creds = await manager.claimScalerCredentials('some-code');

      expect(creds).toEqual({ error: 'invalid claim code' });
    });

    it('redeems a code minted by another coordinator, single-use across both', async () => {
      // One shared `scaler_pending_claims` table, two coordinators. The minting
      // side runs an event scaler; the redeeming side has only a container
      // scaler and has never heard of `github-actions`.
      const table = makeFakeScalerStateStore();
      const mints: Array<{ agentId: string; labels: string[]; ttlMs: number }> = [];
      const createEphemeral = async (agentId: string, labels: string[], ttlMs: number) => {
        mints.push({ agentId, labels, ttlMs });
        return `kat_${agentId}_${labels.join('+')}`;
      };

      const emittingStore = new ClaimStore({
        createEphemeral,
        stateStore: table,
        scalerName: 'github-actions',
        ttlDefaultSec: DEFAULT_CLAIM_TTL_SECONDS,
      });
      const code = await emittingStore.register({
        agentId: 'agent-77',
        labels: ['github-actions', 'kici:scaler:github-actions'],
        mandatoryLabels: ['kici:os:linux'],
        agentTokenTtlSeconds: 600,
        orchestratorUrl: 'wss://shared-endpoint/ws',
      });

      const redeemer = makeManagerWithContainerBackend({
        // No `scalerName`: this store only ever redeems.
        claimStore: new ClaimStore({
          createEphemeral,
          stateStore: table,
          ttlDefaultSec: DEFAULT_CLAIM_TTL_SECONDS,
        }),
      });

      const first = await redeemer.claimScalerCredentials(code);
      expect(first.error).toBeUndefined();
      expect(first.credentials).toEqual({
        agentToken: 'kat_agent-77_github-actions+kici:scaler:github-actions',
        agentId: 'agent-77',
        orchestratorUrl: 'wss://shared-endpoint/ws',
        labels: ['github-actions', 'kici:scaler:github-actions'],
      });

      // The registered `agentTokenTtlSeconds: 600` has to survive the round
      // trip through the table as `agentTokenTtlMs` and reach the mint, or the
      // provisioned agent's token silently gets the wrong lifetime.
      expect(mints).toEqual([
        {
          agentId: 'agent-77',
          labels: ['github-actions', 'kici:scaler:github-actions'],
          ttlMs: 600_000,
        },
      ]);

      // Single-use is enforced by the shared table, so the second redeem —
      // on the same instance or any other — mints nothing.
      const second = await redeemer.claimScalerCredentials(code);
      expect(second.credentials).toBeUndefined();
      expect(second.error).toBe('claim code already consumed');
      expect(mints).toHaveLength(1);
    });
  });
});

describe('external-provision backoff', () => {
  /**
   * Drive one reaper spawn-timeout verdict through the manager, which is the
   * only thing that records an external-provision failure. Returns nothing —
   * the state it changes is read back through `requestScale`.
   */
  async function failProvision(
    manager: ScalerManager,
    scalerName = 'github-actions',
    agentId = 'agent-77',
  ): Promise<void> {
    await manager.emitOrphanScaleDown(
      {
        agentId,
        scalerName,
        provisioningTargets: ['e2e/provision'],
        spawnedAt: new Date('2026-08-26T11:00:00Z'),
      },
      ScaleDownReason.enum['spawn-timeout'],
    );
  }

  const backoff =
    (over: Partial<ProvisionBackoffSettings> = {}) =>
    async () => ({
      baseMs: 30_000,
      maxMs: 900_000,
      maxConsecutiveFailures: 5,
      ...over,
    });

  it('defers the next spawn request after a provisioning failure', async () => {
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });

    // A request before any failure spawns normally, so the refusal below is
    // caused by the failure and not by an unrelated capacity or match problem.
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0')).action,
    ).toBe('spawning');

    await failProvision(manager);

    const result = await manager.requestScale(
      ['github-actions', 'kici:os:linux'],
      'job-1',
      'run-1',
    );
    expect(result.action).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('github-actions');
    expect((result as { reason: string }).reason).toContain('deferring');
  });

  it('grows the deferral exponentially and caps it', async () => {
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-a',
      // A tiny cap makes the ceiling observable within a handful of failures.
      resolveProvisionBackoff: backoff({ baseMs: 1000, maxMs: 4000 }),
    });

    // Each failure needs its OWN agent id: one dead provision is counted once,
    // however many observers see it, so reusing an id would dedupe the very
    // repetition this case measures.
    let seq = 0;
    const waitAfter = async (failures: number): Promise<number> => {
      for (let i = 0; i < failures; i += 1)
        await failProvision(manager, 'github-actions', `a${seq++}`);
      const result = await manager.requestScale(
        ['github-actions', 'kici:os:linux'],
        'job-x',
        'run-x',
      );
      const reason = (result as { reason: string }).reason;
      return Number(/deferring for (\d+)s/.exec(reason)![1]);
    };

    // 1 failure → 1s, 2 → 2s, 3 → 4s, 4 → capped at 4s. Each call adds one
    // more failure to the same manager, so the sequence is cumulative.
    expect(await waitAfter(1)).toBe(1);
    expect(await waitAfter(1)).toBe(2);
    expect(await waitAfter(1)).toBe(4);
    expect(await waitAfter(1)).toBe(4);
  });

  it('names repeated failure once the configured limit is reached', async () => {
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff({ baseMs: 1000, maxMs: 4000, maxConsecutiveFailures: 2 }),
    });

    await failProvision(manager, 'github-actions', 'a0');
    const first = await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    expect((first as { reason: string }).reason).not.toContain('in a row');

    await failProvision(manager, 'github-actions', 'a1');
    const second = await manager.requestScale(
      ['github-actions', 'kici:os:linux'],
      'job-2',
      'run-2',
    );
    expect((second as { reason: string }).reason).toContain('2 times in a row');
    expect((second as { reason: string }).reason).toContain('provisioning workflow');
  });

  it('clears the backoff when a locally-spawned agent registers', async () => {
    const emitter = fakeEmitter();
    const manager = makeManagerWithEventBackend({
      emitter,
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });

    // Spawn first so a real spawning entry exists for the registration below.
    // The agent id comes off the scale-up the backend actually emitted, which
    // is the same id the provisioned agent registers with.
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    await vi.waitFor(() => expect(emitter.emitScalerScaleUp).toHaveBeenCalled());
    const agentId = (emitter.emitScalerScaleUp.mock.calls[0]![0] as { agentId: string }).agentId;
    await failProvision(manager);
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1')).action,
    ).toBe('skipped');

    await manager.onAgentRegistered(agentId, ['github-actions']);

    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('spawning');
  });

  it('clears the backoff when a peer-spawned agent is adopted here', async () => {
    // The HA shape: this coordinator never spawned the agent, so only the
    // adoption path can observe that provisioning recovered. Counting local
    // registrations alone would leave a healthy scaler deferred forever.
    const stateStore = fakeStateStore({
      adoptSpawningAgent: vi.fn().mockResolvedValue({
        agentId: 'agent-peer',
        scalerName: 'github-actions',
        labelSet: ['github-actions'],
        provisioningTargets: ['e2e/provision'],
        backendType: ScalerBackendType.enum.event,
        spawnedAt: new Date(),
        ownerInstanceId: 'orch-a',
      }),
    });
    const manager = makeManagerWithEventBackend({
      stateStore,
      instanceId: 'orch-b',
      resolveProvisionBackoff: backoff(),
    });

    await failProvision(manager);
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1')).action,
    ).toBe('skipped');

    expect(await manager.onAgentRegistered('agent-peer', ['github-actions'])).not.toBeNull();

    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('spawning');
  });

  it('defers on a coordinator that never held leadership, from its own pruned spawn', async () => {
    // The reaper is leader-gated and `provisionFailures` is per-instance, so a
    // backoff armed only from the reaper leaves every non-leader dispatching at
    // the un-deferred cadence for the whole outage. The local stale-spawn prune
    // is the observation every coordinator does have: it asked for a provision
    // and no agent registered. `emitOrphanScaleDown` is deliberately never
    // called here — this manager is a follower.
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-follower',
      resolveProvisionBackoff: backoff(),
    });

    // A first request spawns, proving the refusal below is caused by the pruned
    // failure rather than by an unrelated match or capacity problem.
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0')).action,
    ).toBe('spawning');

    // Age the spawn past the stale window. `requestScale` prunes on entry, so
    // this call observes the failure; the deferral it arms is consulted on the
    // NEXT request.
    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    await vi.waitFor(async () =>
      expect(
        (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
      ).toBe('skipped'),
    );
  });

  it('counts one provision once when both the prune and the reaper see it', async () => {
    // On the leader both observers fire for the same dead provision. Counting
    // it twice would double the leader's backoff against every peer's for the
    // identical outage — and the growth is exponential, so it compounds.
    const emitter = fakeEmitter();
    const manager = makeManagerWithEventBackend({
      emitter,
      instanceId: 'orch-leader',
      resolveProvisionBackoff: backoff({ baseMs: 1000, maxMs: 600_000 }),
    });

    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    await vi.waitFor(() => expect(emitter.emitScalerScaleUp).toHaveBeenCalled());
    const agentId = (emitter.emitScalerScaleUp.mock.calls[0]![0] as { agentId: string }).agentId;

    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    // The reaper now condemns the SAME provision.
    await manager.emitOrphanScaleDown(
      {
        agentId,
        scalerName: 'github-actions',
        provisioningTargets: ['e2e/provision'],
        spawnedAt: new Date('2026-08-26T11:00:00Z'),
      },
      ScaleDownReason.enum['spawn-timeout'],
    );

    // One failure, so the deferral is the base delay — not the base doubled.
    const result = await manager.requestScale(
      ['github-actions', 'kici:os:linux'],
      'job-2',
      'run-2',
    );
    expect(result.action).toBe('skipped');
    expect(Number(/deferring for (\d+)s/.exec((result as { reason: string }).reason)![1])).toBe(1);
  });

  it('records the failure for diagnose on a coordinator that never held leadership', async () => {
    // The wish's third consequence: `kici-admin diagnose scaler` was empty for
    // the one backend that was failing. `ScalerFailureTracker` is per-process
    // and the reaper is leader-gated, so a reaper-only report leaves an
    // operator running diagnose against any non-leader reading "0 spawn
    // failures" for a scaler failing fleet-wide — the same wrong answer the
    // wish exists to stop giving.
    const onScalerEvent = vi.fn();
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-follower',
      resolveProvisionBackoff: backoff(),
      onScalerEvent,
    });

    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    expect(manager.recentSpawnFailures(60_000, Date.now()).size).toBe(0);

    // Age the spawn past the stale window; `requestScale` prunes on entry.
    // `emitOrphanScaleDown` is deliberately never called — this is a follower.
    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');

    expect(manager.recentSpawnFailures(60_000, Date.now()).get('github-actions')).toMatchObject({
      backendType: ScalerBackendType.enum.event,
      boundCount: 1,
      unboundCount: 0,
    });
    // And the job that was waiting on that provision learns why.
    expect(onScalerEvent).toHaveBeenCalledWith(
      'run-0',
      'job-0',
      expect.objectContaining({ eventType: ScalerEventType.enum['scaler.failed'] }),
    );
  });

  it('does not report a pruned spawn a peer adopted as a failed provision', async () => {
    // Nothing tells the spawning coordinator that its agent registered on a
    // peer, so the entry survives adoption and reaches the stale-spawn prune
    // next to a perfectly live agent. Reading that as a dead provision tells
    // the operator the exact opposite of what happened — and the reaper already
    // applies this test, returning `spawn-timeout` only for an unadopted row.
    const emitter = fakeEmitter();
    const onScalerEvent = vi.fn();
    const table = spawningRowTable();
    const manager = makeManagerWithEventBackend({
      emitter,
      onScalerEvent,
      stateStore: fakeStateStore(table.overrides),
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });

    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    await vi.waitFor(() => expect(emitter.emitScalerScaleUp).toHaveBeenCalled());
    const agentId = (emitter.emitScalerScaleUp.mock.calls[0]![0] as { agentId: string }).agentId;
    // The agent reached a peer, which stamped the row — the one durable record
    // of the adoption this coordinator never hears about.
    await table.overrides.adoptSpawningAgent(agentId, 'orch-b');

    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    await vi.waitFor(() => expect(table.overrides.provisionAdopter).toHaveBeenCalledWith(agentId));

    // No failure anywhere: not to the job that is running on the peer, not in
    // `diagnose scaler`, and no deferral against a scaler that is healthy.
    expect(onScalerEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ eventType: ScalerEventType.enum['scaler.failed'] }),
    );
    expect(manager.recentSpawnFailures(60_000, Date.now()).size).toBe(0);
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('spawning');
  });

  it('does not report a pruned spawn that was adopted before the reaper deleted its row', async () => {
    // The defect: a peer adopts the provision and then dies, the leader-gated
    // reaper condemns it with `heartbeat-timeout` and DELETES the spawn row,
    // and the spawning coordinator's prune then finds no row. Reading that
    // absence as "never adopted" reports a provision that worked.
    const emitter = fakeEmitter();
    const onScalerEvent = vi.fn();
    const table = spawningRowTable();
    const manager = makeManagerWithEventBackend({
      emitter,
      onScalerEvent,
      stateStore: fakeStateStore(table.overrides),
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });

    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    await vi.waitFor(() => expect(emitter.emitScalerScaleUp).toHaveBeenCalled());
    const agentId = (emitter.emitScalerScaleUp.mock.calls[0]![0] as { agentId: string }).agentId;

    // A peer adopts it, then the reaper condemns it and drops the spawn row.
    expect(await table.overrides.adoptSpawningAgent(agentId, 'orch-b')).not.toBeNull();
    await table.overrides.recordProvisionCondemned(
      agentId,
      'github-actions',
      ScaleDownReason.enum['heartbeat-timeout'],
    );
    await table.overrides.deleteSpawningAgent(agentId);
    expect(table.rows.has(agentId), 'the row must be gone — that is the ambiguity').toBe(false);

    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    await vi.waitFor(() => expect(table.overrides.provisionAdopter).toHaveBeenCalledWith(agentId));

    // The provision was adopted, so nothing about it is a failure: no
    // `scaler.failed`, nothing in `diagnose scaler`, and no deferral armed
    // against a scaler that is healthy.
    expect(onScalerEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ eventType: ScalerEventType.enum['scaler.failed'] }),
    );
    expect(manager.recentSpawnFailures(60_000, Date.now()).size).toBe(0);
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('spawning');
  });

  it('still reports a pruned spawn nobody ever adopted, even once its row is gone', async () => {
    // The other half of the same predicate, and the reason the naive
    // "absent row means do not report" fix is wrong: a provision that never
    // registered anywhere IS a failed external provision, and every
    // coordinator must back off on its own observation of it — including a
    // follower whose leader already reaped the row out from under it.
    const emitter = fakeEmitter();
    const onScalerEvent = vi.fn();
    const table = spawningRowTable();
    const manager = makeManagerWithEventBackend({
      emitter,
      onScalerEvent,
      stateStore: fakeStateStore(table.overrides),
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });

    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-0', 'run-0');
    await vi.waitFor(() => expect(emitter.emitScalerScaleUp).toHaveBeenCalled());
    const agentId = (emitter.emitScalerScaleUp.mock.calls[0]![0] as { agentId: string }).agentId;

    // The reaper condemned it WITHOUT an adoption, then dropped the row.
    await table.overrides.recordProvisionCondemned(
      agentId,
      'github-actions',
      ScaleDownReason.enum['spawn-timeout'],
    );
    await table.overrides.deleteSpawningAgent(agentId);

    vi.setSystemTime(Date.now() + 400_000);
    await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1');
    await vi.waitFor(() => expect(table.overrides.provisionAdopter).toHaveBeenCalledWith(agentId));

    await vi.waitFor(() =>
      expect(onScalerEvent).toHaveBeenCalledWith(
        'run-0',
        'job-0',
        expect.objectContaining({ eventType: ScalerEventType.enum['scaler.failed'] }),
      ),
    );
    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('skipped');
  });

  it('keeps the adoption verdict after the reaper condemns the provision', async () => {
    // A `heartbeat-timeout` condemns a provision that WAS adopted. If the
    // condemn write cleared the adoption, the prune would read "condemned" and
    // report — the original bug, reached through the fix. Asserted on the
    // fake's own table so it holds whatever the manager happens to call.
    const table = spawningRowTable();
    await table.overrides.upsertSpawningAgent({
      agentId: 'agent-x',
      scalerName: 'github-actions',
      labelSet: ['github-actions'],
      spawnedAt: new Date('2026-08-29T11:00:00Z'),
      backendType: ScalerBackendType.enum.event,
    } as never);

    await table.overrides.adoptSpawningAgent('agent-x', 'orch-b');
    await table.overrides.recordProvisionCondemned(
      'agent-x',
      'github-actions',
      ScaleDownReason.enum['heartbeat-timeout'],
    );
    await table.overrides.deleteSpawningAgent('agent-x');

    expect(await table.overrides.provisionAdopter('agent-x')).toBe('orch-b');
    expect(table.outcomes.get('agent-x')?.condemnedReason).toBe(
      ScaleDownReason.enum['heartbeat-timeout'],
    );
  });

  it('keeps a deferred scaler routable, so a job waiting it out is not called unroutable', async () => {
    // The wish this backoff belongs to exists because a job whose provisioning
    // failed was told its `runsOn` matched nothing. The deferral opens a new
    // window in which a job can expire without ever being attempted, so the
    // property has to be pinned rather than assumed: `classifyUnroutable` calls
    // `unroutable` only when NOTHING can route the labels, and it reads that
    // through `hasBackendForLabels` — which matches on labels alone. A deferred
    // scaler therefore still routes, and such a job settles `timed_out_stale`
    // with a truthful timeout message instead of a false labels complaint.
    const manager = makeManagerWithEventBackend({
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
    });
    expect(manager.hasBackendForLabels(['github-actions', 'kici:os:linux'])).toBe(true);

    await failProvision(manager);
    const result = await manager.requestScale(
      ['github-actions', 'kici:os:linux'],
      'job-1',
      'run-1',
    );
    // The reason, not just the verdict: `skipped` is also how capacity and a
    // failed match report, so asserting it alone would let this case pass with
    // the deferral it is about never armed.
    expect(result.action).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('deferring');

    // Deferred, and still routable.
    expect(manager.hasBackendForLabels(['github-actions', 'kici:os:linux'])).toBe(true);
  });

  it('never defers a spawn for an unrelated scaler', async () => {
    // Two event scalers routinely drive two different providers, so an outage
    // at one says nothing about the other.
    const other: ScalerEntry = {
      ...eventScalerEntry(),
      name: 'hetzner',
      labelSets: [{ labels: ['hetzner'] }],
    };
    const emitter = fakeEmitter();
    const stateStore = fakeStateStore();
    const entry = eventScalerEntry();
    const manager = makeManager({
      stateStore,
      emitter,
      instanceId: 'orch-a',
      resolveProvisionBackoff: backoff(),
      backends: [
        { name: entry.name, backend: makeEventBackend({ entry, emitter, stateStore }) },
        { name: other.name, backend: makeEventBackend({ entry: other, emitter, stateStore }) },
      ],
      config: { version: 1 as const, globalMaxAgents: 100, scalers: [entry, other] },
    });

    await failProvision(manager, 'github-actions');

    expect(
      (await manager.requestScale(['github-actions', 'kici:os:linux'], 'job-1', 'run-1')).action,
    ).toBe('skipped');
    expect(
      (await manager.requestScale(['hetzner', 'kici:os:linux'], 'job-2', 'run-2')).action,
    ).toBe('spawning');
  });
});

describe('resolveScalerOrchestratorUrl', () => {
  it('prefers the per-scaler config URL', () => {
    expect(resolveScalerOrchestratorUrl('ws://192.168.1.85:4000/ws', 'ws://env:1/ws', '4000')).toBe(
      'ws://192.168.1.85:4000/ws',
    );
  });

  it('falls back to KICI_ORCHESTRATOR_URL when no config URL is set', () => {
    expect(resolveScalerOrchestratorUrl(undefined, 'ws://env-host:9/ws', '4000')).toBe(
      'ws://env-host:9/ws',
    );
  });

  it('defaults to the orchestrator port (not the agent 8080) for local agents', () => {
    // A bare-metal scaler with no explicit URL must reach the orchestrator on
    // its own bind port, not the agent default 8080.
    expect(resolveScalerOrchestratorUrl(undefined, undefined, '4000')).toBe(
      'ws://127.0.0.1:4000/ws',
    );
  });

  it('uses 4000 when no port is provided', () => {
    expect(resolveScalerOrchestratorUrl(undefined, undefined, undefined)).toBe(
      'ws://127.0.0.1:4000/ws',
    );
  });
});

describe('buildScalerUsageRows', () => {
  it('stamps scalerType per scaler and __global__ on the rollup row', () => {
    const perScaler = new Map([
      ['ci-pool', { cpus: 2, memBytes: 100 }],
      ['heavy', { cpus: 4, memBytes: 200 }],
    ]);
    const typeOf = (n: string) =>
      ({ 'ci-pool': 'container', heavy: 'bare-metal' })[n] as string | undefined;
    const rows = buildScalerUsageRows(perScaler, { cpus: 6, memBytes: 300 }, typeOf);

    expect(rows).toContainEqual({
      scaler: 'ci-pool',
      scalerType: 'container',
      cpus: 2,
      memBytes: 100,
    });
    expect(rows).toContainEqual({
      scaler: 'heavy',
      scalerType: 'bare-metal',
      cpus: 4,
      memBytes: 200,
    });
    expect(rows).toContainEqual({
      scaler: '__global__',
      scalerType: '__global__',
      cpus: 6,
      memBytes: 300,
    });
  });

  it('omits scalerType when the type is unknown (no bad enum value emitted)', () => {
    const rows = buildScalerUsageRows(
      new Map([['mystery', { cpus: 1, memBytes: 1 }]]),
      { cpus: 1, memBytes: 1 },
      () => undefined,
    );
    expect(rows.find((r) => r.scaler === 'mystery')?.scalerType).toBeUndefined();
  });
});
