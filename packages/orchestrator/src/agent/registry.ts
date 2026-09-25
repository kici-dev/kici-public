/**
 * In-memory agent registry with label-based lookup and capacity tracking.
 *
 * Follows the Platform ConnectionRegistry dual-map pattern:
 * - Primary map: agentId -> AgentEntry (direct agent lookup)
 * - Secondary map: label -> Set<agentId> (reverse index for label-based dispatch queries)
 * - WS reverse map: ws -> agentId (fast lookup on WS events)
 *
 * No persistence needed -- agents re-register on reconnect.
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
import type { AgentCapabilities, WsLike } from '@kici-dev/engine';
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
 * Apply the mandatory-labels gate to a single agent against a required-labels
 * set. Returns `true` when every label in `agent.mandatoryLabels` is present
 * in `requiredLabels`. Empty `agent.mandatoryLabels` is a no-op (returns
 * `true`), so static / non-scaler agents and warm-pool replenishment spawns
 * behave exactly as before.
 *
 * Mirrors the scaler-side gate in `findBackendForLabels`: that gate reads a
 * `mandatoryLabels` list the scaler config folded at load, and this one folds
 * both sides here, so the agent-matching layer (`AgentRegistry.findAvailable` +
 * `hasMatchingAgent`) and the SQL queue-drain path
 * (`JobQueue.dequeueForLabels` / `dequeueById`) reject the same off-gate
 * dispatch attempts in one case.
 *
 * `requiredLabels` is folded here rather than assumed canonical: callers hand
 * it the job's own `runsOn` labels, and one that skipped the fold would leave a
 * gated agent silently reachable by a differently-cased job.
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

/**
 * A single tracked agent connection.
 */
export interface AgentEntry {
  /** Unique agent identifier. */
  agentId: string;
  /** The underlying WebSocket (or mock). */
  ws: WsLike;
  /**
   * Set of labels this agent provides (e.g., "linux", "gpu", "docker"), folded
   * to canonical form by `register()`. The label reverse index is keyed the
   * same way, so a lookup must fold its query before it reaches either.
   */
  labels: Set<CanonicalLabel>;
  /**
   * Kubernetes-taint-style mandatory labels inherited from the scaler that
   * spawned this agent. A job is only dispatched to this agent when every
   * label in `mandatoryLabels` appears in `runsOnLabels` (in addition to the
   * existing subset/exclusion checks).
   *
   * Empty for static agents and warm-pool replenishment spawns — those have
   * no opt-in gate and behave exactly as before. Populated only when the
   * spawning scaler declared a `mandatoryLabels` block; the value is a copy
   * of the scaler's gate (the scaler-side gate in `findBackendForLabels` is
   * not enough — once the agent registers, the queue-drain path
   * (`onAgentAvailable` → `dequeueForLabels`) sees only the agent's labels
   * and would otherwise pull a queued job whose `runsOn` is a subset of the
   * agent's labels but does not satisfy the gate).
   *
   * Folded to canonical form by `register()`, so a scaler that declared `GPU`
   * gates the same jobs a scaler that declared `gpu` does.
   */
  mandatoryLabels: Set<CanonicalLabel>;
  /**
   * True when this agent was spawned by a scaler backend. Scaler-managed
   * agents are single-use: the scaler destroys them on disconnect, so they
   * can never reconnect to reclaim recovering jobs. The dispatcher uses
   * this to triage disconnects (requeue / fail-fast) instead of starting a
   * recovery window that cannot succeed.
   */
  scalerManaged: boolean;
  /**
   * True while this agent is being torn down and must receive no new work.
   *
   * The warm pool decides an agent is idle, marks it, then awaits a destroy
   * that takes seconds — a container `stop({ t: 5 })`, or a Firecracker
   * `SendCtrlAltDel` plus its grace. The registry entry survives until the
   * agent's WebSocket actually closes, so without this flag `findAvailable`
   * kept returning the agent throughout: a job arriving in that window was
   * dispatched onto a container that was already exiting, and failed as a
   * spurious infrastructure error on a healthy system.
   *
   * In memory rather than DB-backed, unlike reboot-pending: a warm-pool
   * destroy is issued by this process, lasts seconds, and ends with the
   * WebSocket close that removes the entry — there is nothing to outlive.
   */
  draining: boolean;
  /**
   * Epoch ms until which the agent is held out of routing after it rejected a
   * dispatch as busy. Unset when no hold is in force. See {@link AgentRegistry.markBusyHeld}.
   */
  busyHeldUntil?: number;
  /** Number of jobs currently executing on this agent. */
  activeJobs: number;
  /** Maximum concurrent jobs this agent can handle (default 1). */
  maxConcurrency: number;
  /** Unix epoch ms of the last heartbeat received. */
  lastHeartbeatAt: number;
  /** Agent platform (os.platform(), e.g. 'linux', 'darwin', 'win32'). */
  platform: string;
  /** Agent architecture (os.arch(), e.g. 'x64', 'arm64'). */
  arch: string;
  /** Unix epoch ms when the agent registered. */
  registeredAt: number;
  /** Self-reported agent version (e.g. "0.0.1"). Null if not reported. */
  version: string | null;
  /**
   * Optional behaviours the agent advertised on `agent.register`. Null for an
   * agent that advertised none, which is read as supporting none.
   */
  capabilities: AgentCapabilities | null;
  /**
   * The `agent_tokens.id` row used to authenticate this connection, or
   * `null` when auth mode is `none`. Indexed by `tokenIdIndex` so a
   * synchronous revocation kick can enumerate every WS authenticated by
   * a given token. in the pentest catalog.
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
   * The auth token's `agent_type` (`'static'` | `'ephemeral'`) snapshot, or
   * `null` when auth mode is `none`. Drives the host roster's
   * `lifecycle_class` — `static` rows persist + alarm on absence, `ephemeral`
   * rows are GC'd past their ttl.
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
  /**
   * The `agent_tokens.id` row used to authenticate this connection.
   * `null` when auth mode is `none` (no token-based auth applied).
   * Indexed for `disconnectByTokenId(...)` revocation kicks.
   */
  tokenId?: string | null;
  /**
   * Kubernetes-taint-style mandatory labels inherited from the scaler that
   * spawned this agent. Empty / undefined for static agents (no opt-in
   * gate). Populated by `agent-handler.ts` from the scaler manager's
   * `onAgentRegistered(...)` return value.
   */
  mandatoryLabels?: string[];
  /**
   * True when a scaler backend spawned this agent (single-use; destroyed
   * on disconnect). Set by `agent-handler.ts` from the presence of the
   * scaler registration metadata.
   */
  scalerManaged?: boolean;
  /**
   * The auth token's `agent_type` (`'static'` | `'ephemeral'`), threaded from
   * `agent-handler.ts` so the host roster can snapshot it as the row's
   * `lifecycle_class`. `null` / undefined when auth mode is `none`.
   */
  tokenAgentType?: 'static' | 'ephemeral' | null;
  /**
   * Agent-reported typed host-vars (the `KICI_PROPERTIES` bag), threaded from
   * the `agent.register` message into the roster upsert (shallow-merged with
   * any operator-declared properties). Undefined ⇒ the agent reported none.
   */
  properties?: Record<string, string | number | boolean>;
  /** Optional behaviours the agent advertised on `agent.register`. */
  capabilities?: AgentCapabilities;
}

/**
 * Subset of `HostRosterStore` the registry reconciles into. Optional — when no
 * store is injected (e.g. workers, which have no DB), the reconcile hooks are
 * a no-op and the in-memory registry behaves exactly as before.
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
  /** Primary: agentId -> AgentEntry */
  private readonly agents = new Map<string, AgentEntry>();

  /** Secondary: label -> Set<agentId> (reverse index for label-based queries) */
  private readonly labelIndex = new Map<string, Set<string>>();

  /** Reverse: ws -> agentId (for fast lookup on WS events) */
  private readonly wsToAgentId = new Map<WsLike, string>();

  /**
   * Reverse: tokenId -> Set<agentId> (for synchronous revocation kicks).
   *
   * Populated when `register()` is called with a non-null `tokenId`,
   * cleaned up by `removeFromIndexes()` on `unregister()` /
   * re-registration. `disconnectByTokenId(tokenId)` walks the matching
   * set, closes each WS, and unregisters the entry — closing the
   * gap where a revoked token's in-flight WS retained data-plane
   * authority until the agent itself disconnected.
   */
  private readonly tokenIdIndex = new Map<string, Set<string>>();

  /**
   * Per-tokenId TTL kick timer, keyed by `tokenId`. Scheduled by
   * `scheduleExpiryKick(tokenId, expiresAt)` at agent register-time
   * when the auth token has a non-null `expires_at`. Fires
   * `disconnectByTokenId(tokenId)` when the token's TTL elapses, and
   * is cleared when (a) the timer fires, (b) `disconnectByTokenId` is
   * called explicitly via revocation (no double-kick when revoke
   * races TTL), or (c) the last agent under the tokenId unregisters
   * naturally (avoid timer leaks on long-lived registries).
   *
   * Idempotent: re-scheduling the same tokenId is a no-op as long as
   * a timer is still queued — a token's `expires_at` doesn't shift
   * across reconnects of the same agent. Closes the sister gap
   * to the revocation finding (`agent-token-revocation-stale-ws`,
   * fixed in `993bc3d9d`) where natural TTL expiration had no
   * propagation path to in-flight WS connections.
   */
  private readonly tokenExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-agent last roster `last_seen` stamp time (epoch ms). Throttles the
   * coarse heartbeat write so we don't issue a DB write per agent per
   * heartbeat — `grace`/`ttl` are minute-scale, so a throttled stamp is
   * sufficient. Cleaned up alongside the agent in `removeFromIndexes`.
   */
  private readonly lastRosterStampAt = new Map<string, number>();

  /** Minimum interval between coarse roster `last_seen` stamps per agent. */
  private readonly ROSTER_STAMP_THROTTLE_MS = 60_000;

  /** Optional host-roster reconciler + this instance's id (see AgentRegistryDeps). */
  private readonly rosterStore?: RosterReconciler;
  private readonly instanceId?: string;

  /**
   * The roster reconcile seam is optional: when no store is injected (workers
   * with no DB, unit tests), every reconcile hook is a no-op and the in-memory
   * registry behaves exactly as before.
   */
  constructor(deps: AgentRegistryDeps = {}) {
    this.rosterStore = deps.rosterStore;
    this.instanceId = deps.instanceId;
  }

  // ── Registration ──────────────────────────────────────────────────

  /**
   * Register an agent. If the agentId already exists, updates the existing
   * entry (agent reconnection scenario).
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

    // Clean up old entry if re-registering (agent reconnection)
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
      // A fresh registration is never draining: a reconnecting agent that was
      // condemned before is a NEW connection with new work to do.
      draining: false,
      activeJobs: 0,
      maxConcurrency,
      lastHeartbeatAt: Date.now(),
      platform,
      arch,
      registeredAt: Date.now(),
      version: version ?? null,
      capabilities: metadata?.capabilities ?? null,
      tokenId,
      // Static metadata
      hostname: metadata?.hostname ?? null,
      osRelease: metadata?.osRelease ?? null,
      osVersion: metadata?.osVersion ?? null,
      totalMemoryMb: metadata?.totalMemoryMb ?? null,
      cpuCount: metadata?.cpuCount ?? null,
      nodeVersion: metadata?.nodeVersion ?? null,
      // Process identity
      runningAsUser: metadata?.runningAsUser ?? null,
      runningAsUid: metadata?.runningAsUid ?? null,
      // Dynamic metadata (populated later via agent.status)
      memoryUsedMb: null,
      memoryAvailableMb: null,
      uptimeSeconds: null,
      tokenAgentType: metadata?.tokenAgentType ?? null,
    };

    // Primary map
    this.agents.set(agentId, entry);

    // WS reverse map
    this.wsToAgentId.set(ws, agentId);

    // Label reverse index, keyed on the canonical form so a lookup that folded
    // its query finds an agent that advertised the label in any case.
    for (const label of canonicalizeLabels(labels)) {
      let agentIds = this.labelIndex.get(label);
      if (!agentIds) {
        agentIds = new Set();
        this.labelIndex.set(label, agentIds);
      }
      agentIds.add(agentId);
    }

    // Token-id reverse index (only when authenticated under a token)
    if (tokenId !== null) {
      let tokenAgents = this.tokenIdIndex.get(tokenId);
      if (!tokenAgents) {
        tokenAgents = new Set();
        this.tokenIdIndex.set(tokenId, tokenAgents);
      }
      tokenAgents.add(agentId);
    }

    // Reconcile the durable host roster (best-effort, fire-and-forget). The
    // in-memory registry stays the dispatch source of truth; the roster is a
    // durable shadow that survives reconnects and powers declared inventory.
    // A row with no known lifecycle class defaults to `ephemeral` (the GC-able
    // class) so an unknown agent is never persisted forever.
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
          // Persist the canonical form the in-memory entry holds. The roster
          // reads fold too, so a row written before this did still matches —
          // but a row written now needs no fold to agree with the registry.
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

  /**
   * Unregister an agent by ID. Removes from all indexes.
   * @returns The removed AgentEntry, or undefined if not found.
   */
  unregister(agentId: string): AgentEntry | undefined {
    const entry = this.agents.get(agentId);
    if (!entry) return undefined;

    this.removeFromIndexes(agentId, entry);
    this.agents.delete(agentId);

    // Clear liveness on the durable roster row (owner-guarded, best-effort).
    // Covers WS-close / token-revoke / TTL-expiry — all three funnel through
    // unregister(). The row itself stays (status derives from last_seen +
    // connected_instance_id); only the live-WS ownership is cleared.
    if (this.rosterStore && this.instanceId) {
      void this.rosterStore.markDisconnected(agentId, this.instanceId).catch(() => {});
    }

    return entry;
  }

  /**
   * Unregister an agent by its WebSocket reference (for disconnect handling).
   * @returns The removed AgentEntry, or undefined if not found.
   */
  unregisterByWs(ws: WsLike): AgentEntry | undefined {
    const agentId = this.wsToAgentId.get(ws);
    if (agentId === undefined) return undefined;
    return this.unregister(agentId);
  }

  /**
   * Close every WS authenticated under `tokenId`, send a final
   * `auth.failure` message, then unregister the entry. Returns the
   * count of kicked agents.
   *
   * Closes the gap on the agent->orchestrator leg: when an admin
   * revokes a token via `DELETE /api/v1/agent-tokens/:id`, the route
   * calls this synchronously after `tokenStore.revoke(id)` so the
   * in-flight WS loses data-plane authority before the handler
   * returns.
   *
   * The WS close code is `WS_CLOSE_AGENT_AUTH_FAILED` (4010); the
   * agent's reconnect loop treats both the `auth.failure` message and
   * this close code as permanent and stops retrying.
   */
  disconnectByTokenId(tokenId: string): number {
    // Always clear any pending TTL timer first — whether the kick was
    // initiated by an explicit revoke or fired by the natural TTL, the
    // post-condition is the same (no agents remain under this token), so
    // we don't want a redundant fire later. Idempotent: clearTimeout on
    // an undefined value is a no-op.
    const timer = this.tokenExpiryTimers.get(tokenId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.tokenExpiryTimers.delete(tokenId);
    }

    const tokenAgents = this.tokenIdIndex.get(tokenId);
    if (!tokenAgents || tokenAgents.size === 0) return 0;

    // Snapshot the agentIds to avoid mutating-while-iterating: each
    // unregister() below mutates `this.tokenIdIndex` via removeFromIndexes.
    const agentIds = [...tokenAgents];

    let kicked = 0;
    for (const agentId of agentIds) {
      const entry = this.agents.get(agentId);
      if (!entry) continue;

      // Best-effort wire notification: send `auth.failure` so a
      // well-behaved agent stops its reconnect loop immediately. If
      // the WS is already closing/closed the send may throw — swallow
      // it so a single bad socket cannot block the rest of the kick.
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

      this.unregister(agentId);
      kicked++;
    }

    return kicked;
  }

  /**
   * Schedule a one-shot TTL kick for `tokenId` at `expiresAt`. When
   * the timer fires (or if `expiresAt` is already past), every
   * in-flight WS authenticated under the token is closed via
   * `disconnectByTokenId`.
   *
   * Idempotent per `tokenId`: if a timer is already scheduled for
   * this token, the call is a no-op. A token's `expires_at` doesn't
   * change across reconnects, so re-scheduling would just re-arm the
   * same trigger.
   *
   * Caller is the agent WS handler at register-time, when the token's
   * `agent_tokens.expires_at` column is non-null. Static tokens have
   * `expires_at = null` and are skipped at the call site (they have
   * no TTL by design). Closes the sister gap to the revocation
   * finding (`agent-token-revocation-stale-ws`, fixed in `993bc3d9d`)
   * where natural TTL expiration had no propagation path to
   * in-flight WS connections.
   */
  scheduleExpiryKick(tokenId: string, expiresAt: Date): void {
    if (this.tokenExpiryTimers.has(tokenId)) return;

    const delayMs = expiresAt.getTime() - Date.now();
    if (delayMs <= 0) {
      // Already expired — kick immediately. The DB-level `validate()`
      // would have rejected this token at auth-time, but a race
      // (token expired between auth and register, or a clock skew)
      // could land us here legitimately.
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
   * Find available agents that match ALL required labels.
   * An agent is available when it has capacity (activeJobs < maxConcurrency).
   *
   * In addition to the subset + exclusion filters, every label declared in
   * the agent's `mandatoryLabels` must appear in `requiredLabels`. This is
   * the agent-side mirror of the scaler-side mandatory-labels gate
   * (`findBackendForLabels`). Without it, a queued job whose `runsOn` is a
   * subset of a gated agent's labels but does not list the gate label
   * would be drained onto that agent the next time `onAgentAvailable`
   * fires — sidestepping the opt-in semantics the gate is meant to enforce.
   *
   * @param requiredLabels - All labels the agent must have (intersection semantics).
   * @returns Array of matching available AgentEntry objects.
   */
  findAvailable(
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[] = [],
    excludeLabels: string[] = [],
    excludePatterns: LabelMatcher[] = [],
  ): AgentEntry[] {
    // Fold every selector once, here: the entries and the label index below are
    // canonical, so a caller's `Docker` must become `docker` before it is
    // compared against either.
    const required = canonicalizeLabels(requiredLabels);
    const excluded = canonicalizeLabels(excludeLabels);
    const requiredMatchers = requiredPatterns.map(canonicalizeMatcher);
    const excludeMatchers = excludePatterns.map(canonicalizeMatcher);

    let candidates: AgentEntry[];

    if (required.length === 0) {
      candidates = [...this.agents.values()].filter((e) => !e.draining && agentHasFreeSlot(e));
    } else {
      // Start with the set of agents matching the first label (smallest candidate set)
      const firstLabelAgents = this.labelIndex.get(required[0]);
      if (!firstLabelAgents || firstLabelAgents.size === 0) return [];

      // Intersect with all other required labels
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

      // Filter to agents with capacity
      candidates = [];
      for (const id of candidateIds) {
        const entry = this.agents.get(id)!;
        if (!entry.draining && agentHasFreeSlot(entry)) {
          candidates.push(entry);
        }
      }
    }

    // Regex include: every required pattern must match some agent label.
    if (requiredMatchers.length > 0) {
      candidates = candidates.filter((a) =>
        requiredMatchers.every((p) => matcherSatisfiedBy(p, a.labels)),
      );
    }

    // Apply exact + regex exclusion filters.
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

    // Apply mandatory-labels gate: every label in agent.mandatoryLabels must
    // appear in requiredLabels. Empty agent.mandatoryLabels is a no-op.
    return filtered.filter((agent) => satisfiesMandatoryLabels(agent, required));
  }

  /**
   * Whether a specific agent satisfies the same label / exclude / mandatory
   * gate `findAvailable` applies per-agent, ignoring capacity. Used by the
   * host-fanout pin to verify the resolved agent still matches before pinning
   * (guards against roster label drift between resolution and dispatch).
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
   * Check if ANY registered agent matches the required labels, regardless of capacity.
   * Used to decide whether to queue (agent exists but busy) vs reject (no agent at all).
   *
   * Applies the same `mandatoryLabels` gate as `findAvailable` — a gated
   * agent only counts as "matching" when every label in its
   * `mandatoryLabels` is present in `requiredLabels`. Without this, the
   * dispatcher's `queued-no-backend` decision in `dispatch()` would treat
   * an off-gate gated agent as "matching but busy" and skip the peer
   * reroute path even though the local agent can never accept the job.
   */
  hasMatchingAgent(
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[] = [],
    excludeLabels: string[] = [],
    excludePatterns: LabelMatcher[] = [],
    /**
     * An extra test a label-matching agent must pass: whether it can run the
     * job at all, which its labels cannot express. An agent that matches but
     * never could is not a reason to keep the job here rather than reroute it.
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
      // The two choke points must reject the same dispatches, or the reroute
      // path is told a local agent can take work that `findAvailable` will
      // never hand it.
      if (entry.draining) return false;
      if (excluded.some((e) => entry.labels.has(e))) return false;
      if (requiredMatchers.some((p) => !matcherSatisfiedBy(p, entry.labels))) return false;
      if (excludeMatchers.some((p) => matcherSatisfiedBy(p, entry.labels))) return false;
      return satisfiesMandatoryLabels(entry, required) && canRun(entry);
    };

    if (required.length === 0) {
      // Walk every agent and return true on the first one that satisfies
      // both the exclusion filters and the gate.
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
   * Internal helper: intersect the per-label candidate sets to find agentIds
   * that satisfy `requiredLabels`. Returns `null` when any required label
   * matches zero agents (so callers can short-circuit). Returns an empty
   * Set on `requiredLabels.length === 0` since the caller decides the
   * walk strategy in that case.
   *
   * Takes canonical labels: the index it reads is keyed on the canonical form,
   * so a caller folds before it gets here.
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

  /**
   * Increment activeJobs for an agent.
   * @returns false if agent not found.
   */
  incrementActiveJobs(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.activeJobs++;
    return true;
  }

  /**
   * Decrement activeJobs for an agent (min 0).
   * @returns false if agent not found.
   */
  decrementActiveJobs(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.activeJobs = Math.max(0, entry.activeJobs - 1);
    return true;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  /**
   * Update the last heartbeat timestamp for an agent.
   */
  updateHeartbeat(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    entry.lastHeartbeatAt = Date.now();

    // Coarse, throttled roster last_seen stamp (owner-guarded, best-effort).
    // register() already stamped last_seen, so the first window is suppressed;
    // subsequent heartbeats refresh the durable column at most once per
    // throttle window, keeping the reaper's liveness view fresh without a DB
    // write per heartbeat.
    if (this.rosterStore && this.instanceId) {
      const now = Date.now();
      const last = this.lastRosterStampAt.get(agentId) ?? now;
      if (!this.lastRosterStampAt.has(agentId)) {
        // First heartbeat after register: seed the window, suppress the write.
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
   * Compact, allocation-cheap snapshot of every registered agent's routing
   * facts. Used by the dispatcher to log WHY a job found no backend (required
   * labels vs each agent's labels / capacity), which is otherwise invisible —
   * a `queued-no-backend` outcome alone doesn't say whether the label set
   * mismatched, the agent was at capacity, or no agent was connected at all.
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
   * Get a single agent entry by ID.
   */
  /**
   * Whether one agent id is currently registered.
   *
   * Distinct from `findAvailable`, which answers "which agents could take this
   * job" — the container orphan sweep needs to know only whether a running
   * container's agent is present at all, including one that is busy or gated.
   */
  isRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Condemn an agent: it stays registered and keeps finishing its current work,
   * but takes no new dispatches.
   *
   * Called before a warm-pool destroy is issued. Returns the agent's current
   * `activeJobs` so the caller can see a job that was claimed between its idle
   * check and this mark, and back out.
   *
   * @returns the agent's active-job count, or `undefined` when it is not registered
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

  /**
   * Get an agent entry by its WebSocket reference.
   */
  getByWs(ws: WsLike): AgentEntry | undefined {
    const agentId = this.wsToAgentId.get(ws);
    if (agentId === undefined) return undefined;
    return this.agents.get(agentId);
  }

  /**
   * Total number of registered agents.
   */
  getActiveCount(): number {
    return this.agents.size;
  }

  /**
   * Iterator over all agent entries (for heartbeat checks, etc).
   */
  *getAllEntries(): IterableIterator<AgentEntry> {
    yield* this.agents.values();
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Remove an agent from the WS reverse map and label index.
   * Does NOT remove from the primary agents map.
   */
  private removeFromIndexes(agentId: string, entry: AgentEntry): void {
    // Remove WS reverse lookup
    this.wsToAgentId.delete(entry.ws);

    // Drop the coarse roster-stamp throttle entry so it doesn't leak across
    // many short-lived agents on a long-lived process.
    this.lastRosterStampAt.delete(agentId);

    // Remove from label index
    for (const label of entry.labels) {
      const agentIds = this.labelIndex.get(label);
      if (agentIds) {
        agentIds.delete(agentId);
        if (agentIds.size === 0) {
          this.labelIndex.delete(label);
        }
      }
    }

    // Remove from token-id reverse index
    if (entry.tokenId !== null) {
      const tokenAgents = this.tokenIdIndex.get(entry.tokenId);
      if (tokenAgents) {
        tokenAgents.delete(agentId);
        if (tokenAgents.size === 0) {
          this.tokenIdIndex.delete(entry.tokenId);
          // No more agents under this token — cancel the pending TTL
          // kick to avoid leaking the timer (and the closure that
          // pins this registry instance) on long-lived processes
          // that authenticate many short-lived tokens.
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
