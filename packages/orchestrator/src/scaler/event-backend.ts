/**
 * Event scaler backend — workflow-driven autoscaling.
 *
 * No local compute: `spawn()` emits `kici.scaler.scale-up` and `destroy()` emits
 * `kici.scaler.scale-down`, which a customer workflow (via `kiciEvent()`) consumes
 * to boot and tear down an ephemeral cloud instance. Its agent registers with the
 * scaler-chosen `agentId` and bound-job dispatch runs the pending job, so the
 * whole scaling engine (caps, reservations, spawn timeout, teardown) applies.
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

/** Subset of `EventEmitter` the backend needs; injected for unit tests. */
export interface ScalerEventEmitterLike {
  emitScalerScaleUp(payload: ScalerScaleUpPayload, targets: string[]): Promise<string>;
  emitScalerScaleDown(payload: ScalerScaleDownPayload, targets: string[]): Promise<string>;
}

export interface EventScalerBackendOptions {
  /** `type: 'event'`. */
  entry: ScalerEntry;
  emitter: ScalerEventEmitterLike;
  /** Redeemed by the self-bootstrapping agent, or by a provisioning workflow. */
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

    // The token binds the full set the agent presents at registration (labelSet
    // plus kici:agent:/kici:scaler:/kici:role:), as the local backends do. Binding
    // only the raw labelSet rejects the register with "labels exceed token-bound
    // scope" once the agent self-reports its role labels.
    const fullLabels = scalerAgentLabels(
      labelSet,
      this.type,
      this.entry.name,
      this.entry.roles,
      spawnContext?.platformTaints,
    );
    // Published for the provisioning workflow. The manager resolves it (config
    // plus derived platform taints); a spawn without a context carries the
    // configured list alone.
    const mandatoryLabels = [
      ...(spawnContext?.mandatoryLabels ?? this.entry.mandatoryLabels ?? []),
    ];

    const claimCode = await this.claimStore.register({
      agentId,
      labels: fullLabels,
      agentTokenTtlSeconds: this.entry.agentTokenTtlSeconds ?? DEFAULT_AGENT_TOKEN_TTL_SECONDS,
      orchestratorUrl,
    });

    const resources: Record<string, unknown> = {};
    if (effectiveLimits?.cpus !== undefined) resources.cpus = effectiveLimits.cpus;
    if (effectiveLimits?.memBytes !== undefined) resources.memBytes = effectiveLimits.memBytes;

    // Track BEFORE the emit, as the local backends do. Emitting first leaves a
    // window where a provision runs uncounted by `getActiveCount()`, and an
    // uncounted agent is an unbounded bill against the customer's cloud account.
    const now = Date.now();
    this.agents.set(agentId, { agentId, labelSet, state: 'provisioning', createdAt: now });

    try {
      await this.emitter.emitScalerScaleUp(
        {
          scalerName: this.entry.name,
          agentId,
          // The workflow sets KICI_LABELS from this, so it must match the
          // token's scope.
          labels: fullLabels,
          mandatoryLabels,
          resources,
          orchestratorUrl,
          claimCode,
          ...(spawnContext?.boundJobId && { jobId: spawnContext.boundJobId }),
          requestId: this.requestId(),
        },
        this.provisioningTargets(),
      );
    } catch (err) {
      // No workflow was provisioned, so nothing exists to count.
      this.agents.delete(agentId);
      throw err;
    }

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
   * Drop the tracked agent, emit a scale-down with the reason, then invalidate
   * the pending claim. Idempotent: a repeat destroy emits nothing.
   *
   * The entry is dropped before the first `await`, so a concurrent destroy
   * returns at the guard and cannot emit a second scale-down.
   *
   * The claim invalidation is last and fails open. The scale-down is the only
   * teardown of the customer's instance, so a DB error before it would suppress
   * the teardown for good (a retried destroy returns at the guard). A leftover
   * claim is single-use and TTL-bounded: at most one token for a dying agent id.
   */
  async destroy(managedId: string, context?: ScalerDestroyContext): Promise<void> {
    if (!this.agents.has(managedId)) {
      return;
    }
    this.agents.delete(managedId);
    const reason = context?.reason ?? 'shutdown';
    // The caller's targets come from the spawn record and win: live config would
    // retarget an in-flight teardown when an operator edits `provisioningTargets`.
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
   * The spawning side of a cross-instance `adopt()`. The spawner is never told
   * a peer adopted its provision, so its entry would otherwise inflate
   * `getActiveCount()` against the global cap until exit, and hand
   * `shutdownAll()` a peer's live agent. It says nothing about whether the
   * instance runs: the adopter emits the teardown, the leader-gated reaper is
   * the backstop.
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

  claim(code: string) {
    return this.claimStore.claim(code);
  }

  /**
   * Emits nothing. A provision's lifetime spans the cluster, not this process:
   * the coordinator holding the agent emits teardown on WS close, and the
   * leader-gated reaper is the backstop. The map may hold provisions a peer
   * adopted, so emitting here would make a routine restart tear down a peer's
   * agents.
   *
   * The map is left intact so a WS close during the remaining shutdown steps
   * still emits its own teardown.
   */
  async shutdownAll(): Promise<void> {
    if (this.agents.size > 0) {
      logger.info(
        `Leaving ${this.agents.size} event provision(s) to the cluster on shutdown; teardown is the holding coordinator's or the reaper's`,
      );
    }
  }

  /**
   * Replace the entry: each spawn reads `roles`, `agentTokenTtlSeconds`,
   * `provisioningTargets` (and, without a context, `mandatoryLabels`) from it.
   * Otherwise a reload would keep emitting to the old workflow refs and minting
   * labels from the old roles while the manager's routing gate uses the new ones.
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
