/**
 * WebSocket handler for agent connections: kat_ token auth, registration,
 * job dispatch, status reports and heartbeats.
 *
 * Two-phase auth flow (when agentAuthMode === 'token'):
 * 1. pendingAuth (5s): Agent must send auth.request with a valid kat_ token.
 * 2. pendingRegistration (10s): After auth.success, agent must send agent.register.
 * 3. registered: Agent is fully connected and can exchange messages.
 *
 * When agentAuthMode === 'none', the connection starts in pendingRegistration.
 * An agent carrying a token still opens with auth.request (nothing on the wire
 * tells it the mode), so that frame is answered with auth.success without
 * reading the token.
 */

import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';
import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage, computeBackoffDelay } from '@kici-dev/shared';
import {
  agentToOrchestratorMessageSchema,
  agentAuthRequestSchema,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_INTERNAL_ERROR,
  WS_CLOSE_AGENT_AUTH_FAILED,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_SUPERSEDED_BY_RECONNECT,
  WsRateLimiter,
  ExecutionJobStatus,
  isSelfReportedLabel,
  canonicalizeLabel,
  canonicalizeLabels,
  PRIVILEGED_ROOT_LABEL,
  ORCH_AGENT_CAPABILITIES,
  ArtifactCompleteAckOutcome,
  ArtifactDownloadOutcome,
  ArtifactUploadOutcome,
  LogStream,
  reservedEventNamePrefix,
  ScaleDownReason,
} from '@kici-dev/engine';
import type { RateLimiterConfig, AttestationVerifyStatus } from '@kici-dev/engine';
import { provenanceStorageKey } from '@kici-dev/engine/provenance/bundle';
import type { ProvenanceTrustRoot } from '../provenance/trust-root.js';
import { computeAttestationVerdict } from '../provenance/verify-at-ingest.js';
import type { AgentRegistry, WsLike } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import {
  boundAgentIdFromCreatedBy,
  BOOTSTRAP_CREATED_BY_PREFIX,
  type AgentTokenStore,
} from '../agent/token-store.js';
import type { OwnershipTracker } from '../agent/ownership-tracker.js';
import { OWNERSHIP_REFUSED } from '../agent/ownership-refusal.js';
import { gateOwnership, type OwnershipDecision } from './ownership-gate.js';
import type { SourceCache } from '../cache/source-cache.js';
import { depTarballKey } from '../cache/dep-cache.js';
import { sourceTarballKey } from '../cache/source-cache.js';
import type { DepCache } from '../cache/dep-cache.js';
import type { UserCache, UserCacheRef } from '../cache/user-cache.js';
import {
  ArtifactInvalidNameError,
  ArtifactObjectMissingError,
  classifyArtifactCommitFailure,
  type ArtifactStore,
} from '../artifacts/artifact-store.js';
import { ArtifactInternalFailure } from '../artifacts/failure-messages.js';
import { AgentWsInternalFailure } from './failure-messages.js';
import type { DispatchCacheRefTracker } from '../cache/dispatch-cache-ref-tracker.js';
import type { PendingBuildTracker } from '../cache/pending-builds.js';
import type { PendingInitTracker } from '../cache/pending-inits.js';
import type { PendingDynamicTracker } from '../cache/pending-dynamics.js';
import type { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import {
  awaitCacheUploadSettle,
  CacheUploadSettleOutcome,
  type CacheUploadSettle,
} from '../cache/cache-upload-settle.js';
import type { CacheStorage } from '../storage/types.js';
import { setAgentsActive } from '../metrics/prometheus.js';
import type { AgentMetricsAggregator } from '../metrics/agent-metrics-aggregator.js';
import {
  ApiRoleDeniedError,
  UnknownApiMethodError,
  type AgentApiRegistry,
} from './agent-api-registry.js';
import type { FleetAgentCollector } from './fleet-agent-collector.js';

const logger = createLogger({ prefix: 'agent-ws-handler' });

/** Timeout for auth phase (must send auth.request within this window). */
const AUTH_TIMEOUT_MS = 5_000;

/** Timeout for registration phase (must send agent.register after auth). */
const REGISTER_TIMEOUT_MS = 10_000;

/**
 * Bounded retry for the artifact commit, which is idempotent (server-derived
 * storage key, onConflict-do-nothing insert). Kept well inside the agent's 25s
 * ack timeout.
 */
const ARTIFACT_COMMIT_RETRY = {
  maxAttempts: 3,
  delayMs: 100,
  backoff: 'exponential',
  maxDelayMs: 1_000,
} as const;

/**
 * Commits an artifact upload, retrying transient failures. A missing object
 * (the presigned PUT never landed) and an invalid artifact name are terminal
 * and rethrown immediately.
 */
async function completeUploadWithRetry(
  artifactStore: ArtifactStore,
  args: Parameters<ArtifactStore['completeUpload']>[0],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await artifactStore.completeUpload(args);
      return;
    } catch (err) {
      if (
        err instanceof ArtifactObjectMissingError ||
        err instanceof ArtifactInvalidNameError ||
        attempt >= ARTIFACT_COMMIT_RETRY.maxAttempts
      ) {
        throw err;
      }
      logger.warn('artifact upload-complete attempt failed, retrying', {
        runId: args.runId,
        name: args.name,
        attempt,
        error: toErrorMessage(err),
      });
      await new Promise((r) => setTimeout(r, computeBackoffDelay(attempt, ARTIFACT_COMMIT_RETRY)));
    }
  }
}

/**
 * Token-bound authorization context captured at auth time and consulted on
 * every `agent.register` on an authenticated WS: the first (Phase 2) and every
 * re-register.
 *
 * `undefined` fields mean `agentAuthMode === 'none'`; the gates are skipped.
 * `tokenLabels === null` is an unscoped token (minted without `--labels`).
 */
type AuthState = {
  tokenId?: string;
  tokenLabels?: string[] | null;
  /**
   * Token-authorized taint set (`agent_tokens.mandatory_labels`): becomes the
   * static agent's `mandatoryLabels`, confining it to jobs whose `runsOn`
   * demands every label here. `null`/`undefined` = no taint. Containing
   * `PRIVILEGED_ROOT_LABEL` triggers the uid-0 honesty gate.
   */
  tokenMandatoryLabels?: string[] | null;
  tokenAgentType?: string;
  tokenCreatedBy?: string | null;
};

/**
 * Narrows the free-string `agent_type` column to the host-roster lifecycle
 * class. Any other value (including `undefined` under `agentAuth: 'none'`)
 * maps to `null`, the GC-able default class.
 */
function toLifecycleClass(agentType: string | undefined): 'static' | 'ephemeral' | null {
  return agentType === 'static' || agentType === 'ephemeral' ? agentType : null;
}

/**
 * WebSocket close reasons are capped at 123 UTF-8 bytes (RFC 6455, section 5.5.1).
 * A longer reason makes `ws.close()` throw a RangeError, which in an async
 * handler becomes an unhandled rejection and skips the close. Truncates on a
 * byte boundary, dropping any trailing partial multi-byte char.
 */
export function truncateCloseReason(reason: string): string {
  const bytes = Buffer.from(reason, 'utf-8');
  if (bytes.length <= 123) return reason;
  return bytes.subarray(0, 123).toString('utf-8').replace(/�+$/, '');
}

/** What a failed frame is about, for the failure log. */
export interface FrameIdentity {
  messageType?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
}

/** Longest id a failure log copies from a frame. */
const FRAME_ID_MAX = 128;

/**
 * Reads the type and ids from a raw agent frame for a failure log. Copies only
 * string fields, each capped at 128 characters; a non-object yields nothing.
 */
export function frameIdentity(data: unknown): FrameIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof data === 'string' ? data : String(data));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const fields = raw as Record<string, unknown>;
  const identity: FrameIdentity = {};
  const copy = (from: string, to: keyof FrameIdentity): void => {
    const value = fields[from];
    if (typeof value === 'string') identity[to] = value.slice(0, FRAME_ID_MAX);
  };
  copy('type', 'messageType');
  copy('agentId', 'agentId');
  copy('runId', 'runId');
  copy('jobId', 'jobId');
  return identity;
}

/**
 * The agent WebSocket handler. `onMessage` resolves once the frame is handled
 * and never rejects: the WebSocket server does not await it.
 */
export interface AgentWsEvents extends Omit<WSEvents, 'onMessage'> {
  onMessage(evt: MessageEvent<WSMessageReceive>, ws: WSContext): Promise<void>;
}

/** `error` frame code sent when a registration is refused because another agent token holds the id. */
export const AGENT_ID_IN_USE = 'AGENT_ID_IN_USE';

/**
 * Run the privileged-root honesty gate and the three token-bound authorization
 * gates against a wire-supplied `agent.register` payload. Every code path that
 * mutates the registry's `agentId → entry` mapping for an authenticated WS
 * (first register and every re-register) MUST run them, or a re-register can
 * silently overwrite the authority.
 *
 * Gates:
 *  0. Privileged-root honesty (any auth mode) — a privileged-root claim needs
 *     a self-reported uid 0. Closes the WS with `WS_CLOSE_AGENT_AUTH_FAILED`.
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
 * Returns `false` after closing the WS on the first violation; the caller MUST
 * then stop processing.
 */
function enforceRegisterAuthGates(
  authState: AuthState | undefined,
  payload: { agentId: string; labels: string[]; runningAsUid?: number },
  ws: WsLike & { close(code: number, reason: string): void },
  registry: Pick<AgentRegistry, 'isAgentIdHeldByOtherToken'>,
): boolean {
  const { agentId, runningAsUid } = payload;
  // Folds case once at ingress. Load-bearing for gate 0: the registry stores
  // the canonical form, so `KICI:PRIVILEGED:ROOT` would otherwise slip past the
  // honesty check yet match the privileged-root selector at dispatch.
  const labels = canonicalizeLabels(payload.labels);

  // Gate 0 — privileged-root honesty (any auth mode): a root-demanding job must
  // never land on a non-root agent. Fails closed when the label is claimed (on
  // the wire, or by the token as a label or taint) without a verifiable uid 0;
  // an absent uid is refused. uid is self-reported, so this catches honest
  // misconfig only: a malicious agent already holds an operator-minted
  // privileged token and is inside the trust boundary.
  const claimsPrivilegedRoot =
    labels.includes(canonicalizeLabel(PRIVILEGED_ROOT_LABEL)) ||
    (authState?.tokenLabels?.includes(PRIVILEGED_ROOT_LABEL) ?? false) ||
    (authState?.tokenMandatoryLabels?.includes(PRIVILEGED_ROOT_LABEL) ?? false);
  if (claimsPrivilegedRoot && runningAsUid !== 0) {
    logger.warn('Agent register rejected: privileged-root claim by non-root agent', {
      agentId,
      runningAsUid: runningAsUid ?? null,
    });
    ws.close(
      WS_CLOSE_AGENT_AUTH_FAILED,
      truncateCloseReason(
        `privileged-root token presented by non-root agent (uid=${runningAsUid ?? 'absent'})`,
      ),
    );
    return false;
  }

  if (authState === undefined) return true;
  const { tokenId, tokenLabels, tokenAgentType, tokenCreatedBy } = authState;

  // Gate 1 — token-scope subset. Self-reported platform facts (kici:os:,
  // kici:arch:, kici:host:) are exempt: unpredictable at mint time and grant no
  // privilege. Authorization-bearing labels (base + scaler-assigned
  // kici:agent:/kici:scaler:/kici:role:) must be token-bound, which the scaler
  // does via scalerAgentLabels().
  if (tokenLabels !== undefined && tokenLabels !== null) {
    // Both sides folded: a case-only difference is not an escalation, and a
    // close over one would read as an auth failure with no hint of the cause.
    const allowedSet = new Set(canonicalizeLabels(tokenLabels));
    const elevated = labels.filter((l) => !allowedSet.has(l) && !isSelfReportedLabel(l));
    if (elevated.length > 0) {
      logger.warn('Agent register-time label-scope violation: wire labels exceed token-bound set', {
        agentId,
        tokenLabels,
        wireLabels: payload.labels,
        elevated,
      });
      ws.close(
        WS_CLOSE_AGENT_AUTH_FAILED,
        truncateCloseReason(`Agent labels exceed token-bound scope: ${elevated.join(',')}`),
      );
      return false;
    }
  }

  // Gate 2 — ephemeral identity-binding. `created_by` holds the bound id
  // verbatim (scaler) or behind `bootstrap:` (init-runner, mintBootstrapToken).
  if (tokenAgentType === 'ephemeral' && tokenCreatedBy !== undefined && tokenCreatedBy !== null) {
    const boundAgentId = boundAgentIdFromCreatedBy(tokenCreatedBy);
    if (boundAgentId !== agentId) {
      logger.warn(
        'Agent register-time identity-binding violation: ephemeral token bound to a different agentId',
        { wireAgentId: agentId, tokenCreatedBy, boundAgentId, tokenId },
      );
      ws.close(
        WS_CLOSE_AGENT_AUTH_FAILED,
        truncateCloseReason(
          `Ephemeral token bound to a different agentId: expected ${boundAgentId}, got ${agentId}`,
        ),
      );
      return false;
    }
  }

  // Gate 3 — agentId collision. A live agent id belongs to its token: another
  // token's registration is refused while that connection lives or is
  // mid-registration (the shared registry tracks both across handlers). A
  // reconnect presents the same token; a rotated token gets in once the old
  // connection is gone (closed, revoked, or heartbeat-dropped). The close code
  // is not permanent, so a refused agent keeps retrying.
  if (tokenId !== undefined && registry.isAgentIdHeldByOtherToken(agentId, tokenId, ws)) {
    logger.warn('Agent register rejected: agent id held by a live connection under another token', {
      agentId,
    });
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: AGENT_ID_IN_USE,
          message: `Agent id ${agentId} is registered under a different agent token`,
        }),
      );
    }
    ws.close(WS_CLOSE_INVALID_MESSAGE, 'AgentId already registered with a different token');
    return false;
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
  /**
   * Optional callback when agent sends log chunks. A returned promise is the
   * chunk's write, which {@link AgentWsHandlerDeps.trackLogChunk} registers.
   */
  onLogChunk?: (agentId: string, msg: AgentLogChunkInput) => void | Promise<void>;
  /**
   * Registers a log chunk's handling with its run's log drain before anything
   * is awaited (`LogWriter.trackPending`): a run completing during the
   * ownership DB fallback would otherwise drain without the chunk, leaving its
   * segment never sealed.
   */
  trackLogChunk?: (runId: string, pending: Promise<unknown>) => void;
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
      /** Parallel step-group concurrency role (`sequential` | `parallel-child` | `parallel-group`). */
      concurrencyKind?: string;
      /** Parallel-group correlation id shared by a group's children. */
      groupId?: string;
      /** Raw log bytes accumulated by this step's LogStreamer at terminal time. */
      logBytesStreamed?: number;
    },
  ) => void;
  /**
   * Optional callback when a scaler-managed agent registers.
   *
   * Returns:
   * - `boundJobId` (optional): a queued job the scaler bound to this agent at
   *   spawn time, dispatched eagerly before the agent's idle timer fires.
   * - `mandatoryLabels` (always populated for scaler-managed agents): the
   *   spawning scaler's taint-style gate, threaded into the AgentRegistry so
   *   queue drain and eager dispatch apply the same gate as the scaler.
   *
   * Resolves to `null` for static agents. Asynchronous because an instance
   * that did not spawn the agent adopts it from the shared spawn record (a
   * database round trip).
   */
  onScalerAgentRegistered?: (
    agentId: string,
    labels: string[],
  ) => Promise<{ boundJobId?: string; mandatoryLabels: string[] } | null>;
  /**
   * Optional callback when an agent disconnects (for scaler lifecycle). `reason`
   * is the scale-down reason an event scaler emits for it.
   */
  onScalerAgentDisconnected?: (agentId: string, reason?: ScaleDownReason) => void;
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
  /**
   * Optional callback when agent emits a custom event via ctx.emit().
   *
   * A returned `error` is relayed verbatim to the agent, which runs untrusted
   * workflow code that persists it into the author's step logs, so it may only carry author-facing wording (an unknown job context). Raw
   * exception text goes to the implementation's own `logger.*`, returning
   * {@link AgentWsInternalFailure.eventEmitFailed} instead; a thrown exception
   * is already replaced with that string here.
   */
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
  /**
   * Optional callback: a provisioning workflow's agent exchanges a single-use
   * claim code (from a `kici.scaler.scale-up` event) for freshly minted
   * ephemeral agent credentials. Delegates to the event scaler backend's claim
   * store. Returns the credentials or an author-actionable error; the token is
   * carried only in the response, never logged.
   */
  onClaimCredentials?: (
    agentId: string,
    claimCode: string,
  ) => Promise<{
    credentials?: {
      agentToken: string;
      agentId: string;
      orchestratorUrl: string;
      labels: string[];
    };
    error?: string;
  }>;
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
   * Server-side jobId -> `{orgId, repoId, cacheRefScope, runId}` store, recorded
   * at dispatch. `cache.user.*` handlers resolve the ref from HERE, NEVER from
   * the wire body (which carries only `jobId` + `key`): an agent can name a job
   * it owns but never influence which org/repo/scope it resolves to.
   */
  dispatchCacheRefs?: DispatchCacheRefTracker;
  /**
   * User-facing artifact store for serving `artifacts.*` upload/download
   * requests from the sandbox. The org (`customer_id`) + runId are resolved
   * server-side from the job's dispatch ref, NEVER from the wire body.
   */
  artifactStore?: ArtifactStore;
  /** Cache storage for setting metadata after upload completion. */
  cacheStorage?: CacheStorage;
  /**
   * In-flight build-cache publishes and the per-org bound a build's success
   * waits for them. Per orchestrator, not per connection, so a success replayed
   * on a reconnected socket sees a publish started on the old one. Absent: no
   * registration and no wait.
   */
  cacheUploadSettle?: CacheUploadSettle;
  /**
   * Storage used to mint presigned PUT URLs for provenance bundles. Distinct
   * dep so a deployment can decide whether attestations share the cache bucket.
   */
  provenanceStorage?: CacheStorage;
  /**
   * Provenance trust root used to verify each bundle at ingest. When absent (or
   * its issuer is null) the verdict is recorded as `unverifiable`.
   */
  provenanceTrustRoot?: ProvenanceTrustRoot;
  /**
   * Record a completed provenance-bundle upload (writes an attestations row).
   * `runId` is resolved server-side from the job's dispatch ref, never the wire.
   * The verdict fields are computed at ingest (verify-at-ingest).
   */
  onProvenanceUpload?: (record: {
    runId: string;
    jobId: string;
    subjectName: string;
    subjectDigest: string;
    storageKey: string;
    mediaType: string;
    verifyStatus: AttestationVerifyStatus;
    verifyReason: string | null;
    verifiedAt: Date | null;
  }) => Promise<void>;
  /**
   * Optional callback when an agent reports a deferred attestation (transient
   * mint failure). Persists the frozen envelope into the deferred-attestation
   * outbox; the job stays green and the token is minted later.
   */
  onProvenanceDefer?: (record: {
    runId: string;
    jobId: string;
    subjectName: string;
    subjectDigest: string;
    audience: string;
    mediaType: string;
    statementHash: string;
    dsseEnvelope: unknown;
    publicKey: unknown;
    originKind: 'deferred' | 'offline-backfill';
  }) => Promise<void>;
  /**
   * Classify a deferred attestation's origin from the local run row: a run
   * ingested while the Platform was down is `offline-backfill`, otherwise a
   * transient blip is `deferred`. Defaults to always-`deferred` when unset.
   */
  classifyDeferOrigin?: (runId: string) => Promise<'deferred' | 'offline-backfill'>;
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
  /** Optional pending global-eval-round tracker for cleanup on agent disconnect. */
  pendingGlobalEvals?: PendingGlobalEvalTracker;
  /** Optional callback when agent sends encrypted secret outputs on job success. */
  onSecretOutputs?: (
    runId: string,
    jobId: string,
    secretOutputs: Record<string, { agentPublicKey: string; encrypted: string }>,
  ) => Promise<void>;
  /** Agent metrics aggregator for receiving pushed metrics. */
  agentMetricsAggregator?: AgentMetricsAggregator;
  /**
   * Optional callback when agent reports a job belongs to a concurrency group.
   *
   * A returned `reason` is relayed verbatim as the `job.concurrency.ack`
   * reason to the agent, which runs untrusted workflow code that persists it into
   * the author's step logs, so it may only carry author-facing
   * wording (the group the job queued behind). Raw exception text goes to the
   * implementation's own `logger.*`.
   */
  onConcurrencyReport?: (
    agentId: string,
    msg: { runId: string; jobId: string; group: string; messageId: string },
  ) => Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }>;
  /**
   * Optional callback when an agent blocks an `approval` step. The server
   * creates a step-scoped hold from the clauses (and the drift `payload` for a
   * `when: 'drift'` gate), resolving when it is approved, rejected, or
   * expired; the handler relays that as `step.approval-resolved`. `agentId`
   * lets the server drop the pending resolver on disconnect.
   *
   * The resolved `reason` is relayed verbatim to the agent, which runs untrusted
   * workflow code that persists it into the author's step logs, so it may only carry author-facing wording (a decline note, an invalid
   * per-gate timeout). Raw exception text goes to the implementation's own
   * `logger.*`; a rejected promise is already replaced with
   * {@link AgentWsInternalFailure.approvalFailed} here.
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
   * Optional callback on WS close, after the dispatcher's cleanup. The
   * concurrency pipeline drops the agent's queued waiters and `cancelQueued`s
   * their DB rows so the run fails instead of dangling.
   */
  onConcurrencyAgentDisconnect?: (agentId: string) => void | Promise<void>;
  /** Agent private API registry for handling agent.api.request messages. */
  agentApiRegistry?: AgentApiRegistry;
  /**
   * Orchestrator-scoped collector correlating fleet.logs.request with the
   * agent's chunked fleet.bundle.chunk / fleet.bundle.error response. An
   * agent's pending requests are rejected when its WS closes.
   */
  fleetAgentCollector?: FleetAgentCollector;
}

/**
 * Reconciles in-flight jobs reported by a reconnecting agent: for each, tries
 * to reclaim the dispatcher's recovery timer and restore DB and in-memory
 * tracking.
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
      registry.incrementActiveJobs(agentId);
      recoveredCount++;

      const recoveryInfo = dispatcher.getRecoveryInfo(jobId);
      const recoveryDuration = recoveryInfo ? Date.now() - recoveryInfo.disconnectedAt : 0;

      logger.info('Job recovered from agent reconnection', {
        recovery_duration: recoveryDuration,
        agent_id: agentId,
        job_id: jobId,
        run_id: runId,
        buffered_messages_count: 0,
      });

      onJobStatus?.(agentId, {
        runId,
        jobId,
        state: ExecutionJobStatus.enum.running,
        timestamp: Date.now(),
      });
    } else {
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
 */
export function isValidLogChunk(raw: unknown): raw is {
  type: 'log.chunk';
  messageId: string;
  runId: string;
  jobId: string;
  stepIndex: number;
  lines: string[];
  timestamp: number;
  stream: LogStream;
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
    typeof msg.timestamp === 'number' &&
    LogStream.safeParse(msg.stream).success
  );
}

/**
 * FAST PATH: Manual type guard for heartbeat messages.
 *
 * SYNC INVARIANT: This manual validator MUST match the Zod schema
 * `heartbeatSchema` in packages/engine/src/protocol/messages/common.ts.
 * If you change the schema, update this validator in the same commit.
 */
function isValidHeartbeat(raw: unknown): raw is { type: 'heartbeat'; timestamp: number } {
  if (typeof raw !== 'object' || raw === null) return false;
  const msg = raw as Record<string, unknown>;
  return msg.type === 'heartbeat' && typeof msg.timestamp === 'number';
}

/** A log chunk as the handler passes it on. */
export interface AgentLogChunkInput {
  runId: string;
  jobId: string;
  stepIndex: number;
  lines: string[];
  timestamp: number;
  /** The stream the lines came from. */
  stream: LogStream;
}

/**
 * Passes a log chunk through its ownership gate to the sink, registering its
 * whole handling with the run's log drain first.
 *
 * An in-memory ownership miss (HA failover) is looked up in the database
 * before the chunk is accepted or refused, so post-failover and post-complete
 * chunks are benign duplicates, not drops — and the drain must know about the
 * chunk before the gate is awaited.
 */
function acceptLogChunk(
  deps: Pick<AgentWsHandlerDeps, 'onLogChunk' | 'trackLogChunk'>,
  agentId: string,
  chunk: AgentLogChunkInput,
  gate: () => Promise<OwnershipDecision>,
): Promise<void> {
  const handled = (async () => {
    // A refused frame carries no reply: the agent is not awaiting one.
    if ((await gate()) === 'reject') return;
    logger.debug('Log chunk received', {
      agentId,
      runId: chunk.runId,
      jobId: chunk.jobId,
      stepIndex: chunk.stepIndex,
      lineCount: chunk.lines.length,
    });
    await deps.onLogChunk?.(agentId, chunk);
  })();
  // fails-when: a drain that starts during the ownership lookup seals the run
  // without this chunk
  deps.trackLogChunk?.(chunk.runId, handled);
  return handled;
}

/**
 * Releases the in-memory waiters of jobs a disconnect triage failed (pending
 * builds, inits, dynamic evaluations, global eval rounds, user-cache refs) so
 * none hangs. Runs inside `onAgentDisconnect`, so every path that drops an
 * agent reaches it, whether or not it waits for the socket to close.
 */
export function releaseFailedJobWaiters(
  deps: Pick<
    AgentWsHandlerDeps,
    | 'pendingBuilds'
    | 'pendingInits'
    | 'pendingDynamics'
    | 'pendingGlobalEvals'
    | 'dispatchCacheRefs'
  >,
  failedJobIds: string[],
): void {
  const { pendingBuilds, pendingInits, pendingDynamics, pendingGlobalEvals, dispatchCacheRefs } =
    deps;
  if (pendingBuilds) {
    for (const jobId of failedJobIds) {
      pendingBuilds.cleanup(jobId);
    }
  }

  if (pendingInits) {
    for (const jobId of failedJobIds) {
      pendingInits.cleanup(jobId);
    }
  }

  if (pendingDynamics) {
    for (const jobId of failedJobIds) {
      pendingDynamics.cleanup(jobId);
    }
  }

  // Covers SCALER-MANAGED agents only, by design: for a static agent with
  // in-flight jobs, `startRecoveryForDisconnect` returns an empty list (it keeps
  // the jobs for reconnect reconciliation). Such a round settles via the
  // agent's terminal `job.status` on reconnect, or the round's own
  // `global_eval_wait_timeout_ms` ceiling.
  if (pendingGlobalEvals) {
    for (const jobId of failedJobIds) {
      pendingGlobalEvals.cleanup(jobId);
    }
  }

  if (dispatchCacheRefs) {
    for (const jobId of failedJobIds) {
      dispatchCacheRefs.delete(jobId);
    }
  }
}

/**
 * Create a Hono WS event handler for agent connections.
 *
 * Flow:
 * 1. onOpen: start the auth timer (token mode) or the register timer (see the
 *    file header for the phases and their timeouts)
 * 2. Pre-register onMessage: auth.request (token mode), then agent.register
 *    with labels and capacity; a scaler.claim-credentials self-bootstrap is
 *    answered in either phase
 * 3. Subsequent onMessage: validated against protocol schemas, routed by type
 * 4. onClose: cleanup from pending registration or dispatcher
 *
 * A frame whose handling fails is logged with its type and ids; the
 * connection stays open.
 */
export function createAgentWsHandler(deps: AgentWsHandlerDeps): AgentWsEvents {
  const {
    registry,
    dispatcher,
    tokenStore,
    agentAuthMode,
    onJobStatus,
    onStepStatus,
    onScalerAgentRegistered,
    onScalerAgentDisconnected,
    onScalerJobComplete,
    onJobHeartbeat,
    onAgentLog,
    onConfigAck,
    onEventEmit,
    onClaimCredentials,
    onRunEvent,
    onJobContext,
    sourceCache,
    depCache,
    userCache,
    artifactStore,
    dispatchCacheRefs,
    cacheStorage,
    cacheUploadSettle,
    provenanceTrustRoot,
    provenanceStorage,
    onProvenanceUpload,
    onProvenanceDefer,
    classifyDeferOrigin,
    rateLimiterConfig,
    ownershipTracker,
    onSecretOutputs,
    onConcurrencyReport,
    onStepApproval,
    onConcurrencyAgentDisconnect,
    agentMetricsAggregator,
  } = deps;

  dispatcher.setDisconnectCleanup?.((failedJobIds) => releaseFailedJobWaiters(deps, failedJobIds));

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
       * `agent_tokens.labels` at auth time. `null` = unscoped token (no label
       * constraint); `undefined` only in `none` auth mode. Wire labels outside
       * it close the WS with `WS_CLOSE_AGENT_AUTH_FAILED`
       * (`agent-handler.label-elevation.test.ts`).
       */
      tokenLabels?: string[] | null;
      /**
       * `mandatory_labels` at auth time; becomes the static agent's
       * `mandatoryLabels` taint. `null` = no taint; `undefined` only in `none`
       * auth mode.
       */
      tokenMandatoryLabels?: string[] | null;
      /**
       * `agent_type` at auth time, enforcing the single-use binding for
       * ephemeral tokens. Static tokens are intentionally N-use
       * (operator-issued shared PSK) and skip it. `undefined` in `none` auth
       * mode. See `agent-handler.token-single-use.test.ts`.
       */
      tokenAgentType?: string;
      /**
       * `created_by`. Ephemeral: the scaler-spawned agentId the token was
       * issued for, which the wire `agentId` MUST equal. Static: a free-form
       * creator label (e.g. `'cli:admin'`), not used for authorization.
       */
      tokenCreatedBy?: string | null;
      /**
       * `expires_at`; non-null only for ephemeral tokens. Schedules the
       * per-token kick (`AgentRegistry.scheduleExpiryKick`) that closes
       * in-flight WS when the TTL elapses — sister to the revoke kick.
       */
      tokenExpiresAt?: Date | null;
    }
  >();

  /**
   * Sockets parked inside the initial-registration await window — past
   * `pendingRegistration.delete(ws)` but not yet in `wsToAgentId`.
   *
   * The scaler notification is awaited before the registry write (a database
   * round trip on a non-spawning instance), and meanwhile the WS is in none of
   * the three maps `onClose` inspects. `onClose` marks this entry `closed`, and
   * the registration checks it before writing — otherwise it registers a dead
   * socket that never closes again, so the disconnect path (and a scaler
   * agent's instance teardown) never runs.
   */
  const registering = new Map<WSContext, { closed: boolean }>();

  /** Registered connections; keyed by Hono WSContext, unlike the registry's WsLike. */
  const wsToAgentId = new Map<WSContext, string>();

  /**
   * Token authority per socket, set when Phase 2's gates pass, so every
   * re-register re-runs the gates against the same authority. Empty when
   * `agentAuthMode === 'none'`.
   */
  const wsToAuthState = new Map<WSContext, AuthState>();

  /**
   * Retires the socket a reconnect just replaced.
   *
   * `AgentRegistry.register` rebinds the agent but leaves the old socket open.
   * A half-open ghost sits in CLOSE_WAIT until reaped; when it closes, `onClose`
   * would resolve it to the same agent id and tear down the *live*
   * registration (unregister, fail running jobs, destroy a scaler agent).
   */
  function retireSupersededSocket(agentId: string, supersededWs: WsLike | undefined): void {
    if (!supersededWs) return;
    const ghost = supersededWs as unknown as WSContext;
    wsToAgentId.delete(ghost);
    wsToAuthState.delete(ghost);
    rateLimiters.delete(ghost);
    logger.info('Closing socket superseded by an agent reconnect', { agentId });
    try {
      ghost.close(WS_CLOSE_SUPERSEDED_BY_RECONNECT, 'Superseded by reconnect');
    } catch (err) {
      // An already-dead socket throws on close; the maps are cleared either way.
      logger.debug('Superseded socket close failed', { agentId, error: toErrorMessage(err) });
    }
  }

  let noAuthWarningLogged = false;

  /**
   * Per-connection `${jobId}:${key} -> tempKey`: `cache.user.save.request`
   * stashes its presigned `.tmp-<uuid>` key, and `cache.user.save.complete`
   * reads it to commit that object. Cleared on disconnect.
   */
  const pendingUserCacheTempKeys = new Map<string, string>();

  function sendJson(ws: WSContext, data: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Holds a build's success until the cache publish its agent reported just
   * before has finished, bounded by the org's settle timeout: the pipeline
   * reads the published pointer as soon as the success is handled (here, or
   * from the shared job row on a sibling coordinator).
   */
  async function holdSuccessForCacheUpload(
    agentId: string,
    runId: string,
    jobId: string,
    orgId: string | undefined,
  ): Promise<void> {
    const { outcome, timeoutMs, waitedMs } = await awaitCacheUploadSettle(cacheUploadSettle, {
      jobId,
      orgId,
    });
    if (outcome === CacheUploadSettleOutcome.Settled) {
      logger.info('Build success waited for its cache upload to publish', {
        agentId,
        runId,
        jobId,
        waitedMs,
      });
    } else if (outcome === CacheUploadSettleOutcome.TimedOut) {
      logger.warn(
        'Cache upload did not publish within the settle timeout; releasing the build without it',
        { agentId, runId, jobId, timeoutMs },
      );
    }
  }

  /**
   * Redeems a single-use scaler claim code for ephemeral credentials and
   * replies on `ws`. Also used before registration (self-bootstrap), passing
   * an empty agent id: minting routes by the claim code. The claim code is a
   * secret and is never logged.
   */
  async function handleClaimCredentials(
    ws: WSContext,
    requestId: string,
    claimCode: string,
    agentId: string,
    onClaimCredentials: AgentWsHandlerDeps['onClaimCredentials'],
  ): Promise<void> {
    if (!onClaimCredentials) {
      logger.warn('scaler.claim-credentials received but event scaler not configured', {
        agentId,
      });
      sendJson(ws, {
        type: 'scaler.claim-credentials.response',
        requestId,
        error: 'Scaler credential claim not available',
      });
      return;
    }

    try {
      const result = await onClaimCredentials(agentId, claimCode);
      sendJson(ws, {
        type: 'scaler.claim-credentials.response',
        requestId,
        ...(result.credentials && { credentials: result.credentials }),
        ...(result.error && { error: result.error }),
      });
    } catch (err) {
      logger.error('Failed to process scaler.claim-credentials', {
        agentId,
        // The claim code is a single-use secret — never log it.
        error: toErrorMessage(err),
      });
      sendJson(ws, {
        type: 'scaler.claim-credentials.response',
        requestId,
        error: AgentWsInternalFailure.scalerClaimFailed,
      });
    }
  }

  /**
   * Resolves a job's user-cache namespace from the server-side tracker (NEVER
   * the wire). `null` for an unknown/cleaned-up job or a dispatch without
   * org/repo (e.g. a sourceless deploy): the cache fails closed and the caller
   * no-ops rather than ever crossing tenants.
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

  const events = {
    onOpen(_evt: Event, ws: WSContext) {
      rateLimiters.set(ws, new WsRateLimiter(rateLimiterConfig));

      if (agentAuthMode === 'token') {
        const timer = setTimeout(() => {
          logger.warn('Agent auth timeout, closing connection');
          pendingAuth.delete(ws);
          ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Auth timeout');
        }, AUTH_TIMEOUT_MS);

        pendingAuth.set(ws, { timer });
        logger.info('Agent WebSocket connection opened, awaiting auth.request');
      } else {
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
      let raw: unknown;
      try {
        const data = typeof evt.data === 'string' ? evt.data : String(evt.data);
        raw = JSON.parse(data);
      } catch {
        logger.warn('Malformed JSON received from agent, closing');
        ws.close(WS_CLOSE_INVALID_MESSAGE, 'Malformed JSON');
        return;
      }

      // Rate limit after parse, before schema validation.
      const rateLimiter = rateLimiters.get(ws);
      if (rateLimiter) {
        const messageSize = typeof evt.data === 'string' ? evt.data.length : 0;
        const isHeartbeat =
          raw !== null &&
          typeof raw === 'object' &&
          'type' in raw &&
          (raw as { type: unknown }).type === 'heartbeat';
        // A solicited fleet bundle chunk is exempt, like a heartbeat: the agent
        // streams ~113 KB frames up to `FLEET_MAX_LOG_BYTES` (50 MiB, 25× the
        // byte burst), and one throttled frame breaks ordering, failing any
        // collection over 2 MiB compressed. Only a chunk for a collection still
        // pending for THIS agent passes; a guessed, stale or peer's request id
        // is throttled, and the assembler caps what a solicited one delivers.
        const isSolicitedFleetChunk =
          raw !== null &&
          typeof raw === 'object' &&
          (raw as { type?: unknown }).type === 'fleet.bundle.chunk' &&
          typeof (raw as { requestId?: unknown }).requestId === 'string' &&
          deps.fleetAgentCollector !== undefined &&
          wsToAgentId.has(ws) &&
          deps.fleetAgentCollector.isPendingFor(
            (raw as { requestId: string }).requestId,
            wsToAgentId.get(ws)!,
          );
        const rlResult = rateLimiter.check(messageSize, isHeartbeat || isSolicitedFleetChunk);
        if (!rlResult.allowed) {
          if (rlResult.action === 'disconnect') {
            logger.warn('Rate limit disconnect', { reason: rlResult.reason });
            ws.close(WS_CLOSE_INVALID_MESSAGE, rlResult.reason ?? 'Rate limit exceeded');
            return;
          }
          // Warn and drop this message.
          sendJson(ws, { type: 'rate.limit.warning', retryAfterMs: rlResult.retryAfterMs });
          return;
        }
      }

      // -- Phase 1: Pending auth (token mode) --
      const authEntry = pendingAuth.get(ws);
      if (authEntry !== undefined) {
        // Self-bootstrap: the claim code is the authorization, so a fresh agent
        // may redeem it ahead of auth.request. The connection stays in
        // pendingAuth with its timer running, then authenticates with the
        // minted token below.
        const preAuth = agentToOrchestratorMessageSchema.safeParse(raw);
        if (preAuth.success && preAuth.data.type === 'scaler.claim-credentials') {
          await handleClaimCredentials(
            ws,
            preAuth.data.requestId,
            preAuth.data.claimCode,
            '',
            onClaimCredentials,
          );
          return;
        }

        clearTimeout(authEntry.timer);
        pendingAuth.delete(ws);

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

        // `agent_tokens.labels` is a JSON `string[]` (or `null` = unscoped).
        // Malformed JSON refuses auth: falling through to "unscoped" would be a
        // silent privilege escalation.
        let tokenLabels: string[] | null = null;
        if (tokenRow.labels !== null) {
          try {
            const parsedLabels: unknown = JSON.parse(tokenRow.labels);
            if (!Array.isArray(parsedLabels) || !parsedLabels.every((l) => typeof l === 'string')) {
              throw new Error('not a string[]');
            }
            // Folded so Gates 0 and 1 compare canonical labels.
            tokenLabels = canonicalizeLabels(parsedLabels);
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

        // `agent_tokens.mandatory_labels`: malformed JSON means "no taint", not
        // an auth failure. An absent taint grants no privilege (it only widens
        // which jobs the agent accepts), and the privileged-root selector stays
        // gated by the uid-0 check and the dispatch authorization chain.
        let tokenMandatoryLabels: string[] | null = null;
        if (tokenRow.mandatory_labels !== null) {
          try {
            const parsed: unknown = JSON.parse(tokenRow.mandatory_labels);
            if (Array.isArray(parsed) && parsed.every((l) => typeof l === 'string')) {
              tokenMandatoryLabels = canonicalizeLabels(parsed as string[]);
            }
          } catch {
            tokenMandatoryLabels = null;
          }
        }

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
          tokenMandatoryLabels,
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
        const parsed = agentToOrchestratorMessageSchema.safeParse(raw);

        // Self-bootstrap before registration (claim code = authorization). The
        // registration timer keeps running, so the connection stays bounded.
        if (parsed.success && parsed.data.type === 'scaler.claim-credentials') {
          await handleClaimCredentials(
            ws,
            parsed.data.requestId,
            parsed.data.claimCode,
            '',
            onClaimCredentials,
          );
          return;
        }

        // Auth disabled, but the agent has a token (a static `KICI_AGENT_TOKEN`
        // or one just minted by self-bootstrap). It cannot know the auth mode,
        // so it waits for `auth.success`; refusing would strand it in a
        // permanent reconnect loop. The reply grants nothing: no `AuthState`,
        // no token read, gates skipped as for any agent in this mode. The
        // registration timer keeps running.
        if (agentAuthMode === 'none' && parsed.success && parsed.data.type === 'auth.request') {
          sendJson(ws, { type: 'auth.success', connectionId: randomUUID() });
          return;
        }

        clearTimeout(regEntry.timer);
        pendingRegistration.delete(ws);

        if (!parsed.success || parsed.data.type !== 'agent.register') {
          logger.warn('First message after auth must be agent.register', {
            errors: parsed.success ? undefined : parsed.error.issues,
          });
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'First message must be agent.register');
          return;
        }

        const { agentId, labels, platform, arch, version, maxConcurrency } = parsed.data;

        // Four authorization gates run together: privileged-root honesty,
        // label-scope subset, ephemeral identity-binding, and static-token
        // agentId collision. Identical gates re-run on every subsequent
        // re-register on this WS (see `case 'agent.register'` in the post-register
        // switch) — `agent_tokens.labels` / `agent_type` / `created_by`
        // bound the connection's authority for its entire lifetime, not
        // just the first message after auth.
        const authStateForRegister: AuthState = {
          tokenId: regEntry.tokenId,
          tokenLabels: regEntry.tokenLabels,
          tokenMandatoryLabels: regEntry.tokenMandatoryLabels,
          tokenAgentType: regEntry.tokenAgentType,
          tokenCreatedBy: regEntry.tokenCreatedBy,
        };
        if (
          !enforceRegisterAuthGates(
            authStateForRegister,
            { agentId, labels, runningAsUid: parsed.data.runningAsUid },
            ws as unknown as WsLike,
            registry,
          )
        ) {
          return;
        }
        // Re-registers re-run the gates from this, without a token-store trip.
        wsToAuthState.set(ws, authStateForRegister);

        // Notify the scaler FIRST: its `mandatoryLabels` gate must be on the
        // AgentEntry before any queue drain sees it, or `dequeueForLabels` could
        // pull an off-gate job in the back-fill window.
        //
        // The await is a DB round trip on the adoption path.
        // `pendingRegistration.delete(ws)` above keeps a second register on
        // this socket out of the window; `registering` makes a mid-lookup close
        // visible.
        const registerState = { closed: false };
        registering.set(ws, registerState);
        registry.beginRegistering(agentId, ws as unknown as WsLike, regEntry.tokenId ?? null);
        let scalerInfo: { boundJobId?: string; mandatoryLabels: string[] } | null = null;
        let scalerLookupFailed = false;
        try {
          // Folded: the scaler's label sets are folded at config load, so
          // `Docker` must arrive as `docker` or it matches no pool.
          scalerInfo =
            (await onScalerAgentRegistered?.(agentId, canonicalizeLabels(labels))) ?? null;
        } catch (err) {
          // Registering without the spawn record would drop the agent's
          // `mandatoryLabels` gate for life, so an untainted job could land on
          // it. Refuse: the agent reconnects, costing one retry.
          scalerLookupFailed = true;
          logger.error('Scaler lookup failed during agent registration', {
            agentId,
            error: toErrorMessage(err),
          });
        } finally {
          registering.delete(ws);
          registry.endRegistering(agentId, ws as unknown as WsLike);
        }

        if (scalerLookupFailed) {
          wsToAuthState.delete(ws);
          ws.close(WS_CLOSE_INTERNAL_ERROR, 'Scaler state unavailable');
          return;
        }

        if (registerState.closed) {
          // The socket died mid-lookup; registering it would leave a dead WS
          // with no close event to remove it. Unwind, and hand the agent to the
          // scaler's disconnect path: the lookup may have adopted it, and that
          // bookkeeping tears the provisioned instance down.
          logger.info('Agent connection closed during registration', { agentId });
          wsToAuthState.delete(ws);
          if (scalerInfo !== null) {
            onScalerAgentDisconnected?.(agentId);
          }
          return;
        }

        const pendingDispatch = scalerInfo?.boundJobId != null;
        // A scaler-managed agent with no bound job was pre-spawned to wait for
        // work. It must not arm the short idle timer — see registerAckSchema.
        const warmPool = scalerInfo !== null && scalerInfo.boundJobId == null;

        // platform/arch default to linux/x64.
        const supersededWs = registry.register(
          agentId,
          ws as unknown as WsLike,
          canonicalizeLabels(labels),
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
            // For AgentRegistry.disconnectByTokenId(...) on revoke. Null in
            // `none` auth mode.
            tokenId: regEntry.tokenId ?? null,
            // The scaler's taint for a scaler-spawned agent, else the token's
            // `mandatory_labels`; an un-tainted static token leaves it undefined.
            mandatoryLabels:
              scalerInfo?.mandatoryLabels ?? authStateForRegister.tokenMandatoryLabels ?? undefined,
            // Single-use (destroyed on disconnect); disconnect triage keys off it.
            scalerManaged: scalerInfo !== null,
            // The roster's `lifecycle_class`. Null in `none` auth mode.
            tokenAgentType: toLifecycleClass(regEntry.tokenAgentType),
            // Shallow-merged into host_properties; agent keys win over operator keys.
            properties: parsed.data.properties,
          },
        );
        retireSupersededSocket(agentId, supersededWs);
        wsToAgentId.set(ws, agentId);

        // Per-token TTL kick (ephemeral only: static tokens have no
        // `expires_at`). Idempotent per tokenId, so a reconnect is a no-op.
        if (
          regEntry.tokenId !== undefined &&
          regEntry.tokenExpiresAt !== undefined &&
          regEntry.tokenExpiresAt !== null
        ) {
          registry.scheduleExpiryKick(regEntry.tokenId, regEntry.tokenExpiresAt);
        }

        // With pendingDispatch the agent suppresses its short
        // KICI_SCALER_IDLE_TIMEOUT: preparing dispatch.job can take seconds
        // (provider lookups, secret merging, upstream outputs), long enough for
        // the timer to kill the agent first.
        sendJson(ws, {
          type: 'register.ack',
          agentId,
          labels,
          scalerManaged: scalerInfo !== null,
          capabilities: ORCH_AGENT_CAPABILITIES,
          ...(pendingDispatch ? { pendingDispatch: true } : {}),
          ...(warmPool ? { warmPool: true } : {}),
        });

        setAgentsActive(registry.getActiveCount());

        logger.info('Agent registered', { agentId, labels });

        // A bootstrap token (`created_by: 'bootstrap:<targetAgentId>'`) is
        // consumed on first successful register, so a leaked one is inert.
        if (
          tokenStore &&
          regEntry.tokenId !== undefined &&
          regEntry.tokenCreatedBy?.startsWith(BOOTSTRAP_CREATED_BY_PREFIX)
        ) {
          await tokenStore.consumeBootstrapToken(regEntry.tokenId);
        }

        if (parsed.data.inFlightJobs && parsed.data.inFlightJobs.length > 0) {
          await reconcileInFlightJobs(
            agentId,
            parsed.data.inFlightJobs,
            dispatcher,
            registry,
            onJobStatus,
          );
        }

        // Eager dispatch: claim the scaler-bound job atomically before the
        // generic drain, closing the dispatch-vs-idle-timer race that made
        // scaler agents (notably Firecracker, ~2s VM boot) disconnect
        // mid-spawn under load.
        if (scalerInfo?.boundJobId) {
          const dispatched = await dispatcher.dispatchBoundJob(agentId, scalerInfo.boundJobId);
          if (!dispatched) {
            logger.warn('Bound job no longer dispatchable, falling back to queue drain', {
              agentId,
              boundJobId: scalerInfo.boundJobId,
            });
          }
        }

        // Down-then-up release: a rebooted static host returns on a fresh WS
        // (first-register path); clear reboot-pending before draining so the
        // held post-restart job is dispatched.
        await dispatcher.releaseRebootPending(agentId);

        // No-op if eager dispatch filled the agent's single slot.
        await dispatcher.onAgentAvailable(agentId);
        return;
      }

      // -- Registered: validate and route --
      const agentId = wsToAgentId.get(ws);
      if (!agentId) {
        if (registering.has(ws)) {
          // Mid-registration (parked in the scaler lookup): drop, never close
          // the socket the registration is about to complete.
          logger.warn('Message arrived while registration is in flight, dropping');
          return;
        }
        logger.warn('Message from unregistered connection, closing');
        ws.close(WS_CLOSE_INVALID_MESSAGE, 'Not registered');
        return;
      }

      // -- FAST PATH for high-frequency messages on authenticated connections --
      // Skip full Zod safeParse for log.chunk and heartbeat (most frequent message types).
      // These manual validators are kept in sync with their Zod schemas.

      if (isValidHeartbeat(raw)) {
        registry.updateHeartbeat(agentId);
        logger.debug('Agent heartbeat received', { agentId });
        return;
      }

      if (isValidLogChunk(raw)) {
        await acceptLogChunk(
          deps,
          agentId,
          {
            runId: raw.runId,
            jobId: raw.jobId,
            stepIndex: raw.stepIndex,
            lines: raw.lines,
            timestamp: raw.timestamp,
            stream: raw.stream,
          },
          () => gateOwnership(ownershipTracker, agentId, raw.jobId, 'log.chunk'),
        );
        return;
      }

      // RAW PATH: run.event and job.context are not in
      // agentToOrchestratorMessageSchema (the orchestrator enriches them with
      // orgId before forwarding). Always intercepted, even without callbacks,
      // to prevent Zod rejection.
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
          // Re-registration is a label/metadata refresh: it preserves the
          // mandatoryLabels gate (the scaler hook fires only on initial
          // registration), or a gated agent could accept off-gate jobs.
          //
          // Re-run the same authorization gates the first register ran, from
          // `wsToAuthState`. Without this, wire `msg.labels` / `msg.agentId`
          // would overwrite the registry entry,
          // collapsing the token-scope and identity-binding invariants.
          const reregisterAuthState = wsToAuthState.get(ws);
          if (
            !enforceRegisterAuthGates(
              reregisterAuthState,
              { agentId: msg.agentId, labels: msg.labels, runningAsUid: msg.runningAsUid },
              ws as unknown as WsLike,
              registry,
            )
          ) {
            return;
          }

          const existingEntry = registry.get(msg.agentId);
          const supersededWs = registry.register(
            msg.agentId,
            ws as unknown as WsLike,
            canonicalizeLabels(msg.labels),
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
              // Keep the token binding: revocation, expiry and the agent-id
              // collision check all read it from the registry entry.
              tokenId: reregisterAuthState?.tokenId ?? null,
              // Preserved so disconnect triage stays correct.
              scalerManaged: existingEntry?.scalerManaged ?? false,
              tokenAgentType:
                toLifecycleClass(reregisterAuthState?.tokenAgentType) ??
                existingEntry?.tokenAgentType ??
                null,
            },
          );
          retireSupersededSocket(msg.agentId, supersededWs);
          wsToAgentId.set(ws, msg.agentId);
          setAgentsActive(registry.getActiveCount());

          sendJson(ws, {
            type: 'register.ack',
            agentId: msg.agentId,
            labels: msg.labels,
            scalerManaged: false,
            capabilities: ORCH_AGENT_CAPABILITIES,
          });

          logger.info('Agent re-registered', {
            agentId: msg.agentId,
            labels: msg.labels,
          });

          if (msg.inFlightJobs && msg.inFlightJobs.length > 0) {
            await reconcileInFlightJobs(
              msg.agentId,
              msg.inFlightJobs,
              dispatcher,
              registry,
              onJobStatus,
            );
          }

          // Down-then-up release: clear reboot-pending BEFORE draining so the
          // held post-restart job is dispatched.
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
            // The registry's activeJobs is authoritative; the self-report lags
            // in-flight dispatches, and adopting it would re-open an occupied
            // slot (double dispatch). Persistent drift is a bug signal.
            if (msg.activeJobs !== entry.activeJobs) {
              logger.warn('Agent self-reported activeJobs disagrees with registry count', {
                agentId,
                reported: msg.activeJobs,
                tracked: entry.activeJobs,
              });
            }

            if (msg.memoryUsedMb !== undefined) entry.memoryUsedMb = msg.memoryUsedMb;
            if (msg.memoryAvailableMb !== undefined)
              entry.memoryAvailableMb = msg.memoryAvailableMb;
            if (msg.uptimeSeconds !== undefined) entry.uptimeSeconds = msg.uptimeSeconds;

            logger.debug('Agent status update', {
              agentId,
              activeJobs: msg.activeJobs,
            });

            // Zero running jobs lifts a busy-rejection hold. Only zero counts: a
            // one-job-at-a-time agent rejects busy with any job running,
            // whatever its maxConcurrency.
            // fails-when: the hold is never lifted — a busy-rejected agent
            // takes no work until BUSY_HOLD_MAX_MS passes.
            if (msg.activeJobs === 0) registry.clearBusyHeld(agentId);

            if (entry.activeJobs < entry.maxConcurrency) {
              await dispatcher.onAgentAvailable(agentId);
            }
          }
          break;
        }

        case 'job.status': {
          // A refused frame carries no reply: the agent is not awaiting one.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'job.status')) === 'reject'
          ) {
            break;
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
              // Disconnect triage now treats it as non-redispatchable (steps may
              // have side effects).
              dispatcher.markJobStarted(jobId);
              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.success:
            case ExecutionJobStatus.enum.failed:
            case ExecutionJobStatus.enum.cancelled: {
              // Fire-and-forget.
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

              dispatcher.onJobComplete(agentId, jobId);
              // Read before the ref is dropped: a build's success waits below
              // on its org's cache upload settle bound. Dropping the user-cache
              // namespace ref keeps the tracker from leaking (mirrors the
              // dispatcher's own per-job cleanup).
              const jobOrgId = dispatchCacheRefs?.get(jobId)?.orgId;
              dispatchCacheRefs?.delete(jobId);
              setAgentsActive(registry.getActiveCount());
              // A failed drain must not end this frame: the status below must
              // still reach the scaler and tracker, and the agent never resends
              // it. The periodic re-drive retries the queue later.
              try {
                await dispatcher.onAgentAvailable(agentId);
              } catch (err) {
                logger.error('Failed to drain the queue after a job finished', {
                  agentId,
                  runId,
                  jobId,
                  error: toErrorMessage(err),
                });
              }

              onScalerJobComplete?.(agentId);

              // A build's success releases its waiters (locally, and on a
              // sibling via the terminal job row), so it waits for the cache
              // publish first. The wait sits after onJobComplete: an idle
              // scaler agent shuts down seconds after its job, and a job still
              // tracked to it on disconnect is failed.
              if (state === ExecutionJobStatus.enum.success) {
                await holdSuccessForCacheUpload(agentId, runId, jobId, jobOrgId);
              }

              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.cancelling: {
              // Agent is running cancel hooks.
              onJobStatus?.(agentId, { runId, jobId, state, timestamp, data });
              break;
            }
            case ExecutionJobStatus.enum.pending:
            case ExecutionJobStatus.enum.queued:
            case ExecutionJobStatus.enum.skipped: {
              logger.debug('Job informational status', { agentId, runId, jobId, state });
              break;
            }
          }
          break;
        }

        case 'job.reject': {
          // A refused frame carries no reply: the agent is not awaiting one.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'job.reject')) === 'reject'
          ) {
            break;
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
          // A refused frame carries no reply: the agent is not awaiting one.
          if ((await gateOwnership(ownershipTracker, agentId, msg.jobId, 'job.ack')) === 'reject') {
            break;
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
          const { runId, jobId, stepIndex, lines, timestamp, stream } = msg;
          await acceptLogChunk(
            deps,
            agentId,
            { runId, jobId, stepIndex, lines, timestamp, stream },
            () => gateOwnership(ownershipTracker, agentId, jobId, 'log.chunk'),
          );
          break;
        }

        case 'step.status': {
          // A refused frame carries no reply: the agent is not awaiting one.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'step.status')) === 'reject'
          ) {
            break;
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
            concurrencyKind,
            groupId,
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
            concurrencyKind,
            groupId,
            logBytesStreamed,
          });
          break;
        }

        case 'step.approval-request': {
          // A refused frame carries no reply: the agent is not awaiting one.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'step.approval-request')) ===
            'reject'
          ) {
            break;
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

          // May last the whole approval window; the agent keeps heartbeating.
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
              // Raw exception logged only; the author gets a fixed reason (the
              // agent runs untrusted workflow code and persists whatever it
              // receives into the step's logs).
              logger.error('Step approval bridge rejected', {
                agentId,
                runId,
                jobId,
                stepIndex,
                error: toErrorMessage(err),
              });
              sendJson(ws, {
                type: 'step.approval-resolved',
                requestId: messageId,
                runId,
                jobId,
                stepIndex,
                outcome: 'rejected',
                reason: AgentWsInternalFailure.approvalFailed,
              });
            },
          );
          break;
        }

        case 'job.heartbeat': {
          // A refused frame carries no reply: the agent is not awaiting one.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'job.heartbeat')) ===
            'reject'
          ) {
            break;
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
          // A refused request still gets a reply (an empty upload URL, as for an
          // unconfigured cache) so the agent skips instead of waiting out its
          // deadline.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'cache.upload.request')) ===
            'reject'
          ) {
            sendJson(ws, {
              type: 'cache.upload.response',
              requestId: msg.messageId,
              uploadUrl: '',
            });
            break;
          }

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
              // Org from the server-side dispatch ref, NEVER the body: an agent
              // can name a job it owns, never the storage prefix it writes to.
              const orgId = dispatchCacheRefs?.get(msg.jobId)?.orgId;
              if (!orgId) {
                logger.warn('cache.upload.request for source with no dispatch org', {
                  agentId,
                  jobId: msg.jobId,
                });
                sendJson(ws, {
                  type: 'cache.upload.response',
                  requestId: msg.messageId,
                  uploadUrl: '',
                });
                break;
              }
              // Content-addressed by its own digest.
              uploadUrl = await sourceCache.getUploadUrl(orgId, msg.sourceTarDigest);
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
              // Content-addressed by its own hash.
              uploadUrl = await depCache.getUploadUrl(msg.depsHash, msg.platform, msg.arch);
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
          // Registered before the first await: frames enter in wire order, so
          // the `job.status success` sent right after always finds it.
          const settleUpload = cacheUploadSettle?.uploads.begin(msg.jobId);
          // Read before any await: the build's success deletes the job's ref.
          const uploadOrgId = dispatchCacheRefs?.get(msg.jobId)?.orgId;
          try {
            // No reply exists, so a refusal is a drop — but still resolved.
            if (
              (await gateOwnership(
                ownershipTracker,
                agentId,
                msg.jobId,
                'cache.upload.complete',
              )) === 'reject'
            ) {
              break;
            }

            // Must equal the key the upload-URL branch signed, or initMeta
            // stamps TTL bookkeeping onto an object that does not exist.
            const storageKey =
              msg.cacheType === 'source'
                ? sourceTarballKey(uploadOrgId ?? '', msg.sourceTarDigest)
                : depTarballKey(msg.depsHash, msg.platform, msg.arch);

            if (cacheStorage) {
              try {
                await cacheStorage.initMeta(storageKey);
                // Pointer published only after the upload landed, or a reader
                // could resolve a lockfile to bytes not there yet.
                if (msg.cacheType === 'deps' && msg.lockfileHash && depCache) {
                  await depCache.publishPointer(
                    msg.lockfileHash,
                    msg.platform,
                    msg.arch,
                    msg.depsHash,
                    msg.siblingsDigest,
                  );
                }
                if (msg.cacheType === 'source' && msg.contentHash && uploadOrgId && sourceCache) {
                  await sourceCache.publishPointer(
                    uploadOrgId,
                    msg.contentHash,
                    msg.sourceTarDigest,
                  );
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
          } finally {
            settleUpload?.();
          }
          break;
        }

        case 'cache.user.restore.request': {
          // A refused restore replies with a miss (as for an unresolvable job)
          // so the agent proceeds without a cache instead of waiting.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'cache.user.restore.request',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'cache.user.restore.response',
              requestId: msg.messageId,
              hit: false,
            });
            break;
          }
          // Namespace resolved server-side; missing userCache or an unresolvable
          // jobId fail closed to a miss, never a cross-tenant read.
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
          // A refused save replies skip (as for an unresolvable job) so the
          // agent abandons the upload instead of hanging.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'cache.user.save.request',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'cache.user.save.response',
              requestId: msg.messageId,
              skip: true,
            });
            break;
          }
          const ref = userCache ? resolveUserCacheRef(msg.jobId) : null;
          if (!userCache || !ref) {
            if (userCache && !ref) {
              logger.warn('user-cache save for unresolvable job, replying skip', {
                agentId,
                jobId: msg.jobId,
              });
            }
            // Fail closed: skip, no presigned URL.
            sendJson(ws, {
              type: 'cache.user.save.response',
              requestId: msg.messageId,
              skip: true,
            });
            break;
          }
          try {
            const begin = await userCache.beginSave({ ...ref, key: msg.key });
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
          // No reply exists, so a refusal is a drop — but still resolved.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'cache.user.save.complete',
            )) === 'reject'
          ) {
            break;
          }
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

        case 'artifacts.upload.request': {
          // A refused request is answered, never dropped: the agent awaits this
          // reply and would otherwise burn its whole retry budget on silence.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'artifacts.upload.request',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'artifacts.upload.response',
              requestId: msg.messageId,
              outcome: ArtifactUploadOutcome.enum.rejected,
              error: OWNERSHIP_REFUSED,
            });
            break;
          }
          const ref = artifactStore ? resolveUserCacheRef(msg.jobId) : null;
          if (!artifactStore || !ref || !ref.runId) {
            // Internal failure: free-text `error`, NO enforcement `reason` — an
            // "over quota" for a misconfigured orchestrator would send the
            // author deleting artifacts that were never the problem.
            const error = !artifactStore
              ? ArtifactInternalFailure.uploadNotConfigured
              : ArtifactInternalFailure.unresolvableRun;
            if (artifactStore && (!ref || !ref.runId)) {
              logger.warn('artifact upload for unresolvable job, rejecting', {
                agentId,
                jobId: msg.jobId,
              });
            }
            sendJson(ws, {
              type: 'artifacts.upload.response',
              requestId: msg.messageId,
              outcome: ArtifactUploadOutcome.enum.rejected,
              error,
            });
            break;
          }
          try {
            const result = await artifactStore.beginUpload({
              customerId: ref.org,
              runId: ref.runId,
              name: msg.name,
              declaredSizeBytes: msg.declaredSizeBytes,
            });
            sendJson(ws, {
              type: 'artifacts.upload.response',
              requestId: msg.messageId,
              outcome: result.outcome,
              ...(result.uploadUrl && { uploadUrl: result.uploadUrl }),
              ...(result.storageKey && { storageKey: result.storageKey }),
              ...(result.reason && { reason: result.reason }),
              // A store rejection without an enforcement reason (an invalid
              // name) travels as free text.
              ...(result.error && { error: result.error }),
            });
          } catch (err) {
            logger.error('artifact begin-upload failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            // The author gets only the safe literal.
            sendJson(ws, {
              type: 'artifacts.upload.response',
              requestId: msg.messageId,
              outcome: ArtifactUploadOutcome.enum.rejected,
              error: ArtifactInternalFailure.uploadFailed,
            });
          }
          break;
        }

        case 'artifacts.upload.complete': {
          // Every path below sends exactly one ack: the agent awaits it, and a
          // failed commit must fail the step, not leave a green run with no
          // artifact.
          const sendCompleteAck = (outcome: ArtifactCompleteAckOutcome, reason?: string): void => {
            sendJson(ws, {
              type: 'artifacts.upload.complete.ack',
              requestId: msg.messageId,
              outcome,
              ...(reason ? { reason } : {}),
            });
          };

          // Ownership is fully resolved (the DB decides on a coordinator
          // failover) and a refusal is acknowledged, never dropped.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'artifacts.upload.complete',
            )) === 'reject'
          ) {
            sendCompleteAck(ArtifactCompleteAckOutcome.enum.failed, OWNERSHIP_REFUSED);
            break;
          }
          const ref = artifactStore ? resolveUserCacheRef(msg.jobId) : null;
          if (!artifactStore || !ref || !ref.runId) {
            if (artifactStore && (!ref || !ref.runId)) {
              logger.warn('artifact upload.complete for unresolvable job, dropping', {
                agentId,
                jobId: msg.jobId,
              });
            }
            sendCompleteAck(
              ArtifactCompleteAckOutcome.enum.failed,
              !artifactStore
                ? ArtifactInternalFailure.uploadNotConfigured
                : ArtifactInternalFailure.unresolvableRun,
            );
            break;
          }
          try {
            await completeUploadWithRetry(artifactStore, {
              customerId: ref.org,
              runId: ref.runId,
              jobId: msg.jobId,
              name: msg.name,
              sha256: msg.sha256,
            });
            sendCompleteAck(ArtifactCompleteAckOutcome.enum.committed);
          } catch (err) {
            logger.error('artifact upload-complete failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            // The author gets only the classified safe literal.
            sendCompleteAck(
              ArtifactCompleteAckOutcome.enum.failed,
              classifyArtifactCommitFailure(err),
            );
          }
          break;
        }

        case 'artifacts.download.request': {
          // A refused download is answered, never dropped: `not_found` is the
          // only outcome this reply allows, and the free-text error says why.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'artifacts.download.request',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'artifacts.download.response',
              requestId: msg.messageId,
              outcome: ArtifactDownloadOutcome.enum.not_found,
              error: OWNERSHIP_REFUSED,
            });
            break;
          }
          const ref = artifactStore ? resolveUserCacheRef(msg.jobId) : null;
          if (!artifactStore || !ref || !ref.runId) {
            // The free-text `error` separates "does not exist" from "could not
            // look it up", since `not_found` is the only allowed outcome.
            const error = !artifactStore
              ? ArtifactInternalFailure.downloadNotConfigured
              : ArtifactInternalFailure.unresolvableRun;
            if (artifactStore && (!ref || !ref.runId)) {
              logger.warn('artifact download for unresolvable job, replying not_found', {
                agentId,
                jobId: msg.jobId,
              });
            }
            sendJson(ws, {
              type: 'artifacts.download.response',
              requestId: msg.messageId,
              outcome: ArtifactDownloadOutcome.enum.not_found,
              error,
            });
            break;
          }
          try {
            const result = await artifactStore.download({
              customerId: ref.org,
              runId: ref.runId,
              name: msg.name,
            });
            sendJson(ws, {
              type: 'artifacts.download.response',
              requestId: msg.messageId,
              outcome: result.outcome,
              ...(result.downloadUrl && { downloadUrl: result.downloadUrl }),
              ...(result.sizeBytes !== undefined && { sizeBytes: result.sizeBytes }),
              ...(result.sha256 && { sha256: result.sha256 }),
            });
          } catch (err) {
            logger.error('artifact download failed', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
            // The author gets only the safe literal.
            sendJson(ws, {
              type: 'artifacts.download.response',
              requestId: msg.messageId,
              outcome: ArtifactDownloadOutcome.enum.not_found,
              error: ArtifactInternalFailure.downloadFailed,
            });
          }
          break;
        }

        case 'provenance.upload.request': {
          // A refused request still gets a reply: an empty upload URL.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'provenance.upload.request',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'provenance.upload.response',
              requestId: msg.messageId,
              uploadUrl: '',
            });
            break;
          }

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
          // No reply exists, so a refusal is a drop — but still resolved.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'provenance.upload.complete',
            )) === 'reject'
          ) {
            break;
          }

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
            // A presigned PUT writes no metadata sidecar, and `CacheStorage.get`
            // reads a metadata-less object as missing; written here (as in
            // `cache.upload.complete`) so the dashboard can inline the bundle.
            if (provenanceStorage) {
              await provenanceStorage.initMeta(storageKey);
            }
            // Verify-at-ingest: fails closed to `unverifiable`, never blocks.
            const verdict = await computeAttestationVerdict({
              trustRoot: provenanceTrustRoot,
              storage: provenanceStorage,
              storageKey,
              logWarn: (reason) =>
                logger.warn('Attestation verify-at-ingest failed', { jobId: msg.jobId, reason }),
            });
            await onProvenanceUpload({
              runId: ref.runId,
              jobId: msg.jobId,
              subjectName: msg.subjectName,
              subjectDigest: msg.subjectDigest,
              storageKey,
              mediaType: msg.mediaType,
              verifyStatus: verdict.verifyStatus,
              verifyReason: verdict.verifyReason,
              verifiedAt: verdict.verifiedAt,
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

        case 'provenance.upload.defer': {
          // No reply exists, so a refusal is a drop — but still resolved.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'provenance.upload.defer',
            )) === 'reject'
          ) {
            break;
          }

          const ref = dispatchCacheRefs?.get(msg.jobId);
          if (!onProvenanceDefer || !ref) {
            if (onProvenanceDefer && !ref) {
              logger.warn('provenance defer for unresolvable job, dropping', {
                agentId,
                jobId: msg.jobId,
              });
            }
            break;
          }
          try {
            // Default a live run whose mint blipped to `deferred`; a run ingested
            // while the Platform was down classifies as `offline-backfill`.
            const originKind = classifyDeferOrigin
              ? await classifyDeferOrigin(ref.runId)
              : 'deferred';
            await onProvenanceDefer({
              runId: ref.runId,
              jobId: msg.jobId,
              subjectName: msg.subjectName,
              subjectDigest: msg.subjectDigest,
              audience: msg.audience,
              mediaType: msg.mediaType,
              statementHash: msg.statementHash,
              dsseEnvelope: msg.dsseEnvelope,
              publicKey: msg.publicKey,
              originKind,
            });
            logger.info('Deferred attestation captured', {
              agentId,
              jobId: msg.jobId,
              originKind,
            });
          } catch (err) {
            logger.error('Failed to capture deferred attestation', {
              agentId,
              jobId: msg.jobId,
              error: toErrorMessage(err),
            });
          }
          break;
        }

        case 'job.concurrency.report': {
          // A refused report is answered with `cancel`: never proceed on a job
          // the agent does not own, never park forever awaiting an ack.
          if (
            (await gateOwnership(
              ownershipTracker,
              agentId,
              msg.jobId,
              'job.concurrency.report',
            )) === 'reject'
          ) {
            sendJson(ws, {
              type: 'job.concurrency.ack',
              requestId: msg.messageId,
              action: 'cancel',
              reason: OWNERSHIP_REFUSED,
            });
            break;
          }

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

            // On `wait` the agent long-polls for a follow-up `concurrency.ack`.
            // Do NOT release the dispatcher slot: the runner holds the agent's
            // capacity until a slot frees (tryDispatchNextQueued) or the
            // connection drops (the tracker cancels the queued row).
          } else {
            // Concurrency disabled: proceed.
            sendJson(ws, {
              type: 'job.concurrency.ack',
              requestId: messageId,
              action: 'proceed',
            });
          }
          break;
        }

        case 'event.emit': {
          // A refused emit is answered; a drop stalls the step to its deadline.
          if (
            (await gateOwnership(ownershipTracker, agentId, msg.jobId, 'event.emit')) === 'reject'
          ) {
            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              error: OWNERSHIP_REFUSED,
            });
            break;
          }

          // Authoritative forgery guard (the SDK check is client-side only):
          // `kici.` is reserved for KiCI system events (event scaler scale-up /
          // scale-down), `__` for events the orchestrator mints itself.
          //
          // `__` is a privilege boundary: its names are exempt from the
          // event-storm rate limiter, and `__schedule_fire` also dispatches as
          // a TRUSTED ref. Lifecycle names inherit their run's tier, so
          // emitting one forges only the exemption — still worth holding.
          const reservedPrefix = reservedEventNamePrefix(msg.eventName);
          if (reservedPrefix) {
            logger.warn('event.emit rejected: reserved event-name prefix', {
              agentId,
              eventName: msg.eventName,
              reservedPrefix,
            });
            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              error: `event name prefix "${reservedPrefix}" is reserved for KiCI internal events`,
            });
            break;
          }

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
            // The author gets a fixed error; an author-actionable failure rides
            // the callback's return value instead.
            sendJson(ws, {
              type: 'event.emit.response',
              requestId: msg.requestId,
              error: AgentWsInternalFailure.eventEmitFailed,
            });
          }
          break;
        }

        case 'scaler.claim-credentials': {
          await handleClaimCredentials(
            ws,
            msg.requestId,
            msg.claimCode,
            agentId,
            onClaimCredentials,
          );
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
            // Read AND write: write methods only affect the caller's own host
            // (e.g. host.requestReboot), so there is no cross-agent escalation.
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
            // The registry's typed rejections name only the caller's method and
            // roles, so they pass through. Any other text can carry
            // infrastructure detail and gets a fixed error. The gate is the
            // error's type, never its wording.
            const deliberate =
              err instanceof UnknownApiMethodError || err instanceof ApiRoleDeniedError;
            sendJson(ws, {
              type: 'agent.api.response',
              requestId: msg.requestId,
              error: deliberate ? err.message : AgentWsInternalFailure.agentApiFailed,
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
      rateLimiters.delete(ws);

      const authEntry = pendingAuth.get(ws);
      if (authEntry !== undefined) {
        clearTimeout(authEntry.timer);
        pendingAuth.delete(ws);
        logger.info('Agent connection closed before auth');
        return;
      }

      const regEntry = pendingRegistration.get(ws);
      if (regEntry !== undefined) {
        clearTimeout(regEntry.timer);
        pendingRegistration.delete(ws);
        logger.info('Agent connection closed before registration');
        return;
      }

      // Closed inside the registration await window (in neither map above):
      // flag it; the registration reads the flag before writing and unwinds
      // itself, the only cleanup possible with no registry entry yet.
      const registeringState = registering.get(ws);
      if (registeringState !== undefined) {
        registeringState.closed = true;
        logger.info('Agent connection closed during registration');
        return;
      }

      const agentId = wsToAgentId.get(ws);
      if (agentId) {
        // Act only when this socket is the one the registry holds: a stale
        // socket's close (a reconnect raced it) would otherwise tear down the
        // healthy agent. Guards a close that beats `retireSupersededSocket`.
        const live = registry.get(agentId);
        if (live !== undefined && live.ws !== (ws as unknown as WsLike)) {
          wsToAgentId.delete(ws);
          wsToAuthState.delete(ws);
          logger.info('Stale agent socket closed, live registration untouched', { agentId });
          return;
        }
        // No registration: a heartbeat timeout, dispatch-ack timeout, or token
        // revocation/expiry already dropped the agent and ran the job triage
        // (which needs the registration, so it cannot run here). This close
        // still owns the rest, so a scaler agent's VM or container is destroyed.
        const unregistered = live === undefined;
        // Unless the agent re-registers on a newer socket, which now owns it.
        if (unregistered && registry.isRegisteringElsewhere(agentId, ws as unknown as WsLike)) {
          wsToAgentId.delete(ws);
          wsToAuthState.delete(ws);
          logger.info('Dropped agent socket closed while the agent re-registers', { agentId });
          return;
        }
        wsToAgentId.delete(ws);
        wsToAuthState.delete(ws);

        ownershipTracker?.cleanup(agentId);

        deps.fleetAgentCollector?.rejectAgent(agentId, 'agent disconnected');

        // Cancels the agent's `concurrency_groups.status='queued'` rows so the
        // run fails instead of sitting forever.
        if (onConcurrencyAgentDisconnect) {
          Promise.resolve(onConcurrencyAgentDisconnect(agentId)).catch((err) => {
            logger.warn('Concurrency waiter cleanup failed on agent disconnect', {
              agentId,
              error: toErrorMessage(err),
            });
          });
        }

        // Fails dispatched jobs, unregisters, and releases their waiters via
        // the installed `releaseFailedJobWaiters`.
        const triage = unregistered
          ? Promise.resolve<string[]>([])
          : dispatcher.onAgentDisconnect(agentId);
        triage.catch((err) => {
          logger.error('Error handling agent disconnect', {
            agentId,
            error: toErrorMessage(err),
          });
        });

        agentMetricsAggregator?.markDisconnected(agentId);

        // An agent dropped without waiting for its socket is torn down as a
        // `heartbeat-timeout`, the reason the stranded-provision sweep emits
        // and a customer's teardown workflow may branch on.
        if (unregistered) {
          onScalerAgentDisconnected?.(agentId, ScaleDownReason.enum['heartbeat-timeout']);
        } else {
          onScalerAgentDisconnected?.(agentId);
        }

        // An agent already unregistered is no longer in the count.
        setAgentsActive(Math.max(0, registry.getActiveCount() - (unregistered ? 0 : 1)));

        logger.info('Agent disconnected', { agentId, ...(unregistered && { unregistered }) });
      }
    },

    onError(_evt: Event, _ws: WSContext) {
      logger.error('Agent WebSocket error');
    },
  } satisfies AgentWsEvents;

  return {
    ...events,
    // The WebSocket server discards the promise, so failures are logged here
    // and the connection stays open; an unhandled rejection would stop the
    // orchestrator (its shutdown hook treats one as fatal).
    onMessage: (evt, ws) =>
      events.onMessage(evt, ws).catch((err: unknown) => {
        const identity = frameIdentity(evt.data);
        logger.error('Failed to handle an agent message', {
          ...identity,
          agentId: wsToAgentId.get(ws) ?? identity.agentId,
          error: toErrorMessage(err),
        });
        // A connection in no state failed between two (e.g. on a token-store
        // query); no timer will close it, so close with the retryable
        // internal-error code and let the agent reconnect.
        if (
          !wsToAgentId.has(ws) &&
          !pendingAuth.has(ws) &&
          !pendingRegistration.has(ws) &&
          !registering.has(ws)
        ) {
          try {
            ws.close(WS_CLOSE_INTERNAL_ERROR, 'Internal error');
          } catch (closeErr) {
            logger.debug('Closing a failed connection failed', {
              error: toErrorMessage(closeErr),
            });
          }
        }
      }),
  };
}
