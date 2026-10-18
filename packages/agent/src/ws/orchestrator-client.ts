import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';
import WebSocket from 'ws';
import { createLogger, getReconnectDelay, toErrorMessage, chunkBuffer } from '@kici-dev/shared';
import {
  deriveOsArchLabels,
  hostLabel,
  mergeAutoLabels,
  resolveRoleLabels,
} from '@kici-dev/engine';
import { runtimeFactLabels } from '../execution/image-build/runtime-facts.js';
import {
  AGENT_API_REQUEST_TIMEOUT_MS,
  orchestratorToAgentMessageSchema,
  heartbeatSchema,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  WS_CLOSE_AGENT_AUTH_FAILED,
  type AgentToOrchestratorMessage,
  type OrchestratorToAgentMessage,
  type JobDispatch,
  type JobCancel,
  type FleetLogsRequest,
  ArtifactCompleteAckOutcome,
  AGENT_CAPABILITIES,
  AGENT_FEATURE_LABELS,
  ExecutionJobStatus,
  type OrchAgentCapabilities,
} from '@kici-dev/engine';
import type {
  CacheRequestIpc,
  CacheResponseIpc,
  ProvenanceRequestIpc,
  ArtifactRequestIpc,
  ArtifactResponseIpc,
  ProvenanceResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
} from '../execution/sandbox/index.js';
import { buildAgentMiniBundle } from '../diagnostics/mini-bundle.js';
import { readAgentVersion } from '../version.js';
import { EventBuffer } from './event-buffer.js';
import { LogBuffer } from './log-buffer.js';

const logger = createLogger({ prefix: 'orchestrator-client' });

/**
 * Wait for `artifacts.upload.complete.ack` before failing the step. Shorter than
 * the sandbox's 30s artifact-request timeout (`CACHE_RESPONSE_TIMEOUT_MS`) so a
 * lost ack surfaces this reason, not the sandbox's generic timeout; the
 * orchestrator's bounded commit retry finishes well under a second.
 */
const ARTIFACT_COMPLETE_ACK_TIMEOUT_MS = 25_000;

/**
 * Re-sends of an in-flight `artifacts.upload.complete` across reconnects before
 * the step fails, bounded so a flapping connection cannot loop forever.
 * ARTIFACT_COMPLETE_ACK_TIMEOUT_MS bounds the overall wait independently; its
 * timer never restarts across a hold or a resend.
 */
export const MAX_COMPLETE_RESEND_ATTEMPTS = 2;

/**
 * Tail of both give-up messages for an unacknowledged commit: the orchestrator
 * may have committed the artifact and lost only the ack, so the operator must
 * not hunt for a lost artifact.
 */
const COMMIT_MAY_HAVE_LANDED = 'the artifact may have been committed';

/**
 * An `artifacts.upload.complete` awaiting its ack, shared by reference between
 * `pendingUserArtifactRequests`, `resendableCompletes`, `heldCompletes` and the
 * ack timer's closure. `messageId` changes on every resend and is the single
 * source of truth for the pending's current key, so the timer never cleans up a
 * stale pre-resend key.
 */
interface InFlightComplete {
  messageId: string;
  /** The frame to (re-)send, carrying the current `messageId`. */
  frame: AgentToOrchestratorMessage;
  /** Re-sends so far. */
  attempts: number;
  pending: {
    resolve: (response: ArtifactResponseIpc) => void;
    reject: (err: Error) => void;
  };
}

export type ConnectionState =
  'disconnected' | 'connecting' | 'authenticating' | 'registering' | 'registered';

export interface OrchestratorClientOptions {
  url: string;
  agentId: string;
  /** Labels for job routing. */
  labels: string[];
  /**
   * Typed host-vars (the `KICI_PROPERTIES` bag), reported at registration and
   * shallow-merged into the orchestrator's host roster.
   */
  properties?: Record<string, string | number | boolean>;
  onJobDispatch: (dispatch: JobDispatch) => void;
  onJobCancel: (cancel: JobCancel) => void;
  /** Agent authentication token (kat_ prefixed). When provided, sends auth.request before agent.register. */
  token?: string;
  /**
   * Self-bootstrap claim code, ignored when a static `token` is present. On WS
   * open, before any auth / register, the client exchanges it via
   * `scaler.claim-credentials` and adopts the minted token, agentId and labels.
   * A rejected or expired code fails permanently (no reconnect).
   */
  scalerClaimCode?: string;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Maximum reconnect delay in ms. Default: 60000 (60s). */
  maxReconnectDelayMs?: number;
  /** Maximum event buffer size. Default: 5000. */
  maxBufferSize?: number;
  /** Maximum log buffer lines for agent.log during disconnection. Default: 10000. */
  maxLogBufferLines?: number;
  /** Callback to retrieve in-flight jobs for reconnection reporting. */
  getInFlightJobs?: () => Array<{ jobId: string; runId: string }>;
  /** Agent roles. undefined = all, [] = execution only. Used to derive kici:role:* auto-labels. */
  roles?: string[];
  /**
   * Spawned by the orchestrator's auto-scaler: KICI_SCALER_MANAGED=1 from
   * config, passed in so the client never reads process.env.
   */
  scalerManaged?: boolean;
  /**
   * Inputs for the fleet mini-bundle on a fleet.logs.request: the resolved
   * config (the bundle assembler redacts it), the log directory and the current
   * Prometheus metrics text. When omitted, the handler replies with an
   * empty-config bundle.
   */
  getFleetBundleInputs?: () => Promise<{
    config: Record<string, unknown>;
    logDir?: string;
    metricsText?: string;
  }>;
}

/**
 * Adapts a frame to what the receiving orchestrator settles. An orchestrator
 * without `acceptsSkippedJobStatus` drops a `skipped` job status, so the job
 * would never settle: it gets `success` with no `data.error`, the frame an
 * agent sent for a rule-skipped job before the capability existed.
 */
export function adaptJobStatusForOrchestrator(
  message: AgentToOrchestratorMessage,
  caps: OrchAgentCapabilities,
): AgentToOrchestratorMessage {
  if (
    message.type !== 'job.status' ||
    message.state !== ExecutionJobStatus.enum.skipped ||
    caps.acceptsSkippedJobStatus === true
  ) {
    return message;
  }
  const adapted = { ...message, state: ExecutionJobStatus.enum.success };
  if (message.data) {
    const { error: _error, ...data } = message.data;
    adapted.data = data;
  }
  return adapted;
}

/**
 * WebSocket client from the agent to the customer orchestrator: registration
 * handshake, heartbeats, auto-reconnect with exponential backoff (1s initial,
 * 1.5x, jitter, 60s max), job dispatch / cancel routing, and event buffering
 * while disconnected with flush on reconnect. Mirrors PlatformClient in
 * packages/orchestrator for the agent-to-orchestrator direction.
 */
export class OrchestratorClient {
  private ws: WebSocket | null = null;
  /**
   * The current connection's `register.ack` capabilities. Empty until the ack,
   * so a frame sent on a socket that has not acked is judged conservatively.
   */
  private orchCapabilities: OrchAgentCapabilities = {};
  private _state: ConnectionState = 'disconnected';
  private readonly eventBuffer: EventBuffer;
  private readonly logBuffer: LogBuffer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;

  // Log batching: accumulate lines and flush every 100ms or 50 lines
  private pendingLogBatch: string[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOG_BATCH_SIZE = 50;
  private static readonly LOG_FLUSH_INTERVAL_MS = 100;

  private readonly pendingUploadRequests = new Map<
    string,
    {
      resolve: (url: string) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingEventEmitRequests = new Map<
    string,
    {
      resolve: (response: { requestId: string; deliveryId?: string; error?: string }) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingApiRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingClaimCredentialsRequests = new Map<
    string,
    {
      resolve: (response: {
        credentials?: {
          agentToken: string;
          agentId: string;
          orchestratorUrl: string;
          labels: string[];
        };
        error?: string;
      }) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingUserCacheRequests = new Map<
    string,
    {
      resolve: (response: CacheResponseIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingUserArtifactRequests = new Map<
    string,
    {
      resolve: (response: ArtifactResponseIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * In-flight `artifacts.upload.complete` frames safe to re-send after a
   * reconnect, keyed by current `messageId`. The commit is idempotent
   * server-side (server-derived storage key, re-writable `initMeta` sidecar,
   * `onConflict.doNothing()` insert), so a dropped ack means "not heard", not
   * "not done". `beginUpload` mints a presigned PUT and is not idempotent this
   * way, and `download` is read-only and cheap to fail, so neither is here.
   */
  private readonly resendableCompletes = new Map<string, InFlightComplete>();

  /**
   * Completes the disconnect sweep took off `pendingUserArtifactRequests`,
   * parked until the next `register.ack` re-sends them. Their ack timers keep
   * running: parking does not extend the deadline.
   */
  private readonly heldCompletes = new Set<InFlightComplete>();

  /**
   * No client-side timeout: the orchestrator owns the (org-/SDK-configured)
   * expiry and sends `step.approval-resolved: expired` when it lapses; the
   * workflow-runner carries an outer safety-net timeout.
   */
  private readonly pendingStepApprovals = new Map<
    string,
    {
      resolve: (response: StepApprovalResolvedIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly pendingConcurrencyRequests = new Map<
    string,
    {
      resolve: (ack: { action: 'proceed' | 'wait' | 'cancel'; reason?: string }) => void;
      reject: (err: Error) => void;
    }
  >();

  private readonly url: string;
  // Not readonly: a self-bootstrap claim exchange (scalerClaimCode) adopts the
  // minted agentId / labels / token before the first auth + register.
  private agentId: string;
  private labels: string[];
  private readonly properties: Record<string, string | number | boolean>;
  private readonly onJobDispatch: (dispatch: JobDispatch) => void;
  private readonly onJobCancel: (cancel: JobCancel) => void;
  private token?: string;
  private readonly scalerClaimCode?: string;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly getInFlightJobs?: () => Array<{ jobId: string; runId: string }>;
  private readonly roles: string[] | undefined;
  private readonly scalerManaged: boolean;
  private readonly getFleetBundleInputs?: () => Promise<{
    config: Record<string, unknown>;
    logDir?: string;
    metricsText?: string;
  }>;

  /** When the connection was lost, for the gap marker's outage duration. */
  private disconnectedAt: number | null = null;

  /** Set on auth.failure, so a bad token is never retried. */
  private authFailed = false;

  /**
   * Fires on every transition to 'registered', initial and after reconnect;
   * server.ts re-evaluates idle shutdown on it. `pendingDispatch`: the
   * orchestrator pre-bound a queued job to this agent and its dispatch.job is
   * in flight, so the agent defers arming the short scaler-idle timer.
   * `warmPool`: the agent was pre-spawned to wait for work, so it arms no idle
   * timer at all; the orchestrator's warm-pool reaper owns its lifetime.
   */
  onRegistered: ((info: { pendingDispatch: boolean; warmPool: boolean }) => void) | null = null;

  /**
   * Fires when a self-bootstrap claim exchange fails permanently (invalid /
   * expired / already-consumed code, or the exchange errored or timed out),
   * only in self-bootstrap mode (`scalerClaimCode` set, no static token). The
   * one-shot agent cannot progress after this, so server.ts wires it to a
   * non-zero graceful shutdown; otherwise the health HTTP server keeps the
   * process alive and a GitHub Actions run hangs until the job timeout.
   */
  onClaimFailedPermanently: ((reason: string) => void) | null = null;

  /**
   * Fires once when authentication fails permanently: an `auth.failure` frame,
   * or a close with WS_CLOSE_AGENT_AUTH_FAILED (a revoked token, or a protocol
   * version below the orchestrator's floor). The client never reconnects, so
   * server.ts wires it to a non-zero graceful shutdown; otherwise the health
   * HTTP server keeps alive a process that can never register, and a one-shot
   * GitHub Actions agent holds its runner until the job timeout.
   */
  onAuthFailedPermanently: ((reason: string) => void) | null = null;

  /** Marks the auth failure permanent and fires onAuthFailedPermanently exactly once. */
  private failAuthPermanently(reason: string): void {
    const first = !this.authFailed;
    this.authFailed = true;
    this.intentionalDisconnect = true;
    if (first) this.onAuthFailedPermanently?.(reason);
  }

  constructor(options: OrchestratorClientOptions) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.labels = options.labels;
    this.properties = options.properties ?? {};
    this.onJobDispatch = options.onJobDispatch;
    this.onJobCancel = options.onJobCancel;
    this.token = options.token;
    this.scalerClaimCode = options.scalerClaimCode;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.getInFlightJobs = options.getInFlightJobs;
    this.roles = options.roles;
    this.scalerManaged = options.scalerManaged ?? false;
    this.getFleetBundleInputs = options.getFleetBundleInputs;
    this.eventBuffer = new EventBuffer({ maxSize: options.maxBufferSize ?? 5_000 });
    this.logBuffer = new LogBuffer({ maxLines: options.maxLogBufferLines ?? 10_000 });
  }

  get state(): ConnectionState {
    return this._state;
  }

  getBufferedCount(): number {
    return this.eventBuffer.size();
  }

  /** Bytes pending in the WebSocket send queue, for LogStreamer backpressure detection. */
  getBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * One-time callback for the WebSocket 'drain' event (send buffer flushed to
   * the kernel); LogStreamer resumes sending on it after backpressure.
   */
  onDrain(callback: () => void): void {
    this.ws?.once('drain', callback);
  }

  /** Starts the connect -> register -> registered lifecycle. */
  connect(): void {
    if (this._state !== 'disconnected') {
      logger.warn('connect() called while not disconnected', { state: this._state });
      return;
    }

    this.intentionalDisconnect = false;
    this.doConnect();
  }

  /** Graceful disconnect; does not trigger reconnection. */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.cancelReconnect();

    // A parked complete waits for a reconnect that is no longer coming: fail it
    // closed now rather than at the ack deadline, which the process may not outlive.
    this.rejectHeldCompletes('the agent disconnected');

    // Pending log lines move to LogBuffer, sent on reconnect.
    this.drainPendingLogBatch();

    if (this.ws) {
      // 1000 = normal closure
      this.ws.close(1000, 'Agent disconnect');
      this.ws = null;
    }

    this._state = 'disconnected';
  }

  /** Sends immediately when registered; otherwise buffers for later delivery. */
  send(message: AgentToOrchestratorMessage): void {
    if (this._state === 'registered' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(adaptJobStatusForOrchestrator(message, this.orchCapabilities)));
    } else {
      this.eventBuffer.add(message);
    }
  }

  /** Sends without buffering, for heartbeat and other protocol messages that must not be buffered. */
  sendDirect(message: AgentToOrchestratorMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(adaptJobStatusForOrchestrator(message, this.orchCapabilities)));
    }
  }

  /**
   * While registered, batches lines (up to 50 lines or 100ms) into agent.log
   * messages; while disconnected, buffers them in LogBuffer for replay on reconnect.
   */
  streamLog(line: string): void {
    if (this._state === 'registered' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.pendingLogBatch.push(line);

      if (this.pendingLogBatch.length >= OrchestratorClient.LOG_BATCH_SIZE) {
        this.sendLogBatch();
        return;
      }

      if (!this.logFlushTimer) {
        this.logFlushTimer = setTimeout(() => {
          this.logFlushTimer = null;
          this.sendLogBatch();
        }, OrchestratorClient.LOG_FLUSH_INTERVAL_MS);
      }
    } else {
      this.logBuffer.add(line);
    }
  }

  /** Presigned S3 upload URL via cache.upload.request / cache.upload.response; 30s timeout. */
  async requestUploadUrl(
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      depsHash?: string;
      sourceTarDigest?: string;
      siblingsDigest?: string;
      platform: string;
      arch: string;
    },
  ): Promise<string> {
    const messageId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploadRequests.delete(messageId);
        reject(new Error('Upload URL request timed out (30s)'));
      }, 30_000);

      this.pendingUploadRequests.set(messageId, {
        resolve: (url) => {
          clearTimeout(timer);
          resolve(url);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendDirect({
        type: 'cache.upload.request' as AgentToOrchestratorMessage['type'],
        messageId,
        jobId,
        cacheType,
        ...key,
      } as AgentToOrchestratorMessage);
    });
  }

  /** Reports a completed S3 upload; the orchestrator then initializes the object's metadata. */
  sendUploadComplete(
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      platform: string;
      arch: string;
      depsHash?: string;
      sourceTarDigest?: string;
      siblingsDigest?: string;
    },
  ): void {
    this.sendDirect({
      type: 'cache.upload.complete' as AgentToOrchestratorMessage['type'],
      messageId: randomUUID(),
      jobId,
      cacheType,
      ...key,
    } as AgentToOrchestratorMessage);
  }

  /**
   * Presigned PUT URL for a provenance bundle via `provenance.upload.request` /
   * `provenance.upload.response` (shared upload-request pending map); 30s timeout.
   */
  async requestProvenanceUploadUrl(jobId: string, subjectDigest: string): Promise<string> {
    const messageId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploadRequests.delete(messageId);
        reject(new Error('Provenance upload URL request timed out (30s)'));
      }, 30_000);

      this.pendingUploadRequests.set(messageId, {
        resolve: (url) => {
          clearTimeout(timer);
          resolve(url);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendDirect({
        type: 'provenance.upload.request' as AgentToOrchestratorMessage['type'],
        messageId,
        jobId,
        subjectDigest,
      } as AgentToOrchestratorMessage);
    });
  }

  /** Notify the orchestrator a provenance bundle upload completed (records an attestations row). */
  sendProvenanceUploadComplete(
    jobId: string,
    subjectName: string,
    subjectDigest: string,
    mediaType: string,
  ): void {
    this.sendDirect({
      type: 'provenance.upload.complete' as AgentToOrchestratorMessage['type'],
      messageId: randomUUID(),
      jobId,
      subjectName,
      subjectDigest,
      mediaType,
    } as AgentToOrchestratorMessage);
  }

  /**
   * Relays a sandbox ctx.emit() to the orchestrator for persistence and routing.
   * Times out after 5s, matching the sandbox-side timeout.
   */
  async sendEventEmit(
    jobId: string,
    requestId: string,
    eventName: string,
    payload: Record<string, unknown>,
    target?: { repos?: string[] },
  ): Promise<{ requestId: string; deliveryId?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEventEmitRequests.delete(requestId);
        // Resolve with synthetic receipt on timeout (event may already be persisted)
        resolve({ requestId, deliveryId: `timeout-${requestId}` });
      }, 5_000);

      this.pendingEventEmitRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const emitMsg: Record<string, unknown> = {
        type: 'event.emit',
        jobId,
        requestId,
        eventName,
        payload,
      };
      if (target) {
        emitMsg.target = target;
      }
      this.sendDirect(emitMsg as AgentToOrchestratorMessage);
    });
  }

  /**
   * Exchanges a single-use claim code (delivered on a `kici.scaler.scale-up`
   * event) for freshly minted ephemeral agent credentials, for a provisioning
   * workflow's `ctx.kici.scaler.claimAgentCredentials`. The token rides the
   * response only and is never logged. Times out after `AGENT_API_REQUEST_TIMEOUT_MS`.
   */
  async sendClaimCredentials(claimCode: string): Promise<{
    credentials?: {
      agentToken: string;
      agentId: string;
      orchestratorUrl: string;
      labels: string[];
    };
    error?: string;
  }> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClaimCredentialsRequests.delete(requestId);
        reject(new Error('scaler.claim-credentials timed out'));
      }, AGENT_API_REQUEST_TIMEOUT_MS);

      this.pendingClaimCredentialsRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendDirect({
        type: 'scaler.claim-credentials',
        requestId,
        claimCode,
      } as AgentToOrchestratorMessage);
    });
  }

  /**
   * Build this agent's fleet mini-bundle and stream it back to the orchestrator
   * as ordered fleet.bundle.chunk frames (the WS frame cap forbids one frame).
   * On failure, sends a single fleet.bundle.error. Public for unit testing.
   */
  async streamFleetBundle(req: FleetLogsRequest): Promise<void> {
    try {
      const inputs = (await this.getFleetBundleInputs?.()) ?? { config: {} };
      const buf = await buildAgentMiniBundle({
        agentId: this.agentId,
        logDir: inputs.logDir,
        logWindowHours: req.logWindowHours,
        config: inputs.config,
        metricsText: inputs.metricsText,
      });
      for (const f of chunkBuffer(buf)) {
        this.sendDirect({
          type: 'fleet.bundle.chunk',
          requestId: req.requestId,
          seq: f.seq,
          isLast: f.isLast,
          dataB64: f.dataB64,
        });
      }
    } catch (err) {
      this.sendDirect({
        type: 'fleet.bundle.error',
        requestId: req.requestId,
        message: toErrorMessage(err),
      });
    }
  }

  /**
   * Transport for the agent private API: the SDK's typed KiciApi calls it with
   * dot-namespaced method names. Times out after `AGENT_API_REQUEST_TIMEOUT_MS`.
   */
  async sendApiRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApiRequests.delete(requestId);
        reject(
          new Error(
            `API request '${method}' timed out after ${AGENT_API_REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, AGENT_API_REQUEST_TIMEOUT_MS);

      this.pendingApiRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendDirect({
        type: 'agent.api.request',
        requestId,
        method,
        params,
      } as AgentToOrchestratorMessage);
    });
  }

  /**
   * Relays a sandbox `cache.request` IPC as the matching `cache.user.*` WS
   * message and maps the response onto the IPC shape:
   *
   * - `restore` -> `cache.user.restore.request` / `.response`.
   * - `beginSave` -> `cache.user.save.request` / `.response`.
   * - `completeSave` -> `cache.user.save.complete`, fire-and-forget (the
   *   orchestrator commits temp -> final without replying); resolves immediately.
   *
   * Round-trip ops time out after 30s.
   */
  async requestUserCache(jobId: string, request: CacheRequestIpc): Promise<CacheResponseIpc> {
    if (request.op === 'completeSave') {
      this.sendDirect({
        type: 'cache.user.save.complete',
        messageId: randomUUID(),
        jobId,
        key: request.key,
        tarHash: request.tarHash!,
        sizeBytes: request.sizeBytes!,
      } as AgentToOrchestratorMessage);
      return { type: 'cache.response', requestId: request.requestId };
    }

    const messageId = randomUUID();
    return new Promise<CacheResponseIpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUserCacheRequests.delete(messageId);
        reject(new Error('User-cache request timed out (30s)'));
      }, 30_000);

      this.pendingUserCacheRequests.set(messageId, {
        resolve: (response) => {
          clearTimeout(timer);
          // Carry the runner's IPC requestId so dispatchAgentMessage correlates.
          resolve({ ...response, requestId: request.requestId });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      if (request.op === 'restore') {
        this.sendDirect({
          type: 'cache.user.restore.request',
          messageId,
          jobId,
          key: request.key,
          ...(request.restoreKeys && { restoreKeys: request.restoreKeys }),
        } as AgentToOrchestratorMessage);
      } else {
        this.sendDirect({
          type: 'cache.user.save.request',
          messageId,
          jobId,
          key: request.key,
        } as AgentToOrchestratorMessage);
      }
    });
  }

  /**
   * Relays a sandbox `artifacts.request` IPC as the matching `artifacts.*` WS
   * message and maps the response onto the IPC shape:
   *
   * - `beginUpload` -> `artifacts.upload.request` / `.response`.
   * - `completeUpload` -> `artifacts.upload.complete` / `.complete.ack`; rejects
   *   when the commit failed, so the step fails instead of losing the artifact
   *   behind a green run.
   * - `download` -> `artifacts.download.request` / `.response`.
   *
   * Round-trip ops time out after 30s.
   */
  async requestUserArtifact(
    jobId: string,
    request: ArtifactRequestIpc,
  ): Promise<ArtifactResponseIpc> {
    if (request.op === 'completeUpload') {
      const completeId = randomUUID();
      const complete = {
        type: 'artifacts.upload.complete',
        messageId: completeId,
        jobId,
        name: request.name,
        sha256: request.sha256!,
      } as AgentToOrchestratorMessage;

      return new Promise<ArtifactResponseIpc>((resolve, reject) => {
        // Shared by reference with the maps below, so `record.messageId` names
        // the current key even after a reconnect re-key. The timer is created
        // once and NEVER restarted, so hold-plus-resend stays inside the deadline
        // an uninterrupted ack wait gets.
        const record: InFlightComplete = {
          messageId: completeId,
          frame: complete,
          attempts: 0,
          pending: {
            resolve: () => {
              clearTimeout(timer);
              resolve({ type: 'artifacts.response', requestId: request.requestId });
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          },
        };

        const timer = setTimeout(() => {
          this.forgetComplete(record);
          reject(
            new Error(
              `Artifact upload-complete ack timed out (${ARTIFACT_COMPLETE_ACK_TIMEOUT_MS}ms)`,
            ),
          );
        }, ARTIFACT_COMPLETE_ACK_TIMEOUT_MS);

        this.pendingUserArtifactRequests.set(completeId, record.pending);
        this.resendableCompletes.set(completeId, record);

        this.sendDirect(complete);
      });
    }

    const messageId = randomUUID();
    return new Promise<ArtifactResponseIpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUserArtifactRequests.delete(messageId);
        reject(new Error('User-artifact request timed out (30s)'));
      }, 30_000);

      this.pendingUserArtifactRequests.set(messageId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve({ ...response, requestId: request.requestId });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      if (request.op === 'beginUpload') {
        this.sendDirect({
          type: 'artifacts.upload.request',
          messageId,
          jobId,
          name: request.name,
          declaredSizeBytes: request.declaredSizeBytes!,
        } as AgentToOrchestratorMessage);
      } else {
        this.sendDirect({
          type: 'artifacts.download.request',
          messageId,
          jobId,
          name: request.name,
        } as AgentToOrchestratorMessage);
      }
    });
  }

  /**
   * Maps a `provenance.request` IPC onto `requestProvenanceUploadUrl` (presigned
   * URL), `sendProvenanceUploadComplete` or `sendProvenanceUploadDefer` (both
   * fire-and-forget), returning the IPC response shape.
   */
  async relayProvenance(
    jobId: string,
    request: ProvenanceRequestIpc,
  ): Promise<ProvenanceResponseIpc> {
    if (request.op === 'complete') {
      this.sendProvenanceUploadComplete(
        jobId,
        request.subjectName!,
        request.subjectDigest,
        request.mediaType!,
      );
      return { type: 'provenance.response', requestId: request.requestId };
    }
    if (request.op === 'defer') {
      this.sendProvenanceUploadDefer(jobId, request);
      return { type: 'provenance.response', requestId: request.requestId };
    }
    const uploadUrl = await this.requestProvenanceUploadUrl(jobId, request.subjectDigest);
    return { type: 'provenance.response', requestId: request.requestId, uploadUrl };
  }

  /**
   * Capture a frozen, DSSE-signed attestation for later minting (transient
   * mint-failure path). Fire-and-forget: the orchestrator persists it into the
   * deferred-attestation outbox and the job stays green.
   */
  sendProvenanceUploadDefer(jobId: string, request: ProvenanceRequestIpc): void {
    this.sendDirect({
      type: 'provenance.upload.defer' as AgentToOrchestratorMessage['type'],
      messageId: randomUUID(),
      jobId,
      subjectName: request.subjectName!,
      subjectDigest: request.subjectDigest,
      audience: request.audience!,
      mediaType: request.mediaType!,
      statementHash: request.statementHash!,
      dsseEnvelope: request.dsseEnvelope,
      publicKey: request.publicKey,
    } as unknown as AgentToOrchestratorMessage);
  }

  /**
   * Sends `step.approval-request` and resolves with `step.approval-resolved` on
   * the IPC shape. No client-side timeout: the orchestrator owns the expiry and
   * replies `expired`. Rejects only on disconnect, which the relay caller treats
   * as a fail-closed reject.
   */
  async sendStepApproval(
    runId: string,
    jobId: string,
    request: StepApprovalRequestIpc,
  ): Promise<StepApprovalResolvedIpc> {
    const messageId = randomUUID();
    return new Promise<StepApprovalResolvedIpc>((resolve, reject) => {
      this.pendingStepApprovals.set(messageId, {
        resolve: (response) => resolve({ ...response, requestId: request.requestId }),
        reject,
      });
      this.sendDirect({
        type: 'step.approval-request',
        messageId,
        runId,
        jobId,
        stepIndex: request.stepIndex,
        stepName: request.stepName,
        clauses: request.clauses,
        reason: request.reason,
        ...(request.timeoutSeconds !== undefined && { timeoutSeconds: request.timeoutSeconds }),
        ...(request.payload !== undefined && { payload: request.payload }),
      } as unknown as AgentToOrchestratorMessage);
    });
  }

  /**
   * Execution environment details (runtime, sandbox type, env vars) for the
   * Summary tab; the orchestrator adds orgId before forwarding to Platform.
   */
  sendJobContext(
    runId: string,
    jobId: string,
    context: {
      envVars?: Array<{
        name: string;
        value: string;
        category: 'system' | 'user' | 'inherited' | 'secret';
      }>;
      runtime?: { nodeVersion?: string; os?: string; arch?: string };
      sandboxType?: string;
      labels?: string[];
      workingDirectory?: string;
      gitRef?: string;
    },
  ): void {
    this.sendDirect({
      type: 'job.context',
      runId,
      jobId,
      context,
    } as unknown as AgentToOrchestratorMessage);
  }

  /**
   * Infrastructure lifecycle events (clone, execution, teardown); the
   * orchestrator adds orgId before forwarding to Platform.
   */
  sendRunEvent(
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ): void {
    this.sendDirect({
      type: 'run.event',
      runId,
      eventType,
      timestampMs: Date.now(),
      sourceService: 'agent',
      jobId: opts?.jobId ?? null,
      metadata: opts?.metadata,
      durationMs: opts?.durationMs ?? null,
    } as unknown as AgentToOrchestratorMessage);
  }

  /**
   * Sends job.concurrency.report; the orchestrator evaluates the group and acks
   * with `proceed`, `wait` (release the slot; the orchestrator re-dispatches
   * later) or `cancel` (superseded by a newer run). 30s timeout.
   */
  async sendConcurrencyReport(
    runId: string,
    jobId: string,
    group: string,
  ): Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }> {
    const messageId = randomUUID();
    return new Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingConcurrencyRequests.delete(messageId);
          reject(new Error('Concurrency report ack timed out (30s)'));
        }, 30_000);

        this.pendingConcurrencyRequests.set(messageId, {
          resolve: (ack) => {
            clearTimeout(timer);
            resolve(ack);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });

        this.sendDirect({
          type: 'job.concurrency.report',
          messageId,
          runId,
          jobId,
          group,
        } as AgentToOrchestratorMessage);
      },
    );
  }

  getReconnectDelay(): number {
    return getReconnectDelay(this.reconnectAttempts, this.maxReconnectDelayMs);
  }

  // --- Internal methods ---

  private doConnect(): void {
    this._state = 'connecting';
    this.orchCapabilities = {};

    try {
      this.ws = new WebSocket(this.url, {
        // Caps the decompressed frame size so a rogue orchestrator cannot OOM
        // the agent with a compression bomb (ws@8.x defaults to 100 MiB).
        maxPayload: WS_MAX_PAYLOAD_BYTES,
        perMessageDeflate: {
          concurrencyLimit: 10,
          threshold: 128, // Skip compressing tiny messages like heartbeats
        },
      });
    } catch (err) {
      logger.error('Failed to create WebSocket', {
        error: toErrorMessage(err),
      });
      this._state = 'disconnected';
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      void this.onWsOpen();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.info('Orchestrator connection closed', {
        code,
        reason: reason.toString(),
      });

      // Defense in depth: WS_CLOSE_AGENT_AUTH_FAILED (4010) means the token was
      // never valid or is revoked, so fail permanently even when the preceding
      // auth.failure was lost or garbled; otherwise intentionalDisconnect stays
      // false and the reconnect loop storms a token already rejected.
      if (code === WS_CLOSE_AGENT_AUTH_FAILED) {
        logger.error(
          'Orchestrator closed with auth-failed code -- token is invalid or revoked. NOT retrying.',
          { code, reason: reason.toString() },
        );
        this.failAuthPermanently(reason.toString() || 'orchestrator closed with auth-failed code');
      }

      this._state = 'disconnected';
      this.stopHeartbeat();

      // Drain the pending log batch into LogBuffer before marking disconnectedAt.
      this.drainPendingLogBatch();
      this.disconnectedAt = Date.now();

      for (const [_id, pending] of this.pendingUploadRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingUploadRequests.clear();

      for (const [_id, pending] of this.pendingEventEmitRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingEventEmitRequests.clear();

      for (const [_id, pending] of this.pendingApiRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingApiRequests.clear();

      for (const [_id, pending] of this.pendingClaimCredentialsRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingClaimCredentialsRequests.clear();

      for (const [_id, pending] of this.pendingUserCacheRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingUserCacheRequests.clear();

      // An in-flight `artifacts.upload.complete` is held for resend, not
      // rejected: the artifact may be committed with only the ack lost.
      // beginUpload / download still fail fast; they are not idempotent.
      // Holding is safe only when a reconnect is coming, and `scheduleReconnect`
      // runs only for an unintentional disconnect, so a deliberate shutdown
      // rejects them immediately.
      for (const [id, pending] of this.pendingUserArtifactRequests) {
        const record = this.resendableCompletes.get(id);
        if (record && !this.intentionalDisconnect) {
          this.heldCompletes.add(record);
          continue;
        }
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingUserArtifactRequests.clear();
      this.resendableCompletes.clear();

      // Completes parked by an *earlier* drop: a deliberate close (shutdown, or
      // a permanently rejected token) means no `register.ack` will re-send them.
      if (this.intentionalDisconnect) {
        this.rejectHeldCompletes('the agent disconnected');
      }

      for (const [_id, pending] of this.pendingConcurrencyRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingConcurrencyRequests.clear();

      // The relay caller fails the gate closed.
      for (const [_id, pending] of this.pendingStepApprovals) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingStepApprovals.clear();

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error(`Orchestrator WebSocket error: ${err.message}`);

      // Close fires after error and triggers the reconnect.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  /**
   * WS-open handshake. Self-bootstrap runs first (`scalerClaimCode` set, no
   * static token): the claim exchange happens before any auth or register, and
   * a rejected or expired code fails permanently, so a one-shot provisioning run
   * exits visibly rather than looping. Then, with a token (static or minted),
   * send `auth.request` and register after `auth.success`; without one, register
   * directly (unauthenticated mode).
   */
  private async onWsOpen(): Promise<void> {
    if (this.scalerClaimCode && !this.token) {
      const adopted = await this.performClaimExchange(this.scalerClaimCode);
      if (!adopted) return; // permanent failure — do not auth or register
    }

    if (this.token) {
      this._state = 'authenticating';
      logger.info('Connected to orchestrator, sending auth.request', {
        url: this.url,
        agentId: this.agentId,
      });

      this.ws!.send(
        JSON.stringify({
          type: 'auth.request',
          token: this.token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    } else {
      this._state = 'registering';
      logger.info('Connected to orchestrator, sending agent.register (no token)', {
        url: this.url,
        agentId: this.agentId,
      });

      this.sendAgentRegister();
    }
  }

  /**
   * Adopts the minted token / agentId / labels and returns true; returns false
   * when the claim failed permanently (the connection is already torn down,
   * with no reconnect).
   */
  private async performClaimExchange(claimCode: string): Promise<boolean> {
    logger.info('Self-bootstrap: exchanging claim code for ephemeral credentials', {
      url: this.url,
      agentId: this.agentId,
    });

    let response: Awaited<ReturnType<typeof this.sendClaimCredentials>>;
    try {
      response = await this.sendClaimCredentials(claimCode);
    } catch (err) {
      this.failClaimPermanently(`claim exchange failed: ${toErrorMessage(err)}`);
      return false;
    }

    if (response.error || !response.credentials) {
      this.failClaimPermanently(response.error ?? 'orchestrator returned no credentials');
      return false;
    }

    const { agentToken, agentId, labels } = response.credentials;
    this.token = agentToken;
    this.agentId = agentId;
    this.labels = this.mergeClaimedLabels(labels);
    logger.info('Self-bootstrap: adopted ephemeral credentials', { agentId });
    return true;
  }

  /**
   * Deduped union with the agent's own labels. The `kici:os:` / `kici:arch:` /
   * `kici:host:` facts are derived at register time (`sendAgentRegister`), so
   * they survive regardless.
   */
  private mergeClaimedLabels(claimed: string[]): string[] {
    return [...new Set([...this.labels, ...claimed])];
  }

  /**
   * Same no-reconnect mechanism as `auth.failure`: mark the auth context dead,
   * suppress reconnect, close the socket.
   */
  private failClaimPermanently(reason: string): void {
    logger.error(
      'Self-bootstrap claim exchange failed -- claim code is invalid or expired. NOT retrying.',
      { reason },
    );
    this.authFailed = true;
    this.intentionalDisconnect = true;
    if (this.ws) {
      this.ws.close(1000, 'Claim failed');
      this.ws = null;
    }
    this._state = 'disconnected';

    // A one-shot agent has no path forward: server.ts exits non-zero rather than
    // letting the health server keep it alive until a job timeout.
    this.onClaimFailedPermanently?.(reason);
  }

  /** Maps the wire fields onto the IPC shape; no-op when nothing is pending for the requestId. */
  private resolveArtifactResponse(
    type: 'artifacts.upload.response' | 'artifacts.download.response',
    raw: unknown,
  ): void {
    const artMsg = raw as {
      requestId: string;
      outcome?: string;
      uploadUrl?: string;
      storageKey?: string;
      reason?: string;
      error?: string;
      downloadUrl?: string;
      sizeBytes?: number;
      sha256?: string;
    };
    const pending = this.pendingUserArtifactRequests.get(artMsg.requestId);
    if (!pending) return;
    this.pendingUserArtifactRequests.delete(artMsg.requestId);
    const isUpload = type === 'artifacts.upload.response';
    pending.resolve({
      type: 'artifacts.response',
      requestId: artMsg.requestId,
      ...(isUpload &&
        artMsg.outcome !== undefined && {
          uploadOutcome: artMsg.outcome as 'granted' | 'rejected',
        }),
      ...(!isUpload &&
        artMsg.outcome !== undefined && {
          downloadOutcome: artMsg.outcome as 'found' | 'not_found',
        }),
      ...(artMsg.uploadUrl && { uploadUrl: artMsg.uploadUrl }),
      ...(artMsg.storageKey && { storageKey: artMsg.storageKey }),
      ...(artMsg.reason && {
        reason: artMsg.reason as 'duplicate_name' | 'size_cap' | 'run_cap' | 'org_quota',
      }),
      // A dedicated IPC field: on `error`, the sandbox would throw a relay
      // failure instead of rendering the rejection.
      ...(artMsg.error && { rejectionDetail: artMsg.error }),
      ...(artMsg.downloadUrl && { downloadUrl: artMsg.downloadUrl }),
      ...(artMsg.sizeBytes !== undefined && { sizeBytes: artMsg.sizeBytes }),
      ...(artMsg.sha256 && { sha256: artMsg.sha256 }),
    });
  }

  /**
   * `committed` resolves the relayed completeUpload; `failed` rejects it with
   * the orchestrator's reason, which reaches the relay's `response.error` and
   * fails the step rather than losing the artifact silently. No-op for an ack
   * whose complete already timed out.
   */
  private resolveArtifactCompleteAck(raw: unknown): void {
    const ack = raw as { requestId: string; outcome: string; reason?: string };
    const pending = this.pendingUserArtifactRequests.get(ack.requestId);
    if (!pending) return;
    this.pendingUserArtifactRequests.delete(ack.requestId);
    this.resendableCompletes.delete(ack.requestId);
    if (ack.outcome === ArtifactCompleteAckOutcome.enum.committed) {
      pending.resolve({ type: 'artifacts.response', requestId: ack.requestId });
    } else {
      pending.reject(new Error(ack.reason ?? 'artifact upload-complete failed'));
    }
  }

  /**
   * Drops every trace of an in-flight complete, under its current key, parked
   * or not. The ack timer calls it on the original schedule, however many
   * re-keys happened since.
   */
  private forgetComplete(record: InFlightComplete): void {
    this.pendingUserArtifactRequests.delete(record.messageId);
    this.resendableCompletes.delete(record.messageId);
    this.heldCompletes.delete(record);
  }

  /**
   * Fails every parked complete closed when the reconnect it waited for will
   * never come (deliberate shutdown, permanently rejected token). The message
   * names the ambiguity so the operator does not hunt for an artifact that landed.
   */
  private rejectHeldCompletes(cause: string): void {
    if (this.heldCompletes.size === 0) return;
    const held = [...this.heldCompletes];
    this.heldCompletes.clear();
    for (const record of held) {
      record.pending.reject(
        new Error(
          `artifact upload-complete could not be acknowledged before ${cause} — ` +
            COMMIT_MAY_HAVE_LANDED,
        ),
      );
    }
  }

  /**
   * Called from `register.ack`. Each frame gets a fresh `messageId` (the
   * correlation key), so a late ack for the pre-disconnect send cannot resolve
   * the new pending. The original ack timer is left alone, so hold plus resends
   * stay inside the ARTIFACT_COMPLETE_ACK_TIMEOUT_MS budget.
   */
  private resendHeldCompletes(): void {
    if (this.heldCompletes.size === 0) return;
    const held = [...this.heldCompletes];
    this.heldCompletes.clear();

    for (const record of held) {
      if (record.attempts >= MAX_COMPLETE_RESEND_ATTEMPTS) {
        record.pending.reject(
          new Error(
            'artifact upload-complete could not be acknowledged after ' +
              `${MAX_COMPLETE_RESEND_ATTEMPTS} reconnects — ${COMMIT_MAY_HAVE_LANDED}`,
          ),
        );
        continue;
      }

      record.messageId = randomUUID();
      record.attempts += 1;
      record.frame = { ...record.frame, messageId: record.messageId } as AgentToOrchestratorMessage;
      this.pendingUserArtifactRequests.set(record.messageId, record.pending);
      this.resendableCompletes.set(record.messageId, record);
      this.sendDirect(record.frame);
      logger.info('Re-sent artifact upload-complete after reconnect', {
        messageId: record.messageId,
        attempt: record.attempts,
      });
    }
  }

  /**
   * Artifact replies dispatch off the raw frame, not the parsed protocol union.
   * Returns true when the message was consumed.
   */
  private handleArtifactReply(type: string | undefined, raw: unknown): boolean {
    if (type === 'artifacts.upload.response' || type === 'artifacts.download.response') {
      this.resolveArtifactResponse(type, raw);
      return true;
    }
    if (type === 'artifacts.upload.complete.ack') {
      this.resolveArtifactCompleteAck(raw);
      return true;
    }
    return false;
  }

  /** Returns true when it handled the message; kept out of handleMessage for the function-length limit. */
  private handleClaimCredentialsResponse(rawMsg: {
    type?: string;
    requestId?: string;
    error?: string;
  }): boolean {
    if (rawMsg.type !== 'scaler.claim-credentials.response') return false;
    const pending = this.pendingClaimCredentialsRequests.get(rawMsg.requestId!);
    if (pending) {
      this.pendingClaimCredentialsRequests.delete(rawMsg.requestId!);
      pending.resolve({
        credentials: (rawMsg as Record<string, unknown>).credentials as
          | { agentToken: string; agentId: string; orchestratorUrl: string; labels: string[] }
          | undefined,
        error: rawMsg.error,
      });
    }
    return true;
  }

  /** Enters `registered`, flushes everything parked while disconnected, and hands the ack's lifetime flags to `onRegistered`. */
  private handleRegisterAck(msg: Extract<OrchestratorToAgentMessage, { type: 'register.ack' }>) {
    logger.info('Registration acknowledged by orchestrator', {
      agentId: msg.agentId,
      labels: msg.labels,
      scalerManaged: msg.scalerManaged,
      pendingDispatch: msg.pendingDispatch ?? false,
      warmPool: msg.warmPool ?? false,
      acceptsSkippedJobStatus: msg.capabilities?.acceptsSkippedJobStatus ?? false,
    });

    // Before the flush: a frame buffered during an outage is judged against the
    // orchestrator it is delivered to.
    this.orchCapabilities = msg.capabilities ?? {};
    this._state = 'registered';
    this.reconnectAttempts = 0;
    this.startHeartbeat();
    this.flushBuffer();

    this.resendHeldCompletes();

    this.onRegistered?.({
      pendingDispatch: msg.pendingDispatch ?? false,
      warmPool: msg.warmPool ?? false,
    });

    // Firecracker / scaler-managed mode.
    if (msg.scalerManaged || this.scalerManaged) {
      this.blockMmdsAccess();
    }

    this.sendConfigAck(msg.agentId);
  }

  private handleMessage(data: WebSocket.Data): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      logger.warn('Malformed JSON received from orchestrator');
      return;
    }

    // cache.upload.response is not part of the standard protocol schema.
    const rawMsg = raw as {
      type?: string;
      requestId?: string;
      uploadUrl?: string;
      deliveryId?: string;
      error?: string;
    };
    if (rawMsg.type === 'cache.upload.response' || rawMsg.type === 'provenance.upload.response') {
      const pending = this.pendingUploadRequests.get(rawMsg.requestId!);
      if (pending) {
        this.pendingUploadRequests.delete(rawMsg.requestId!);
        if (rawMsg.uploadUrl) {
          pending.resolve(rawMsg.uploadUrl);
        } else {
          pending.reject(new Error('Orchestrator returned empty upload URL'));
        }
      }
      return;
    }

    if (rawMsg.type === 'event.emit.response') {
      const pending = this.pendingEventEmitRequests.get(rawMsg.requestId!);
      if (pending) {
        this.pendingEventEmitRequests.delete(rawMsg.requestId!);
        pending.resolve({
          requestId: rawMsg.requestId!,
          deliveryId: rawMsg.deliveryId,
          error: rawMsg.error,
        });
      }
      return;
    }

    if (this.handleClaimCredentialsResponse(rawMsg)) {
      return;
    }

    if (rawMsg.type === 'agent.api.response') {
      const pending = this.pendingApiRequests.get(rawMsg.requestId!);
      if (pending) {
        this.pendingApiRequests.delete(rawMsg.requestId!);
        if (rawMsg.error) {
          pending.reject(new Error(rawMsg.error as string));
        } else {
          pending.resolve((rawMsg as Record<string, unknown>).result);
        }
      }
      return;
    }

    if (
      rawMsg.type === 'cache.user.restore.response' ||
      rawMsg.type === 'cache.user.save.response'
    ) {
      const cacheMsg = raw as {
        requestId: string;
        hit?: boolean;
        matchedKey?: string;
        downloadUrl?: string;
        tarHash?: string;
        skip?: boolean;
        uploadUrl?: string;
      };
      const pending = this.pendingUserCacheRequests.get(cacheMsg.requestId);
      if (pending) {
        this.pendingUserCacheRequests.delete(cacheMsg.requestId);
        pending.resolve({
          type: 'cache.response',
          requestId: cacheMsg.requestId,
          ...(cacheMsg.hit !== undefined && { hit: cacheMsg.hit }),
          ...(cacheMsg.matchedKey && { matchedKey: cacheMsg.matchedKey }),
          ...(cacheMsg.downloadUrl && { downloadUrl: cacheMsg.downloadUrl }),
          ...(cacheMsg.tarHash && { tarHash: cacheMsg.tarHash }),
          ...(cacheMsg.skip !== undefined && { skip: cacheMsg.skip }),
          ...(cacheMsg.uploadUrl && { uploadUrl: cacheMsg.uploadUrl }),
        });
      }
      return;
    }

    if (this.handleArtifactReply(rawMsg.type, raw)) return;

    const parsed = orchestratorToAgentMessageSchema.safeParse(raw);
    if (parsed.success) {
      const msg = parsed.data;

      switch (msg.type) {
        case 'auth.success': {
          if (this._state === 'authenticating') {
            logger.info('Authentication successful, sending agent.register', {
              connectionId: msg.connectionId,
            });
            this._state = 'registering';
            this.sendAgentRegister();
          }
          break;
        }

        case 'auth.failure': {
          logger.error('Authentication FAILED -- token is invalid or expired. NOT retrying.', {
            reason: msg.reason,
          });
          this.failAuthPermanently(msg.reason);
          if (this.ws) {
            this.ws.close(1000, 'Auth failed');
            this.ws = null;
          }
          this._state = 'disconnected';
          break;
        }

        case 'register.ack': {
          this.handleRegisterAck(msg);
          break;
        }

        case 'job.dispatch': {
          logger.info('Job dispatch received', {
            runId: msg.runId,
            jobId: msg.jobId,
          });
          this.onJobDispatch(msg);
          break;
        }

        case 'job.cancel': {
          logger.info('Job cancel received', {
            runId: msg.runId,
            jobId: msg.jobId,
            reason: msg.reason,
          });
          this.onJobCancel(msg);
          break;
        }

        case 'job.concurrency.ack': {
          logger.info('Concurrency ack received', {
            requestId: msg.requestId,
            action: msg.action,
          });
          const pending = this.pendingConcurrencyRequests.get(msg.requestId);
          if (pending) {
            this.pendingConcurrencyRequests.delete(msg.requestId);
            pending.resolve({ action: msg.action, reason: msg.reason });
          }
          break;
        }

        case 'step.approval-resolved': {
          logger.info('Step approval resolved', {
            requestId: msg.requestId,
            runId: msg.runId,
            jobId: msg.jobId,
            stepIndex: msg.stepIndex,
            outcome: msg.outcome,
          });
          const pending = this.pendingStepApprovals.get(msg.requestId);
          if (pending) {
            this.pendingStepApprovals.delete(msg.requestId);
            pending.resolve({
              type: 'approval.resolved',
              requestId: msg.requestId,
              outcome: msg.outcome,
              ...(msg.reason !== undefined && { reason: msg.reason }),
            });
          }
          break;
        }

        case 'fleet.logs.request': {
          logger.info('Fleet log collection requested', {
            requestId: msg.requestId,
            logWindowHours: msg.logWindowHours,
          });
          void this.streamFleetBundle(msg);
          break;
        }

        case 'rate.limit.warning': {
          // The orchestrator dropped the frame this answers; logged as such so a
          // throttled agent sees its output discarded, not an unparseable frame.
          logger.warn('Orchestrator rate-limited this agent and dropped a frame', {
            retryAfterMs: msg.retryAfterMs,
          });
          break;
        }
      }
      return;
    }

    const heartbeat = heartbeatSchema.safeParse(raw);
    if (heartbeat.success) {
      return;
    }

    logger.warn('Invalid message from orchestrator', {
      errors: parsed.error.issues,
    });
  }

  private flushBuffer(): void {
    const events = this.eventBuffer.flush();
    const logLines = this.logBuffer.flush();

    // Gap marker when anything was buffered or dropped.
    if (
      events.length > 0 ||
      logLines.length > 0 ||
      this.eventBuffer.droppedCount > 0 ||
      this.logBuffer.droppedCount > 0
    ) {
      const outageDurationSec = this.disconnectedAt
        ? Math.round((Date.now() - this.disconnectedAt) / 1000)
        : 0;

      let gapMsg = `--- Orchestrator offline for ${outageDurationSec}s. Replaying ${events.length} buffered events and ${logLines.length} buffered log lines.`;

      if (this.eventBuffer.droppedCount > 0) {
        gapMsg += ` ${this.eventBuffer.droppedCount} events dropped due to buffer overflow.`;
      }
      if (this.logBuffer.droppedCount > 0) {
        gapMsg += ` ${this.logBuffer.droppedCount} log lines dropped due to buffer overflow.`;
      }
      gapMsg += ' ---';

      // Sent as a log line before the replay.
      this.sendAgentLogMessage([gapMsg]);
    }

    this.disconnectedAt = null;

    // Events are full message objects and keep their original timestamps.
    if (events.length > 0) {
      logger.info('Flushing event buffer', { count: events.length });
      for (const msg of events) {
        this.sendDirect(msg);
      }
    }

    if (logLines.length > 0) {
      logger.info('Flushing log buffer', { count: logLines.length });
      for (let i = 0; i < logLines.length; i += OrchestratorClient.LOG_BATCH_SIZE) {
        const batch = logLines.slice(i, i + OrchestratorClient.LOG_BATCH_SIZE);
        this.sendAgentLogMessage(batch);
      }
    }

    // Only after the gap marker has reported them.
    this.eventBuffer.resetDroppedCount();
    this.logBuffer.resetDroppedCount();
  }

  private sendLogBatch(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }

    if (this.pendingLogBatch.length === 0) {
      return;
    }

    const lines = this.pendingLogBatch;
    this.pendingLogBatch = [];

    // A socket no longer open (e.g. CLOSING) buffers the lines for replay, never drops them.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      for (const line of lines) {
        this.logBuffer.add(line);
      }
      return;
    }

    this.sendAgentLogMessage(lines);
  }

  private sendAgentLogMessage(lines: string[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'agent.log',
          messageId: randomUUID(),
          agentId: this.agentId,
          lines,
          timestamp: Date.now(),
        }),
      );
    }
  }

  /** Called on disconnect to keep pending lines for replay on reconnect. */
  private drainPendingLogBatch(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }

    for (const line of this.pendingLogBatch) {
      this.logBuffer.add(line);
    }
    this.pendingLogBatch = [];
  }

  /**
   * Blocks MMDS via iptables in Firecracker / scaler-managed mode, after
   * register.ack delivered the config, so neither the agent nor user code can
   * read MMDS metadata.
   */
  private blockMmdsAccess(): void {
    // iptables needs root (or CAP_NET_ADMIN). A container-scaler agent runs as
    // non-root and the orchestrator's host nftables rules isolate it, so skip
    // quietly rather than warn.
    if (process.getuid?.() !== 0) {
      logger.info(
        'MMDS iptables block skipped (non-root) — network isolation handled by orchestrator',
      );
      return;
    }

    try {
      execSync('iptables -A OUTPUT -d 169.254.169.254 -j DROP', { timeout: 5000 });
      logger.info('MMDS access blocked via iptables');
    } catch (err) {
      logger.warn('Failed to block MMDS access via iptables', {
        error: toErrorMessage(err),
      });
      // Non-fatal: MMDS data will also be cleared host-side after config.ack
    }
  }

  /** Confirms the registration config arrived; the orchestrator then clears MMDS data for Firecracker agents. */
  private sendConfigAck(agentId: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'config.ack',
          messageId: `config-ack-${agentId}-${Date.now()}`,
          agentId,
        }),
      );
      logger.info('Config ACK sent to orchestrator', { agentId });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._state === 'registered' && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'heartbeat',
            timestamp: Date.now(),
          }),
        );
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Shared by the authenticated and unauthenticated flows. */
  private sendAgentRegister(): void {
    const inFlightJobs = this.getInFlightJobs?.() ?? [];
    const autoLabels = [
      ...deriveOsArchLabels(os.platform(), os.arch()),
      hostLabel(os.hostname()),
      // Container capabilities: a self-reported FACT like os/arch/host, which
      // the orchestrator cannot know and the scaler cannot predict at token mint.
      ...runtimeFactLabels(),
      // Behaviours this build implements, so dependent work routes only to an
      // agent that has them: a fact about the build, not a privilege.
      ...AGENT_FEATURE_LABELS,
      ...resolveRoleLabels(this.roles),
    ];
    const allLabels = mergeAutoLabels(this.labels, autoLabels);
    const msg: Record<string, unknown> = {
      type: 'agent.register',
      messageId: `register-${this.agentId}-${Date.now()}`,
      agentId: this.agentId,
      labels: allLabels,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      osRelease: os.release(),
      osVersion: os.version(),
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      cpuCount: os.cpus().length,
      nodeVersion: process.versions.node,
      // The orchestrator routes work needing a capability only to an agent advertising it.
      capabilities: AGENT_CAPABILITIES,
      ...(() => {
        const v = readAgentVersion();
        return v ? { version: v } : {};
      })(),
      ...(() => {
        try {
          const info = os.userInfo();
          return { runningAsUser: info.username, runningAsUid: info.uid };
        } catch {
          return {};
        }
      })(),
    };
    if (inFlightJobs.length > 0) {
      msg.inFlightJobs = inFlightJobs;
    }
    if (Object.keys(this.properties).length > 0) {
      msg.properties = this.properties;
    }
    this.ws!.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();

    if (this.authFailed) {
      logger.error('Not reconnecting: authentication permanently failed');
      return;
    }

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;

    logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalDisconnect) {
        this.doConnect();
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
