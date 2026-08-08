import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createLogger, requestContext, getReconnectDelay, toErrorMessage } from '@kici-dev/shared';
import { OrchRpcRegistry } from './orch-rpc.js';
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
  type DashboardRunDetailRequest,
  type DashboardRunStructuredRequest,
  type DashboardRunStateRequest,
  type DashboardRunsListRequest,
  type DashboardRunsFiltersRequest,
  type DashboardSourcesListRequest,
  type DashboardStepLogsRequest,
  type DashboardAttestationsListRequest,
  type DashboardAttestationsListAllRequest,
  type DashboardAttestationGetRequest,
  type DashboardAttestationRetryRequest,
  type DashboardArtifactsListRequest,
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
  type DashboardFleetHostsRequest,
  type DashboardFleetHostRequest,
  type DashboardFleetPreviewRequest,
  type DashboardFleetWorkflowsForHostRequest,
  type JoinRequest,
  type JoinResponse,
  type SourceRegistration,
  type DeploymentIdentity,
  ORCH_CAPABILITIES,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  DASHBOARD_REQUEST_TYPE_SET,
  DashboardResponseErrorCode,
  buildUnsupportedMessageNack,
  collectDiscriminatorTypes,
  PLATFORM_TO_ORCH_RECOGNIZED_TYPES,
  hasPlatformCapability,
  type OrchCapabilities,
  type OrchRole,
  type PlatformCapabilities,
  type OrchestratorMode,
} from '@kici-dev/engine';
import { EventBuffer } from './event-buffer.js';
import { RelayBufferRegistry, type RelayStartMeta } from '../webhook/relay-buffer.js';
import type { AdmitResult } from '../webhook/ingest-admission.js';
import {
  wsUnsupportedMessageSentTotal,
  wsNackReceivedTotal,
  wsPlatformCapabilityGapTotal,
} from '../metrics/prometheus.js';

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
 * Hard ceiling on how long an admitted fire-and-forget relay pipeline may hold
 * its admission slot before it is force-released. A pipeline running longer than
 * this is treated as hung; releasing its slot (idempotently) prevents a
 * permanent slot leak that would otherwise shrink capacity for every future
 * webhook. Well above any legitimate ingest-pipeline duration.
 */
const ADMITTED_PIPELINE_LIFETIME_MS = 5 * 60 * 1000;

/**
 * How long a connection must stay open after authenticating before it counts as
 * healthy enough to reset the reconnect backoff. Authentication succeeding is
 * not proof of viability — the state replay send is still ahead of it.
 */
const CONNECTION_STABLE_MS = 30_000;

/** Consecutive replay-attributed disconnects before replay is skipped entirely. */
const REPLAY_BREAKER_THRESHOLD = 3;

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
    ...(source.slug ? { slug: source.slug } : {}),
  };
}

/**
 * Test-only: remove the comma-separated `dashboard.*` request types in `omit`
 * from the advertised manifest, so an integration test can reproduce an
 * orchestrator that predates a given capability. Double-gated on `testMode`
 * (config `KICI_TEST_MODE=1`, matching the other orchestrator test seams), so a
 * stray env var can never strip advertised capabilities in production — which
 * leaves `KICI_TEST_MODE` unset. No-op unless both are set; production
 * advertises the full set. The values flow from config (registered in the
 * orchestrator env schema), never read from `process.env` here.
 */
function applyTestCapabilityOmissions(
  caps: OrchCapabilities,
  opts: { testMode?: boolean; omit?: string },
): OrchCapabilities {
  if (!opts.testMode || !opts.omit) return caps;
  const omit = new Set(
    opts.omit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (omit.size === 0 || !Array.isArray(caps.supportedDashboardRequests)) return caps;
  return {
    ...caps,
    supportedDashboardRequests: caps.supportedDashboardRequests.filter((t) => !omit.has(t)),
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
  /** How the orchestrator process was deployed. Sent in source.register so the dashboard can build the correct kici-admin invocation. */
  deployment?: DeploymentIdentity;
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
  /**
   * Optional callback fired with the provenance trust root (OIDC issuer) the
   * Platform supplies on `auth.success`. The orchestrator uses it to verify
   * provenance bundles at ingest. `null` means provenance is not configured.
   */
  onProvenanceIssuer?: (issuer: string | null) => void;
  /** Optional callback for dashboard run detail requests from Platform. */
  onDashboardRunDetail?: (msg: DashboardRunDetailRequest) => void;
  /** Optional callback for dashboard structured run-result requests from Platform. */
  onDashboardRunStructured?: (msg: DashboardRunStructuredRequest) => void;
  /** Optional callback for the run-state system reconciliation read from Platform. */
  onDashboardRunState?: (msg: DashboardRunStateRequest) => void;
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
  /** Optional callback for org-wide attestations list (browser) requests from Platform. */
  onDashboardAttestationsListAll?: (msg: DashboardAttestationsListAllRequest) => void;
  /** Optional callback for single-attestation detail requests from Platform. */
  onDashboardAttestationGet?: (msg: DashboardAttestationGetRequest) => void;
  onDashboardAttestationRetry?: (msg: DashboardAttestationRetryRequest) => void;
  /** Optional callback for dashboard artifacts-list requests from Platform. */
  onDashboardArtifactsList?: (msg: DashboardArtifactsListRequest) => void;
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
  /** Optional callback for fleet roster requests from Platform. */
  onFleetHosts?: (msg: DashboardFleetHostsRequest) => void;
  /** Optional callback for fleet host-detail requests from Platform. */
  onFleetHost?: (msg: DashboardFleetHostRequest) => void;
  /** Optional callback for fleet runsOnAll-preview requests from Platform. */
  onFleetPreview?: (msg: DashboardFleetPreviewRequest) => void;
  /** Optional callback for fleet workflows-for-host requests from Platform. */
  onFleetWorkflowsForHost?: (msg: DashboardFleetWorkflowsForHostRequest) => void;
  /** Optional callback for trust policy updates pushed from Platform. */
  onTrustPolicyUpdate?: (msg: TrustPolicyUpdate) => void;
  /** Optional callback for stale check run cleanup requests from Platform. */
  onStaleCheckrunCleanup?: (msg: StaleCheckrunCleanup) => void;
  /** Optional callback for join requests relayed via Platform. */
  onJoinRequest?: (msg: JoinRequest) => Promise<JoinResponse>;
  /** Custom orchestrator capabilities to merge with ORCH_CAPABILITIES in auth.request. */
  orchCapabilities?: Partial<OrchCapabilities>;
  /**
   * Test-only. Whether the orchestrator runs in test mode (config
   * `KICI_TEST_MODE=1`). Gates `testOmitDashboardRequestTypes`.
   */
  testMode?: boolean;
  /**
   * Test-only. Comma-separated `dashboard.*` request types to drop from the
   * advertised capability manifest (config `KICI_TEST_OMIT_DASHBOARD_REQUEST_TYPES`).
   * Only honored when `testMode` is true; production leaves both unset.
   */
  testOmitDashboardRequestTypes?: string;
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
  /**
   * Webhook-ingest admission hook. Called with the relay's routing key BEFORE
   * signature verification (so an unverified flood is throttled too — a verify
   * does a DB read). When it sheds, the relay acks `shed_retry_later` (429) and
   * no pipeline work runs. When it admits, the returned slot is held for the
   * fire-and-forget pipeline's lifetime and released on completion / error /
   * timeout. Absent → no admission gate (tests, minimal wirings).
   */
  onAdmit?: (routingKey: string) => Promise<AdmitResult>;
  /**
   * Optional durable-overflow capture seam. Invoked with the pre-verify relay
   * meta + assembled body on a shed, before the shed_retry_later ack. Best-effort
   * — the client wraps it so a capture failure never blocks the ack.
   */
  onShedCapture?: (meta: RelayStartMeta, body: Buffer) => Promise<void>;
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
  /**
   * Generic orchestrator-initiated RPC correlation (e.g. the provenance OIDC
   * mint). The orchestrator sends a `requestId`-keyed request over the WS and
   * awaits the Platform's matching `.response`; rejected on timeout or close.
   */
  private readonly orchRpc = new OrchRpcRegistry();
  /**
   * Platform capabilities advertised on this connection (Platform → orchestrator
   * `platform.capabilities` frame). `undefined` means nothing advertised yet —
   * either a pre-capability Platform (which never advertises) or the frame has
   * not arrived. Feature-gated sends treat "undefined" as optimistic (send
   * anyway, backward-safe); only an advertised-but-absent flag suppresses a send.
   * Reset to `undefined` on every (re)connect so a stale advertisement can't
   * leak across connections.
   */
  private platformCapabilities: PlatformCapabilities | undefined;
  private readonly instanceId?: string;
  private readonly clusterName?: string;
  private readonly clusterId?: string;
  private readonly address?: string | null;
  private readonly version?: string;
  private readonly mode?: string;
  private readonly scalerBackends?: string[];
  private readonly deployment?: DeploymentIdentity;
  private readonly s3LogAccess?: boolean;
  private readonly queueTimeoutMs?: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onLogPullRequest?: PlatformClientOptions['onLogPullRequest'];

  private readonly onPeerDiscover?: PlatformClientOptions['onPeerDiscover'];
  private readonly onAuthenticated?: PlatformClientOptions['onAuthenticated'];
  private readonly onOrgIdentified?: PlatformClientOptions['onOrgIdentified'];
  private readonly onProvenanceIssuer?: PlatformClientOptions['onProvenanceIssuer'];
  private readonly onDashboardRunDetail?: PlatformClientOptions['onDashboardRunDetail'];
  private readonly onDashboardRunStructured?: PlatformClientOptions['onDashboardRunStructured'];
  private readonly onDashboardRunState?: PlatformClientOptions['onDashboardRunState'];
  private readonly onDashboardRunsList?: PlatformClientOptions['onDashboardRunsList'];
  private readonly onDashboardRunsFilters?: PlatformClientOptions['onDashboardRunsFilters'];
  private readonly onDashboardSourcesList?: PlatformClientOptions['onDashboardSourcesList'];
  private readonly onDashboardStepLogs?: PlatformClientOptions['onDashboardStepLogs'];
  private readonly onDashboardAttestationsList?: PlatformClientOptions['onDashboardAttestationsList'];
  private readonly onDashboardAttestationsListAll?: PlatformClientOptions['onDashboardAttestationsListAll'];
  private readonly onDashboardAttestationGet?: PlatformClientOptions['onDashboardAttestationGet'];
  private readonly onDashboardAttestationRetry?: PlatformClientOptions['onDashboardAttestationRetry'];
  private readonly onDashboardArtifactsList?: PlatformClientOptions['onDashboardArtifactsList'];
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
  private readonly onFleetHosts?: PlatformClientOptions['onFleetHosts'];
  private readonly onFleetHost?: PlatformClientOptions['onFleetHost'];
  private readonly onFleetPreview?: PlatformClientOptions['onFleetPreview'];
  private readonly onFleetWorkflowsForHost?: PlatformClientOptions['onFleetWorkflowsForHost'];
  private readonly onTrustPolicyUpdate?: PlatformClientOptions['onTrustPolicyUpdate'];
  private readonly onStaleCheckrunCleanup?: PlatformClientOptions['onStaleCheckrunCleanup'];
  private readonly onJoinRequest?: PlatformClientOptions['onJoinRequest'];
  private orchCapabilities: OrchCapabilities;
  private readonly onVerifyInbound?: PlatformClientOptions['onVerifyInbound'];
  private readonly onAdmit?: PlatformClientOptions['onAdmit'];
  private readonly onShedCapture?: PlatformClientOptions['onShedCapture'];
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
    this.s3LogAccess = options.s3LogAccess;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.eventBuffer = new EventBuffer({ maxSize: options.maxBufferSize ?? 10_000 });
    this.onLogPullRequest = options.onLogPullRequest;

    this.onPeerDiscover = options.onPeerDiscover;
    this.onAuthenticated = options.onAuthenticated;
    this.onOrgIdentified = options.onOrgIdentified;
    this.onProvenanceIssuer = options.onProvenanceIssuer;
    this.onDashboardRunDetail = options.onDashboardRunDetail;
    this.onDashboardRunStructured = options.onDashboardRunStructured;
    this.onDashboardRunState = options.onDashboardRunState;
    this.onDashboardRunsList = options.onDashboardRunsList;
    this.onDashboardRunsFilters = options.onDashboardRunsFilters;
    this.onDashboardSourcesList = options.onDashboardSourcesList;
    this.onDashboardStepLogs = options.onDashboardStepLogs;
    this.onDashboardAttestationsList = options.onDashboardAttestationsList;
    this.onDashboardAttestationsListAll = options.onDashboardAttestationsListAll;
    this.onDashboardAttestationGet = options.onDashboardAttestationGet;
    this.onDashboardAttestationRetry = options.onDashboardAttestationRetry;
    this.onDashboardArtifactsList = options.onDashboardArtifactsList;
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
    this.onFleetHosts = options.onFleetHosts;
    this.onFleetHost = options.onFleetHost;
    this.onFleetPreview = options.onFleetPreview;
    this.onFleetWorkflowsForHost = options.onFleetWorkflowsForHost;
    this.onTrustPolicyUpdate = options.onTrustPolicyUpdate;
    this.onStaleCheckrunCleanup = options.onStaleCheckrunCleanup;
    this.onJoinRequest = options.onJoinRequest;
    this.orchCapabilities = applyTestCapabilityOmissions(
      { ...ORCH_CAPABILITIES, ...options.orchCapabilities },
      { testMode: options.testMode, omit: options.testOmitDashboardRequestTypes },
    );
    this.onVerifyInbound = options.onVerifyInbound;
    this.onAdmit = options.onAdmit;
    this.onShedCapture = options.onShedCapture;
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
      // Additively capture the shed delivery into the durable overflow buffer
      // for replay once capacity recovers. Best-effort — a capture failure never
      // blocks the shed_retry_later ack (the caller redelivers regardless).
      if (this.onShedCapture) {
        try {
          await this.onShedCapture(meta, body);
        } catch (err) {
          logger.warn('Failed to capture shed relay delivery to overflow buffer', {
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

    // Fire-and-forget pipeline: hold the admitted slot for its lifetime and
    // release exactly once on completion / error / a hard lifetime timeout (so a
    // hung pipeline can never leak its slot). release() is itself idempotent, so
    // a timeout-release followed by a late real completion is safe. Wrapping the
    // call in Promise.resolve().then keeps a synchronous throw inside the finally.
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
    this.clearStabilityTimer();
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
   * Send the reconnect state replay as N paced frames.
   *
   * The payload is bounded by BOTH the wire schema's run cap and the Platform
   * limiter's byte budget, and paced under its refill rate, because a frame
   * breaching either one is rejected with a 4003 close — and since reconnecting
   * does not reduce the run count, an oversized frame is resent forever rather
   * than failing once.
   *
   * Uses `this.ws.send` directly rather than `this.send()` on purpose: `send()`
   * falls back to `this.eventBuffer` when the socket is not open, which for a
   * multi-frame replay would queue the remaining frames for the NEXT connection
   * instead of abandoning a replay whose connection has already gone. The
   * Platform's replay handler upserts per run, so abandoning is safe — the next
   * reconnect replays from scratch.
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
      // Attribution marker. Deliberately NOT cleared when the send completes:
      // the Platform rejects an unacceptable frame milliseconds AFTER the write
      // succeeds, so a flag cleared on send-completion would never be set when
      // the close arrives. A close is replay-attributed when a replay went out
      // on this connection and the connection died before proving stable.
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

  /**
   * Send a feature-gated message only if the Platform is known to support the
   * named capability — the orchestrator-side pre-flight for a self-hosted
   * orchestrator running ahead of the hosted Platform.
   *
   * Backward-safe: a Platform that never advertised capabilities (a
   * pre-capability build, or the advertisement hasn't arrived yet) is treated as
   * "unknown → send optimistically", exactly like the Platform's dashboard
   * pre-flight treats an absent `supportedDashboardRequests` as "unknown", never
   * "supports nothing". Only an *advertised* capability set that explicitly lacks
   * the flag suppresses the send — surfacing a diagnosable capability gap instead
   * of firing a frame the Platform would silently drop.
   */
  sendIfPlatformSupports(capability: string, message: OrchestratorToPlatformMessage): void {
    if (
      this.platformCapabilities === undefined ||
      hasPlatformCapability(this.platformCapabilities, capability)
    ) {
      this.send(message);
      return;
    }
    wsPlatformCapabilityGapTotal.add(1, { capability, type: message.type });
    logger.warn('Suppressed feature-gated send: Platform does not advertise capability', {
      capability,
      type: message.type,
    });
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
   * Send an orchestrator-initiated request over the Platform WS and await its
   * typed `.response`. The reverse of the Platform's dashboard-RPC pattern: we
   * hold the pending map and resolve on the echoed requestId. Rejects on timeout
   * or connection close; protocol-level errors arrive inside the response body.
   * The request type is a member of the typed orch->Platform union, so it rides
   * the validated `send()` path.
   */
  sendRequestAndAwait<Res>(
    type: OrchestratorToPlatformMessage['type'],
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Res> {
    const requestId = randomUUID();
    const awaited = this.orchRpc.register(requestId, timeoutMs) as Promise<Res>;
    this.send({ type, requestId, ...payload } as unknown as OrchestratorToPlatformMessage);
    return awaited;
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
      ...(this.mode && { mode: this.mode as OrchestratorMode }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.deployment && { deployment: this.deployment }),
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
    // routingKey: a rename (name change), slug change, or subtype change with
    // the same routing_key still needs to flow to Platform so the dashboard
    // reflects it. The Platform-side `onConflict.doUpdateSet` covers the upsert
    // semantics on the receiver, so re-sending an already-registered source
    // is safe and idempotent.
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
        ...(this.mode && { mode: this.mode as OrchestratorMode }),
        ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
        ...(this.deployment && { deployment: this.deployment }),
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
      // Drop the advertised Platform capabilities: a new connection re-advertises,
      // so never let a stale advertisement leak across reconnects.
      this.platformCapabilities = undefined;
      this.stopHeartbeat();
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
      // Fail any in-flight orchestrator-initiated RPC (e.g. an OIDC mint) fast
      // instead of letting it hang until its own timeout.
      this.orchRpc.rejectAll(new Error('platform connection closed'));

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

    // Version-skew diagnosability: a frame that failed every recognition schema
    // is either a genuinely-unknown message type (the Platform is ahead of this
    // orchestrator build) or malformed garbage. For a recognizable-but-unknown
    // type, reply with a NACK naming it so the skew surfaces as a diagnosable
    // error instead of a silent drop → downstream timeout. `buildUnsupportedMessageNack`
    // returns null (stay drop-and-warn) for garbage, for a `nack` (loop guard),
    // and for streaming frame classes (`log.chunk` / `orch-log.chunk`).
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

      case 'oidc.mint.response':
        // Generic orchestrator-initiated RPC response: resolve the pending
        // request keyed by requestId. Adding a future orch->Platform RPC needs
        // only a new typed pair + an entry in ORCH_RPC_RESPONSE_TYPES.
        this.orchRpc.resolve(msg.requestId, msg);
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

      case 'dashboard.run.structured':
        logger.debug('Dashboard structured run-result request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardRunStructured?.(msg);
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

      case 'dashboard.attestations.list.all':
        logger.debug('Dashboard org-wide attestations list request received', {
          requestId: msg.requestId,
        });
        this.onDashboardAttestationsListAll?.(msg);
        break;

      case 'dashboard.attestation.get':
        logger.debug('Dashboard attestation get request received', {
          requestId: msg.requestId,
          attestationId: msg.attestationId,
        });
        this.onDashboardAttestationGet?.(msg);
        break;

      case 'dashboard.attestation.retry':
        logger.info('Dashboard attestation retry request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardAttestationRetry?.(msg);
        break;

      case 'dashboard.artifacts.list':
        logger.debug('Dashboard artifacts list request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardArtifactsList?.(msg);
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

      case 'platform.capabilities':
        // Platform advertises what it supports (Platform → orchestrator). Cache
        // per connection so feature-gated sends can pre-flight against it. A
        // self-hosted orchestrator running ahead of the hosted Platform uses
        // this to avoid firing frames the Platform would drop.
        this.platformCapabilities = msg.capabilities;
        logger.info('Platform capabilities advertised', {
          capabilities: Object.keys(msg.capabilities),
        });
        break;

      case 'nack':
        // The Platform could not process a frame we sent — for version skew it
        // names the unsupported `receivedType`. Surface it as a structured
        // warning so the skew is diagnosable in Loki instead of a phantom
        // timeout. Never NACK a NACK (the loop guard lives at the send site).
        wsNackReceivedTotal.add(1, { received_type: msg.receivedType ?? 'unknown' });
        logger.warn('Platform rejected a message (NACK) — likely version skew', {
          receivedType: msg.receivedType,
          messageId: msg.messageId,
          reason: msg.reason,
        });
        break;

      // Diagnostics
      case 'dashboard.diagnostics':
        logger.debug('Dashboard diagnostics request received', {
          requestId: msg.requestId,
        });
        this.onDashboardDiagnostics?.(msg);
        break;

      // Run-state system reconciliation read (Platform RunMirrorReconciler)
      case 'dashboard.run.state':
        logger.debug('Dashboard run-state reconciliation request received', {
          requestId: msg.requestId,
          runId: msg.runId,
        });
        this.onDashboardRunState?.(msg);
        break;

      // Fleet read (roster, host detail, runsOnAll preview)
      case 'dashboard.fleet.hosts':
        logger.debug('Dashboard fleet hosts request received', { requestId: msg.requestId });
        this.onFleetHosts?.(msg);
        break;
      case 'dashboard.fleet.host':
        logger.debug('Dashboard fleet host request received', {
          requestId: msg.requestId,
          agentId: msg.agentId,
        });
        this.onFleetHost?.(msg);
        break;
      case 'dashboard.fleet.preview':
        logger.debug('Dashboard fleet preview request received', {
          requestId: msg.requestId,
          workflowName: msg.workflowName,
        });
        this.onFleetPreview?.(msg);
        break;
      case 'dashboard.fleet.workflows-for-host':
        logger.debug('Dashboard fleet workflows-for-host request received', {
          requestId: msg.requestId,
          agentId: msg.agentId,
        });
        this.onFleetWorkflowsForHost?.(msg);
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
      // Fleet host writes (Model C: declare / remove) ride the same generic
      // forwarding shape — the policy-gated DashboardFleetWriteHandler answers
      // them inside guardedDashboardDispatch.
      case 'dashboard.fleet.host.declare':
      case 'dashboard.fleet.host.remove':
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
    // Do NOT reset the attempt counter here. Authenticating does not mean the
    // connection is viable: the state replay send is still ahead of it, and a
    // frame the Platform rejects closes the socket immediately after. Resetting
    // on auth is what let a post-auth failure reconnect at the 1.0-1.5s floor
    // forever instead of escalating toward the 60s ceiling. Only surviving
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
    // Surface the provenance trust root so the agent-handler can verify
    // provenance bundles at ingest. Fires on every (re)connect; `null` when
    // the Platform has no provenance issuer configured.
    this.onProvenanceIssuer?.(msg.provenanceIssuer ?? null);
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
      ...(this.mode && { mode: this.mode as OrchestratorMode }),
      ...(this.scalerBackends && { scalerBackends: this.scalerBackends }),
      ...(this.deployment && { deployment: this.deployment }),
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
