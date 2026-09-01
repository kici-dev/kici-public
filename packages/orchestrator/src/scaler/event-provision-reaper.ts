import { createLogger, toErrorMessage } from '@kici-dev/shared';

import { setScalerReapBlocked, setScalerReapUnseenProvisions } from '../metrics/prometheus.js';
import { ScaleDownReason } from './scaler-events.js';
import type { ReapCandidate } from './scaler-state-store.js';

const logger = createLogger({ prefix: 'event-provision-reaper' });

/**
 * How long a provision outcome is kept once its spawn row is gone.
 *
 * Deliberately a constant rather than a `cluster_settings` knob: unlike the
 * claim retention beside it, there is no operational decision here. The only
 * reader is the stale-spawn prune, and the interval the row must survive is
 * derived from windows the reaper already resolves — so a knob would be surface
 * with nothing behind it. The purge floors this against twice the spawn
 * deadline, so raising `KICI_SCALER_SPAWN_TIMEOUT_MS` for a slow cloud widens
 * the retention with it.
 */
export const PROVISION_OUTCOME_RETENTION_MS = 86_400_000;

/**
 * The live values one sweep runs against. Read together at the top of each tick
 * so a sweep is internally consistent even if an operator changes a knob
 * halfway through.
 */
export interface ReaperWindows {
  /** How often the leader sweeps. A change reschedules the timer after this tick. */
  intervalMs: number;
  /** How long an unadopted provision may stay unregistered before teardown. */
  spawnTimeoutMs: number;
  /** How long an adopted provision may stay unseen before teardown. */
  strandedTimeoutMs: number;
  /**
   * How long a peer disconnection, or an agent's absence, must persist before
   * it counts as real rather than as a reconnect in progress. Shared with the
   * rerouted-job guard (`reroute_flap_grace_ms`) because it answers the same
   * question for the same reason.
   */
  flapGraceMs: number;
  /** How long before a candidate whose teardown did not clear it is retried. */
  reattemptIntervalMs: number;
  /** How long an expired provisioning claim is kept before it is purged. */
  claimRetentionMs: number;
}

/**
 * The flap grace the reaper actually runs on.
 *
 * `reroute_flap_grace_ms` is shared with the rerouted-job guard, and the two
 * consumers do not carry the same risk: the reroute guard force-fails a run it
 * could have waited for, while this one deletes a customer's running instance.
 * An operator lowering the knob for reroute reasons must not silently collapse
 * that protection to two consecutive sweeps.
 *
 * The floor is two peer-stale-timeout windows — the very derivation the knob's
 * own default (`DEFAULT_REROUTE_FLAP_GRACE_MS`) comes from, applied as a floor
 * rather than a default. It has to cover the worst honest gap between an agent
 * being alive and being visible here: an agent reconnect backing off to its cap
 * (60s), plus the peer heartbeat interval (30s) during which a freshly
 * reconnected peer advertises no agents at all. Two stale windows (120s at the
 * defaults) covers that 90s; one (60s) would not.
 *
 * A raised knob is honoured as-is: the floor only ever raises.
 */
export function reaperFlapGraceMs(flapGraceMs: number, peerStaleTimeoutMs: number): number {
  return Math.max(flapGraceMs, 2 * peerStaleTimeoutMs);
}

/** The slice of the peer registry the cluster-view guard reads. */
export interface ReaperPeerView {
  /** Every coordinator peer this instance knows, connected or not. */
  getCoordinatorPeers(): readonly unknown[];
  /** How many of those are connected right now. */
  getConnectedCoordinatorPeerCount(): number;
}

/**
 * The reaper's `canReap` predicate, over static config plus the live peer
 * registry.
 *
 * Extracted and exported so the wiring itself is testable. The bug this closes
 * lived in exactly this expression — `clusterViewSufficient` was unit-tested
 * throughout, while the call site that fed it the wrong count was not, so the
 * guard read permissive on a Platform-mode HA pair through two review rounds.
 * A component whose false positive deletes a customer's running instances
 * cannot have an untested load-bearing line.
 *
 * The peer count is the max of the two sources because neither alone covers
 * both modes: `KICI_CLUSTER_PEERS` is set only in independent mode, while a
 * Platform-mode cluster learns its peers from the matchmaker and leaves that
 * array empty. `getCoordinatorPeers()` filters on role, not on connectivity, so
 * a peer lost to a partition stays counted and the guard stays armed.
 */
export function canReapForCluster(configuredPeerCount: number, peers: ReaperPeerView): boolean {
  return clusterViewSufficient(
    Math.max(configuredPeerCount, peers.getCoordinatorPeers().length),
    peers.getConnectedCoordinatorPeerCount(),
  );
}

/**
 * Whether an adopting coordinator should still be treated as live.
 *
 * Mirrors `shouldDeferReroutedJob`, and for the same reason: `PeerRegistry`
 * flips `connected` the instant a peer WS closes, with no grace of its own, so
 * sampling it alone cannot tell a link blip between two healthy processes from
 * a dead coordinator — while the agent is still attached to that peer running a
 * customer job. A peer we have never heard of is genuinely gone.
 */
export function adopterIsLive(
  peer: { connected: boolean; lastHeartbeatAt: number } | undefined,
  nowMs: number,
  flapGraceMs: number,
): boolean {
  if (!peer) return false;
  if (peer.connected) return true;
  return nowMs - peer.lastHeartbeatAt <= flapGraceMs;
}

/**
 * Whether this coordinator sees enough of its cluster to tear down provisions
 * on the cluster's behalf.
 *
 * Raft self-elects a coordinator that has zero connected coordinator peers, so
 * both halves of a partitioned pair become leader on their own side. Each then
 * reads every agent the other side holds as registered nowhere, and roughly one
 * flap grace later both emit teardowns for the other's live instances —
 * symmetric destruction of a running fleet. Standing down costs a delayed
 * backstop; not standing down costs the customer their fleet.
 *
 * `knownCoordinatorPeerCount` must count peers this coordinator has *ever*
 * handshaken with, not the ones named in static config. `KICI_CLUSTER_PEERS` is
 * set only in multi-orchestrator independent mode: the documented HA-pair recipe
 * runs Platform mode and joins by token, so peers arrive through the Platform
 * matchmaker and the static array stays empty. Keying on it left the guard inert
 * on precisely the topology it exists to protect. A known peer survives a
 * partition because `evictStalePeers` only marks it disconnected, so the guard
 * stays armed for as long as the partition lasts.
 *
 * A coordinator that has never met a peer is a single-coordinator deployment,
 * not a partitioned one, so it is never blocked.
 */
export function clusterViewSufficient(
  knownCoordinatorPeerCount: number,
  connectedCoordinatorPeerCount: number,
): boolean {
  return knownCoordinatorPeerCount === 0 || connectedCoordinatorPeerCount > 0;
}

export interface EventProvisionReaperOptions {
  /** Event rows that are either adopted, or past the spawn deadline unadopted. */
  listCandidates: (spawnCutoff: Date) => Promise<ReapCandidate[]>;
  /**
   * Whether an instance id is still a live cluster member (self counts as live).
   * `flapGraceMs` is passed in so the implementation can treat a peer that
   * disconnected moments ago as live — `peer.connected` alone flips on WS close
   * with no grace at all.
   */
  isPeerLive: (instanceId: string, flapGraceMs: number) => boolean;
  /** Whether an agent id is registered anywhere in the cluster we can see. */
  isAgentRegistered: (agentId: string) => boolean;
  /**
   * Whether this coordinator can see enough of the cluster to act on its
   * behalf. False on a node that *knows* coordinator peers but is connected to
   * none of them, which is exactly the shape a network partition produces.
   *
   * "Knows" spans both modes: peers named in static config, plus peers this
   * instance has handshaken with. Keying on static config alone is what left
   * this guard inert on a Platform-mode HA pair, which configures none.
   */
  canReap: () => boolean;
  /** Emit the teardown and drop the row. */
  emitScaleDown: (candidate: ReapCandidate, reason: ScaleDownReason) => Promise<void>;
  /** Delete pending claims that expired before the cutoff; returns rows deleted. */
  purgeExpiredClaims: (cutoff: Date) => Promise<number>;
  /**
   * Delete provision outcomes older than the cutoff whose spawn row is gone;
   * returns rows deleted. Runs on the same leader-gated sweep as the claim
   * purge, which is the orchestrator's one precedent for a timer-driven purge
   * of scaler bookkeeping.
   */
  purgeProvisionOutcomes: (cutoff: Date) => Promise<number>;
  /**
   * Read the live windows for one sweep. Backed by `cluster_settings`, so an
   * operator retunes the reaper on a running cluster; each read falls back to
   * the orchestrator's configured default when the column is NULL.
   */
  resolveWindows: () => Promise<ReaperWindows>;
  /**
   * Interval used for the very first schedule, before any knob has been read.
   * `onBecomeLeader` is synchronous (it is a Raft callback), so the timer starts
   * at the configured default and the first tick reconciles it to the live value.
   */
  bootIntervalMs: number;
}

/**
 * Leader-gated teardown backstop for event-scaler provisions.
 *
 * An event scaler emits a scale-up and then has no further local handle on the
 * instance a customer workflow booted. `spawn()` returns as soon as the event
 * is emitted, so the spawn-call deadline says nothing about whether the VM ever
 * appeared, and nothing else tears the provision down: an agent that never
 * registers — a cloud API 500, a cancelled run, a denied quota — leaves a
 * permanent row holding a `maxAgents` slot and no `kici.scaler.scale-down` is
 * ever emitted. Two more shapes strand a provision on a cluster: the spawning
 * coordinator dies before the agent registers, and the adopting coordinator
 * dies mid-job.
 *
 * The same pass purges pending provisioning claims past their expiry. A claim
 * row outlives its agent whenever a registration unwinds after the claim was
 * written, or whenever the coordinator that would have invalidated it crashed
 * first, and nothing else deletes one on a timer.
 *
 * Every teardown deletes a customer's cloud instance, so the whole design is
 * biased towards leaving a doubtful row alone:
 *
 *  - **Nothing is ever condemned on one sample.** "The agent is registered
 *    nowhere" is an observation that flips false for a live agent on routine
 *    events — a local WS reconnect, or the ~30s after any peer reconnect during
 *    which that peer's advertised agent list is empty. So the reaper times how
 *    long the observation has *persisted* (leader-local, never a database
 *    column a re-adopt could refresh) and requires it to hold for at least the
 *    flap grace before any arm can fire.
 *  - **A peer disconnection gets the same grace.** `peer.connected` flips on WS
 *    close with no grace of its own, so the adopter-liveness question is asked
 *    the way `shouldDeferReroutedJob` asks it: connected, or last heard from
 *    inside the flap window.
 *  - **A node that cannot see its cluster does not act for it.** A coordinator
 *    isolated by a partition self-elects after ~60s with zero connected peers;
 *    without a guard its first sweep would read every adopter as dead and
 *    condemn every adopted provision in the cluster, including the ones the
 *    majority side is still running. The guard counts *known* peers — static
 *    config plus everyone handshaken with — never static config alone.
 *
 * Modelled on `PendingScaleSweeper` / `HostRosterReaper`: one timer, started and
 * stopped by the Raft leadership callbacks, so several coordinators never each
 * tear the same provision down. Unlike those two, every window it runs on is a
 * live `cluster_settings` knob re-read per sweep — including the interval, which
 * reschedules the timer at the end of the sweep that observed the change.
 */
export class EventProvisionReaper {
  private readonly opts: EventProvisionReaperOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;
  /** The interval the live timer was created with, so a change is detectable. */
  private scheduledIntervalMs: number | null = null;
  /** Whether the previous sweep was blocked, so the log fires on the edge only. */
  private reapBlocked = false;
  /**
   * agentId → when this reaper last emitted a teardown for it. A candidate that
   * comes back means the emit did not clear the row — most often because
   * neither the row nor the leader's config names a provisioning target, which
   * `ScalerManager.emitScaleDownForSpec` deliberately answers by keeping the
   * row and logging. Without this throttle that row would be re-emitted and
   * re-logged at error level on every single tick, forever.
   */
  private readonly lastAttemptAt = new Map<string, number>();
  /**
   * agentId → when this reaper first observed the agent registered nowhere.
   *
   * This is the debounce that makes "unseen" mean sustained absence rather than
   * one unlucky sample. It is leader-local observation, deliberately not a
   * database column: `adopted_at` is refreshed by a coordinator re-adopting its
   * own agent, so a restart loop on the adopter would keep resetting the clock
   * on its own stranded provision.
   */
  private readonly strandedSince = new Map<string, number>();
  /**
   * How many entries of `strandedSince` the last sweep found absent for at
   * least the flap grace.
   *
   * The gauge publishes this rather than `strandedSince.size`, because the two
   * answer different questions. `size` counts every agent currently observed
   * absent, and an agent transits that set on every ordinary reconnect — a 30s
   * peer heartbeat against a 60s sweep, and `PeerRegistry` emptying a peer's
   * agent list on any disconnect, mean one flap enrols every peer-adopted agent
   * at once. So `size` is routinely non-zero on a healthy cluster, while
   * `verdict()` refuses to act on anything below the flap grace. Publishing the
   * past-grace count makes the gauge measure the same thing the reaper does.
   */
  private unseenPastGrace = 0;
  /**
   * agentIds already reported as having an unknown owner, so the warning fires
   * once per row rather than once per sweep. Pruned with the other per-agent
   * maps when the row leaves the candidate set.
   */
  private readonly unknownOwnerLogged = new Set<string>();

  constructor(opts: EventProvisionReaperOptions) {
    this.opts = opts;
  }

  onBecomeLeader(): void {
    this.isLeader = true;
    logger.info('Became leader, starting event-provision reaper', {
      intervalMs: this.opts.bootIntervalMs,
    });
    this.schedule(this.opts.bootIntervalMs);
  }

  onLoseLeadership(): void {
    this.isLeader = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scheduledIntervalMs = null;
    this.reapBlocked = false;
    // Both maps are leader-local bookkeeping, not durable state. Dropping the
    // attempt history lets the next leader retry a target this one could not
    // resolve; dropping the stranded clocks means it must observe the absence
    // itself for a full window before condemning anything, which is the
    // conservative direction.
    this.lastAttemptAt.clear();
    this.strandedSince.clear();
    this.unknownOwnerLogged.clear();
    this.unseenPastGrace = 0;
    // A non-leader observes nothing, so it must publish nothing rather than
    // leave its last leader-era readings standing on the scrape endpoint.
    this.publishGauges(false);
    logger.info('Lost leadership, stopped event-provision reaper');
  }

  stop(): void {
    this.onLoseLeadership();
  }

  /**
   * The interval the timer currently runs at, or null when no timer is armed.
   * Public so a caller can observe that a live knob change actually took.
   */
  currentIntervalMs(): number | null {
    return this.scheduledIntervalMs;
  }

  /** One sweep pass. Public for tests. Never throws (logs and keeps ticking). */
  async tick(): Promise<void> {
    if (!this.isLeader) return;
    let windows: ReaperWindows;
    try {
      windows = await this.opts.resolveWindows();
    } catch (err) {
      // Without windows there is no defensible cutoff, so skip the sweep rather
      // than fall back to a guess. `ClusterSettingsReader.getNumber` already
      // degrades a sick DB to the configured default, so reaching here means
      // something worse than an unreadable settings row.
      logger.error('event-provision reap tick could not resolve its windows', {
        error: toErrorMessage(err),
      });
      // A sweep that never ran is not a blocked sweep. Leaving `blocked` at its
      // last value would strand it at 1 when a partition heals into a DB fault.
      this.publishGauges(false);
      return;
    }
    // Leadership can move across any await. A former leader that keeps emitting
    // races the new one over the same rows, and `lastAttemptAt` is per-instance
    // so it cannot dedupe across coordinators.
    if (!this.isLeader) return;
    await this.reapProvisions(windows);
    if (!this.isLeader) return;
    await this.purgeClaims(windows.claimRetentionMs);
    if (!this.isLeader) return;
    await this.purgeOutcomes(windows.spawnTimeoutMs);
    this.reconcileInterval(windows.intervalMs);
  }

  /** Tear down every candidate the verdict condemns. */
  private async reapProvisions(windows: ReaperWindows): Promise<void> {
    if (!this.opts.canReap()) {
      if (!this.reapBlocked) {
        logger.warn(
          'Skipping event-provision reap: this coordinator is connected to none of the coordinator peers it knows',
        );
        this.reapBlocked = true;
      }
      // The stranded clocks were measured against a cluster view this node no
      // longer has, so they say nothing. Drop them: once the partition heals,
      // the absence must be re-observed for a full window before anything is
      // condemned.
      this.strandedSince.clear();
      this.unseenPastGrace = 0;
      this.publishGauges(true);
      return;
    }
    this.reapBlocked = false;
    try {
      await this.sweepCandidates(windows);
    } finally {
      // Always, on every exit from the sweep: a gauge frozen at its last reading
      // reports a state the reaper is no longer in. `finally` rather than a
      // trailing call because the candidate loop can return early on a
      // leadership change.
      this.publishGauges(false);
    }
  }

  /** The candidate half of one sweep, once the blocked check has passed. */
  private async sweepCandidates(windows: ReaperWindows): Promise<void> {
    const now = Date.now();
    let candidates: ReapCandidate[];
    try {
      candidates = await this.opts.listCandidates(new Date(now - windows.spawnTimeoutMs));
    } catch (err) {
      logger.error('event-provision reap tick failed to list candidates', {
        error: toErrorMessage(err),
      });
      return;
    }
    if (!this.isLeader) return;
    this.pruneTracking(candidates);
    try {
      await this.condemnCandidates(candidates, now, windows);
    } finally {
      // Recomputed on every exit, early return included: a count left over from
      // the previous sweep describes a cluster view this one has replaced.
      this.unseenPastGrace = this.countUnseenPastGrace(now, windows.flapGraceMs);
    }
  }

  /** How many absence clocks have run for at least the flap grace. */
  private countUnseenPastGrace(now: number, flapGraceMs: number): number {
    let count = 0;
    for (const since of this.strandedSince.values()) {
      if (now - since >= flapGraceMs) count += 1;
    }
    return count;
  }

  /** Emit a teardown for every candidate the verdict condemns. */
  private async condemnCandidates(
    candidates: ReapCandidate[],
    now: number,
    windows: ReaperWindows,
  ): Promise<void> {
    for (const candidate of candidates) {
      // Re-checked per row, not only per sweep: a long sweep can outlive the
      // leadership that started it.
      if (!this.isLeader) return;
      const reason = this.verdict(candidate, now, windows);
      if (!reason) continue;
      const lastAttempt = this.lastAttemptAt.get(candidate.agentId);
      if (lastAttempt !== undefined && now - lastAttempt < windows.reattemptIntervalMs) {
        logger.debug('Skipping a stranded provision still inside its re-attempt window', {
          agentId: candidate.agentId,
          scalerName: candidate.scalerName,
          reason,
        });
        continue;
      }
      logger.warn('Reaping stranded event-scaler provision', {
        agentId: candidate.agentId,
        scalerName: candidate.scalerName,
        reason,
        unseenMs: now - (this.strandedSince.get(candidate.agentId) ?? now),
        retry: lastAttempt !== undefined,
      });
      this.lastAttemptAt.set(candidate.agentId, now);
      try {
        await this.opts.emitScaleDown(candidate, reason);
      } catch (err) {
        // One unreachable row must not stop the rest of the sweep.
        logger.error('Failed to tear down a stranded event-scaler provision', {
          agentId: candidate.agentId,
          scalerName: candidate.scalerName,
          error: toErrorMessage(err),
        });
      }
    }
  }

  /**
   * Publish what this sweep observed.
   *
   * The unseen count is the only outward sign of the one failure this design
   * cannot fix on its own: the absence clock is leader-local, so a cluster with
   * enough leader churn — or a peer link flapping faster than the stranded
   * window — restarts it before it can ever expire, and a genuinely stranded
   * provision bills forever with no log line to show for it.
   */
  private publishGauges(blocked: boolean): void {
    setScalerReapBlocked(blocked);
    setScalerReapUnseenProvisions(blocked ? 0 : this.unseenPastGrace);
  }

  /** Delete pending claims past their expiry plus the retention grace. */
  private async purgeClaims(retentionMs: number): Promise<void> {
    try {
      const purged = await this.opts.purgeExpiredClaims(new Date(Date.now() - retentionMs));
      if (purged > 0) logger.info('Purged expired scaler provisioning claims', { purged });
    } catch (err) {
      logger.error('event-provision claim purge failed', { error: toErrorMessage(err) });
    }
  }

  /**
   * Delete provision outcomes nothing can ask about any more.
   *
   * The retention is floored against twice the spawn deadline because that
   * deadline also floors the stale-spawn prune window: recovery rehydrates a
   * spawning entry from the spawn row, and that entry asks about its provision
   * one prune later. The store's own `NOT EXISTS` predicate is what makes the
   * purge safe while the spawn row is still there; this floor covers the window
   * after it goes.
   *
   * `spawnTimeoutMs` needs no finiteness guard the way `reconcileInterval`'s
   * period does: `config.scalerSpawnTimeoutMs` is parsed as an integer of at
   * least 1000, and this is the one window `resolveWindows` takes straight from
   * config rather than from a `cluster_settings` column.
   */
  private async purgeOutcomes(spawnTimeoutMs: number): Promise<void> {
    const retentionMs = Math.max(PROVISION_OUTCOME_RETENTION_MS, 2 * spawnTimeoutMs);
    try {
      const purged = await this.opts.purgeProvisionOutcomes(new Date(Date.now() - retentionMs));
      if (purged > 0) logger.info('Purged expired scaler provision outcomes', { purged });
    } catch (err) {
      logger.error('event-provision outcome purge failed', { error: toErrorMessage(err) });
    }
  }

  /**
   * Adopt a changed sweep interval by rebuilding the timer.
   *
   * Re-read every sweep rather than only at a leadership transition: a knob an
   * operator can set but that is silently ignored until the next election is
   * worse than no knob at all. A value that is not a usable interval is ignored
   * — a zero or negative `setInterval` period would spin the sweep as fast as
   * the event loop allows.
   */
  private reconcileInterval(intervalMs: number): void {
    if (!this.isLeader) return;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      logger.warn('Ignoring an unusable event-provision reaper interval', { intervalMs });
      return;
    }
    if (intervalMs === this.scheduledIntervalMs) return;
    logger.info('Rescheduling event-provision reaper', {
      fromMs: this.scheduledIntervalMs,
      toMs: intervalMs,
    });
    this.schedule(intervalMs);
  }

  /** Replace the timer with one running at `intervalMs`. */
  private schedule(intervalMs: number): void {
    if (this.timer) clearInterval(this.timer);
    this.scheduledIntervalMs = intervalMs;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  /**
   * Drop per-agent tracking for rows that are gone, so a long-lived leader's
   * maps cannot grow without bound.
   */
  private pruneTracking(candidates: ReapCandidate[]): void {
    if (
      this.lastAttemptAt.size === 0 &&
      this.strandedSince.size === 0 &&
      this.unknownOwnerLogged.size === 0
    ) {
      return;
    }
    const live = new Set(candidates.map((c) => c.agentId));
    for (const agentId of this.lastAttemptAt.keys()) {
      if (!live.has(agentId)) this.lastAttemptAt.delete(agentId);
    }
    for (const agentId of this.strandedSince.keys()) {
      if (!live.has(agentId)) this.strandedSince.delete(agentId);
    }
    for (const agentId of this.unknownOwnerLogged) {
      if (!live.has(agentId)) this.unknownOwnerLogged.delete(agentId);
    }
  }

  /**
   * `null` means leave it alone.
   *
   * A registered agent is always spared, and seeing it registered resets its
   * stranded clock: that is the one signal saying the provision is genuinely
   * alive, and it outranks every other test.
   *
   * Otherwise the agent is unseen, and every arm below needs that observation
   * to have held for at least the flap grace — one sample proves nothing, since
   * a live agent reads unseen during its own WS reconnect and during the window
   * after a peer reconnect in which that peer advertises no agents yet.
   *
   * An adopted row means the agent reached some coordinator at least once, so
   * its disappearance is a lost heartbeat rather than a spawn that never
   * landed — both adopted shapes emit the same reason, and which coordinator
   * the agent happened to reach stays invisible to the customer's teardown
   * workflow. They differ only in how much sustained absence they need: a dead
   * adopter is strong corroboration that the provision is orphaned (its agent's
   * WS died with it), so the flap grace alone suffices; a live adopter is no
   * evidence either way, so that arm waits out the full stranded window.
   *
   * A row with neither an owner nor an adopter predates migration 119 —
   * `owner_instance_id IS NULL` reads as "unknown owner", never as "not mine",
   * so it is left for a human rather than reaped during a rolling upgrade.
   */
  private verdict(
    candidate: ReapCandidate,
    now: number,
    windows: ReaperWindows,
  ): ScaleDownReason | null {
    if (this.opts.isAgentRegistered(candidate.agentId)) {
      if (this.strandedSince.delete(candidate.agentId)) {
        // Paired with the seed line below, so the unseen gauge going up has a
        // log to explain it. Both fire once per transition, never per sweep.
        logger.info('Event-scaler provision seen registered again, absence clock cleared', {
          agentId: candidate.agentId,
          scalerName: candidate.scalerName,
        });
      }
      return null;
    }
    const since = this.strandedSince.get(candidate.agentId);
    if (since === undefined) {
      this.strandedSince.set(candidate.agentId, now);
      // The teardown `warn` below never fires under the leader-churn starvation
      // mode, so without this an operator woken by the unseen gauge has a
      // number and nothing to look up.
      logger.info('Event-scaler provision registered nowhere, starting absence clock', {
        agentId: candidate.agentId,
        scalerName: candidate.scalerName,
        adoptedBy: candidate.adoptedBy,
      });
      return null;
    }
    const unseenMs = now - since;
    if (unseenMs < windows.flapGraceMs) return null;

    if (candidate.adoptedBy) {
      if (!this.opts.isPeerLive(candidate.adoptedBy, windows.flapGraceMs)) {
        return ScaleDownReason.enum['heartbeat-timeout'];
      }
      if (unseenMs >= windows.strandedTimeoutMs) return ScaleDownReason.enum['heartbeat-timeout'];
      return null;
    }
    if (!candidate.ownerInstanceId) {
      // A row with neither an owner nor an adopter predates migration 119. It
      // is left for a human, and it is the one stand-down in this file with
      // nothing else to show for it — the agent is not registered, so no other
      // arm ever reports it. Logged once per absence, on the same transition
      // the absence clock is seeded on, so a row that is genuinely stuck is
      // visible instead of silently spared on every sweep forever.
      if (!this.unknownOwnerLogged.has(candidate.agentId)) {
        this.unknownOwnerLogged.add(candidate.agentId);
        logger.warn('Sparing an event-scaler provision whose owner is unknown', {
          agentId: candidate.agentId,
          scalerName: candidate.scalerName,
          spawnedAt: candidate.spawnedAt.toISOString(),
        });
      }
      return null;
    }
    // `listCandidates` already applied the spawn deadline in SQL; re-checking it
    // here keeps the verdict self-contained rather than trusting the caller's
    // predicate to stay in step with this one.
    if (now - candidate.spawnedAt.getTime() < windows.spawnTimeoutMs) return null;
    return ScaleDownReason.enum['spawn-timeout'];
  }
}
