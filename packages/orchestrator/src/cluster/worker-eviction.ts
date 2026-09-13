import { WS_CLOSE_PLAN_LIMIT } from '@kici-dev/engine';
import type { PeerInfo, PeerRegistry } from './peer-registry.js';

/** How long a draining worker may hold in-flight jobs before it is disconnected anyway. */
export const WORKER_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The coordinator-side operations eviction needs.
 *
 * Declared here rather than reached for on the coordinator directly: the
 * coordinator owns dispatch and job attribution, but exposes no ineligibility
 * or idle-notification surface, and widening its public API for one caller
 * would couple eviction to it. A fake implementation makes this class unit
 * testable without a running cluster.
 */
export interface EvictionHooks {
  /** Stop rerouting new jobs to this peer. */
  markIneligible(instanceId: string): void;
  /**
   * Restore this peer to dispatch eligibility and drop any idle-notification
   * registration. Called when a drain is cancelled (the ceiling rose so the
   * peer is no longer excess) and after a drained peer is disconnected, so a
   * later re-admission of the same instance starts dispatch-eligible.
   */
  clearIneligible(instanceId: string): void;
  /** In-flight rerouted jobs currently attributed to this peer. */
  runningJobCount(instanceId: string): number;
  /** Invoke the callback once this peer has no in-flight rerouted jobs. */
  onPeerIdle(instanceId: string, callback: () => void): void;
  /** Close this peer's connection with the given code and reason. */
  closePeer(instanceId: string, code: number, reason: string): void;
}

/**
 * The workers to drain to bring this coordinator down to its ceiling.
 *
 * Newest-first by connect time: the joins that crossed the line are the ones
 * that go, so long-running capacity is not shuffled arbitrarily.
 */
export function selectEvictionTargets(workers: readonly PeerInfo[], ceiling: number): PeerInfo[] {
  const excess = workers.length - ceiling;
  if (excess <= 0) return [];
  return [...workers].sort((a, b) => b.connectedAt - a.connectedAt).slice(0, excess);
}

/**
 * Drain-then-disconnect this coordinator's excess workers.
 *
 * A target is first marked ineligible for new dispatch, then closed once its
 * in-flight rerouted jobs reach terminal status — which the worker's durable
 * outbox and `job.progress.ack` already guarantee — or after
 * `WORKER_DRAIN_TIMEOUT_MS`, after which the coordinator's existing
 * orphan-recovery guard handles whatever remains.
 */
export class WorkerEviction {
  private readonly draining = new Map<string, NodeJS.Timeout | null>();

  constructor(
    private readonly peerRegistry: PeerRegistry,
    private readonly hooks: EvictionHooks,
    private readonly logger: { warn: (msg: string, meta?: unknown) => void },
  ) {}

  /**
   * Reconcile the connected worker set against the ceiling.
   *
   * When `evictExcess` is true, drain the newest workers past `ceiling`;
   * otherwise the target set is empty. Any drain in flight for a worker that is
   * no longer a target is CANCELLED — its timer cleared and its dispatch
   * eligibility restored — so a raised ceiling (or the Platform clearing
   * `evictExcess` once the org drops back under) rescues a worker instead of
   * disconnecting it at the drain timeout.
   */
  reconcile(ceiling: number, evictExcess: boolean): void {
    const targets = evictExcess
      ? selectEvictionTargets(this.peerRegistry.getConnectedWorkerPeers(), ceiling)
      : [];
    const targetIds = new Set(targets.map((t) => t.instanceId));

    // Cancel drains for workers no longer targeted (ceiling rose / no longer evicting).
    for (const instanceId of [...this.draining.keys()]) {
      if (!targetIds.has(instanceId)) this.cancelDrain(instanceId);
    }

    for (const target of targets) {
      if (this.draining.has(target.instanceId)) continue;
      this.startDrain(target.instanceId);
    }
  }

  /** Stop an in-flight drain and restore the worker to dispatch eligibility. */
  private cancelDrain(instanceId: string): void {
    const timer = this.draining.get(instanceId);
    if (timer) clearTimeout(timer);
    this.draining.delete(instanceId);
    this.hooks.clearIneligible(instanceId);
    this.logger.warn('Cancelled worker drain — no longer over the plan ceiling', {
      peerInstanceId: instanceId,
    });
  }

  private startDrain(instanceId: string): void {
    this.logger.warn('Draining worker to meet the plan ceiling', { peerInstanceId: instanceId });
    this.hooks.markIneligible(instanceId);

    const finish = (): void => {
      const timer = this.draining.get(instanceId);
      if (timer) clearTimeout(timer);
      if (!this.draining.has(instanceId)) return; // already finished or cancelled
      this.draining.delete(instanceId);
      this.hooks.closePeer(
        instanceId,
        WS_CLOSE_PLAN_LIMIT,
        'Plan limit: this orchestrator exceeds the organization limit',
      );
      // Clear the ineligibility + idle registration now that the peer is gone,
      // so a re-admission of the same instance (ceiling later raised) starts
      // dispatch-eligible rather than silently receiving zero rerouted jobs.
      this.hooks.clearIneligible(instanceId);
    };

    if (this.hooks.runningJobCount(instanceId) === 0) {
      this.draining.set(instanceId, null);
      finish();
      return;
    }

    this.draining.set(instanceId, setTimeout(finish, WORKER_DRAIN_TIMEOUT_MS));
    this.hooks.onPeerIdle(instanceId, finish);
  }
}
