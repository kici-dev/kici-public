import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createLogger, requestContext, getReconnectDelay, toErrorMessage } from '@kici-dev/shared';
import {
  platformToOrchestratorMessageSchema,
  logPullPlatformToOrchSchema,
  joinRequestSchema,
  type OrchestratorToPlatformMessage,
  type PlatformToOrchestratorMessage,
  type WebhookRelay,
  type WebhookRelayResult,
  type TrustPolicyUpdate,
  type StaleCheckrunCleanup,
  type DashboardRunDetailRequest,
  type DashboardRunsListRequest,
  type DashboardRunsFiltersRequest,
  type DashboardSourcesListRequest,
  type DashboardStepLogsRequest,
  type DashboardAttestationsListRequest,
  type DashboardOrchLogsRequest,
  type RunRerunRequest,
  type ManualScheduleRequest,
  type RunCancelRequest,
  type DashboardPayloadRequest,
  type DashboardPlatformToOrchMessage,
  type TestRelayRequest,
  type DashboardDiagnosticsRequest,
  type DashboardScalerCapacityRequest,
  type DashboardScalerAgentsRequest,
  type JoinRequest,
  type JoinResponse,
  type SourceRegistration,
  ORCH_CAPABILITIES,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  type OrchCapabilities,
  type OrchRole,
} from '@kici-dev/engine';
import { EventBuffer } from './event-buffer.js';
import { RelayBufferRegistry, type RelayStartMeta } from '../webhook/relay-buffer.js';

/**
 * Verification + processing outcome returned by the chunked relay path's
 * `onVerifyInbound` callback. Mirrors the shape exported by
 * `webhook/verify-inbound.ts` so wiring is a single hand-off without an
 * adapter layer.
 */
export interface InboundVerifyOutcome {
  result: WebhookRelayResult;
  reason?: string;
}

const logger = createLogger({ prefix: 'platform-client' });

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'authenticated';

/**
 * A webhook source that this orchestrator manages.
 * Sent to Platform after auth.success so the Platform knows which
 * routing keys this orchestrator handles.
 *
 * Note: webhookSecret is no longer included. Secrets are pushed separately
 * via source.secrets after loading from PgSecretStore.
 *
 * Single source of truth lives in `../entry-helpers.ts`. Re-exported here
 * so existing imports of `ProviderSource` from `./platform-client.js` keep
 * working without churn.
 */
export type { ProviderSource } from '../entry-helpers.js';
import type { ProviderSource } from '../entry-helpers.js';

/**
 * Wire-shape for one source inside a `source.register` message — matches the
 * engine's Zod schema element exactly so we can hand it through without a
 * cast. Local alias keeps the call sites readable.
 */
type SourceRegistrationEntry = SourceRegistration['sources'][number];

/**
 * Convert an internal `ProviderSource` to the wire shape Platform expects.
 * Pulled out so every send path uses one mapping (post-auth bulk register,
 * runtime add via `sendSourceRegister`, diff-driven `updateSources`).
 */
function toSourceRegistrationEntry(source: ProviderSource): SourceRegistrationEntry {
  return {
    provider: source.provider,
    routingKey: source.routingKey,
    name: source.name,
    subtype: source.subtype,
  };
}

export interface PlatformClientOptions {
  /** WebSocket URL of the Platform relay. */
  url: string;
  /** API key for authentication. */
  token: string;
  /** Callback invoked when a webhook relay is received from Platform. */
  onWebhookRelay: (relay: WebhookRelay) => Promise<void>;
  /** Provider sources to register after authentication. */
  providerSources?: ProviderSource[];
  /** Orchestrator cluster instance ID (sent in source.register for peer correlation). */
  instanceId?: string;
  /**
   * Human-friendly cluster name resolved on orch boot
   * (`cluster_meta.cluster_name`). Sent in source.register so Platform
   * can route per-orch dashboard requests by this identifier.
   */
  clusterName?: string;
  /**
   * Orchestrator DB identifier (UUID, seeded by migration 001 in
   * `cluster_meta` key `'cluster_id'`). Sent in source.register so
   * Platform can warn when two unrelated clusters in the same org
   * accidentally share a `clusterName`. HA siblings share the same orch
   * DB and therefore the same `clusterId`.
   */
  clusterId?: string;
  /** Reachable address for peer-to-peer connections (from KICI_CLUSTER_ADDRESS env var). Null if not configured. */
  address?: string | null;
  /** Orchestrator version string (e.g. "0.0.1"). Sent in source.register for diagnostics. */
  version?: string;
  /** Orchestrator config mode. Sent in source.register for diagnostics. */
  mode?: string;
  /** Scaler backends configured (e.g. ["container", "firecracker"]). Sent in source.register for diagnostics. */
  scalerBackends?: string[];
  /** Whether this orchestrator has S3 log storage configured. Sent in source.register for pool validation. */
  s3LogAccess?: boolean;
  /** Queue timeout in ms. Sent in source.register for Platform safety-net GC. */
  queueTimeoutMs?: number;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Maximum reconnect delay in ms. Default: 60000 (60s). */
  maxReconnectDelayMs?: number;
  /** Maximum event buffer size. Default: 10000. */
  maxBufferSize?: number;
  /** Optional callback for log pull requests from Platform. */
  onLogPullRequest?: (msg: {
    messageId: string;
    executionId: string;
    jobName?: string;
    stepIndex?: number;
    cursor?: number;
    limit?: number;
  }) => void;

  /** Optional callback for peer discovery (from Platform matchmaker). */
  onPeerDiscover?: (peer: {
    connectionId: string;
    instanceId?: string;
    address: string | null;
    routingKeys: string[];
    orchRole?: OrchRole;
  }) => void;
  /** Optional callback invoked after successful authentication and source registration. */
  onAuthenticated?: () => void;
  /**
   * Optional callback invoked when the Platform surfaces the orchestrator's
   * canonical org id on `auth.success`. Used to auto-provision the
   * `remote_sources` anchor (`remote:<orgId>`) so Platform-relayed
   * `kici run remote` resolves the real tenant. Fires on every (re)connect;
   * provisioning is idempotent.
   */
  onOrgIdentified?: (info: { orgId: string; clusterId: string | null }) => void;
  /** Optional callback for dashboard run detail requests from Platform. */
  onDashboardRunDetail?: (msg: DashboardRunDetailRequest) => void;
  /** Optional callback for dashboard runs.list (operator console) requests from Platform. */
  onDashboardRunsList?: (msg: DashboardRunsListRequest) => void;
  /** Optional callback for dashboard runs.filters (operator console) requests from Platform. */
  onDashboardRunsFilters?: (msg: DashboardRunsFiltersRequest) => void;
  /** Optional callback for dashboard sources.list (operator console) requests from Platform. */
  onDashboardSourcesList?: (msg: DashboardSourcesListRequest) => void;
  /** Optional callback for dashboard step logs requests from Platform. */
  onDashboardStepLogs?: (msg: DashboardStepLogsRequest) => void;
  /** Optional callback for dashboard attestations-list requests from Platform. */
  onDashboardAttestationsList?: (msg: DashboardAttestationsListRequest) => void;
  /** Optional callback for run re-run requests from Platform (dashboard action). */
  onRunRerun?: (msg: RunRerunRequest) => void;
  /** Optional callback for manual schedule trigger requests from Platform (dashboard action). */
  onManualSchedule?: (msg: ManualScheduleRequest) => void;
  /** Optional callback for run cancel requests from Platform (dashboard action). */
  onRunCancel?: (msg: RunCancelRequest) => void;
  /** Optional callback for dashboard payload requests from Platform. */
  onDashboardPayload?: (msg: DashboardPayloadRequest) => void;
  /** Optional callback for dashboard orchestration logs requests from Platform. */
  onDashboardOrchLogs?: (msg: DashboardOrchLogsRequest) => void;
  /** Optional callback for dashboard environment/held-run messages from Platform. */
  onDashboardEnvMessage?: (msg: DashboardPlatformToOrchMessage) => void;
  /**
   * Optional callback for Platform-first `kici run remote` control-plane relay
   * requests (upload-init, trigger, status, logs, cancel). The handler performs
   * the action and replies over the WS keyed by `requestId`.
   */
  onTestRelay?: (msg: TestRelayRequest) => void;
  /** Optional callback for dashboard diagnostics requests from Platform. */
  onDashboardDiagnostics?: (msg: DashboardDiagnosticsRequest) => void;
  /** Optional callback for dashboard scaler capacity requests from Platform. */
  onDashboardScalerCapacity?: (msg: DashboardScalerCapacityRequest) => void;
  /** Optional callback for dashboard scaler agents requests from Platform. */
  onDashboardScalerAgents?: (msg: DashboardScalerAgentsRequest) => void;
  /** Optional callback for trust policy updates pushed from Platform. */
  onTrustPolicyUpdate?: (msg: TrustPolicyUpdate) => void;
  /** Optional callback for stale check run cleanup requests from Platform. */
  onStaleCheckrunCleanup?: (msg: StaleCheckrunCleanup) => void;
  /** Optional callback for join requests relayed via Platform. */
  onJoinRequest?: (msg: JoinRequest) => Promise<JoinResponse>;
  /** Custom orchestrator capabilities to merge with ORCH_CAPABILITIES in auth.request. */
  orchCapabilities?: Partial<OrchCapabilities>;
  /**
   * Verify a reassembled inbound webhook from the chunked relay path.
   *
   * Wired to `verifyInboundWebhook(deps, ...)` in production. Required when
   * Platform sends `webhook.relay.start`/`webhook.relay.chunk` (chunked path);
   * if absent, the orchestrator ACKs `rejected_misconfigured` because it
   * cannot perform the trust check the new design requires.
   */
  onVerifyInbound?: (
    meta: RelayStartMeta,
    body: Buffer,
  ) => Promise<InboundVerifyOutcome> | InboundVerifyOutcome;
  /**
   * Optional injected reassembly registry. Tests pass a registry with a short
   * TTL; production constructs a default one per PlatformClient.
   */
  relayBuffer?: RelayBufferRegistry;
}

/**
 * WebSocket client that connects the orchestrator to the Platform relay.
 *
 * Handles:
 * - Authentication handshake (auth.request -> auth.success/failure)
 * - Periodic heartbeat messages to keep the connection alive
 * - Auto-reconnect with exponential backoff (1s initial, 1.5x, jitter, 60s max)
 * - Webhook relay reception and ACK responses
 * - Event buffering during disconnection with flush on reconnect
 */
export class PlatformClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private readonly eventBuffer: EventBuffer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private readonly url: string;
  private readonly token: string;
  private readonly onWebhookRelay: (relay: WebhookRelay) => Promise<void>;
  private providerSources: ProviderSource[];
  /**
   * Pending `registerSourceAndAwait()` callers, keyed by routing key. Resolved
   * with the Platform-computed webhook URL when the matching
   * `source.register.ack` arrives, or rejected on timeout / disconnect.
   */
  private readonly pendingSourceRegistrations = new Map<
    string,
    {
      resolve: (url: string | null) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly instanceId?: string;
  private readonly clusterName?: string;
  private readonly clusterId?: string;
  private readonly address?: string | null;
  private readonly version?: string;
  private readonly mode?: string;
  private readonly scalerBackends?: string[];
  private readonly s3LogAccess?: boolean;
  private readonly queueTimeoutMs?: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onLogPullRequest?: PlatformClientOptions['onLogPullRequest'];

  private readonly onPeerDiscover?: PlatformClientOptions['onPeerDiscover'];
  private readonly onAuthenticated?: PlatformClientOptions['onAuthenticated'];
  private readonly onOrgIdentified?: PlatformClientOptions['onOrgIdentified'];
  private readonly onDashboardRunDetail?: PlatformClientOptions['onDashboardRunDetail'];
  private readonly onDashboardRunsList?: PlatformClientOptions['onDashboardRunsList'];
  private readonly onDashboardRunsFilters?: PlatformClientOptions['onDashboardRunsFilters'];
  private readonly onDashboardSourcesList?: PlatformClientOptions['onDashboardSourcesList'];
  private readonly onDashboardStepLogs?: PlatformClientOptions['onDashboardStepLogs'];
  private readonly onDashboardAttestationsList?: PlatformClientOptions['onDashboardAttestationsList'];
  private readonly onRunRerun?: PlatformClientOptions['onRunRerun'];
  private readonly onManualSchedule?: PlatformClientOptions['onManualSchedule'];
  private readonly onRunCancel?: PlatformClientOptions['onRunCancel'];
  private readonly onDashboardPayload?: PlatformClientOptions['onDashboardPayload'];
  private readonly onDashboardOrchLogs?: PlatformClientOptions['onDashboardOrchLogs'];
  private readonly onDashboardEnvMessage?: PlatformClientOptions['onDashboardEnvMessage'];
  private readonly onTestRelay?: PlatformClientOptions['onTestRelay'];
  private readonly onDashboardDiagnostics?: PlatformClientOptions['onDashboardDiagnostics'];
  private readonly onDashboardScalerCapacity?: PlatformClientOptions['onDashboardScalerCapacity'];
  private readonly onDashboardScalerAgents?: PlatformClientOptions['onDashboardScalerAgents'];
  private readonly onTrustPolicyUpdate?: PlatformClientOptions['onTrustPolicyUpdate'];
  private readonly onStaleCheckrunCleanup?: PlatformClientOptions['onStaleCheckrunCleanup'];
  private readonly onJoinRequest?: PlatformClientOptions['onJoinRequest'];
  private orchCapabilities: OrchCapabilities;
  private readonly onVerifyInbound?: PlatformClientOptions['onVerifyInbound'];
  private readonly relayBuffer: RelayBufferRegistry;
  /**
   * Public alias of the orchestrator's owning org as supplied by
   * Platform on `auth.success`. Used by the check-run emitter to build
   * outbound `details_url`s that hide the canonical `org_<12-char>` id.
   * `undefined` when the orchestrator runs against a Platform that
   * predates the alias plumbing, or before the first successful auth.
   */
  private _orgPublicAlias?: string;

  /**
   * Returns the cached public alias of the orchestrator's owning org,
   * or `undefined` if Platform has not supplied one yet. Read by
   * `check-run-reporter.ts` when building `details_url`.
   */
  getOrgPublicAlias(): string | undefined {
    return this._orgPublicAlias;
  }

  constructor(options: PlatformClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onWebhookRelay = options.onWebhookRelay;
    this.providerSources = options.providerSources ?? [];
    this.instanceId = options.instanceId;
    this.clusterName = options.clusterName;
    this.clusterId = options.clusterId;
    this.address = options.address;
    this.version = options.version;
    this.mode = options.mode;
    this.scalerBackends = options.scalerBackends;
    this.s3LogAccess = options.s3LogAccess;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.eventBuffer = new EventBuffer({ maxSize: options.maxBufferSize ?? 10_000 });
    this.onLogPullRequest = options.onLogPullRequest;

    this.onPeerDiscover = options.onPeerDiscover;
    this.onAuthenticated = options.onAuthenticated;
    this.onOrgIdentified = options.onOrgIdentified;
    this.onDashboardRunDetail = options.onDashboardRunDetail;
    this.onDashboardRunsList = options.onDashboardRunsList;
    this.onDashboardRunsFilters = options.onDashboardRunsFilters;
    this.onDashboardSourcesList = options.onDashboardSourcesList;
    this.onDashboardStepLogs = options.onDashboardStepLogs;
    this.onDashboardAttestationsList = options.onDashboardAttestationsList;
    this.onRunRerun = options.onRunRerun;
    this.onManualSchedule = options.onManualSchedule;
    this.onRunCancel = options.onRunCancel;
    this.onDashboardPayload = options.onDashboardPayload;
    this.onDashboardOrchLogs = options.onDashboardOrchLogs;
    this.onDashboardEnvMessage = options.onDashboardEnvMessage;
    this.onTestRelay = options.onTestRelay;
    this.onDashboardDiagnostics = options.onDashboardDiagnostics;
    this.onDashboardScalerCapacity = options.onDashboardScalerCapacity;
    this.onDashboardScalerAgents = options.onDashboardScalerAgents;
    this.onTrustPolicyUpdate = options.onTrustPolicyUpdate;
    this.onStaleCheckrunCleanup = options.onStaleCheckrunCleanup;
    this.onJoinRequest = options.onJoinRequest;
    this.orchCapabilities = { ...ORCH_CAPABILITIES, ...options.orchCapabilities };
    this.onVerifyInbound = options.onVerifyInbound;
    this.relayBuffer = options.relayBuffer ?? new RelayBufferRegistry();
  }

  /**
   * Merge `updates` into the stored orch capabilities and broadcast the
   * full set to Platform via `orch.capabilities.update`. Buffers via
   * `send()` when not yet authenticated. The next `auth.request` will
   * also carry the merged capabilities, so a reconnect-followed-by-
   * runtime-broadcast still ends Platform in the correct cache state.
   */
  broadcastCapabilities(updates: Partial<OrchCapabilities>): void {
    this.orchCapabilities = { ...this.orchCapabilities, ...updates };
    this.send({
      type: 'orch.capabilities.update',
      capabilities: this.orchCapabilities,
    });
  }

  /**
   * Current merged orchestrator capabilities. Read-only view used by
   * tests and diagnostics; mutate via `broadcastCapabilities`.
   */
  getCapabilities(): OrchCapabilities {
    return this.orchCapabilities;
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
   * Complete a chunked webhook relay: verify, process if accepted, ACK.
   *
   * Called from the `webhook.relay.chunk` handler once `relayBuffer.chunk(...)`
   * returns `{ status: 'completed' }`. This sequence is intentionally single-pass
   * and inside `requestContext.run` so trace propagation works end-to-end.
   */
  private async completeChunkedRelay(
    messageId: string,
    meta: RelayStartMeta,
    body: Buffer,
  ): Promise<void> {
    if (!this.onVerifyInbound) {
      logger.error('Chunked webhook.relay received but no onVerifyInbound configured', {
        messageId,
        deliveryId: meta.deliveryId,
      });
      this.sendDirect({
        type: 'webhook.ack',
        messageId,
        deliveryId: meta.deliveryId,
        result: 'rejected_misconfigured',
        reason: 'orchestrator has no verifyInbound handler wired',
      });
      return;
    }

    const outcome = await this.onVerifyInbound(meta, body);

    if (outcome.result !== 'accepted') {
      logger.warn('Chunked webhook.relay verify rejected', {
        messageId,
        deliveryId: meta.deliveryId,
        routingKey: meta.routingKey,
        result: outcome.result,
        reason: outcome.reason,
      });
      this.sendDirect({
        type: 'webhook.ack',
        messageId,
        deliveryId: meta.deliveryId,
        result: outcome.result,
        ...(outcome.reason && { reason: outcome.reason }),
      });
      return;
    }

    // Accepted: synthesize a WebhookRelay-shaped object so the existing
    // `onWebhookRelay` pipeline keeps working without a parallel API. The
    // payload is parsed from the body bytes when the content-type signals
    // JSON; otherwise we forward the raw body in the same `{rawBody,
    // contentType}` envelope the legacy single-frame relay used so generic
    // webhooks with non-JSON payloads still route correctly.
    const contentType = meta.headers['content-type'] ?? 'application/octet-stream';
    let payload: unknown;
    if (contentType.includes('application/json') || contentType === '') {
      try {
        payload = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
      } catch (err) {
        logger.warn('Accepted webhook body is not valid JSON; rejecting', {
          messageId,
          deliveryId: meta.deliveryId,
          error: toErrorMessage(err),
        });
        this.sendDirect({
          type: 'webhook.ack',
          messageId,
          deliveryId: meta.deliveryId,
          result: 'rejected_misconfigured',
          reason: 'webhook body is not valid JSON',
        });
        return;
      }
    } else {
      payload = { rawBody: body.toString('utf8'), contentType };
    }

    // ACK accepted FIRST so Platform can return 200 to the upstream sender
    // promptly; downstream processing (lock file fetch, trigger match, dispatch)
    // is fire-and-forget like the legacy single-frame path.
    this.sendDirect({
      type: 'webhook.ack',
      messageId,
      deliveryId: meta.deliveryId,
      result: 'accepted',
    });

    const relay: WebhookRelay = {
      type: 'webhook.relay',
      messageId,
      routingKey: meta.routingKey,
      deliveryId: meta.deliveryId,
      event: meta.event,
      action: meta.action ?? null,
      payload,
      ...(meta.requestId && { requestId: meta.requestId }),
    };

    this.onWebhookRelay(relay).catch((err) => {
      logger.error('Error processing chunked webhook relay', {
        messageId,
        deliveryId: meta.deliveryId,
        error: toErrorMessage(err),
      });
    });
  }

  /**
   * Initiate connection to the Platform relay.
   * Starts the connect -> authenticate -> ready lifecycle.
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
   * Gracefully disconnect from Platform. Does not trigger reconnection.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.cancelReconnect();

    if (this.ws) {
      // 1000 = normal closure
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    // Drop any in-flight chunked-relay reassembly buffers so their TTL timers
    // don't keep the process alive past disconnect.
    this.relayBuffer.clear();

    this._state = 'disconnected';
  }

  /**
   * Send a message to Platform. If authenticated, sends immediately.
   * If not authenticated, buffers the message for later delivery.
   */
  send(message: OrchestratorToPlatformMessage): void {
    if (this._state === 'authenticated' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.eventBuffer.add(message);
    }
  }

  /**
   * Send a raw message directly on the WebSocket, bypassing typed validation.
   * Used for log pull response messages (log.response) which are
   * NOT in the OrchestratorToPlatformMessage union (they are in the separate log pull schema).
   */
  sendRaw(data: unknown): void {
    if (this._state === 'authenticated' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Register a new source at runtime (e.g., after config reload adds a new GitHub app).
   * Separate from the post-auth registration which sends all sources at once.
   */
  sendSourceRegister(source: ProviderSource): void {
    this.send({
      type: 'source.register',
      messageId: randomUUID(),
      sources: [toSourceRegistrationEntry(source)],
      ...(this.instanceId && { instanceId: this.instanceId }),
      ...(this.clusterName && { clusterName: this.clusterName }),
      ...(this.clusterId && { clusterId: this.clusterId }),
      ...(this.address !== undefined && { address: this.address }),
      ...(this.version && { version: this.version }),
      ...(this.mode && { mode: this.mode as 'platform' | 'hybrid' | 'independent' }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
    });
  }

  /**
   * Deregister sources at runtime (e.g., after config reload removes a GitHub app).
   * Tells Platform to stop routing webhooks for these routing keys to this orchestrator.
   */
  sendSourceDeregister(source: { routingKey: string }): void {
    this.send({
      type: 'source.deregister',
      messageId: randomUUID(),
      routingKeys: [source.routingKey],
    });
  }

  /**
   * Diff current provider sources with new ones and send register/deregister as needed.
   * Convenience method for config reload that atomically updates routing.
   */
  updateSources(newSources: ProviderSource[]): void {
    const oldByKey = new Map(this.providerSources.map((s) => [s.routingKey, s]));
    const newByKey = new Map(newSources.map((s) => [s.routingKey, s]));

    // Deregister removed sources
    const removedKeys = this.providerSources
      .filter((s) => !newByKey.has(s.routingKey))
      .map((s) => s.routingKey);
    if (removedKeys.length > 0) {
      this.send({
        type: 'source.deregister',
        messageId: randomUUID(),
        routingKeys: removedKeys,
      });
    }

    // Register added or *changed* sources. The diff key is no longer just
    // routingKey: a rename (name change) or subtype change with the same
    // routing_key still needs to flow to Platform so the dashboard reflects
    // it. The Platform-side `onConflict.doUpdateSet` covers the upsert
    // semantics on the receiver, so re-sending an already-registered source
    // is safe and idempotent.
    const changedSources = newSources.filter((s) => {
      const prev = oldByKey.get(s.routingKey);
      if (!prev) return true; // added
      return prev.provider !== s.provider || prev.name !== s.name || prev.subtype !== s.subtype;
    });
    if (changedSources.length > 0) {
      this.send({
        type: 'source.register',
        messageId: randomUUID(),
        sources: changedSources.map(toSourceRegistrationEntry),
        ...(this.instanceId && { instanceId: this.instanceId }),
        ...(this.clusterName && { clusterName: this.clusterName }),
        ...(this.clusterId && { clusterId: this.clusterId }),
        ...(this.address !== undefined && { address: this.address }),
        ...(this.version && { version: this.version }),
        ...(this.mode && { mode: this.mode as 'platform' | 'hybrid' | 'independent' }),
        ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
        ...(this.s3LogAccess !== undefined && { s3LogAccess: this.s3LogAccess }),
        ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
      });
    } else if (newSources.length === 0 && this.providerSources.length > 0) {
      // Every source was removed. Re-announce with an empty set so the
      // Platform updates this connection's routing_keys to [] and keeps the
      // now-sourceless orchestrator recorded as connected (rather than going
      // silent and leaving stale routing keys behind).
      this.send({
        type: 'source.register',
        messageId: randomUUID(),
        sources: [],
        ...(this.instanceId && { instanceId: this.instanceId }),
        ...(this.clusterName && { clusterName: this.clusterName }),
        ...(this.clusterId && { clusterId: this.clusterId }),
        ...(this.address !== undefined && { address: this.address }),
        ...(this.version && { version: this.version }),
        ...(this.mode && { mode: this.mode as 'platform' | 'hybrid' | 'independent' }),
        ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
        ...(this.s3LogAccess !== undefined && { s3LogAccess: this.s3LogAccess }),
        ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
      });
    }

    // Update internal state
    this.providerSources.length = 0;
    this.providerSources.push(...newSources);
  }

  /**
   * Push the full source list to the Platform and resolve with the webhook URL
   * the Platform computed for `routingKey` (from the `source.register.ack`), or
   * `null` if the Platform has no public webhook base configured.
   *
   * Used by `kici-admin source add` (platform/hybrid mode) to print the URL
   * synchronously. Passing the **full** source list keeps this on the single
   * `updateSources` push path — the routing key being newly added means
   * `updateSources` emits a `source.register` whose ack carries the URL; the
   * later NOTIFY-driven republish then diffs to a no-op.
   *
   * Rejects on timeout or disconnect; the caller degrades to a "(unavailable)"
   * note rather than fabricating a URL.
   */
  registerSourceAndAwait(
    fullSources: ProviderSource[],
    routingKey: string,
    timeoutMs = 5000,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      // Reject a previous pending wait for the same key (shouldn't happen, but
      // never leak a resolver).
      const existing = this.pendingSourceRegistrations.get(routingKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('superseded by a newer registration'));
      }
      const timer = setTimeout(() => {
        this.pendingSourceRegistrations.delete(routingKey);
        reject(new Error(`timed out waiting for source.register.ack for ${routingKey}`));
      }, timeoutMs);
      this.pendingSourceRegistrations.set(routingKey, { resolve, reject, timer });
      this.updateSources(fullSources);
    });
  }

  /**
   * Reject every pending `registerSourceAndAwait()` — called on disconnect so a
   * `source add` issued while the link drops fails fast instead of hanging.
   */
  private rejectPendingSourceRegistrations(reason: string): void {
    for (const [, pending] of this.pendingSourceRegistrations) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingSourceRegistrations.clear();
  }

  getReconnectDelay(): number {
    return getReconnectDelay(this.reconnectAttempts, this.maxReconnectDelayMs);
  }

  // --- Internal methods ---

  private doConnect(): void {
    this._state = 'connecting';

    try {
      this.ws = new WebSocket(this.url, {
        //: cap maximum decompressed frame size so a rogue or
        // compromised Platform peer cannot OOM the orchestrator with a
        // compression bomb on the Platform→orch direction. Without this,
        // ws@8.x defaults to 100 MiB.
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
      this._state = 'authenticating';
      logger.info('Connected to Platform, sending auth request', { url: this.url });

      // Send auth.request with capabilities
      this.ws!.send(
        JSON.stringify({
          type: 'auth.request',
          token: this.token,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: this.orchCapabilities,
        }),
      );
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason.toString();
      logger.info('Platform connection closed', {
        code,
        reason: reasonText,
      });

      this._state = 'disconnected';
      this.stopHeartbeat();
      this.rejectPendingSourceRegistrations('Platform connection closed before ack');

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('Platform WebSocket error', { error: err.message });

      // Close will fire after error, triggering reconnect there
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      logger.warn('Malformed JSON received from Platform');
      return;
    }

    const parsed = platformToOrchestratorMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.handleNonStandardMessage(raw, parsed.error.issues);
      return;
    }

    const msg = parsed.data;
    this.dispatchPlatformMessage(msg);
  }

  /**
   * Try the two non-mainline schemas (log-pull, cluster join.request) when
   * the primary `platformToOrchestratorMessageSchema` failed to parse. Falls
   * back to a structured warning if neither schema matches.
   */
  private handleNonStandardMessage(raw: unknown, primaryIssues: unknown): void {
    // Try log pull messages (separate schema union)
    const logPullParsed = logPullPlatformToOrchSchema.safeParse(raw);
    if (logPullParsed.success) {
      this.onLogPullRequest?.(logPullParsed.data);
      return;
    }

    // Try join.request messages (relayed via Platform for cluster join flow)
    const joinParsed = joinRequestSchema.safeParse(raw);
    if (joinParsed.success && this.onJoinRequest) {
      this.onJoinRequest(joinParsed.data)
        .then((response) => {
          this.sendRaw(response);
        })
        .catch((err) => {
          logger.error('Error handling join request', { error: toErrorMessage(err) });
        });
      return;
    }

    // A dashboard request that fails primary schema validation (e.g. a malformed
    // body that omits a required field) still carries a requestId the Platform is
    // waiting on over its forward window. Emit a structured error response frame
    // so the Platform answers a fast 400 instead of timing out (10s 504). This is
    // the schema-validation-layer counterpart to the dispatch choke point in
    // guardedDashboardDispatch — both guarantee every forwarded dashboard request
    // gets exactly one response frame.
    if (this.respondToInvalidDashboardRequest(raw, primaryIssues)) {
      return;
    }

    logger.warn('Invalid message from Platform', {
      errors: primaryIssues,
    });
  }

  /**
   * If `raw` looks like a dashboard request (a `dashboard.*` type with a
   * requestId) that failed schema validation, send a structured error response
   * keyed to its requestId and return true. Returns false when the message is
   * not a recognisable dashboard request (let the caller log a warning).
   */
  private respondToInvalidDashboardRequest(raw: unknown, issues: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const { type, requestId } = raw as { type?: unknown; requestId?: unknown };
    if (typeof type !== 'string' || !type.startsWith('dashboard.')) return false;
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    logger.warn('Invalid dashboard request from Platform; answering structured error', {
      type,
      requestId,
      errors: issues,
    });
    this.sendRaw({
      type: `${type}.response`,
      requestId,
      error: `invalid dashboard request payload for ${type}`,
    });
    return true;
  }

  /**
   * Dispatch a parsed platform message to the appropriate per-area
   * handler. Each `case` either inlines a tiny dispatch (for one-line
   * forwards to a callback) or delegates to a private method when the
   * branch carries non-trivial logic.
   */
  private dispatchPlatformMessage(msg: PlatformToOrchestratorMessage): void {
    switch (msg.type) {
      case 'auth.success':
        this.handleAuthSuccess(msg);
        break;

      case 'auth.failure':
        this.handleAuthFailure(msg);
        break;

      case 'webhook.relay.start':
        this.handleWebhookRelayStart(msg);
        break;

      case 'webhook.relay.chunk':
        this.handleWebhookRelayChunk(msg);
        break;

      case 'source.register.ack':
        this.handleSourceRegisterAck(msg);
        break;

      case 'source.deregister.ack':
        logger.info('Source deregistration acknowledged', {
          removed: msg.removed,
        });
        break;

      case 'peer.discover':
        this.handlePeerDiscover(msg);
        break;

      case 'peer.update':
        this.handlePeerUpdate(msg);
        break;

      case 'dashboard.run.detail':
        logger.debug('Dashboard run detail request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardRunDetail?.(msg);
        break;

      case 'dashboard.runs.list':
        logger.debug('Dashboard runs list request received', {
          requestId: msg.requestId,
          actor: msg.actor,
        });
        this.onDashboardRunsList?.(msg);
        break;

      case 'dashboard.runs.filters':
        logger.debug('Dashboard runs filters request received', {
          requestId: msg.requestId,
          actor: msg.actor,
        });
        this.onDashboardRunsFilters?.(msg);
        break;

      case 'dashboard.sources.list':
        logger.debug('Dashboard sources list request received', {
          requestId: msg.requestId,
          actor: msg.actor,
        });
        this.onDashboardSourcesList?.(msg);
        break;

      case 'dashboard.step.logs':
        logger.debug('Dashboard step logs request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          jobId: msg.jobId,
          stepIndex: msg.stepIndex,
        });
        this.onDashboardStepLogs?.(msg);
        break;

      case 'dashboard.attestations.list':
        logger.debug('Dashboard attestations list request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardAttestationsList?.(msg);
        break;

      case 'run.rerun.request':
        logger.info('Run rerun request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          actor: msg.actor,
        });
        this.onRunRerun?.(msg);
        break;

      case 'run.manual_schedule.request':
        logger.info('Manual schedule request received', {
          requestId: msg.requestId,
          registrationId: msg.registrationId,
          actor: msg.actor,
        });
        this.onManualSchedule?.(msg);
        break;

      case 'run.cancel.request':
        logger.info('Run cancel request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          actor: msg.actor,
        });
        this.onRunCancel?.(msg);
        break;

      case 'dashboard.payload':
        logger.debug('Dashboard payload request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardPayload?.(msg);
        break;

      case 'dashboard.orch.logs':
        logger.debug('Dashboard orchestration logs request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          jobId: msg.jobId,
        });
        this.onDashboardOrchLogs?.(msg);
        break;

      case 'trust_policy.update':
        logger.info('Trust policy updated', { orgId: msg.orgId });
        this.onTrustPolicyUpdate?.(msg);
        break;

      case 'stale.checkrun.cleanup':
        logger.info('Stale check run cleanup request received', {
          runCount: msg.runs.length,
        });
        this.onStaleCheckrunCleanup?.(msg);
        break;

      // Diagnostics
      case 'dashboard.diagnostics':
        logger.debug('Dashboard diagnostics request received', {
          requestId: msg.requestId,
        });
        this.onDashboardDiagnostics?.(msg);
        break;

      // Scaler capacity
      case 'dashboard.scaler.capacity':
        logger.debug('Dashboard scaler capacity request received', {
          requestId: msg.requestId,
        });
        this.onDashboardScalerCapacity?.(msg);
        break;

      // Scaler agents (on-demand)
      case 'dashboard.scaler.agents':
        logger.debug('Dashboard scaler agents request received', {
          requestId: msg.requestId,
          scalerName: msg.scalerName,
        });
        this.onDashboardScalerAgents?.(msg);
        break;

      // Read + mutation attribution (access_log)
      case 'dashboard.access-log.list':
        logger.debug('Dashboard access-log list request received', {
          requestId: msg.requestId,
          orgId: msg.orgId,
        });
        this.onDashboardEnvMessage?.(msg);
        break;

      // Registrations + event-log + environment CRUD all share the same
      // generic onDashboardEnvMessage forwarding shape.
      case 'dashboard.registrations.list':
      case 'dashboard.registration.disable':
      case 'dashboard.registration.delete':
      case 'dashboard.event-log.list':
      case 'dashboard.event-log.detail':
      case 'dashboard.event-log.payload.stream':
      case 'dashboard.event-dlq.list':
      case 'dashboard.event-dlq.count':
      case 'dashboard.event-dlq.retry':
      case 'dashboard.event-dlq.discard':
      case 'dashboard.environments.list':
      case 'dashboard.environments.get':
      case 'dashboard.environments.create':
      case 'dashboard.environments.update':
      case 'dashboard.environments.test_access.set':
      case 'dashboard.environments.delete':
      case 'dashboard.environments.variables.list':
      case 'dashboard.environments.variables.set':
      case 'dashboard.environments.variables.delete':
      case 'dashboard.environments.source-overrides.list':
      case 'dashboard.environments.source-overrides.set':
      case 'dashboard.environments.source-overrides.delete':
      case 'dashboard.environments.bindings.list':
      case 'dashboard.environments.bindings.set':
      case 'dashboard.environments.secrets.list':
      case 'dashboard.environments.secrets.set':
      case 'dashboard.environments.secrets.delete':
      case 'dashboard.environments.secrets.scope.create':
      case 'dashboard.environments.secrets.scope.rename':
      case 'dashboard.environments.secrets.scope.delete':
      case 'dashboard.environments.history':
      case 'dashboard.held-runs.list':
      case 'dashboard.held-runs.approve':
      case 'dashboard.held-runs.reject':
      case 'dashboard.backends.list':
      case 'dashboard.backends.get':
      case 'dashboard.backends.sync':
      case 'dashboard.backends.sync.one':
      case 'dashboard.backends.test':
      case 'dashboard.global-workflows.get':
      case 'dashboard.global-workflows.update':
        logger.debug('Dashboard environment message received', {
          type: msg.type,
          requestId: msg.requestId,
        });
        this.onDashboardEnvMessage?.(msg);
        break;

      case 'test.relay.uploads.init':
      case 'test.relay.trigger':
      case 'test.relay.run.status':
      case 'test.relay.run.logs':
      case 'test.relay.cancel':
        logger.debug('Test-relay request received', {
          type: msg.type,
          requestId: msg.requestId,
        });
        this.onTestRelay?.(msg);
        break;

      default: {
        // Exhaustiveness check: every variant of PlatformToOrchestratorMessage
        // above must be handled. Adding a new variant to the union without a
        // matching case here will fail `pnpm typecheck` at this line.
        const _exhaustive: never = msg;
        void _exhaustive;
        logger.warn('Unknown platform message type', {
          type: (msg as { type?: string }).type,
        });
        break;
      }
    }
  }

  private handleAuthSuccess(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'auth.success' }>,
  ): void {
    logger.info('Authenticated with Platform', {
      connectionId: msg.connectionId,
      orgPublicAlias: msg.orgPublicAlias,
    });

    this._state = 'authenticated';
    this.reconnectAttempts = 0;
    // Cache the owning org's public alias for outbound URLs. Falls back
    // to whatever was set on the previous connection (typically the
    // same value); only overwritten when Platform actually supplies one.
    if (msg.orgPublicAlias) {
      this._orgPublicAlias = msg.orgPublicAlias;
    }
    // Surface the canonical org id so the server can auto-provision the
    // `remote_sources` anchor for Platform-relayed `kici run remote`.
    if (msg.orgId) {
      this.onOrgIdentified?.({ orgId: msg.orgId, clusterId: this.clusterId ?? null });
    }
    this.startHeartbeat();

    // Announce presence to the Platform. Always send source.register —
    // even with zero sources — so the Platform records this orchestrator
    // as connected (writes its platform_connections row and tracks the
    // connection) regardless of whether any sources are configured. A
    // sourceless orchestrator is a valid, connected orchestrator and must
    // be visible in the dashboard. onAuthenticated fires on the matching
    // source.register.ack (sent by the Platform for empty registrations too).
    this.sendDirect({
      type: 'source.register',
      messageId: randomUUID(),
      sources: this.providerSources.map(toSourceRegistrationEntry),
      ...(this.instanceId && { instanceId: this.instanceId }),
      ...(this.clusterName && { clusterName: this.clusterName }),
      ...(this.clusterId && { clusterId: this.clusterId }),
      ...(this.address !== undefined && { address: this.address }),
      ...(this.version && { version: this.version }),
      ...(this.mode && { mode: this.mode as 'platform' | 'hybrid' | 'independent' }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.s3LogAccess !== undefined && { s3LogAccess: this.s3LogAccess }),
      ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
    });
    logger.info('Sent source.register', {
      sources: this.providerSources.map((s) => s.routingKey),
      instanceId: this.instanceId,
      scalerBackends: this.scalerBackends ?? null,
    });

    this.flushBuffer();
  }

  private handleAuthFailure(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'auth.failure' }>,
  ): void {
    logger.error('Platform auth failed', { reason: msg.reason });

    // Close connection, schedule reconnect
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Auth failed');
    }
    // Don't set state here, the 'close' event handler does that
  }

  private handleWebhookRelayStart(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'webhook.relay.start' }>,
  ): void {
    // Allocate a per-messageId reassembly buffer. No ACK is sent until
    // the stream completes (or errors); Platform's AckWaiterRegistry has
    // a 5 s budget covering the whole start+chunks+ack sequence.
    const startRes = this.relayBuffer.start(msg.messageId, {
      routingKey: msg.routingKey,
      deliveryId: msg.deliveryId,
      event: msg.event,
      action: msg.action ?? null,
      signatureHeaderName: msg.signatureHeaderName ?? null,
      signatureHeader: msg.signatureHeader ?? null,
      clientIp: msg.clientIp ?? null,
      headers: msg.headers,
      totalSize: msg.totalSize,
      chunkCount: msg.chunkCount,
      ...(msg.requestId && { requestId: msg.requestId }),
    });
    if (startRes.status === 'error') {
      logger.warn('Rejecting webhook.relay.start', {
        messageId: msg.messageId,
        reason: startRes.reason,
      });
      this.sendDirect({
        type: 'webhook.ack',
        messageId: msg.messageId,
        deliveryId: msg.deliveryId,
        result: 'rejected_misconfigured',
        reason: startRes.reason,
      });
    } else {
      logger.info('Webhook relay stream started', {
        messageId: msg.messageId,
        deliveryId: msg.deliveryId,
        event: msg.event,
        chunkCount: msg.chunkCount,
        totalSize: msg.totalSize,
      });
    }
  }

  private handleWebhookRelayChunk(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'webhook.relay.chunk' }>,
  ): void {
    const applyRes = this.relayBuffer.chunk(msg.messageId, msg.sequence, msg.data, msg.final);

    if (applyRes.status === 'pending') {
      // More chunks expected; no ACK yet.
      return;
    }

    if (applyRes.status === 'error') {
      // We don't have meta in scope (the buffer was already dropped on
      // error). The deliveryId is required by webhookAckSchema; use the
      // messageId as a fallback so Platform can correlate via either id.
      logger.warn('Rejecting webhook.relay.chunk', {
        messageId: msg.messageId,
        sequence: msg.sequence,
        reason: applyRes.reason,
      });
      this.sendDirect({
        type: 'webhook.ack',
        messageId: msg.messageId,
        deliveryId: msg.messageId,
        result: 'rejected_misconfigured',
        reason: applyRes.reason,
      });
      return;
    }

    // Stream complete: verify, then process (if accepted), then ACK.
    const { meta, body } = applyRes;
    const reqId = meta.requestId ?? randomUUID();
    requestContext.run({ requestId: reqId, routingKey: meta.routingKey }, () => {
      this.completeChunkedRelay(msg.messageId, meta, body).catch((err) => {
        logger.error('Error completing chunked relay', {
          messageId: msg.messageId,
          error: toErrorMessage(err),
        });
        // Fall back to misconfigured ACK so Platform doesn't time out.
        this.sendDirect({
          type: 'webhook.ack',
          messageId: msg.messageId,
          deliveryId: meta.deliveryId,
          result: 'rejected_misconfigured',
          reason: 'orchestrator threw during verify+process',
        });
      });
    });
  }

  private handleSourceRegisterAck(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'source.register.ack' }>,
  ): void {
    const accepted = msg.accepted;
    const rejected = msg.rejected;

    if (accepted.length > 0) {
      logger.info('Source registration accepted', {
        routingKeys: accepted.map((a) => a.routingKey),
      });
    }

    // Resolve any pending registerSourceAndAwait() callers with the webhook
    // URL the Platform computed for their routing key.
    for (const entry of accepted) {
      const pending = this.pendingSourceRegistrations.get(entry.routingKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSourceRegistrations.delete(entry.routingKey);
        pending.resolve(entry.webhookUrl);
      }
    }
    if (rejected.length > 0) {
      logger.warn('Source registration rejected', {
        rejected: rejected.map((r) => `${r.routingKey}: ${r.reason}`),
      });
    }

    // Process peer discovery from ACK
    if (msg.peers && msg.peers.length > 0 && this.onPeerDiscover) {
      for (const peer of msg.peers) {
        logger.info('Peer discovered via source.register.ack', {
          connectionId: peer.connectionId,
          instanceId: peer.instanceId,
          address: peer.address,
          routingKeys: peer.routingKeys,
        });
        this.onPeerDiscover(peer);
      }
    }

    // Invoke onAuthenticated after source registration is processed
    this.onAuthenticated?.();
  }

  private handlePeerDiscover(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'peer.discover' }>,
  ): void {
    const { peer } = msg;
    logger.info('Peer discovered via Platform matchmaker', {
      connectionId: peer.connectionId,
      instanceId: peer.instanceId,
      address: peer.address,
      routingKeys: peer.routingKeys,
    });
    this.onPeerDiscover?.(peer);
  }

  private handlePeerUpdate(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'peer.update' }>,
  ): void {
    if (msg.peers && this.onPeerDiscover) {
      for (const peer of msg.peers) {
        logger.info('Peer discovered via peer.update', {
          connectionId: peer.connectionId,
          instanceId: peer.instanceId,
          address: peer.address,
          routingKeys: peer.routingKeys,
          orchRole: peer.orchRole,
        });
        this.onPeerDiscover(peer);
      }
    }
  }

  /**
   * Send a message directly on the WebSocket without buffering.
   * Used for ACK responses that must go immediately.
   */
  private sendDirect(message: OrchestratorToPlatformMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private flushBuffer(): void {
    const messages = this.eventBuffer.flush();
    if (messages.length > 0) {
      logger.info('Flushing event buffer', { count: messages.length });
      for (const msg of messages) {
        this.sendDirect(msg);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._state === 'authenticated' && this.ws?.readyState === WebSocket.OPEN) {
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

  private scheduleReconnect(): void {
    this.cancelReconnect();

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
