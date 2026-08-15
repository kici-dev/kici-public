/**
 * Shared orchestrator bootstrap logic.
 *
 * Both server.ts (platform/hybrid) and standalone.ts (independent) delegate to
 * bootstrapOrchestrator() for all startup/shutdown work that is identical
 * between the two modes. Mode-specific behavior is injected via the
 * OrchestratorHooks interface.
 *
 * This eliminates ~1300 lines of duplication that previously existed across
 * the two entry points.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { serve } from '@hono/node-server';
import {
  createLogger,
  getRequestContext,
  parseDatabaseUrl,
  requestContext,
  setupGracefulShutdown,
  toErrorMessage,
  validateRequiredTools,
  type ColdStore,
} from '@kici-dev/shared';
import {
  checkCollationDriftAtStartup,
  shouldFailOnCollationDrift,
} from '@kici-dev/shared/db-collation';
import type { AppConfig } from './config.js';
import { resolveDataDir } from './data-dir.js';
import { ConfigReloader, type ReloadResult } from './config/reload.js';
import type { ConfigRouteDeps } from './routes/admin-config.js';
import { resolveLocalConfig, resolveFullConfig } from './config/resolver.js';
import { createPool, createDb } from './db/client.js';
import { AgentRegistry } from './agent/registry.js';
import { HostRosterStore } from './agent/host-roster.js';
import { HostRosterReaper } from './agent/host-roster-reaper.js';
import { JobQueue, DispatchQueueStatus, type QueuedJob } from './queue/job-queue.js';
import { createCleanupHandler } from './queue/cleanup.js';
import { type CanRouteLabels, terminalizeUnroutableJob } from './queue/terminalize-unroutable.js';
import {
  createUnroutableProbeHandler,
  DEFAULT_UNROUTABLE_GRACE_MS,
  makeRoutingReasonWriter,
  probeTickIntervalMs,
} from './queue/unroutable-probe.js';
import { unroutableFastFailedTotal } from './metrics/prometheus.js';
import { bootstrapOrchestratorScheduledJobs } from './queue/bootstrap.js';
import type { OrchestratorScheduledJobHandle } from './queue/scheduled-job.js';
import {
  createColdStoreArchiveHandler,
  createColdStorePurgeHandler,
  OrchestratorColdStore,
  readOrchestratorColdStoreConfig,
} from './cold-store/orchestrator-cold-store.js';
import { createDepthRefresher, type DepthRefresher } from './queue/depth-refresher.js';
import { EventLogWriter } from './webhook/event-log.js';
import { AccessLogWriter } from './audit/access-log.js';
import { SamplingRateLimiter } from './audit/sampling-rate-limiter.js';
import { Dispatcher, DEFAULT_REDRIVE_BATCH } from './agent/dispatcher.js';
import { PendingScaleSweeper } from './scaler/pending-scale-sweeper.js';
import { LockFileCache } from './lockfile-cache.js';
import { ContentRequirementsCache } from './content-requirements-cache.js';
import { DedupCache } from './webhook/dedup.js';
import { ObserverRegistry } from './ws/observer-registry.js';
import { AgentHeartbeatMonitor } from './ws/agent-heartbeat.js';
import {
  scalerConfigReloadsTotal,
  pgPoolClientErrorsTotal,
  setIngestAdmissionState,
  setIngestAdmissionLimits,
  ingestShedTotal,
  ingestAdmittedTotal,
} from './metrics/prometheus.js';
import {
  IngestAdmissionController,
  type IngestAdmissionSnapshot,
} from './webhook/ingest-admission.js';
import { RealLoopLagSource } from './webhook/loop-lag-source.js';
import {
  createOrgIngestCapReader,
  type OrgIngestCapReader,
} from './webhook/org-ingest-cap-reader.js';
import {
  createSandboxAllowListReader,
  type SandboxAllowListReader,
  type SandboxAllowList,
} from './pipeline/sandbox-allowlist-reader.js';
import { resolveSandboxGrant } from './pipeline/resolve-sandbox-grant.js';
import { IngestOverflowBuffer } from './webhook/ingest-overflow-buffer.js';
import { IngestOverflowReplayer } from './webhook/ingest-overflow-replayer.js';
import { AgentMetricsAggregator } from './metrics/agent-metrics-aggregator.js';
import { createApp, SourceLocationStore } from './app.js';
import { LocalDevSigner, KICI_LOCAL_ISSUER, type LocalSigner } from './oidc/local-dev-signer.js';
import { FleetAgentCollector } from './ws/fleet-agent-collector.js';
import { FLEET_NODE_TIMEOUT_MS } from './diagnostics/fleet-constants.js';
import {
  getFleetTopology as getFleetTopologyImpl,
  collectFleet as collectFleetImpl,
  makeFleetCollectResponder,
  type FleetRuntime,
} from './diagnostics/fleet-wiring.js';
import { resolveSelection } from './diagnostics/fleet-selection.js';
import {
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_DISPATCH_ACK_TIMEOUT,
  isLockStaticJob,
  partitionMatchers,
  resolveScheduleInputs,
  VariantKind,
  ExecutionJobStatus,
  InitFailureCategory,
  type LabelMatcher,
  type PeerHeartbeat,
  type CacheRefScope,
  type PeerLogsCollectRequest,
  type PeerToPeerMessage,
  type ResolvedSandboxGrant,
} from '@kici-dev/engine';
import {
  ScalerManager,
  ContainerScalerBackend,
  BareMetalScalerBackend,
  FirecrackerScalerBackend,
  DbIpAllocator,
  loadScalerConfig,
  detectLabelSetOverlaps,
} from './scaler/index.js';
import type { ScalerBackend, ScalerConfig, ScalerEvent } from './scaler/index.js';
import { createCacheStorage, generateSigningSecret } from './storage/index.js';
import type { CacheStorage } from './storage/index.js';
import { assertAgentReachableStorage } from './storage/loopback-guard.js';
import {
  createProvenanceTrustRoot,
  provenanceTrustRootFromRepo,
  type ProvenanceTrustRoot,
} from './provenance/trust-root.js';
import { OrchestratorSigningKeyRepo } from './db/repos/signing-keys-repo.js';
import { reconcileOrchestratorSigningKey } from './oidc/reconcile-signing-key.js';
import { DashboardEncryptionKeyRepo } from './db/repos/dashboard-encryption-keys-repo.js';
import {
  reconcileDashboardEncryptionKey,
  type ResolvedDashboardEncryptionKey,
} from './secrets/dashboard-encryption-key.js';
import { isProvenanceSigningEnabled } from './oidc/orchestrator-signer-factory.js';
import type { Signer } from './oidc/signer.js';
import {
  SourceCache,
  BuildCoordinator,
  DepCache,
  UserCache,
  DispatchCacheRefTracker,
  PendingBuildTracker,
  PendingInitTracker,
  PendingDynamicTracker,
  PendingGlobalEvalTracker,
  GlobalEvalRoundCache,
  type UserCacheOrgLimits,
  type UserCacheOrgLimitsReader,
} from './cache/index.js';
import {
  ArtifactStore,
  type ArtifactOrgLimits,
  type ArtifactOrgLimitsReader,
} from './artifacts/artifact-store.js';
import { CheckRunReporter } from './reporting/check-run-reporter.js';
import { CheckRunTrackingStore } from './reporting/check-run-tracking-store.js';
import { reportJobCheckRunCompletion } from './reporting/job-check-run-completion.js';
import { ScalerStateStore } from './scaler/scaler-state-store.js';
import {
  dispatchReadyJob,
  cleanupPendingJobContexts,
  restorePendingJobContexts,
  openEvalGate,
  clearEvalGatesForRun,
  resolveOrgId,
} from './pipeline/processor.js';
import { restorePendingWorkflowContexts } from './pipeline/pending-workflow-context.js';
import { recomputeNeedsSatisfied } from './pipeline/needs-scheduler.js';
import { StepLogBuffer } from './reporting/step-log-buffer.js';
import { createLogStorage, type LogStorage } from './reporting/log-storage.js';
import { ExecutionTracker, type ExecutionTrackerDeps } from './reporting/execution-tracker.js';
import { LogWriter } from './reporting/log-writer.js';
import { createLogChunkSink, type NormalizedLogChunk } from './reporting/log-chunk-sink.js';
import { normalizePeerLogChunk } from './reporting/peer-log-normalize.js';
import { StaleRunDetector } from './stale-detector/stale-run-detector.js';
import { WorkflowDeadlineDetector } from './stale-detector/workflow-deadline-detector.js';
import type { HeldRunStore, ReleaseSignal } from './contexts/held-runs.js';
import type { StepApprovalBridge } from './approvals/step-approval-bridge.js';
import { cancelRunWithReason } from './cancel/cancel-run.js';
import {
  PeerRegistry,
  PeerClient,
  createPeerHandler,
  RaftNode,
  RaftStateStore,
  OrphanRecovery,
  RunCoordinator,
  createClusterHealthRoutes,
  type RunContext,
  type JobToRoute,
} from './cluster/index.js';
import { extractRepoIdentifier } from './entry-helpers.js';
import { runMigrations } from './db/migrator.js';
import { SourceStore, SourceManager } from './sources/index.js';
import { GithubAppNameRefresher } from './github-app-name-refresher/github-app-name-refresher.js';
import { fetchGithubAppIdentity } from './providers/github/manifest.js';
import {
  loadMasterKey,
  loadOldMasterKey,
  PgSecretStore,
  AuditLogger,
  SecretResolver,
  RbacEnforcer,
  TokenManager,
  createOrphanSecretCleanupHandler,
} from './secrets/index.js';
import { BackendRegistry } from './secrets/backend-registry.js';
import { loadRoutableStores } from './secrets/scope-routing.js';
import { BackendHealthChecker } from './secrets/backend-health.js';
import { BackendSyncManager } from './secrets/backend-sync.js';
import type { SecretStore } from '@kici-dev/engine';
import type { AdminRouteDeps } from './routes/admin.js';
import { AgentTokenStore } from './agent/token-store.js';
import { OwnershipTracker } from './agent/ownership-tracker.js';
import { EventStore } from './events/event-store.js';
import { EventCircuitBreaker } from './events/circuit-breaker.js';
import { EventRouter, type EventMatchContext } from './events/event-router.js';
import { EventRetryScanner } from './events/event-retry-scanner.js';
import { EventEmitter } from './events/event-emitter.js';
import { TrustStore } from './events/trust-store.js';
import { parseFaultInjectionMap, type EventRouterConfig } from './events/types.js';
import { GenericSourceManager } from './webhook/generic-sources.js';
import { createGenericProviderBundle } from './providers/generic/index.js';
import { registerProviderBundleForSource } from './webhook/register-source-bundle.js';
import { GenericSourcesChangeListener } from './webhook/generic-sources-listener.js';
import {
  universalGitRegistrationErrorsTotal,
  setDeclaredHostsUnreachable,
  setDbCollationDrift,
  incScalerRedispatch,
  setDraining,
} from './metrics/prometheus.js';
import { DrainController } from './drain/drain-controller.js';
import { ConcurrencyGroupTracker, ConcurrencyQueueManager } from './concurrency/index.js';
import { RegistrationStore } from './registration/registration-store.js';
import { RegistrationIndex } from './registration/registration-index.js';
import { CronStore } from './cron/cron-store.js';
import { CronScheduler } from './cron/cron-scheduler.js';
import { SecretOutputStore } from './secrets/secret-output-store.js';
import { decryptPrivateKey, decryptSecretOutput } from './secrets/ephemeral-keys.js';
import { encrypt, decrypt as pskDecrypt, deriveKey } from '@kici-dev/shared';
import { ProviderRegistry } from './provider-registry.js';
import { ClusterIdentity } from './cluster/cluster-identity.js';
import { ClusterSettingsReader, clampCacheMaxEntries } from './cluster/cluster-settings-reader.js';
import { resolveAndPersistClusterName } from './config/cluster-name.js';
import { getClusterId } from './config/cluster-id.js';
import { JoinHandler } from './cluster/join-handler.js';
import { JoinTokenManager } from './cluster/join-token.js';
import { PeerCredentialStore } from './cluster/peer-credentials.js';
import { SharedConfigStore } from './config/shared-store.js';
import { exitWithStartupBackoff } from './startup-backoff.js';
import { runDiskGuard } from './scaler/disk-guard.js';
import { createS3Client } from '@kici-dev/shared';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Kysely } from 'kysely';
import type { Database } from './db/types.js';
import type pg from 'pg';

const logger = createLogger({ prefix: 'core' });

// ── Shared types ────────────────────────────────────────────────────────────

/**
 * All subsystems that are created during bootstrap.
 * Passed to hooks so mode-specific code can wire callbacks.
 */
export interface OrchestratorSubsystems {
  config: AppConfig;
  db: Kysely<Database>;
  pool: pg.Pool;
  /** Cluster-global settings reader (fleet-wide tunables on cluster_settings). */
  clusterSettings: ClusterSettingsReader;
  providerRegistry: ProviderRegistry;
  agentRegistry: AgentRegistry;
  hostRosterStore: HostRosterStore;
  dispatcher: Dispatcher;
  queue: JobQueue;
  scalerManager: ScalerManager | null;
  scalerConfig: ScalerConfig | null;
  cacheStorage: CacheStorage | undefined;
  /**
   * Provenance trust root used to verify build-provenance bundles at ingest.
   * The mode-specific hook (server.ts) wires the live issuer onto it from the
   * Platform `auth.success` message via `onProvenanceIssuer`.
   */
  provenanceTrustRoot: ProvenanceTrustRoot;
  sourceCache: SourceCache | undefined;
  depCache: DepCache | undefined;
  userCache: UserCache | undefined;
  artifactStore: ArtifactStore | undefined;
  /** Server-side jobId -> user-cache-namespace store, written at dispatch, read by the agent-WS handler. */
  dispatchCacheRefs: DispatchCacheRefTracker;
  buildCoordinator: BuildCoordinator | undefined;
  pendingBuilds: PendingBuildTracker | undefined;
  pendingInits: PendingInitTracker;
  pendingDynamics: PendingDynamicTracker;
  pendingGlobalEvals: PendingGlobalEvalTracker;
  checkRunReporter: CheckRunReporter;
  stepLogBuffer: StepLogBuffer;
  sourceLocationStore: SourceLocationStore;
  logStorage: LogStorage;
  logWriter: LogWriter;
  observerRegistry: ObserverRegistry;
  executionTracker: ExecutionTracker;
  secretResolver: SecretResolver | null;
  adminDeps: AdminRouteDeps | undefined;
  pgSecretStore: PgSecretStore | undefined;
  /**
   * Dashboard-encryption (X25519) key resolver for browser-sealed dashboard
   * writes under the `encrypted` posture. Present whenever KICI_SECRET_KEY is
   * configured; absent ⇒ `encrypted` writes fail closed at the WS handler.
   */
  dashboardEncryption:
    | {
        resolve: () => Promise<ResolvedDashboardEncryptionKey | null>;
      }
    | undefined;
  tokenStore: AgentTokenStore;
  ownershipTracker: OwnershipTracker;
  lockFileCache: LockFileCache;
  contentRequirementsCache: ContentRequirementsCache;
  globalEvalCache: GlobalEvalRoundCache;
  dedup: DedupCache;
  eventRouter: EventRouter;
  /**
   * Event store for custom internal events (system + custom). Exposed
   * here so the dashboard handler can serve the per-org DLQ surface
   * (list / count / retry / discard) over the WS relay.
   */
  eventStore: EventStore;
  eventEmitter: EventEmitter;
  genericSourceManager: GenericSourceManager;
  /**
   * Re-register a generic source's provider bundle from its database row.
   * The webhook pipeline calls it on an exact registry miss so the read side
   * settles against server truth rather than a stand-in bundle. Shared by the
   * relay path (server.ts) and the direct-ingress path (app.ts).
   */
  ensureProviderBundle: (routingKey: string) => Promise<boolean>;
  trustStore: TrustStore;
  registrationStore: RegistrationStore;
  registrationIndex: RegistrationIndex;
  cronScheduler: CronScheduler;
  peerRegistry: PeerRegistry;
  raft: RaftNode;
  coordinator: RunCoordinator;
  orphanRecovery: OrphanRecovery;
  peerHandler: ReturnType<typeof createPeerHandler>;
  peerClients: Map<string, PeerClient>;
  getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  broadcastHeartbeatToAllPeers: () => void;
  broadcastAgentTokenRevoke: (tokenId: string) => void;
  joinHandler: JoinHandler;
  configReloader: ConfigReloader;
  localConfigVersion: number;
  sourceStore: SourceStore;
  sourceManager: SourceManager;
  /**
   * Generic-webhook-source hot-reload listener. Exposed so the platform-mode
   * boot can wire its `onChange` to re-push the full source list to the
   * Platform when a generic source is added/removed at runtime.
   */
  genericSourcesChangeListener: GenericSourcesChangeListener;
  /** Inbound webhook delivery log writer (event_log table + object-storage payloads). */
  eventLogWriter: EventLogWriter;
  /** Access log writer (read + mutation attribution for dashboard + admin). */
  accessLogWriter: AccessLogWriter;
  /**
   * Long-lived cold-store handle. Read paths (dashboard, CLI) use this
   * for transparent fallback to S3 when a row has aged out of PG. The
   * scheduled archive cycle constructs its own ephemeral instance per
   * tick (so SIGHUP-driven config reload picks up new bucket / prefix
   * values without a restart) — these two instances are independent.
   * `null` when cold-store is not enabled in the env.
   */
  coldStore: ColdStore | null;
  /**
   * In-memory aggregator for agent-pushed metrics. Constructed once at
   * subsystem-build time so both the HTTP `/metrics` exposition path
   * (orchestrator-side) and the Platform-bound MetricsReporter (which
   * concatenates the agent snapshot before WS push so agent metrics
   * land in Mimir per-org alongside `kici_orch_*`) reference the same
   * store. the metrics enforcement plan.
   */
  agentMetricsAggregator: AgentMetricsAggregator;
  /**
   * Peer-side fleet collect responder. On an inbound peer.logs.collect.request,
   * assembles this node's subtree and streams it back. Wired into every outgoing
   * PeerClient (the incoming peer-handler is wired directly in setupCluster).
   * Armed after the fleet runtime is built, so calls before that resolve to a
   * no-op.
   */
  fleetCollectResponder: (
    msg: PeerLogsCollectRequest,
    send: (out: PeerToPeerMessage) => boolean,
  ) => Promise<void>;
  /** Shared webhook-ingest admission controller (HTTP + WS relay paths). */
  ingestController: IngestAdmissionController;
  /** Cached per-org ingest cap reader for admission fairness keying. */
  ingestCapReader: OrgIngestCapReader;
  /** Cached per-org container-sandbox escape-hatch allow-list reader (dispatch). */
  sandboxAllowListReader: SandboxAllowListReader;
  /** Durable overflow buffer capturing shed deliveries (HTTP + WS relay). */
  ingestOverflowBuffer: IngestOverflowBuffer;
  /** Background replayer draining the overflow buffer once capacity recovers. */
  ingestOverflowReplayer: IngestOverflowReplayer;
}

/**
 * Mode-specific hooks injected by each entry point.
 */
export interface OrchestratorHooks {
  /** Logger prefix for mode-specific messages */
  logPrefix: string;

  /**
   * Extra ExecutionTracker callbacks (e.g., Platform-mode forwards execution
   * status and step status to the relay).
   */
  executionTrackerExtras?: (subsystems: OrchestratorSubsystems) => {
    onExecutionStatusChange?: ExecutionTrackerDeps['onExecutionStatusChange'];
    onStepStatusForward?: ExecutionTrackerDeps['onStepStatusForward'];
    onJobStatusChange?: ExecutionTrackerDeps['onJobStatusChange'];
    onRunEventEmit?: ExecutionTrackerDeps['onRunEventEmit'];
    onOrchLog?: ExecutionTrackerDeps['onOrchLog'];
    orgId?: string;
  };

  /**
   * Forward a step-log chunk to the Platform for browser fan-out. Implemented
   * by modes that hold a Platform connection; left undefined in independent
   * mode, where logs are persisted but not relayed.
   */
  forwardLogChunk?: (chunk: NormalizedLogChunk) => void;

  /**
   * Called after the secrets subsystem is initialized.
   * Server.ts uses this to create SecretResolver; standalone doesn't.
   */
  onSecretsInitialized?: (ctx: {
    pgSecretStore: PgSecretStore;
    backendStores: Map<string, SecretStore>;
    db: Kysely<Database>;
    auditLogger: AuditLogger;
  }) => SecretResolver | null;

  /**
   * Called after all subsystems are built, before HTTP server starts.
   * Mode-specific wiring (PlatformClient creation, peer client setup, etc.)
   *
   * Returns mode-specific dependencies to pass to createApp() and
   * additional shutdown steps.
   */
  onSubsystemsReady: (subsystems: OrchestratorSubsystems) => Promise<{
    /** Extra dependencies to merge into createApp() */
    appDepsExtras?: Record<string, unknown>;
    /** Extra ConfigReloader deps beyond shared ones */
    configReloaderExtras?: {
      onProviderChange?: (
        newConfig: AppConfig,
        oldConfig: AppConfig,
        subsystems: OrchestratorSubsystems,
      ) => Promise<void>;
      onPlatformReconnect?: (newConfig: AppConfig) => Promise<void>;
    };
    /** Extra shutdown steps in order (run before shared shutdown) */
    shutdownExtras?: Array<{ label: string; fn: () => Promise<void> | void }>;
    /** Called after HTTP server starts (e.g., PlatformClient.connect) */
    onServerStarted?: () => Promise<void>;
  }>;

  /**
   * Mode startup log message.
   */
  startupLogMessage: (port: number) => string;
}

// ── Local dev-signed identity (offline plane only) ──────────────────────────

/**
 * Load the offline local dev plane's dev-signed ES256 signer from its persisted
 * private JWK, and write the public JWK next to it (mode 0644 — public material)
 * so `kici local trust-root` can export a `{ issuer, jwks }` trust root without
 * a JWKS HTTP endpoint. The private key never leaves this process; only the
 * public JWK is written out.
 */
async function buildLocalDevSigner(
  keyFile: string,
  logger: ReturnType<typeof createLogger>,
): Promise<LocalSigner> {
  const signer = await LocalDevSigner.fromFile(keyFile);
  const pubFile = path.join(path.dirname(keyFile), 'identity.pub.jwk');
  await fs.writeFile(pubFile, JSON.stringify(signer.getPublicJwk(), null, 2) + '\n', {
    mode: 0o644,
  });
  logger.info('local dev-signed identity loaded', {
    issuer: KICI_LOCAL_ISSUER,
    kid: signer.getKid(),
    publicJwkFile: pubFile,
  });
  return signer;
}

// ── Scaler initialization (extracted to reduce bootstrap length) ────────────

async function initializeScaler(
  config: AppConfig,
  db: Kysely<Database>,
  tokenStore: AgentTokenStore,
  onScalerEvent: (runId: string, jobId: string, event: ScalerEvent) => void,
  isDraining: () => boolean,
  clusterSettings: ClusterSettingsReader,
): Promise<{ manager: ScalerManager; config: ScalerConfig } | null> {
  if (!config.scalerConfigPath) return null;

  const scalerConfig = await loadScalerConfig(config.scalerConfigPath, config.scalerConfigDir);

  // Disk-space guard: free leaked FC chroots before any heavy startup write so
  // a 100%-full data disk self-heals instead of crash-looping on ENOSPC.
  const guard = await runDiskGuard({ scalerConfig });
  if (!guard.recovered) {
    await exitWithStartupBackoff(
      `Data disk below free-space threshold and orphan reap did not free enough; ` +
        `run 'kici-admin scaler reap-orphans' on this host. Free bytes: ${guard.freeBytesAfter}`,
    );
  }

  // Validate label-set overlaps
  const overlaps = detectLabelSetOverlaps(scalerConfig.scalers);
  if (overlaps.length > 0) {
    logger.error('Scaler config has label-set overlaps', { overlaps });
    await exitWithStartupBackoff('Scaler config has label-set overlaps');
  }

  // Validate required external tools for all configured scalers
  const toolRequirements = scalerConfig.scalers.flatMap((s) => {
    switch (s.type) {
      case 'container':
        return ContainerScalerBackend.getRequiredTools(s);
      case 'bare-metal':
        return BareMetalScalerBackend.getRequiredTools(s);
      case 'firecracker':
        return FirecrackerScalerBackend.getRequiredTools(s);
      default:
        return [];
    }
  });
  const toolErrors = validateRequiredTools(toolRequirements);
  if (toolErrors.length > 0) {
    const detail =
      'Required tools validation failed:\n' + toolErrors.map((e) => `  - ${e}`).join('\n');
    logger.error(detail);
    await exitWithStartupBackoff(detail);
  }

  // Create backends from config
  const backendResults = await Promise.all(
    scalerConfig.scalers.map(async (s) => {
      if (s.type === 'container') {
        return {
          name: s.name,
          backend: await ContainerScalerBackend.create({
            name: s.name,
            labelSets: s.labelSets,
            maxAgents: s.maxAgents,
            host: s.host,
            socketPath: s.socketPath,
            runtime: s.runtime,
            defaultResources: scalerConfig.defaults?.resources,
            extraHosts: s.extraHosts,
            networkIsolation: s.networkIsolation,
            tokenStore: config.agentAuth === 'token' ? tokenStore : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
            // Live per-spawn resolve of the fleet-wide agent-token TTL override
            // (cluster_settings.agent_token_ttl_ms); leader has DB access.
            tokenTtlProvider: () =>
              clusterSettings.getNumber('agent_token_ttl_ms', config.agentTokenTtlMs),
            roles: s.roles,
          }),
        };
      } else if (s.type === 'bare-metal') {
        return {
          name: s.name,
          backend: new BareMetalScalerBackend({
            name: s.name,
            labelSets: s.labelSets,
            maxAgents: s.maxAgents,
            defaultResources: scalerConfig.defaults?.resources,
            tokenStore: config.agentAuth === 'token' ? tokenStore : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
            // Live per-spawn resolve of the fleet-wide agent-token TTL override
            // (cluster_settings.agent_token_ttl_ms); leader has DB access.
            tokenTtlProvider: () =>
              clusterSettings.getNumber('agent_token_ttl_ms', config.agentTokenTtlMs),
            roles: s.roles,
            enforceCgroups: s.enforceCgroups,
          }),
        };
      } else if (s.type === 'firecracker') {
        const fcNet = scalerConfig.firecracker;
        const cidr = fcNet?.cidr ?? '10.0.0.0/24';
        const bridgeName = fcNet?.bridgeName ?? 'kici-br0';
        const gateway = fcNet?.gateway ?? '10.0.0.1';
        const netmask = fcNet?.netmask ?? '255.255.255.0';
        const table = fcNet?.table ?? 'kici';
        const autoProvisionHost = fcNet?.autoProvisionHost ?? true;
        const ipAllocator = new DbIpAllocator({ db, cidr, gateway, netmask });
        return {
          name: s.name,
          backend: new FirecrackerScalerBackend({
            name: s.name,
            labelSets: s.labelSets,
            maxAgents: s.maxAgents,
            ipAllocator,
            firecrackerPath: s.firecrackerPath!,
            jailerPath: s.jailerPath!,
            kernelPath: s.kernelPath!,
            chrootBaseDir: s.chrootBaseDir,
            uid: s.uid!,
            gid: s.gid!,
            vcpuCount: s.vcpuCount,
            memSizeMib: s.memSizeMib,
            bridgeName,
            cidr,
            gateway,
            netmask,
            table,
            autoProvisionHost,
            tokenStore: config.agentAuth === 'token' ? tokenStore : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
            // Live per-spawn resolve of the fleet-wide agent-token TTL override
            // (cluster_settings.agent_token_ttl_ms); leader has DB access.
            tokenTtlProvider: () =>
              clusterSettings.getNumber('agent_token_ttl_ms', config.agentTokenTtlMs),
            roles: s.roles,
          }),
        };
      } else {
        logger.warn(`Unsupported scaler type "${s.type}" for scaler "${s.name}", skipping`);
        return null;
      }
    }),
  );
  const backends: Array<{ name: string; backend: ScalerBackend }> = backendResults.filter(
    (b) => b !== null,
  );

  const scalerStateStore = new ScalerStateStore(db);
  const scalerManager = new ScalerManager({
    config: scalerConfig,
    backends,
    stateStore: scalerStateStore,
    machineLedger: {
      dir: config.machineLedgerDir,
      instanceId: config.instanceId,
    },
    onScalerEvent,
    isDraining,
    spawnTimeoutMs: config.scalerSpawnTimeoutMs,
    resolveSpawnTimeoutMs: makeOrgTimeoutReaderById(
      db,
      'scaler_spawn_timeout_ms',
      config.scalerSpawnTimeoutMs,
    ),
  });

  // Hydrate scaler state from DB so a Raft leader switch / coord
  // restart doesn't strand reservations or lose spawning-agent
  // tracking. Errors are logged inside `recoverState`; we don't abort
  // bootstrap on a transient DB hiccup.
  await scalerManager.recoverState();

  // Run orphan cleanup for container and firecracker backends
  for (const { name, backend } of backends) {
    if (backend.type === 'container') {
      try {
        const cleaned = await (backend as ContainerScalerBackend).cleanupOrphans();
        if (cleaned > 0) {
          logger.info(`Cleaned up ${cleaned} orphaned containers`, { backend: name });
        }
      } catch (err) {
        logger.warn('Container orphan cleanup failed', {
          backend: name,
          error: toErrorMessage(err),
        });
      }
    } else if (backend.type === 'firecracker') {
      const fcBackend = backend as FirecrackerScalerBackend;
      try {
        const cleaned = await fcBackend.cleanupOrphans();
        if (cleaned > 0) {
          logger.info(`Cleaned up ${cleaned} orphaned Firecracker VMs`, { backend: name });
        }
      } catch (err) {
        logger.warn('Firecracker orphan cleanup failed', {
          backend: name,
          error: toErrorMessage(err),
        });
      }
      // Long-running orchestrators can't rely on startup-only cleanup:
      // kici-leak-sweep skips interface cleanup while the orchestrator is
      // active, so leaked TAPs accumulate until restart. A leaked TAP under
      // heavy churn can wedge NetworkManager (observed 2026-04-14). The
      // periodic sweep inside the backend closes that gap.
      fcBackend.startPeriodicOrphanSweep();
    }
  }

  // Verify + self-provision each backend's host prerequisites (Firecracker
  // bridge) before spawning starts. Degraded-on-failure — never aborts startup.
  await scalerManager.ensureHostsReady();

  // Start warm pool idle check interval
  scalerManager.start();

  logger.info('Scaler initialized', {
    backends: scalerConfig.scalers.map((s) => s.name),
    globalMaxAgents: scalerConfig.globalMaxAgents,
  });

  return { manager: scalerManager, config: scalerConfig };
}

// ── Cache infrastructure initialization ─────────────────────────────────────

interface CacheInfra {
  cacheStorage: CacheStorage | undefined;
  sourceCache: SourceCache | undefined;
  depCache: DepCache | undefined;
  userCache: UserCache | undefined;
  artifactStore: ArtifactStore | undefined;
  buildCoordinator: BuildCoordinator | undefined;
  pendingBuilds: PendingBuildTracker | undefined;
  pendingInits: PendingInitTracker;
  pendingDynamics: PendingDynamicTracker;
  pendingGlobalEvals: PendingGlobalEvalTracker;
  /**
   * Filesystem backend only: base directory + HMAC secret used by the
   * `/api/v1/cache/blob/*` HTTP route to serve / receive blobs. `undefined`
   * for the s3 backend (and when caching is disabled).
   */
  fsCache:
    { basePath: string; signingSecret: string; ttlMs: number; maxUploadBytes: number } | undefined;
}

function buildCacheLayers(
  cacheStorage: CacheStorage,
  config: AppConfig,
  storageType: 's3' | 'filesystem',
  db: Kysely<Database> | undefined,
  clusterSettings?: ClusterSettingsReader,
): CacheInfra {
  const sourceCache = new SourceCache({ storage: cacheStorage });
  const depCache = new DepCache({
    storage: cacheStorage,
    maxTarballBytes: config.cacheMaxTarballBytes,
    cacheTtlDaysFallback: config.cacheTtlDays,
    clusterSettings,
  });
  const userCache = new UserCache({
    storage: cacheStorage,
    quotaBytes: config.storage?.userCacheQuotaBytes,
    ttlMs: config.storage?.userCacheTtlMs,
    // Per-org override: resolve quota/TTL from org_settings at op time; null
    // columns fall back to the cluster-wide defaults above.
    orgLimitsReader: db ? makeOrgCacheLimitsReader(db) : undefined,
  });
  // Artifacts require a DB (row store + org-quota accounting); only built when
  // a DB is present, otherwise ctx.artifacts is unavailable in this mode.
  const artifactStore = db
    ? new ArtifactStore({
        storage: cacheStorage,
        db,
        quotaBytes: config.artifactQuotaBytes,
        ttlMs: config.artifactTtlMs,
        maxBytes: config.artifactMaxBytes,
        maxPerRun: config.artifactMaxPerRun,
        orgLimitsReader: makeOrgArtifactLimitsReader(db),
      })
    : undefined;
  const buildCoordinator = new BuildCoordinator({ timeoutMs: config.cacheBuildTimeoutMs });
  const pendingBuilds = new PendingBuildTracker();
  logger.info('Cache initialized', {
    storageType,
    ttlDays: config.cacheTtlDays,
    maxTarballBytes: config.cacheMaxTarballBytes,
    userCacheQuotaBytes: config.storage?.userCacheQuotaBytes,
    userCacheTtlMs: config.storage?.userCacheTtlMs,
  });
  return {
    cacheStorage,
    sourceCache,
    depCache,
    userCache,
    artifactStore,
    buildCoordinator,
    pendingBuilds,
    pendingInits: new PendingInitTracker(),
    pendingDynamics: new PendingDynamicTracker(),
    pendingGlobalEvals: new PendingGlobalEvalTracker(),
    fsCache: undefined,
  };
}

/**
 * Build the per-org cache-limits reader backed by `org_settings`. Returns the
 * per-org quota/TTL overrides (NULL columns → undefined → cluster default).
 * The BIGINT columns come back from pg as strings; coerce to number here.
 */
function makeOrgCacheLimitsReader(db: Kysely<Database>): UserCacheOrgLimitsReader {
  return async (orgId: string): Promise<UserCacheOrgLimits> => {
    const row = await db
      .selectFrom('org_settings')
      .select(['user_cache_quota_bytes', 'user_cache_ttl_ms'])
      .where('customer_id', '=', orgId)
      .executeTakeFirst();
    return {
      quotaBytes:
        row?.user_cache_quota_bytes != null ? Number(row.user_cache_quota_bytes) : undefined,
      ttlMs: row?.user_cache_ttl_ms != null ? Number(row.user_cache_ttl_ms) : undefined,
    };
  };
}

/**
 * Build the per-org artifact-limits reader backed by `org_settings`. Returns the
 * per-org quota/TTL overrides (NULL columns → undefined → cluster default).
 */
function makeOrgArtifactLimitsReader(db: Kysely<Database>): ArtifactOrgLimitsReader {
  return async (customerId: string): Promise<ArtifactOrgLimits> => {
    const row = await db
      .selectFrom('org_settings')
      .select([
        'artifact_quota_bytes',
        'artifact_ttl_ms',
        'artifact_max_bytes',
        'artifact_max_per_run',
      ])
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    return {
      quotaBytes: row?.artifact_quota_bytes != null ? Number(row.artifact_quota_bytes) : undefined,
      ttlMs: row?.artifact_ttl_ms != null ? Number(row.artifact_ttl_ms) : undefined,
      maxBytes: row?.artifact_max_bytes != null ? Number(row.artifact_max_bytes) : undefined,
      maxPerRun: row?.artifact_max_per_run != null ? Number(row.artifact_max_per_run) : undefined,
    };
  };
}

/**
 * Build the per-job ack-timeout resolver: per-org override from
 * `org_settings.dispatch_ack_timeout_ms` (the job's org travels in
 * jobConfig.cacheOrgId), falling back to the cluster-wide
 * `config.dispatchAckTimeoutMs`.
 */
function makeAckTimeoutReader(
  db: Kysely<Database> | undefined,
  config: AppConfig,
): (job: QueuedJob) => Promise<number> {
  return async (job) => {
    const orgId =
      typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined;
    if (db && orgId) {
      try {
        const row = await db
          .selectFrom('org_settings')
          .select('dispatch_ack_timeout_ms')
          .where('customer_id', '=', orgId)
          .executeTakeFirst();
        if (row?.dispatch_ack_timeout_ms != null) return Number(row.dispatch_ack_timeout_ms);
      } catch (err) {
        logger.warn('Failed to read org_settings.dispatch_ack_timeout_ms, using cluster default', {
          error: toErrorMessage(err),
        });
      }
    }
    return config.dispatchAckTimeoutMs;
  };
}

/** org_settings numeric columns readable per-org by {@link makeOrgNumberReader}. */
type OrgNumberColumn =
  'reroute_spawn_window_ms' | 'reroute_ack_timeout_ms' | 'reroute_max_hops' | 'queue_timeout_ms';

/**
 * Build a per-job resolver for a numeric `org_settings` column: the job's org
 * (jobConfig.cacheOrgId) override wins, falling back to the cluster-wide
 * default when the DB, the org row, or the column value is absent. Mirrors
 * {@link makeAckTimeoutReader} for the reroute-tunable columns.
 */
function makeOrgNumberReader(
  db: Kysely<Database> | undefined,
  column: OrgNumberColumn,
  fallback: number,
): (job: { jobConfig?: Record<string, unknown> }) => Promise<number> {
  return async (job) => {
    const orgId =
      typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined;
    if (db && orgId) {
      try {
        const row = await db
          .selectFrom('org_settings')
          .select(column)
          .where('customer_id', '=', orgId)
          .executeTakeFirst();
        const value = row?.[column];
        if (value != null) return Number(value);
      } catch (err) {
        logger.warn(`Failed to read org_settings.${column}, using cluster default`, {
          error: toErrorMessage(err),
        });
      }
    }
    return fallback;
  };
}

/**
 * Build a per-org resolver for a numeric `org_settings` column keyed directly
 * on the org id: the org's override wins, falling back to the cluster-wide
 * default when the DB, the org row, or the column value is absent. Sibling of
 * {@link makeOrgNumberReader} for callers (the scaler) that already hold the
 * org id rather than a job object.
 */
function makeOrgTimeoutReaderById(
  db: Kysely<Database> | undefined,
  column: 'scaler_spawn_timeout_ms',
  fallback: number,
): (orgId: string | undefined) => Promise<number> {
  return async (orgId) => {
    if (db && orgId) {
      try {
        const row = await db
          .selectFrom('org_settings')
          .select(column)
          .where('customer_id', '=', orgId)
          .executeTakeFirst();
        const value = row?.[column];
        if (value != null) return Number(value);
      } catch (err) {
        logger.warn(`Failed to read org_settings.${column}, using cluster default`, {
          error: toErrorMessage(err),
        });
      }
    }
    return fallback;
  };
}

function initializeCacheInfra(
  config: AppConfig,
  db: Kysely<Database> | undefined,
  clusterSettings?: ClusterSettingsReader,
): CacheInfra {
  if (config.storage?.type === 's3') {
    const cacheStorage = createCacheStorage({
      type: 's3',
      bucket: config.storage.bucket!,
      prefix: config.storage.prefix ?? '',
      ttlMs: config.cacheTtlDays * 86_400_000,
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      externalEndpoint: config.storage.externalEndpoint,
      uploadEndpoint: config.storage.uploadEndpoint,
      forcePathStyle: config.storage.forcePathStyle,
    });
    return buildCacheLayers(cacheStorage, config, 's3', db, clusterSettings);
  }

  if (config.storage?.type === 'filesystem') {
    const basePath = config.storage.fsBasePath!;
    const baseUrl = config.storage.fsBaseUrl ?? `http://127.0.0.1:${config.port}`;
    const signingSecret = generateSigningSecret();
    const ttlMs = config.cacheTtlDays * 86_400_000;
    const cacheStorage = createCacheStorage({
      type: 'filesystem',
      basePath,
      ttlMs,
      baseUrl,
      signingSecret,
    });
    const layers = buildCacheLayers(cacheStorage, config, 'filesystem', db, clusterSettings);
    return {
      ...layers,
      fsCache: { basePath, signingSecret, ttlMs, maxUploadBytes: config.cacheMaxTarballBytes },
    };
  }

  logger.info('Cache storage not configured, caching disabled');
  return {
    cacheStorage: undefined,
    sourceCache: undefined,
    depCache: undefined,
    userCache: undefined,
    artifactStore: undefined,
    buildCoordinator: undefined,
    pendingBuilds: undefined,
    pendingInits: new PendingInitTracker(),
    pendingDynamics: new PendingDynamicTracker(),
    pendingGlobalEvals: new PendingGlobalEvalTracker(),
    fsCache: undefined,
  };
}

// ── Secrets subsystem initialization ────────────────────────────────────────

interface SecretsInfra {
  secretResolver: SecretResolver | null;
  adminDeps: AdminRouteDeps | undefined;
  pgSecretStore: PgSecretStore | undefined;
  /** Phase D: exposed so the bootstrap can late-bind a cold-store handle. */
  auditLogger: AuditLogger | undefined;
}

async function initializeSecrets(
  config: AppConfig,
  db: Kysely<Database>,
  tokenStore: AgentTokenStore,
  hooks: OrchestratorHooks,
): Promise<SecretsInfra> {
  if (!config.secretKey && !config.secretKeyFile) {
    logger.warn(
      'KICI_SECRET_KEY not set — secrets subsystem disabled. Webhook secrets remain in plaintext.',
    );
    return {
      secretResolver: null,
      adminDeps: undefined,
      pgSecretStore: undefined,
      auditLogger: undefined,
    };
  }

  const masterKey = loadMasterKey(undefined, config.secretKeyFile);
  const oldMasterKey = loadOldMasterKey(undefined, config.secretKeyFileOld);
  if (oldMasterKey) {
    logger.info('Old master key configured — dual-key decrypt and true rotation enabled');
  }
  const auditLogger = new AuditLogger(db);
  const pgSecretStore = await PgSecretStore.create(db, masterKey, auditLogger, oldMasterKey);
  pgSecretStore.customerSecretsEnabled = config.pgCustomerSecrets;

  // Load registered backends from DB via BackendRegistry (replaces hardcoded Map)
  const backendRegistry = new BackendRegistry(db, masterKey, logger, oldMasterKey);
  // Self-heal: ensure the default `pg` backend row exists (idempotent). Covers
  // DBs where the row was lost to operator error or a buggy purge.
  await backendRegistry.ensureDefaultPgBackend();
  // The `pg` entry is always the configured `pgSecretStore`, never the one the
  // registry synthesizes for the seeded row — only the configured instance
  // carries `pgCustomerSecrets`, the resolved key version and the old-master-key
  // fallback. See `loadRoutableStores`.
  const backendStores = await loadRoutableStores<SecretStore, AuditLogger>(
    backendRegistry,
    auditLogger,
    pgSecretStore,
  );

  // Initialize health checker and sync manager for external backends
  const healthChecker = new BackendHealthChecker(backendRegistry, logger);
  const syncManager = new BackendSyncManager(backendRegistry, logger);

  // check health at startup, warn but don't block
  healthChecker.checkAllBackends().catch((err) =>
    logger.warn('Backend health check failed at startup', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  // Start periodic health checks and sync for external backends
  healthChecker.startPeriodicCheck(60000);
  syncManager.startPeriodicSync();

  // Let mode-specific code decide whether to create SecretResolver
  const secretResolver =
    hooks.onSecretsInitialized?.({ pgSecretStore, backendStores, db, auditLogger }) ?? null;

  const rbac = new RbacEnforcer();
  const tokenManager = new TokenManager(db);

  // Ensure bootstrap admin token exists
  const bootstrapToken = await tokenManager.ensureBootstrapToken(config.bootstrapAdminToken);
  if (bootstrapToken) {
    logger.info('Bootstrap admin token generated', { token: bootstrapToken });
    console.log(`\n  KICI Admin Token: ${bootstrapToken}\n`);
  }

  // Build admin route deps for createApp()
  const adminDeps: AdminRouteDeps = {
    tokenManager,
    rbac,
    secretStore: pgSecretStore,
    auditLogger,
    tokenStore,
    backendRegistry,
    backendHealthChecker: healthChecker,
    backendSyncManager: syncManager,
  };

  logger.info('Secrets subsystem initialized', {
    backends: [...backendStores.keys()],
    registeredBackends: (await backendRegistry.listBackends()).length,
  });

  return { secretResolver, adminDeps, pgSecretStore, auditLogger };
}

// ── onDispatch callback builder ─────────────────────────────────────────────

type ProviderBundle = ReturnType<ProviderRegistry['getByRoutingKey']>;

/**
 * Normalize a lock job's `needs` array (strings, NeedsEntry objects, or
 * NeedsGroupEntry objects) to the set of upstream BASE job names. Group entries
 * are skipped here — group fan-in is resolved separately by the scheduler.
 */
export function upstreamBaseNamesFromNeeds(needs: unknown): string[] {
  if (!Array.isArray(needs)) return [];
  const names: string[] = [];
  for (const need of needs) {
    if (typeof need === 'string') {
      names.push(need);
    } else if (need && typeof need === 'object') {
      const obj = need as { name?: unknown; group?: unknown };
      if (typeof obj.group === 'string') continue; // group ref, resolved elsewhere
      if (typeof obj.name === 'string') names.push(obj.name);
    }
  }
  return names;
}

/**
 * Partition a lock job's `runsOn` / `excludeLabels` matchers into exact label
 * strings and regex patterns for internal-event (cron / `ctx.emit`) dispatch.
 * Lock jobs carry `runsOn` as `LabelMatcher[]`; the coordinator routing and the
 * direct dispatcher both need exact labels for the indexed/SQL fast path and
 * regex patterns as a separate JS post-filter — never the raw matcher objects.
 */
export function internalJobRunsOnSelectors(job: {
  runsOn?: readonly LabelMatcher[];
  excludeLabels?: readonly LabelMatcher[];
}): {
  runsOnLabels: string[];
  runsOnPatterns: LabelMatcher[];
  excludeLabels: string[];
  excludePatterns: LabelMatcher[];
} {
  const include = partitionMatchers(job.runsOn ?? []);
  const exclude = partitionMatchers(job.excludeLabels ?? []);
  return {
    runsOnLabels: include.exact,
    runsOnPatterns: include.regex,
    excludeLabels: exclude.exact,
    excludePatterns: exclude.regex,
  };
}

/** Escape SQL LIKE wildcards (`%`, `_`) so a literal base name matches exactly. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Parse an `execution_jobs.outputs` cell (string JSON or object) to a plain
 * object, or null when empty / unparseable.
 */
export function parseOutputsCell(outputs: unknown): Record<string, unknown> | null {
  if (!outputs) return null;
  try {
    const parsed = typeof outputs === 'string' ? JSON.parse(outputs) : outputs;
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Build the downstream `upstreamJobOutputs` map keyed by BASE name. A base name
 * that fanned into matrix children (rows with `matrix_values`) gets the
 * `{ byMatrix, merged }` envelope; a single non-fanned row keeps the flat shape.
 * Returns undefined when no upstream produced outputs.
 */
export function buildUpstreamOutputsByBase(
  baseNames: string[],
  rows: Array<{
    job_name: string;
    outputs: unknown;
    matrix_values: unknown;
    variant_kind?: string | null;
    variant_label?: string | null;
    status?: string | null;
  }>,
): Record<string, Record<string, unknown>> | undefined {
  let result: Record<string, Record<string, unknown>> | undefined;
  for (const base of baseNames) {
    // Host fan-out children (variant_kind='host') fold into a byHost envelope.
    const hostChildren = rows
      .filter((r) => r.variant_kind === VariantKind.host && r.job_name.startsWith(`${base} (`))
      .map((r) => ({
        host: r.variant_label ?? r.job_name.slice(base.length + 2, -1),
        status: r.status ?? null,
        parsed: parseOutputsCell(r.outputs) ?? {},
      }));
    if (hostChildren.length > 0) {
      if (!result) result = {};
      result[base] = buildHostOutputsEnvelope(hostChildren);
      continue;
    }

    const exact = rows.find((r) => r.job_name === base && !r.matrix_values);
    const children = rows
      .filter((r) => r.matrix_values && r.job_name.startsWith(`${base} (`))
      .map((r) => ({ job_name: r.job_name, parsed: parseOutputsCell(r.outputs) }))
      .filter((r): r is { job_name: string; parsed: Record<string, unknown> } => r.parsed !== null);

    if (children.length > 0) {
      if (!result) result = {};
      result[base] = buildMatrixOutputsEnvelope(base, children);
    } else if (exact) {
      const parsed = parseOutputsCell(exact.outputs);
      if (parsed) {
        if (!result) result = {};
        result[base] = parsed;
      }
    }
  }
  return result;
}

/**
 * Build the downstream `upstreamJobStatuses` map keyed by each upstream job
 * row's name. A single non-fanned upstream is keyed by its base name; a
 * fanned-out upstream contributes one entry per expanded child name (`base
 * (child)`). The agent uses this to stamp `ctx.needs.<job>.status` (single) and
 * the per-child status of group / matrix / host-fanout entries.
 */
export function buildUpstreamStatusesByBase(
  rows: Array<{ job_name: string; status?: string | null }>,
): Record<string, ExecutionJobStatus> | undefined {
  let result: Record<string, ExecutionJobStatus> | undefined;
  for (const r of rows) {
    if (!r.status) continue;
    if (!result) result = {};
    result[r.job_name] = r.status as ExecutionJobStatus;
  }
  return result;
}

/**
 * Fold a `runsOnAll` upstream's host children into the `byHost` envelope
 * `{ byHost: { '<host>': outputs }, summary: { succeededHosts, failedHosts, outputs } }`.
 * Unlike the matrix envelope, `summary.outputs[key]` is an array view across hosts
 * (host order), never a last-write-wins scalar; `succeededHosts`/`failedHosts`
 * record each host's terminal outcome.
 */
export function buildHostOutputsEnvelope(
  children: Array<{ host: string; status: string | null; parsed: Record<string, unknown> }>,
): {
  byHost: Record<string, Record<string, unknown>>;
  summary: {
    succeededHosts: string[];
    failedHosts: string[];
    outputs: Record<string, unknown[]>;
  };
} {
  const byHost: Record<string, Record<string, unknown>> = {};
  const succeededHosts: string[] = [];
  const failedHosts: string[] = [];
  const outputs: Record<string, unknown[]> = {};
  const ordered = [...children].sort((a, b) => a.host.localeCompare(b.host));
  for (const child of ordered) {
    byHost[child.host] = child.parsed;
    if (child.status === ExecutionJobStatus.enum.success) succeededHosts.push(child.host);
    else if (child.status === ExecutionJobStatus.enum.failed) failedHosts.push(child.host);
    for (const [key, value] of Object.entries(child.parsed)) {
      (outputs[key] ??= []).push(value);
    }
  }
  return { byHost, summary: { succeededHosts, failedHosts, outputs } };
}

/**
 * Group an upstream's child rows into the matrix outputs envelope
 * `{ byMatrix: { '<suffix>': outputs }, merged: <last-write-wins> }`. The suffix
 * is the text inside the `(...)` of each expanded child name; children are
 * merged in name order (deterministic, matching dispatch order).
 */
export function buildMatrixOutputsEnvelope(
  baseName: string,
  children: Array<{ job_name: string; parsed: Record<string, unknown> }>,
): { byMatrix: Record<string, Record<string, unknown>>; merged: Record<string, unknown> } {
  let merged: Record<string, unknown> = {};
  const ordered = [...children].sort((a, b) => a.job_name.localeCompare(b.job_name));
  for (const child of ordered) {
    merged = { ...merged, ...child.parsed };
  }
  // `Object.fromEntries` defines own properties. Assigning `byMatrix[suffix]`
  // in the loop would run the inherited setter for a matrix value named
  // `__proto__` and silently drop that child's outputs from the envelope.
  const byMatrix: Record<string, Record<string, unknown>> = Object.fromEntries(
    // `${base} (${suffix})` -> suffix
    ordered.map((child) => [child.job_name.slice(baseName.length + 2, -1), child.parsed]),
  );
  return { byMatrix, merged };
}

/**
 * Merge plain `outputs` and decrypted `secret outputs` from upstream jobs
 * into the dispatch envelope's `secrets` + `upstreamJobOutputs` fields.
 *
 * For a fanned (matrix) upstream, the downstream sees a keyed envelope
 * `{ byMatrix: { '<suffix>': outputs }, merged: <last-write-wins> }` under the
 * BASE name; a non-fanned upstream keeps the flat outputs shape.
 *
 * The needs-aware scheduler guarantees upstreams are
 * terminal before the downstream is dispatched, so the lookups below
 * always find final values. Errors are swallowed (warn-logged) so a flaky
 * upstream-outputs read doesn't block dispatch — the agent will still get
 * its declared secrets, just without the merged upstream additions.
 */
export async function mergeUpstreamOutputs(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  needs: unknown,
  dispatchSecrets: Record<string, string> | undefined,
  secretKey: string,
): Promise<{
  mergedSecrets: Record<string, string> | undefined;
  upstreamJobOutputs: Record<string, Record<string, unknown>> | undefined;
  upstreamJobStatuses: Record<string, ExecutionJobStatus> | undefined;
}> {
  let mergedSecrets = dispatchSecrets ? { ...dispatchSecrets } : undefined;
  let upstreamJobOutputs: Record<string, Record<string, unknown>> | undefined;
  let upstreamJobStatuses: Record<string, ExecutionJobStatus> | undefined;

  const baseNames = upstreamBaseNamesFromNeeds(needs);
  if (baseNames.length === 0) return { mergedSecrets, upstreamJobOutputs, upstreamJobStatuses };

  try {
    const secretOutputStore = new SecretOutputStore(db);
    // Match both exact base-name rows (non-fanned) and expanded matrix children
    // (`${base} (...)`). The LIKE patterns escape the SQL wildcards in the base
    // name so a job named `a%b` cannot over-match.
    let query = db
      .selectFrom('execution_jobs')
      .select([
        'job_id',
        'job_name',
        'outputs',
        'matrix_values',
        'variant_kind',
        'variant_label',
        'status',
      ])
      .where('run_id', '=', runId);
    query = query.where((eb) =>
      eb.or(
        baseNames.flatMap((base) => [
          eb('job_name', '=', base),
          eb('job_name', 'like', `${escapeLikePattern(base)} (%`),
        ]),
      ),
    );
    const upstreamJobs = await query.execute();

    if (upstreamJobs.length === 0)
      return { mergedSecrets, upstreamJobOutputs, upstreamJobStatuses };

    upstreamJobOutputs = buildUpstreamOutputsByBase(baseNames, upstreamJobs);
    upstreamJobStatuses = buildUpstreamStatusesByBase(upstreamJobs);

    const upstreamJobIds = upstreamJobs.map((j) => j.job_id);
    const upstreamSecretOutputs = await secretOutputStore.getUpstreamSecretOutputs(
      runId,
      upstreamJobIds,
    );
    const hasSecretOutputs = Object.values(upstreamSecretOutputs).some(
      (outputs) => Object.keys(outputs).length > 0,
    );
    if (hasSecretOutputs) {
      const secretKeyBuf = deriveKey(secretKey);
      if (!mergedSecrets) mergedSecrets = {};
      for (const outputs of Object.values(upstreamSecretOutputs)) {
        for (const [key, encryptedValue] of Object.entries(outputs)) {
          if (!(key in mergedSecrets)) {
            mergedSecrets[key] = pskDecrypt(
              { data: encryptedValue, keyVersion: 1 },
              secretKeyBuf,
              `secret-output:${runId}`,
            );
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to merge upstream outputs', {
      runId,
      jobName,
      error: toErrorMessage(err),
    });
  }

  return { mergedSecrets, upstreamJobOutputs, upstreamJobStatuses };
}

/**
 * Mint structured `sourceAuth` (and a backward-compat `token`) for the
 * source-repo clone. Providers that implement `issueGitAuth()` return the
 * auth `kind` (basic vs ssh) directly; the GitHub path falls through to
 * `createCloneToken()` and we synthesize a basic-auth envelope so
 * `sourceAuth` is always populated when auth is available.
 */
async function mintSourceAuth(
  bundle: NonNullable<ProviderBundle>,
  repoIdentifier: string,
  providerContext: unknown,
): Promise<{
  token: string | null;
  structuredAuth: import('@kici-dev/engine').ProviderGitAuth | null;
}> {
  const provider = bundle.cloneTokenProvider;
  let structuredAuth: import('@kici-dev/engine').ProviderGitAuth | null = null;
  if (provider?.issueGitAuth) {
    structuredAuth = await provider.issueGitAuth(repoIdentifier, providerContext);
  }
  let token: string | null = null;
  if (structuredAuth?.kind === 'basic') {
    token = structuredAuth.secret;
  } else if (!structuredAuth && provider?.createCloneToken) {
    token = await provider.createCloneToken(repoIdentifier, providerContext);
    if (token) {
      structuredAuth = { kind: 'basic', user: 'x-access-token', secret: token };
    }
  }
  return { token, structuredAuth };
}

/**
 * Mint `workflowAuth` for cross-provider global workflows (Phase 4 Option B).
 * When the registration's routing key differs from the inbound, the
 * workflow-repo bundle is separate from the source-repo bundle and needs
 * its own auth envelope. Returns `null` if same-bundle, no separate
 * workflow context is provided, or auth minting fails.
 */
async function mintCrossProviderWorkflowAuth(
  providerRegistry: ProviderRegistry,
  jobConfig: Record<string, unknown>,
  cleanJobConfig: Record<string, unknown>,
  jobRoutingKey: string,
  jobId: string,
): Promise<import('@kici-dev/engine').ProviderGitAuth | null> {
  if (cleanJobConfig.isGlobalWorkflow !== true) return null;

  const workflowRoutingKey = jobConfig.workflowRoutingKey as string | undefined;
  const workflowRepoIdentifier = cleanJobConfig.workflowRepoIdentifier as string | undefined;
  const workflowProviderContext = (jobConfig.workflowProviderContext ?? {}) as Record<
    string,
    unknown
  >;
  if (!workflowRoutingKey || !workflowRepoIdentifier || workflowRoutingKey === jobRoutingKey) {
    return null;
  }

  const workflowBundle = providerRegistry.getByRoutingKey(workflowRoutingKey);
  if (!workflowBundle) {
    logger.error('Cross-provider global workflow: no bundle registered for workflow routing key', {
      workflowRoutingKey,
      jobId,
    });
    return null;
  }

  try {
    const wfProvider = workflowBundle.cloneTokenProvider;
    let wfAuth: import('@kici-dev/engine').ProviderGitAuth | null = null;
    if (wfProvider?.issueGitAuth) {
      wfAuth = await wfProvider.issueGitAuth(workflowRepoIdentifier, workflowProviderContext);
    }
    if (!wfAuth && wfProvider?.createCloneToken) {
      const wfToken = await wfProvider.createCloneToken(
        workflowRepoIdentifier,
        workflowProviderContext,
      );
      if (wfToken) {
        wfAuth = { kind: 'basic', user: 'x-access-token', secret: wfToken };
      }
    }
    return wfAuth;
  } catch (err) {
    logger.warn('Failed to mint workflowAuth for cross-provider global workflow', {
      error: toErrorMessage(err),
      workflowRoutingKey,
    });
    return null;
  }
}

function buildOnDispatch(
  config: AppConfig,
  db: Kysely<Database>,
  agentRegistry: AgentRegistry,
  providerRegistryRef: { current: ProviderRegistry },
  dispatchCacheRefs: DispatchCacheRefTracker,
  clusterSettings: ClusterSettingsReader,
) {
  return async (agentId: string, job: any) => {
    const entry = agentRegistry.get(agentId);
    if (!entry) return;

    // Look up the provider bundle by routing key carried on the queued job, so
    // multi-app setups get the correct per-app credentials (private key, etc.).
    // No fallback: an unknown routing key at dispatch time means the orchestrator
    // config is broken — silently picking a wrong provider would mask it.
    if (!job.routingKey) {
      logger.error('Queued job has no routingKey — refusing to dispatch', { jobId: job.id });
      return;
    }
    // `local:*` is the CLI's pseudo-routing-key for local-repo `kici run remote`
    // (full-repo overlay tarball + inline lock file). `remote:<orgId>` is the
    // Platform-first `kici run remote` anchor (relayed runs carry the overlay
    // tarball + inline lock too). Neither has a webhook provider — the agent
    // uses the inline tarball / overlay, so no clone token or provider bundle
    // is needed; the org is resolved via the `remote_sources` anchor.
    const isOverlayRoutingKey =
      job.routingKey.startsWith('local:') || job.routingKey.startsWith('remote:');
    const bundle = providerRegistryRef.current.getByRoutingKey(job.routingKey);
    if (!bundle && !isOverlayRoutingKey) {
      logger.error('No provider bundle registered for routing key — refusing to dispatch', {
        routingKey: job.routingKey,
        jobId: job.id,
      });
      return;
    }
    const repoIdentifier = extractRepoIdentifier(job.repoUrl);
    const lockFileUrl = bundle?.repoUrlBuilder
      ? bundle.repoUrlBuilder.buildRawFileUrl(repoIdentifier, job.sha, '.kici/kici.lock.json')
      : `${job.repoUrl.replace('.git', '')}/raw/${job.sha}/.kici/kici.lock.json`;

    const ctx = getRequestContext();

    const dispatchSecrets = job.jobConfig.secrets as Record<string, string> | undefined;
    const dispatchNamespacedSecrets = job.jobConfig.namespacedSecrets as
      Record<string, Record<string, string>> | undefined;
    const dispatchRunPublicKey = job.jobConfig.runPublicKey as string | undefined;
    const dispatchNpmRegistries = job.jobConfig.npmRegistries as
      Array<Record<string, unknown>> | undefined;
    const dispatchInstallEnvSecrets = job.jobConfig.installEnvSecrets as
      Record<string, string> | undefined;
    // Strip secrets/runPublicKey/internal-auth-context — agent never sees these.
    const cleanJobConfig = Object.fromEntries(
      Object.entries(job.jobConfig).filter(
        ([k]) =>
          k !== 'secrets' &&
          k !== 'namespacedSecrets' &&
          k !== 'runPublicKey' &&
          k !== 'npmRegistries' &&
          k !== 'installEnvSecrets' &&
          k !== 'workflowRoutingKey' &&
          k !== 'workflowProviderContext',
      ),
    );

    const { mergedSecrets, upstreamJobOutputs, upstreamJobStatuses } = await mergeUpstreamOutputs(
      db,
      job.runId,
      job.jobName,
      cleanJobConfig.needs,
      dispatchSecrets,
      config.secretKey!,
    );

    const dispatchMsg: Record<string, unknown> = {
      type: 'job.dispatch',
      messageId: crypto.randomUUID(),
      runId: job.runId,
      jobId: job.id,
      repoUrl: job.repoUrl,
      ref: job.ref,
      sha: job.sha,
      lockFileUrl,
      jobConfig: cleanJobConfig,
      timestamp: Date.now(),
      // Fleet-wide concurrency-slot wait timeout, resolved live from
      // cluster_settings (live override wins) and pushed to the agent; the
      // agent falls back to its own default when absent.
      concurrencyWaitTimeoutMs: await clusterSettings.getNumber(
        'concurrency_wait_timeout_ms',
        config.concurrencyWaitTimeoutMs,
      ),
      // Lift user-cache namespacing from jobConfig to top-level dispatch fields
      // (jobDispatchSchema carries orgId/repoId/cacheRefScope) so the agent-WS
      // handler resolves the cache ref from the tracked dispatch.
      ...(typeof cleanJobConfig.cacheOrgId === 'string' && { orgId: cleanJobConfig.cacheOrgId }),
      ...(typeof cleanJobConfig.cacheRepoId === 'string' && {
        repoId: cleanJobConfig.cacheRepoId,
      }),
      ...(typeof cleanJobConfig.cacheRefScope === 'string' && {
        cacheRefScope: cleanJobConfig.cacheRefScope,
      }),
      ...(ctx.requestId && { requestId: ctx.requestId }),
      ...(mergedSecrets && { secrets: mergedSecrets }),
      ...(dispatchNamespacedSecrets && { namespacedSecrets: dispatchNamespacedSecrets }),
      ...(dispatchRunPublicKey && { runPublicKey: dispatchRunPublicKey }),
      ...(dispatchNpmRegistries &&
        dispatchNpmRegistries.length > 0 && { npmRegistries: dispatchNpmRegistries }),
      ...(dispatchInstallEnvSecrets &&
        Object.keys(dispatchInstallEnvSecrets).length > 0 && {
          installEnvSecrets: dispatchInstallEnvSecrets,
        }),
      ...(upstreamJobOutputs && { upstreamJobOutputs }),
      ...(upstreamJobStatuses && { upstreamJobStatuses }),
    };

    if (bundle) {
      try {
        const { token, structuredAuth } = await mintSourceAuth(
          bundle,
          repoIdentifier,
          job.providerContext,
        );
        if (token) dispatchMsg.token = token;
        if (structuredAuth) {
          dispatchMsg.sourceAuth = structuredAuth;
          // Default to mirroring sourceAuth for same-bundle globals.
          // Cross-provider globals override this below.
          if (cleanJobConfig.isGlobalWorkflow === true) {
            dispatchMsg.workflowAuth = structuredAuth;
          }
        }
      } catch (err) {
        logger.warn('Failed to generate clone token, agent will attempt unauthenticated clone', {
          error: toErrorMessage(err),
        });
      }
    }

    const wfAuth = await mintCrossProviderWorkflowAuth(
      providerRegistryRef.current,
      job.jobConfig,
      cleanJobConfig,
      job.routingKey,
      job.id,
    );
    if (wfAuth) dispatchMsg.workflowAuth = wfAuth;

    if (job.sourceTarUrl) dispatchMsg.sourceTarUrl = job.sourceTarUrl;
    if (job.sourceTarHash) dispatchMsg.sourceTarHash = job.sourceTarHash;
    if (job.depsUrl) dispatchMsg.depsUrl = job.depsUrl;
    if (job.depsHash) dispatchMsg.depsHash = job.depsHash;

    // Record the user-cache namespacing server-side, keyed by jobId, so the
    // agent-WS handler resolves `{orgId, repoId, cacheRefScope, runId}` from
    // this trusted store rather than from the wire `cache.user.*` message
    // (which only ever names a jobId + key). Mirrors the dispatch fields above.
    dispatchCacheRefs.record(job.id, {
      runId: job.runId,
      ...(typeof cleanJobConfig.cacheOrgId === 'string' && { orgId: cleanJobConfig.cacheOrgId }),
      ...(typeof cleanJobConfig.cacheRepoId === 'string' && {
        repoId: cleanJobConfig.cacheRepoId,
      }),
      ...(typeof cleanJobConfig.cacheRefScope === 'string' && {
        cacheRefScope: cleanJobConfig.cacheRefScope as CacheRefScope,
      }),
    });

    entry.ws.send(JSON.stringify(dispatchMsg));
  };
}

// ── onSecretOutputs handler builder ─────────────────────────────────────────

function buildOnSecretOutputs(config: AppConfig, db: Kysely<Database>) {
  return async (runId: string, jobId: string, secretOutputs: Record<string, any>) => {
    try {
      const keyRow = await db
        .selectFrom('run_ephemeral_keys')
        .selectAll()
        .where('run_id', '=', runId)
        .executeTakeFirst();

      if (!keyRow) {
        logger.warn('No ephemeral key found for run, skipping secret output processing', {
          runId,
          jobId,
        });
        return;
      }

      const runPrivateKey = decryptPrivateKey(keyRow.encrypted_private_key, config.secretKey!);

      const secretOutputStore = new SecretOutputStore(db);
      const secretKeyBuf = deriveKey(config.secretKey!);

      for (const [key, envelope] of Object.entries(secretOutputs)) {
        try {
          const plaintext = decryptSecretOutput(envelope, runPrivateKey);
          const reEncrypted = encrypt(plaintext, secretKeyBuf, 1, `secret-output:${runId}`);
          await secretOutputStore.storeSecretOutput(runId, jobId, key, reEncrypted.data);
        } catch (err) {
          logger.warn('Failed to decrypt/store secret output', {
            runId,
            jobId,
            key,
            error: toErrorMessage(err),
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to process secret outputs for job', {
        runId,
        jobId,
        error: toErrorMessage(err),
      });
    }
  };
}

// ── onEventMatched handler builder ──────────────────────────────────────────

interface InternalEventDispatchContext {
  event: any;
  routingKey: string;
  repoIdentifier: string;
  providerContext: Record<string, unknown>;
  providerType: 'github' | undefined;
  repoUrl: string;
  cronCommitSha: string;
}

interface InternalEventDispatchDeps {
  dispatcher: Dispatcher;
  coordinator: RunCoordinator | null;
  executionTracker: ExecutionTracker;
  db: Kysely<Database>;
  sandboxAllowListReader: SandboxAllowListReader;
}

/**
 * Route a workflow's static jobs through the cluster coordinator (cluster mode)
 * or fall back to direct local dispatch on timeout. Returns the locally
 * dispatched job IDs for tracking. The "rerouted" and "failed" cases are
 * logged but do not contribute to the local-tracked set.
 */
async function routeInternalJobsViaCoordinator(
  coordinator: RunCoordinator,
  dispatcher: Dispatcher,
  runId: string,
  workflow: any,
  staticJobs: any[],
  ctx: InternalEventDispatchContext,
  buildInternalJobConfig: (job: any) => Record<string, unknown>,
): Promise<Array<{ jobId: string; jobName: string }>> {
  const dispatchedJobs: Array<{ jobId: string; jobName: string }> = [];

  const jobsToRoute: JobToRoute[] = staticJobs.map((job: any) => {
    const sel = internalJobRunsOnSelectors(job);
    return {
      jobName: job.name,
      runsOnLabels: [sel.runsOnLabels],
      runsOnPatterns: sel.runsOnPatterns,
      excludeLabels: sel.excludeLabels,
      excludePatterns: sel.excludePatterns,
      jobConfig: buildInternalJobConfig(job),
      repoUrl: ctx.repoUrl,
      ref: '',
      sha: ctx.cronCommitSha,
      ...(job.resources && { resources: job.resources }),
    };
  });

  const runCtx: RunContext = {
    runId,
    deliveryId: ctx.event.id,
    routingKey: ctx.routingKey,
    event: ctx.event.eventName,
    action: null,
    provider: ctx.providerType ?? 'internal',
    payload: ctx.event.payload ?? {},
    repoIdentifier: ctx.repoIdentifier,
    sha: ctx.cronCommitSha,
    ref: '',
    workflowName: workflow.name,
    installationId:
      typeof ctx.providerContext.installationId === 'number'
        ? ctx.providerContext.installationId
        : undefined,
  };

  // Add a 30s timeout to routeJobs to prevent blocking indefinitely
  // when peer orchestrators are unreachable or slow to respond.
  const routeResult = await Promise.race([
    coordinator.routeJobs(runCtx, jobsToRoute),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('routeJobs timed out after 30s')), 30_000),
    ),
  ]).catch((err) => {
    logger.warn(
      'Coordinator routing timed out for internal event, falling back to direct dispatch',
      { runId, workflow: workflow.name, error: toErrorMessage(err) },
    );
    return null;
  });

  if (!routeResult) {
    // Timeout fallback: direct dispatch
    return dispatchInternalJobsDirect(dispatcher, runId, workflow, staticJobs, ctx, false);
  }

  for (const local of routeResult.localJobs) {
    dispatchedJobs.push({ jobId: local.jobId, jobName: local.jobName });
  }
  for (const rerouted of routeResult.reroutedJobs) {
    logger.info('Internal event job rerouted to peer', {
      eventId: ctx.event.id,
      runId,
      workflow: workflow.name,
      job: rerouted.jobName,
      peerId: rerouted.peerId,
    });
  }
  for (const failed of routeResult.failedJobs) {
    logger.warn('Internal event job routing failed', {
      eventId: ctx.event.id,
      runId,
      workflow: workflow.name,
      job: failed.jobName,
      reason: failed.reason,
    });
  }
  return dispatchedJobs;
}

/**
 * Direct local dispatch of every static job in a workflow. Used when the
 * coordinator is absent (standalone mode) or after a coordinator timeout.
 */
async function dispatchInternalJobsDirect(
  dispatcher: Dispatcher,
  runId: string,
  workflow: any,
  staticJobs: any[],
  ctx: InternalEventDispatchContext,
  logEachDispatch: boolean,
): Promise<Array<{ jobId: string; jobName: string }>> {
  const dispatchedJobs: Array<{ jobId: string; jobName: string }> = [];
  const buildJobConfig = (job: any) =>
    buildInternalJobConfigForWorkflow(workflow, job, undefined, ctx.event?.payload);

  for (const job of staticJobs) {
    const sel = internalJobRunsOnSelectors(job);
    const result = await dispatcher.dispatch({
      runId,
      workflowName: workflow.name,
      jobName: job.name,
      runsOnLabels: sel.runsOnLabels,
      runsOnPatterns: sel.runsOnPatterns,
      excludeLabels: sel.excludeLabels,
      excludePatterns: sel.excludePatterns,
      jobConfig: buildJobConfig(job),
      repoUrl: ctx.repoUrl,
      ref: '',
      sha: ctx.cronCommitSha,
      deliveryId: ctx.event.id,
      provider: ctx.providerType ?? 'internal',
      providerContext: ctx.providerContext,
      routingKey: ctx.routingKey,
      ...(job.resources && { resources: job.resources }),
    });

    if (result.status !== 'rejected') {
      dispatchedJobs.push({ jobId: result.jobId, jobName: job.name });
    }
    if (logEachDispatch) {
      logger.info('Internal event job dispatched', {
        eventId: ctx.event.id,
        runId,
        workflow: workflow.name,
        job: job.name,
        jobId: result.status !== 'rejected' ? result.jobId : undefined,
        status: result.status,
      });
    }
  }
  return dispatchedJobs;
}

export function buildInternalJobConfigForWorkflow(
  workflow: any,
  job: any,
  sandboxGrant?: ResolvedSandboxGrant,
  firedSchedule?: { cronExpression?: string; timezone?: string },
): Record<string, unknown> {
  // Schedule fires carry no operator input — resolve the trigger's declared
  // defaults. A workflow may declare several schedule() triggers, so for a
  // __schedule_fire event resolve the trigger whose cron matches the schedule
  // that actually fired; fall back to the first schedule for internal events
  // that carry no cron (workflow_complete, job_complete). Non-schedule events
  // have no schedule trigger, so dispatchInputs stays undefined and is omitted.
  const scheduleTriggers = (
    (workflow.triggers ?? []) as Array<{
      _type?: string;
      cronExpression?: string;
      timezone?: string;
      inputs?: Parameters<typeof resolveScheduleInputs>[0];
    }>
  ).filter((t) => t._type === 'schedule');
  const firedCron = firedSchedule?.cronExpression;
  const firedTz = firedSchedule?.timezone;
  const scheduleTrigger = firedCron
    ? (scheduleTriggers.find(
        (t) => t.cronExpression === firedCron && (t.timezone ?? '') === (firedTz ?? ''),
      ) ?? scheduleTriggers[0])
    : scheduleTriggers[0];
  const dispatchInputs = resolveScheduleInputs(scheduleTrigger?.inputs);
  return {
    source: workflow.source ?? undefined,
    workflowName: workflow.name,
    name: job.name,
    steps: job.steps as unknown as Record<string, unknown>[],
    needs: job.needs,
    ...(job.matrix && { matrix: job.matrix }),
    ...(job.include && { include: job.include }),
    ...(job.exclude && { exclude: job.exclude }),
    ...(job.rules && { rules: job.rules }),
    ...(dispatchInputs && { dispatchInputs }),
    ...(workflow.contentHash && { contentHash: workflow.contentHash }),
    ...(job.resources && { resources: job.resources }),
    // The job's container image selects the container execution backend on the
    // agent (determineExecutionMode gives jobConfig.container top priority), so
    // it must survive dispatch or a container:-field job silently runs bare-metal.
    ...(job.container && { container: job.container }),
    // The dispatch-resolved sandbox escape-hatch grant (allow-listed by the
    // caller). Absent ⇒ no grant ⇒ default hardened posture.
    ...(sandboxGrant && { sandboxGrant }),
  };
}

/**
 * Dispatch one matched workflow for an internal event: register the
 * execution row, dispatch its static jobs (via coordinator or direct),
 * and fail the run immediately if no jobs landed (instead of waiting for
 * OrphanRecovery's 5-minute timeout). The whole body is wrapped in
 * try/catch by the caller so a single bad decision doesn't poison the
 * batch.
 */
/**
 * Resolve the static jobs' `sandbox:` escape-hatch requests for an internally
 * triggered workflow against the org allow-list. Populates `out` with the
 * authorized grants and returns a denial reason (to fail the run) on the first
 * non-allow-listed request — deny is loud + total, never a silent strip. When no
 * job requests an escape hatch the allow-list is not even read. An org that
 * cannot be resolved from the routing key falls back to deny-all (safe).
 */
async function resolveInternalSandboxGrants(
  staticJobs: any[],
  routingKey: string,
  db: Kysely<Database>,
  reader: SandboxAllowListReader,
  out: Map<string, ResolvedSandboxGrant>,
): Promise<string | null> {
  if (!staticJobs.some((j) => j.sandbox)) return null;
  let allowList: SandboxAllowList = { capabilities: [], allowHostNetwork: false };
  try {
    allowList = await reader.read(await resolveOrgId(db, routingKey));
  } catch {
    // Org unresolvable → keep the deny-all default (a request will be denied).
  }
  for (const job of staticJobs) {
    if (!job.sandbox) continue;
    const res = resolveSandboxGrant(job.sandbox, allowList);
    if ('denied' in res) return `job '${job.name}': ${res.denied.reason}`;
    if (res.grant) out.set(job.name, res.grant);
  }
  return null;
}

async function dispatchInternalEventDecision(
  decision: any,
  lockFile: any,
  ctx: InternalEventDispatchContext,
  deps: InternalEventDispatchDeps,
): Promise<void> {
  const workflow = lockFile.workflows.find((w: any) => w.name === decision.workflowName);
  if (!workflow) return;

  // Dispatch-resolved sandbox escape-hatch grants, keyed by lock-job name.
  // Populated below (after the run is started) from the org allow-list; the
  // closure reads it by reference at job-dispatch time.
  const sandboxGrants = new Map<string, ResolvedSandboxGrant>();

  // Patch source field for buildInternalJobConfig — needs lockFile fallback
  const buildJobConfig = (job: any): Record<string, unknown> => ({
    ...buildInternalJobConfigForWorkflow(
      workflow,
      job,
      sandboxGrants.get(job.name),
      ctx.event?.payload,
    ),
    source: workflow.source ?? lockFile.source,
  });

  const runId = crypto.randomUUID();

  // Derive triggerEvent for dashboard display from internal event name:
  // __schedule_fire -> 'schedule', __workflow_complete -> 'workflow_complete', etc.
  const triggerEvent =
    ctx.event.eventName === '__schedule_fire'
      ? 'schedule'
      : ctx.event.eventName.startsWith('__')
        ? ctx.event.eventName.slice(2)
        : ctx.event.eventName;

  // Mark runs dispatched by a failure-lifecycle trigger so their own completion
  // is excluded from batch accumulation (a broken notifier must not re-trigger
  // itself). See EventRouter.isFailureLifecycleRun.
  const matchedTrigger = workflow.triggers?.[decision.matchedTrigger ?? -1];
  const dispatchedByFailureLifecycle =
    matchedTrigger?._type === 'workflows_failed_batch' ||
    (matchedTrigger?._type === 'workflow_complete' &&
      Array.isArray(matchedTrigger.status) &&
      matchedTrigger.status.includes('failed'));

  await deps.executionTracker.onExecutionStarted(
    runId,
    workflow.name,
    ctx.providerType ?? 'internal',
    ctx.repoIdentifier,
    '',
    ctx.cronCommitSha,
    ctx.event.id,
    ctx.providerContext,
    {
      matched: true,
      eventName: ctx.event.eventName,
      ...(dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
    },
    [],
    ctx.routingKey,
    undefined,
    triggerEvent,
    undefined, // commitMessage
    undefined, // parentRunId
    undefined, // triggeredBy
    undefined, // originalRunId
    workflow.concurrency
      ? {
          cancelInProgress: workflow.concurrency.cancelInProgress,
          max: workflow.concurrency.max,
        }
      : undefined,
    workflow.timeout, // workflowTimeoutMs
  );

  const staticJobs = workflow.jobs.filter(isLockStaticJob);

  // Resolve each static job's `sandbox:` escape-hatch request against the org
  // allow-list (the single enforcement point — the agent never reads it). A
  // denied request fails the run loudly before any job is dispatched; an org
  // that cannot be resolved from the routing key defaults to deny-all (safe).
  const sandboxDenial = await resolveInternalSandboxGrants(
    staticJobs,
    ctx.routingKey,
    deps.db,
    deps.sandboxAllowListReader,
    sandboxGrants,
  );
  if (sandboxDenial) {
    await deps.executionTracker.failRun(runId, sandboxDenial, {
      scope: 'run',
      category: InitFailureCategory.enum.sandbox_denied,
      message: sandboxDenial,
    });
    logger.warn('Internal event run failed: sandbox escape-hatch denied', {
      runId,
      workflow: workflow.name,
      reason: sandboxDenial,
    });
    return;
  }

  const dispatchedJobs =
    deps.coordinator && staticJobs.length > 0
      ? await routeInternalJobsViaCoordinator(
          deps.coordinator,
          deps.dispatcher,
          runId,
          workflow,
          staticJobs,
          ctx,
          buildJobConfig,
        )
      : await dispatchInternalJobsDirect(deps.dispatcher, runId, workflow, staticJobs, ctx, true);

  if (dispatchedJobs.length > 0) {
    await deps.executionTracker.addJobsToRun(runId, dispatchedJobs);
  }
  // Fail immediately if no jobs landed (no agents available locally or on peers)
  // instead of leaving the run in 'running' for OrphanRecovery to catch later.
  if (dispatchedJobs.length === 0 && staticJobs.length > 0) {
    await deps.executionTracker.failRun(runId, 'No agents available to dispatch jobs');
    logger.warn('Internal event run failed: no agents dispatched', {
      runId,
      workflow: workflow.name,
      eventId: ctx.event.id,
    });
  }
}

function buildOnEventMatched(
  dispatcherRef: { current: Dispatcher | null },
  executionTracker: ExecutionTracker,
  providerRegistryRef: { current: ProviderRegistry },
  coordinatorRef: { current: RunCoordinator | null },
  db: Kysely<Database>,
  sandboxAllowListReader: SandboxAllowListReader,
) {
  return async (
    event: any,
    lockFile: any,
    matchedWorkflows: any[],
    context?: EventMatchContext,
  ) => {
    if (!dispatcherRef.current) {
      logger.debug('onEventMatched firing before dispatcher initialized, deferring', {
        eventId: event.id,
      });
      return;
    }

    logger.info('Internal event matched workflows', {
      eventId: event.id,
      eventName: event.eventName,
      matchedCount: matchedWorkflows.length,
      workflows: matchedWorkflows.map((d: any) => d.workflowName),
    });

    // Resolve provider info from registration context (if available) or event
    const routingKey = context?.routingKey || event.sourceRoutingKey || '';
    const repoIdentifier = context?.repoIdentifier || event.sourceRepo || '';
    const providerContext = context?.providerContext ?? {};
    const providerType = routingKey ? (routingKey.split(':')[0] as 'github') : undefined;
    const bundle = routingKey ? providerRegistryRef.current.getByRoutingKey(routingKey) : undefined;
    const repoUrl = bundle?.repoUrlBuilder
      ? bundle.repoUrlBuilder.buildCloneUrl(repoIdentifier)
      : '';
    // For cron-triggered runs (__schedule_fire), the event payload carries
    // the registration's commitSha so the run can be associated with the
    // commit that registered the workflow (enables clickable workflow links).
    const cronCommitSha =
      event.eventName === '__schedule_fire' ? ((event.payload?.commitSha as string) ?? '') : '';

    const ctx: InternalEventDispatchContext = {
      event,
      routingKey,
      repoIdentifier,
      providerContext,
      providerType,
      repoUrl,
      cronCommitSha,
    };
    const deps: InternalEventDispatchDeps = {
      dispatcher: dispatcherRef.current,
      coordinator: coordinatorRef.current,
      executionTracker,
      db,
      sandboxAllowListReader,
    };

    for (const decision of matchedWorkflows) {
      try {
        await dispatchInternalEventDecision(decision, lockFile, ctx, deps);
      } catch (err) {
        logger.error('Failed to dispatch internal event workflow', {
          eventId: event.id,
          workflow: decision.workflowName,
          error: toErrorMessage(err),
        });
      }
    }
  };
}

// ── Cluster initialization ──────────────────────────────────────────────────

interface ClusterInfra {
  peerRegistry: PeerRegistry;
  raft: RaftNode;
  coordinator: RunCoordinator;
  orphanRecovery: OrphanRecovery;
  peerHandler: ReturnType<typeof createPeerHandler>;
  peerClients: Map<string, PeerClient>;
  getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  broadcastHeartbeatToAllPeers: () => void;
  broadcastAgentTokenRevoke: (tokenId: string) => void;
  /**
   * Mutable handle to the leader-gated recovery-sweep timer. The
   * outer `bootstrapOrchestrator` clears it during graceful shutdown
   * even when this coord lost leadership before the shutdown signal
   * arrived.
   */
  recoverySweepTimerRef: { current: ReturnType<typeof setInterval> | null };
  /**
   * Mutable handle to the peer-side fleet collect responder, armed after the
   * fleet runtime is built. The incoming peer-handler and outgoing peer-clients
   * both delegate to `.current`.
   */
  fleetResponderRef: {
    current:
      | ((msg: PeerLogsCollectRequest, send: (out: PeerToPeerMessage) => boolean) => Promise<void>)
      | null;
  };
}

function initializeCluster(
  config: AppConfig,
  db: Kysely<Database>,
  agentRegistry: AgentRegistry,
  dispatcher: Dispatcher,
  executionTracker: ExecutionTracker,
  checkRunReporter: CheckRunReporter,
  cacheStorage: CacheStorage | undefined,
  scalerManager: ScalerManager | null,
  registrationIndex: RegistrationIndex,
  cronScheduler: CronScheduler,
  configReloaderRef: { current: ConfigReloader | null },
  localConfigVersionRef: { value: number },
  stepLogBuffer: StepLogBuffer,
  eventRetryScannerRef: { onBecomeLeader: () => void; onLoseLeadership: () => void },
  isDraining: () => boolean,
  clusterSettings: ClusterSettingsReader,
  logWriter: LogWriter,
  forwardLogChunk: ((chunk: NormalizedLogChunk) => void) | undefined,
): ClusterInfra {
  const peerClients = new Map<string, PeerClient>();

  // Helper to build local agent inventory for peer heartbeats
  const getLocalInventory = () => ({
    instanceId: config.instanceId,
    timestamp: Date.now(),
    agents: [...agentRegistry.getAllEntries()].map((e) => ({
      agentId: e.agentId,
      labels: [...e.labels],
      activeJobs: e.activeJobs,
      maxConcurrency: e.maxConcurrency,
      platform: e.platform ?? 'linux',
      arch: e.arch ?? 'x64',
      mandatoryLabels: [...e.mandatoryLabels],
      scalerName: scalerManager?.getBackendForAgent(e.agentId) ?? null,
    })),
    draining: isDraining(),
    capabilities: { s3LogAccess: !!cacheStorage },
    ...(scalerManager && {
      scalerCapacity: scalerManager.getStatus().backends.map((b) => ({
        name: b.name,
        type: b.type,
        labelSets: b.labelSets,
        maxAgents: b.maxAgents,
        activeCount: b.activeCount,
        spawnsOnLocalHost: b.spawnsOnLocalHost,
        mandatoryLabels: b.mandatoryLabels,
      })),
    }),
    configVersion: localConfigVersionRef.value,
    registryVersion: registrationIndex.getVersion(),
    clusterSettingsVersion: clusterSettings.getCachedVersion(),
    term: raftRef?.getCurrentTerm() ?? 0,
    leaderId: raftRef?.getLeaderId() ?? null,
  });

  const peerRegistry = new PeerRegistry({
    onConfigVersionBehind: (peerVersion: number) => {
      logger.info('Peer has newer config version, triggering reload', {
        peerVersion,
        localVersion: localConfigVersionRef.value,
      });
      configReloaderRef.current?.triggerReload('cluster');
    },
    onRegistryVersionBehind: (peerVersion: number) => {
      logger.info('Peer has newer registry version, refreshing index', {
        peerVersion,
        localVersion: registrationIndex.getVersion(),
      });
      registrationIndex.refreshIfNeeded(peerVersion).catch((err) => {
        logger.error('Failed to refresh registration index from peer version', {
          error: toErrorMessage(err),
        });
      });
    },
    // Notify Raft when a peer disconnects so it can quickly self-elect
    // if all peers are gone (uses late-binding ref since Raft is created after).
    onPeerDisconnected: () => raftRef?.onPeerDisconnected(),
  });

  // Raft state store
  const raftStateStore = new RaftStateStore({ db, clusterId: 'default' });

  // Orphan recovery (needs raft reference)
  let raftRef: RaftNode | null = null;
  let orphanRecoveryRef: OrphanRecovery;
  /**
   * Timer for the leader-gated `Dispatcher.sweepExpiredRecoveries()`
   * tick. Wrapped in a ref so the outer `bootstrapOrchestrator` shutdown
   * path can clear it (the timer is started/stopped on Raft leader
   * transitions inside this function).
   */
  const recoverySweepTimerRef: { current: ReturnType<typeof setInterval> | null } = {
    current: null,
  };

  // Raft node
  const raftNode = new RaftNode({
    instanceId: config.instanceId,
    stateStore: raftStateStore,
    peerRegistry,
    broadcastToPeers: (msg) => {
      for (const [, client] of peerClients) {
        client.send(msg);
      }
      for (const peer of peerRegistry.getConnectedPeers()) {
        peerHandlerRef.sendToPeer(peer.instanceId, msg);
      }
    },
    onBecomeLeader: () => {
      logger.info('This orchestrator became the Raft leader');
      orphanRecoveryRef.start();
      cronScheduler.onBecomeLeader().catch((err) => {
        logger.error('Failed to start cron scheduler on leader election', {
          error: toErrorMessage(err),
        });
      });
      eventRetryScannerRef.onBecomeLeader();
      // Start the leader-gated recovery sweep. Every 10s the leader
      // marks any `recovering` row whose `recovery_deadline` has
      // passed as `failed` and fires the per-job timeout hook. The
      // previous-coord-crash window (timers lost from process
      // memory) is now closed by this single sweeper.
      if (!recoverySweepTimerRef.current) {
        recoverySweepTimerRef.current = setInterval(() => {
          dispatcher.sweepExpiredRecoveries().catch((err) => {
            logger.error('Recovery sweep failed', { error: toErrorMessage(err) });
          });
          dispatcher.sweepExpiredAckDeadlines().catch((err) => {
            logger.error('Ack deadline sweep failed', { error: toErrorMessage(err) });
          });
        }, 10_000);
      }
    },
    onLoseLeadership: () => {
      logger.info('This orchestrator lost Raft leadership');
      orphanRecoveryRef.stop();
      cronScheduler.onLoseLeadership();
      eventRetryScannerRef.onLoseLeadership();
      if (recoverySweepTimerRef.current) {
        clearInterval(recoverySweepTimerRef.current);
        recoverySweepTimerRef.current = null;
      }
    },
    electionTimeoutMinMs: config.cluster.raftElectionTimeoutMinMs,
    electionTimeoutMaxMs: config.cluster.raftElectionTimeoutMaxMs,
    leaderHeartbeatMs: config.cluster.raftHeartbeatMs,
    gracePeriodMs: config.cluster.singleNode ? 0 : config.cluster.electionGracePeriodMs,
  });
  raftRef = raftNode;

  // Run coordinator
  // peerHandlerObj is assigned later (after createPeerHandler), so we use a mutable reference.
  let peerHandlerObj: ReturnType<typeof createPeerHandler> | null = null;
  const coordinator = new RunCoordinator({
    instanceId: config.instanceId,
    peerRegistry,
    dispatcher,
    executionTracker,
    checkRunReporter,
    getPeerClient: (instanceId) => peerClients.get(instanceId),
    sendAndWaitAckViaHandler: (targetId, msg, timeoutMs) =>
      peerHandlerObj?.sendAndWaitAck(targetId, msg, timeoutMs) ?? Promise.resolve(false),
    sendToPeerViaHandler: (targetId, msg) => peerHandlerObj?.sendToPeer(targetId, msg) ?? false,
    getRerouteSpawnWindowMs: makeOrgNumberReader(
      db,
      'reroute_spawn_window_ms',
      config.rerouteSpawnWindowMs,
    ),
    getRerouteAckTimeoutMs: makeOrgNumberReader(
      db,
      'reroute_ack_timeout_ms',
      config.rerouteAckTimeoutMs,
    ),
    getRerouteMaxHops: makeOrgNumberReader(db, 'reroute_max_hops', config.rerouteMaxHops),
  });

  // Orphan recovery (leader-only)
  const orphanRecovery = new OrphanRecovery({
    db,
    raft: raftNode,
    peerRegistry,
    executionTracker,
    clusterSettings,
    rerouteFlapGraceFallbackMs: config.rerouteFlapGraceMs,
  });
  orphanRecoveryRef = orphanRecovery;

  // Fleet collect responder — assigned after the fleet runtime is built below.
  // A peer.logs.collect.request on either the incoming peer-handler or an
  // outgoing peer-client delegates to this ref to assemble + stream the subtree.
  const fleetResponderRef: {
    current:
      | ((msg: PeerLogsCollectRequest, send: (out: PeerToPeerMessage) => boolean) => Promise<void>)
      | null;
  } = { current: null };

  // A worker orchestrator has no database and no log storage, so the
  // coordinator that owns the run persists the bytes its worker relays. The
  // storage key comes from the same `getJobName` call that fills
  // `execution_steps.log_path`, so the reader and the writer agree by
  // construction.
  const peerLogChunkSink = createLogChunkSink({
    source: 'peer',
    stepLogBuffer,
    logWriter,
    executionTracker,
    ...(forwardLogChunk && { forwardToPlatform: forwardLogChunk }),
  });

  // Peer handler for incoming WS connections
  const peerHandlerRef = createPeerHandler({
    tokenManager: new JoinTokenManager({ db }),
    credentialStore: new PeerCredentialStore(db),
    instanceId: config.instanceId,
    peerRegistry,
    getLocalInventory,
    heartbeatIntervalMs: config.cluster.peerHeartbeatIntervalMs,
    onLogsCollectRequest: (msg, send) =>
      fleetResponderRef.current?.(msg, send) ?? Promise.resolve(),
    onJobReroute: async (msg) => {
      const result = await coordinator.handleIncomingReroute(msg);
      if (msg.coordinatorId) {
        peerHandlerRef.sendToPeer(msg.coordinatorId, {
          type: 'job.reroute.ack',
          messageId: msg.messageId,
          accepted: result.accepted,
          reason: result.reason,
        });
      }
    },
    onPeerLogChunk: (chunk, _peerId) => {
      for (const group of normalizePeerLogChunk(chunk)) {
        peerLogChunkSink(group);
      }
    },
    onPeerCacheUploadRequest: async (req, _peerId) => {
      if (!cacheStorage) {
        return {
          type: 'peer.cache.upload.response' as const,
          messageId: req.messageId,
          runId: req.runId,
          jobId: req.jobId,
          uploadUrl: '',
        };
      }
      const cacheKey = `${req.cacheType}/${req.hash}`;
      const uploadUrl = await cacheStorage.getUploadUrl(cacheKey);
      return {
        type: 'peer.cache.upload.response' as const,
        messageId: req.messageId,
        runId: req.runId,
        jobId: req.jobId,
        uploadUrl,
      };
    },
    onJobProgress: (msg, fromPeerId, reply) =>
      coordinator.onPeerJobProgress(msg, fromPeerId, reply),
    onPeerScalerEvent: (msg, fromPeerId) => coordinator.onPeerScalerEvent(msg, fromPeerId),
    onJobCancel: (msg) => {
      if (!msg.jobId) return;
      const agentId = dispatcher.getAgentIdForJob(msg.jobId);
      if (agentId) {
        const entry = agentRegistry.get(agentId);
        if (entry?.ws) {
          entry.ws.send(
            JSON.stringify({
              type: 'job.cancel',
              messageId: crypto.randomUUID(),
              runId: msg.runId,
              jobId: msg.jobId,
              reason: msg.reason,
            }),
          );
        }
      }
    },
    onRaftVoteRequest: (msg) => raftNode.handleVoteRequest(msg),
    onRaftVoteResponse: (msg) => raftNode.handleVoteResponse(msg),
    onRaftAppendEntries: (msg) => raftNode.handleAppendEntries(msg),
    onPeerLeaving: (msg) => raftNode.handlePeerLeaving(msg.instanceId),
    onAgentTokenRevoke: (msg) => {
      const kicked = agentRegistry.disconnectByTokenId(msg.tokenId);
      // Always log on receipt (not just when kicked > 0): the staging
      // operator-friendly Loki dogfood relies on these lines to confirm
      // the fan-out reached every peer, and KICI_AGENT_AUTH=none deploys
      // legitimately observe kicked=0 because no agent ever populated a
      // tokenId in the registry.
      logger.info('Kicked agent connections after cross-peer revoke', {
        tokenId: msg.tokenId,
        senderInstanceId: msg.senderInstanceId,
        kicked,
      });
    },
    onPeerConfigReload: async (msg) => {
      const reloader = configReloaderRef.current;
      if (!reloader) {
        return {
          success: false,
          errors: ['Config reloader not initialized on target peer'],
        };
      }
      return reloader.executeReload({ source: 'cluster', drain: msg.drain });
    },
    onPeerClusterSettingsRequest: async () => {
      // A DB-less worker pulls the worker-relevant settings snapshot. The async
      // DB read lives here (off the synchronous heartbeat hot path). The leader
      // is the sole holder of cluster_settings, so this resolves live.
      const agentTokenTtlMs = await clusterSettings.getNumber(
        'agent_token_ttl_ms',
        config.agentTokenTtlMs,
      );
      const version = clusterSettings.getCachedVersion();
      logger.info('Serving worker cluster-settings pull', { version, agentTokenTtlMs });
      return {
        version,
        settings: { agentTokenTtlMs },
      };
    },
  });

  // Wire the peer handler into the RunCoordinator for incoming connection message routing
  peerHandlerObj = peerHandlerRef;

  // Debounced heartbeat broadcast — collapses rapid agent connect/disconnect events
  let heartbeatDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcastHeartbeatToAllPeers(): void {
    if (heartbeatDebounceTimer) clearTimeout(heartbeatDebounceTimer);
    heartbeatDebounceTimer = setTimeout(() => {
      heartbeatDebounceTimer = null;
      const inventory = getLocalInventory();

      // Send to outbound peer connections (PeerClients)
      for (const client of peerClients.values()) {
        if (client.state === 'connected') {
          client.send({ type: 'peer.heartbeat', ...inventory });
        }
      }

      // Send to inbound peer connections (peer handler)
      peerHandlerRef.broadcastHeartbeat(inventory);
    }, 100); // 100ms debounce for rapid agent connect/disconnect bursts
  }

  /**
   * Broadcast a `peer.agent-token.revoke` to every connected peer (both
   * outbound PeerClients and inbound peer-handler connections). Each peer's
   * receiver calls `agentRegistry.disconnectByTokenId(tokenId)` locally,
   * closing every in-flight WS authenticated by the now-revoked token. The
   * originating peer kicks itself synchronously inside the DELETE admin
   * route, so this fan-out reaches only the *other* peers in the cluster.
   *
   * Fire-and-forget: matches's Valkey pub/sub semantics (no per-peer
   * ACK, no aggregated kick count). Operators see per-peer detail in Loki
   * via the `Kicked agent connections after cross-peer revoke` log line.
   */
  function broadcastAgentTokenRevoke(tokenId: string): void {
    const msg = {
      type: 'peer.agent-token.revoke' as const,
      tokenId,
      senderInstanceId: config.instanceId,
    };
    for (const client of peerClients.values()) {
      if (client.state === 'connected') client.send(msg);
    }
    peerHandlerRef.broadcastAgentTokenRevoke(msg);
  }

  return {
    peerRegistry,
    raft: raftNode,
    coordinator,
    orphanRecovery,
    peerHandler: peerHandlerRef,
    peerClients,
    getLocalInventory,
    broadcastHeartbeatToAllPeers,
    broadcastAgentTokenRevoke,
    recoverySweepTimerRef,
    fleetResponderRef,
  };
}

// ── Main bootstrap function ─────────────────────────────────────────────────

export async function bootstrapOrchestrator(
  config: AppConfig,
  hooks: OrchestratorHooks,
  options?: { otelSdk?: { shutdown(): Promise<void> } },
): Promise<void> {
  // 1. Initialize database
  const pool = createPool(config.databaseUrl, {
    config: {
      max: config.dbPoolMax,
      connectionTimeoutMillis: config.dbPoolAcquireTimeoutMs,
      statement_timeout: config.dbStatementTimeoutMs,
    },
    onError: (_err, source) => pgPoolClientErrorsTotal.add(1, { source }),
  });
  const db = createDb(pool);
  logger.info('Database connected');

  // 2. Auto-migrate (runs pending migrations with advisory lock for HA safety)
  if (config.autoMigrate) {
    await runMigrations({ db, pool });
  } else {
    logger.info('Auto-migrate disabled (KICI_AUTO_MIGRATE=false)');
  }

  // 2.4. Detect libc collation drift before serving. A stamped-vs-actual
  // collation-version mismatch silently corrupts text b-tree indexes, so a
  // present, correctly-scoped row (e.g. a source private key) can read back as
  // missing. Loud ERROR + `kici_orch_db_collation_drift` gauge on drift; never
  // crashes by default (opt in with KICI_DB_FAIL_ON_COLLATION_DRIFT=true). Heal
  // with `kici-admin db reindex` + `db refresh-collation-version`.
  {
    const { dbName } = parseDatabaseUrl(config.databaseUrl);
    const drift = await checkCollationDriftAtStartup(pool, dbName, logger, {
      failOnDrift: shouldFailOnCollationDrift(process.env),
    });
    setDbCollationDrift(dbName, !!drift);
  }

  // 2.5. Validate cluster identity (split-brain prevention)
  const clusterIdentity = new ClusterIdentity({
    db,
    s3Client:
      config.storage?.type === 's3'
        ? (() => {
            const s3 = createS3Client({
              region: config.storage.region,
              endpoint: config.storage.endpoint,
              forcePathStyle: config.storage.forcePathStyle,
            });
            return {
              getObject: async (bucket: string, key: string) => {
                try {
                  const response = await s3.send(
                    new GetObjectCommand({ Bucket: bucket, Key: key }),
                  );
                  return (await response.Body?.transformToString()) ?? null;
                } catch (e: any) {
                  if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
                  throw e;
                }
              },
              putObject: async (bucket: string, key: string, body: string) => {
                await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
              },
            };
          })()
        : undefined,
    storageBucket: config.storage?.bucket,
    storagePrefix: config.storage?.prefix,
    skipSentinelValidation: config.skipS3SentinelValidation,
  });
  await clusterIdentity.validateAtStartup(config.cluster.instanceId);

  // 2.6. Resolve and persist this cluster's human-friendly name
  // (`cluster_meta.cluster_name`). Auto-generated on first boot;
  // operators rename via `kici-admin cluster-name set`. The result is
  // sent on `source.register` so Platform can surface it on the
  // per-orch dashboard URL.
  const clusterNameResult = await resolveAndPersistClusterName(db, process.env);
  logger.info('Cluster name resolved', {
    clusterName: clusterNameResult.clusterName,
    source: clusterNameResult.source,
  });

  // 2.7. Read the orchestrator DB's stable UUID identifier
  // (`cluster_meta.cluster_id`, seeded by migration 001). Published on
  // `source.register` so Platform can warn when two unrelated clusters
  // accidentally share a `cluster_name`. HA siblings share the same orch
  // DB and therefore the same `cluster_id`; unrelated clusters carry
  // distinct UUIDs.
  const clusterId = await getClusterId(db);
  logger.info('Cluster id resolved', { clusterId });

  // 3. Track shared config version for cluster heartbeats
  const localConfigVersionRef = { value: 0 };

  // 4. Provider registry will be built by SourceManager after secrets init
  // Using an empty placeholder that gets replaced by sourceManager.start()
  let providerRegistry = new ProviderRegistry();

  // Mutable ref so onDispatch always uses the latest registry
  const providerRegistryRef = { current: providerRegistry };

  // 4. Create agent token store and log auth mode
  const tokenStore = new AgentTokenStore(db);
  if (config.agentAuth === 'none') {
    logger.warn(
      'Agent authentication disabled (KICI_AGENT_AUTH=none). All agents will be accepted without tokens.',
    );
  } else {
    logger.info('Agent authentication enabled (token mode)');
  }

  // 5/6. Periodic cleanup schedulers (expired agent tokens + orphaned
  // ephemeral keys / secret outputs) are registered below via
  // bootstrapOrchestratorScheduledJobs alongside queue cleanup so all
  // scheduled work goes through the same observability wrapper.

  // 7. Create agent registry, reconciling into the durable host roster.
  // The store is the same instance the leader-only reaper uses (constructed
  // once, below); the registry fire-and-forget-upserts on register and
  // disconnect-stamps on unregister so declared inventory survives reconnects.
  const hostRosterStore = new HostRosterStore(db);
  const agentRegistry = new AgentRegistry({
    rosterStore: hostRosterStore,
    instanceId: config.instanceId,
  });

  // Fleet log collection: one collector correlates every fleet.logs.request
  // this node sends to its agents with the chunked bundle response. Shared
  // between the agent WS handler (which routes chunk/error frames into it) and
  // the fleet fan-out below (which issues the requests and awaits the bundles).
  const fleetAgentCollector = new FleetAgentCollector({ timeoutMs: FLEET_NODE_TIMEOUT_MS });

  // Cluster-global settings reader: one whole-row short-TTL cache shared by
  // every consumer of a fleet-wide tunable (cluster_settings) — the queue,
  // cache, event circuit-breaker, dispatch build, scaler backends, and the
  // cluster recovery sweepers. Degrades to the config.ts defaults on a sick DB.
  const clusterSettings = new ClusterSettingsReader(db, config.clusterSettingsCacheTtlMs);

  // 8. Create job queue. `queue_max_depth` is fleet-wide (cluster_settings);
  // `queue_timeout_ms` is genuinely per-job (org resolved from the job's
  // jobConfig.cacheOrgId inside enqueue).
  const queue = new JobQueue(db, {
    maxDepth: config.queueMaxDepth,
    defaultTimeoutMs: config.queueTimeoutMs,
    clusterSettings,
    getQueueTimeoutMs: makeOrgNumberReader(db, 'queue_timeout_ms', config.queueTimeoutMs),
  });

  // 8b. Create dedup cache (cleanup scheduler started later after execution tracker)
  const dedup = new DedupCache(db, {
    clusterSettings,
    defaultTtlMs: config.webhookDedupTtlMs,
  });

  // 8c. Coordinator drain controller (pre-upgrade quiescing). Ephemeral,
  // in-memory: a restart comes back accepting and the startup recovery drains
  // the Pending backlog. `jobsRunning` is the live quiesce signal read by
  // `kici-admin orchestrator drain --wait`.
  const drainController = new DrainController({
    activeJobsTotal: () => {
      let sum = 0;
      for (const e of agentRegistry.getAllEntries()) sum += e.activeJobs;
      return sum;
    },
    dispatchedJobsOwned: async () =>
      (await queue.getDepthBreakdown()).byStatus[DispatchQueueStatus.Dispatched] ?? 0,
    onChange: setDraining,
  });

  // 9. Initialize scaler
  // The execution tracker is constructed below (it depends on cache + log
  // infrastructure built after the scaler), so the scaler's event callback
  // late-binds through executionTrackerRef. Scaler events only fire during
  // job dispatch — long after the tracker is assigned to the ref — so the
  // ref is always populated by the time a scaler.failed event arrives.
  let executionTrackerRef: ExecutionTracker | null = null;
  const scalerResult = await initializeScaler(
    config,
    db,
    tokenStore,
    (runId, jobId, ev) => executionTrackerRef?.emitScalerEvent(runId, jobId, ev),
    () => drainController.isDraining(),
    clusterSettings,
  );
  const scalerManager = scalerResult?.manager ?? null;
  const scalerConfig = scalerResult?.config ?? null;

  // Fail fast if a non-co-located scaler would receive a loopback storage URL.
  // A loopback agent-facing endpoint is only reachable by a co-located process;
  // serving it to a scaled agent produces an opaque ECONNREFUSED. Throwing here
  // — before any cache client is built — surfaces the fix in the orchestrator
  // logs instead.
  assertAgentReachableStorage(config, scalerConfig);

  // 10. Initialize cache infrastructure
  const {
    cacheStorage,
    sourceCache,
    depCache,
    userCache,
    artifactStore,
    buildCoordinator,
    pendingBuilds,
    pendingInits,
    pendingDynamics,
    pendingGlobalEvals,
    fsCache,
  } = initializeCacheInfra(config, db, clusterSettings);

  // 11. Create commit status reporter
  const stepLogBuffer = new StepLogBuffer();
  const sourceLocationStore = new SourceLocationStore();
  // CheckRunReporter no longer takes githubConfig from config
  // -- it uses providerRegistry which is populated by SourceManager.
  // dashboardUrl is the static base for `details_url` in GitHub Check
  // Runs; the per-org public alias gets late-bound in server.ts /
  // standalone.ts via setOrgPublicAliasResolver after PlatformClient
  // construction.
  const checkRunTrackingStore = new CheckRunTrackingStore(db);
  const checkRunReporter = new CheckRunReporter({
    providerRegistry,
    stepLogBuffer,
    trackingStore: checkRunTrackingStore,
    getStepSourceLocations: (workflowName, jobName) =>
      sourceLocationStore.get(workflowName, jobName),
    ...(config.dashboardUrl && { dashboardUrl: config.dashboardUrl }),
  });

  // 12. Create log storage, log writer, and execution tracker
  const logStorage = createLogStorage(
    config.storage?.type === 's3'
      ? {
          type: 's3',
          bucket: config.storage.logBucket ?? config.storage.bucket!,
          prefix: 'kici-logs/',
          region: config.storage.region,
          endpoint: config.storage.endpoint,
          forcePathStyle: config.storage.forcePathStyle,
          segmentFlushBytes: config.logSegmentFlushBytes,
          segmentFlushMs: config.logSegmentFlushMs,
        }
      : {
          type: 'filesystem',
          // Execution-log storage base. An explicit KICI_WEBHOOK_PAYLOAD_DIR
          // still overrides (staging/E2E rely on this). Otherwise resolve a
          // writable data root: KICI_DATA_DIR → /var/lib/kici → XDG state dir.
          // A user-level orchestrator can't write /var/lib/kici, so the
          // resolver falls back instead of failing the first job with EACCES.
          basePath:
            (config.webhookPayloadDir ?? resolveDataDir(config.dataDir) + '/cache') + '/logs',
        },
  );
  const observerRegistry = new ObserverRegistry();
  const logWriter = new LogWriter({
    logStorage,
    observerRegistry,
    isTestRun: (runId) => executionTrackerRef?.isTestRun(runId) ?? false,
  });

  // Forward-declare eventEmitter for the onWorkflowComplete/onJobComplete callbacks
  let eventEmitter: EventEmitter | null = null;
  // Forward-declare concurrency refs for slot release on run completion
  let concurrencyTrackerRef: ConcurrencyGroupTracker | null = null;
  let concurrencyQueueManagerRef: ConcurrencyQueueManager | null = null;
  // Forward-declare the slot-release dispatcher built inside createApp; wired
  // back here after createApp returns. Lets the run-completion callback wake
  // up agents parked on the long-poll concurrency wait protocol.
  let tryDispatchNextQueuedRef: ((group: string, routingKey: string) => Promise<void>) | undefined =
    undefined;

  // Get mode-specific extras for execution tracker
  // We'll build a temporary subsystems-like object to pass to the hook.
  // The hook only needs the platformClient (if any), which will be wired later.
  // For now, get the callback creators; actual binding happens via closures.
  const trackerExtras = hooks.executionTrackerExtras?.({} as any);

  const executionTracker = new ExecutionTracker({
    db,
    observerRegistry,
    jobQueue: queue,
    resolveOrgId: (rk: string) => resolveOrgId(db, rk),
    onExecutionComplete: (runId, status, context, description) => {
      const doWork = () => {
        logger.info('Execution completed', { runId, status });

        // Seal any buffered step-log tail segments for this run so the durable
        // S3 record is complete for the dashboard / rerun / follow reads. This
        // fires for EVERY terminal run (not just test runs). Ordering is safe:
        // log chunks and the completion signal arrive in-order on the agent WS,
        // and appendChunk registers its pending promise synchronously before
        // this callback runs, so drain (await-pending -> finalize) captures
        // every chunk.
        logWriter.drain(runId).catch((err) => {
          logger.warn('Failed to drain log writer on run completion', {
            runId,
            error: toErrorMessage(err),
          });
        });

        // Clean up any un-dispatched pending job contexts for this run
        // Fire-and-forget: in-memory Map cleanup is synchronous inside the function;
        // only the DB DELETE is async and can safely be best-effort here.
        cleanupPendingJobContexts(db, runId).catch((err) => {
          logger.warn('Failed to clean up pending job contexts from DB', {
            runId,
            error: toErrorMessage(err),
          });
        });
        // Drop any still-open result-aware eval gates for this run so a run that
        // completed (e.g. cancelled) before an upstream finished doesn't leak a
        // never-resolved gate promise.
        clearEvalGatesForRun(runId);

        const [owner, repo] = context.repoIdentifier.split('/');
        checkRunReporter.updateWorkflowStatus({
          provider: context.provider,
          owner,
          repo,
          sha: context.sha,
          workflowName: context.workflowName,
          // Present only for a cross-repository global run — qualifies the
          // check-run name so this conclusion cannot complete the acted-on
          // repository's same-named check.
          ...(context.workflowRepoIdentifier && {
            workflowRepoIdentifier: context.workflowRepoIdentifier,
          }),
          overallStatus: status,
          installationId: context.installationId,
          routingKey: context.routingKey,
          description,
          // Explicit runId — the onExecutionComplete callback may fire from
          // an agent WS handler or stale-detector tick that's outside the
          // request-context ALS frame, so the reporter cannot rely on its
          // fallback to read runId from getRequestContext(). Without this,
          // buildDetailsUrl() short-circuits on the 'N/A' sentinel and
          // GitHub falls back to the GitHub App's homepage URL.
          runId,
          requestId: context.requestId,
        });

        // Clean up ephemeral keys and secret outputs for forward secrecy
        Promise.all([
          db.deleteFrom('run_ephemeral_keys').where('run_id', '=', runId).execute(),
          db.deleteFrom('run_secret_outputs').where('run_id', '=', runId).execute(),
        ]).catch((err) => {
          logger.warn('Failed to clean up run secrets', {
            runId,
            error: toErrorMessage(err),
          });
        });

        // Release concurrency group slots for this run, then wake up the
        // FIFO-next queued waiter (if any) so a long-polling agent's
        // `waitForConcurrencyAck` resolves to `proceed`.
        if (concurrencyTrackerRef && concurrencyQueueManagerRef) {
          db.selectFrom('concurrency_groups')
            .select(['group_key', 'routing_key'])
            .where('run_id', '=', runId)
            .where('status', '=', 'active')
            .execute()
            .then(async (entries) => {
              for (const entry of entries) {
                concurrencyTrackerRef!.releaseSlot(entry.group_key, entry.routing_key, runId);
                await concurrencyQueueManagerRef!.markCompleted(
                  runId,
                  entry.group_key,
                  entry.routing_key,
                );
                // Dispatch the next queued entry (if any) on this slot. Built
                // inside createApp; ref is wired up after createApp returns.
                if (tryDispatchNextQueuedRef) {
                  await tryDispatchNextQueuedRef(entry.group_key, entry.routing_key);
                }
              }
              if (entries.length > 0) {
                logger.info('Released concurrency slots', {
                  runId,
                  groups: entries.map((e) => e.group_key),
                });
              }
            })
            .catch((err) => {
              logger.warn('Failed to release concurrency slots', {
                runId,
                error: toErrorMessage(err),
              });
            });
        }
      };
      if (context.requestId) {
        requestContext.run({ requestId: context.requestId, runId }, doWork);
      } else {
        doWork();
      }
    },
    onExecutionStatusChange: trackerExtras?.onExecutionStatusChange,
    onStepStatusForward: trackerExtras?.onStepStatusForward,
    onJobStatusChange: trackerExtras?.onJobStatusChange,
    onRunEventEmit: trackerExtras?.onRunEventEmit,
    onOrchLog: trackerExtras?.onOrchLog,
    logStorage,
    orgId: trackerExtras?.orgId,
    onRunPruned: (runId) => {
      stepLogBuffer.cleanup(runId);
      checkRunReporter.cleanupRun(runId);
    },
    onWorkflowComplete: (data) => {
      if (!eventEmitter) return;
      eventEmitter
        .emitWorkflowComplete({
          routingKey: data.routingKey ?? '',
          repo: data.repo,
          workflowName: data.workflowName,
          runId: data.runId,
          status: data.status,
          conclusion: data.status,
          duration: data.duration,
          jobResults: data.jobResults,
          ...(data.failureClass && { failureClass: data.failureClass }),
        })
        .catch((err) => {
          logger.warn('Failed to emit workflow_complete event', { error: String(err) });
        });
    },
    onJobComplete: (data) => {
      // Resolve the job's check run. This hook fires for every job the tracker
      // terminalizes — agent-reported completions, orchestrator-set skips and
      // drift drops, and peer-forwarded completions in cluster mode alike — so
      // posting from here is what stops a check run being left `queued` forever
      // on the commit. Two sweeps that terminalize a job without going through
      // the tracker — the stale-run detector and the queue-expiry sweep in
      // `queue/cleanup.ts` — post their own completion for the same reason.
      // They are not the only direct writers: whole-run cancellation and
      // cluster orphan recovery still settle rows without resolving the job
      // check run (see `docs/architecture/webhooks/github-checks.md`).
      reportJobCheckRunCompletion(
        {
          checkRunReporter,
          getExecutionContext: (runId) => executionTrackerRef?.getExecutionContext(runId),
        },
        {
          runId: data.runId,
          jobId: data.jobId,
          jobName: data.jobName,
          status: data.status,
          data: data.data,
        },
      );

      if (!eventEmitter) return;
      eventEmitter
        .emitJobComplete({
          routingKey: data.routingKey ?? '',
          repo: data.repo,
          workflowName: data.workflowName,
          jobName: data.jobName,
          runId: data.runId,
          jobId: data.jobId,
          status: data.status,
          duration: 0,
          stepResults: [],
        })
        .catch((err) => {
          logger.warn('Failed to emit job_complete event', { error: String(err) });
        });
    },
  });
  executionTrackerRef = executionTracker;

  // wire the needs-aware scheduler's onJobReady callback.
  // When the scheduler determines a job's upstreams are all satisfied,
  // it calls this callback to dispatch the newly-ready job.
  executionTracker.setOnJobReadyCallback(async (runId, jobName) => {
    // A result-aware dynamic eval job is gated by the same needs scheduler, but
    // its "ready" signal goes to the deferred dispatch task (which then gathers
    // the frozen upstream snapshot and dispatches the eval) rather than the
    // normal pending-context dispatch path. openEvalGate returns true when it
    // handled the signal, so we must not also run dispatchReadyJob for it.
    if (openEvalGate(runId, jobName)) return;
    await dispatchReadyJob(runId, jobName, dispatcher, executionTracker, cluster.coordinator, db);
  });

  logger.info('Execution reporting initialized', {
    logStorageType: config.storage?.type ?? 'filesystem',
  });

  // 12b. Construct the inbound webhook delivery log writer.
  // Single instance shared across the relay path (server.ts), the direct
  // ingress paths (app.ts), and the cleanup scheduler.
  const eventLogWriter = new EventLogWriter(db, logStorage, {
    maxPayloadBytes: config.eventLogMaxPayloadBytes,
    clusterSettings,
  });

  // 12b-bis. Access log writer — read + mutation attribution for dashboard
  // and admin HTTP/CLI paths. Best-effort: swallow errors, never fail a read.
  // The SamplingRateLimiter is process-wide so the diagnostics-class
  // 1-row/min/actor cap holds across every WS handler.
  const accessLogRateLimiter = new SamplingRateLimiter();
  const accessLogWriter = new AccessLogWriter(db, undefined, accessLogRateLimiter);

  // 12b-ter. Long-lived cold-store handle for read paths (dashboard,
  // CLI) when cold-store is enabled. The scheduled archive cycle
  // constructs its OWN ephemeral instance per tick (so SIGHUP picks up
  // new bucket/prefix without a restart); these two are intentionally
  // independent. Construction failures (e.g. missing bucket) → null,
  // which the dashboard handler treats as "no cold-store fallback".
  let coldStoreSingleton: ColdStore | null = null;
  try {
    const csConfig = readOrchestratorColdStoreConfig();
    if (csConfig.enabled && csConfig.storage.bucket) {
      coldStoreSingleton = new OrchestratorColdStore({
        config: csConfig,
        instanceId: config.instanceId,
        kdb: db,
        log: (level, msg, extra) => {
          if (level === 'info') logger.info(msg, extra);
          else if (level === 'warn') logger.warn(msg, extra);
          else logger.error(msg, extra);
        },
      });
    }
  } catch (err) {
    logger.warn('cold-store singleton init skipped', { error: toErrorMessage(err) });
  }

  // Phase D: late-bind the cold-store onto the AccessLogWriter so its
  // query() path merges archived rows transparently when pagination
  // crosses the warm cutoff. (AuditLogger gets the same treatment
  // after initializeSecrets returns; that one is gated on
  // --include-archived rather than transparent.)
  accessLogWriter.setColdStore(coldStoreSingleton);

  // 12c. Register the orchestrator's periodic work through the
  // scheduled-job wrapper. Covers queue cleanup (hourly), orphaned
  // secret cleanup (hourly), and agent-token cleanup (every 60s) —
  // all three emit uniform `kici_orch_job_*` metrics and write an
  // access_log row on failure.
  // ONE routability predicate, consulted at two different moments: the
  // unroutable probe's short tick (grace-gated) and the queue-expiry sweep
  // (the backstop). A registered agent means the labels route regardless of
  // capacity; a scaler backend means one could be spawned, which is what keeps
  // a scale-from-zero pool out of the unroutable bucket.
  const canRouteLabels: CanRouteLabels = (labels, patterns, excludeLabels, excludePatterns) =>
    agentRegistry.hasMatchingAgent(labels, patterns, excludeLabels, excludePatterns) ||
    (scalerManager?.hasBackendForLabels(labels, excludeLabels) ?? false);

  const scheduledJobHandles: OrchestratorScheduledJobHandle[] = bootstrapOrchestratorScheduledJobs(
    { db, instanceId: config.instanceId },
    {
      cleanup: {
        intervalMs: 60 * 60 * 1000,
        handler: createCleanupHandler(dedup, queue, {
          db,
          executionTracker,
          // The expiry sweep terminalizes jobs without going through
          // `onJobStatus`, so it resolves their check runs itself.
          checkRunReporter,
          dispatchQueueTtlDays: config.dispatchQueueTtlDays,
          stepLogTtlDays: config.stepLogTtlDays,
          checkRunTrackingTtlDays: config.checkRunTrackingTtlDays,
          // The SAME store instance the reporter writes through, so the sweep
          // and the writer cannot disagree about what is in the table.
          checkRunTrackingStore,
          clusterSettings,
          logStorage,
          logStorageIsS3: config.storage?.type === 's3',
          // Lets the expiry sweep tell "nothing can ever run this" apart from
          // "something could, but never produced an agent" — see
          // `CleanupExtras`. A scaler-managed pool at zero has no registered
          // agent, so the backend half is what keeps scale-from-zero out of the
          // unroutable bucket.
          canRouteLabels,
          // A global eval round has an in-process awaiter and no run row, so
          // this sweep is the only thing that can tell it the job is dead.
          pendingGlobalEvals,
        }),
      },
      // The unroutable probe asks the SAME predicate on a short tick, so a job
      // nothing can run is surfaced in seconds and failed after a grace window
      // instead of waiting out the hourly sweep against a 1-hour timeout.
      //
      // ALWAYS registered, including when the env default is 0 (disabled). The
      // handler re-reads `unroutable_grace_ms` live and no-ops while it is 0,
      // so registering unconditionally is what makes the cluster setting work
      // in BOTH directions: gating registration on the env default meant an
      // orchestrator started with KICI_UNROUTABLE_GRACE_MS=0 could never be
      // re-enabled without a restart, while `cluster-settings.md` promises the
      // value takes effect within a cache window. A disabled tick costs one
      // cached settings read per interval.
      unroutableProbe: {
        // The cadence is fixed at startup, so a 0 default derives it from the
        // shipped default instead — an operator who enables the knob later gets
        // a sane interval rather than the 5s floor.
        intervalMs: probeTickIntervalMs(
          config.unroutableGraceMs > 0 ? config.unroutableGraceMs : DEFAULT_UNROUTABLE_GRACE_MS,
        ),
        handler: createUnroutableProbeHandler({
          queue,
          getGraceMs: () =>
            clusterSettings.getNumber('unroutable_grace_ms', config.unroutableGraceMs),
          canRouteLabels,
          setRoutingReason: makeRoutingReasonWriter(db),
          terminalize: async (job) => {
            await terminalizeUnroutableJob(
              { db, executionTracker, checkRunReporter, canRouteLabels, pendingGlobalEvals },
              job,
            );
            await executionTracker.completeRunIfAllJobsTerminal(job.runId);
          },
          onFastFailed: () => unroutableFastFailedTotal.add(1),
        }),
      },
      orphanSecretCleanup: {
        intervalMs: 60 * 60 * 1000,
        handler: createOrphanSecretCleanupHandler({ db, logger }),
      },
      tokenCleanup: {
        intervalMs: 60_000,
        handler: async () => {
          // Defense-in-depth for the TTL-expiry kick (sister to
          // the revoke kick fixed in 993bc3d9d). The per-token timer
          // scheduled at register-time covers the common case; this
          // periodic sweep covers the corner case where the timer
          // map was wiped (process restart) but the in-flight WS
          // survived the bounce. See
          await tokenStore.cleanupExpired({
            onBeforeDelete: (tokenIds) => {
              for (const tokenId of tokenIds) {
                agentRegistry.disconnectByTokenId(tokenId);
              }
            },
          });
        },
      },
      coldStoreArchive: {
        intervalMs: 60 * 60 * 1000,
        handler: createColdStoreArchiveHandler(config.instanceId, db),
      },
      coldStorePurge: {
        // Phase 2 — runs hourly, offset 15 minutes from the archive
        // sweep so its newly-inserted `cold_store_chunks` rows have
        // settled before the purge looks for expired ones.
        intervalMs: 60 * 60 * 1000,
        handler: createColdStorePurgeHandler(config.instanceId, db),
      },
    },
  );

  // 13. Initialize secrets subsystem
  const { secretResolver, adminDeps, pgSecretStore, auditLogger } = await initializeSecrets(
    config,
    db,
    tokenStore,
    hooks,
  );

  // Late-bind the agent registry into admin route deps so the
  // DELETE /api/v1/agent-tokens/:id route can synchronously kick every
  // in-flight WS authenticated by a revoked token. adminDeps
  // is constructed inside initializeSecrets() before the registry
  // exists; this mirrors the late-binding pattern below for
  // joinTokenManager / sourceStore / db / pool.
  if (adminDeps) {
    adminDeps.agentRegistry = agentRegistry;
    // Expose the drain controller so the admin route
    // (POST/GET /api/v1/admin/orchestrator/drain) can drive it.
    adminDeps.drainController = drainController;
    // The cross-peer broadcaster is bound below after `cluster` is
    // initialized -- it depends on the peer fabric that doesn't exist
    // yet at this point in the bootstrap.
  }

  // Phase D: late-bind the cold-store onto the AuditLogger so its
  // query() path can read archived rows.
  if (auditLogger) auditLogger.setColdStore(coldStoreSingleton);

  // 13b. Initialize SourceStore + SourceManager (DB-first provider management)
  const sourceStore = pgSecretStore
    ? new SourceStore(db, pgSecretStore)
    : (null as unknown as SourceStore);

  const sourceManager = new SourceManager({
    pool,
    sourceStore,
    mode: config.mode,
    onSourcesChanged: () => {
      // Wired by mode-specific hook in onSubsystemsReady
    },
  });

  // Build ProviderRegistry from DB sources (replaces config-based buildProviderRegistry)
  if (pgSecretStore) {
    providerRegistry = await sourceManager.start();
    providerRegistryRef.current = providerRegistry;
    checkRunReporter.updateRegistry(providerRegistry);

    const registeredKeys = providerRegistry.getRoutingKeys();
    if (registeredKeys.length > 0) {
      logger.info('Provider registry built from sources', { routingKeys: registeredKeys });
    } else {
      logger.info('No sources configured yet (orchestrator can start with zero sources)');
    }
  }

  if (adminDeps) {
    adminDeps.sourceStore = sourceStore;
    adminDeps.mode = config.mode;
    adminDeps.db = db;
    adminDeps.pool = pool;
  }
  logger.info('Source management initialized');

  // 14. Initialize event routing infrastructure
  const genericSourceManager = new GenericSourceManager(db);
  const genericBundle = createGenericProviderBundle(genericSourceManager);
  providerRegistry.register('generic', genericBundle);

  // Register a LocalWebhookNormalizer bundle for every generic webhook
  // source flagged provider_type='local'. This is how a git repository
  // present on the agent filesystem dispatches real runs through the generic
  // endpoint without a real GitHub signature. The bundle is registered at the
  // exact routing key so providerRegistry.getByRoutingKey() in the webhook
  // processor resolves to the local normalizer instead of falling back to the
  // generic default bundle (which hardcodes type:'generic_webhook' and never
  // matches push triggers).
  //
  // The local bundle's LockFileFetcher returns null for any repo not
  // physically on the peer's filesystem. The webhook pipeline's multi-provider
  // lock-file fallback (see `resolveLockFileWithFallback` in
  // `pipeline/processor.ts`) handles the cross-provider case: when a
  // local-sourced webhook arrives for a repo whose lock file lives in another
  // provider bundle (e.g., a github source in the same customer), the pipeline
  // iterates same-tenant registrations for that repo and consults each
  // distinct routingKey's bundle until one resolves.
  //
  // Register per-routing-key bundles for every local source already in the DB.
  // Same logic the admin POST /generic-sources handler invokes for
  // freshly-added sources — see webhook/register-source-bundle.ts for the
  // dispatch semantics (local-bundle vs. universal-git vs. no-op) and the
  // canServeGenericProviderType gate that skips local sources on peers whose
  // filesystem does not host the repo.
  // A local (`file://`) source needs the repo inside the agent's filesystem.
  // On a container / firecracker scaler the agent does NOT share the
  // orchestrator host FS, so registration emits a non-fatal reachability
  // warning. Pick a representative non-host-FS backend type (if any) to drive it.
  const localScalerWarnBackend = scalerConfig?.scalers.find(
    (s) => s.type === 'container' || s.type === 'firecracker',
  )?.type;
  try {
    const localSources = await genericSourceManager.listLocalSources();
    for (const row of localSources) {
      registerProviderBundleForSource(row, {
        providerRegistry,
        config,
        secretResolver,
        scalerBackendType: localScalerWarnBackend,
      });
    }
  } catch (err) {
    logger.warn('Failed to register local provider bundles at startup', {
      error: toErrorMessage(err),
    });
  }

  // Register universal-git bundles for every source with a non-null
  // git_config. Per-row error handling lives inside
  // registerProviderBundleForSource (bumps kici_universal_git_registration_
  // errors_total{reason}); we only catch the outer list-fetch failure here.
  try {
    const universalGitSources = await genericSourceManager.listUniversalGitSources();
    for (const row of universalGitSources) {
      registerProviderBundleForSource(row, {
        providerRegistry,
        config,
        secretResolver,
        clusterSettings,
      });
    }
  } catch (err) {
    universalGitRegistrationErrorsTotal.add(1, { reason: 'registration' });
    logger.warn('Failed to enumerate universal-git sources at startup', {
      error: toErrorMessage(err),
    });
  }

  // Warm-path cross-peer propagation: when any peer's admin POST/PATCH/
  // DELETE /generic-sources writes a row, the migration-019 trigger emits
  // pg_notify('generic_sources_change', routing_key); every peer's
  // listener picks that up and applies registerProviderBundleForSource /
  // unregister against its local ProviderRegistry. The bulk loops above
  // are the cold-boot equivalent.
  const genericSourcesChangeListener = new GenericSourcesChangeListener({
    pool,
    sourceManager: genericSourceManager,
    providerRegistry,
    config,
    secretResolver,
    scalerBackendType: localScalerWarnBackend,
  });
  await genericSourcesChangeListener.start();

  /**
   * Re-register one generic source's provider bundle from its database row.
   *
   * The three population paths above — the cold-boot loops, the admin write
   * handler, and the NOTIFY listener — are all WRITE-side. None of them can
   * promise the registry holds a given source at the moment a delivery for it
   * arrives: a NOTIFY can be missed while the listener reconnects, the source
   * can be created on a peer, and a peer can boot before the row exists. The
   * webhook pipeline calls this on an exact miss so the read side settles the
   * question against the database instead of matching against a stand-in
   * bundle that reports every payload as repository-less.
   *
   * Resolves false when the row is gone, disabled, or genuinely has no
   * per-routing-key bundle (a plain generic source) — the caller then uses the
   * shared default bundle, exactly as before.
   */
  const ensureProviderBundle = async (routingKey: string): Promise<boolean> => {
    try {
      const row = await genericSourceManager.getByRoutingKey(routingKey);
      if (!row) return false;
      registerProviderBundleForSource(row, {
        providerRegistry,
        config,
        secretResolver,
        scalerBackendType: localScalerWarnBackend,
      });
      return providerRegistry.hasExact(routingKey);
    } catch (err) {
      // A refresh failure must never fail the delivery: fall through to the
      // registry as it stands, which is what the caller did before this seam.
      logger.warn('Failed to refresh a provider bundle from its source row', {
        routingKey,
        error: toErrorMessage(err),
      });
      return false;
    }
  };

  const eventRouterConfig: EventRouterConfig = {
    maxChainDepth: config.eventRouterMaxChainDepth,
    rateLimitPerWorkflowPerMinute: config.eventRouterRateLimitPerWorkflowPerMinute,
    eventTtlSeconds: config.eventRouterEventTtlSeconds,
    cleanupIntervalMs: config.eventRouterCleanupIntervalMs,
    maxDispatchAttempts: config.eventRouterMaxDispatchAttempts,
    leaseDurationMs: config.eventRouterLeaseDurationMs,
    retryBaseBackoffMs: config.eventRouterRetryBaseBackoffMs,
    retryMaxBackoffMs: config.eventRouterRetryMaxBackoffMs,
    retryScanIntervalMs: config.eventRouterRetryScanIntervalMs,
    debugFailFirstNAttemptsByEvent: parseFaultInjectionMap(
      config.testMode,
      config.testEventFailFirstN,
    ),
  };
  if (eventRouterConfig.debugFailFirstNAttemptsByEvent) {
    logger.warn(
      'Event-dispatch fault-injection ACTIVE — KICI_TEST_MODE=1 + KICI_TEST_EVENT_FAIL_FIRST_N parsed. Production deployments must clear both env vars.',
      { map: eventRouterConfig.debugFailFirstNAttemptsByEvent },
    );
  }
  const eventStore = new EventStore(db, eventRouterConfig);
  const circuitBreaker = new EventCircuitBreaker(eventRouterConfig, clusterSettings);
  const trustStore = new TrustStore(db);

  // Forward-declare dispatcher and coordinator for event router callback
  const dispatcherRef: { current: Dispatcher | null } = { current: null };
  const coordinatorRef: { current: RunCoordinator | null } = { current: null };

  // 15. Initialize registration store and index (before EventRouter so it can match events)
  const registrationStore = new RegistrationStore(db);
  const registrationIndex = new RegistrationIndex(registrationStore);

  // Cached per-org sandbox escape-hatch allow-list reader, consumed at dispatch
  // (both the webhook and internal-event paths) to resolve `sandbox:` requests —
  // the single enforcement point. Created here so the internal-event dispatcher
  // (buildOnEventMatched, below) and the subsystems bundle share one instance.
  const sandboxAllowListReader = createSandboxAllowListReader({ db });

  const eventRouter = new EventRouter({
    db,
    pool,
    eventStore,
    circuitBreaker,
    trustStore,
    config: eventRouterConfig,
    clusterSettings,
    onEventMatched: buildOnEventMatched(
      dispatcherRef,
      executionTracker,
      providerRegistryRef,
      coordinatorRef,
      db,
      sandboxAllowListReader,
    ),
    registrationIndex,
    nodeId: config.instanceId,
  });
  eventEmitter = new EventEmitter(eventRouter);

  // Start event store cleanup and event router LISTEN/NOTIFY
  // EventRouter.start() loads registrations from DB via registrationIndex
  eventStore.startCleanupTimer();
  await eventRouter.start();
  logger.info('Event routing initialized');

  // 16b. Leader-only retry scanner -- closes the at-least-once dispatch loop.
  // The ref is passed into initializeCluster so the Raft onBecomeLeader /
  // onLoseLeadership callbacks can drive it. Calls go through the ref so
  // the scanner can be constructed AFTER initializeCluster wires the
  // callbacks (mirrors orphanRecoveryRef pattern).
  const eventRetryScannerRef: { onBecomeLeader: () => void; onLoseLeadership: () => void } = {
    onBecomeLeader: () => {},
    onLoseLeadership: () => {},
  };
  const eventRetryScanner = new EventRetryScanner({
    db,
    eventStore,
    eventEmitter: eventEmitter!,
    config: eventRouterConfig,
  });
  // Leader-only host-roster reaper (deletes ephemeral rows past their ttl).
  // Driven through the same ref as the event retry scanner so both ride the
  // Raft onBecomeLeader / onLoseLeadership callbacks wired in initializeCluster.
  // Reuses the single hostRosterStore instance the AgentRegistry reconciles into.
  const hostRosterReaper = new HostRosterReaper({
    store: hostRosterStore,
    ttlMs: config.rosterTtlMs,
    graceMs: config.rosterGraceMs,
    scanIntervalMs: 60_000,
    setUnreachableGauge: setDeclaredHostsUnreachable,
  });
  // Leader-gated backstop for the scaler capacity-freed re-drive. Constructed
  // after the dispatcher exists (below) but before initializeCluster fires any
  // leadership callback; the closures reference it lazily so a null (no scaler)
  // deployment no-ops.
  let pendingScaleSweeper: PendingScaleSweeper | null = null;
  eventRetryScannerRef.onBecomeLeader = () => {
    eventRetryScanner.onBecomeLeader();
    hostRosterReaper.onBecomeLeader();
    pendingScaleSweeper?.onBecomeLeader();
  };
  eventRetryScannerRef.onLoseLeadership = () => {
    eventRetryScanner.onLoseLeadership();
    hostRosterReaper.onLoseLeadership();
    pendingScaleSweeper?.onLoseLeadership();
  };

  // 17. Initialize cron scheduler
  const cronStore = new CronStore(db);
  const cronScheduler = new CronScheduler({
    db,
    registrationIndex,
    cronStore,
    eventRouter,
  });

  // 18. Create dispatcher
  //
  // The dispatch-cache-ref tracker is written by buildOnDispatch (per jobId at
  // dispatch time) and read by the agent-WS handler to resolve the user-cache
  // namespace server-side. Constructed before the dispatcher so buildOnDispatch
  // can capture it.
  const dispatchCacheRefs = new DispatchCacheRefTracker();
  const dispatcher = new Dispatcher({
    registry: agentRegistry,
    queue,
    metrics: {
      incJobsDispatched: () => {},
      setQueueDepth: () => {},
      incScalerRedispatch: (trigger, count) => incScalerRedispatch(trigger, count),
    },
    onDispatch: buildOnDispatch(
      config,
      db,
      agentRegistry,
      providerRegistryRef,
      dispatchCacheRefs,
      clusterSettings,
    ),
    onNoMatchingAgent: scalerManager
      ? (labels, jobId, runId, excludeLabels, resources, orgId) =>
          scalerManager!.requestScale(labels, jobId, runId, excludeLabels ?? [], resources, orgId)
      : undefined,
    isDraining: () => drainController.isDraining(),
    maxReconnectDelayMs: config.agentMaxReconnectDelayMs,
    onJobFailedPermanently: (agentId, jobId, runId, reason) => {
      logger.warn('Job permanently failed before/outside agent execution', {
        agentId,
        jobId,
        runId,
        reason,
      });
      executionTracker
        .onJobStatus(runId, jobId, 'failed', Date.now(), undefined, { error: reason })
        .then(() => executionTracker.cancelStepsForJob(runId, jobId, reason))
        .catch((err) => {
          logger.error('Failed to update execution tracker on permanent job failure', {
            jobId,
            error: toErrorMessage(err),
          });
        });
    },
    onRecoveryStarted: (agentId, jobId) => {
      logger.info('Job entering recovery state', { agentId, jobId });
    },
    // Reboot-pending gate + disconnect-survival for workflow-level host restart.
    rosterStore: hostRosterStore,
    getAckTimeoutMs: makeAckTimeoutReader(db, config),
    onAckTimeout: (agentId, jobId, runId) => {
      const entry = agentRegistry.get(agentId);
      if (!entry) return;
      try {
        entry.ws.send(
          JSON.stringify({
            type: 'job.cancel',
            messageId: crypto.randomUUID(),
            runId,
            jobId,
            reason: 'dispatch ack timeout',
          }),
        );
      } catch {
        // Socket may already be dead; the close below is the real teardown.
      }
      try {
        entry.ws.close(WS_CLOSE_DISPATCH_ACK_TIMEOUT, 'dispatch ack timeout');
      } catch (err) {
        logger.warn('Failed to close agent WS after ack timeout', {
          agentId,
          error: toErrorMessage(err),
        });
      }
    },
  });
  dispatcherRef.current = dispatcher;

  // Capacity-freed re-drive: when a scaler agent releases its slot, re-offer the
  // oldest pending jobs to the scaler (near-zero latency) instead of letting them
  // sit until they time out. Fire-and-forget; the dispatcher single-flights it.
  if (scalerManager) {
    scalerManager.onCapacityFreed = () => {
      void dispatcher.retryPendingScaleRequests();
    };
    pendingScaleSweeper = new PendingScaleSweeper({
      redrive: () => dispatcher.retryPendingScaleRequests(DEFAULT_REDRIVE_BATCH, 'sweep'),
      intervalMs: config.scalerPendingSweepIntervalMs,
    });
  }

  // 19. Create ownership tracker
  //
  // The DB fallback (`isJobOwnedByAgentInDb`) makes the per-message ownership
  // check HA-safe: after a Raft leader switch the local `agentJobs` Map is
  // empty, but the DB still records which agent owns which job. `validateAsync`
  // accepts frames for a `dispatched` row whose `agent_id` matches, a
  // `recovering` row whose `recovery_agent_id` matches, or a row that is
  // already terminal — so a post-failover or post-complete frame is handled
  // rather than dropped.
  //
  // The lookup is bounded by `ownership_db_check_timeout_ms`, read fresh per
  // call. A query that fails or outruns the deadline resolves `unknown`, which
  // refuses the frame without counting a violation.
  const ownershipTracker = new OwnershipTracker({
    isJobOwnedByAgent: (agentId, jobId) => dispatcher.isJobOwnedByAgent(agentId, jobId),
    isJobOwnedByAgentInDb: async (agentId, jobId) =>
      (await queue.hasAgentOwnedJob(agentId, jobId)) ? 'owned' : 'not-owned',
    getTimeoutMs: () =>
      clusterSettings.getNumber('ownership_db_check_timeout_ms', config.ownershipDbCheckTimeoutMs),
    onDisconnect: (agentId, reason) => {
      logger.warn('Disconnecting agent due to ownership violations', { agentId, reason });
      const entry = agentRegistry.get(agentId);
      if (entry?.ws) {
        entry.ws.close(WS_CLOSE_GOING_AWAY, reason);
      }
    },
  });

  // Start dispatcher grace window cleanup
  dispatcher.startGraceCleanup();

  // 20. Create lock file cache. Sizes and TTL are structural to the LRU, which
  // is constructed once here, so a cluster-settings override applies at the
  // next orchestrator restart rather than within the settings cache window.
  //
  // The entry counts go through `clampCacheMaxEntries` because the LRU
  // allocates its index arrays eagerly from `max`: an unbounded stored value
  // throws inside the constructor, which would crash boot before the admin API
  // is listening and leave no way to correct the value. The route's `.max()`
  // rejects new bad writes; this clamp is what covers a value already in the
  // database.
  const lockFileCache = new LockFileCache({
    max: clampCacheMaxEntries(
      await clusterSettings.getNumber('lockfile_cache_max', config.lockfileCacheMax),
      config.lockfileCacheMax,
    ),
    ttl: await clusterSettings.getNumber('lockfile_cache_ttl_ms', config.lockfileCacheTtlMs),
    maxBytes: await clusterSettings.getNumber(
      'lockfile_cache_max_bytes',
      config.lockfileCacheMaxBytes,
    ),
  });

  // Tier-1 content-requirements cache: source-file bytes at a ref, keyed by
  // (repo, sha, path). Feeds the `requires` static content filter before dispatch.
  // Sizes and TTL are structural to the LRU, so an override applies at next restart.
  const contentRequirementsCache = new ContentRequirementsCache({
    max: clampCacheMaxEntries(
      await clusterSettings.getNumber('content_cache_max', config.contentCacheMax),
      config.contentCacheMax,
    ),
    ttl: await clusterSettings.getNumber('content_cache_ttl_ms', config.contentCacheTtlMs),
    maxBytes: await clusterSettings.getNumber(
      'content_cache_max_bytes',
      config.contentCacheMaxBytes,
    ),
  });

  // Tier-2 global-eval round-result cache, keyed by (workflow repo, workflow
  // sha, source sha). Its size is structural to the LRU, so an override applies
  // at the next restart; the two round *budgets* are read per round instead, so
  // those land on the next push. The clamp is the same boot-safety guarantee the
  // two caches above rely on — a stored value the route never validated must not
  // be able to throw inside the constructor.
  const globalEvalCache = new GlobalEvalRoundCache({
    max: clampCacheMaxEntries(
      await clusterSettings.getNumber('global_eval_cache_max', config.globalEvalCacheMax),
      config.globalEvalCacheMax,
    ),
  });

  // 21. Initialize cluster
  const configReloaderRef: { current: ConfigReloader | null } = { current: null };

  const cluster = initializeCluster(
    config,
    db,
    agentRegistry,
    dispatcher,
    executionTracker,
    checkRunReporter,
    cacheStorage,
    scalerManager,
    registrationIndex,
    cronScheduler,
    configReloaderRef,
    localConfigVersionRef,
    stepLogBuffer,
    eventRetryScannerRef,
    () => drainController.isDraining(),
    clusterSettings,
    logWriter,
    hooks.forwardLogChunk,
  );
  coordinatorRef.current = cluster.coordinator;

  // Late-bind the cross-peer agent-token-revoke broadcaster onto adminDeps
  // now that `cluster` exists. The DELETE /api/v1/agent-tokens/:id route
  // calls this after the synchronous local kick so every other peer in a
  // clustered orchestrator runs its own AgentRegistry.disconnectByTokenId.
  // Same late-binding pattern as `agentRegistry` above.
  if (adminDeps) {
    adminDeps.broadcastAgentTokenRevoke = cluster.broadcastAgentTokenRevoke;
  }

  // 23. (removed) WebhookSecretManager: post-cutover the orchestrator
  //     no longer pushes webhook secrets to Platform. Platform asks the orch
  //     to verify each inbound webhook via the chunked relay protocol; the
  //     verifyInboundWebhook dispatcher reads secrets directly from
  //     PgSecretStore on demand.

  // 23b. Create SharedConfigStore and JoinHandler for cluster join flow
  let masterKeyForStore: Buffer | null = null;
  let oldMasterKeyForStore: Buffer | null = null;
  try {
    if (config.secretKey || config.secretKeyFile) {
      masterKeyForStore = loadMasterKey(undefined, config.secretKeyFile);
      // Old key fallback enables rotation grace window: if KICI_SECRET_KEY_OLD
      // (or the _OLD file) is set, rows encrypted under the previous
      // generation still decrypt until `rotate-key` has completed.
      oldMasterKeyForStore = loadOldMasterKey(undefined, config.secretKeyFileOld) ?? null;
    }
  } catch {
    // No master key available -- SharedConfigStore will work without encryption
  }
  const sharedConfigStore = await SharedConfigStore.create(
    db,
    masterKeyForStore,
    oldMasterKeyForStore,
  );
  const joinHandler = new JoinHandler({
    db,
    sharedConfigStore,
    clusterIdentity,
    databaseUrl: config.databaseUrl,
  });

  // Wire JoinTokenManager + SharedConfigStore into admin routes
  // (POST /api/v1/admin/join-tokens, POST /api/v1/admin/rotate-key)
  if (adminDeps) {
    adminDeps.joinTokenManager = new JoinTokenManager({ db });
    adminDeps.sharedStore = sharedConfigStore;
  }

  // Local dev-signed identity (offline local dev plane only). Constructed ONLY
  // in independent mode with KICI_INDEPENDENT_IDENTITY=1 + a freshly-generated
  // keypair — never on a Platform-connected orchestrator (which mints via the
  // Platform relay). The public JWK is written next to the private key so
  // `kici local trust-root` can export it, and it seeds the in-process trust
  // root so a `kici-local` bundle verifies at ingest without a JWKS endpoint.
  const localOidcSigner =
    config.mode === 'independent' && config.independentIdentity && config.devIdentityKeyFile
      ? await buildLocalDevSigner(config.devIdentityKeyFile, logger)
      : undefined;

  // Build subsystems object for hooks
  // Provenance trust root: the live issuer is wired by the mode-specific hook
  // from the Platform `auth.success`; the config/env value seeds the CLI path.
  // For the local dev plane, serve the in-process signer's JWKS directly under
  // the `kici-local` issuer (not a URL, so no discovery/fetch).
  // Orchestrator-owned provenance signing (Phase 1 root of trust). When
  // KICI_ORCHESTRATOR_PROVENANCE_ISSUER is set, the orchestrator holds its own
  // ES256 key: it mints + signs identity tokens locally, serves its own JWKS,
  // and verifies at ingest against its own keys. The signer is resolved LAZILY
  // (memoized) on first use so the Raft leader-election race at boot never
  // blocks or crash-loops — the key is reconciled when the first agent requests
  // a token (by which point the cluster has a leader and the key exists).
  const provenanceSigningEnabled = isProvenanceSigningEnabled({
    provenanceSigningIssuer: config.provenanceSigningIssuer,
  });
  const orchestratorSigningRepo = provenanceSigningEnabled
    ? new OrchestratorSigningKeyRepo(db)
    : undefined;
  let cachedOrchestratorSigner: Signer | null = null;
  const reconcileSignerOnce = (): Promise<{ signer: Signer } | null> =>
    reconcileOrchestratorSigningKey({
      repo: orchestratorSigningRepo!,
      config: {
        provenanceSigningIssuer: config.provenanceSigningIssuer,
        provenanceSignerKind: config.provenanceSignerKind,
        provenanceKmsKeyArn: config.provenanceKmsKeyArn,
        provenanceKmsRegion: config.provenanceKmsRegion,
        provenanceKmsAccessKeyId: config.provenanceKmsAccessKeyId,
        provenanceKmsSecretAccessKey: config.provenanceKmsSecretAccessKey,
        provenanceSignerCommand: config.provenanceSignerCommand,
      },
      isLeader: () => cluster.raft?.isLeader() ?? true,
      secretKey: config.secretKey,
      audit: ({ kid, signerKind }) => {
        logger.info('activated orchestrator provenance signing key', { kid, signerKind });
      },
    });
  // Resolve the signer, WAITING (bounded) for the key to be provisioned rather
  // than immediately deferring. This closes the security-critical mint-in-boot-
  // window race: a mint that arrives before the leader has generated the key
  // must NOT fall back to the Platform relay (which would produce an intermittent
  // Platform-signed bundle that fails verification against the orchestrator trust
  // root). Once provisioned (eager reconcile at boot, or the first mint), the
  // signer is memoized and returned immediately.
  const resolveOrchestratorSigner = async (): Promise<Signer | null> => {
    if (!orchestratorSigningRepo) return null;
    if (cachedOrchestratorSigner) return cachedOrchestratorSigner;
    for (let attempt = 0; attempt < 60; attempt++) {
      const reconciled = await reconcileSignerOnce().catch(() => null);
      if (reconciled) {
        cachedOrchestratorSigner = reconciled.signer;
        return cachedOrchestratorSigner;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  };

  // Dashboard-encryption (X25519) key: the trust root for browser-sealed
  // dashboard writes under the `encrypted` posture. Available whenever the
  // master key (KICI_SECRET_KEY) is configured — it wraps the private half.
  // Leader-gated generation (same HA-safe pattern as the signer), resolved
  // lazily + memoized so the leader-election race at boot never crash-loops.
  const dashboardEncryptionRepo = config.secretKey ? new DashboardEncryptionKeyRepo(db) : undefined;
  let cachedDashboardEncryptionKey: ResolvedDashboardEncryptionKey | null = null;
  const resolveDashboardEncryptionKey =
    async (): Promise<ResolvedDashboardEncryptionKey | null> => {
      if (!dashboardEncryptionRepo) return null;
      if (cachedDashboardEncryptionKey) return cachedDashboardEncryptionKey;
      const reconciled = await reconcileDashboardEncryptionKey({
        repo: dashboardEncryptionRepo,
        isLeader: () => cluster.raft?.isLeader() ?? true,
        secretKey: config.secretKey,
        audit: ({ kid }) => {
          logger.info('activated dashboard encryption key', { kid });
        },
      }).catch((err) => {
        logger.warn('dashboard encryption key reconcile failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      if (reconciled) cachedDashboardEncryptionKey = reconciled;
      return reconciled;
    };
  // Eagerly provision the key at boot so the JWKS publishes it before the first
  // sealed write. Bounded-retry (same shape as the signer resolve) because the
  // reconcile is leader-gated: at cold boot no node is raft-leader yet, so the
  // first attempts return null; we retry until the elected leader generates the
  // key (or any node reads the row the leader wrote to the shared DB).
  if (dashboardEncryptionRepo) {
    void (async () => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const resolved = await resolveDashboardEncryptionKey();
        if (resolved) return;
        await new Promise((res) => setTimeout(res, 500));
      }
      logger.warn('dashboard encryption key not provisioned after boot retries');
    })();
  }

  // Provenance trust root: for orchestrator-owned signing, verify at ingest
  // against the orchestrator's own key set (fresh rotations/revocations). For the
  // offline local dev plane, serve the in-process signer's JWKS under the fixed
  // `kici-local` issuer. Otherwise the config/env value seeds the CLI path.
  const provenanceTrustRoot =
    provenanceSigningEnabled && orchestratorSigningRepo
      ? provenanceTrustRootFromRepo(
          orchestratorSigningRepo,
          config.provenanceSigningIssuer as string,
        )
      : localOidcSigner
        ? createProvenanceTrustRoot({
            issuer: KICI_LOCAL_ISSUER,
            staticJwks: { keys: [localOidcSigner.getPublicJwk() as Record<string, unknown>] },
          })
        : createProvenanceTrustRoot({
            issuer: config.provenanceIssuer ?? null,
          });

  // Single webhook-ingest admission controller for the process, shared by the
  // HTTP direct-ingress closure (createApp) and the Platform-WS relay path
  // (server.ts wires PlatformClient.onAdmit from subsystems.ingestController).
  const ingestCapReader = createOrgIngestCapReader({
    db,
    clusterDefault: config.ingestOrgMaxConcurrency,
  });
  const ingestController = new IngestAdmissionController({
    config: {
      maxConcurrency: config.ingestMaxConcurrency,
      maxQueueDepth: config.ingestMaxQueueDepth,
      codelTargetMs: config.ingestCodelTargetMs,
      codelIntervalMs: config.ingestCodelIntervalMs,
      queueMaxWaitMs: config.ingestQueueMaxWaitMs,
      loopLagShedMs: config.ingestLoopLagShedMs,
      loopLagResumeMs: config.ingestLoopLagResumeMs,
      loopLagSampleMs: config.ingestLoopLagSampleMs,
    },
    loopLag: new RealLoopLagSource(),
    onStateChange: (s: IngestAdmissionSnapshot) => setIngestAdmissionState(s),
    onShedMetric: (reason) => ingestShedTotal.add(1, { reason }),
    onAdmitMetric: () => ingestAdmittedTotal.add(1),
  });
  // Config-sourced limit gauges so the dashboard overlays current-vs-limit and
  // the ratio alerts track the deployed caps (never a hardcoded threshold).
  setIngestAdmissionLimits({
    maxConcurrency: config.ingestMaxConcurrency,
    maxQueueDepth: config.ingestMaxQueueDepth,
    orgMaxConcurrency: config.ingestOrgMaxConcurrency,
    loopLagShedMs: config.ingestLoopLagShedMs,
    loopLagResumeMs: config.ingestLoopLagResumeMs,
    overflowMax: config.ingestOverflowMax,
  });

  // Durable overflow buffer: capture shed deliveries and replay them once the
  // admission controller stops shedding. Default-on (config.ingestOverflowEnabled).
  const ingestOverflowBuffer = new IngestOverflowBuffer({
    db,
    maxRows: config.ingestOverflowMax,
  });
  const ingestOverflowReplayer = new IngestOverflowReplayer({
    db,
    controller: ingestController,
    intervalMs: config.ingestOverflowReplayIntervalMs,
    batchSize: config.ingestOverflowReplayBatch,
    maxAttempts: config.ingestOverflowMaxAttempts,
    claimTimeoutMs: config.ingestOverflowClaimTimeoutMs,
    clusterSettings,
  });
  if (config.ingestOverflowEnabled) {
    ingestOverflowReplayer.start();
  }

  const subsystems: OrchestratorSubsystems = {
    config,
    db,
    pool,
    clusterSettings,
    ingestController,
    ingestCapReader,
    sandboxAllowListReader,
    ingestOverflowBuffer,
    ingestOverflowReplayer,
    providerRegistry,
    agentRegistry,
    hostRosterStore,
    dispatcher,
    queue,
    scalerManager,
    scalerConfig,
    cacheStorage,
    provenanceTrustRoot,
    sourceCache,
    depCache,
    userCache,
    artifactStore,
    dispatchCacheRefs,
    buildCoordinator,
    pendingBuilds,
    pendingInits,
    pendingDynamics,
    pendingGlobalEvals,
    checkRunReporter,
    stepLogBuffer,
    sourceLocationStore,
    logStorage,
    logWriter,
    observerRegistry,
    executionTracker,
    secretResolver,
    adminDeps,
    pgSecretStore,
    dashboardEncryption: dashboardEncryptionRepo
      ? { resolve: resolveDashboardEncryptionKey }
      : undefined,
    tokenStore,
    ownershipTracker,
    lockFileCache,
    contentRequirementsCache,
    globalEvalCache,
    dedup,
    eventRouter,
    eventStore,
    eventEmitter: eventEmitter!,
    genericSourceManager,
    ensureProviderBundle,
    trustStore,
    registrationStore,
    registrationIndex,
    cronScheduler,
    peerRegistry: cluster.peerRegistry,
    raft: cluster.raft,
    coordinator: cluster.coordinator,
    orphanRecovery: cluster.orphanRecovery,
    peerHandler: cluster.peerHandler,
    peerClients: cluster.peerClients,
    getLocalInventory: cluster.getLocalInventory,
    broadcastHeartbeatToAllPeers: cluster.broadcastHeartbeatToAllPeers,
    broadcastAgentTokenRevoke: cluster.broadcastAgentTokenRevoke,
    joinHandler,
    configReloader: null as any, // assigned after creation below
    localConfigVersion: localConfigVersionRef.value,
    sourceStore,
    sourceManager,
    genericSourcesChangeListener,
    eventLogWriter,
    accessLogWriter,
    coldStore: coldStoreSingleton,
    // Single instance so the HTTP scrape path (orchestrator's own
    // /metrics) and the WS push path (Mimir per-org via MetricsReporter)
    // both reference the same store of agent-pushed metrics. The
    // getScalerForAgent callback stamps a `scaler` label on every
    // kici_agent_* series so dashboards split per scaler TYPE
    // (`stateful` for static agents, backend type otherwise) instead of
    // per-agent_id which is too high-cardinality and only useful for
    // drill-down filtering. The label is the backend TYPE, not the
    // operator-chosen scaler name -- the Platform catalog enum admits
    // only the four types.
    agentMetricsAggregator: new AgentMetricsAggregator({
      getScalerForAgent: scalerManager
        ? (agentId) => scalerManager.getBackendType(agentId)
        : undefined,
    }),
    fleetCollectResponder: (msg, send) =>
      cluster.fleetResponderRef.current?.(msg, send) ?? Promise.resolve(),
  };

  // 24. Call mode-specific hook for wiring
  const modeResult = await hooks.onSubsystemsReady(subsystems);

  // 25. Start Raft. Webhook secrets are read on-demand by
  //     verifyInboundWebhook directly from PgSecretStore, so there is no
  //     long-lived LISTEN/NOTIFY subscription to start here anymore.
  await cluster.raft.start();
  cluster.peerRegistry.setLocalRegistryVersion(registrationIndex.getVersion());

  // Eagerly provision the provenance signing key once leadership settles, so the
  // public JWKS endpoint is populated shortly after boot instead of only on the
  // first agent token request. Fire-and-forget with a bounded retry (the resolve
  // is memoized + leader-gated for db custody, so a non-leader just waits).
  if (provenanceSigningEnabled) {
    void (async () => {
      for (let i = 0; i < 120; i++) {
        const resolved = await resolveOrchestratorSigner().catch(() => null);
        if (resolved) {
          logger.info('provenance signing key provisioned', {
            kid: await resolved.getKid().catch(() => 'unknown'),
          });
          return;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      logger.warn(
        'provenance signing key not provisioned after boot retries (still lazy on demand)',
      );
    })();
  }

  // Start stale peer eviction timer (removes peers that miss heartbeats)
  cluster.coordinator.startStaleEvictionTimer(config.cluster.peerStaleTimeoutMs);

  logger.info('Cluster initialized', {
    instanceId: config.instanceId,
    address: config.cluster.address,
    peers: config.cluster.peers.length > 0 ? config.cluster.peers.length : 'none (single-orch)',
  });

  // 26. DB polling fallback for registry sync
  const registryPollInterval = setInterval(async () => {
    try {
      const dbVersion = await registrationStore.getVersion();
      const localVersion = registrationIndex.getVersion();
      if (dbVersion > localVersion) {
        logger.info('DB registry version ahead, refreshing index', {
          dbVersion,
          localVersion,
        });
        await registrationIndex.refreshIfNeeded(dbVersion);
        cluster.peerRegistry.setLocalRegistryVersion(registrationIndex.getVersion());
      }
    } catch (err) {
      logger.error('Registry version poll failed', {
        error: toErrorMessage(err),
      });
    }
  }, 30_000);

  // 26b. Per-coordinator safety-net re-drive of pending jobs onto connected
  // idle agents. Runs on EVERY coordinator (not leader-gated, unlike the ack
  // sweep) at the same 10s cadence: a job requeued after the only matching
  // connected agent's drain trigger already fired has no further trigger, so a
  // one-shot `redispatch` that transiently misses that agent (in-flight drain
  // holding the eager slot, or the agent connected to a different coordinator)
  // would strand it. This tick re-attempts delivery through the atomic claim,
  // so at most one agent on any coordinator wins the job. Gated internally on a
  // non-empty queue, so an idle cluster does no work.
  const pendingRedriveInterval = setInterval(() => {
    dispatcher.redrivePendingToConnectedAgents().catch((err) => {
      logger.error('Pending connected-agent re-drive failed', { error: toErrorMessage(err) });
    });
  }, 10_000);

  // 27. Create Hono app
  const clusterHealthRoutes = createClusterHealthRoutes({
    instanceId: config.instanceId,
    raft: cluster.raft,
    peerRegistry: cluster.peerRegistry,
    executionTracker,
    agentRegistry,
  });

  // Concurrency group support -- always enabled
  const concurrencyTracker = new ConcurrencyGroupTracker();
  const concurrencyQueueManager = new ConcurrencyQueueManager(db);
  concurrencyTrackerRef = concurrencyTracker;
  concurrencyQueueManagerRef = concurrencyQueueManager;

  // 27.5 Construct ConfigReloader BEFORE createApp so the admin config routes
  // can hold a reference to it. The reloader needs subsystems and modeResult,
  // both already initialized above.
  const configReloader = new ConfigReloader(config as any, {
    resolveLocalConfig: async () => {
      const result = await resolveLocalConfig();
      return { local: result.local };
    },
    resolveFullConfig: (local, dbConfig) => resolveFullConfig(local, dbConfig) as any,
    sharedStore: null,
    onProviderChange: modeResult.configReloaderExtras?.onProviderChange
      ? (((newConfig: any, oldConfig: any) =>
          modeResult.configReloaderExtras!.onProviderChange!(
            newConfig,
            oldConfig,
            subsystems,
          )) as any)
      : ((async () => {
          // Default: reload sources from DB (providers are DB-managed now)
          await sourceManager.reload();
          providerRegistry = sourceManager.getRegistry();
          providerRegistryRef.current = providerRegistry;
          checkRunReporter.updateRegistry(providerRegistry);
          logger.info('Provider registry reloaded from sources', {
            routingKeys: providerRegistry.getRoutingKeys(),
          });
        }) as any),
    onScalerReload: scalerManager
      ? async () => {
          scalerConfigReloadsTotal.add(1, { result: 'attempted' });
          try {
            const newScalerConfig = await loadScalerConfig(
              config.scalerConfigPath!,
              config.scalerConfigDir,
            );
            const overlaps = detectLabelSetOverlaps(newScalerConfig.scalers);
            if (overlaps.length > 0) {
              logger.error('New config has label-set overlaps, keeping current config', {
                overlaps,
              });
              scalerConfigReloadsTotal.add(1, { result: 'failed' });
              return;
            }
            const result = await scalerManager!.reload(newScalerConfig);
            if (!result.valid) {
              logger.error('Config reload validation failed, keeping current config', {
                errors: result.errors,
              });
              scalerConfigReloadsTotal.add(1, { result: 'failed' });
              return;
            }
            logger.info('Scaler configuration reloaded successfully');
            scalerConfigReloadsTotal.add(1, { result: 'success' });
          } catch (err) {
            logger.error('Scaler config reload error', {
              error: toErrorMessage(err),
            });
            scalerConfigReloadsTotal.add(1, { result: 'failed' });
          }
        }
      : undefined,
    onPlatformReconnect: modeResult.configReloaderExtras?.onPlatformReconnect as any,
    onConfigApplied: (_newConfig) => {
      localConfigVersionRef.value++;
      cluster.peerRegistry.setLocalConfigVersion(localConfigVersionRef.value);
      logger.info('Config applied', { configVersion: localConfigVersionRef.value });
    },
    logger,
  });
  configReloaderRef.current = configReloader;
  subsystems.configReloader = configReloader;
  configReloader.installSignalHandler();

  // 27.6 Periodic dispatch-queue depth refresher.
  //
  // Drives the `kici_orch_dispatch_queue_depth{status}` and
  // `..._by_label{status,label}` observable gauges. The refresher is the
  // single source of truth for Prometheus's view of the queue, so
  // Prometheus scrapes never touch the DB. It also evaluates the
  // `queueBackpressureThreshold` warning (0 = disabled, default 100),
  // reading the threshold lazily on every tick so SIGHUP reloads take
  // effect immediately without restarting the refresher.
  const queueDepthRefresher: DepthRefresher = createDepthRefresher({
    queue,
    logger,
    thresholdGetter: () => configReloader.getCurrentConfig().queueBackpressureThreshold,
  });
  queueDepthRefresher.start();

  // Forward a config reload request to a specific peer instance via the
  // cluster connection. Tries the outgoing PeerClient first (peers we connected
  // TO), then the incoming peer-handler connections (peers that connected to us).
  // Returns null if the target peer is unknown / not connected via either path.
  const forwardReloadToPeer = async (
    targetInstanceId: string,
    opts: { drain?: boolean; timeoutMs?: number },
  ): Promise<ReloadResult | null> => {
    const messageId = crypto.randomUUID();
    const reloadMsg = {
      type: 'peer.config.reload' as const,
      messageId,
      drain: opts.drain,
    };
    const timeoutMs = opts.timeoutMs ?? 15_000;

    // Try outgoing PeerClient first
    const outgoing = cluster.peerClients.get(targetInstanceId);
    if (outgoing && outgoing.state === 'connected') {
      const response = await outgoing.sendConfigReloadAndWait(reloadMsg, timeoutMs);
      if (response) {
        return {
          success: response.success,
          version: response.version,
          errors: response.errors,
          restartRequired: response.restartRequired,
          fieldsChanged: response.fieldsChanged,
        };
      }
    }

    // Fall back to incoming peer-handler connections
    const response = await cluster.peerHandler.sendConfigReloadAndWait(
      targetInstanceId,
      reloadMsg,
      timeoutMs,
    );
    if (response) {
      return {
        success: response.success,
        version: response.version,
        errors: response.errors,
        restartRequired: response.restartRequired,
        fieldsChanged: response.fieldsChanged,
      };
    }

    return null;
  };

  const configRouteDeps: ConfigRouteDeps | undefined = config.secretKey
    ? {
        sharedStore: sharedConfigStore,
        configReloader,
        loadLocalConfig: async () => {
          const result = await resolveLocalConfig();
          return result.local as any;
        },
        // Bootstrap admin token: KICI_SECRET_KEY (operators must set this for
        // /admin/config/* to be accessible). Routes return 503 if undefined.
        adminToken: config.secretKey,
        forwardReloadToPeer,
      }
    : undefined;

  // Fleet log collection runtime — built from the live registries + cluster so
  // the /admin/fleet-topology + /admin/fleet-bundle routes (and the peer-side
  // responder) can enumerate and recursively assemble the cluster's bundles.
  const fleetRuntime: FleetRuntime = {
    instanceId: config.instanceId,
    role: config.cluster.role,
    logWindowHours: 4,
    timeoutMs: FLEET_NODE_TIMEOUT_MS,
    logDir: process.env.KICI_LOG_DIR,
    agentRegistry,
    peerRegistry: cluster.peerRegistry,
    fleetAgentCollector,
    peerClients: cluster.peerClients,
    peerHandler: cluster.peerHandler,
    diagnosticDeps: {
      db,
      platformUrl: config.platformUrl,
      agentRegistry,
      config: config as unknown as Record<string, unknown>,
      tlsCertPath: config.tlsCertPath,
      scalerManager: scalerManager ?? undefined,
    },
    config: config as unknown as Record<string, unknown>,
    clusterHealthUrl: `http://127.0.0.1:${config.port}/cluster/health`,
  };
  // Now that the runtime exists, arm the peer-side collect responder (used by
  // both the incoming peer-handler and outgoing peer-clients).
  cluster.fleetResponderRef.current = makeFleetCollectResponder(fleetRuntime);

  // Warmth latch surfaced on `GET /ready`: flips true at the end of the boot
  // sequence (after every subsystem starts and the HTTP server is serving), so
  // an external gate can wait for the orchestrator to be ready to serve rather
  // than merely process-live.
  let warm = false;

  const { app, wss, tryDispatchNextQueued, reinjectDirect } = createApp({
    config,
    db,
    clusterSettings,
    isWarm: () => warm,
    pool,
    registry: agentRegistry,
    hostRosterStore,
    dispatcher,
    jobQueue: queue,
    dedup,
    lockFileCache,
    contentRequirementsCache,
    globalEvalCache,
    providerRegistry,
    ingestController,
    ingestCapReader,
    sandboxAllowListReader,
    ingestOverflowBuffer,
    ingestOverflowReplayer,
    scalerManager: scalerManager ?? undefined,
    tokenStore,
    ownershipTracker,
    fleetAgentCollector,
    sourceCache,
    buildCoordinator,
    depCache,
    userCache,
    artifactStore,
    dispatchCacheRefs,
    cacheStorage,
    provenanceTrustRoot,
    localOidcSigner,
    ...(provenanceSigningEnabled && orchestratorSigningRepo
      ? {
          provenanceSigning: {
            issuer: config.provenanceSigningIssuer as string,
            resolveSigner: resolveOrchestratorSigner,
            repo: orchestratorSigningRepo,
          },
        }
      : {}),
    ...(dashboardEncryptionRepo
      ? {
          dashboardEncryption: {
            repo: dashboardEncryptionRepo,
            resolve: resolveDashboardEncryptionKey,
          },
        }
      : {}),
    fsCache,
    pendingBuilds,
    pendingInits,
    pendingDynamics,
    pendingGlobalEvals,
    checkRunReporter,
    executionTracker,
    logWriter,
    stepLogBuffer,
    adminDeps,
    clusterHealthRoutes,
    peerHandler: cluster.peerHandler,
    onAgentInventoryChanged: cluster.broadcastHeartbeatToAllPeers,
    onJoinRequest: (msg) => joinHandler.handleJoinRequest(msg),
    eventRouter,
    eventStore,
    eventEmitter: eventEmitter!,
    genericSourceManager,
    ensureProviderBundle,
    // Direct GitHub ingress deps (mounted only in hybrid/independent with a
    // configured secret store — mirrors the relay path's onVerifyInbound guard).
    githubSourceStore: pgSecretStore ? sourceStore : undefined,
    githubVerifyDeps: pgSecretStore
      ? { db, secretStore: pgSecretStore, genericSourceManager }
      : undefined,
    trustStore,
    observerRegistry,
    tokenManager: adminDeps?.tokenManager,
    secretResolver: secretResolver ?? undefined,
    cronScheduler,
    registrationStore,
    registrationIndex,
    logStorage,
    onSecretOutputs: buildOnSecretOutputs(config, db),
    concurrencyTracker,
    concurrencyQueueManager,
    coordinator: cluster.coordinator,
    peerRegistry: cluster.peerRegistry,
    configRouteDeps,
    eventLogWriter,
    accessLogWriter,
    coldStore: coldStoreSingleton,
    agentMetricsAggregator: subsystems.agentMetricsAggregator,
    fleetRoutes: {
      getTopology: () => getFleetTopologyImpl(fleetRuntime),
      collectBundle: (opts: {
        selectors: string[];
        logWindowHours?: number;
        timeoutSeconds?: number;
      }) => {
        const runtime: FleetRuntime = {
          ...fleetRuntime,
          logWindowHours: opts.logWindowHours ?? fleetRuntime.logWindowHours,
          timeoutMs: opts.timeoutSeconds ? opts.timeoutSeconds * 1000 : fleetRuntime.timeoutMs,
        };
        const topology = getFleetTopologyImpl(runtime);
        const selectionByOrch =
          opts.selectors.length > 0 ? resolveSelection(topology, opts.selectors) : null;
        return collectFleetImpl(runtime, selectionByOrch);
      },
    },
    ...modeResult.appDepsExtras,
  });
  // Wire the long-poll concurrency dispatcher built inside createApp into the
  // forward-declared ref consumed by `onExecutionComplete` above.
  tryDispatchNextQueuedRef = tryDispatchNextQueued;

  // Wire the HTTP-direct overflow re-injector (built inside createApp, closes
  // over runWebhookIngest) into the replayer. The relay re-injector is wired in
  // server.ts where the verify + relay processing closures live.
  ingestOverflowReplayer.setReinjectDirect(reinjectDirect);

  // 28. Start HTTP server
  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      websocket: { server: wss },
    },
    (info) => {
      logger.info(hooks.startupLogMessage(info.port), {
        port: info.port,
        mode: config.mode,
        environment: config.nodeEnv,
      });
    },
  );

  // 29. Start heartbeat monitor
  const heartbeatMonitor = new AgentHeartbeatMonitor({
    registry: agentRegistry,
    dispatcher,
  });
  heartbeatMonitor.start();
  logger.info('Agent heartbeat monitor started');

  // 30. Start stale run detector
  const staleRunDetector = new StaleRunDetector({
    db,
    executionTracker,
    checkRunReporter,
    scalerManager: scalerManager ?? undefined,
    dispatcher,
    registry: agentRegistry,
    peerRegistry: cluster.peerRegistry,
    clusterSettings,
    rerouteFlapGraceFallbackMs: config.rerouteFlapGraceMs,
    staleThresholdMs: config.jobHeartbeatIntervalMs * config.staleDetectorThresholdMultiplier,
    scanIntervalMs: config.staleDetectorScanIntervalMs,
    // Approval-hold expiry: the held-run store (so overdue holds are expired)
    // and the step-approval bridge (so a step-scoped expiry notifies the
    // waiting agent). Both are supplied by the platform/hybrid mode hook.
    heldRunStore: modeResult.appDepsExtras?.heldRunStore as HeldRunStore | undefined,
    stepApprovalBridge: modeResult.appDepsExtras?.stepApprovalBridge as
      StepApprovalBridge | undefined,
    // Job/workflow approval-hold expiry fails the run (terminal `failed`), not
    // cancels it: a lapsed reviewer hold is a failure outcome, distinct from a
    // user-initiated cancel. The gated job was held (never dispatched), so
    // failRun's cascade over execution_runs / execution_jobs / dispatch_queue is
    // sufficient — there are no agents to notify or orphans to reap.
    failRun: (runId, reason) => executionTracker.failRun(runId, reason).then(() => undefined),
    // Resume a workflow whose install-gate wait-timer hold elapsed (workflow
    // scope). Supplied by the platform/hybrid mode hook alongside heldRunStore.
    onWorkflowRelease: modeResult.appDepsExtras?.onWorkflowRelease as
      ((signal: ReleaseSignal) => Promise<void>) | undefined,
    // Audit each approval-hold expiry to the orchestrator access-log stream.
    accessLogWriter,
  });
  await staleRunDetector.cleanupOrphanedRecoveryJobs();
  await staleRunDetector.start();
  logger.info('Stale run detector started', {
    scanIntervalMs: config.staleDetectorScanIntervalMs,
    staleThresholdMs: config.jobHeartbeatIntervalMs * config.staleDetectorThresholdMultiplier,
  });

  // 30a. Start the GitHub App name/slug refresher (only when a secret store is
  // wired — it needs decrypted App credentials to call GitHub). It re-fetches
  // each GitHub source's display name + slug from GitHub on a daily cadence and
  // persists a drift; the `sources_change` DB trigger fans the change out to the
  // Platform + dashboard via the existing SourceManager → updateSources path.
  let githubAppNameRefresher: GithubAppNameRefresher | null = null;
  if (sourceStore) {
    githubAppNameRefresher = new GithubAppNameRefresher({
      sourceStore,
      fetchIdentity: (creds) => fetchGithubAppIdentity(creds),
      scanIntervalMs: config.githubAppNameRefreshIntervalMs,
    });
    await githubAppNameRefresher.start();
    logger.info('GitHub app name refresher started', {
      scanIntervalMs: config.githubAppNameRefreshIntervalMs,
    });
  }

  // 30b. Start workflow-deadline detector — enforces the workflow-level run
  // deadline (workflow `timeout`) by cancelling overdue non-terminal runs
  // through the same canonical cancel path the user-initiated cancel uses.
  const workflowDeadlineDetector = new WorkflowDeadlineDetector({
    db,
    jobQueue: queue,
    cancelRun: (runId, reason) =>
      cancelRunWithReason(
        { db, jobQueue: queue, dispatcher, registry: agentRegistry, executionTracker },
        runId,
        reason,
      ),
    scanIntervalMs: config.staleDetectorScanIntervalMs,
  });
  await workflowDeadlineDetector.start();
  logger.info('Workflow deadline detector started', {
    scanIntervalMs: config.staleDetectorScanIntervalMs,
  });

  // 31. Startup recovery
  const dispatchedJobs = await queue.getJobsByStatus(DispatchQueueStatus.Dispatched);
  if (dispatchedJobs.length > 0) {
    logger.info('Starting recovery timers for dispatched jobs from previous instance', {
      count: dispatchedJobs.length,
    });
    for (const job of dispatchedJobs) {
      // The recovery timer stamps `recovery_agent_id`, which is what a
      // reconnecting agent is checked against when it claims the job back. A
      // row whose owner was recorded at dispatch is therefore reclaimable by
      // that agent; a row from before the owner was recorded keeps the
      // placeholder and is not reclaimable by anyone.
      await dispatcher.startRecoveryTimer(job.id, job.agentId ?? 'unknown', job.runId);
    }
  }

  // 31.5. Rehydrate per-job recovery timers from already-`recovering` rows so
  // a previous-coord crash mid-recovery doesn't leave jobs hanging. The
  // companion leader-gated sweep (started under onBecomeLeader) finalises
  // any rows whose deadline has already passed.
  await dispatcher.recoverState();

  // 31a.5. Restore pending job contexts from DB
  // Must run BEFORE needs scheduler recovery so dispatchReadyJob has context available
  try {
    const restoredCount = await restorePendingJobContexts(db);
    if (restoredCount > 0) {
      logger.info('Restored pending job contexts from DB', { count: restoredCount });
    }
  } catch (err) {
    logger.error('Failed to restore pending job contexts from DB', { error: toErrorMessage(err) });
  }

  // Restore pending workflow contexts (install-gate holds) so a held workflow
  // can resume after a restart when its hold releases.
  try {
    const restoredCount = await restorePendingWorkflowContexts(db);
    if (restoredCount > 0) {
      logger.info('Restored pending workflow contexts from DB', { count: restoredCount });
    }
  } catch (err) {
    logger.error('Failed to restore pending workflow contexts from DB', {
      error: toErrorMessage(err),
    });
  }

  // 31b. Needs-aware scheduler recovery
  // After restart, non-terminal runs may have pending jobs whose upstreams
  // completed while the orchestrator was down. Recompute needs_satisfied to
  // unblock them. Without this, pending jobs after restart hang forever.
  try {
    const nonTerminalRuns = await db
      .selectFrom('execution_runs')
      .select('run_id')
      .where('status', 'not in', ['success', 'failed', 'cancelled'])
      .execute();

    for (const { run_id: recoveryRunId } of nonTerminalRuns) {
      const pendingJobs = await db
        .selectFrom('execution_jobs')
        .select('job_name')
        .where('run_id', '=', recoveryRunId)
        .where('needs_satisfied', '=', false)
        .where('status', '=', 'pending')
        .execute();

      if (pendingJobs.length > 0) {
        const jobNames = pendingJobs.map((j) => j.job_name);
        const schedulerResults = await recomputeNeedsSatisfied(db, recoveryRunId, jobNames);

        for (const result of schedulerResults) {
          if (result.action === 'dispatch') {
            if (executionTracker.onJobReadyCallback) {
              await executionTracker.onJobReadyCallback(recoveryRunId, result.jobName);
            }
          } else if (result.action === 'skip') {
            // Look up actual job_id — onJobStatus expects UUID, not name
            const skipJobRow = await db
              .selectFrom('execution_jobs')
              .select('job_id')
              .where('run_id', '=', recoveryRunId)
              .where('job_name', '=', result.jobName)
              .executeTakeFirst();

            if (skipJobRow) {
              await executionTracker.onJobStatus(
                recoveryRunId,
                skipJobRow.job_id,
                'skipped',
                Date.now(),
                undefined,
                { error: result.reason },
              );
            }
          }
        }

        if (schedulerResults.length > 0) {
          logger.info('Needs scheduler recovery: recomputed needs for pending jobs', {
            runId: recoveryRunId,
            pendingCount: pendingJobs.length,
            readyCount: schedulerResults.filter((r) => r.action === 'dispatch').length,
            skippedCount: schedulerResults.filter((r) => r.action === 'skip').length,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Needs scheduler recovery failed', { error: toErrorMessage(err) });
  }

  // 32. ConfigReloader was constructed earlier (before createApp) so the
  // admin config routes can hold a reference to it.

  // 33. Mode-specific post-server-start hook
  await modeResult.onServerStarted?.();

  // Boot sequence complete: every subsystem is started and the HTTP server is
  // serving. Flip the warmth latch so `GET /ready` reports warm and any
  // external readiness gate can stop waiting.
  warm = true;
  logger.info('Orchestrator warm — ready to serve', { port: config.port, mode: config.mode });

  // -- Graceful shutdown --

  const modeShutdownSteps: import('@kici-dev/shared').ShutdownStep[] = (
    modeResult.shutdownExtras ?? []
  ).map((step) => ({ name: step.label, fn: step.fn }));

  setupGracefulShutdown({
    logger,
    steps: [
      {
        name: 'Shutting down scaler',
        fn: async () => {
          if (scalerManager) await scalerManager.shutdownAll();
        },
      },
      {
        name: 'Stopping stale eviction timer',
        fn: () => cluster.coordinator.stopStaleEvictionTimer(),
      },
      {
        name: 'Stopping orphan recovery',
        fn: () => cluster.orphanRecovery.stop(),
      },
      {
        name: 'Broadcasting peer.leaving',
        fn: () => {
          const msg = {
            type: 'peer.leaving' as const,
            instanceId: config.instanceId,
            term: cluster.raft.getCurrentTerm(),
          };
          // Send via outbound peer clients (to coordinators we connected TO)
          for (const [, client] of cluster.peerClients) {
            client.send(msg);
          }
          // Send via inbound peer handler connections (from coordinators that connected TO US)
          for (const peer of cluster.peerRegistry.getConnectedPeers()) {
            cluster.peerHandler.sendToPeer(peer.instanceId, msg);
          }
        },
      },
      {
        name: 'Stopping Raft',
        fn: () => cluster.raft.stop(),
      },
      {
        name: 'Disconnecting peer clients',
        fn: () => {
          if (cluster.peerClients.size > 0) {
            for (const [, client] of cluster.peerClients) {
              client.disconnect();
            }
            cluster.peerClients.clear();
          }
        },
      },
      // Mode-specific shutdown steps (e.g., disconnect Platform client)
      ...modeShutdownSteps,
      {
        name: 'Stopping source manager',
        fn: () => sourceManager.stop(),
      },
      {
        name: 'Stopping GitHub app name refresher',
        fn: () => githubAppNameRefresher?.stop(),
      },
      {
        name: 'Stopping generic sources change listener',
        fn: () => genericSourcesChangeListener.stop(),
      },
      {
        name: 'Stopping event router',
        fn: async () => {
          await eventRouter.stop();
          eventStore.stopCleanupTimer();
        },
      },
      {
        name: 'Closing agent WebSocket connections',
        fn: () => {
          for (const entry of agentRegistry.getAllEntries()) {
            entry.ws.close(WS_CLOSE_GOING_AWAY, 'Server shutting down');
          }
        },
      },
      {
        name: 'Stopping stale run detector',
        fn: () => staleRunDetector.stop(),
      },
      {
        name: 'Stopping workflow deadline detector',
        fn: () => workflowDeadlineDetector.stop(),
      },
      {
        name: 'Stopping heartbeat monitor',
        fn: () => heartbeatMonitor.stop(),
      },
      {
        name: 'Closing inbound peer WebSocket connections',
        fn: () => {
          // Close all server-side peer WS connections BEFORE stopping the HTTP
          // server. Node's http.Server.closeAllConnections() does NOT touch
          // upgraded protocols like WebSocket, so without this step the
          // inbound peer sockets keep server.close() waiting forever and
          // the 30s graceful shutdown timer force-exits the process with
          // status=1. This destabilised systemd restarts during E2E HA chaos.
          cluster.peerHandler.closeAllInbound();
        },
      },
      {
        name: 'Stopping HTTP server',
        fn: () =>
          new Promise<void>((resolve) => {
            // Also force-close any remaining plain HTTP connections (dashboard
            // SSE streams, long polling, etc). Safe no-op on older Node
            // versions that lack closeAllConnections.
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => resolve());
          }),
      },
      {
        name: 'Stopping cron scheduler',
        fn: () => cronScheduler.stop(),
      },
      {
        name: 'Stopping event retry scanner',
        fn: () => eventRetryScanner.stop(),
      },
      {
        name: 'Stopping host roster reaper',
        fn: () => hostRosterReaper.stop(),
      },
      {
        name: 'Stopping pending-scale sweeper',
        fn: () => pendingScaleSweeper?.stop(),
      },
      {
        name: 'Stopping ingest admission controller',
        fn: () => ingestController.stop(),
      },
      {
        name: 'Stopping ingest overflow replayer',
        fn: () => ingestOverflowReplayer.stop(),
      },
      {
        name: 'Stopping timers, cleanup, and reloader',
        fn: () => {
          for (const handle of scheduledJobHandles) {
            handle.stop();
          }
          clearInterval(registryPollInterval);
          clearInterval(pendingRedriveInterval);
          if (cluster.recoverySweepTimerRef.current) {
            clearInterval(cluster.recoverySweepTimerRef.current);
            cluster.recoverySweepTimerRef.current = null;
          }
          dispatcher.stopGraceCleanup();
          dispatcher.stopRecoveryTimers();
          queueDepthRefresher.stop();
          configReloader.dispose();
        },
      },
      {
        name: 'Closing database',
        fn: async () => {
          try {
            await db.destroy();
          } catch (_e) {
            // Ignore "Called end on pool more than once" during shutdown
          }
        },
      },
      {
        name: 'Shutting down OTel SDK',
        fn: async () => {
          if (options?.otelSdk) await options.otelSdk.shutdown();
        },
      },
    ],
  });
}
