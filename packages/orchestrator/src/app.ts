/**
 * Hono application factory for the customer orchestrator.
 *
 * Creates the HTTP + WebSocket application with:
 * - Agent WebSocket endpoint at /ws for agent connections
 * - Webhook endpoint for direct webhook ingestion (Hybrid/Independent)
 * - Source-tarball serve endpoint at /api/v1/cache/source/:hash
 * - Health/readiness check endpoints
 * - Prometheus metrics endpoint
 * - Request ID and logging middleware
 * - 25MB body size limit
 *
 * Pattern follows packages/platform/src/app.ts: returns { app, injectWebSocket }.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createNodeWebSocket } from '@hono/node-ws';
import { getConnInfo } from '@hono/node-server/conninfo';
import { extractRemoteIp } from './helpers/ip-extraction.js';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { getPrometheusExporter, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import { createLogger, requestContext } from '@kici-dev/shared';
import type { AppConfig } from './config.js';
import type { HostRosterStore } from './agent/host-roster.js';
import type { Database } from './db/types.js';
import type { AgentRegistry } from './agent/registry.js';
import type { Dispatcher } from './agent/dispatcher.js';
import type { RunCoordinator } from './cluster/coordinator.js';
import type { PeerRegistry } from './cluster/peer-registry.js';
import type { JobQueue } from './queue/job-queue.js';
import type { DedupCache } from './webhook/dedup.js';
import type { LockFileCache } from './lockfile-cache.js';
import type { PlatformClient } from './ws/platform-client.js';
import type { ScalerManager } from './scaler/manager.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { SourceCache } from './cache/index.js';
import type { BuildCoordinator } from './cache/index.js';
import type { DepCache } from './cache/index.js';
import type { UserCache } from './cache/index.js';
import type { DispatchCacheRefTracker } from './cache/index.js';
import type { PendingBuildTracker } from './cache/index.js';
import type { PendingInitTracker, InitResult } from './cache/index.js';
import type { PendingDynamicTracker } from './cache/index.js';
import type { CacheStorage } from './storage/types.js';
import { registerBlobRoutes } from './storage/blob-routes.js';
import { AgentApiRegistry } from './ws/agent-api-registry.js';
import { OIDC_TOKEN_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import { createOidcTokenHandler, deriveHttpBaseFromWsUrl } from './ws/oidc-token-relay.js';
import { createInventoryGetHandler, createInventoryQueryHandler } from './ws/inventory-api.js';
import { configureSecureWsServer } from './ws/server-options.js';
import {
  type CheckRunReporter,
  buildJobFailureDescription,
} from './reporting/check-run-reporter.js';
import type { ExecutionTracker } from './reporting/execution-tracker.js';
import { cancelRunWithReason } from './cancel/cancel-run.js';
import type { LogWriter } from './reporting/log-writer.js';
import type { LogStorage } from './reporting/log-storage.js';
import type { StepLogBuffer } from './reporting/step-log-buffer.js';
import type { SourceLocationData } from './reporting/check-run-summary.js';
import type { Hono as HonoType } from 'hono';
import type { PeerWsLike } from './cluster/peer-handler.js';
import type { PeerToPeerMessage, InitFailure } from '@kici-dev/engine';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { AgentJobFailedError } from './cache/agent-job-failed-error.js';
import type { AgentTokenStore } from './agent/token-store.js';
import type { OwnershipTracker } from './agent/ownership-tracker.js';
import type { ObserverRegistry } from './ws/observer-registry.js';
import { createAgentWsHandler } from './ws/agent-handler.js';
import type { FleetAgentCollector } from './ws/fleet-agent-collector.js';
import type { FleetTopology } from './diagnostics/fleet-topology.js';
import type { TokenManager } from './secrets/token-manager.js';
import type { SecretResolver } from './secrets/secret-resolver.js';
import { forwardLine } from './scaler/log-forwarder.js';
import { createGenericWebhookRoutes } from './routes/webhooks.js';
import { createAdminRoutes, type AdminRouteDeps } from './routes/admin.js';
import { createAdminEventRoutes } from './routes/admin-events.js';
import { createAdminRegistrationRoutes } from './routes/admin-registrations.js';
import { createAdminRunRoutes } from './routes/admin-runs.js';
import { createAdminEventLogRoutes } from './routes/admin-event-log.js';
import { createAdminAccessLogRoutes } from './routes/admin-access-log.js';
import { createAdminScheduledJobsRoutes } from './routes/admin-scheduled-jobs.js';
import type { RegistrationStore } from './registration/registration-store.js';
import type { RegistrationIndex } from './registration/registration-index.js';
import type { CronScheduler } from './cron/cron-scheduler.js';
import { createConfigAdminRoutes, type ConfigRouteDeps } from './routes/admin-config.js';
import { createHealthRoutes } from './routes/health.js';
import { createCapabilitiesRoutes } from './routes/capabilities.js';
import { createMetricsRoutes } from '@kici-dev/shared';
import { createDiagnosticsRoutes } from './routes/diagnostics.js';
import { createFleetRoutes } from './routes/fleet.js';
import { processWebhook } from './pipeline/processor.js';
import type { ConcurrencyGroupTracker } from './concurrency/group-tracker.js';
import type { ConcurrencyQueueManager } from './concurrency/queue-manager.js';
import { ConcurrencyWaiters } from './concurrency/waiters.js';
import {
  tryDispatchNextQueued as tryDispatchNextQueuedHelper,
  buildOnConcurrencyAgentDisconnect,
} from './concurrency/dispatch-next-queued.js';
import type { EventRouter } from './events/event-router.js';
import type { EventStore } from './events/event-store.js';
import { createAdminEventDlqRoutes } from './routes/admin-event-dlq.js';
import type { EventEmitter } from './events/event-emitter.js';
import type { GlobalWorkflowPolicy } from './security/global-workflow-policy.js';
import type { EventLogWriter } from './webhook/event-log.js';
import type { AccessLogWriter } from './audit/access-log.js';
import { payloadFromObject } from './webhook/event-log.js';
import type { GenericSourceManager } from './webhook/generic-sources.js';
import type { TrustStore } from './events/trust-store.js';
import type { EnvironmentStore } from './environments/environment-store.js';
import type { VariableStore } from './environments/variable-store.js';
import type { HeldRunStore } from './environments/held-runs.js';
import type { StepApprovalBridge } from './approvals/step-approval-bridge.js';
import type { ContributorCache } from './security/contributor-cache.js';
import {
  logChunksReceivedTotal,
  logBytesStoredTotal,
  stepsTotal,
  registerOrchestratorMetrics,
} from './metrics/prometheus.js';
import { AgentMetricsAggregator } from './metrics/agent-metrics-aggregator.js';

const logger = createLogger({ prefix: 'app' });

/**
 * All dependencies needed to create the orchestrator Hono app.
 */
export interface AppDependencies {
  config: AppConfig;
  db: Kysely<Database>;
  pool: pg.Pool;
  registry: AgentRegistry;
  /** Host roster store for runsOnAll fan-out resolution. */
  hostRosterStore?: HostRosterStore;
  dispatcher: Dispatcher;
  jobQueue: JobQueue;
  dedup: DedupCache;
  lockFileCache: LockFileCache;
  providerRegistry: ProviderRegistry;
  platformClient?: PlatformClient;
  scalerManager?: ScalerManager;
  /** Bundle cache for compiled workflow bundles. Optional — requires S3 storage. */
  sourceCache?: SourceCache;
  /** Build coordinator for deduplicating concurrent builds. Optional — requires bundle cache. */
  buildCoordinator?: BuildCoordinator;
  /** Dep cache for dependency tarballs. Optional — requires S3 storage. */
  depCache?: DepCache;
  /** User-facing cache (ctx.cache / declarative job-step cache). Optional — requires cache storage. */
  userCache?: UserCache;
  /**
   * Server-side jobId -> user-cache-namespace store. Written at dispatch time
   * (orchestrator-core's buildOnDispatch); read by the agent-WS handler to
   * resolve the cache ref for `cache.user.*` requests WITHOUT trusting the wire
   * message. Optional — absent for modes that never serve the user cache.
   */
  dispatchCacheRefs?: DispatchCacheRefTracker;
  /** Cache storage backend (S3) for metadata operations on upload completion. */
  cacheStorage?: CacheStorage;
  /**
   * Filesystem cache backend handle. Only set when KICI_STORAGE_TYPE is
   * `filesystem`. Drives the /api/v1/cache/blob/* HTTP route that serves and
   * receives signed-URL blob traffic the filesystem backend mints.
   */
  fsCache?: {
    basePath: string;
    signingSecret: string;
    ttlMs: number;
  };
  /** Pending build tracker for build-then-execute coordination. Optional — requires bundle cache. */
  pendingBuilds?: PendingBuildTracker;
  /** Pending init tracker for init-then-execute coordination. */
  pendingInits?: PendingInitTracker;
  /** Pending dynamic tracker for DynamicJobFn evaluation coordination. */
  pendingDynamics?: PendingDynamicTracker;
  /** Commit status reporter for setting pending/success/failure/error on commits. Optional. */
  checkRunReporter?: CheckRunReporter;
  /** Execution tracker for DB persistence of execution state. Optional — requires database. */
  executionTracker?: ExecutionTracker;
  /** Log writer for persisting agent log chunks. Optional — requires database. */
  logWriter?: LogWriter;
  /** Log storage backend for persisting webhook payloads and step logs. Optional — requires S3 storage. */
  logStorage?: LogStorage;
  /** Step log buffer for enriched check run summaries. Optional — requires execution tracker. */
  stepLogBuffer?: StepLogBuffer;
  // Prometheus registry removed -- OTel PrometheusExporter used via getPrometheusExporter()
  /** Agent token store for validating agent auth tokens. Required when agentAuth='token'. */
  tokenStore?: AgentTokenStore;
  /** Job ownership tracker for validating agent messages. Optional — requires database. */
  ownershipTracker?: OwnershipTracker;
  /**
   * Orchestrator-scoped collector correlating fleet.logs.request with agents'
   * chunked bundle responses. Shared with the fleet fan-out in orchestrator-core.
   */
  fleetAgentCollector?: FleetAgentCollector;
  /** Admin API route dependencies. Optional -- only mounted when secrets management is configured. */
  adminDeps?: AdminRouteDeps;
  /**
   * Resolves the public webhook URL for a newly added source (for
   * `kici-admin source add` output). Built by the entry point where the
   * Platform client + config are in scope; passed into the admin source routes.
   */
  resolveSourceWebhookUrl?: AdminRouteDeps['resolveSourceWebhookUrl'];
  /**
   * Resolves the org-scoped GitHub webhook URL for the manifest setup
   * pre-flight (before any App exists). Passed into the admin source routes.
   */
  resolveGithubWebhookUrl?: AdminRouteDeps['resolveGithubWebhookUrl'];
  /** Config admin API route dependencies. Optional -- mounted when config management is available. */
  configRouteDeps?: ConfigRouteDeps;
  /** Event router for internal event delivery. Optional -- if not set, event routing is inactive. */
  eventRouter?: EventRouter;
  /** Event store. Optional -- mounted when admin DLQ admin route should be available. */
  eventStore?: EventStore;
  /** Event emitter for system events (workflow/job complete). Optional -- if not set, system events are skipped. */
  eventEmitter?: EventEmitter;
  /** Generic webhook source manager. Optional -- if not set, generic webhooks are disabled. */
  genericSourceManager?: GenericSourceManager;
  /** Trust store for cross-repo event trust. Optional -- if not set, trust management admin routes are unavailable. */
  trustStore?: TrustStore;
  /** Observer registry for broadcasting status/log updates to CLI observers. Optional -- if not set, observer features are inactive. */
  observerRegistry?: ObserverRegistry;
  /** Token manager for authenticating test trigger and observer connections. Optional -- requires secrets subsystem. */
  tokenManager?: TokenManager;
  /** Secret resolver for test run secret context resolution. Optional -- if not set, test runs have no secret access. */
  secretResolver?: SecretResolver;
  /** Cron scheduler for refreshing last-fired cache after registration changes. Optional — requires database. */
  cronScheduler?: CronScheduler;
  /** Registration store for admin registration routes. Optional -- mounted when registration system is initialized. */
  registrationStore?: RegistrationStore;
  /** Registration index for admin registration routes. Optional -- mounted when registration system is initialized. */
  registrationIndex?: RegistrationIndex;
  /** Environment store for resolving environment configs. Optional -- if not set, environment resolution is inactive. */
  environmentStore?: EnvironmentStore;
  /** Variable store for resolving environment variables. Optional -- if not set, environment vars are not merged. */
  variableStore?: VariableStore;
  /** Held run store for persisting protection rule holds. Optional -- if not set, holds are not persisted. */
  heldRunStore?: HeldRunStore;
  /** Step-approval bridge — opens step-scoped holds and relays their resolution back to the waiting agent. Optional. */
  stepApprovalBridge?: StepApprovalBridge;
  /** Global workflow policy for org-level permission enforcement. Optional -- if not set, global workflows are dispatched without permission checks. */
  globalWorkflowPolicy?: GlobalWorkflowPolicy;
  /** Inbound webhook delivery log writer. Optional -- if not set, deliveries are not persisted to event_log. */
  eventLogWriter?: EventLogWriter;
  /** Cold-store handle (Phase E). Optional -- when present, admin event-log routes can serve archived rows. */
  coldStore?: ColdStore | null;
  /** Read + mutation attribution log writer. Optional -- if not set, access_log rows are not written. */
  accessLogWriter?: AccessLogWriter;
  /** In-memory concurrency group tracker. Optional -- if not set, concurrency is disabled. */
  concurrencyTracker?: ConcurrencyGroupTracker;
  /** DB-backed concurrency queue manager. Optional -- if not set, concurrency is disabled. */
  concurrencyQueueManager?: ConcurrencyQueueManager;
  /** Optional callback when agent sends encrypted secret outputs on job success. */
  onSecretOutputs?: (
    runId: string,
    jobId: string,
    secretOutputs: Record<string, { agentPublicKey: string; encrypted: string }>,
  ) => Promise<void>;
  /** Cluster health routes (Hono app). Always mounted (cluster always on). */
  clusterHealthRoutes: HonoType;
  /** Peer WS handler for incoming peer connections. Always mounted (cluster always on). */
  peerHandler: {
    handleConnection: (ws: PeerWsLike, remoteIp?: string) => void;
    sendToPeer: (targetInstanceId: string, msg: PeerToPeerMessage) => boolean;
    getConnectionCount: () => number;
  };
  /** Optional join handler for direct peer join requests. */
  onJoinRequest?: (
    msg: import('@kici-dev/engine').JoinRequest,
  ) => Promise<import('@kici-dev/engine').JoinResponse>;
  /** Optional callback when agent inventory changes (connect/disconnect). Triggers peer heartbeat broadcast. */
  onAgentInventoryChanged?: () => void;
  /** Run coordinator for multi-orch claim/reroute. Optional -- if not set, jobs dispatch locally. */
  coordinator?: RunCoordinator;
  /** Peer registry for aggregating infrastructure across cluster. Optional. */
  peerRegistry?: PeerRegistry;
  /** Contributor permission cache. Optional -- threaded through from server.ts
   *  so membership-related webhooks invalidate matching entries immediately
   *  (instead of waiting for the 15-minute TTL). */
  contributorCache?: ContributorCache;
  /**
   * Shared aggregator for agent-pushed metrics. When omitted, app.ts
   * constructs its own — kept optional so existing tests still work
   * without touching every call site. Production wiring threads the
   * subsystem-built instance through so the Platform-bound MetricsReporter
   * can read the same store and Mimir gets agent metrics per-org.
   */
  agentMetricsAggregator?: AgentMetricsAggregator;
  /**
   * Fleet log-collection route backing. `getTopology` enumerates the cluster
   * (no fan-out); `collectBundle` drives the recursive fan-out and returns the
   * assembled ZIP. Mounted at /admin/fleet-topology + /admin/fleet-bundle.
   */
  fleetRoutes?: FleetRoutesDeps;
}

/** Backing for the /admin/fleet-* routes. */
export interface FleetRoutesDeps {
  getTopology: () => FleetTopology;
  collectBundle: (opts: {
    selectors: string[];
    logWindowHours?: number;
    timeoutSeconds?: number;
  }) => Promise<Buffer>;
}

/**
 * In-memory cache for step source locations extracted from lock files.
 * Keyed by `workflowName:jobName`, stores source location arrays indexed by step index.
 * Populated during webhook processing, used by CheckRunReporter for annotations.
 */
export class SourceLocationStore {
  private readonly cache = new Map<string, Array<SourceLocationData | undefined>>();

  private key(workflowName: string, jobName: string): string {
    return `${workflowName}:${jobName}`;
  }

  set(
    workflowName: string,
    jobName: string,
    locations: Array<SourceLocationData | undefined>,
  ): void {
    this.cache.set(this.key(workflowName, jobName), locations);
  }

  get(workflowName: string, jobName: string): SourceLocationData[] | undefined {
    const locs = this.cache.get(this.key(workflowName, jobName));
    if (!locs) return undefined;
    // Filter out undefined entries and return as SourceLocationData[]
    return locs.filter((l): l is SourceLocationData => l !== undefined);
  }
}

/**
 * Create Hono application with all routes and middleware.
 *
 * @param deps - Application dependencies (injected for testability)
 * @returns Object with Hono app instance and injectWebSocket function
 */
export function createApp(deps: AppDependencies) {
  // Register the orchestrator's observable gauges on the real meter. createApp
  // runs during bootstrap, after initTelemetry() has wired the global
  // MeterProvider, so the gauges reach the Prometheus exporter (registering
  // them at module-eval time would bind to the no-op provider). Idempotent.
  registerOrchestratorMetrics();

  const app = new Hono().basePath(deps.config.basePath);

  // Set up WebSocket support via @hono/node-ws
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });

  // Apply security-relevant WS server options. The compression-bomb
  // defense invariant (`maxPayload` + `serverNoContextTakeover`) lives in this
  // helper so it can be unit-tested without spinning up createApp.
  configureSecureWsServer(wss);

  // Agent metrics aggregator for collecting pushed metrics from agents.
  // Reuse the subsystem-built instance when provided so the WS push to
  // Platform (and from there to Mimir per-org) sees the same data the
  // local /metrics scrape exposes. Fallback construction keeps existing
  // tests that don't pass deps intact.
  const agentMetricsAggregator = deps.agentMetricsAggregator ?? new AgentMetricsAggregator();

  // Agent private API registry — typed request-response API over WS
  const agentApiRegistry = new AgentApiRegistry();

  // Register infrastructure.list API method (read role)
  agentApiRegistry.register('infrastructure.list', 'read', async () => {
    const scalers: Array<{
      name: string;
      type: string;
      labelSets: string[][];
      source: string;
      activeCount?: number;
      maxAgents?: number;
      usage?: { cpus: number; memBytes: number };
      resourceCap?: { maxCpu?: number; maxMemoryBytes?: number };
      machinePool?: string;
    }> = [];
    let globalUsage: { cpus: number; memBytes: number } | undefined;
    let globalResourceCap: { maxCpu?: number; maxMemoryBytes?: number } | undefined;
    if (deps.scalerManager) {
      const status = deps.scalerManager.getStatus();
      globalUsage = status.globalUsage;
      globalResourceCap = status.globalResourceCap;
      for (const backend of status.backends) {
        scalers.push({
          name: backend.name,
          type: backend.type,
          labelSets: backend.labelSets,
          source: 'local',
          activeCount: backend.activeCount,
          maxAgents: backend.maxAgents,
          usage: backend.usage,
          resourceCap: backend.resourceCap,
          machinePool: backend.machinePool,
        });
      }
    }

    const agents: Array<{
      agentId: string;
      labels: string[];
      scalerManaged: boolean;
      source: string;
    }> = [];
    for (const entry of deps.registry.getAllEntries()) {
      const scalerName = deps.scalerManager?.getBackendForAgent(entry.agentId);
      agents.push({
        agentId: entry.agentId,
        labels: [...entry.labels],
        scalerManaged: !!scalerName,
        source: 'local',
      });
    }

    // Aggregate peer data from cluster heartbeats
    if (deps.peerRegistry) {
      for (const peer of deps.peerRegistry.getConnectedPeers()) {
        // Peer scaler capacity (advertised via heartbeats)
        if (peer.scalerCapacity) {
          for (const sc of peer.scalerCapacity) {
            scalers.push({
              name: sc.name ?? `${peer.instanceId}-scaler`,
              type: sc.type ?? 'unknown',
              labelSets: sc.labelSets,
              source: peer.instanceId,
            });
          }
        }
        // Peer agents (inventory from heartbeats)
        for (const agent of peer.agents) {
          agents.push({
            agentId: agent.agentId,
            labels: [...agent.labels],
            scalerManaged: false, // Peer-side scaler status not tracked here
            source: peer.instanceId,
          });
        }
      }
    }

    return { scalers, agents, globalUsage, globalResourceCap };
  });

  // Register the host inventory query API (read role). Resolves against this
  // cluster's roster; available to steps and dynamic-job generators via
  // ctx.kici.inventory. Only registered when a roster store is present.
  if (deps.hostRosterStore) {
    const inventoryDeps = {
      rosterStore: deps.hostRosterStore,
      graceMs: deps.config.rosterGraceMs,
    };
    agentApiRegistry.register(
      'inventory.query',
      'read',
      createInventoryQueryHandler(inventoryDeps),
    );
    agentApiRegistry.register('inventory.get', 'read', createInventoryGetHandler(inventoryDeps));
  }

  // Register the provenance ID-token relay (read role). The relay drives the
  // Platform's token-mint endpoint, so it is only meaningful when this
  // orchestrator is connected to a Platform (platform/hybrid mode). In
  // independent mode (no platformUrl/platformToken) the method is not
  // registered and a request returns a clear "unknown method" error.
  if (deps.config.platformUrl && deps.config.platformToken) {
    agentApiRegistry.register(
      OIDC_TOKEN_REQUEST_METHOD,
      'read',
      createOidcTokenHandler({
        dispatcher: deps.dispatcher,
        platformToken: deps.config.platformToken,
        platformHttpBase: deriveHttpBaseFromWsUrl(deps.config.platformUrl),
        orchestratorId: deps.config.instanceId,
      }),
    );
  }

  // Source location store for check run annotations
  const sourceLocationStore = new SourceLocationStore();

  // In-memory waiters for the long-poll concurrency protocol. The orchestrator
  // ack's a `concurrency.report` with `{ action: 'wait' }` and tracks the
  // waiting agent here; when the held slot frees, `tryDispatchNextQueued`
  // looks up the waiter and pushes an unsolicited `concurrency.ack` over the
  // same WS so the agent's parked `waitForConcurrencyAck` resolves.
  const concurrencyWaiters = new ConcurrencyWaiters();
  const tryDispatchNextQueued =
    deps.concurrencyTracker && deps.concurrencyQueueManager
      ? async (group: string, routingKey: string): Promise<void> => {
          await tryDispatchNextQueuedHelper(
            {
              tracker: deps.concurrencyTracker!,
              queueManager: deps.concurrencyQueueManager!,
              registry: deps.registry,
              waiters: concurrencyWaiters,
            },
            group,
            routingKey,
          );
        }
      : undefined;
  const concurrencyDisconnect = deps.concurrencyQueueManager
    ? buildOnConcurrencyAgentDisconnect({
        waiters: concurrencyWaiters,
        queueManager: deps.concurrencyQueueManager,
      })
    : undefined;
  // Also drop any step-approval waits for the disconnected agent so the relayed
  // resolution is skipped (its socket is gone); the held_runs row is left for
  // the stale detector / a manual decision.
  const onConcurrencyAgentDisconnect =
    concurrencyDisconnect || deps.stepApprovalBridge
      ? async (agentId: string) => {
          deps.stepApprovalBridge?.failAgent(agentId);
          await concurrencyDisconnect?.(agentId);
        }
      : undefined;

  // Callback for processor to populate source locations
  const onSourceLocationsExtracted = (
    workflowName: string,
    jobName: string,
    locations: Array<{ file: string; line: number; column: number } | undefined>,
  ) => {
    sourceLocationStore.set(
      workflowName,
      jobName,
      locations as Array<SourceLocationData | undefined>,
    );
  };

  // Mount WebSocket route for agent connections
  app.get(
    '/ws',
    upgradeWebSocket(() =>
      createAgentWsHandler({
        registry: deps.registry,
        dispatcher: deps.dispatcher,
        agentAuthMode: deps.config.agentAuth,
        tokenStore: deps.tokenStore,
        ownershipTracker: deps.ownershipTracker,
        fleetAgentCollector: deps.fleetAgentCollector,
        sourceCache: deps.sourceCache,
        depCache: deps.depCache,
        userCache: deps.userCache,
        dispatchCacheRefs: deps.dispatchCacheRefs,
        cacheStorage: deps.cacheStorage,
        onJobStatus:
          deps.platformClient ||
          deps.executionTracker ||
          deps.checkRunReporter ||
          deps.pendingBuilds ||
          deps.pendingInits
            ? (_agentId, msg) => {
                // Resolve/reject pending builds on terminal states
                if (deps.pendingBuilds && deps.pendingBuilds.has(msg.jobId)) {
                  if (msg.state === ExecutionJobStatus.enum.success && msg.data?.buildComplete) {
                    deps.pendingBuilds.resolve(msg.jobId);
                  } else if (
                    msg.state === ExecutionJobStatus.enum.failed ||
                    msg.state === ExecutionJobStatus.enum.cancelled
                  ) {
                    deps.pendingBuilds.reject(
                      msg.jobId,
                      new Error((msg.data?.error as string) ?? `Build ${msg.state}`),
                    );
                  }
                }

                // Resolve/reject pending init jobs on terminal states
                if (deps.pendingInits && deps.pendingInits.has(msg.jobId)) {
                  if (msg.state === ExecutionJobStatus.enum.success && msg.data?.initComplete) {
                    deps.pendingInits.resolve(
                      msg.jobId,
                      ((msg.data.initResult as InitResult) ?? {}) as InitResult,
                    );
                  } else if (
                    msg.state === ExecutionJobStatus.enum.failed ||
                    msg.state === ExecutionJobStatus.enum.cancelled
                  ) {
                    deps.pendingInits.reject(
                      msg.jobId,
                      new AgentJobFailedError(
                        (msg.data?.error as string) ?? `Init ${msg.state}`,
                        msg.data?.initFailure as InitFailure | undefined,
                      ),
                    );
                  }
                }

                // Resolve/reject pending DynamicJobFn eval jobs on terminal states
                if (deps.pendingDynamics && deps.pendingDynamics.has(msg.jobId)) {
                  if (msg.state === ExecutionJobStatus.enum.success && msg.data?.dynamicComplete) {
                    deps.pendingDynamics.resolve(
                      msg.jobId,
                      (msg.data.dynamicJobs as import('@kici-dev/engine').LockJob[]) ?? [],
                    );
                  } else if (
                    msg.state === ExecutionJobStatus.enum.failed ||
                    msg.state === ExecutionJobStatus.enum.cancelled
                  ) {
                    deps.pendingDynamics.reject(
                      msg.jobId,
                      new AgentJobFailedError(
                        (msg.data?.error as string) ?? `Dynamic eval ${msg.state}`,
                        msg.data?.initFailure as InitFailure | undefined,
                      ),
                    );
                  }
                }

                // Update execution tracker
                deps.executionTracker
                  ?.onJobStatus(msg.runId, msg.jobId, msg.state, msg.timestamp, _agentId, msg.data)
                  .catch((err) => {
                    logger.error('Failed to update execution tracker on job status', {
                      runId: msg.runId,
                      jobId: msg.jobId,
                      error: toErrorMessage(err),
                    });
                  });

                // Forward to Platform (existing behavior -- terminal states only)
                if (
                  deps.platformClient &&
                  (msg.state === ExecutionJobStatus.enum.success ||
                    msg.state === ExecutionJobStatus.enum.failed ||
                    msg.state === ExecutionJobStatus.enum.cancelled)
                ) {
                  deps.platformClient.send({
                    type: 'execution.event',
                    messageId: randomUUID(),
                    runId: msg.runId,
                    event: 'job_completed',
                    data: {
                      jobId: msg.jobId,
                      state: msg.state,
                      ...msg.data,
                    },
                    timestamp: msg.timestamp,
                  });
                }

                // Update job-level check run on terminal states
                if (
                  deps.checkRunReporter &&
                  deps.executionTracker &&
                  (msg.state === ExecutionJobStatus.enum.success ||
                    msg.state === ExecutionJobStatus.enum.failed ||
                    msg.state === ExecutionJobStatus.enum.cancelled)
                ) {
                  const execContext = deps.executionTracker.getExecutionContext(msg.runId);
                  if (execContext) {
                    const [owner, repo] = execContext.repoIdentifier.split('/');

                    // Build a meaningful description from agent data on failure
                    let description: string | undefined;
                    if (msg.state === ExecutionJobStatus.enum.failed && msg.data) {
                      description = buildJobFailureDescription(msg.data);
                    }

                    deps.checkRunReporter.updateJobStatus({
                      provider: execContext.provider,
                      owner,
                      repo,
                      sha: execContext.sha,
                      workflowName: execContext.workflowName,
                      jobName: deps.executionTracker.getJobName(msg.runId, msg.jobId) ?? msg.jobId,
                      state: msg.state as Extract<
                        ExecutionJobStatus,
                        'success' | 'failed' | 'cancelled'
                      >,
                      installationId: execContext.installationId,
                      routingKey: execContext.routingKey,
                      description,
                      // Pass additional data for enriched summaries
                      data: msg.data,
                      runIdForLogs: msg.runId,
                      jobId: msg.jobId,
                      // Explicit runId — the agent WS message handler runs
                      // outside the request-context ALS frame that wrapped
                      // the original dispatch, so the reporter cannot pull
                      // runId from getRequestContext(). Without it, the
                      // job-completion check-run update omits details_url
                      // and GitHub falls back to the App's homepage URL.
                      runId: msg.runId,
                    });
                  }
                }
              }
            : undefined,
        onLogChunk: (_agentId, msg) => {
          logChunksReceivedTotal.add(1);

          // Feed lines to StepLogBuffer for check run summaries
          if (deps.stepLogBuffer) {
            deps.stepLogBuffer.addLines(
              { runId: msg.runId, jobId: msg.jobId, stepIndex: msg.stepIndex },
              msg.lines,
            );
          }

          if (deps.logWriter) {
            const jobName = deps.executionTracker?.getJobName(msg.runId, msg.jobId) ?? msg.jobId;
            deps.logWriter.appendChunk(
              msg.runId,
              jobName,
              msg.stepIndex,
              msg.lines,
              msg.timestamp,
              msg.jobId,
            );

            // Track bytes stored (approximate: sum of line lengths + newlines)
            const byteCount = msg.lines.reduce((sum, line) => sum + line.length + 1, 0);
            logBytesStoredTotal.add(byteCount);
          }

          // Forward log.chunk to Platform for browser fan-out
          if (deps.platformClient) {
            deps.platformClient.send({
              type: 'log.chunk',
              messageId: randomUUID(),
              runId: msg.runId,
              jobId: msg.jobId,
              stepIndex: msg.stepIndex,
              lines: msg.lines,
              timestamp: msg.timestamp,
            });
          }
        },
        onStepStatus: (_agentId, msg) => {
          stepsTotal.add(1, { status: msg.state });

          if (deps.executionTracker) {
            // Merge secretsAccessed into data for forwarding through the pipeline
            const data =
              msg.secretsAccessed !== undefined
                ? { ...msg.data, secretsAccessed: msg.secretsAccessed }
                : msg.data;
            deps.executionTracker.onStepStatus(
              msg.runId,
              msg.jobId,
              msg.stepIndex,
              msg.stepName,
              msg.state,
              msg.timestamp,
              data,
              msg.logBytesStreamed,
            );
          }

          // Update step progress on check run (live progress updates)
          if (deps.checkRunReporter && deps.executionTracker) {
            const execContext = deps.executionTracker.getExecutionContext(msg.runId);
            if (execContext) {
              const [owner, repo] = execContext.repoIdentifier.split('/');
              deps.checkRunReporter.updateStepProgress({
                provider: execContext.provider,
                owner,
                repo,
                sha: execContext.sha,
                workflowName: execContext.workflowName,
                jobName: deps.executionTracker.getJobName(msg.runId, msg.jobId) ?? msg.jobId,
                stepIndex: msg.stepIndex,
                stepName: msg.stepName,
                state: msg.state as
                  | 'running'
                  | 'success'
                  | 'failed'
                  | 'skipped'
                  | 'cancelled'
                  | 'error',
                durationMs: (msg.data?.durationMs as number) ?? undefined,
                installationId: execContext.installationId,
                routingKey: execContext.routingKey,
                runId: msg.runId,
              });
            }
          }
        },
        onJobHeartbeat: deps.executionTracker
          ? (_agentId, msg) => {
              deps.executionTracker!.updateJobHeartbeat(msg.runId, msg.jobId);
            }
          : undefined,
        onScalerAgentRegistered: (agentId, labels) => {
          const result = deps.scalerManager?.onAgentRegistered(agentId, labels) ?? null;
          deps.onAgentInventoryChanged?.(); // broadcast heartbeat to peers
          return result;
        },
        onScalerAgentDisconnected: (agentId) => {
          deps.scalerManager?.onAgentDisconnected(agentId);
          deps.onAgentInventoryChanged?.(); // broadcast heartbeat to peers
        },
        onScalerJobComplete: deps.scalerManager
          ? (agentId) => deps.scalerManager!.onJobComplete(agentId)
          : undefined,
        onConfigAck: deps.scalerManager
          ? (agentId) => deps.scalerManager!.onConfigAck(agentId)
          : undefined,
        onAgentLog: (agentId, msg) => {
          for (const line of msg.lines) {
            forwardLine(line, agentId, process.stdout);
          }
        },
        onEventEmit:
          deps.eventRouter && deps.executionTracker
            ? async (_agentId, msg) => {
                const execContext = deps.executionTracker!.getExecutionContext(msg.jobId);
                if (!execContext) {
                  return { error: 'Unknown job context' };
                }
                try {
                  const deliveryId = await deps.eventRouter!.emit({
                    eventName: msg.eventName,
                    payload: msg.payload,
                    sourceRepo: execContext.repoIdentifier,
                    sourceRoutingKey: execContext.routingKey,
                    sourceRunId: msg.jobId, // jobId is used as source reference
                    sourceJobId: msg.jobId,
                    chainDepth: 1, // Agent-emitted events start at chain depth 1
                    ...(msg.target && { target: msg.target }),
                  });
                  return { deliveryId };
                } catch (err) {
                  return { error: toErrorMessage(err) };
                }
              }
            : undefined,
        pendingBuilds: deps.pendingBuilds,
        pendingInits: deps.pendingInits,
        pendingDynamics: deps.pendingDynamics,
        agentApiRegistry,
        agentMetricsAggregator,
        onSecretOutputs: deps.onSecretOutputs,
        // Provenance bundles reuse the cache storage backend for presigned PUTs;
        // each completed upload records one attestations row.
        provenanceStorage: deps.cacheStorage,
        onProvenanceUpload: async (record) => {
          await deps.db
            .insertInto('attestations')
            .values({
              id: randomUUID(),
              run_id: record.runId,
              job_id: record.jobId,
              subject_name: record.subjectName,
              subject_digest: record.subjectDigest,
              storage_key: record.storageKey,
              mode: 'kici',
              media_type: record.mediaType,
            })
            .execute();
        },
        onConcurrencyReport:
          deps.concurrencyTracker && deps.concurrencyQueueManager
            ? async (agentId, msg) => {
                const tracker = deps.concurrencyTracker!;
                const queueManager = deps.concurrencyQueueManager!;
                const execCtx = deps.executionTracker?.getExecutionContext(msg.runId);
                const routingKey = execCtx?.routingKey ?? '';

                // Read concurrency config from lock file (via execution context).
                // Defaults: max=1, cancelInProgress=true (backward-compat with
                // pre-wiring behavior where all concurrent runs were cancelled).
                const concurrencyConfig = {
                  max: execCtx?.concurrency?.max ?? 1,
                  cancelInProgress: execCtx?.concurrency?.cancelInProgress ?? true,
                };

                if (concurrencyConfig.cancelInProgress) {
                  // Cancel older runs in the same group
                  const activeRuns = tracker.getActiveRuns(msg.group, routingKey);
                  const supersededRunIds: string[] = [];
                  for (const oldRunId of activeRuns) {
                    if (oldRunId === msg.runId) continue;
                    // Send job.cancel to old run's agents
                    const oldJobIds = await deps.jobQueue.getDispatchedJobIdsByRunId(oldRunId);
                    for (const oldJobId of oldJobIds) {
                      const oldAgentId = deps.dispatcher.getAgentIdForJob(oldJobId);
                      if (oldAgentId) {
                        const entry = deps.registry.get(oldAgentId);
                        if (entry?.ws) {
                          entry.ws.send(
                            JSON.stringify({
                              type: 'job.cancel',
                              messageId: randomUUID(),
                              runId: oldRunId,
                              jobId: oldJobId,
                              reason: `Superseded by run in concurrency group '${msg.group}'`,
                            }),
                          );
                        }
                      }
                    }
                    tracker.releaseSlot(msg.group, routingKey, oldRunId);
                    await queueManager.markCompleted(oldRunId, msg.group, routingKey);
                    supersededRunIds.push(oldRunId);
                  }
                  // Acquire slot for current run.
                  tracker.acquireSlot(msg.group, routingKey, msg.runId, {
                    max: concurrencyConfig.max,
                  });
                  await queueManager.recordActive({
                    groupKey: msg.group,
                    routingKey,
                    runId: msg.runId,
                    jobId: msg.jobId,
                  });
                  // Defensive: if a superseded run was holding slots in
                  // OTHER groups (concurrency.max>1 future-proof), wake any
                  // queued waiters for THIS (group, routingKey) too. The new
                  // arrival just acquired a slot here, so for the same-group
                  // case dequeueNext() will return null and this is a no-op.
                  if (tryDispatchNextQueued && supersededRunIds.length > 0) {
                    await tryDispatchNextQueued(msg.group, routingKey);
                  }
                  return { action: 'proceed' as const };
                }

                // Queue mode: try to acquire slot
                const acquired = tracker.acquireSlot(msg.group, routingKey, msg.runId, {
                  max: concurrencyConfig.max,
                });
                if (acquired) {
                  await queueManager.recordActive({
                    groupKey: msg.group,
                    routingKey,
                    runId: msg.runId,
                    jobId: msg.jobId,
                  });
                  return { action: 'proceed' as const };
                }

                // No slot available -- queue the job and register the waiter
                // so the slot-release path can wake this agent up later.
                await queueManager.enqueue({
                  groupKey: msg.group,
                  routingKey,
                  runId: msg.runId,
                  jobId: msg.jobId,
                });
                concurrencyWaiters.register(msg.group, routingKey, {
                  runId: msg.runId,
                  jobId: msg.jobId,
                  agentId,
                });
                return {
                  action: 'wait' as const,
                  reason: `Queued in concurrency group '${msg.group}'`,
                };
              }
            : undefined,
        onStepApproval: deps.stepApprovalBridge
          ? async (agentId, msg) =>
              deps.stepApprovalBridge!.request({
                agentId,
                runId: msg.runId,
                jobId: msg.jobId,
                stepIndex: msg.stepIndex,
                stepName: msg.stepName,
                clauses: msg.clauses,
                reason: msg.reason,
                ...(msg.timeoutSeconds !== undefined && { timeoutSeconds: msg.timeoutSeconds }),
              })
          : undefined,
        onConcurrencyAgentDisconnect,
        onRunEvent: deps.platformClient
          ? (_agentId, msg) => {
              deps.platformClient!.send({
                type: 'run.event',
                runId: msg.runId,
                eventType: msg.eventType,
                timestampMs: msg.timestampMs,
                sourceService: msg.sourceService,
                jobId: msg.jobId ?? null,
                metadata: msg.metadata,
                durationMs: msg.durationMs ?? null,
              } as any);
            }
          : undefined,
        onJobContext: deps.platformClient
          ? (_agentId, msg) => {
              // Enrich with scaler-specific configuration metadata
              const scalerContext = deps.scalerManager?.getScalerContextForAgent(_agentId);
              const enrichedContext = scalerContext
                ? { ...msg.context, scalerContext }
                : msg.context;

              deps.platformClient!.send({
                type: 'job.context',
                runId: msg.runId,
                jobId: msg.jobId,
                context: enrichedContext,
              } as any);
            }
          : undefined,
      }),
    ),
  );

  // Global middleware: X-Request-ID generation
  app.use('*', async (c, next) => {
    const requestId = c.req.header('X-Request-ID') || randomUUID();
    c.header('X-Request-ID', requestId);
    await next();
  });

  // Global middleware: Request logging
  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info('Request completed', {
      method,
      path,
      status,
      duration: `${duration}ms`,
      requestId: c.req.header('X-Request-ID'),
    });
  });

  // Global middleware: Body size limit (25MB)
  app.use('*', bodyLimit({ maxSize: 25 * 1024 * 1024 }));

  // The legacy single-secret /webhook/:orgId/github direct endpoint has been
  // removed. Direct HTTP webhook ingestion now flows exclusively through the
  // per-source generic-webhook routes mounted further below (search for
  // createGenericWebhookRoutes), which look up the secret per source from
  // the DB via cluster/webhook-secret-manager. To register a GitHub App,
  // use `kici-admin source add github ...`.

  // Cache HTTP routes — only mounted when the FILESYSTEM backend is active.
  //
  // Production / S3 backend uses pre-signed S3 URLs directly. The filesystem
  // backend doesn't have presigned URLs, so the orchestrator hosts a GET/PUT
  // route that the agent hits with an HMAC-signed token (see sign-url.ts).
  //
  //   GET  /api/v1/cache/blob/<key>?sig=<token>   — stream cached bytes
  //   PUT  /api/v1/cache/blob/<key>?sig=<token>   — accept upload (no metadata)
  //
  // The orchestrator then writes metadata via cacheStorage.initMeta(key) when
  // the agent sends `cache.upload.complete` — same two-phase pattern S3 uses.
  if (deps.fsCache) {
    registerBlobRoutes(app, deps.fsCache);
  }

  // Cancel run: send job.cancel to all agents that have dispatched jobs for this run
  // Supports force flag for immediate SIGKILL (skip hooks).
  //
  // Auth: Bearer token via TokenManager + run.cancel RBAC permission. Mounted
  // under /api/v1/admin/ so it's clearly an operator-only path. An access_log
  // row is written for every attempt (success, denial, error) under
  // source='admin_http'.
  app.post('/api/v1/admin/runs/:runId/cancel', async (c) => {
    const runId = c.req.param('runId');
    if (!runId) {
      return c.json({ error: 'Missing runId' }, 400);
    }

    // Bearer auth — refuse immediately if token manager isn't wired.
    if (!deps.adminDeps) {
      return c.json({ error: 'Admin API not available' }, 503);
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const token = authHeader.slice(7);
    const tokenInfo = await deps.adminDeps.tokenManager.validate(token);
    if (!tokenInfo) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    const recordAccess = (outcome: 'allowed' | 'denied' | 'error', errorMessage?: string) => {
      if (!deps.accessLogWriter) return;
      void deps.accessLogWriter.record({
        orgId: null,
        routingKey: null,
        actor: { type: 'api_key', keyId: tokenInfo.id, ownerSub: tokenInfo.id },
        action: 'run.cancel',
        target: { type: 'run', id: runId },
        requestId: null,
        source: 'admin_http',
        outcome,
        errorMessage: errorMessage ?? null,
      });
    };

    if (!deps.adminDeps.rbac.hasPermission(tokenInfo.role, 'run.cancel')) {
      recordAccess('denied', `role "${tokenInfo.role}" lacks run.cancel`);
      return c.json({ error: 'Permission denied: run.cancel required' }, 403);
    }

    try {
      // Parse optional force flag from request body
      let force = false;
      try {
        const body = await c.req.json();
        if (body?.force === true) {
          force = true;
        }
      } catch {
        // No body or invalid JSON -- default to graceful cancel
      }

      // Check if run exists and is not already terminal
      const runRow = await deps.db
        .selectFrom('execution_runs')
        .select(['status', 'cancelled_by'])
        .where('run_id', '=', runId)
        .executeTakeFirst();

      if (!runRow) {
        recordAccess('allowed', 'run not found');
        return c.json({ error: 'Run not found' }, 404);
      }

      const terminalStates: ReadonlySet<string> = new Set([
        ExecutionRunStatus.enum.success,
        ExecutionRunStatus.enum.failed,
        ExecutionRunStatus.enum.cancelled,
      ]);
      if (terminalStates.has(runRow.status)) {
        recordAccess('allowed', `run already in terminal state ${runRow.status}`);
        return c.json({ error: 'Run already in terminal state', status: runRow.status }, 409);
      }

      // The execution tracker is required to drive a no-outstanding-work run
      // to its terminal status through the shared cancel path.
      if (!deps.executionTracker) {
        recordAccess('error', 'execution tracker not available');
        return c.json({ error: 'Cancel not available' }, 503);
      }

      const reason = force ? 'force cancelled via API' : 'run cancelled via API';
      // Canonical run-cancel path — shared with the WorkflowDeadlineDetector.
      const { agentsNotified, pendingCancelled } = await cancelRunWithReason(
        {
          db: deps.db,
          jobQueue: deps.jobQueue,
          dispatcher: deps.dispatcher,
          registry: deps.registry,
          executionTracker: deps.executionTracker,
        },
        runId,
        reason,
        { force, cancelledBy: `api_key:${tokenInfo.id}` },
      );

      const resultStatus =
        agentsNotified > 0 ? ExecutionRunStatus.enum.cancelling : ExecutionRunStatus.enum.cancelled;
      recordAccess('allowed');
      return c.json(
        { status: resultStatus, cancelledJobs: agentsNotified + pendingCancelled },
        200,
      );
    } catch (err) {
      logger.error('Cancel run failed', {
        runId,
        error: toErrorMessage(err),
      });
      recordAccess('error', toErrorMessage(err));
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Generic webhook routes (mounted when generic source manager is available)
  if (deps.genericSourceManager) {
    app.route(
      '/',
      createGenericWebhookRoutes({
        sourceManager: deps.genericSourceManager,
        dedup: deps.dedup,
        onWebhook: async (info) => {
          const reqId = randomUUID();
          await requestContext.run({ requestId: reqId, routingKey: info.routingKey }, async () => {
            try {
              await processWebhook(info, {
                dedup: deps.dedup,
                providerRegistry: deps.providerRegistry,
                lockFileCache: deps.lockFileCache,
                dispatcher: deps.dispatcher,
                platformClient: deps.platformClient,
                sourceCache: deps.sourceCache,
                buildCoordinator: deps.buildCoordinator,
                depCache: deps.depCache,
                pendingBuilds: deps.pendingBuilds,
                pendingInits: deps.pendingInits,
                pendingDynamics: deps.pendingDynamics,
                checkRunReporter: deps.checkRunReporter,
                executionTracker: deps.executionTracker,
                onSourceLocationsExtracted,
                eventRouter: deps.eventRouter,
                registrationStore: deps.registrationStore,
                registrationIndex: deps.registrationIndex,
                db: deps.db,
                secretKey: deps.config.secretKey,
                secretResolver: deps.secretResolver,
                logStorage: deps.logStorage,
                environmentStore: deps.environmentStore,
                variableStore: deps.variableStore,
                heldRunStore: deps.heldRunStore,
                coordinator: deps.coordinator,
                cronScheduler: deps.cronScheduler,
                globalWorkflowPolicy: deps.globalWorkflowPolicy,
                eventLog: deps.eventLogWriter,
                eventLogSource: 'direct',
                contributorCache: deps.contributorCache,
                accessLogWriter: deps.accessLogWriter,
                hostRosterStore: deps.hostRosterStore,
                instanceId: deps.config.instanceId,
                rosterGraceMs: deps.config.rosterGraceMs,
                maxFanoutHosts: deps.config.maxFanoutHosts,
              });
            } catch (err) {
              if (deps.eventLogWriter) {
                try {
                  await deps.eventLogWriter.record(info, payloadFromObject(info.payload), {
                    orgId: '__default__',
                    source: 'direct',
                    status: 'failed',
                    errorMessage: toErrorMessage(err),
                  });
                } catch (recordErr) {
                  logger.warn('Failed to record failed event-log row for generic path', {
                    deliveryId: info.deliveryId,
                    error: toErrorMessage(recordErr),
                  });
                }
              }
              throw err;
            }
          });
        },
      }),
    );
  }

  // Admin API routes (optional -- only when secrets management is configured).
  // We merge `accessLog` in here (rather than the caller threading it
  // through adminDeps) because the writer is built later in
  // orchestrator-core than adminDeps itself.
  if (deps.adminDeps) {
    app.route(
      '',
      createAdminRoutes({
        ...deps.adminDeps,
        accessLog: deps.accessLogWriter,
        resolveSourceWebhookUrl: deps.resolveSourceWebhookUrl,
        resolveGithubWebhookUrl: deps.resolveGithubWebhookUrl,
      }),
    );
  }

  // Admin event routes (optional -- mounted when generic source + trust management is available)
  if (deps.genericSourceManager && deps.trustStore && deps.adminDeps) {
    app.route(
      '',
      createAdminEventRoutes({
        sourceManager: deps.genericSourceManager,
        trustStore: deps.trustStore,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
        // Needed so the POST /generic-sources handler can register the
        // new source's per-routing-key bundle into the live registry —
        // without it, the next webhook 404s until the next restart.
        providerRegistry: deps.providerRegistry,
        config: deps.config,
        secretResolver: deps.secretResolver ?? null,
        // Required for the `POST /api/v1/admin/events/emit` route — mirrors
        // `emitKiciEventDirect` in `@kici-dev/shared/db-admin.ts`.
        pool: deps.pool,
      }),
    );
  }

  // Admin registration routes (optional -- mounted when registration system is initialized)
  if (deps.registrationStore && deps.registrationIndex && deps.adminDeps) {
    app.route(
      '',
      createAdminRegistrationRoutes({
        registrationStore: deps.registrationStore,
        registrationIndex: deps.registrationIndex,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
      }),
    );
  }

  // Admin run inspection routes (optional -- mounted when admin auth is configured).
  // masterSecretKey + auditLogger are required only by the ?reveal=true variant
  // of /admin/runs/:runId/secret-outputs; when absent, that path 503s cleanly.
  if (deps.adminDeps) {
    app.route(
      '',
      createAdminRunRoutes({
        db: deps.db,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
        auditLogger: deps.adminDeps.auditLogger,
        masterSecretKey: deps.config.secretKey,
      }),
    );
  }

  // Admin event-log routes (optional -- mounted when admin auth is configured
  // AND log storage is available for payload reads).
  if (deps.adminDeps && deps.logStorage) {
    app.route(
      '',
      createAdminEventLogRoutes({
        db: deps.db,
        logStorage: deps.logStorage,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
        coldStore: deps.coldStore ?? undefined,
      }),
    );
  }

  // Access log admin routes (mounted when adminDeps is available AND an
  // accessLogWriter has been wired by orchestrator-core).
  if (deps.adminDeps && deps.accessLogWriter) {
    app.route(
      '',
      createAdminAccessLogRoutes({
        accessLog: deps.accessLogWriter,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
      }),
    );
  }

  // Scheduled-jobs admin trigger route. Lets an admin force a registered
  // scheduled job tick out of band (used by cold-store E2E smoke + future
  // dashboard "Run now" buttons).
  if (deps.adminDeps) {
    app.route(
      '',
      createAdminScheduledJobsRoutes({
        db: deps.db,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
      }),
    );
  }

  // Event-DLQ admin routes. Mounted when adminDeps + eventStore are wired
  // (i.e. the orchestrator runs the event router subsystem at all).
  if (deps.adminDeps && deps.eventStore) {
    app.route(
      '',
      createAdminEventDlqRoutes({
        eventStore: deps.eventStore,
        tokenManager: deps.adminDeps.tokenManager,
        rbac: deps.adminDeps.rbac,
        accessLog: deps.accessLogWriter,
      }),
    );
  }

  // Config admin API routes (optional -- mounted when config management is available)
  if (deps.configRouteDeps) {
    app.route('/admin/config', createConfigAdminRoutes(deps.configRouteDeps));
  }

  // Cluster health routes (always mounted -- cluster always on)
  app.route('/', deps.clusterHealthRoutes);

  // Diagnostic health check endpoint
  app.route(
    '/',
    createDiagnosticsRoutes({
      db: deps.db,
      platformUrl: deps.config.platformUrl,
      agentRegistry: deps.registry,
      config: deps.config as unknown as Record<string, unknown>,
      tlsCertPath: deps.config.tlsCertPath,
      scalerManager: deps.scalerManager,
    }),
  );

  // Fleet log-collection routes (mounted when fleet backing + token manager
  // are available — i.e. whenever admin auth is configured).
  if (deps.fleetRoutes && deps.tokenManager) {
    app.route('/', createFleetRoutes({ fleet: deps.fleetRoutes, tokenManager: deps.tokenManager }));
  }

  // Peer WebSocket route for incoming peer connections (always mounted)
  {
    const peerHandlerRef = deps.peerHandler;
    app.get(
      '/ws/peer',
      upgradeWebSocket((c) => {
        const connInfo = getConnInfo(c);
        const remoteIp = extractRemoteIp(c, connInfo, deps.config.cluster.trustedProxies);

        return {
          onOpen: (_event, ws) => {
            // Create a WsLike adapter from the Hono WSContext
            const wsLike = {
              send: (data: string) => ws.send(data),
              close: (code?: number, reason?: string) => ws.close(code, reason),
              on: (event: string, _listener: (...args: unknown[]) => void) => {
                if (event === 'message') {
                  // onMessage will handle this via the Hono WSEvents pattern below
                } else if (event === 'close') {
                  // onClose will handle this via the Hono WSEvents pattern below
                } else if (event === 'error') {
                  // onError will handle this via the Hono WSEvents pattern below
                }
              },
              readyState: 1, // OPEN
            };
            // Store the wsLike adapter on the ws context for message routing
            (ws as any).__peerWsLike = wsLike;
            // Collect event handlers from the peer handler
            const handlers: {
              onMessage?: (data: unknown) => void;
              onClose?: () => void;
              onError?: (err: unknown) => void;
            } = {};
            wsLike.on = (event: string, listener: (...args: unknown[]) => void) => {
              if (event === 'message') handlers.onMessage = listener;
              else if (event === 'close') handlers.onClose = listener;
              else if (event === 'error') handlers.onError = listener;
            };
            (ws as any).__peerHandlers = handlers;
            peerHandlerRef.handleConnection(wsLike, remoteIp);
          },
          onMessage: (event, ws) => {
            const handlers = (ws as any).__peerHandlers;
            if (handlers?.onMessage) {
              const data =
                typeof event.data === 'string' ? event.data : (event.data?.toString?.() ?? '');
              handlers.onMessage(data);
            }
          },
          onClose: (_event, ws) => {
            const wsLike = (ws as any).__peerWsLike;
            if (wsLike) wsLike.readyState = 3; // CLOSED
            const handlers = (ws as any).__peerHandlers;
            handlers?.onClose?.();
          },
          onError: (event, ws) => {
            const handlers = (ws as any).__peerHandlers;
            handlers?.onError?.(event);
          },
        };
      }),
    );
  }

  // Direct peer join endpoint (for `kici-orchestrator join --peer` transport)
  if (deps.onJoinRequest) {
    const joinHandler = deps.onJoinRequest;
    app.post('/api/v1/cluster/join', async (c) => {
      try {
        const body = await c.req.json();
        if (!body?.token || typeof body.token !== 'string') {
          return c.json({ type: 'join.response', success: false, error: 'Missing token' }, 400);
        }
        const response = await joinHandler({ type: 'join.request', token: body.token });
        return c.json(response, response.success ? 200 : 401);
      } catch (_err) {
        return c.json({ type: 'join.response', success: false, error: 'Internal error' }, 500);
      }
    });
  }

  // Health and readiness routes
  app.route(
    '/',
    createHealthRoutes({
      db: deps.db,
    }),
  );

  // Public capability manifest for CLI capability-gap error messages
  app.route('/', createCapabilitiesRoutes());

  // Prometheus metrics (served via OTel PrometheusExporter)
  app.route(
    '/',
    createMetricsRoutes({
      getMetrics: async () => {
        const exporter = getPrometheusExporter();
        if (!exporter) {
          return { contentType: 'text/plain', body: '# OTel not initialized\n' };
        }
        // Capture output from the PrometheusExporter's request handler
        // by wrapping it with a mock response
        const otelResult = await new Promise<{ contentType: string; body: string }>((resolve) => {
          const chunks: Buffer[] = [];
          let contentType = 'text/plain';
          const mockRes = {
            setHeader: (_name: string, value: string) => {
              if (_name.toLowerCase() === 'content-type') contentType = value;
            },
            end: (data: string) => {
              chunks.push(Buffer.from(data ?? ''));
              resolve({
                contentType,
                body: Buffer.concat(chunks).toString(),
              });
            },
            writeHead: (statusCode: number, headers?: Record<string, string>) => {
              if (headers?.['content-type']) contentType = headers['content-type'];
              if (statusCode !== 200) {
                resolve({ contentType: 'text/plain', body: '# metrics error\n' });
              }
            },
          };
          exporter.getMetricsRequestHandler({} as any, mockRes as any);
        });

        // Append aggregated agent metrics to the orchestrator's own metrics
        const agentMetricsText = agentMetricsAggregator.getPrometheusText();
        if (agentMetricsText) {
          otelResult.body = otelResult.body + '\n' + agentMetricsText;
        }
        return otelResult;
      },
    }),
  );

  return {
    app,
    injectWebSocket,
    onSourceLocationsExtracted,
    /**
     * Wake up the FIFO-next queued concurrency waiter for `(group, routingKey)`.
     * Called by orchestrator-core when a slot is released (run completion,
     * cancellation, supersession). No-op when concurrency is disabled.
     */
    tryDispatchNextQueued,
  };
}
