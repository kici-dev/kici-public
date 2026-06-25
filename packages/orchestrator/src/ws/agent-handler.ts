/**
 * WebSocket handler for agent connections.
 *
 * Agents connect to the orchestrator via WebSocket to:
 * - Authenticate with a kat_ token (when agentAuthMode === 'token')
 * - Register their capabilities (labels, concurrency)
 * - Receive job dispatches
 * - Report job execution status
 * - Send periodic heartbeats
 *
 * Two-phase auth flow (when agentAuthMode === 'token'):
 * 1. pendingAuth (5s): Agent must send auth.request with a valid kat_ token.
 * 2. pendingRegistration (10s): After auth.success, agent must send agent.register.
 * 3. registered: Agent is fully connected and can exchange messages.
 *
 * When agentAuthMode === 'none', the auth phase is skipped (legacy behavior).
 */

import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';
import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  agentToOrchestratorMessageSchema,
  agentAuthRequestSchema,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_AGENT_AUTH_FAILED,
  WS_CLOSE_PROTOCOL_ERROR,
  WsRateLimiter,
  ExecutionJobStatus,
  isSelfReportedLabel,
} from '@kici-dev/engine';
import type { RateLimiterConfig } from '@kici-dev/engine';
import { provenanceStorageKey } from '@kici-dev/engine/provenance/bundle';
import type { AgentRegistry, WsLike } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type { OwnershipTracker } from '../agent/ownership-tracker.js';
import type { SourceCache } from '../cache/source-cache.js';
import type { DepCache } from '../cache/dep-cache.js';
import type { UserCache, UserCacheRef } from '../cache/user-cache.js';
import type { DispatchCacheRefTracker } from '../cache/dispatch-cache-ref-tracker.js';
import type { PendingBuildTracker } from '../cache/pending-builds.js';
import type { PendingInitTracker } from '../cache/pending-inits.js';
import type { PendingDynamicTracker } from '../cache/pending-dynamics.js';
import type { CacheStorage } from '../storage/types.js';
import { setAgentsActive } from '../metrics/prometheus.js';
import type { AgentMetricsAggregator } from '../metrics/agent-metrics-aggregator.js';
import type { AgentApiRegistry } from './agent-api-registry.js';
import type { FleetAgentCollector } from './fleet-agent-collector.js';

const logger = createLogger({ prefix: 'agent-ws-handler' });

/** Timeout for auth phase (must send auth.request within this window). */
const AUTH_TIMEOUT_MS = 5_000;

/** Timeout for registration phase (must send agent.register after auth). */
const REGISTER_TIMEOUT_MS = 10_000;

/**
 * Token-bound authorization context captured at auth time and consulted
 * on every `agent.register` that mutates the registry's `agentId → entry`
 * mapping for an authenticated WS — both the first register (Phase 2) and
 * any subsequent re-register on the same connection.
 *
 * `undefined` fields mean the deployment opted out of agent auth
 * (`agentAuthMode === 'none'`); the gates are skipped in that case.
 *
 * `tokenLabels === null` is the back-compat carve-out for tokens issued
 * before `agent_tokens.labels` became an enforced authorization signal.
 */
type AuthState = {
  tokenId?: string;
  tokenLabels?: string[] | null;
  tokenAgentType?: string;
  tokenCreatedBy?: string | null;
};

/**
 * Narrow the token's `agent_type` column (a free string at the DB layer) to
 * the host-roster lifecycle class. Anything other than the two known values
 * (including `undefined` under `agentAuth: 'none'`) maps to `null` so the
 * roster's reconcile hook treats it as the GC-able default class.
 */
function toLifecycleClass(agentType: string | undefined): 'static' | 'ephemeral' | null {
  return agentType === 'static' || agentType === 'ephemeral' ? agentType : null;
}

/**
 * Run the three token-bound authorization gates against a wire-supplied
 * `agent.register` payload. The gates are identical at first register
 * (Phase 2 / `pendingRegistration`) and on every subsequent re-register
 * arriving on the same registered WS — every code path that mutates the
 * registry's `agentId → entry` mapping for an authenticated WS MUST run
 * them, otherwise the §5.3 / §5.1 invariants only hold for the very first
 * register and a re-register can silently overwrite the authority.
 *
 * Gates:
 *  1. Token-scope subset — wire labels MUST be a subset of
 *     `agent_tokens.labels` when that set is non-null. Closes the WS with
 *     `WS_CLOSE_AGENT_AUTH_FAILED` listing the elevated labels.
 *  2. Ephemeral identity-binding — for `agent_type === 'ephemeral'`,
 *     wire `agentId` MUST equal `tokenCreatedBy` (the scaler-spawned
 *     agentId the token was issued for). Closes the WS with
 *     `WS_CLOSE_AGENT_AUTH_FAILED`.
 *  3. Static-token agentId-collision — a different `tokenId` must not
 *     already claim the wire `agentId`. Closes the WS with
 *     `WS_CLOSE_INVALID_MESSAGE`.
 *
 * Returns `true` when every gate passed and the caller may proceed;
 * returns `false` after closing the WS on the first violation, in which
 * case the caller MUST stop processing.
 */
/**
 * WebSocket close reasons are capped at 123 UTF-8 bytes (RFC 6455 §5.5.1).
 * A reason longer than that makes `ws.close()` throw a RangeError, which —
 * thrown from an async message handler — surfaces as an unhandled rejection
 * and skips the close entirely. Truncate on a byte boundary and drop any
 * trailing partial multi-byte char.
 */
export function truncateCloseReason(reason: string): string {
  const bytes = Buffer.from(reason, 'utf-8');
  if (bytes.length <= 123) return reason;
  return bytes.subarray(0, 123).toString('utf-8').replace(/�+$/, '');
}

function enforceRegisterAuthGates(
  authState: AuthState | undefined,
  payload: { agentId: string; labels: string[] },
  ws: { close(code: number, reason: string): void },
  agentIdToTokenId: Map<unknown, string>,
): boolean {
  if (authState === undefined) return true;
  const { tokenId, tokenLabels, tokenAgentType, tokenCreatedBy } = authState;
  const { agentId, labels } = payload;

  // Gate 1 — token-scope subset. Self-reported platform facts (kici:os:,
  // kici:arch:, kici:host:) are exempt: the agent derives them from its own
  // host at registration, the scaler can't predict them at token-mint time,
  // and they grant no privilege. Authorization-bearing labels (base + the
  // scaler-assigned kici:agent:/kici:scaler:/kici:role:) must be bound by the
  // token, which the scaler now does via scalerAgentLabels().
  if (tokenLabels !== undefined && tokenLabels !== null) {
    const allowedSet = new Set(tokenLabels);
    const elevated = labels.filter((l) => !allowedSet.has(l) && !isSelfReportedLabel(l));
    if (elevated.length > 0) {
      logger.warn('Agent register-time label-scope violation: wire labels exceed token-bound set', {
        agentId,
        tokenLabels,
        wireLabels: labels,
        elevated,
      });
      ws.close(
        WS_CLOSE_AGENT_AUTH_FAILED,
        truncateCloseReason(`Agent labels exceed token-bound scope: ${elevated.join(',')}`),
      );
      return false;
    }
  }

  // Gate 2 — ephemeral identity-binding.
  if (
    tokenAgentType === 'ephemeral' &&
    tokenCreatedBy !== undefined &&
    tokenCreatedBy !== null &&
    tokenCreatedBy !== agentId
  ) {
    logger.warn(
      'Agent register-time identity-binding violation: ephemeral token bound to a different agentId',
      { wireAgentId: agentId, tokenCreatedBy, tokenId },
    );
    ws.close(
      WS_CLOSE_AGENT_AUTH_FAILED,
      truncateCloseReason(
        `Ephemeral token bound to a different agentId: expected ${tokenCreatedBy}, got ${agentId}`,
      ),
    );
    return false;
  }

  // Gate 3 — agentId collision.
  if (tokenId !== undefined) {
    const existingTokenId = agentIdToTokenId.get(agentId);
    if (existingTokenId !== undefined && existingTokenId !== tokenId) {
      logger.warn('AgentId collision: different token', { agentId });
      ws.close(WS_CLOSE_INVALID_MESSAGE, 'AgentId already registered with a different token');
      return false;
    }
  }

  return true;
}

export interface AgentWsHandlerDeps {
  registry: AgentRegistry;
  dispatcher: Dispatcher;
  /** Token store for validating agent auth tokens. Undefined when auth disabled. */
  tokenStore?: AgentTokenStore;
  /** Agent authentication mode. 'token' requires auth.request before register. */
  agentAuthMode: 'token' | 'none';
  /** Optional callback to forward job status to the Platform client. */
  onJobStatus?: (
    agentId: string,
    msg: {
      runId: string;
      jobId: string;
      state: string;
      timestamp: number;
      data?: Record<string, unknown>;
    },
  ) => void;
  /** Optional callback when agent sends log chunks. */
  onLogChunk?: (
    agentId: string,
    msg: {
      runId: string;
      jobId: string;
      stepIndex: number;
      lines: string[];
      timestamp: number;
    },
  ) => void;
  /** Optional callback when agent sends step status updates. */
  onStepStatus?: (
    agentId: string,
    msg: {
      runId: string;
      jobId: string;
      stepIndex: number;
      stepName: string;
      state: string;
      timestamp: number;
      data?: Record<string, unknown>;
      secretsAccessed?: string[];
      /** Raw log bytes accumulated by this step's LogStreamer at terminal time. */
      logBytesStreamed?: number;
    },
  ) => void;
  /**
   * Optional callback when a scaler-managed agent registers.
   *
   * Returns:
   * - `boundJobId` (optional): set when the scaler bound a specific queued
   *   job to this agent at spawn time. The orchestrator eagerly dispatches
   *   that job before the agent's idle timer fires.
   * - `mandatoryLabels` (always populated for scaler-managed agents): the
   *   spawning scaler's Kubernetes-taint-style gate. Threaded into the
   *   AgentRegistry so subsequent label matches (queue drain + eager
   *   dispatch) apply the same gate the scaler-side selector applied.
   *
   * Returns `null` for static agents not managed by any scaler.
   */
  onScalerAgentRegistered?: (
    agentId: string,
    labels: string[],
  ) => { boundJobId?: string; mandatoryLabels: string[] } | null;
  /** Optional callback when an agent disconnects (for scaler lifecycle). */
  onScalerAgentDisconnected?: (agentId: string) => void;
  /** Optional callback when an agent completes a job (for scaler lifecycle). */
  onScalerJobComplete?: (agentId: string) => void;
  /** Optional callback when agent sends per-job heartbeats. */
  onJobHeartbeat?: (
    agentId: string,
    msg: { runId: string; jobId: string; timestamp: number },
  ) => void;
  /** Optional callback when agent sends operational log lines (stateful/external agents via WS). */
  onAgentLog?: (agentId: string, msg: { lines: string[]; timestamp: number }) => void;
  /** Optional callback when agent acknowledges config (for MMDS clearing in Firecracker). */
  onConfigAck?: (agentId: string) => void;
  /** Optional callback when agent emits a custom event via ctx.emit(). */
  onEventEmit?: (
    agentId: string,
    msg: {
      jobId: string;
      requestId: string;
      eventName: string;
      payload: Record<string, unknown>;
      target?: { repos?: string[] };
    },
  ) => Promise<{ deliveryId?: string; error?: string }>;
  /** Optional callback when agent sends a run.event for infrastructure lifecycle tracking. */
  onRunEvent?: (
    agentId: string,
    msg: {
      runId: string;
      eventType: string;
      timestampMs: number;
      sourceService: string;
      jobId?: string | null;
      metadata?: Record<string, unknown>;
      durationMs?: number | null;
    },
  ) => void;
  /** Optional callback when agent sends a job.context with execution environment details. */
  onJobContext?: (
    agentId: string,
    msg: {
      runId: string;
      jobId: string;
      context: Record<string, unknown>;
    },
  ) => void;
  /** Bundle cache for generating pre-signed upload URLs. */
  sourceCache?: SourceCache;
  /** Dep cache for generating pre-signed upload URLs. */
  depCache?: DepCache;
  /** User-facing cache for serving restore/save requests from the sandbox. */
  userCache?: UserCache;
  /**
   * Server-side jobId -> user-cache-namespace store. The orchestrator records
   * `{orgId, repoId, cacheRefScope, runId}` per job at dispatch time; the
   * `cache.user.*` handlers resolve the ref from HERE (keyed by the wire jobId),
   * NEVER from the wire message body — a `cache.user.*` message carries only a
   * `jobId` + `key`, so an agent can name a job it owns but can never influence
   * which org/repo/scope that job resolves to.
   */
  dispatchCacheRefs?: DispatchCacheRefTracker;
  /** Cache storage for setting metadata after upload completion. */
  cacheStorage?: CacheStorage;
  /**
   * Storage used to mint presigned PUT URLs for provenance bundles. Distinct
   * dep so a deployment can decide whether attestations share the cache bucket.
   */
  provenanceStorage?: CacheStorage;
  /**
   * Record a completed provenance-bundle upload (writes an attestations row).
   * `runId` is resolved server-side from the job's dispatch ref, never the wire.
   */
  onProvenanceUpload?: (record: {
    runId: string;
    jobId: string;
    subjectName: string;
    subjectDigest: string;
    storageKey: string;
    mediaType: string;
  }) => Promise<void>;
  /** Optional rate limiter configuration. */
  rateLimiterConfig?: RateLimiterConfig;
  /** Optional ownership tracker for validating job-related messages. */
  ownershipTracker?: OwnershipTracker;
  /** Optional pending build tracker for cleanup on agent disconnect. */
  pendingBuilds?: PendingBuildTracker;
  /** Optional pending init tracker for cleanup on agent disconnect. */
  pendingInits?: PendingInitTracker;
  /** Optional pending dynamic tracker for cleanup on agent disconnect. */
  pendingDynamics?: PendingDynamicTracker;
  /** Optional callback when agent sends encrypted secret outputs on job success. */
  onSecretOutputs?: (
    runId: string,
    jobId: string,
    secretOutputs: Record<string, { agentPublicKey: string; encrypted: string }>,
  ) => Promise<void>;
  /** Agent metrics aggregator for receiving pushed metrics. */
  agentMetricsAggregator?: AgentMetricsAggregator;
  /** Optional callback when agent reports a job belongs to a concurrency group. */
  onConcurrencyReport?: (
    agentId: string,
    msg: { runId: string; jobId: string; group: string; messageId: string },
  ) => Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }>;
  /**
   * Optional callback when an agent blocks an `approval` step. The server
   * creates a step-scoped hold from the carried clauses (and the drift
   * `payload` for a `when: 'drift'` gate) and returns a promise that resolves
   * when the hold is approved, rejected, or expired. The handler relays the
   * resolution back to the originating agent as a `step.approval-resolved`
   * message. The `agentId` lets the server drop the pending resolver when the
   * agent disconnects.
   */
  onStepApproval?: (
    agentId: string,
    msg: {
      runId: string;
      jobId: string;
      stepIndex: number;
      stepName: string;
      clauses: Array<{ team: string } | { user: string }>;
      reason: string;
      timeoutSeconds?: number;
      payload?: { summaryMarkdown: string; drift: unknown };
    },
  ) => Promise<{ outcome: 'approved' | 'rejected' | 'expired'; reason?: string }>;
  /**
   * Optional callback fired when an agent's WS connection closes, after the
   * dispatcher's own cleanup has run. Used by the long-poll concurrency
   * pipeline to drop the agent's queued waiters and `cancelQueued` the
   * matching DB rows so the run is marked failed instead of dangling.
   */
  onConcurrencyAgentDisconnect?: (agentId: string) => void | Promise<void>;
  /** Agent private API registry for handling agent.api.request messages. */
  agentApiRegistry?: AgentApiRegistry;
  /**
   * Orchestrator-scoped collector that correlates fleet.logs.request with the
   * agent's chunked fleet.bundle.chunk / fleet.bundle.error response. Routed to
   * from the incoming-message switch; pending requests for a given agent are
   * rejected when that agent's WS closes.
   */
  fleetAgentCollector?: FleetAgentCollector;
}

/**
 * Create a Hono WS event handler for agent connections.
 *
 * Flow:
 * 1. onOpen: start 10-second register timer
 * 2. First onMessage: must be agent.register with labels and capacity
 * 3. Subsequent onMessage: validated against protocol schemas, routed by type
 * 4. onClose: cleanup from pending registration or dispatcher
 */
/**
 * Reconcile in-flight jobs reported by a reconnecting agent.
 *
 * For each job the agent claims is still running, attempt to reclaim the
 * dispatcher's recovery timer, restore DB and in-memory tracking, and emit
 * structured recovery log events.
 */
async function reconcileInFlightJobs(
  agentId: string,
  inFlightJobs: Array<{ jobId: string; runId: string }>,
  dispatcher: Dispatcher,
  registry: AgentRegistry,
  onJobStatus?: AgentWsHandlerDeps['onJobStatus'],
): Promise<void> {
  logger.info('Agent reporting in-flight jobs on reconnect', {
    agentId,
    jobCount: inFlightJobs.length,
    jobIds: inFlightJobs.map((j) => j.jobId),
  });

  let recoveredCount = 0;
  for (const { jobId, runId } of inFlightJobs) {
    const reconciled = await dispatcher.reconcileRecovery(jobId, agentId);
    if (reconciled) {
      // Increment active jobs in registry
      registry.incrementActiveJobs(agentId);
      recoveredCount++;

      const recoveryInfo = dispatcher.getRecoveryInfo(jobId);
      const recoveryDuration = recoveryInfo ? Date.now() - recoveryInfo.disconnectedAt : 0;

      // Structured recovery log event
      logger.info('Job recovered from agent reconnection', {
        recovery_duration: recoveryDuration,
        agent_id: agentId,
        job_id: jobId,
        run_id: runId,
        buffered_messages_count: 0,
      });

      // Update execution_jobs status back to 'running'
      onJobStatus?.(agentId, {
        runId,
        jobId,
        state: ExecutionJobStatus.enum.running,
        timestamp: Date.now(),
      });
    } else {
      // Agent claims a job we don't know about or that's not in recovery
      logger.warn('Agent reported unknown in-flight job', {
        agentId,
        jobId,
        runId,
      });
    }
  }

  logger.info('Reconnection reconciliation complete', {
    agentId,
    reported: inFlightJobs.length,
    recovered: recoveredCount,
    orphaned: inFlightJobs.length - recoveredCount,
  });
}

/**
 * FAST PATH: Manual type guard for log.chunk messages.
 *
 * Skips Zod safeParse() on authenticated connections for this high-frequency message type.
 *
 * SYNC INVARIANT: This manual validator MUST match the Zod schema
 * `agentLogChunkSchema` in packages/engine/src/protocol/messages/orchestrator-agent.ts.
 * If you change the schema, update this validator in the same commit.
 * See CLAUDE.md rule: "Zod fast-path sync invariant".
 */
function isValidLogChunk(raw: unknown): raw is {
  type: 'log.chunk';
  messageId: string;
  runId: string;
  jobId: string;
  stepIndex: number;
  lines: string[];
  timestamp: number;
} {
  if (typeof raw !== 'object' || raw === null) return false;
  const msg = raw as Record<string, unknown>;
  return (
    msg.type === 'log.chunk' &&
    typeof msg.messageId === 'string' &&
    typeof msg.runId === 'string' &&
    typeof msg.jobId === 'string' &&
    typeof msg.stepIndex === 'number' &&
    Array.isArray(msg.lines) &&
    typeof msg.timestamp === 'number'
  );
}

/**
 * FAST PATH: Manual type guard for heartbeat messages.
 *
 * SYNC INVARIANT: This manual validator MUST match the Zod schema
 * `heartbeatSchema` in packages/engine/src/protocol/messages/common.ts.
 * If you change the schema, update this validator in the same commit.
 * See CLAUDE.md rule: "Zod fast-path sync invariant".
 */
function isValidHeartbeat(raw: unknown): raw is { type: 'heartbeat'; timestamp: number } {
  if (typeof raw !== 'object' || raw === null) return false;
  const msg = raw as Record<string, unknown>;
  return msg.type === 'heartbeat' && typeof msg.timestamp === 'number';
}

export function createAgentWsHandler(deps: AgentWsHandlerDeps): WSEvents {
  const {
    registry,
    dispatcher,
    tokenStore,
    agentAuthMode,
    onJobStatus,
    onLogChunk,
    onStepStatus,
    onScalerAgentRegistered,
    onScalerAgentDisconnected,
    onScalerJobComplete,
    onJobHeartbeat,
    onAgentLog,
    onConfigAck,
    onEventEmit,
    onRunEvent,
    onJobContext,
    sourceCache,
    depCache,
    userCache,
    dispatchCacheRefs,
    cacheStorage,
    provenanceStorage,
    onProvenanceUpload,
    rateLimiterConfig,
    ownershipTracker,
    pendingBuilds,
    pendingInits,
    pendingDynamics,
    onSecretOutputs,
    onConcurrencyReport,
    onStepApproval,
    onConcurrencyAgentDisconnect,
    agentMetricsAggregator,
  } = deps;

  /** Per-connection rate limiters. Created on connect, cleaned up on disconnect. */
  const rateLimiters = new Map<WSContext, WsRateLimiter>();

  /** Connections waiting for auth.request (token mode only). */
  const pendingAuth = new Map<WSContext, { timer: ReturnType<typeof setTimeout> }>();

  /** Connections waiting for agent.register (after auth, or directly in 'none' mode). */
  const pendingRegistration = new Map<
    WSContext,
    {
      timer: ReturnType<typeof setTimeout>;
      tokenId?: string;
      /**
       * Token-bound label authorization scope, captured from `agent_tokens.labels`
       * at auth time. `null` means the token has no label constraint (back-compat
       * carve-out for tokens issued before the column became an enforced
       * authorization signal). `undefined` only when auth mode is `none` (in
       * which case label scoping is not applicable — the deployment opted out
       * of agent authentication entirely).
       *
       * The agent's wire-supplied labels on `agent.register` are checked against
       * this set; any label outside it is treated as a token-authorization
       * failure and the WS is closed with `WS_CLOSE_AGENT_AUTH_FAILED`. See
       * and the regression test at `agent-handler.label-elevation.test.ts`.
       */
      tokenLabels?: string[] | null;
      /**
       * Token's `agent_type` column (`'static'` | `'ephemeral'`). Captured at
       * auth time; consumed at register time to enforce the
       * single-use binding for ephemeral tokens. Static tokens are
       * intentionally N-use (operator-issued shared PSK), so the binding
       * check is skipped when `agent_type === 'static'`. `undefined` when
       * auth mode is `none`. See `agent-handler.token-single-use.test.ts`.
       */
      tokenAgentType?: string;
      /**
       * Token's `created_by` column. For `agent_type === 'ephemeral'`,
       * this is the scaler-spawned agentId the token was issued for, and
       * the wire-supplied `agentId` MUST equal this value at register
       * time. For `agent_type === 'static'`,
       * this is a free-form creator label (e.g. `'cli:admin'`) and is
       * not consulted for authorization.
       */
      tokenCreatedBy?: string | null;
      /**
       * Token's `expires_at` column. Non-null only for ephemeral tokens
       * (static tokens have no TTL by design). At register-time, used
       * to schedule a per-token kick timer via
       * `AgentRegistry.scheduleExpiryKick(tokenId, expiresAt)` so that
       * in-flight WS connections close when the token's TTL elapses
       * naturally — sister to the revoke kick path. See
       */
      tokenExpiresAt?: Date | null;
    }
  >();

  /**
   * Map from WSContext to agentId for registered connections.
   * Separate from the registry's WS map because we use WSContext here
   * (Hono type) vs WsLike in the registry.
   */
  const wsToAgentId = new Map<WSContext, string>();

  /**
   * Map from agentId to the tokenId used for authentication.
   * Used for agentId collision detection (different token = reject).
   */
  const agentIdToTokenId = new Map<string, string>();

  /**
   * Map from WSContext to the token authority context captured at auth
   * time. Populated when Phase 2's auth gates pass and consulted on every
   * subsequent `agent.register` (re-register branch) so the gates re-run
   * with the same authority the first register was checked against. Empty
   * when `agentAuthMode === 'none'`.
   */
  const wsToAuthState = new Map<WSContext, AuthState>();

  /** Track whether the unauthenticated mode warning has been logged. */
  let noAuthWarningLogged = false;

  /**
   * Per-connection `${jobId}:${key} -> tempKey` map. `cache.user.save.request`
   * mints a presigned PUT to a `.tmp-<uuid>` key and stashes that temp key here;
   * the matching `cache.user.save.complete` reads it back so the commit copies
   * the right temp object to its final key. Cleared on disconnect with the rest
   * of this connection's per-job state.
   */
  const pendingUserCacheTempKeys = new Map<string, string>();

  function sendJson(ws: WSContext, data: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Resolve the trusted user-cache namespace for a job from the server-side
   * dispatch-cache-ref tracker (NEVER from the wire message). Returns `null`
   * when the job was never dispatched / already cleaned up, or when the dispatch
   * carried no org/repo (e.g. a sourceless deploy) — in which case the cache
   * fails closed and the caller no-ops rather than ever crossing tenants.
   */
  function resolveUserCacheRef(jobId: string): UserCacheRef | null {
    const ref = dispatchCacheRefs?.get(jobId);
    if (!ref || ref.orgId === undefined || ref.repoId === undefined) return null;
    return {
      org: ref.orgId,
      repo: ref.repoId,
      // Absent scope fails closed to `isolated` (per-run write scope), matching
      // the agent-side default for a dispatch that carried no cacheRefScope.
      scope: ref.cacheRefScope ?? 'isolated',
      runId: ref.runId,
    };
  }

  return {
    onOpen(_evt: Event, ws: WSContext) {
      // Create per-connection rate limiter
      rateLimiters.set(ws, new WsRateLimiter(rateLimiterConfig));

      if (agentAuthMode === 'token') {
        // Start auth timeout -- agent must send auth.request within AUTH_TIMEOUT_MS
        const timer = setTimeout(() => {
          logger.warn('Agent auth timeout, closing connection');
          pendingAuth.delete(ws);
          ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Auth timeout');
        }, AUTH_TIMEOUT_MS);

        pendingAuth.set(ws, { timer });
        logger.info('Agent WebSocket connection opened, awaiting auth.request');
      } else {
        // Unauthenticated mode: skip auth phase, go directly to pendingRegistration
        if (!noAuthWarningLogged) {
          logger.warn(
            'Agent authentication is DISABLED (KICI_AGENT_AUTH=none). Any client can register as an agent.',
          );
          noAuthWarningLogged = true;
        }

        const timer = setTimeout(() => {
          logger.warn('Agent registration timeout, closing connection');
          pendingRegistration.delete(ws);
          ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Registration timeout');
        }, REGISTER_TIMEOUT_MS);

        pendingRegistration.set(ws, { timer });
        logger.info('Agent WebSocket connection opened, awaiting registration (auth disabled)');
      }
    },

    async onMessage(evt: MessageEvent<WSMessageReceive>, ws: WSContext) {
      // Parse raw JSON
      let raw: unknown;
      try {
        const data = typeof evt.data === 'string' ? evt.data : String(evt.data);
        raw = JSON.parse(data);
      } catch {
        logger.warn('Malformed JSON received from agent, closing');
        ws.close(WS_CLOSE_INVALID_MESSAGE, 'Malformed JSON');
        return;
      }

      // Rate limiting check (after parse, before schema validation)
      const rateLimiter = rateLimiters.get(ws);
      if (rateLimiter) {
        const messageSize = typeof evt.data === 'string' ? evt.data.length : 0;
        const isHeartbeat =
          raw !== null &&
          typeof raw === 'object' &&
          'type' in raw &&
          (raw as { type: unknown }).type === 'heartbeat';
        const rlResult = rateLimiter.check(messageSize, isHeartbeat);
        if (!rlResult.allowed) {
          if (rlResult.action === 'disconnect') {
            logger.warn('Rate limit disconnect', { reason: rlResult.reason });
            ws.close(WS_CLOSE_INVALID_MESSAGE, rlResult.reason ?? 'Rate limit exceeded');
            return;
          }
          // Warn: send rate.limit.warning message and drop this message
          sendJson(ws, { type: 'rate.limit.warning', retryAfterMs: rlResult.retryAfterMs });
          return;
        }
      }

      // -- Phase 1: Pending auth (token mode) --
      const authEntry = pendingAuth.get(ws);
      if (authEntry !== undefined) {
        clearTimeout(authEntry.timer);
        pendingAuth.delete(ws);

        // First message must be auth.request
        const parsed = agentAuthRequestSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn('First message must be auth.request (token mode)', {
            errors: parsed.error.issues,
          });
          sendJson(ws, { type: 'auth.failure', reason: 'First message must be auth.request' });
          ws.close(WS_CLOSE_AGENT_AUTH_FAILED, 'Invalid auth message');
          return;
        }

        // Protocol version check (consistent with Platform handler)
        if (parsed.data.protocolVersion < MIN_PROTOCOL_VERSION) {
          logger.warn('Agent protocol version below minimum', {
            received: parsed.data.protocolVersion,
            minimum: MIN_PROTOCOL_VERSION,
          });
          sendJson(ws, { type: 'auth.failure', reason: 'Unsupported protocol version' });
          ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Unsupported protocol version');
          return;
        }

        // Validate token via tokenStore
        if (!tokenStore) {
          logger.error('Token store not configured but auth mode is token');
          sendJson(ws, { type: 'auth.failure', reason: 'Server misconfiguration' });
          ws.close(WS_CLOSE_AGENT_AUTH_FAILED, 'Server misconfiguration');
          return;
        }

        const tokenRow = await tokenStore.validate(parsed.data.token);
        if (!tokenRow) {
          logger.warn('Agent auth failed: invalid or expired token');
          sendJson(ws, { type: 'auth.failure', reason: 'Invalid or expired token' });
          ws.close(WS_CLOSE_AGENT_AUTH_FAILED, 'Authentication failed');
          return;
        }

        // Parse the token's authorized-labels scope. `agent_tokens.labels` is
        // stored as JSON-encoded `string[]` (or `null` for unscoped tokens).
        // Malformed JSON in the column is a server-side state error — refuse
        // auth rather than fall through to "unscoped" (which would be a silent
        // privilege escalation back to the baseline).
        let tokenLabels: string[] | null = null;
        if (tokenRow.labels !== null) {
          try {
            const parsedLabels: unknown = JSON.parse(tokenRow.labels);
            if (!Array.isArray(parsedLabels) || !parsedLabels.every((l) => typeof l === 'string')) {
              throw new Error('not a string[]');
            }
            tokenLabels = parsedLabels;
          } catch (err) {
            logger.error('Token row has malformed labels JSON, refusing auth', {
              tokenId: tokenRow.id,
              tokenPrefix: tokenRow.token_prefix,
              error: toErrorMessage(err),
            });
            sendJson(ws, { type: 'auth.failure', reason: 'Server token state error' });
            ws.close(WS_CLOSE_AGENT_AUTH_FAILED, 'Token state error');
            return;
          }
        }

        // Auth successful -- send auth.success and move to pendingRegistration
        const connectionId = randomUUID();
        sendJson(ws, { type: 'auth.success', connectionId });

        const regTimer = setTimeout(() => {
          logger.warn('Agent registration timeout after auth, closing connection');
          pendingRegistration.delete(ws);
          ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Registration timeout');
        }, REGISTER_TIMEOUT_MS);

        pendingRegistration.set(ws, {
          timer: regTimer,
          tokenId: tokenRow.id,
          tokenLabels,
          tokenAgentType: tokenRow.agent_type,
          tokenCreatedBy: tokenRow.created_by,
          tokenExpiresAt: tokenRow.expires_at,
        });
        logger.info('Agent authenticated, awaiting registration', {
          tokenPrefix: tokenRow.token_prefix,
        });
        return;
      }

      // -- Phase 2: Pending registration --
      const regEntry = pendingRegistration.get(ws);
      if (regEntry !== undefined) {
        clearTimeout(regEntry.timer);
        pendingRegistration.delete(ws);

        const parsed = agentToOrchestratorMessageSchema.safeParse(raw);
        if (!parsed.success || parsed.data.type !== 'agent.register') {
          logger.warn('First message after auth must be agent.register', {
            errors: parsed.success ? undefined : parsed.error.issues,
          });
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'First message must be agent.register');
          return;
        }

        const { agentId, labels, platform, arch, version, maxConcurrency } = parsed.data;

        // Three token-bound authorization gates run together: label-scope
        // subset, ephemeral identity-binding, and static-token agentId
        // collision. Identical gates re-run on every subsequent re-register
        // on this WS (see `case 'agent.register'` in the post-register
        // switch) — `agent_tokens.labels` / `agent_type` / `created_by`
        // bound the connection's authority for its entire lifetime, not
        // just the first message after auth.
        const authStateForRegister: AuthState = {
          tokenId: regEntry.tokenId,
          tokenLabels: regEntry.tokenLabels,
          tokenAgentType: regEntry.tokenAgentType,
          tokenCreatedBy: regEntry.tokenCreatedBy,
        };
        if (
          !enforceRegisterAuthGates(authStateForRegister, { agentId, labels }, ws, agentIdToTokenId)
        ) {
          return;
        }
        if (regEntry.tokenId !== undefined) {
          // Bind the agentId to its tokenId so the collision gate fires
          // on a future first-register from a different token claiming
          // the same agentId.
          agentIdToTokenId.set(agentId, regEntry.tokenId);
        }
        // Cache the token authority context on the WS so the re-register
        // branch in the post-register switch can re-run the same gates
        // without a second token-store round-trip.
        wsToAuthState.set(ws, authStateForRegister);

        // Notify the scaler of agent registration FIRST so we can thread the
        // spawning scaler's `mandatoryLabels` into the registry entry. The
        // gate must be present on the AgentEntry before any subsequent
        // queue-drain or label-match call observes it; registering the agent
        // with an empty gate and back-filling it later would leave a window
        // where `dequeueForLabels` could pull an off-gate queued job.
        const scalerInfo = onScalerAgentRegistered?.(agentId, labels) ?? null;
        const pendingDispatch = scalerInfo?.boundJobId != null;

        // Register in the registry (platform/arch default to linux/x64 if not provided)
        registry.register(
          agentId,
          ws as unknown as WsLike,
          labels,
          platform ?? 'linux',
          arch ?? 'x64',
          version,
          maxConcurrency ?? 1,
          {
            hostname: parsed.data.hostname,
            osRelease: parsed.data.osRelease,
            osVersion: parsed.data.osVersion,
            totalMemoryMb: parsed.data.totalMemoryMb,
            cpuCount: parsed.data.cpuCount,
            nodeVersion: parsed.data.nodeVersion,
            runningAsUser: parsed.data.runningAsUser,
            runningAsUid: parsed.data.runningAsUid,
            // Threaded through so AgentRegistry.disconnectByTokenId(...)
            // can enumerate every in-flight WS for a revoked token. Null
            // when auth mode is `none` (no token-bound authority).
            tokenId: regEntry.tokenId ?? null,
            // Scaler-spawned agents inherit the spawning scaler's
            // Kubernetes-taint-style gate. Empty for static agents
            // (scalerInfo === null) — `findAvailable` and the queue-drain
            // path then behave exactly as before.
            mandatoryLabels: scalerInfo?.mandatoryLabels,
            // Scaler-spawned agents are single-use (destroyed on disconnect).
            // The dispatcher's disconnect triage keys off this flag.
            scalerManaged: scalerInfo !== null,
            // Snapshot the token's lifecycle class for the host roster's
            // `lifecycle_class`. Null when auth mode is `none`.
            tokenAgentType: toLifecycleClass(regEntry.tokenAgentType),
            // Agent-reported typed host-vars, shallow-merged into the roster's
            // host_properties (agent keys win over operator-declared keys).
            properties: parsed.data.properties,
          },
        );
        wsToAgentId.set(ws, agentId);

        // schedule a per-token TTL kick when the
        // token has a non-null `expires_at`. Static tokens have no
        // TTL by design (`expires_at = null`) so this is effectively
        // ephemeral-only. The scheduler is idempotent per tokenId, so
        // an agent reconnect under the same token is a no-op (the
        // token's `expires_at` doesn't shift across reconnects). See
        if (
          regEntry.tokenId !== undefined &&
          regEntry.tokenExpiresAt !== undefined &&
          regEntry.tokenExpiresAt !== null
        ) {
          registry.scheduleExpiryKick(regEntry.tokenId, regEntry.tokenExpiresAt);
        }

        // Send register.ack with confirmed config. When pendingDispatch is set,
        // the agent suppresses its short KICI_SCALER_IDLE_TIMEOUT timer because
        // the orchestrator is about to send dispatch.job (preparing it can take
        // seconds for jobs with provider lookups, secret merging, or upstream
        // output resolution — which previously raced the timer and killed the
        // agent before the dispatch arrived).
        sendJson(ws, {
          type: 'register.ack',
          agentId,
          labels,
          scalerManaged: scalerInfo !== null,
          ...(pendingDispatch ? { pendingDispatch: true } : {}),
        });

        // Update metrics
        setAgentsActive(registry.getActiveCount());

        logger.info('Agent registered', { agentId, labels });

        // Single-use bootstrap (init-runner) tokens are consumed on their first
        // successful register, so a leaked token is inert afterward. A bootstrap
        // token is tagged `created_by: 'bootstrap:<targetAgentId>'` at mint time.
        if (
          tokenStore &&
          regEntry.tokenId !== undefined &&
          regEntry.tokenCreatedBy?.startsWith('bootstrap:')
        ) {
          await tokenStore.consumeBootstrapToken(regEntry.tokenId);
        }

        // Reconcile in-flight jobs if agent reports them on reconnect
        if (parsed.data.inFlightJobs && parsed.data.inFlightJobs.length > 0) {
          await reconcileInFlightJobs(
            agentId,
            parsed.data.inFlightJobs,
            dispatcher,
            registry,
            onJobStatus,
          );
        }

        // Eager dispatch path: the scaler spawned this agent for a specific
        // queued job. Claim and dispatch that exact job atomically before the
        // generic queue drain runs, eliminating the dispatch-vs-idle-timer
        // race that caused scaler-managed agents (notably Firecracker, with
        // ~2s VM boot) to disconnect mid-spawn under concurrent run load.
        if (scalerInfo?.boundJobId) {
          const dispatched = await dispatcher.dispatchBoundJob(agentId, scalerInfo.boundJobId);
          if (!dispatched) {
            logger.warn('Bound job no longer dispatchable, falling back to queue drain', {
              agentId,
              boundJobId: scalerInfo.boundJobId,
            });
          }
        }

        // Down-then-up release: a static reboot host comes back as a fresh
        // connection (new WS ⇒ first-register path). Clear any reboot-pending
        // flag before draining so the held post-restart job is dispatched.
        await dispatcher.releaseRebootPending(agentId);

        // Drain any queued jobs for this agent (no-op if eager dispatch already
        // filled this agent's single slot).
        await dispatcher.onAgentAvailable(agentId);
        return;
      }

      // -- Registered: validate and route --
      const agentId = wsToAgentId.get(ws);
      if (!agentId) {
        logger.warn('Message from unregistered connection, closing');
        ws.close(WS_CLOSE_INVALID_MESSAGE, 'Not registered');
        return;
      }

      // -- FAST PATH for high-frequency messages on authenticated connections --
      // Skip full Zod safeParse for log.chunk and heartbeat (most frequent message types).
      // These manual validators are kept in sync with their Zod schemas per CLAUDE.md rule.

      if (isValidHeartbeat(raw)) {
        registry.updateHeartbeat(agentId);
        logger.debug('Agent heartbeat received', { agentId });
        return;
      }

      if (isValidLogChunk(raw)) {
        // Ownership validation with DB fallback. Synchronous check
        // hits the in-memory dispatcher Map; a miss in HA failover
        // falls through to `validateAsync` (DB-backed) before we
        // accept or reject. The DB fallback makes the log writer
        // tolerant of post-failover and post-complete chunks as
        // benign duplicates — the per-coord 30s grace window no
        // longer has to hide them.
        if (ownershipTracker && !ownershipTracker.checkOwnership(agentId, raw.jobId, 'log.chunk')) {
          const accept = await ownershipTracker.validateAsync(agentId, raw.jobId, 'log.chunk');
          if (!accept) return;
        }

        logger.debug('Log chunk received', {
          agentId,
          runId: raw.runId,
          jobId: raw.jobId,
          stepIndex: raw.stepIndex,
          lineCount: raw.lines.length,
        });
        onLogChunk?.(agentId, {
          runId: raw.runId,
          jobId: raw.jobId,
          stepIndex: raw.stepIndex,
          lines: raw.lines,
          timestamp: raw.timestamp,
        });
        return;
      }

      // RAW PATH: Handle agent-sent run.event and job.context messages.
      // These are not in agentToOrchestratorMessageSchema — the agent sends them
      // as raw typed casts, and the orchestrator enriches with orgId before forwarding.
      // Always intercept (even without callbacks) to prevent Zod rejection.
      const rawMsg = raw as { type?: string; [key: string]: unknown };
      if (rawMsg.type === 'run.event') {
        onRunEvent?.(agentId, {
          runId: rawMsg.runId as string,
          eventType: rawMsg.eventType as string,
          timestampMs: rawMsg.timestampMs as number,
          sourceService: rawMsg.sourceService as string,
          jobId: (rawMsg.jobId as string | null) ?? undefined,
          metadata: rawMsg.metadata as Record<string, unknown> | undefined,
          durationMs: (rawMsg.durationMs as number | null) ?? undefined,
        });
        return;
      }

      if (rawMsg.type === 'job.context') {
        onJobContext?.(agentId, {
          runId: rawMsg.runId as string,
          jobId: rawMsg.jobId as string,
          context: rawMsg.context as Record<string, unknown>,
        });
        return;
      }

      // SLOW PATH: Full Zod validation for all other message types
      const msgParse = agentToOrchestratorMessageSchema.safeParse(raw);
      if (!msgParse.success) {
        logger.warn('Invalid message from agent', {
          agentId,
          errors: msgParse.error.issues,
        });
        sendJson(ws, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Invalid message format',
        });
        ws.close(WS_CLOSE_INVALID_MESSAGE, 'Invalid message');
        return;
      }

      const msg = msgParse.data;

      switch (msg.type) {
        case 'agent.register': {
          // Re-registration: update the registry entry. Preserve the
          // existing mandatoryLabels gate — re-registration is a label /
          // metadata refresh, not a scaler relationship change. The scaler
          // hook only fires from the initial-registration phase above; if
          // we let the re-register path drop the gate, a gated agent could
          // start accepting off-gate jobs the first time it sends an
          // `agent.register` after its initial registration.
          //
          // Re-run the same three token-bound authorization gates the
          // first register ran. The `pendingRegistration` map was deleted
          // when the WS transitioned to "registered", so the authority
          // context comes from `wsToAuthState` (cached when the first
          // register's gates passed). Without this, a wire-supplied
          // `msg.labels` / `msg.agentId` would silently overwrite the
          // registry entry — collapsing the §5.3 / §5.1 invariants for
          // every re-register after Phase 2.
          const reregisterAuthState = wsToAuthState.get(ws);
          if (
            !enforceRegisterAuthGates(
              reregisterAuthState,
              { agentId: msg.agentId, labels: msg.labels },
              ws,
              agentIdToTokenId,
            )
          ) {
            return;
          }
          if (reregisterAuthState?.tokenId !== undefined) {
            // Update the agentId-to-tokenId mapping if the wire agentId
            // changed across the re-register (covers a static-token PSK
            // legitimately rebinding to a fresh agentId; the collision
            // gate above already rejected re-registers under an agentId
            // owned by a different token).
            agentIdToTokenId.set(msg.agentId, reregisterAuthState.tokenId);
          }

          const existingEntry = registry.get(msg.agentId);
          registry.register(
            msg.agentId,
            ws as unknown as WsLike,
            msg.labels,
            msg.platform ?? 'linux',
            msg.arch ?? 'x64',
            msg.version,
            msg.maxConcurrency ?? 1,
            {
              hostname: msg.hostname,
              osRelease: msg.osRelease,
              osVersion: msg.osVersion,
              totalMemoryMb: msg.totalMemoryMb,
              cpuCount: msg.cpuCount,
              nodeVersion: msg.nodeVersion,
              runningAsUser: msg.runningAsUser,
              runningAsUid: msg.runningAsUid,
              mandatoryLabels: existingEntry ? [...existingEntry.mandatoryLabels] : undefined,
              // Preserve single-use status across a re-register so disconnect
              // triage stays correct for a scaler-managed agent that reconnects.
              scalerManaged: existingEntry?.scalerManaged ?? false,
              // Preserve the lifecycle class across a re-register (cached on the
              // WS auth state at first register; falls back to the prior entry).
              tokenAgentType:
                toLifecycleClass(reregisterAuthState?.tokenAgentType) ??
                existingEntry?.tokenAgentType ??
                null,
            },
          );
          wsToAgentId.set(ws, msg.agentId);
          setAgentsActive(registry.getActiveCount());

          // Send register.ack for re-registration
          sendJson(ws, {
            type: 'register.ack',
            agentId: msg.agentId,
            labels: msg.labels,
            scalerManaged: false,
          });

          logger.info('Agent re-registered', {
            agentId: msg.agentId,
            labels: msg.labels,
          });

          // Reconcile in-flight jobs if agent reports them on reconnect
          if (msg.inFlightJobs && msg.inFlightJobs.length > 0) {
            await reconcileInFlightJobs(
              msg.agentId,
              msg.inFlightJobs,
              dispatcher,
              registry,
              onJobStatus,
            );
          }

          // Down-then-up release: this re-register is a fresh connection after a
          // reboot cycle, so clear any reboot-pending flag BEFORE draining. The
          // drain then dispatches the held post-restart job.
          await dispatcher.releaseRebootPending(msg.agentId);
          await dispatcher.onAgentAvailable(msg.agentId);
          break;
        }

        case 'config.ack': {
          logger.info('Agent config acknowledged', { agentId });
          onConfigAck?.(agentId);
          break;
        }

        case 'agent.status': {
          const entry = registry.get(agentId);
          if (entry) {
            // The registry's activeJobs count is authoritative: incremented
            // at dispatch, decremented on completion / rejection. The agent's
            // self-report lags dispatches in flight; assigning it here would
            // re-open an occupied slot and invite a double dispatch. Surface
            // disagreement as a warn — persistent drift is a bug signal.
            if (msg.activeJobs !== entry.activeJobs) {
              logger.warn('Agent self-reported activeJobs disagrees with registry count', {
                agentId,
                reported: msg.activeJobs,
                tracked: entry.activeJobs,
              });
            }

            // Update dynamic OS metadata if present
            if (msg.memoryUsedMb !== undefined) entry.memoryUsedMb = msg.memoryUsedMb;
            if (msg.memoryAvailableMb !== undefined)
              entry.memoryAvailableMb = msg.memoryAvailableMb;
            if (msg.uptimeSeconds !== undefined) entry.uptimeSeconds = msg.uptimeSeconds;

            logger.debug('Agent status update', {
              agentId,
              activeJobs: msg.activeJobs,
            });

            // Drain trigger: if the registry shows capacity, try the queue.
            if (entry.activeJobs < entry.maxConcurrency) {
              await dispatcher.onAgentAvailable(agentId);
            }
          }
          break;
        }

        case 'job.status': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'job.status')
          ) {
            const accept = await ownershipTracker.validateAsync(agentId, msg.jobId, 'job.status');
            if (!accept) break;
          }

          const { runId, jobId, state, timestamp, data } = msg;

          const errorMsg =
            data && typeof data === 'object' && 'error' in data
              ? (data as { error: unknown }).error
              : undefined;
          logger.info('Job status update', {
            agentId,
            runId,
            jobId,
            state,
            ...(errorMsg ? { error: errorMsg } : {}),
            ...(state === ExecutionJobStatus.enum.failed && data
              ? { failureData: JSON.stringify(data) }
              : {}),
          });

          switch (state) {
            case ExecutionJobStatus.enum.running: {
              // Job started -- disconnect triage now treats it as
              // non-redispatchable (steps may have side effects).
              dispatcher.markJobStarted(jobId);
              // Forward to onJobStatus for ExecutionTracker
              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.success:
            case ExecutionJobStatus.enum.failed:
            case ExecutionJobStatus.enum.cancelled: {
              // Process encrypted secret outputs on job success (fire-and-forget)
              if (
                state === ExecutionJobStatus.enum.success &&
                msg.secretOutputs &&
                onSecretOutputs
              ) {
                onSecretOutputs(runId, jobId, msg.secretOutputs).catch((err) => {
                  logger.warn('Failed to process secret outputs', {
                    agentId,
                    runId,
                    jobId,
                    error: toErrorMessage(err),
                  });
                });
              }

              // Job completed -- decrement active jobs and drain queue
              dispatcher.onJobComplete(agentId, jobId);
              // Drop the server-side user-cache namespace ref so the tracker
              // can't leak (mirrors the dispatcher's own per-job cleanup).
              dispatchCacheRefs?.delete(jobId);
              setAgentsActive(registry.getActiveCount());
              await dispatcher.onAgentAvailable(agentId);

              // Notify scaler of job completion
              onScalerJobComplete?.(agentId);

              // Forward to Platform client and ExecutionTracker
              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.cancelling: {
              // Agent is running cancel hooks -- forward to execution tracker
              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.pending:
            case ExecutionJobStatus.enum.queued:
            case ExecutionJobStatus.enum.skipped: {
              // Informational states
              logger.debug('Job informational status', { agentId, runId, jobId, state });
              break;
            }
          }
          break;
        }

        case 'job.reject': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'job.reject')
          ) {
            const accept = await ownershipTracker.validateAsync(agentId, msg.jobId, 'job.reject');
            if (!accept) break;
          }

          logger.warn('Agent rejected job dispatch', {
            agentId,
            runId: msg.runId,
            jobId: msg.jobId,
            reason: msg.reason,
          });
          await dispatcher.onJobRejected(agentId, msg.jobId, msg.reason);
          break;
        }

        case 'job.ack': {
          // Ownership validation with DB fallback (HA-safe).
          if (ownershipTracker && !ownershipTracker.checkOwnership(agentId, msg.jobId, 'job.ack')) {
            const accept = await ownershipTracker.validateAsync(agentId, msg.jobId, 'job.ack');
            if (!accept) break;
          }
          logger.debug('Job dispatch acknowledged', {
            agentId,
            runId: msg.runId,
            jobId: msg.jobId,
          });
          dispatcher.onJobAcked(agentId, msg.jobId);
          break;
        }

        case 'log.chunk': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'log.chunk')
          ) {
            const accept = await ownershipTracker.validateAsync(agentId, msg.jobId, 'log.chunk');
            if (!accept) break;
          }

          const { runId, jobId, stepIndex, lines, timestamp } = msg;
          logger.debug('Log chunk received', {
            agentId,
            runId,
            jobId,
            stepIndex,
            lineCount: lines.length,
          });
          onLogChunk?.(agentId, { runId, jobId, stepIndex, lines, timestamp });
          break;
        }

        case 'step.status': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'step.status')
          ) {
            const accept = await ownershipTracker.validateAsync(agentId, msg.jobId, 'step.status');
            if (!accept) break;
          }

          const {
            runId,
            jobId,
            stepIndex,
            stepName,
            state,
            timestamp,
            data,
            secretsAccessed,
            logBytesStreamed,
          } = msg;
          logger.info('Step status update', {
            agentId,
            runId,
            jobId,
            stepIndex,
            stepName,
            state,
          });
          onStepStatus?.(agentId, {
            runId,
            jobId,
            stepIndex,
            stepName,
            state,
            timestamp,
            data,
            secretsAccessed,
            logBytesStreamed,
          });
          break;
        }

        case 'step.approval-request': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'step.approval-request')
          ) {
            const accept = await ownershipTracker.validateAsync(
              agentId,
              msg.jobId,
              'step.approval-request',
            );
            if (!accept) break;
          }

          const {
            messageId,
            runId,
            jobId,
            stepIndex,
            stepName,
            clauses,
            reason,
            timeoutSeconds,
            payload,
          } = msg;
          logger.info('Step approval requested', { agentId, runId, jobId, stepIndex, stepName });

          if (!onStepApproval) {
            // No approval bridge wired — fail closed so the step doesn't hang.
            sendJson(ws, {
              type: 'step.approval-resolved',
              requestId: messageId,
              runId,
              jobId,
              stepIndex,
              outcome: 'rejected',
              reason: 'Approvals not available on this orchestrator',
            });
            break;
          }

          // The bridge creates a step-scoped hold and resolves when the hold is
          // approved/rejected/expired. The await may last as long as the
          // approval window; the agent keeps heartbeating during the wait.
          onStepApproval(agentId, {
            runId,
            jobId,
            stepIndex,
            stepName,
            clauses,
            reason,
            ...(timeoutSeconds !== undefined && { timeoutSeconds }),
            ...(payload !== undefined && { payload }),
          }).then(
            (resolution) => {
              sendJson(ws, {
                type: 'step.approval-resolved',
                requestId: messageId,
                runId,
                jobId,
                stepIndex,
                outcome: resolution.outcome,
                ...(resolution.reason !== undefined && { reason: resolution.reason }),
              });
            },
            (err) => {
              sendJson(ws, {
                type: 'step.approval-resolved',
                requestId: messageId,
                runId,
                jobId,
                stepIndex,
                outcome: 'rejected',
                reason: toErrorMessage(err),
              });
            },
          );
          break;
        }

        case 'job.heartbeat': {
          // Ownership validation with DB fallback (HA-safe).
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'job.heartbeat')
          ) {
            const accept = await ownershipTracker.validateAsync(
              agentId,
              msg.jobId,
              'job.heartbeat',
            );
            if (!accept) break;
          }

          const { runId, jobId, timestamp } = msg;
          logger.debug('Job heartbeat received', { agentId, runId, jobId });
          onJobHeartbeat?.(agentId, { runId, jobId, timestamp });
          break;
        }

        case 'agent.log': {
          const { lines, timestamp } = msg;
          logger.debug('Agent log received', { agentId, lineCount: lines.length });
          onAgentLog?.(agentId, { lines, timestamp });
          break;
        }

        case 'agent.metrics': {
          if (agentMetricsAggregator) {
            agentMetricsAggregator.update(agentId, msg.metrics);
            logger.debug('Agent metrics received', {
              agentId,
              metricCount: msg.metrics.length,
            });
          }
          break;
        }

        case 'cache.upload.request': {
          // Ownership validation: silently drop if agent does not own this job
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'cache.upload.request')
          )
            break;

          try {
            let uploadUrl: string;
            if (msg.cacheType === 'source') {
              if (!sourceCache) {
                logger.warn('cache.upload.request for source but sourceCache not configured', {
                  agentId,
                });
                sendJson(ws, {
                  type: 'cache.upload.response',
                  requestId: msg.messageId,
                  uploadUrl: '',
                });
                break;
              }
              uploadUrl = await sourceCache.getUploadUrl(msg.contentHash!);
            } else {
              if (!depCache) {
                logger.warn('cache.upload.request for deps but depCache not configured', {
                  agentId,
                });
                sendJson(ws, {
                  type: 'cache.upload.response',
                  requestId: msg.messageId,
                  uploadUrl: '',
                });
                break;
              }
              uploadUrl = await depCache.getUploadUrl(msg.lockfileHash!, msg.platform, msg.arch);
            }
            sendJson(ws, {
              type: 'cache.upload.response',
              requestId: msg.messageId,
              uploadUrl,
            });
            logger.info('Cache upload URL generated', {
              agentId,
              cacheType: msg.cacheType,
              platform: msg.platform,
              arch: msg.arch,
            });
          } catch (err) {
            logger.error('Failed to generate cache upload URL', {
              agentId,
              cacheType: msg.cacheType,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'cache.upload.response',
              requestId: msg.messageId,
              uploadUrl: '',
            });
          }
          break;
        }

        case 'cache.upload.complete': {
          // Ownership validation: silently drop if agent does not own this job
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'cache.upload.complete')
          )
            break;

          // Compute the storage key from the message fields
          let storageKey: string;
          if (msg.cacheType === 'source') {
            storageKey = `source/${msg.contentHash}.tar.gz`;
          } else {
            storageKey = `deps/${msg.platform}-${msg.arch}/${msg.lockfileHash}.tar.gz`;
          }

          if (cacheStorage) {
            try {
              await cacheStorage.initMeta(storageKey);
              // Store companion hash file for dep tarballs (agent-side integrity verification)
              if (msg.cacheType === 'deps' && msg.depsHash && msg.lockfileHash) {
                const hashKey = `deps/${msg.platform}-${msg.arch}/${msg.lockfileHash}.hash`;
                await cacheStorage.put(hashKey, msg.depsHash);
              }
              logger.info('Cache upload metadata initialized', {
                agentId,
                cacheType: msg.cacheType,
                storageKey,
              });
            } catch (err) {
              logger.error('Failed to initialize cache metadata', {
                agentId,
                storageKey,
                error: toErrorMessage(err),
              });
            }
          } else {
            logger.warn('cache.upload.complete received but cacheStorage not configured', {
              agentId,
              storageKey,
            });
          }
          break;
        }

        case 'cache.user.restore.request': {
          // Ownership: silently drop if the agent does not own this job.
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'cache.user.restore.request')
          )
            break;
          // Resolve the namespace server-side. Missing userCache or an
          // unresolvable jobId both fail closed to a miss — never a cross-tenant
          // read and never a trust of the wire-supplied identity.
          const ref = userCache ? resolveUserCacheRef(msg.jobId) : null;
          if (!userCache || !ref) {
            if (userCache && !ref) {
              logger.warn('user-cache restore for unresolvable job, replying miss', {
                agentId,
                jobId: msg.jobId,
              });
            }
            sendJson(ws, {
              type: 'cache.user.restore.response',
              requestId: msg.messageId,
              hit: false,
            });
            break;
          }
          try {
            const r = await userCache.restore({
              ...ref,
              key: msg.key,
              restoreKeys: msg.restoreKeys,
            });
            sendJson(ws, {
              type: 'cache.user.restore.response',
              requestId: msg.messageId,
              hit: r.hit,
              ...(r.matchedKey && { matchedKey: r.matchedKey }),
              ...(r.downloadUrl && { downloadUrl: r.downloadUrl }),
              ...(r.tarHash && { tarHash: r.tarHash }),
            });
          } catch (err) {
            logger.error('user-cache restore failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'cache.user.restore.response',
              requestId: msg.messageId,
              hit: false,
            });
          }
          break;
        }

        case 'cache.user.save.request': {
          // Ownership: silently drop if the agent does not own this job.
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'cache.user.save.request')
          )
            break;
          const ref = userCache ? resolveUserCacheRef(msg.jobId) : null;
          if (!userCache || !ref) {
            if (userCache && !ref) {
              logger.warn('user-cache save for unresolvable job, replying skip', {
                agentId,
                jobId: msg.jobId,
              });
            }
            // Fail closed: tell the agent to skip the upload (no presigned URL).
            sendJson(ws, {
              type: 'cache.user.save.response',
              requestId: msg.messageId,
              skip: true,
            });
            break;
          }
          try {
            const begin = await userCache.beginSave({ ...ref, key: msg.key });
            // Stash the temp key so the matching save.complete can commit it.
            if (begin.tempKey) {
              pendingUserCacheTempKeys.set(`${msg.jobId}:${msg.key}`, begin.tempKey);
            }
            sendJson(ws, {
              type: 'cache.user.save.response',
              requestId: msg.messageId,
              skip: begin.skip,
              ...(begin.uploadUrl && { uploadUrl: begin.uploadUrl }),
            });
          } catch (err) {
            logger.error('user-cache save begin failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'cache.user.save.response',
              requestId: msg.messageId,
              skip: true,
            });
          }
          break;
        }

        case 'cache.user.save.complete': {
          // Ownership: silently drop if the agent does not own this job.
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'cache.user.save.complete')
          )
            break;
          const stashKey = `${msg.jobId}:${msg.key}`;
          const tempKey = pendingUserCacheTempKeys.get(stashKey);
          pendingUserCacheTempKeys.delete(stashKey);
          const ref = userCache ? resolveUserCacheRef(msg.jobId) : null;
          if (!userCache || !ref) {
            if (userCache && !ref) {
              logger.warn('user-cache save.complete for unresolvable job, dropping', {
                agentId,
                jobId: msg.jobId,
              });
            }
            break;
          }
          try {
            await userCache.commitSave({
              ...ref,
              key: msg.key,
              tarHash: msg.tarHash,
              sizeBytes: msg.sizeBytes,
              ...(tempKey && { tempKey }),
            });
          } catch (err) {
            logger.error('user-cache save commit failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
          }
          break;
        }

        case 'provenance.upload.request': {
          // Ownership: silently drop if the agent does not own this job.
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'provenance.upload.request')
          )
            break;

          const ref = dispatchCacheRefs?.get(msg.jobId);
          if (!provenanceStorage || !ref) {
            if (provenanceStorage && !ref) {
              logger.warn('provenance upload for unresolvable job, replying with no URL', {
                agentId,
                jobId: msg.jobId,
              });
            }
            sendJson(ws, {
              type: 'provenance.upload.response',
              requestId: msg.messageId,
              uploadUrl: '',
            });
            break;
          }
          try {
            // runId comes from the server-side dispatch ref, never the wire.
            const key = provenanceStorageKey(ref.runId, msg.jobId, msg.subjectDigest);
            const uploadUrl = await provenanceStorage.getUploadUrl(key);
            sendJson(ws, {
              type: 'provenance.upload.response',
              requestId: msg.messageId,
              uploadUrl,
            });
            logger.info('Provenance upload URL generated', { agentId, jobId: msg.jobId, key });
          } catch (err) {
            logger.error('Failed to generate provenance upload URL', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'provenance.upload.response',
              requestId: msg.messageId,
              uploadUrl: '',
            });
          }
          break;
        }

        case 'provenance.upload.complete': {
          // Ownership: silently drop if the agent does not own this job.
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'provenance.upload.complete')
          )
            break;

          const ref = dispatchCacheRefs?.get(msg.jobId);
          if (!onProvenanceUpload || !ref) {
            if (onProvenanceUpload && !ref) {
              logger.warn('provenance upload.complete for unresolvable job, dropping', {
                agentId,
                jobId: msg.jobId,
              });
            }
            break;
          }
          try {
            const storageKey = provenanceStorageKey(ref.runId, msg.jobId, msg.subjectDigest);
            // The agent uploaded the bundle via a presigned PUT, which writes
            // only the data object — not the metadata sidecar `CacheStorage.get`
            // requires (a metadata-less object reads back as missing). Write the
            // companion metadata here, mirroring the `cache.upload.complete`
            // two-phase finalize, so the P1.7 dashboard read can inline the
            // bundle.
            if (provenanceStorage) {
              await provenanceStorage.initMeta(storageKey);
            }
            await onProvenanceUpload({
              runId: ref.runId,
              jobId: msg.jobId,
              subjectName: msg.subjectName,
              subjectDigest: msg.subjectDigest,
              storageKey,
              mediaType: msg.mediaType,
            });
            logger.info('Provenance attestation recorded', {
              agentId,
              jobId: msg.jobId,
              storageKey,
            });
          } catch (err) {
            logger.error('Failed to record provenance attestation', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
          }
          break;
        }

        case 'job.concurrency.report': {
          // Ownership validation: silently drop if agent does not own this job
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'job.concurrency.report')
          )
            break;

          const { runId, jobId, group, messageId } = msg;
          logger.info('Concurrency report received', { agentId, runId, jobId, group });

          if (onConcurrencyReport) {
            const result = await onConcurrencyReport(agentId, { runId, jobId, group, messageId });
            sendJson(ws, {
              type: 'job.concurrency.ack',
              requestId: messageId,
              action: result.action,
              ...(result.reason && { reason: result.reason }),
            });

            // On `wait`, the agent stays connected and long-polls for an
            // unsolicited follow-up `concurrency.ack`. Do NOT release the
            // dispatcher slot here — the workflow-runner is still parked on
            // the second `waitForConcurrencyAck` call, holding the agent's
            // capacity until a slot frees (orchestrator -> tryDispatchNextQueued)
            // or the connection drops (tracker drops the waiter and cancels
            // the queued row).
          } else {
            // No concurrency handler -- default to proceed (concurrency disabled)
            sendJson(ws, {
              type: 'job.concurrency.ack',
              requestId: messageId,
              action: 'proceed',
            });
          }
          break;
        }

        case 'event.emit': {
          // Ownership validation: silently drop if agent does not own this job
          if (
            ownershipTracker &&
            !ownershipTracker.checkOwnership(agentId, msg.jobId, 'event.emit')
          )
            break;

          if (!onEventEmit) {
            logger.warn('event.emit received but event routing not configured', { agentId });
            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              error: 'Event routing not available',
            });
            break;
          }

          try {
            const result = await onEventEmit(agentId, {
              jobId: msg.jobId,
              requestId: msg.requestId,
              eventName: msg.eventName,
              payload: msg.payload,
              target: msg.target,
            });

            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              ...(result.deliveryId && { deliveryId: result.deliveryId }),
              ...(result.error && { error: result.error }),
            });
          } catch (err) {
            logger.error('Failed to process event.emit', {
              agentId,
              jobId: msg.jobId,
              eventName: msg.eventName,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              error: toErrorMessage(err),
            });
          }
          break;
        }

        case 'agent.api.request': {
          const { agentApiRegistry } = deps;
          if (!agentApiRegistry) {
            sendJson(ws, {
              type: 'agent.api.response',
              requestId: msg.requestId,
              error: 'Agent API not available',
            });
            break;
          }

          try {
            // Every agent may call read AND write methods on its own behalf.
            // Write methods only ever affect the calling agent's own host
            // (e.g. host.requestReboot reboots the box the agent runs on), so
            // there is no cross-agent escalation surface to gate further here.
            const allowedRoles: Array<'read' | 'write'> = ['read', 'write'];
            const result = await agentApiRegistry.handle(
              agentId,
              msg.method,
              msg.params as Record<string, unknown>,
              allowedRoles,
            );
            sendJson(ws, {
              type: 'agent.api.response',
              requestId: msg.requestId,
              result,
            });
          } catch (err) {
            logger.warn('Agent API request failed', {
              agentId,
              method: msg.method,
              error: toErrorMessage(err),
            });
            sendJson(ws, {
              type: 'agent.api.response',
              requestId: msg.requestId,
              error: toErrorMessage(err),
            });
          }
          break;
        }

        case 'fleet.bundle.chunk': {
          deps.fleetAgentCollector?.onChunk(msg.requestId, msg.seq, msg.dataB64, msg.isLast);
          break;
        }

        case 'fleet.bundle.error': {
          logger.warn('Agent reported fleet bundle error', {
            agentId,
            requestId: msg.requestId,
            error: msg.message,
          });
          deps.fleetAgentCollector?.onError(msg.requestId, msg.message);
          break;
        }
      }
    },

    onClose(_evt: CloseEvent, ws: WSContext) {
      // Clean up rate limiter
      rateLimiters.delete(ws);

      // Clean up pending auth
      const authEntry = pendingAuth.get(ws);
      if (authEntry !== undefined) {
        clearTimeout(authEntry.timer);
        pendingAuth.delete(ws);
        logger.info('Agent connection closed before auth');
        return;
      }

      // Clean up pending registration
      const regEntry = pendingRegistration.get(ws);
      if (regEntry !== undefined) {
        clearTimeout(regEntry.timer);
        pendingRegistration.delete(ws);
        logger.info('Agent connection closed before registration');
        return;
      }

      // Clean up registered agent
      const agentId = wsToAgentId.get(ws);
      if (agentId) {
        wsToAgentId.delete(ws);
        // Cleanup the agentId->tokenId map too, otherwise an agent that
        // disconnects and never reconnects leaves a stale entry behind
        // (slow leak that grows with every churned agent).
        agentIdToTokenId.delete(agentId);
        // Same cleanup logic for the per-WS authority cache — the WS is
        // gone, so the captured token context is dead state.
        wsToAuthState.delete(ws);

        // Clean up ownership violation tracking
        ownershipTracker?.cleanup(agentId);

        // Reject any in-flight fleet-bundle requests this agent was answering —
        // the chunked response can never complete now that its WS is gone.
        deps.fleetAgentCollector?.rejectAgent(agentId, 'agent disconnected');

        // Drop any in-memory concurrency waiters owned by this agent and
        // cancel the matching `concurrency_groups.status='queued'` rows so the
        // run is marked failed instead of sitting forever.
        if (onConcurrencyAgentDisconnect) {
          Promise.resolve(onConcurrencyAgentDisconnect(agentId)).catch((err) => {
            logger.warn('Concurrency waiter cleanup failed on agent disconnect', {
              agentId,
              error: toErrorMessage(err),
            });
          });
        }

        // Dispatcher handles: mark dispatched jobs as failed, unregister from registry
        dispatcher
          .onAgentDisconnect(agentId)
          .then((failedJobIds) => {
            // Clean up pending build entries so processor doesn't hang forever
            if (pendingBuilds) {
              for (const jobId of failedJobIds) {
                pendingBuilds.cleanup(jobId);
              }
            }

            // Clean up pending init entries so init dispatch doesn't hang forever
            if (pendingInits) {
              for (const jobId of failedJobIds) {
                pendingInits.cleanup(jobId);
              }
            }

            // Clean up pending dynamic eval entries so processor doesn't hang forever
            if (pendingDynamics) {
              for (const jobId of failedJobIds) {
                pendingDynamics.cleanup(jobId);
              }
            }

            // Drop the server-side user-cache namespace refs for the agent's
            // now-failed jobs so the tracker can't leak across a disconnect.
            if (dispatchCacheRefs) {
              for (const jobId of failedJobIds) {
                dispatchCacheRefs.delete(jobId);
              }
            }
          })
          .catch((err) => {
            logger.error('Error handling agent disconnect', {
              agentId,
              error: toErrorMessage(err),
            });
          });

        // Mark agent metrics for retention-based cleanup
        agentMetricsAggregator?.markDisconnected(agentId);

        // Notify scaler of agent disconnect
        onScalerAgentDisconnected?.(agentId);

        setAgentsActive(Math.max(0, registry.getActiveCount() - 1));

        logger.info('Agent disconnected', { agentId });
      }
    },

    onError(_evt: Event, _ws: WSContext) {
      logger.error('Agent WebSocket error');
    },
  };
}
