/**
 * In-memory agent registry with label-based lookup and capacity tracking, following the
 * Platform ConnectionRegistry dual-map pattern. No persistence needed: agents re-register
 * on reconnect.
 */

import {
  type CanonicalLabel,
  canonicalizeLabels,
  canonicalizeLabelSet,
  canonicalizeMatcher,
  type LabelMatcher,
  matcherSatisfiedBy,
  WS_CLOSE_AGENT_AUTH_FAILED,
} from '@kici-dev/engine';
import type { WsLike } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

/**
 * The longest a busy rejection holds an agent out of routing when no evidence
 * of a free slot lifts the hold first: an `agent.status` capacity report, or a
 * job on the agent reaching a final status.
 */
export const BUSY_HOLD_MAX_MS = 30_000;

/** What {@link AgentRegistry.markBusyHeld} found on the agent. */
export enum BusyHoldOutcome {
  /** No hold was on the agent: it last reported an empty slot, or never rejected. */
  Held = 'held',
  /** A hold that had run out was still on the agent: it never reported an empty slot. */
  ReheldAfterExpiry = 'reheld-after-expiry',
  /** The agent is not in the registry. */
  NotRegistered = 'not-registered',
}

/**
 * Whether an agent can take one more job now: a free slot, and no busy hold
 * in force ({@link AgentRegistry.markBusyHeld}). Draining is checked by the
 * callers that route around it.
 */
export function agentHasFreeSlot(entry: AgentEntry, now: number = Date.now()): boolean {
  if (entry.activeJobs >= entry.maxConcurrency) return false;
  return entry.busyHeldUntil === undefined || now >= entry.busyHeldUntil;
}

export type { WsLike } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'agent-registry' });

/**
 * True when every label in `agent.mandatoryLabels` is in `requiredLabels`. An empty
 * gate passes, so static agents and warm-pool replenishment spawns are ungated.
 *
 * Mirrors the scaler-side gate in `findBackendForLabels` (which reads a list the scaler
 * config folded at load), so the agent-matching layer (`AgentRegistry.findAvailable` +
 * `hasMatchingAgent`) and the SQL queue-drain path (`JobQueue.dequeueForLabels` /
 * `dequeueById`) reject the same off-gate dispatch attempts in one case.
 *
 * `requiredLabels` is folded here rather than assumed canonical: callers pass the job's
 * own `runsOn` labels, and a skipped fold would leave a gated agent silently reachable
 * by a differently-cased job.
 */
function satisfiesMandatoryLabels(
  agent: { mandatoryLabels: Set<CanonicalLabel> },
  requiredLabels: readonly string[],
): boolean {
  if (agent.mandatoryLabels.size === 0) return true;
  const requiredSet = canonicalizeLabelSet(requiredLabels);
  for (const label of agent.mandatoryLabels) {
    if (!requiredSet.has(label)) return false;
  }
  return true;
}

/** A single tracked agent connection. */
export interface AgentEntry {
  agentId: string;
  ws: WsLike;
  /**
   * Folded to canonical form by `register()`. The label reverse index is keyed the
   * same way, so a lookup must fold its query before it reaches either.
   */
  labels: Set<CanonicalLabel>;
  /**
   * Kubernetes-taint-style gate copied from the spawning scaler's `mandatoryLabels`
   * block: a job is dispatched here only when every one of these appears in its
   * `runsOnLabels`, on top of the subset/exclusion checks. Empty for static agents and
   * warm-pool replenishment spawns (no gate).
   *
   * The scaler-side gate in `findBackendForLabels` is not enough: once the agent
   * registers, the queue-drain path (`onAgentAvailable` → `dequeueForLabels`) sees only
   * the agent's labels and would pull a queued job whose `runsOn` is a subset of them
   * but does not satisfy the gate.
   *
   * Folded to canonical form by `register()`, so a scaler that declared `GPU` gates the
   * same jobs one that declared `gpu` does.
   */
  mandatoryLabels: Set<CanonicalLabel>;
  /**
   * Scaler-spawned agents are single-use: the scaler destroys them on disconnect, so
   * they never reconnect to reclaim recovering jobs. The dispatcher triages their
   * disconnects (requeue / fail-fast) instead of starting a recovery window that
   * cannot succeed.
   */
  scalerManaged: boolean;
  /**
   * True while this agent is being torn down and must receive no new work.
   *
   * A warm-pool destroy takes seconds (a container `stop({ t: 5 })`, or a Firecracker
   * `SendCtrlAltDel` plus its grace), and the entry survives until the WebSocket closes.
   * Without this flag `findAvailable` keeps returning the agent, and a job arriving in
   * that window lands on an exiting container and fails as a spurious infrastructure
   * error.
   *
   * In memory rather than DB-backed, unlike reboot-pending: the destroy is issued by
   * this process, lasts seconds, and ends with the WebSocket close that removes the
   * entry — there is nothing to outlive.
   */
  draining: boolean;
  /**
   * Epoch ms until which the agent is held out of routing after it rejected a
   * dispatch as busy. Unset when no hold is in force. See {@link AgentRegistry.markBusyHeld}.
   */
  busyHeldUntil?: number;
  activeJobs: number;
  /** Default 1. */
  maxConcurrency: number;
  /** Unix epoch ms. */
  lastHeartbeatAt: number;
  /** `os.platform()`, e.g. 'linux', 'darwin', 'win32'. */
  platform: string;
  /** `os.arch()`, e.g. 'x64', 'arm64'. */
  arch: string;
  /** Unix epoch ms. */
  registeredAt: number;
  /** Self-reported; null if not reported. */
  version: string | null;
  /**
   * The `agent_tokens.id` that authenticated this connection, `null` when auth mode is
   * `none`. Indexed by `tokenIdIndex` so a synchronous revocation kick can enumerate
   * every WS authenticated by a token.
   */
  tokenId: string | null;
  // --- Static OS metadata (from agent.register) ---
  hostname: string | null;
  osRelease: string | null;
  osVersion: string | null;
  totalMemoryMb: number | null;
  cpuCount: number | null;
  nodeVersion: string | null;
  // --- Process identity (from agent.register) ---
  runningAsUser: string | null;
  runningAsUid: number | null;
  // --- Dynamic OS metadata (from agent.status) ---
  memoryUsedMb: number | null;
  memoryAvailableMb: number | null;
  uptimeSeconds: number | null;
  /**
   * The auth token's `agent_type` snapshot, `null` when auth mode is `none`. Drives the
   * host roster's `lifecycle_class`: `static` rows persist and alarm on absence,
   * `ephemeral` rows are GC'd past their ttl.
   */
  tokenAgentType: 'static' | 'ephemeral' | null;
}

/** Optional static metadata from the agent.register message. */
interface AgentMetadata {
  hostname?: string;
  osRelease?: string;
  osVersion?: string;
  totalMemoryMb?: number;
  cpuCount?: number;
  nodeVersion?: string;
  runningAsUser?: string;
  runningAsUid?: number;
  /** `null` when auth mode is `none`. Indexed for `disconnectByTokenId(...)` revocation kicks. */
  tokenId?: string | null;
  /**
   * Set by `agent-handler.ts` from the scaler manager's `onAgentRegistered(...)` return
   * value. Empty / undefined for static agents (no gate).
   */
  mandatoryLabels?: string[];
  /** Set by `agent-handler.ts` from the presence of the scaler registration metadata. */
  scalerManaged?: boolean;
  /**
   * Threaded from `agent-handler.ts` so the host roster can snapshot it as the row's
   * `lifecycle_class`. `null` / undefined when auth mode is `none`.
   */
  tokenAgentType?: 'static' | 'ephemeral' | null;
  /**
   * Agent-reported typed host-vars (the `KICI_PROPERTIES` bag), passed into the roster
   * upsert (shallow-merged with any operator-declared properties). Undefined ⇒ the
   * agent reported none.
   */
  properties?: Record<string, string | number | boolean>;
}

/**
 * Subset of `HostRosterStore` the registry reconciles into. Optional: with no store
 * injected (e.g. workers, which have no DB), the reconcile hooks are a no-op.
 */
export interface RosterReconciler {
  upsert(input: {
    agentId: string;
    tokenId: string | null;
    lifecycleClass: 'static' | 'ephemeral';
    /** True when a scaler backend spawned this agent (kept out of `runsOnAll`). */
    scalerManaged?: boolean;
    labels: string[];
    hostname: string | null;
    platform: string;
    arch: string;
    instanceId: string;
    properties?: Record<string, string | number | boolean>;
  }): Promise<void>;
  markDisconnected(agentId: string, instanceId: string): Promise<void>;
  stampLastSeen(agentId: string, instanceId: string): Promise<void>;
}

/** Optional dependencies that enable host-roster reconciliation. */
export interface AgentRegistryDeps {
  rosterStore?: RosterReconciler;
  instanceId?: string;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentEntry>();

  /** label -> agentIds, keyed on the canonical label. */
  private readonly labelIndex = new Map<string, Set<string>>();

  private readonly wsToAgentId = new Map<WsLike, string>();

  /**
   * tokenId -> agentIds, for synchronous revocation kicks: `disconnectByTokenId` closes
   * each WS so a revoked token's in-flight connection loses data-plane authority at
   * once instead of when the agent disconnects.
   */
  private readonly tokenIdIndex = new Map<string, Set<string>>();

  /**
   * Per-tokenId TTL kick timer, armed by `scheduleExpiryKick` for a token with a
   * non-null `expires_at`. Cleared when it fires, when a revocation calls
   * `disconnectByTokenId` (no double kick when revoke races TTL), or when the last agent
   * under the token unregisters (no timer leak on long-lived registries).
   */
  private readonly tokenExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-agent last roster `last_seen` stamp (epoch ms). Throttles the heartbeat write
   * to one per agent per window: `grace`/`ttl` are minute-scale, so a throttled stamp
   * is sufficient.
   */
  private readonly lastRosterStampAt = new Map<string, number>();

  /** Minimum interval between coarse roster `last_seen` stamps per agent. */
  private readonly ROSTER_STAMP_THROTTLE_MS = 60_000;

  private readonly rosterStore?: RosterReconciler;
  private readonly instanceId?: string;

  /** With no roster store (workers with no DB, unit tests), every reconcile hook is a no-op. */
  constructor(deps: AgentRegistryDeps = {}) {
    this.rosterStore = deps.rosterStore;
    this.instanceId = deps.instanceId;
  }

  /**
   * Triages the in-flight jobs of an agent this registry drops on its own (a
   * revoked or expired token): fails or requeues a scaler-managed agent's
   * jobs, starts recovery for a static agent's. Installed by the dispatcher,
   * which is built after the registry.
   */
  private disconnectTriage?: (agentId: string) => Promise<unknown>;

  /** Install the job triage {@link disconnectByTokenId} runs for each agent it drops. */
  setDisconnectTriage(triage: (agentId: string) => Promise<unknown>): void {
    this.disconnectTriage = triage;
  }

  /**
   * Sockets whose `agent.register` is in flight (awaiting the scaler lookup), per agent
   * id, with the agent token id each authenticated with (`null` without token auth).
   * Kept here rather than in the WebSocket handler because the coordinator builds one
   * handler per connection: a socket's close, and a registration's check against
   * another agent token, must see a registration in flight on another connection.
   */
  private readonly registeringSockets = new Map<string, Map<WsLike, string | null>>();

  /** Record that `ws`, authenticated with `tokenId`, has started registering `agentId`. */
  beginRegistering(agentId: string, ws: WsLike, tokenId: string | null): void {
    let sockets = this.registeringSockets.get(agentId);
    if (!sockets) {
      sockets = new Map();
      this.registeringSockets.set(agentId, sockets);
    }
    sockets.set(ws, tokenId);
  }

  /** Record that `ws` has finished registering `agentId`, however it ended. */
  endRegistering(agentId: string, ws: WsLike): void {
    const sockets = this.registeringSockets.get(agentId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) this.registeringSockets.delete(agentId);
  }

  /** Whether a socket other than `ws` is registering `agentId` right now. */
  isRegisteringElsewhere(agentId: string, ws: WsLike): boolean {
    const sockets = this.registeringSockets.get(agentId);
    if (!sockets) return false;
    return [...sockets.keys()].some((other) => other !== ws);
  }

  /**
   * Whether another connection holds `agentId` under an agent token other than
   * `tokenId`: the live registration, or a registration in flight on another
   * socket. A registration without token auth (`null`) holds no token identity
   * and conflicts with nothing.
   */
  isAgentIdHeldByOtherToken(agentId: string, tokenId: string, ws: WsLike): boolean {
    const live = this.agents.get(agentId);
    if (live && live.tokenId !== null && live.tokenId !== tokenId) return true;
    for (const [other, otherToken] of this.registeringSockets.get(agentId) ?? []) {
      if (other !== ws && otherToken !== null && otherToken !== tokenId) return true;
    }
    return false;
  }

  // ── Registration ──────────────────────────────────────────────────

  /**
   * Register an agent, replacing an existing entry for the same id (reconnect).
   *
   * @returns the socket the previous entry was bound to, when this register
   *   replaced one bound to a *different* socket. The caller owns that socket's
   *   per-connection state and must retire it: a half-open connection can
   *   outlive the reconnect, and its later close carries the same agent id, so
   *   a caller that keeps treating it as live tears down the registration that
   *   replaced it. `undefined` for a first register or a re-register on the
   *   same socket.
   */
  register(
    agentId: string,
    ws: WsLike,
    labels: string[],
    platform: string = 'linux',
    arch: string = 'x64',
    version?: string,
    maxConcurrency: number = 1,
    metadata?: AgentMetadata,
  ): WsLike | undefined {
    const existing = this.agents.get(agentId);
    const supersededWs = existing && existing.ws !== ws ? existing.ws : undefined;

    if (existing) {
      this.removeFromIndexes(agentId, existing);
    }

    const tokenId = metadata?.tokenId ?? null;

    const entry: AgentEntry = {
      agentId,
      ws,
      labels: canonicalizeLabelSet(labels),
      mandatoryLabels: canonicalizeLabelSet(metadata?.mandatoryLabels ?? []),
      scalerManaged: metadata?.scalerManaged ?? false,
      // A reconnecting agent that was condemned before is a NEW connection with new work.
      draining: false,
      activeJobs: 0,
      maxConcurrency,
      lastHeartbeatAt: Date.now(),
      platform,
      arch,
      registeredAt: Date.now(),
      version: version ?? null,
      tokenId,
      hostname: metadata?.hostname ?? null,
      osRelease: metadata?.osRelease ?? null,
      osVersion: metadata?.osVersion ?? null,
      totalMemoryMb: metadata?.totalMemoryMb ?? null,
      cpuCount: metadata?.cpuCount ?? null,
      nodeVersion: metadata?.nodeVersion ?? null,
      runningAsUser: metadata?.runningAsUser ?? null,
      runningAsUid: metadata?.runningAsUid ?? null,
      // Populated later via agent.status.
      memoryUsedMb: null,
      memoryAvailableMb: null,
      uptimeSeconds: null,
      tokenAgentType: metadata?.tokenAgentType ?? null,
    };

    this.agents.set(agentId, entry);

    this.wsToAgentId.set(ws, agentId);

    // Keyed on the canonical form, so a folded lookup finds a label advertised in any case.
    for (const label of canonicalizeLabels(labels)) {
      let agentIds = this.labelIndex.get(label);
      if (!agentIds) {
        agentIds = new Set();
        this.labelIndex.set(label, agentIds);
      }
      agentIds.add(agentId);
    }

    if (tokenId !== null) {
      let tokenAgents = this.tokenIdIndex.get(tokenId);
      if (!tokenAgents) {
        tokenAgents = new Set();
        this.tokenIdIndex.set(tokenId, tokenAgents);
      }
      tokenAgents.add(agentId);
    }

    // Best-effort, fire-and-forget. The in-memory registry stays the dispatch source of
    // truth; the roster is a durable shadow that survives reconnects and powers declared
    // inventory. An unknown lifecycle class defaults to `ephemeral` (the GC-able class)
    // so an unknown agent is never persisted forever.
    if (this.rosterStore && this.instanceId) {
      const instanceId = this.instanceId;
      void this.rosterStore
        .upsert({
          agentId,
          tokenId,
          lifecycleClass: metadata?.tokenAgentType ?? 'ephemeral',
          // Recorded beside the lifecycle class, not derived from it: the class
          // snapshots the auth TOKEN's type and is `ephemeral` for every agent
          // when the auth mode is `none`, so only this flag separates a scaler
          // agent from a fleet host in that mode.
          scalerManaged: metadata?.scalerManaged ?? false,
          // Persist the canonical form the in-memory entry holds. Roster reads fold too,
          // so an older non-canonical row still matches.
          labels: canonicalizeLabels(labels),
          hostname: metadata?.hostname ?? null,
          platform,
          arch,
          instanceId,
          properties: metadata?.properties,
        })
        .catch((err) =>
          logger.warn('host_roster upsert failed (best-effort)', {
            agentId,
            error: toErrorMessage(err),
          }),
        );
    }

    return supersededWs;
  }

  /** @returns the removed entry, or undefined if not found. */
  unregister(agentId: string): AgentEntry | undefined {
    const entry = this.agents.get(agentId);
    if (!entry) return undefined;

    this.removeFromIndexes(agentId, entry);
    this.agents.delete(agentId);

    // Owner-guarded, best-effort. WS close, token revoke and TTL expiry all funnel
    // through here. The row stays (status derives from last_seen +
    // connected_instance_id); only the live-WS ownership is cleared.
    if (this.rosterStore && this.instanceId) {
      void this.rosterStore.markDisconnected(agentId, this.instanceId).catch(() => {});
    }

    return entry;
  }

  /** For disconnect handling. @returns the removed entry, or undefined if not found. */
  unregisterByWs(ws: WsLike): AgentEntry | undefined {
    const agentId = this.wsToAgentId.get(ws);
    if (agentId === undefined) return undefined;
    return this.unregister(agentId);
  }

  /**
   * Send a final `auth.failure` to every WS authenticated under `tokenId`, close it,
   * and unregister the entry. Returns the count of kicked agents.
   *
   * `DELETE /api/v1/agent-tokens/:id` calls this synchronously after
   * `tokenStore.revoke(id)`, so the in-flight WS loses data-plane authority before the
   * handler returns.
   *
   * The close code is `WS_CLOSE_AGENT_AUTH_FAILED` (4010); the agent's reconnect loop
   * treats both it and the `auth.failure` message as permanent and stops retrying.
   */
  disconnectByTokenId(tokenId: string): number {
    // Clear the TTL timer first: revoke or natural TTL, afterwards no agents remain
    // under this token, so a later fire would be redundant.
    const timer = this.tokenExpiryTimers.get(tokenId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.tokenExpiryTimers.delete(tokenId);
    }

    const tokenAgents = this.tokenIdIndex.get(tokenId);
    if (!tokenAgents || tokenAgents.size === 0) return 0;

    // Snapshot: each unregister() below mutates `this.tokenIdIndex`.
    const agentIds = [...tokenAgents];

    let kicked = 0;
    for (const agentId of agentIds) {
      const entry = this.agents.get(agentId);
      if (!entry) continue;

      // Best-effort, so a well-behaved agent stops reconnecting at once. A send on a
      // closing socket may throw; swallow it so one bad socket cannot block the kick.
      try {
        if (entry.ws.readyState === 1 /* OPEN */) {
          entry.ws.send(JSON.stringify({ type: 'auth.failure', reason: 'Token revoked' }));
        }
      } catch {
        // ignore — the close below is the load-bearing step
      }

      try {
        entry.ws.close(WS_CLOSE_AGENT_AUTH_FAILED, 'Token revoked');
      } catch {
        // ignore — entry will still be unregistered below
      }

      // Triage the agent's in-flight jobs before it leaves the registry: the
      // triage reads the registration, before its first await, to tell a
      // scaler-managed agent from a static one. The unregister right after
      // still removes the agent's authority before this call returns.
      this.disconnectTriage?.(agentId).catch((err: unknown) => {
        logger.error('Job triage failed for an agent dropped by token revocation', {
          agentId,
          error: toErrorMessage(err),
        });
      });
      this.unregister(agentId);
      kicked++;
    }

    return kicked;
  }

  /**
   * Schedule a one-shot `disconnectByTokenId` kick for `tokenId` at `expiresAt`, or at
   * once when it is already past.
   *
   * Idempotent per `tokenId`: a token's `expires_at` doesn't change across reconnects,
   * so re-scheduling would re-arm the same trigger.
   *
   * Called by the agent WS handler at register time when `agent_tokens.expires_at` is
   * non-null. Static tokens have `expires_at = null` (no TTL by design) and are skipped
   * at the call site.
   */
  scheduleExpiryKick(tokenId: string, expiresAt: Date): void {
    if (this.tokenExpiryTimers.has(tokenId)) return;

    const delayMs = expiresAt.getTime() - Date.now();
    if (delayMs <= 0) {
      // `validate()` rejects an expired token at auth time, but the token can expire
      // between auth and register, or under clock skew.
      this.disconnectByTokenId(tokenId);
      return;
    }

    const timer = setTimeout(() => {
      this.tokenExpiryTimers.delete(tokenId);
      this.disconnectByTokenId(tokenId);
    }, delayMs);
    this.tokenExpiryTimers.set(tokenId, timer);
  }

  // ── Label-based lookup ────────────────────────────────────────────

  /**
   * Find available agents that have ALL required labels.
   * An agent is available when it is not draining and has a free slot
   * ({@link agentHasFreeSlot}: activeJobs < maxConcurrency and no busy hold).
   *
   * Every label in the agent's `mandatoryLabels` must also appear in `requiredLabels`:
   * the agent-side mirror of the scaler-side gate (`findBackendForLabels`). Without it,
   * a queued job whose `runsOn` is a subset of a gated agent's labels but omits the
   * gate label would be drained onto that agent the next time `onAgentAvailable` fires.
   */
  findAvailable(
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[] = [],
    excludeLabels: string[] = [],
    excludePatterns: LabelMatcher[] = [],
  ): AgentEntry[] {
    // Fold every selector once: the entries and the label index are canonical, so a
    // caller's `Docker` must become `docker` before it is compared against either.
    const required = canonicalizeLabels(requiredLabels);
    const excluded = canonicalizeLabels(excludeLabels);
    const requiredMatchers = requiredPatterns.map(canonicalizeMatcher);
    const excludeMatchers = excludePatterns.map(canonicalizeMatcher);

    let candidates: AgentEntry[];

    if (required.length === 0) {
      candidates = [...this.agents.values()].filter((e) => !e.draining && agentHasFreeSlot(e));
    } else {
      const firstLabelAgents = this.labelIndex.get(required[0]);
      if (!firstLabelAgents || firstLabelAgents.size === 0) return [];

      const candidateIds = new Set(firstLabelAgents);
      for (let i = 1; i < required.length; i++) {
        const labelAgents = this.labelIndex.get(required[i]);
        if (!labelAgents || labelAgents.size === 0) return [];

        for (const id of candidateIds) {
          if (!labelAgents.has(id)) {
            candidateIds.delete(id);
          }
        }

        if (candidateIds.size === 0) return [];
      }

      candidates = [];
      for (const id of candidateIds) {
        const entry = this.agents.get(id)!;
        if (!entry.draining && agentHasFreeSlot(entry)) {
          candidates.push(entry);
        }
      }
    }

    if (requiredMatchers.length > 0) {
      candidates = candidates.filter((a) =>
        requiredMatchers.every((p) => matcherSatisfiedBy(p, a.labels)),
      );
    }

    let filtered = candidates;
    if (excluded.length > 0) {
      filtered = filtered.filter((agent) => {
        for (const label of excluded) {
          if (agent.labels.has(label)) return false;
        }
        return true;
      });
    }
    if (excludeMatchers.length > 0) {
      filtered = filtered.filter(
        (a) => !excludeMatchers.some((p) => matcherSatisfiedBy(p, a.labels)),
      );
    }

    return filtered.filter((agent) => satisfiesMandatoryLabels(agent, required));
  }

  /**
   * The per-agent label / exclude / mandatory gate of `findAvailable`, ignoring
   * capacity. The host-fanout pin uses it to guard against roster label drift between
   * resolution and dispatch.
   */
  agentSatisfies(
    agent: AgentEntry,
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[] = [],
    excludeLabels: string[] = [],
    excludePatterns: LabelMatcher[] = [],
  ): boolean {
    const required = canonicalizeLabels(requiredLabels);
    for (const label of required) {
      if (!agent.labels.has(label)) return false;
    }
    for (const p of requiredPatterns) {
      if (!matcherSatisfiedBy(canonicalizeMatcher(p), agent.labels)) return false;
    }
    for (const label of canonicalizeLabels(excludeLabels)) {
      if (agent.labels.has(label)) return false;
    }
    for (const p of excludePatterns) {
      if (matcherSatisfiedBy(canonicalizeMatcher(p), agent.labels)) return false;
    }
    return satisfiesMandatoryLabels(agent, required);
  }

  /**
   * Whether ANY registered agent matches, regardless of capacity: decides queue (agent
   * exists but busy) vs reject (no agent at all).
   *
   * Applies the `mandatoryLabels` gate of `findAvailable`. Without it, the
   * `queued-no-backend` decision in `dispatch()` would treat an off-gate agent as
   * "matching but busy" and skip the peer reroute path, though that agent can never
   * accept the job.
   */
  hasMatchingAgent(
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[] = [],
    excludeLabels: string[] = [],
    excludePatterns: LabelMatcher[] = [],
    /**
     * Whether a label-matching agent can run the job at all, which its labels cannot
     * express. An agent that never could is no reason to keep the job here rather
     * than reroute it.
     */
    canRun: (entry: AgentEntry) => boolean = () => true,
  ): boolean {
    const required = canonicalizeLabels(requiredLabels);
    const excluded = canonicalizeLabels(excludeLabels);
    const requiredMatchers = requiredPatterns.map(canonicalizeMatcher);
    const excludeMatchers = excludePatterns.map(canonicalizeMatcher);

    const candidateIds = this.intersectLabelCandidates(required);
    if (candidateIds === null) return false;

    const ok = (entry: AgentEntry): boolean => {
      // Must reject the same dispatches as `findAvailable`, or the reroute path is told a
      // local agent can take work it will never be handed.
      if (entry.draining) return false;
      if (excluded.some((e) => entry.labels.has(e))) return false;
      if (requiredMatchers.some((p) => !matcherSatisfiedBy(p, entry.labels))) return false;
      if (excludeMatchers.some((p) => matcherSatisfiedBy(p, entry.labels))) return false;
      return satisfiesMandatoryLabels(entry, required) && canRun(entry);
    };

    if (required.length === 0) {
      for (const entry of this.agents.values()) {
        if (ok(entry)) return true;
      }
      return false;
    }

    for (const id of candidateIds) {
      if (ok(this.agents.get(id)!)) return true;
    }
    return false;
  }

  /**
   * Agent ids that have every required label, or `null` when any label matches zero
   * agents (so callers can short-circuit). An empty Set for no labels: the caller picks
   * the walk strategy then.
   *
   * Takes canonical labels, since the index is keyed on the canonical form.
   */
  private intersectLabelCandidates(requiredLabels: readonly CanonicalLabel[]): Set<string> | null {
    if (requiredLabels.length === 0) return new Set();

    const firstLabelAgents = this.labelIndex.get(requiredLabels[0]);
    if (!firstLabelAgents || firstLabelAgents.size === 0) return null;

    const candidateIds = new Set(firstLabelAgents);
    for (let i = 1; i < requiredLabels.length; i++) {
      const labelAgents = this.labelIndex.get(requiredLabels[i]);
      if (!labelAgents || labelAgents.size === 0) return null;

      for (const id of candidateIds) {
        if (!labelAgents.has(id)) {
          candidateIds.delete(id);
        }
      }

      if (candidateIds.size === 0) return null;
    }
    return candidateIds;
  }

  // ── Job tracking ──────────────────────────────────────────────────

  /** @returns false if agent not found. */
  incrementActiveJobs(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.activeJobs++;
    return true;
  }

  /** Floors at 0. @returns false if agent not found. */
  decrementActiveJobs(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.activeJobs = Math.max(0, entry.activeJobs - 1);
    return true;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  updateHeartbeat(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.lastHeartbeatAt = Date.now();

    // Throttled roster last_seen stamp (owner-guarded, best-effort): at most one write
    // per window keeps the reaper's liveness view fresh. register() already stamped
    // last_seen, so the first window is suppressed.
    if (this.rosterStore && this.instanceId) {
      const now = Date.now();
      const last = this.lastRosterStampAt.get(agentId) ?? now;
      if (!this.lastRosterStampAt.has(agentId)) {
        this.lastRosterStampAt.set(agentId, now);
      } else if (now - last >= this.ROSTER_STAMP_THROTTLE_MS) {
        this.lastRosterStampAt.set(agentId, now);
        const instanceId = this.instanceId;
        void this.rosterStore.stampLastSeen(agentId, instanceId).catch(() => {});
      }
    }
    return true;
  }

  // ── Lookups ───────────────────────────────────────────────────────

  /**
   * Cheap snapshot of every agent's routing facts, so the dispatcher can log WHY a job
   * found no backend: `queued-no-backend` alone doesn't say whether the labels
   * mismatched, the agent was at capacity, or no agent was connected.
   */
  agentSummaries(): Array<{
    agentId: string;
    labels: string[];
    platform: string;
    arch: string;
    activeJobs: number;
    maxConcurrency: number;
  }> {
    return [...this.agents.values()].map((e) => ({
      agentId: e.agentId,
      labels: [...e.labels],
      platform: e.platform,
      arch: e.arch,
      activeJobs: e.activeJobs,
      maxConcurrency: e.maxConcurrency,
    }));
  }

  /**
   * Distinct from `findAvailable` ("which agents could take this job"): the container
   * orphan sweep needs only whether a running container's agent is present at all,
   * busy or gated included.
   */
  isRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Condemn an agent before a warm-pool destroy: it stays registered and finishes its
   * current work, but takes no new dispatches.
   *
   * @returns the agent's `activeJobs`, so the caller can see a job claimed between its
   *   idle check and this mark and back out; `undefined` when not registered
   */
  markDraining(agentId: string): number | undefined {
    const entry = this.agents.get(agentId);
    if (!entry) return undefined;
    entry.draining = true;
    return entry.activeJobs;
  }

  /**
   * Hold an agent out of routing after it rejected a dispatch as busy.
   *
   * A busy rejection means the agent still holds the slot of the job it is
   * tearing down, while the registry already counts that slot free (the
   * job reported completion first). Without the hold, the requeue re-picks the
   * same agent at once and each rejection repeats within milliseconds. The hold
   * lifts on evidence of a free slot ({@link clearBusyHeld}): the agent reports
   * an empty slot on `agent.status`, or a job tracked to it reaches a final
   * status. An expired hold is also dropped when the agent accepts a job
   * ({@link clearExpiredBusyHold}). Otherwise the hold ends after
   * {@link BUSY_HOLD_MAX_MS}, so a lost status report cannot strand the agent.
   *
   * An expired hold keeps its `busyHeldUntil` until that evidence arrives. So a
   * hold still on the entry here means the agent was re-picked because its last
   * hold ran out, and has neither reported a free slot nor accepted or finished
   * a job since — an agent whose job count is stuck. The caller spends an
   * attempt for that, which keeps such an agent from holding a job pending
   * forever.
   */
  markBusyHeld(agentId: string, now: number = Date.now()): BusyHoldOutcome {
    const entry = this.agents.get(agentId);
    if (!entry) return BusyHoldOutcome.NotRegistered;
    const reheld = entry.busyHeldUntil !== undefined;
    entry.busyHeldUntil = now + BUSY_HOLD_MAX_MS;
    return reheld ? BusyHoldOutcome.ReheldAfterExpiry : BusyHoldOutcome.Held;
  }

  /**
   * Lift a {@link markBusyHeld} hold: the agent reported an empty slot, or a
   * job tracked to it reached a final status.
   */
  clearBusyHeld(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry) delete entry.busyHeldUntil;
  }

  /**
   * Drop a {@link markBusyHeld} hold that has already run out: the agent
   * accepted a job since.
   *
   * Every dispatch path skips an agent whose hold is in force, so a job the
   * agent accepts while an expired hold is on its entry was dispatched after
   * the hold ran out, into a slot that was free. That refutes the stuck job
   * count the leftover hold stands for. A hold still in force is kept: the
   * accepted job occupies the slot, so the acceptance says nothing about a
   * free slot now.
   */
  clearExpiredBusyHold(agentId: string, now: number = Date.now()): void {
    const entry = this.agents.get(agentId);
    // fails-when: a hold still in force is dropped — the busy agent is routable again at once.
    // breaks-if-wrong: an expired hold must still be dropped, or the agent's next
    // teardown-window rejection spends an attempt.
    if (entry?.busyHeldUntil !== undefined && now >= entry.busyHeldUntil) {
      delete entry.busyHeldUntil;
    }
  }

  /** Undo {@link markDraining} — a destroy that was rejected leaves the agent alive. */
  clearDraining(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry) entry.draining = false;
  }

  get(agentId: string): AgentEntry | undefined {
    return this.agents.get(agentId);
  }

  getByWs(ws: WsLike): AgentEntry | undefined {
    const agentId = this.wsToAgentId.get(ws);
    if (agentId === undefined) return undefined;
    return this.agents.get(agentId);
  }

  getActiveCount(): number {
    return this.agents.size;
  }

  *getAllEntries(): IterableIterator<AgentEntry> {
    yield* this.agents.values();
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Remove an agent from the WS reverse map, the label index, the roster-stamp
   * map and the token index (cancelling the token's TTL timer when no agent is
   * left on it). Does NOT remove from the primary agents map.
   */
  private removeFromIndexes(agentId: string, entry: AgentEntry): void {
    this.wsToAgentId.delete(entry.ws);

    // So it doesn't leak across many short-lived agents on a long-lived process.
    this.lastRosterStampAt.delete(agentId);

    for (const label of entry.labels) {
      const agentIds = this.labelIndex.get(label);
      if (agentIds) {
        agentIds.delete(agentId);
        if (agentIds.size === 0) {
          this.labelIndex.delete(label);
        }
      }
    }

    if (entry.tokenId !== null) {
      const tokenAgents = this.tokenIdIndex.get(entry.tokenId);
      if (tokenAgents) {
        tokenAgents.delete(agentId);
        if (tokenAgents.size === 0) {
          this.tokenIdIndex.delete(entry.tokenId);
          // Cancel the TTL kick so the timer (and its closure pinning this registry)
          // doesn't leak on processes that authenticate many short-lived tokens.
          const timer = this.tokenExpiryTimers.get(entry.tokenId);
          if (timer !== undefined) {
            clearTimeout(timer);
            this.tokenExpiryTimers.delete(entry.tokenId);
          }
        }
      }
    }
  }
}
