/**
 * Event scaler backend — workflow-driven autoscaling.
 *
 * Unlike the local backends (container / bare-metal / firecracker), this backend
 * performs NO local compute. Its `spawn()` emits a `kici.scaler.scale-up` event
 * and its `destroy()` emits a `kici.scaler.scale-down` event; a customer-authored
 * provisioning / teardown workflow (subscribed via `kiciEvent()`) consumes those
 * events to boot and tear down an ephemeral cloud instance. The provisioned
 * instance's agent registers back with the scaler-chosen `agentId` and the
 * existing bound-job dispatch runs the pending job — reusing the whole scaling
 * engine (demand detection, caps, reservations, spawn timeout, teardown).
 */

import { ScalerBackendType, scalerAgentLabels } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  EffectiveLimits,
  LabelSetConfig,
  ManagedAgent,
  ScalerBackend,
  ScalerDestroyContext,
  ScalerEntry,
  ScalerEventCallback,
  SpawnContext,
  ValidationResult,
} from './types.js';
import type { ClaimStore } from './claim-store.js';
import type { ScalerScaleUpPayload, ScalerScaleDownPayload } from './scaler-events.js';
import {
  incScalerScaleUpEmitted,
  incScalerScaleDownEmitted,
  incScalerExternalProvisionTimeout,
  setScalerExternalProvisioningActive,
} from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'event-backend' });

/** Default TTL (seconds) of the ephemeral agent token when the entry omits it. */
const DEFAULT_AGENT_TOKEN_TTL_SECONDS = 600;

/**
 * Subset of `EventEmitter` the backend needs. Injected so the backend is unit
 * testable without a real event router.
 */
export interface ScalerEventEmitterLike {
  emitScalerScaleUp(payload: ScalerScaleUpPayload, targets: string[]): Promise<string>;
  emitScalerScaleDown(payload: ScalerScaleDownPayload, targets: string[]): Promise<string>;
}

export interface EventScalerBackendOptions {
  /** The parsed scaler entry (`type: 'event'`). */
  entry: ScalerEntry;
  /** Emits the reserved scale-up / scale-down events. */
  emitter: ScalerEventEmitterLike;
  /** Mints ephemeral credentials when a claim code is redeemed — normally by
   * the provisioned agent self-bootstrapping, or by a provisioning workflow. */
  claimStore: ClaimStore;
  /** Correlation-id generator for scale-up / scale-down requests. */
  requestId: () => string;
}

/** Internal per-agent tracking state (finer than `ManagedAgent.state`). */
type EventAgentState = 'provisioning' | 'active';

interface EventAgentEntry {
  agentId: string;
  labelSet: string[];
  state: EventAgentState;
  createdAt: number;
}

export class EventScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum.event;
  readonly spawnsOnLocalHost = false;
  readonly logsSource = 'event';

  labelSets: LabelSetConfig[];
  maxAgents: number;

  /** Exposed so the composition root can wire `onClaimCredentials` to it. */
  readonly claimStore: ClaimStore;

  private entry: ScalerEntry;
  private readonly emitter: ScalerEventEmitterLike;
  private readonly requestId: () => string;
  private readonly agents = new Map<string, EventAgentEntry>();

  constructor(opts: EventScalerBackendOptions) {
    this.entry = opts.entry;
    this.emitter = opts.emitter;
    this.claimStore = opts.claimStore;
    this.requestId = opts.requestId;
    this.labelSets = opts.entry.labelSets;
    this.maxAgents = opts.entry.maxAgents;
  }

  /** The entry this backend is serving; the reload rollback restores it. */
  get currentEntry(): ScalerEntry {
    return this.entry;
  }

  getActiveCount(): number {
    return this.agents.size;
  }

  /**
   * Register a pending claim, emit a scale-up event to the provisioning targets,
   * and track the agent as provisioning. Performs no local compute.
   */
  async spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    _onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
    spawnContext?: SpawnContext,
    signal?: AbortSignal,
  ): Promise<ManagedAgent> {
    if (signal?.aborted) {
      throw new Error('event scaler spawn aborted before start');
    }

    // Full label set the provisioned agent will present at registration (base
    // labelSet plus the scaler-assigned kici:agent:/kici:scaler:/kici:role:
    // labels). The ephemeral token is bound to exactly this set — same as the
    // container / bare-metal / firecracker backends — so the agent's
    // register-time labels don't trip the scope gate. Binding the token to only
    // the raw labelSet rejected the register with "labels exceed token-bound
    // scope" as soon as the agent self-reported its role labels.
    const fullLabels = scalerAgentLabels(
      labelSet,
      this.type,
      this.entry.name,
      this.entry.roles,
      spawnContext?.platformTaints,
    );

    const claimCode = await this.claimStore.register({
      agentId,
      labels: fullLabels,
      mandatoryLabels: this.entry.mandatoryLabels ?? [],
      agentTokenTtlSeconds: this.entry.agentTokenTtlSeconds ?? DEFAULT_AGENT_TOKEN_TTL_SECONDS,
      orchestratorUrl,
    });

    const resources: Record<string, unknown> = {};
    if (effectiveLimits?.cpus !== undefined) resources.cpus = effectiveLimits.cpus;
    if (effectiveLimits?.memBytes !== undefined) resources.memBytes = effectiveLimits.memBytes;

    await this.emitter.emitScalerScaleUp(
      {
        scalerName: this.entry.name,
        agentId,
        // The provisioning workflow sets the agent's KICI_LABELS from this
        // field, so it must be the full token-bound set (matching the minted
        // token's scope), not just the raw labelSet.
        labels: fullLabels,
        mandatoryLabels: this.entry.mandatoryLabels ?? [],
        resources,
        orchestratorUrl,
        claimCode,
        ...(spawnContext?.boundJobId && { jobId: spawnContext.boundJobId }),
        requestId: this.requestId(),
      },
      this.provisioningTargets(),
    );

    const now = Date.now();
    this.agents.set(agentId, { agentId, labelSet, state: 'provisioning', createdAt: now });
    incScalerScaleUpEmitted(this.entry.name);
    setScalerExternalProvisioningActive(this.entry.name, this.agents.size);

    return {
      id: agentId,
      labelSet,
      backendRef: agentId,
      spawnedAt: now,
      state: 'spawning',
    };
  }

  /**
   * Drop the tracked agent, emit a scale-down event (carrying the teardown
   * reason), then invalidate the pending claim. Idempotent: a repeat destroy of
   * an already-torn-down agent is a no-op (no duplicate scale-down).
   *
   * The tracking entry is dropped before the first `await` so a concurrent
   * destroy of the same agent returns at the guard above and cannot emit a
   * second scale-down.
   *
   * The claim invalidation is last and fails open. It is a DB delete, and the
   * scale-down is the only thing that tears down the customer's cloud instance:
   * running the delete first lets a DB error suppress the teardown for good,
   * because the agent is already out of `this.agents` and a retried destroy
   * returns at the guard. A claim left behind instead is inert — the row is
   * single-use and TTL-bounded, so it can mint at most one token for an agent
   * id that is being torn down.
   */
  async destroy(managedId: string, context?: ScalerDestroyContext): Promise<void> {
    if (!this.agents.has(managedId)) {
      return;
    }
    this.agents.delete(managedId);
    const reason = context?.reason ?? 'shutdown';
    // The caller's targets win when it has them: they come from the spawn
    // record, which is what the provision was actually spawned with. Live
    // config would otherwise retarget an in-flight teardown the moment an
    // operator edits `provisioningTargets`.
    const targets = context?.targets?.length ? context.targets : this.provisioningTargets();
    await this.emitter.emitScalerScaleDown(
      {
        scalerName: this.entry.name,
        agentId: managedId,
        reason,
        requestId: this.requestId(),
      },
      targets,
    );
    try {
      await this.claimStore.invalidate(managedId);
    } catch (err) {
      logger.warn(
        `Failed to invalidate pending claims for agent ${managedId}: ${toErrorMessage(err)}`,
      );
    }
    incScalerScaleDownEmitted(this.entry.name, reason);
    if (reason === 'spawn-timeout') {
      incScalerExternalProvisionTimeout(this.entry.name);
    }
    setScalerExternalProvisioningActive(this.entry.name, this.agents.size);
  }

  /**
   * Drop the tracked agent without emitting anything.
   *
   * The counterpart to `adopt()` on the other side of a cross-instance
   * registration: the spawning coordinator is never told that a peer adopted
   * its provision, so its entry would otherwise live until the process exits —
   * inflating `getActiveCount()` against the global cap forever, and handing
   * `shutdownAll()` a peer's live agent to tear down. Forgetting says "this
   * coordinator no longer tracks the provision", which is exactly true and says
   * nothing about whether the customer's instance is still running; the adopter
   * emits the teardown, and the leader-gated reaper is the backstop.
   */
  forget(agentId: string): void {
    if (!this.agents.delete(agentId)) return;
    setScalerExternalProvisioningActive(this.entry.name, this.agents.size);
  }

  /**
   * Take over bookkeeping for an agent another instance spawned. Seeds the same
   * entry `spawn()` would have, so `destroy()` emits its teardown instead of
   * no-opping on an unknown id.
   */
  adopt(agentId: string, labelSet: string[]): void {
    if (this.agents.has(agentId)) return;
    this.agents.set(agentId, { agentId, labelSet, state: 'active', createdAt: Date.now() });
    setScalerExternalProvisioningActive(this.entry.name, this.agents.size);
  }

  /** Mark a provisioned agent active once its instance registers over WS. */
  markActive(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry) entry.state = 'active';
  }

  /** Delegate a credential claim to the backend's claim store. */
  claim(code: string) {
    return this.claimStore.claim(code);
  }

  /**
   * Emits nothing. An event provision is a customer cloud instance whose
   * lifetime spans the cluster, not this process: the coordinator holding the
   * agent emits its teardown from the WS-close path, and the leader-gated
   * reaper is the backstop for one that reaches nobody. This map also carries
   * provisions a peer has already adopted — the spawning coordinator is never
   * told — so emitting here would make a routine restart tear down a peer's
   * running agents.
   *
   * The map is deliberately left intact rather than cleared: a WS close landing
   * during the remaining shutdown steps then still emits its own teardown.
   */
  async shutdownAll(): Promise<void> {
    if (this.agents.size > 0) {
      logger.info(
        `Leaving ${this.agents.size} event provision(s) to the cluster on shutdown; teardown is the holding coordinator's or the reaper's`,
      );
    }
  }

  /**
   * Apply the new config. The backend reads `roles`, `mandatoryLabels`,
   * `agentTokenTtlSeconds` and `provisioningTargets` off its entry at every
   * spawn, so the entry is replaced here — otherwise a reload that retargets
   * the provisioning workflow, or changes the scaler's roles, would keep
   * emitting scale-up events to the old workflow refs and minting agent labels
   * from the old roles, while the manager's own routing gate used the new ones.
   */
  reload(
    labelSets: LabelSetConfig[],
    opts?: { maxAgents?: number; entry?: ScalerEntry },
  ): ValidationResult {
    this.labelSets = labelSets;
    if (opts?.maxAgents !== undefined) {
      this.maxAgents = opts.maxAgents;
    }
    if (opts?.entry) {
      this.entry = opts.entry;
      if (opts.entry.claimTtlSeconds !== undefined) {
        this.claimStore.setDefaultTtlSeconds(opts.entry.claimTtlSeconds);
      }
    }
    return { valid: true };
  }

  private provisioningTargets(): string[] {
    return this.entry.provisioningTargets ?? [];
  }
}
