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
  hasOrchAgentCapability,
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
 * How long to wait for `artifacts.upload.complete.ack` before failing the step.
 *
 * Deliberately shorter than the sandbox's own 30s artifact-request timeout
 * (`CACHE_RESPONSE_TIMEOUT_MS` in the workflow runner) so a lost ack surfaces
 * this specific reason rather than the sandbox's generic "artifact request
 * timed out". The orchestrator's bounded commit retry finishes in well under a
 * second, so the margin costs nothing.
 */
const ARTIFACT_COMPLETE_ACK_TIMEOUT_MS = 25_000;

/**
 * How many times an in-flight `artifacts.upload.complete` is re-sent across
 * reconnects before the step is failed.
 *
 * Bounded so a flapping connection cannot loop forever. The overall wait is
 * bounded independently by ARTIFACT_COMPLETE_ACK_TIMEOUT_MS, whose timer is
 * never restarted across a hold or a resend.
 */
export const MAX_COMPLETE_RESEND_ATTEMPTS = 2;

/**
 * Tail shared by both give-up messages for an unacknowledged commit. The
 * operator must not be sent hunting for a lost artifact that in fact landed:
 * the orchestrator may well have committed it and only the ack was lost.
 */
const COMMIT_MAY_HAVE_LANDED = 'the artifact may have been committed';

/**
 * An `artifacts.upload.complete` awaiting its ack, shared by reference between
 * `pendingUserArtifactRequests`, `resendableCompletes`, `heldCompletes`, and the
 * ack timer's closure.
 *
 * `messageId` is mutated on every resend and is the single source of truth for
 * which key the pending currently lives under, so the timer always cleans up the
 * current entry rather than a stale pre-resend key.
 */
interface InFlightComplete {
  /** Current correlation id — re-keyed on every resend. */
  messageId: string;
  /** The frame to (re-)send, carrying the current `messageId`. */
  frame: AgentToOrchestratorMessage;
  /** How many times this complete has already been re-sent. */
  attempts: number;
  pending: {
    resolve: (response: ArtifactResponseIpc) => void;
    reject: (err: Error) => void;
  };
}

export type ConnectionState =
  'disconnected' | 'connecting' | 'authenticating' | 'registering' | 'registered';

export interface OrchestratorClientOptions {
  /** WebSocket URL of the orchestrator. */
  url: string;
  /** Agent's unique identifier. */
  agentId: string;
  /** Agent's label set for job routing. */
  labels: string[];
  /**
   * Agent-reported typed host-vars (the `KICI_PROPERTIES` bag). Reported at
   * registration and shallow-merged into the orchestrator's host roster.
   * Omitted / empty ⇒ no properties reported.
   */
  properties?: Record<string, string | number | boolean>;
  /** Callback invoked when a job.dispatch message is received. */
  onJobDispatch: (dispatch: JobDispatch) => void;
  /** Callback invoked when a job.cancel message is received. */
  onJobCancel: (cancel: JobCancel) => void;
  /** Agent authentication token (kat_ prefixed). When provided, sends auth.request before agent.register. */
  token?: string;
  /**
   * Self-bootstrap claim code. When set and no static `token` is present, the
   * client exchanges it for its own ephemeral credentials via
   * `scaler.claim-credentials` on WS open — before any auth / register — then
   * adopts the minted token, agentId, and labels. A rejected or expired code
   * fails permanently (no reconnect). Ignored when a static `token` is present.
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
   * Whether the agent was spawned by the orchestrator's auto-scaler.
   * Mirrors KICI_SCALER_MANAGED=1 from config; passed in so the client
   * doesn't have to read process.env directly.
   */
  scalerManaged?: boolean;
  /**
   * Supplies the inputs for the agent fleet mini-bundle on a fleet.logs.request.
   * Returns the agent's resolved config (redacted inside the bundle assembler),
   * the log directory, and the current Prometheus metrics text. Omitted in
   * tests / contexts that don't participate in fleet collection — the handler
   * then replies with an empty-config bundle.
   */
  getFleetBundleInputs?: () => Promise<{
    config: Record<string, unknown>;
    logDir?: string;
    metricsText?: string;
  }>;
}

/**
 * WebSocket client that connects the agent to the customer orchestrator.
 *
 * Handles:
 * - Registration handshake (sends agent.register on connect)
 * - Periodic heartbeat messages to keep the connection alive
 * - Auto-reconnect with exponential backoff (1s initial, 1.5x, jitter, 60s max)
 * - Job dispatch and cancel message routing to callbacks
 * - Event buffering during disconnection with flush on reconnect
 *
 * Mirrors the proven PlatformClient pattern from packages/orchestrator but adapted
 * for the agent-to-orchestrator protocol direction.
 */
export class OrchestratorClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private readonly eventBuffer: EventBuffer;
  private readonly logBuffer: LogBuffer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;

  /**
   * Agent-facing capabilities advertised by the orchestrator on `register.ack`.
   * Undefined until the first ack arrives, and on a pre-capability orchestrator
   * that never advertises — both cases mean "assume unsupported" for every
   * optional feature gated on it.
   */
  private orchCapabilities: OrchAgentCapabilities | undefined;

  // Log batching: accumulate lines and flush every 100ms or 50 lines
  private pendingLogBatch: string[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOG_BATCH_SIZE = 50;
  private static readonly LOG_FLUSH_INTERVAL_MS = 100;

  /** Pending upload URL requests awaiting orchestrator response. */
  private readonly pendingUploadRequests = new Map<
    string,
    {
      resolve: (url: string) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Pending event.emit requests awaiting orchestrator response. */
  private readonly pendingEventEmitRequests = new Map<
    string,
    {
      resolve: (response: { requestId: string; deliveryId?: string; error?: string }) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Pending agent.api.request calls awaiting orchestrator response. */
  private readonly pendingApiRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Pending scaler.claim-credentials requests awaiting orchestrator response. */
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

  /** Pending user-cache restore/save requests awaiting orchestrator response. */
  private readonly pendingUserCacheRequests = new Map<
    string,
    {
      resolve: (response: CacheResponseIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Pending user-artifact upload/download requests awaiting orchestrator response. */
  private readonly pendingUserArtifactRequests = new Map<
    string,
    {
      resolve: (response: ArtifactResponseIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * In-flight `artifacts.upload.complete` frames that are safe to re-send after a
   * reconnect, keyed by their current `messageId`.
   *
   * The commit is idempotent server-side (the storage key is derived server-side,
   * `initMeta` is a re-writable sidecar, and the DB insert is
   * `onConflict.doNothing()`), so a dropped ack means "we did not hear the
   * answer", not "it did not happen". `beginUpload` / `download` are deliberately
   * absent: `beginUpload` mints a presigned PUT and is not idempotent the same
   * way, and `download` is read-only and cheap to fail.
   */
  private readonly resendableCompletes = new Map<string, InFlightComplete>();

  /**
   * Completes taken off `pendingUserArtifactRequests` by the disconnect sweep and
   * parked until the next `register.ack` re-sends them. Their ack timers keep
   * running — parking does not extend the deadline.
   */
  private readonly heldCompletes = new Set<InFlightComplete>();

  /**
   * Pending step-approval requests awaiting the orchestrator's resolution.
   * No client-side timeout: the orchestrator owns the (org-/SDK-configured)
   * expiry and sends `step.approval-resolved: expired` when it lapses. The
   * workflow-runner carries an outer safety-net timeout.
   */
  private readonly pendingStepApprovals = new Map<
    string,
    {
      resolve: (response: StepApprovalResolvedIpc) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Pending concurrency report requests awaiting orchestrator ack. */
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

  /** Timestamp when the connection was lost, used for gap marker outage duration. */
  private disconnectedAt: number | null = null;

  /** Set to true when auth.failure is received. Prevents retrying with a bad token. */
  private authFailed = false;

  /**
   * Callback invoked when the client transitions to the 'registered' state.
   * Fires on both initial registration and re-registration after reconnection.
   * Used by server.ts to re-evaluate idle shutdown after reconnection.
   *
   * `pendingDispatch` is set by the orchestrator when a queued job has been
   * pre-bound to this agent and the dispatch.job message is in flight. The
   * agent must defer arming the short scaler-idle timer in this case.
   *
   * `warmPool` is set when this agent was pre-spawned to wait for work rather
   * than for a specific queued job. The agent must arm no idle timer at all:
   * the orchestrator's warm-pool reaper owns its lifetime.
   */
  onRegistered: ((info: { pendingDispatch: boolean; warmPool: boolean }) => void) | null = null;

  /**
   * Callback invoked when a self-bootstrap claim exchange fails permanently
   * (invalid / expired / already-consumed claim code, or the exchange itself
   * errored or timed out). Only ever fires in self-bootstrap mode
   * (`scalerClaimCode` set, no static token) — a statically-tokened agent never
   * runs the claim exchange. A one-shot self-bootstrap agent cannot make any
   * further progress after this, so server.ts wires it to a non-zero graceful
   * shutdown; without it the health HTTP server keeps the process alive and a
   * GitHub Actions run hangs until the job timeout.
   */
  onClaimFailedPermanently: ((reason: string) => void) | null = null;

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

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /** Number of messages currently buffered. */
  getBufferedCount(): number {
    return this.eventBuffer.size();
  }

  /**
   * Get the underlying WebSocket's bufferedAmount (bytes pending in the send queue).
   * Used by LogStreamer for backpressure detection.
   */
  getBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Register a one-time callback for the WebSocket 'drain' event.
   * Fires when the send buffer has been flushed to the kernel.
   * Used by LogStreamer to resume sending after backpressure.
   */
  onDrain(callback: () => void): void {
    this.ws?.once('drain', callback);
  }

  /**
   * Initiate connection to the orchestrator.
   * Starts the connect -> register -> registered lifecycle.
   */
  connect(): void {
    if (this._state !== 'disconnected') {
      logger.warn('connect() called while not disconnected', { state: this._state });
      return;
    }

    this.intentionalDisconnect = false;
    this.doConnect();
  }

  /**
   * Gracefully disconnect from the orchestrator. Does not trigger reconnection.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.cancelReconnect();

    // A complete parked by an earlier drop is waiting for a reconnect that is
    // no longer coming. Fail it closed now instead of leaving it to the ack
    // deadline, which the process may not outlive.
    this.rejectHeldCompletes('the agent disconnected');

    // Move any pending log batch to LogBuffer (they'll be sent on reconnect)
    this.drainPendingLogBatch();

    if (this.ws) {
      // 1000 = normal closure
      this.ws.close(1000, 'Agent disconnect');
      this.ws = null;
    }

    this._state = 'disconnected';
  }

  /**
   * Send a message to the orchestrator. If registered, sends immediately.
   * If not registered, buffers the message for later delivery.
   */
  send(message: AgentToOrchestratorMessage): void {
    if (this._state === 'registered' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.eventBuffer.add(message);
    }
  }

  /**
   * Send a message directly on the WebSocket without buffering.
   * Used for heartbeat and other protocol messages that must not be buffered.
   */
  sendDirect(message: AgentToOrchestratorMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Stream a log line to the orchestrator via agent.log messages.
   *
   * If connected and registered, lines are batched (up to 50 lines or 100ms)
   * and sent as agent.log messages. If disconnected, lines are buffered in the
   * LogBuffer for replay on reconnection.
   */
  streamLog(line: string): void {
    if (this._state === 'registered' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.pendingLogBatch.push(line);

      // Send immediately if batch reaches threshold
      if (this.pendingLogBatch.length >= OrchestratorClient.LOG_BATCH_SIZE) {
        this.sendLogBatch();
        return;
      }

      // Otherwise, set a flush timer if not already set
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

  /**
   * Request a pre-signed S3 upload URL from the orchestrator.
   *
   * Sends a cache.upload.request WS message and waits for a cache.upload.response.
   * Times out after 30 seconds.
   */
  async requestUploadUrl(
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      depsHash?: string;
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

  /**
   * Notify orchestrator that an S3 upload completed successfully.
   *
   * The orchestrator uses this to initialize metadata on the S3 object.
   */
  sendUploadComplete(
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      platform: string;
      arch: string;
      depsHash?: string;
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
   * Request a presigned PUT URL for a provenance bundle. Sends a
   * `provenance.upload.request` and waits for a `provenance.upload.response`
   * (resolved via the shared upload-request pending map). Times out after 30s.
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
   * Send an event.emit WS message to the orchestrator and await the response.
   *
   * Used by the job runner to relay custom event emissions from the sandbox
   * (ctx.emit()) to the orchestrator for persistence and routing.
   * Times out after 5 seconds (matching the sandbox-side timeout).
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
   * Send a scaler.claim-credentials WS message and await the response.
   *
   * Used by a provisioning workflow (via `ctx.kici.scaler.claimAgentCredentials`)
   * to exchange a single-use claim code — delivered on a `kici.scaler.scale-up`
   * event — for freshly minted ephemeral agent credentials. The token rides the
   * response only; it is never logged. Times out after 15 seconds (matching the
   * generic agent-API request timeout).
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
      }, 15_000);

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
   * Send a typed API request to the orchestrator and await the response.
   *
   * This is the transport layer for the agent private API. The SDK's typed
   * KiciApi interface calls this with dot-namespaced method names.
   */
  async sendApiRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApiRequests.delete(requestId);
        reject(new Error(`API request '${method}' timed out after 15s`));
      }, 15_000);

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
   * Relay a user-facing cache request from the sandbox to the orchestrator.
   *
   * Translates the sandbox `cache.request` IPC into the matching `cache.user.*`
   * WS message and resolves with the orchestrator's response mapped onto the
   * IPC response shape:
   *
   * - `restore` -> `cache.user.restore.request`, awaits `cache.user.restore.response`.
   * - `beginSave` -> `cache.user.save.request`, awaits `cache.user.save.response`.
   * - `completeSave` -> `cache.user.save.complete` (fire-and-forget; the
   *   orchestrator commits temp -> final without replying), resolves immediately.
   *
   * Times out after 30 seconds for the round-trip ops.
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
   * Relay a user-facing artifact request from the sandbox to the orchestrator.
   *
   * Translates the sandbox `artifacts.request` IPC into the matching
   * `artifacts.*` WS message and resolves with the orchestrator's response
   * mapped onto the IPC response shape:
   *
   * - `beginUpload` -> `artifacts.upload.request`, awaits `artifacts.upload.response`.
   * - `completeUpload` -> `artifacts.upload.complete`, awaits
   *   `artifacts.upload.complete.ack` when the orchestrator advertises the
   *   `artifactCompleteAck` capability, and rejects when the commit failed so
   *   the workflow step fails instead of losing the artifact behind a green run.
   *   Against an orchestrator that never advertises it, the message stays
   *   fire-and-forget and resolves immediately.
   * - `download` -> `artifacts.download.request`, awaits `artifacts.download.response`.
   *
   * Times out after 30 seconds for the round-trip ops.
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
        sizeBytes: request.sizeBytes!,
        sha256: request.sha256!,
        storageKey: request.storageKey!,
      } as AgentToOrchestratorMessage;

      if (!hasOrchAgentCapability(this.orchCapabilities, 'artifactCompleteAck')) {
        this.sendDirect(complete);
        return { type: 'artifacts.response', requestId: request.requestId };
      }

      return new Promise<ArtifactResponseIpc>((resolve, reject) => {
        // Shared by reference with the maps below, so `record.messageId` always
        // names the key the pending currently lives under — including after a
        // reconnect re-key. The timer is created once and is NEVER restarted, so
        // the hold-plus-resend sequence stays inside the same deadline an
        // uninterrupted ack wait gets.
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
   * Relay a provenance bundle upload operation to the orchestrator. Maps the
   * IPC `provenance.request` onto `requestProvenanceUploadUrl` (returns the
   * presigned URL) or `sendProvenanceUploadComplete` (fire-and-forget) and
   * returns the result on the IPC response shape.
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
   * Relay a step-level approval request to the orchestrator. Sends a
   * `step.approval-request` WS message and resolves with the orchestrator's
   * `step.approval-resolved` mapped onto the IPC response shape. No client-side
   * timeout — the orchestrator owns the approval expiry and replies with an
   * `expired` outcome when it lapses. Rejects only on disconnect (the relay
   * caller treats a rejection as a fail-closed reject).
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
   * Send a job.context message to the orchestrator.
   *
   * Conveys execution environment details (runtime, sandbox type, env vars)
   * for the Summary tab. The orchestrator enriches with orgId before forwarding to Platform.
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
   * Send a run.event message to the orchestrator.
   *
   * Emits infrastructure lifecycle events (clone, execution, teardown).
   * The orchestrator enriches with orgId before forwarding to Platform.
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
   * Send a job.concurrency.report WS message and wait for job.concurrency.ack.
   *
   * The orchestrator evaluates the concurrency group and responds with an action:
   * - proceed: continue with execution
   * - wait: release the agent slot, orchestrator will re-dispatch later
   * - cancel: cancel the job (superseded by newer run)
   *
   * Times out after 30 seconds.
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

    try {
      this.ws = new WebSocket(this.url, {
        // Cap maximum decompressed frame size so a rogue or compromised
        // orchestrator peer cannot OOM the agent with a compression bomb.
        // Without this, ws@8.x defaults to 100 MiB.
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

      // defense in depth: if the orchestrator closes with
      // WS_CLOSE_AGENT_AUTH_FAILED (4010), the auth context is gone for
      // good — the token was either never valid or has been revoked.
      // Treat this as a permanent failure even if the preceding
      // auth.failure message was lost / arrived garbled. Without this,
      // a missed auth.failure would leave intentionalDisconnect = false
      // and the reconnect loop would storm against a token the
      // orchestrator already rejected.
      if (code === WS_CLOSE_AGENT_AUTH_FAILED) {
        logger.error(
          'Orchestrator closed with auth-failed code -- token is invalid or revoked. NOT retrying.',
          { code, reason: reason.toString() },
        );
        this.authFailed = true;
        this.intentionalDisconnect = true;
      }

      this._state = 'disconnected';
      this.stopHeartbeat();

      // Drain any pending log batch into LogBuffer before marking disconnectedAt
      this.drainPendingLogBatch();
      this.disconnectedAt = Date.now();

      // Reject all pending upload requests on disconnect
      for (const [_id, pending] of this.pendingUploadRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingUploadRequests.clear();

      // Reject all pending event emit requests on disconnect
      for (const [_id, pending] of this.pendingEventEmitRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingEventEmitRequests.clear();

      // Reject all pending API requests on disconnect
      for (const [_id, pending] of this.pendingApiRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingApiRequests.clear();

      // Reject all pending scaler-credential claims on disconnect
      for (const [_id, pending] of this.pendingClaimCredentialsRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingClaimCredentialsRequests.clear();

      // Reject all pending user-cache requests on disconnect
      for (const [_id, pending] of this.pendingUserCacheRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingUserCacheRequests.clear();

      // Pending user-artifact requests on disconnect. An in-flight
      // `artifacts.upload.complete` is held for resend rather than rejected: the
      // orchestrator may have committed the artifact and only the ack was lost,
      // so failing here fails a step whose artifact exists. Everything else
      // (beginUpload / download) still fails fast — those are not idempotent.
      //
      // Holding is only safe when a reconnect is coming. `scheduleReconnect`
      // runs only for an unintentional disconnect, so on a deliberate shutdown a
      // held complete would never be re-sent — reject those immediately.
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

      // Same reasoning for completes parked by an *earlier* drop: this close is
      // deliberate (a shutdown, or a permanently rejected token), so no further
      // `register.ack` will re-send them.
      if (this.intentionalDisconnect) {
        this.rejectHeldCompletes('the agent disconnected');
      }

      // Reject all pending concurrency requests on disconnect
      for (const [_id, pending] of this.pendingConcurrencyRequests) {
        pending.reject(new Error('WebSocket disconnected'));
      }
      this.pendingConcurrencyRequests.clear();

      // Reject all pending step-approval requests on disconnect (the relay
      // caller fails the gate closed).
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

      // Close will fire after error, triggering reconnect there
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  /**
   * WS-open handshake driver.
   *
   * Self-bootstrap runs first: when a `scalerClaimCode` is set and no static
   * token is present, the client exchanges the single-use code for its own
   * ephemeral credentials over `scaler.claim-credentials` — before any auth or
   * register — and adopts the minted token, agentId, and labels. A rejected or
   * expired code fails permanently (no reconnect), so a one-shot provisioning
   * run exits visibly rather than looping.
   *
   * Then the normal handshake: with a token (static or just-minted) send
   * `auth.request` and register after `auth.success`; without one, register
   * directly (unauthenticated mode).
   */
  private async onWsOpen(): Promise<void> {
    if (this.scalerClaimCode && !this.token) {
      const adopted = await this.performClaimExchange(this.scalerClaimCode);
      if (!adopted) return; // permanent failure — do not auth or register
    }

    if (this.token) {
      // Token provided (static or minted): send auth.request first, then
      // agent.register after auth.success.
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
      // No token: send agent.register directly (unauthenticated mode)
      this._state = 'registering';
      logger.info('Connected to orchestrator, sending agent.register (no token)', {
        url: this.url,
        agentId: this.agentId,
      });

      this.sendAgentRegister();
    }
  }

  /**
   * Exchange the single-use claim code for ephemeral credentials, adopting the
   * minted token / agentId / labels on success. Returns true when credentials
   * were adopted; false when the claim failed permanently (the connection has
   * already been torn down with no reconnect).
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
   * Merge the claim-minted labels into the agent's own label set, deduped. The
   * self-reported `kici:os:` / `kici:arch:` / `kici:host:` facts are derived at
   * register time (`sendAgentRegister`), so they survive regardless.
   */
  private mergeClaimedLabels(claimed: string[]): string[] {
    return [...new Set([...this.labels, ...claimed])];
  }

  /**
   * Fail a self-bootstrap claim permanently, using the same no-reconnect
   * mechanism as `auth.failure`: mark the auth context dead, suppress reconnect,
   * and close the socket. A one-shot provisioning run then exits visibly.
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

    // A one-shot self-bootstrap agent has no path forward from here. Surface the
    // permanent failure so server.ts can terminate the process (non-zero)
    // instead of leaving the health server to keep it alive until a job timeout.
    this.onClaimFailedPermanently?.(reason);
  }

  /**
   * Resolve a pending user-artifact request from an `artifacts.upload.response`
   * / `artifacts.download.response` WS message, mapping the wire fields onto the
   * IPC response shape. No-op when no request is pending for the requestId.
   */
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
      // The orchestrator's internal-failure detail rides a dedicated IPC field:
      // putting it on `error` would make the sandbox throw a relay failure
      // instead of rendering the rejection.
      ...(artMsg.error && { rejectionDetail: artMsg.error }),
      ...(artMsg.downloadUrl && { downloadUrl: artMsg.downloadUrl }),
      ...(artMsg.sizeBytes !== undefined && { sizeBytes: artMsg.sizeBytes }),
      ...(artMsg.sha256 && { sha256: artMsg.sha256 }),
    });
  }

  /**
   * Resolve or reject a pending completeUpload from an
   * `artifacts.upload.complete.ack`. `committed` resolves the relayed IPC
   * request; `failed` rejects it (carrying the orchestrator's reason), which
   * propagates through the relay's `response.error` and fails the workflow step
   * rather than losing the artifact silently. No-op when nothing is pending for
   * the requestId (an ack for an already-timed-out complete).
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
   * Drop every trace of an in-flight upload-complete, whichever key it currently
   * lives under and whether or not it is parked awaiting a resend.
   *
   * Called from the ack timer, which fires on the original schedule regardless of
   * how many times the complete has been re-keyed since.
   */
  private forgetComplete(record: InFlightComplete): void {
    this.pendingUserArtifactRequests.delete(record.messageId);
    this.resendableCompletes.delete(record.messageId);
    this.heldCompletes.delete(record);
  }

  /**
   * Fail every parked upload-complete closed, for the paths where the reconnect
   * the park was betting on will never arrive (a deliberate shutdown, a
   * permanently rejected token). Naming the ambiguity keeps the operator from
   * hunting for an artifact that in fact landed.
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
   * Re-send every upload-complete parked by the disconnect sweep.
   *
   * Called from `register.ack`, once the new connection's capabilities are known.
   * Each frame is re-keyed with a fresh `messageId` before it goes out: the id is
   * the correlation key, so reusing it would let a late ack for the pre-disconnect
   * send resolve the new pending.
   *
   * The ack timer created when the complete was first sent is deliberately left
   * alone, so the hold plus every resend stays inside the original
   * ARTIFACT_COMPLETE_ACK_TIMEOUT_MS budget.
   */
  private resendHeldCompletes(): void {
    if (this.heldCompletes.size === 0) return;
    const held = [...this.heldCompletes];
    this.heldCompletes.clear();

    // A reconnected orchestrator that no longer acks cannot tell us the commit
    // landed. Resolving anyway would report success for an artifact we never saw
    // committed — the fail-open loss the ack exists to prevent — so give up
    // fail-closed instead, naming the ambiguity.
    const canAck = hasOrchAgentCapability(this.orchCapabilities, 'artifactCompleteAck');

    for (const record of held) {
      if (!canAck) {
        record.pending.reject(
          new Error(
            'artifact upload-complete cannot be acknowledged by the reconnected ' +
              `orchestrator — ${COMMIT_MAY_HAVE_LANDED}`,
          ),
        );
        continue;
      }

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
   * Route the orchestrator's replies to a relayed user-artifact request, which
   * are dispatched off the raw frame rather than the parsed protocol union.
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

  /**
   * Resolve a pending scaler credential-claim request from its response
   * message. Returns true when it handled the message. Extracted from
   * handleMessage so that dispatcher stays under the function-length limit.
   */
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

  /**
   * Complete registration: adopt the orchestrator's negotiated capabilities,
   * enter the `registered` state, flush everything parked while disconnected,
   * and hand the ack's lifetime flags to `onRegistered`.
   */
  private handleRegisterAck(msg: Extract<OrchestratorToAgentMessage, { type: 'register.ack' }>) {
    logger.info('Registration acknowledged by orchestrator', {
      agentId: msg.agentId,
      labels: msg.labels,
      scalerManaged: msg.scalerManaged,
      pendingDispatch: msg.pendingDispatch ?? false,
      warmPool: msg.warmPool ?? false,
    });

    // Optional agent-facing features are gated on what this orchestrator
    // advertises; absent means "stay on the unnegotiated behavior".
    this.orchCapabilities = msg.capabilities;

    // Transition to registered state
    this._state = 'registered';
    this.reconnectAttempts = 0;
    this.startHeartbeat();
    this.flushBuffer();

    // Completes parked by the disconnect sweep go out again now that this
    // connection's capabilities are known.
    this.resendHeldCompletes();

    this.onRegistered?.({
      pendingDispatch: msg.pendingDispatch ?? false,
      warmPool: msg.warmPool ?? false,
    });

    // Block MMDS access if in Firecracker/scaler-managed mode
    if (msg.scalerManaged || this.scalerManaged) {
      this.blockMmdsAccess();
    }

    // Send config.ack to orchestrator
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

    // Handle cache.upload.response (not part of the standard protocol schema)
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

    // Handle event.emit.response (orchestrator -> agent, response to sandbox event emission)
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

    // Handle scaler.claim-credentials.response (orchestrator -> agent, minted
    // ephemeral credentials for a provisioning workflow, or an error).
    if (this.handleClaimCredentialsResponse(rawMsg)) {
      return;
    }

    // Handle agent.api.response (orchestrator -> agent, response to API request)
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

    // Handle cache.user.restore.response / cache.user.save.response
    // (orchestrator -> agent, response to a relayed user-cache request).
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

    // Handle the orchestrator -> agent replies to a relayed user-artifact
    // request (upload/download responses and the upload-complete ack).
    if (this.handleArtifactReply(rawMsg.type, raw)) return;

    // Try orchestrator-to-agent protocol messages first
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
          this.authFailed = true;
          // Do not reconnect -- the token is bad
          this.intentionalDisconnect = true;
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
      }
      return;
    }

    // Try heartbeat from common schema (orchestrator heartbeat response)
    const heartbeat = heartbeatSchema.safeParse(raw);
    if (heartbeat.success) {
      // Heartbeat acknowledged, nothing to do
      return;
    }

    logger.warn('Invalid message from orchestrator', {
      errors: parsed.error.issues,
    });
  }

  private flushBuffer(): void {
    const events = this.eventBuffer.flush();
    const logLines = this.logBuffer.flush();

    // Insert gap marker if there are buffered items to replay or dropped items
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

      // Send gap marker as a log line before replay
      this.sendAgentLogMessage([gapMsg]);
    }

    // Clear disconnectedAt now that we've used it for the gap marker
    this.disconnectedAt = null;

    // Replay events with original timestamps (they are full message objects)
    if (events.length > 0) {
      logger.info('Flushing event buffer', { count: events.length });
      for (const msg of events) {
        this.sendDirect(msg);
      }
    }

    // Replay log lines in batches
    if (logLines.length > 0) {
      logger.info('Flushing log buffer', { count: logLines.length });
      for (let i = 0; i < logLines.length; i += OrchestratorClient.LOG_BATCH_SIZE) {
        const batch = logLines.slice(i, i + OrchestratorClient.LOG_BATCH_SIZE);
        this.sendAgentLogMessage(batch);
      }
    }

    // Reset dropped counters after gap marker has been sent
    this.eventBuffer.resetDroppedCount();
    this.logBuffer.resetDroppedCount();
  }

  /** Send the current pending log batch as an agent.log message. */
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

    // If ws is no longer open (e.g. transitioning to CLOSING), move lines to
    // the log buffer for replay on reconnection instead of dropping them.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      for (const line of lines) {
        this.logBuffer.add(line);
      }
      return;
    }

    this.sendAgentLogMessage(lines);
  }

  /** Send an agent.log message directly on the WebSocket. */
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

  /**
   * Drain pending log batch into the LogBuffer.
   * Called on disconnect to preserve pending lines for replay on reconnect.
   */
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
   * Block MMDS access via iptables.
   * Called in Firecracker/scaler-managed mode after receiving config via register.ack.
   * This prevents the agent (and any user code) from accessing MMDS metadata.
   */
  private blockMmdsAccess(): void {
    // iptables requires root (or CAP_NET_ADMIN). In container-scaler mode the agent
    // runs as non-root — network isolation is handled by the orchestrator's nftables
    // rules on the host. Skip gracefully instead of emitting a scary warning.
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

  /**
   * Send config.ack to orchestrator to confirm receipt of registration config.
   * This signals the orchestrator to clear MMDS data for Firecracker agents.
   */
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

  /**
   * Send agent.register message on the WebSocket.
   * Extracted to avoid duplication between authenticated and unauthenticated flows.
   */
  private sendAgentRegister(): void {
    const inFlightJobs = this.getInFlightJobs?.() ?? [];
    const autoLabels = [
      ...deriveOsArchLabels(os.platform(), os.arch()),
      hostLabel(os.hostname()),
      // What this host can do with containers. A self-reported FACT, like
      // os/arch/host — the orchestrator cannot know it, and the scaler cannot
      // predict it when it mints the agent's token.
      ...runtimeFactLabels(),
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
      // Static OS metadata
      hostname: os.hostname(),
      osRelease: os.release(),
      osVersion: os.version(),
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      cpuCount: os.cpus().length,
      nodeVersion: process.versions.node,
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

    // Do not retry if auth permanently failed (bad token)
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
