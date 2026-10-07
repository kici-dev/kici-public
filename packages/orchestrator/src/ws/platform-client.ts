import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createLogger, requestContext, getReconnectDelay, toErrorMessage } from '@kici-dev/shared';
import { chunkReplayRuns, REPLAY_BYTE_REFILL_BYTES_PER_SEC } from './replay-chunker.js';
import { stateReplayBreakerTripsTotal } from '../metrics/prometheus.js';
import {
  platformToOrchestratorMessageSchema,
  logPullPlatformToOrchSchema,
  joinRequestSchema,
  stateReplaySchema,
  type StateReplayRun,
  type OrchestratorToPlatformMessage,
  type PlatformToOrchestratorMessage,
  type WebhookRelay,
  type WebhookRelayResult,
  type TrustPolicyUpdate,
  type StaleCheckrunCleanup,
  type DashboardAttestationRetryRequest,
  type RunRerunRequest,
  type ManualScheduleRequest,
  type RunCancelRequest,
  type DashboardPlatformToOrchMessage,
  type TestRelayRequest,
  isJoinRequestFrame,
  type JoinResponse,
  type SourceRegistration,
  type DeploymentIdentity,
  type ConfigPaths,
  ORCH_CAPABILITIES,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  DASHBOARD_REQUEST_TYPE_SET,
  DashboardResponseErrorCode,
  buildUnsupportedMessageNack,
  collectDiscriminatorTypes,
  PLATFORM_TO_ORCH_RECOGNIZED_TYPES,
  CLUSTER_MEMBERSHIP_MAX_WORKERS,
  type OrchCapabilities,
  type OrchRole,
  type OrchestratorMode,
  type PlanHeadroom,
  type ClusterMembership,
} from '@kici-dev/engine';
import type { PlanHeadroomStore } from '../cluster/plan-headroom-store.js';
import { runDetached } from '../helpers/run-detached.js';
import { EventBuffer } from './event-buffer.js';
import { RelayBufferRegistry, type RelayStartMeta } from '../webhook/relay-buffer.js';
import type { AdmitResult } from '../webhook/ingest-admission.js';
import { wsUnsupportedMessageSentTotal, wsNackReceivedTotal } from '../metrics/prometheus.js';

/** Outcome of the chunked relay path's `onVerifyInbound`; mirrors `webhook/verify-inbound.ts`. */
export interface InboundVerifyOutcome {
  result: WebhookRelayResult;
  reason?: string;
}

const logger = createLogger({ prefix: 'platform-client' });

/**
 * Every message `type` this orchestrator recognizes on an inbound Platform frame:
 * the mainline Platform→orchestrator union (dashboard request types included) plus
 * the extra recognition-chain schemas `handleNonStandardMessage` tries separately
 * (log-pull, cluster join). A known-but-invalid frame (its `type` is in this set
 * but validation failed) is malformed, not version skew, so
 * `buildUnsupportedMessageNack` returns null and no spurious skew NACK is sent.
 * Derived from the schema discriminators so it can never drift.
 */
const PLATFORM_TO_ORCH_KNOWN_TYPES: ReadonlySet<string> = new Set<string>([
  ...PLATFORM_TO_ORCH_RECOGNIZED_TYPES,
  ...collectDiscriminatorTypes(logPullPlatformToOrchSchema),
  ...collectDiscriminatorTypes(joinRequestSchema),
  ...DASHBOARD_REQUEST_TYPE_SET,
]);

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'authenticated';

/**
 * Outcome of a chunked `state.replay` send. `skipped` names why the replay did
 * not complete: an empty payload, a frame that failed wire validation locally,
 * a socket that closed mid-send, or the circuit breaker being open.
 */
export type ReplaySendResult = {
  sent: number;
  chunks: number;
  skipped?: 'empty' | 'invalid' | 'disconnected' | 'breaker';
};

/**
 * A webhook source this orchestrator manages, registered with the Platform after
 * auth.success. Defined in `../entry-helpers.ts`; re-exported for existing importers.
 */
export type { ProviderSource } from '../entry-helpers.js';
import type { ProviderSource } from '../entry-helpers.js';

/**
 * Hard ceiling on how long an admitted fire-and-forget relay pipeline may hold
 * its admission slot. Past it the pipeline counts as hung and its slot is
 * force-released, so a hang cannot permanently shrink ingest capacity.
 *
 * Exported because the global eval round caps its inline wait ceiling at this
 * value: waiting past the force-release buys latency and no verdict.
 */
export const ADMITTED_PIPELINE_LIFETIME_MS = 5 * 60 * 1000;

/**
 * How long a connection must stay open after authenticating before it counts as
 * healthy enough to reset the reconnect backoff. Authentication succeeding is
 * not proof of viability — the state replay send is still ahead of it.
 */
const CONNECTION_STABLE_MS = 30_000;

/** Consecutive replay-attributed disconnects before replay is skipped entirely. */
const REPLAY_BREAKER_THRESHOLD = 3;

type SourceRegistrationEntry = SourceRegistration['sources'][number];

/** The one `ProviderSource` → wire mapping every `source.register` send path uses. */
function toSourceRegistrationEntry(source: ProviderSource): SourceRegistrationEntry {
  return {
    provider: source.provider,
    routingKey: source.routingKey,
    name: source.name,
    subtype: source.subtype,
    ...(source.slug ? { slug: source.slug } : {}),
  };
}

/**
 * A handler for one Platform frame. It may be async: the client runs it
 * through {@link PlatformClient.runFrameHandler}, which logs a failure and
 * keeps the connection.
 */
export type FrameHandler<M> = (msg: M) => void | Promise<void>;

/**
 * Platform → orchestrator frame types answered by exactly one dashboard / fleet
 * read handler, looked up in {@link PlatformClientOptions.dashboardHandlers}.
 */
export const DASHBOARD_FRAME_TYPES = [
  'dashboard.run.detail',
  'dashboard.run.structured',
  'dashboard.run.state',
  'dashboard.runs.list',
  'dashboard.runs.filters',
  'dashboard.sources.list',
  'dashboard.admin-tokens.list',
  'dashboard.step.logs',
  'dashboard.attestations.list',
  'dashboard.attestations.list.all',
  'dashboard.attestation.get',
  'dashboard.artifacts.list',
  'dashboard.payload',
  'dashboard.orch.logs',
  'dashboard.diagnostics',
  'dashboard.scaler.capacity',
  'dashboard.scaler.agents',
  'dashboard.fleet.hosts',
  'dashboard.fleet.host',
  'dashboard.fleet.preview',
  'dashboard.fleet.workflows-for-host',
] as const satisfies readonly PlatformToOrchestratorMessage['type'][];
export type DashboardFrameType = (typeof DASHBOARD_FRAME_TYPES)[number];
/** One optional handler per {@link DASHBOARD_FRAME_TYPES} entry, typed by its frame. */
export type DashboardFrameHandlers = {
  [K in DashboardFrameType]?: FrameHandler<Extract<PlatformToOrchestratorMessage, { type: K }>>;
};
type DashboardFrame = Extract<PlatformToOrchestratorMessage, { type: DashboardFrameType }>;
const DASHBOARD_FRAME_SET: ReadonlySet<string> = new Set(DASHBOARD_FRAME_TYPES);
const isDashboardFrame = (msg: PlatformToOrchestratorMessage): msg is DashboardFrame =>
  DASHBOARD_FRAME_SET.has(msg.type);

/** Frame fields worth a debug line when a dashboard frame arrives. */
const DASHBOARD_FRAME_LOG_FIELDS = [
  'requestId',
  'runId',
  'jobId',
  'stepIndex',
  'attestationId',
  'agentId',
  'workflowName',
  'scalerName',
  'actor',
] as const;

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
  /** `cluster_meta.cluster_name`; the Platform routes per-orch dashboard requests by it. */
  clusterName?: string;
  /**
   * `cluster_meta.cluster_id` (UUID). Lets the Platform warn when two unrelated
   * clusters in one org share a `clusterName`; HA siblings share one DB and so one id.
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
  /** How the orchestrator process was deployed. Sent in source.register so the dashboard can build the correct kici-admin invocation. */
  deployment?: DeploymentIdentity;
  /** Where this orchestrator's own config files live on its host. Sent in source.register so the dashboard can point an operator at them. */
  configPaths?: ConfigPaths;
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
  onLogPullRequest?: FrameHandler<{
    messageId: string;
    executionId: string;
    jobName?: string;
    stepIndex?: number;
    cursor?: number;
    limit?: number;
  }>;

  /** Optional callback for peer discovery (from Platform matchmaker). */
  onPeerDiscover?: (peer: {
    connectionId: string;
    instanceId?: string;
    address: string | null;
    routingKeys: string[];
    orchRole?: OrchRole;
  }) => void;
  /** Optional callback invoked after successful authentication and source registration. */
  onAuthenticated?: () => void | Promise<void>;
  /** Connected worker peers for `cluster.membership`; undefined off-coordinator → none reported. */
  getWorkerPeers?: () => Array<{ instanceId: string }>;
  /**
   * Persisted Platform-pushed worker ceiling, written on every `plan.headroom`.
   * Undefined → no ceiling, worker joins are admitted freely.
   */
  planHeadroomStore?: PlanHeadroomStore;
  /**
   * Reconcile this coordinator's workers against a pushed ceiling. Invoked on
   * EVERY `plan.headroom` frame with the frame's `evictExcess` flag, so a raised
   * ceiling (or a cleared `evictExcess`) can cancel an in-flight drain, not only
   * start one. Undefined → no eviction reconciliation.
   */
  onPlanCeiling?: (ceiling: number, evictExcess: boolean) => void;
  /**
   * Fires with the canonical org id from `auth.success` on every (re)connect, to
   * idempotently provision the `remote:<orgId>` anchor `kici run remote` resolves.
   */
  onOrgIdentified?: (info: { orgId: string; clusterId: string | null }) => void;
  onDashboardAttestationRetry?: FrameHandler<DashboardAttestationRetryRequest>;
  onRunRerun?: FrameHandler<RunRerunRequest>;
  onManualSchedule?: FrameHandler<ManualScheduleRequest>;
  onRunCancel?: FrameHandler<RunCancelRequest>;
  /** Handlers for the {@link DASHBOARD_FRAME_TYPES} read frames; a type with none is dropped. */
  dashboardHandlers?: DashboardFrameHandlers;
  /** Dashboard environment / held-run messages. */
  onDashboardEnvMessage?: FrameHandler<DashboardPlatformToOrchMessage>;
  /** `kici run remote` control-plane relay requests; the handler replies keyed by `requestId`. */
  onTestRelay?: FrameHandler<TestRelayRequest>;
  onTrustPolicyUpdate?: FrameHandler<TrustPolicyUpdate>;
  onStaleCheckrunCleanup?: FrameHandler<StaleCheckrunCleanup>;
  /** Optional handler for join.request frames relayed by the Platform. It answers every such frame. */
  onJoinRequest?: (raw: unknown) => Promise<JoinResponse>;
  /** Custom orchestrator capabilities to merge with ORCH_CAPABILITIES in auth.request. */
  orchCapabilities?: Partial<OrchCapabilities>;
  /**
   * Verify a reassembled chunked-relay webhook. Without it every chunked relay
   * is ACKed `rejected_misconfigured`, since the trust check cannot run.
   */
  onVerifyInbound?: (
    meta: RelayStartMeta,
    body: Buffer,
  ) => Promise<InboundVerifyOutcome> | InboundVerifyOutcome;
  /** Reassembly registry override (tests use a short TTL). */
  relayBuffer?: RelayBufferRegistry;
  /**
   * Webhook-ingest admission, called BEFORE signature verification so an
   * unverified flood is throttled too (verify reads the DB). A shed acks
   * `shed_retry_later` (429); an admitted slot is held for the pipeline's
   * lifetime. Absent → no admission gate.
   */
  onAdmit?: (routingKey: string) => Promise<AdmitResult>;
  /**
   * Records a shed delivery durably (an `event_log` breadcrumb, plus an
   * overflow-buffer row when enabled) before the shed ack. Best-effort: a
   * failure never blocks the ack.
   */
  onShedCapture?: (meta: RelayStartMeta, body: Buffer, reason: string) => Promise<void>;
}

/** Error `*.response` frame shape for a dashboard request that failed validation. */
export interface DashboardRequestErrorFrame {
  type: string;
  requestId: string;
  error: string;
  code: string;
  orchVersion?: string;
  requestType: string;
}

/**
 * Build the error `*.response` frame for a dashboard request that failed schema
 * validation, distinguishing a request type this build has never heard of
 * (version mismatch → upgrade the orchestrator) from a known type with a
 * malformed body (genuine client error).
 */
export function classifyDashboardRequestError(
  raw: { type: string; requestId: string },
  knownTypes: ReadonlySet<string>,
  orchVersion: string | undefined,
): DashboardRequestErrorFrame {
  const known = knownTypes.has(raw.type);
  const code = known
    ? DashboardResponseErrorCode.enum.invalid_payload
    : DashboardResponseErrorCode.enum.unsupported_request_type;
  const error = known
    ? `invalid dashboard request payload for ${raw.type}`
    : `This orchestrator (v${orchVersion ?? 'unknown'}) does not support '${raw.type}'. Upgrade the orchestrator to use this feature.`;
  return {
    type: `${raw.type}.response`,
    requestId: raw.requestId,
    error,
    code,
    ...(orchVersion ? { orchVersion } : {}),
    requestType: raw.type,
  };
}

/**
 * The orchestrator's WebSocket link to the Platform relay: auth handshake,
 * heartbeat, jittered exponential reconnect, webhook relay + ACK, and event
 * buffering while disconnected.
 */
export class PlatformClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private readonly eventBuffer: EventBuffer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private membershipTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** Armed on auth; resets the backoff only if the connection survives it. */
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the current connection has survived CONNECTION_STABLE_MS. */
  private connectionProvenStable = false;
  /** True once a state replay has been sent on the current connection. */
  private replaySentOnConnection = false;
  private replayConsecutiveFailures = 0;
  private replayBreakerOpen = false;
  private intentionalDisconnect = false;
  private readonly url: string;
  private readonly token: string;
  private readonly onWebhookRelay: (relay: WebhookRelay) => Promise<void>;
  private providerSources: ProviderSource[];
  /** `registerSourceAndAwait()` waiters by routing key, settled by ack, timeout or disconnect. */
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
  private readonly deployment?: DeploymentIdentity;
  private readonly configPaths?: ConfigPaths;
  private readonly s3LogAccess?: boolean;
  private readonly queueTimeoutMs?: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onLogPullRequest?: PlatformClientOptions['onLogPullRequest'];

  private readonly onPeerDiscover?: PlatformClientOptions['onPeerDiscover'];
  private readonly onAuthenticated?: PlatformClientOptions['onAuthenticated'];
  private readonly getWorkerPeers?: PlatformClientOptions['getWorkerPeers'];
  private readonly planHeadroomStore?: PlanHeadroomStore;
  private readonly onPlanCeiling?: PlatformClientOptions['onPlanCeiling'];
  private readonly onOrgIdentified?: PlatformClientOptions['onOrgIdentified'];
  private readonly onDashboardAttestationRetry?: PlatformClientOptions['onDashboardAttestationRetry'];
  private readonly onRunRerun?: PlatformClientOptions['onRunRerun'];
  private readonly onManualSchedule?: PlatformClientOptions['onManualSchedule'];
  private readonly onRunCancel?: PlatformClientOptions['onRunCancel'];
  private readonly dashboardHandlers: DashboardFrameHandlers;
  private readonly onDashboardEnvMessage?: PlatformClientOptions['onDashboardEnvMessage'];
  private readonly onTestRelay?: PlatformClientOptions['onTestRelay'];
  private readonly onTrustPolicyUpdate?: PlatformClientOptions['onTrustPolicyUpdate'];
  private readonly onStaleCheckrunCleanup?: PlatformClientOptions['onStaleCheckrunCleanup'];
  private readonly onJoinRequest?: PlatformClientOptions['onJoinRequest'];
  private orchCapabilities: OrchCapabilities;
  private readonly onVerifyInbound?: PlatformClientOptions['onVerifyInbound'];
  private readonly onAdmit?: PlatformClientOptions['onAdmit'];
  private readonly onShedCapture?: PlatformClientOptions['onShedCapture'];
  private readonly relayBuffer: RelayBufferRegistry;
  /**
   * Owning org's public alias from `auth.success`, used for outbound check-run
   * `details_url`s so they hide the canonical `org_<12-char>` id.
   */
  private _orgPublicAlias?: string;

  private _orgId?: string;

  private _githubWebhookUrl?: string | null;

  getOrgPublicAlias(): string | undefined {
    return this._orgPublicAlias;
  }

  /**
   * Canonical org id from `auth.success` (`undefined` before it). The Platform
   * refuses a generic routing key (`generic:<orgId>:<id>`) naming another org,
   * so source-create reads this to refuse a mismatched `--org` up front rather
   * than create a source that never delivers.
   */
  getOrgId(): string | undefined {
    return this._orgId;
  }

  /**
   * The hosted Platform's org-scoped GitHub App webhook URL
   * (`<base>/webhook/<orgId>/github`) from the last `auth.success`. `null` when
   * the Platform has no public webhook base; `undefined` before the first
   * successful auth or when the Platform does not send the field.
   */
  getGithubWebhookUrl(): string | null | undefined {
    return this._githubWebhookUrl;
  }

  constructor(options: PlatformClientOptions) {
    // Prime the breaker counter so its series exists from boot. An OTel counter
    // that has never been incremented exports nothing, and an alert against an
    // absent series can never fire — the "dark alert" class this repo already
    // tracks. A rare-event counter must be born at zero, not on first trip.
    stateReplayBreakerTripsTotal.add(0);
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
    this.deployment = options.deployment;
    this.configPaths = options.configPaths;
    this.s3LogAccess = options.s3LogAccess;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.eventBuffer = new EventBuffer({ maxSize: options.maxBufferSize ?? 10_000 });
    this.onLogPullRequest = options.onLogPullRequest;

    this.onPeerDiscover = options.onPeerDiscover;
    this.onAuthenticated = options.onAuthenticated;
    this.getWorkerPeers = options.getWorkerPeers;
    this.planHeadroomStore = options.planHeadroomStore;
    this.onPlanCeiling = options.onPlanCeiling;
    this.onOrgIdentified = options.onOrgIdentified;
    this.onDashboardAttestationRetry = options.onDashboardAttestationRetry;
    this.onRunRerun = options.onRunRerun;
    this.onManualSchedule = options.onManualSchedule;
    this.onRunCancel = options.onRunCancel;
    this.dashboardHandlers = options.dashboardHandlers ?? {};
    this.onDashboardEnvMessage = options.onDashboardEnvMessage;
    this.onTestRelay = options.onTestRelay;
    this.onTrustPolicyUpdate = options.onTrustPolicyUpdate;
    this.onStaleCheckrunCleanup = options.onStaleCheckrunCleanup;
    this.onJoinRequest = options.onJoinRequest;
    this.orchCapabilities = { ...ORCH_CAPABILITIES, ...options.orchCapabilities };
    this.onVerifyInbound = options.onVerifyInbound;
    this.onAdmit = options.onAdmit;
    this.onShedCapture = options.onShedCapture;
    this.relayBuffer = options.relayBuffer ?? new RelayBufferRegistry();
  }

  /**
   * Merge `updates` and broadcast the full set (buffered while unauthenticated).
   * The next `auth.request` carries the merged set too, so a reconnect cannot
   * leave the Platform's cache stale.
   */
  broadcastCapabilities(updates: Partial<OrchCapabilities>): void {
    this.orchCapabilities = { ...this.orchCapabilities, ...updates };
    this.send({
      type: 'orch.capabilities.update',
      capabilities: this.orchCapabilities,
    });
  }

  getCapabilities(): OrchCapabilities {
    return this.orchCapabilities;
  }

  get state(): ConnectionState {
    return this._state;
  }

  getBufferedCount(): number {
    return this.eventBuffer.size();
  }

  /**
   * Verify, process if accepted, and ACK a fully reassembled chunked relay.
   * Runs single-pass inside `requestContext.run` so trace propagation holds.
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

    // Admission control BEFORE signature verify: verify does a DB read, so
    // gating after it would leave an unverified flood un-throttled. Admit on the
    // Platform-established routing key (available pre-verify). The WS ack is
    // awaited synchronously by Platform (5 s budget), so this path never queues
    // — the controller grants immediately or sheds `shed_retry_later` (429).
    const admit = this.onAdmit ? await this.onAdmit(meta.routingKey) : undefined;
    if (admit && !admit.admitted) {
      logger.warn('Chunked webhook.relay shed by ingest admission control', {
        messageId,
        deliveryId: meta.deliveryId,
        routingKey: meta.routingKey,
        reason: admit.reason,
      });
      // Additively record the shed delivery: an `event_log` breadcrumb so it is
      // distinguishable from a delivery that never arrived, and a durable
      // overflow row for replay once capacity recovers. Best-effort — a
      // recording failure never blocks the shed_retry_later ack.
      if (this.onShedCapture) {
        try {
          await this.onShedCapture(meta, body, admit.reason);
        } catch (err) {
          logger.warn('Failed to record shed relay delivery', {
            deliveryId: meta.deliveryId,
            error: toErrorMessage(err),
          });
        }
      }
      this.sendDirect({
        type: 'webhook.ack',
        messageId,
        deliveryId: meta.deliveryId,
        result: 'shed_retry_later',
      });
      return;
    }
    // From here every exit path must release the admitted slot exactly once.
    const releaseSlot = admit?.admitted ? admit.release : (): void => {};

    const outcome = await this.onVerifyInbound(meta, body);

    if (outcome.result !== 'accepted') {
      releaseSlot();
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

    // Feed `onWebhookRelay` a WebhookRelay: JSON bodies are parsed, anything
    // else travels as a `{rawBody, contentType}` envelope so non-JSON generic
    // webhooks still route.
    const contentType = meta.headers['content-type'] ?? 'application/octet-stream';
    let payload: unknown;
    if (contentType.includes('application/json') || contentType === '') {
      try {
        payload = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
      } catch (err) {
        releaseSlot();
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

    // ACK FIRST so the Platform answers the sender promptly; the pipeline
    // below is fire-and-forget.
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

    // Release the slot exactly once: on completion, error, or the lifetime
    // timeout (a late completion after a timeout-release is safe).
    // Promise.resolve().then keeps a synchronous throw inside the finally.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      releaseSlot();
    };
    const lifetimeTimer = setTimeout(() => {
      logger.warn(
        'Chunked webhook.relay pipeline exceeded admitted lifetime; force-releasing slot',
        {
          messageId,
          deliveryId: meta.deliveryId,
        },
      );
      releaseOnce();
    }, ADMITTED_PIPELINE_LIFETIME_MS);
    lifetimeTimer.unref?.();
    Promise.resolve()
      .then(() => this.onWebhookRelay(relay))
      .catch((err) => {
        logger.error('Error processing chunked webhook relay', {
          messageId,
          deliveryId: meta.deliveryId,
          error: toErrorMessage(err),
        });
      })
      .finally(() => {
        clearTimeout(lifetimeTimer);
        releaseOnce();
      });
  }

  connect(): void {
    if (this._state !== 'disconnected') {
      logger.warn('connect() called while not disconnected', { state: this._state });
      return;
    }

    this.intentionalDisconnect = false;
    this.doConnect();
  }

  /** Graceful disconnect; does not reconnect. */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.stopClusterMembership();
    this.clearStabilityTimer();
    this.cancelReconnect();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    // Reassembly TTL timers would otherwise keep the process alive.
    this.relayBuffer.clear();

    this._state = 'disconnected';
  }

  /** Send now when authenticated, otherwise buffer for the next connection. */
  send(message: OrchestratorToPlatformMessage): void {
    if (this._state === 'authenticated' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.eventBuffer.add(message);
    }
  }

  /**
   * Send the reconnect state replay as paced frames, each within the wire
   * schema's run cap and the Platform limiter's byte budget: a breaching frame
   * gets a 4003 close and, since reconnecting does not shrink it, is resent forever.
   *
   * Uses `this.ws.send`, not `send()`, so a dropped connection abandons the
   * replay instead of buffering its tail for the next one. The Platform upserts
   * per run, so the next reconnect replays from scratch.
   */
  async sendStateReplay(runs: StateReplayRun[]): Promise<ReplaySendResult> {
    if (runs.length === 0) return { sent: 0, chunks: 0, skipped: 'empty' };

    if (this.replayBreakerOpen) {
      logger.warn('Skipping state replay — breaker open after consecutive rejections', {
        consecutiveFailures: this.replayConsecutiveFailures,
        runCount: runs.length,
      });
      return { sent: 0, chunks: 0, skipped: 'breaker' };
    }

    const chunks = chunkReplayRuns(runs);
    let sent = 0;

    for (const [index, chunk] of chunks.entries()) {
      if (this._state !== 'authenticated' || this.ws?.readyState !== WebSocket.OPEN) {
        logger.warn('Abandoning state replay — connection no longer open', {
          chunksSent: index,
          chunksTotal: chunks.length,
          runsSent: sent,
        });
        return { sent, chunks: index, skipped: 'disconnected' };
      }

      const frame = {
        type: 'state.replay' as const,
        messageId: randomUUID(),
        runs: chunk,
        timestamp: Date.now(),
      };

      const parsed = stateReplaySchema.safeParse(frame);
      if (!parsed.success) {
        logger.error('Refusing to send an invalid state replay frame', {
          chunkIndex: index,
          chunkRuns: chunk.length,
          issue: parsed.error.issues[0]?.message,
          path: parsed.error.issues[0]?.path.join('.'),
        });
        return { sent, chunks: index, skipped: 'invalid' };
      }

      const payload = JSON.stringify(frame);
      this.ws.send(payload);
      // Deliberately NOT cleared on send completion: the Platform's rejection
      // close arrives after the write succeeds. A close is replay-attributed when
      // a replay went out and the connection died before proving stable.
      this.replaySentOnConnection = true;
      sent += chunk.length;

      // Pace under the Platform limiter's byte refill so a large replay cannot
      // trip its sustained-violation disconnect. Skipped after the last frame.
      if (index < chunks.length - 1) {
        const delayMs =
          (Buffer.byteLength(payload, 'utf8') / REPLAY_BYTE_REFILL_BYTES_PER_SEC) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    logger.info('Sent state replay to Platform', { runCount: sent, chunks: chunks.length });
    return { sent, chunks: chunks.length };
  }

  /** Unbuffered, untyped send for frames outside the union (e.g. `log.response`). */
  sendRaw(data: unknown): void {
    if (this._state === 'authenticated' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /** Register one source at runtime (the post-auth registration sends them all). */
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
      ...(this.mode && { mode: this.mode as OrchestratorMode }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.deployment && { deployment: this.deployment }),
      ...(this.configPaths &&
        Object.keys(this.configPaths).length > 0 && { configPaths: this.configPaths }),
      ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
    });
  }

  sendSourceDeregister(source: { routingKey: string }): void {
    this.send({
      type: 'source.deregister',
      messageId: randomUUID(),
      routingKeys: [source.routingKey],
    });
  }

  /** Diff against the current sources and send the register / deregister frames. */
  updateSources(newSources: ProviderSource[]): void {
    const oldByKey = new Map(this.providerSources.map((s) => [s.routingKey, s]));
    const newByKey = new Map(newSources.map((s) => [s.routingKey, s]));

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

    // Register added AND changed sources: a name, slug or subtype change under
    // the same routing key must reach the dashboard. The Platform upserts, so
    // re-sending a registered source is idempotent.
    const changedSources = newSources.filter((s) => {
      const prev = oldByKey.get(s.routingKey);
      if (!prev) return true; // added
      return (
        prev.provider !== s.provider ||
        prev.name !== s.name ||
        prev.subtype !== s.subtype ||
        prev.slug !== s.slug
      );
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
        ...(this.mode && { mode: this.mode as OrchestratorMode }),
        ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
        ...(this.deployment && { deployment: this.deployment }),
        ...(this.configPaths &&
          Object.keys(this.configPaths).length > 0 && { configPaths: this.configPaths }),
        ...(this.s3LogAccess !== undefined && { s3LogAccess: this.s3LogAccess }),
        ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
      });
    } else if (newSources.length === 0 && this.providerSources.length > 0) {
      // Every source was removed: re-announce an empty set so the Platform
      // clears the routing keys yet keeps this orchestrator recorded as connected.
      this.send({
        type: 'source.register',
        messageId: randomUUID(),
        sources: [],
        ...(this.instanceId && { instanceId: this.instanceId }),
        ...(this.clusterName && { clusterName: this.clusterName }),
        ...(this.clusterId && { clusterId: this.clusterId }),
        ...(this.address !== undefined && { address: this.address }),
        ...(this.version && { version: this.version }),
        ...(this.mode && { mode: this.mode as OrchestratorMode }),
        ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
        ...(this.deployment && { deployment: this.deployment }),
        ...(this.configPaths &&
          Object.keys(this.configPaths).length > 0 && { configPaths: this.configPaths }),
        ...(this.s3LogAccess !== undefined && { s3LogAccess: this.s3LogAccess }),
        ...(this.queueTimeoutMs && { queueTimeoutMs: this.queueTimeoutMs }),
      });
    }

    this.providerSources.length = 0;
    this.providerSources.push(...newSources);
  }

  /**
   * Push the full source list and resolve with the webhook URL the Platform's
   * `source.register.ack` carries for `routingKey` (`null`: no public webhook
   * base). `kici-admin source add` prints it. Taking the FULL list keeps this
   * on the one `updateSources` path, so the later NOTIFY republish diffs to a
   * no-op. Rejects on timeout or disconnect.
   */
  registerSourceAndAwait(
    fullSources: ProviderSource[],
    routingKey: string,
    timeoutMs = 5000,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      // Never leak a superseded resolver.
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

  /** On disconnect, so a `source add` in flight fails fast instead of hanging. */
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
        // Cap the decompressed frame size so a rogue Platform cannot OOM the
        // orchestrator with a compression bomb (ws defaults to 100 MiB).
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
      this.stopClusterMembership();
      this.clearStabilityTimer();

      if (this.replaySentOnConnection && !this.connectionProvenStable) {
        this.replayConsecutiveFailures++;
        if (this.replayConsecutiveFailures >= REPLAY_BREAKER_THRESHOLD && !this.replayBreakerOpen) {
          this.replayBreakerOpen = true;
          stateReplayBreakerTripsTotal.add(1);
          logger.error('State replay breaker opened — connecting without replay', {
            consecutiveFailures: this.replayConsecutiveFailures,
            code,
          });
        }
      }
      this.replaySentOnConnection = false;
      this.connectionProvenStable = false;
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
    // disconnect() ends this client's work: a frame still arriving on the
    // closing socket must not start a handler the shutdown is tearing down
    // under it. The Platform fails a relay over when the socket closes.
    if (this.intentionalDisconnect) return;

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

  /** Recognition chain for frames the primary schema rejected. */
  private handleNonStandardMessage(raw: unknown, primaryIssues: unknown): void {
    const logPullParsed = logPullPlatformToOrchSchema.safeParse(raw);
    if (logPullParsed.success) {
      this.runFrameHandler(logPullParsed.data, this.onLogPullRequest);
      return;
    }

    // A join.request relayed by the Platform. The join handler answers every such
    // frame, a refused version-1 or malformed one included, so the Platform never
    // waits out its relay timeout.
    if (isJoinRequestFrame(raw) && this.onJoinRequest) {
      this.onJoinRequest(raw)
        .then((response) => {
          this.sendRaw(response);
        })
        .catch((err) => {
          logger.error('Error handling join request', { error: toErrorMessage(err) });
        });
      return;
    }

    // An invalid dashboard request still has a requestId the Platform waits on:
    // answer it with an error frame (fast 400, not a 10s 504). With
    // guardedDashboardDispatch this guarantees exactly one response per request.
    if (this.respondToInvalidDashboardRequest(raw, primaryIssues)) {
      return;
    }

    // An unknown-but-recognizable type means the Platform is ahead of this
    // build: NACK it so the skew is diagnosable instead of a silent timeout.
    // The builder returns null (drop-and-warn) for garbage, for a `nack` (loop
    // guard), and for streaming frames (`log.chunk` / `orch-log.chunk`).
    const nack = buildUnsupportedMessageNack(raw, 'orchestrator', PLATFORM_TO_ORCH_KNOWN_TYPES);
    if (nack) {
      wsUnsupportedMessageSentTotal.add(1, { received_type: nack.receivedType ?? 'unknown' });
      logger.warn('Unsupported message type from Platform; replying with NACK (version skew)', {
        receivedType: nack.receivedType,
        errors: primaryIssues,
      });
      this.sendRaw(nack);
      return;
    }

    logger.warn('Invalid message from Platform', {
      errors: primaryIssues,
    });
  }

  /** Answer an invalid `dashboard.*` request carrying a requestId; false when `raw` is not one. */
  private respondToInvalidDashboardRequest(raw: unknown, issues: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const { type, requestId } = raw as { type?: unknown; requestId?: unknown };
    if (typeof type !== 'string' || !type.startsWith('dashboard.')) return false;
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    const frame = classifyDashboardRequestError(
      { type, requestId },
      DASHBOARD_REQUEST_TYPE_SET,
      this.version,
    );
    logger.warn('Invalid dashboard request from Platform; answering structured error', {
      type,
      requestId,
      code: frame.code,
      errors: issues,
    });
    this.sendRaw(frame);
    return true;
  }

  /**
   * Run the handler for one Platform frame. Nothing awaits a frame, so a throw
   * or a rejection is logged with the frame's type and request id and the
   * connection carries on; left unhandled it would stop the orchestrator.
   */
  private runFrameHandler<M>(msg: M, handler: FrameHandler<M> | undefined): void {
    if (!handler) return;
    const ids = msg as { type?: unknown; requestId?: unknown; runId?: unknown };
    runDetached(logger, 'Platform frame handler', () => handler(msg), {
      ...(typeof ids.type === 'string' && { messageType: ids.type }),
      ...(typeof ids.requestId === 'string' && { requestId: ids.requestId }),
      ...(typeof ids.runId === 'string' && { runId: ids.runId }),
    });
  }

  private dispatchPlatformMessage(msg: PlatformToOrchestratorMessage): void {
    if (isDashboardFrame(msg)) {
      this.dispatchDashboardFrame(msg);
      return;
    }
    switch (msg.type) {
      case 'auth.success':
        this.handleAuthSuccess(msg);
        break;

      case 'auth.failure':
        this.handleAuthFailure(msg);
        break;

      case 'plan.headroom':
        this.onPlanHeadroom(msg).catch((err) => {
          logger.warn('Failed to apply the Platform worker ceiling', {
            error: toErrorMessage(err),
          });
        });
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

      case 'dashboard.attestation.retry':
        logger.info('Dashboard attestation retry request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.runFrameHandler(msg, this.onDashboardAttestationRetry);
        break;

      case 'run.rerun.request':
        logger.info('Run rerun request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          actor: msg.actor,
        });
        this.runFrameHandler(msg, this.onRunRerun);
        break;

      case 'run.manual_schedule.request':
        logger.info('Manual schedule request received', {
          requestId: msg.requestId,
          registrationId: msg.registrationId,
          actor: msg.actor,
        });
        this.runFrameHandler(msg, this.onManualSchedule);
        break;

      case 'run.cancel.request':
        logger.info('Run cancel request received', {
          requestId: msg.requestId,
          runId: msg.runId,
          actor: msg.actor,
        });
        this.runFrameHandler(msg, this.onRunCancel);
        break;

      case 'trust_policy.update':
        logger.info('Trust policy updated', { orgId: msg.orgId });
        this.runFrameHandler(msg, this.onTrustPolicyUpdate);
        break;

      case 'stale.checkrun.cleanup':
        logger.info('Stale check run cleanup request received', {
          runCount: msg.runs.length,
        });
        this.runFrameHandler(msg, this.onStaleCheckrunCleanup);
        break;

      case 'platform.capabilities':
        // No Platform capability flag is defined at protocol 4; log what was advertised.
        logger.info('Platform capabilities advertised', {
          capabilities: Object.keys(msg.capabilities),
        });
        break;

      case 'nack':
        // Surface skew in Loki instead of a phantom timeout. Never NACK a NACK
        // (the loop guard lives at the send site).
        wsNackReceivedTotal.add(1, { received_type: msg.receivedType ?? 'unknown' });
        logger.warn('Platform rejected a message (NACK) — likely version skew', {
          receivedType: msg.receivedType,
          messageId: msg.messageId,
          reason: msg.reason,
        });
        break;

      case 'dashboard.access-log.list':
        logger.debug('Dashboard access-log list request received', {
          requestId: msg.requestId,
          orgId: msg.orgId,
        });
        this.runFrameHandler(msg, this.onDashboardEnvMessage);
        break;

      case 'dashboard.registrations.list':
      case 'dashboard.registration.disable':
      case 'dashboard.registration.delete':
      case 'dashboard.event-log.list':
      case 'dashboard.event-log.activity':
      case 'dashboard.event-log.detail':
      case 'dashboard.event-log.payload.stream':
      case 'dashboard.event-dlq.list':
      case 'dashboard.event-dlq.count':
      case 'dashboard.event-dlq.retry':
      case 'dashboard.event-dlq.discard':
      case 'dashboard.contexts.list':
      case 'dashboard.contexts.get':
      case 'dashboard.contexts.create':
      case 'dashboard.contexts.update':
      case 'dashboard.contexts.test_access.set':
      case 'dashboard.contexts.delete':
      case 'dashboard.contexts.variables.list':
      case 'dashboard.contexts.variables.set':
      case 'dashboard.contexts.variables.delete':
      case 'dashboard.contexts.source-overrides.list':
      case 'dashboard.contexts.source-overrides.set':
      case 'dashboard.contexts.source-overrides.delete':
      case 'dashboard.contexts.bindings.list':
      case 'dashboard.contexts.bindings.set':
      case 'dashboard.contexts.secrets.list':
      case 'dashboard.contexts.secrets.set':
      case 'dashboard.contexts.secrets.delete':
      case 'dashboard.contexts.secrets.scope.create':
      case 'dashboard.contexts.secrets.scope.rename':
      case 'dashboard.contexts.secrets.scope.delete':
      case 'dashboard.contexts.history':
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
      // Fleet host writes are answered by the policy-gated DashboardFleetWriteHandler.
      case 'dashboard.fleet.host.declare':
      case 'dashboard.fleet.host.remove':
        logger.debug('Dashboard environment message received', {
          type: msg.type,
          requestId: msg.requestId,
        });
        this.runFrameHandler(msg, this.onDashboardEnvMessage);
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
        this.runFrameHandler(msg, this.onTestRelay);
        break;

      default: {
        // Exhaustiveness: a new union variant without a case fails typecheck here.
        const _exhaustive: never = msg;
        void _exhaustive;
        logger.warn('Unknown platform message type', {
          type: (msg as { type?: string }).type,
        });
        break;
      }
    }
  }

  /** Log a dashboard read frame and hand it to its registered handler. */
  private dispatchDashboardFrame(msg: DashboardFrame): void {
    const fields = msg as Record<string, unknown>;
    const meta: Record<string, unknown> = { type: msg.type };
    for (const key of DASHBOARD_FRAME_LOG_FIELDS) {
      if (fields[key] !== undefined) meta[key] = fields[key];
    }
    logger.debug('Dashboard frame received', meta);
    const handler = this.dashboardHandlers[msg.type] as FrameHandler<typeof msg> | undefined;
    this.runFrameHandler(msg, handler);
  }

  private handleAuthSuccess(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'auth.success' }>,
  ): void {
    logger.info('Authenticated with Platform', {
      connectionId: msg.connectionId,
      orgPublicAlias: msg.orgPublicAlias,
    });

    this._state = 'authenticated';
    // Do NOT reset the attempt counter on auth: the state replay is still
    // ahead, and a rejected frame closes the socket right after. Resetting here
    // pins a post-auth failure at the backoff floor forever. Only surviving
    // CONNECTION_STABLE_MS proves health.
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.connectionProvenStable = true;
      this.reconnectAttempts = 0;
      // A connection that lived this long carried its replay successfully.
      this.replayConsecutiveFailures = 0;
    }, CONNECTION_STABLE_MS);
    this.stabilityTimer.unref?.();
    this._orgPublicAlias = msg.orgPublicAlias;
    this._orgId = msg.orgId;
    this.onOrgIdentified?.({ orgId: msg.orgId, clusterId: this.clusterId ?? null });
    this._githubWebhookUrl = msg.githubWebhookUrl;
    this.startHeartbeat();
    this.startClusterMembership();

    // Always send source.register, even with zero sources: a sourceless
    // orchestrator is still connected and must show in the dashboard.
    // onAuthenticated fires on the matching ack, which empty registrations get too.
    this.sendDirect({
      type: 'source.register',
      messageId: randomUUID(),
      sources: this.providerSources.map(toSourceRegistrationEntry),
      ...(this.instanceId && { instanceId: this.instanceId }),
      ...(this.clusterName && { clusterName: this.clusterName }),
      ...(this.clusterId && { clusterId: this.clusterId }),
      ...(this.address !== undefined && { address: this.address }),
      ...(this.version && { version: this.version }),
      ...(this.mode && { mode: this.mode as OrchestratorMode }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.deployment && { deployment: this.deployment }),
      ...(this.configPaths &&
        Object.keys(this.configPaths).length > 0 && { configPaths: this.configPaths }),
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

    // The 'close' handler sets state and schedules the reconnect.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Auth failed');
    }
  }

  private handleWebhookRelayStart(
    msg: Extract<PlatformToOrchestratorMessage, { type: 'webhook.relay.start' }>,
  ): void {
    // No ACK until the stream completes or errors; the Platform's 5 s ack
    // budget covers the whole start+chunks+ack sequence.
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
      return;
    }

    if (applyRes.status === 'error') {
      // The buffer (and its deliveryId) is gone; the required deliveryId
      // falls back to the messageId so the Platform can still correlate.
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
      // Fail the waiter with the Platform's own reason (e.g. an `--org`
      // mismatch) rather than letting it time out into "(unavailable)".
      for (const entry of rejected) {
        const pending = this.pendingSourceRegistrations.get(entry.routingKey);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingSourceRegistrations.delete(entry.routingKey);
          pending.reject(new Error(`Platform rejected ${entry.routingKey}: ${entry.reason}`));
        }
      }
    }

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

    runDetached(logger, 'Platform authenticated hook', () => this.onAuthenticated?.());
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

  /** Unbuffered send, for ACKs that must go now or not at all. */
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

  private static readonly CLUSTER_MEMBERSHIP_INTERVAL_MS = 60_000;

  /** Worker-peer snapshot (not a delta, so a dropped frame self-heals on the next send). */
  sendClusterMembership(): void {
    if (this._state !== 'authenticated' || !this.getWorkerPeers) return;
    const workers = this.getWorkerPeers();
    const message: ClusterMembership = {
      type: 'cluster.membership',
      workers: workers
        .slice(0, CLUSTER_MEMBERSHIP_MAX_WORKERS)
        .map((peer) => ({ instanceId: peer.instanceId })),
      timestamp: Date.now(),
    };
    this.sendDirect(message);
  }

  private startClusterMembership(): void {
    this.stopClusterMembership();
    if (!this.getWorkerPeers) return;
    // Once now, so the Platform has a count before the first interval.
    this.sendClusterMembership();
    this.membershipTimer = setInterval(
      () => this.sendClusterMembership(),
      PlatformClient.CLUSTER_MEMBERSHIP_INTERVAL_MS,
    );
  }

  private stopClusterMembership(): void {
    if (this.membershipTimer) {
      clearInterval(this.membershipTimer);
      this.membershipTimer = null;
    }
  }

  /**
   * Store the worker ceiling; it survives disconnects and restarts, which keeps
   * the fail-open stance bounded.
   */
  private async onPlanHeadroom(msg: PlanHeadroom): Promise<void> {
    await this.planHeadroomStore?.write(msg);
    // Reconcile on EVERY frame (not only evictExcess), so a raised ceiling can
    // cancel an in-flight drain rather than letting it disconnect the worker.
    this.onPlanCeiling?.(msg.maxWorkerPeers, msg.evictExcess);
  }

  /** Enforced ceiling; `null` (never received) admits worker joins freely. */
  async getWorkerCeiling(): Promise<number | null> {
    const stored = await this.planHeadroomStore?.read();
    return stored ? stored.maxWorkerPeers : null;
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

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
