/**
 * Platform-connected entry point for the customer orchestrator.
 *
 * Operates in 'platform' or 'hybrid' mode:
 * - platform: receives webhooks ONLY via Platform WS relay
 * - hybrid: receives webhooks via both WS relay and direct HTTP endpoint
 *
 * Both modes connect a PlatformClient to the Platform relay and run an agent WS server.
 *
 * Startup sequence follows packages/platform/src/server.ts pattern:
 * config -> DB -> migrations -> provider registry -> dispatcher -> PlatformClient -> app -> HTTP -> heartbeat
 *
 * Graceful shutdown in reverse order:
 * Platform client -> agent WS -> heartbeat -> HTTP -> DB
 */

import {
  createLogger,
  guardStartup,
  requestContext,
  setServiceName,
  initTelemetry,
  toErrorMessage,
} from '@kici-dev/shared';
import {
  OrchRole,
  githubWebhookPath,
  PLATFORM_CONNECTED_MODES,
  RELAY_INGRESS_MODES,
  type ActorPrincipal,
  type ExecutionJobStatus,
} from '@kici-dev/engine';
import { observedRelayVerify, observedRelayReject } from './webhook/observed-relay-guard.js';
import { createDashboardCancelHandler } from './cancel/dashboard-cancel-handler.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// The six workspace dep fingerprints power the SDK drift diagnostic — compare
// orchestrator.sdkBundleHash against agent.sdkBundleHash in one log-grep.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_COMMIT: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;
const ORCHESTRATOR_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.1';
const BUILD_COMMIT = typeof KICI_BUILD_COMMIT !== 'undefined' ? KICI_BUILD_COMMIT : 'unknown';
const SDK_VERSION = typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown';
const SDK_BUNDLE_HASH =
  typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown';
const SHARED_VERSION = typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : 'unknown';
const SHARED_BUNDLE_HASH =
  typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : 'unknown';
const ENGINE_VERSION = typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : 'unknown';
const ENGINE_BUNDLE_HASH =
  typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : 'unknown';

// Initialize OTel SDK BEFORE any metric-creating modules are imported.
// ESM static imports are hoisted, so we must use dynamic imports for modules
// that transitively create OTel meters (prometheus.ts, etc.).
const otelSdk = initTelemetry({
  serviceName: 'kici-orchestrator',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

// Dynamic imports: these modules create OTel meters at module load time,
// so they must be imported after initTelemetry() sets up the MeterProvider.
const { loadConfig } = await import('./config.js');
const { PlatformClient } = await import('./ws/platform-client.js');
const { processWebhook } = await import('./pipeline/processor.js');
const { dispatchReadyJob } = await import('./pipeline/processor.js');
const { resumeWorkflow, rejectWorkflow } = await import('./pipeline/resume-workflow.js');
const { LogPullHandler } = await import('./reporting/log-pull-handler.js');
const { DashboardHandler } = await import('./dashboard/handler.js');
const { payloadFromObject } = await import('./webhook/event-log.js');
const { loadActiveGenericRoutingKeys } = await import('./webhook/generic-sources.js');
const { buildPlatformProviderSources } = await import('./sources/build-platform-sources.js');
const { DashboardContextHandler } = await import('./ws/dashboard-context-handler.js');
const { DashboardRegistrationsHandler } = await import('./ws/dashboard-registrations-handler.js');
const { DashboardBackendsHandler } = await import('./ws/dashboard-backends-handler.js');
const { DashboardFleetWriteHandler } = await import('./ws/dashboard-fleet-write-handler.js');
const { DashboardGlobalWorkflowsHandler, isDashboardGlobalWorkflowsMessage } =
  await import('./ws/dashboard-global-workflows-handler.js');
const { guardedDashboardDispatch } = await import('./ws/dashboard-dispatch-guard.js');
const { handleDiagnosticsRequest, handleScalerCapacityRequest, handleScalerAgentsRequest } =
  await import('./ws/dashboard-diagnostics-handler.js');
const {
  handleFleetHostsRequest,
  handleFleetHostRequest,
  handleFleetPreviewRequest,
  handleFleetWorkflowsForHostRequest,
} = await import('./ws/dashboard-fleet-handler.js');
const { handleRunState } = await import('./ws/dashboard-run-state-handler.js');
const { resolveWorkflowRunsOnAll } = await import('./ws/fleet-runs-on-all.js');
const { ContextStore } = await import('./contexts/context-store.js');
const { VariableStore } = await import('./contexts/variable-store.js');
const { BindingStore } = await import('./contexts/binding-store.js');
const { handleRerun } = await import('./pipeline/rerun.js');
const { handleManualSchedule } = await import('./pipeline/manual-schedule.js');
const { buildContextSecretResolver } = await import('./secrets/context-secret-resolver.js');
const { PeerClient, PeerAuthCoordinator } = await import('./cluster/index.js');
const { TrustResolver } = await import('./security/trust-resolver.js');
const { ContributorCache } = await import('./security/contributor-cache.js');
const { HeldRunStore } = await import('./contexts/held-runs.js');
const { TrustPolicyStore } = await import('./security/trust-policy-store.js');
const { StepApprovalBridge } = await import('./approvals/step-approval-bridge.js');
const { GlobalWorkflowPolicy } = await import('./security/global-workflow-policy.js');
const { bootstrapOrchestrator } = await import('./orchestrator-core.js');
const { getClusterName } = await import('./config/cluster-name.js');
const { getClusterId } = await import('./config/cluster-id.js');
const { MetricsReporter } = await import('./metrics/metrics-reporter.js');
const { getDashboardWritePolicy, dashboardWritePolicyEvents } =
  await import('./policy/dashboard-write-policy.js');
const { AttestationRetrier } = await import('./provenance/attestation-retrier.js');
const { PendingAttestationsRepo } = await import('./provenance/pending-attestations-repo.js');
const { backfillRunToPlatform } = await import('./provenance/backfill-run.js');
const { requestMint, MintUnavailableError, MintRelayError, MintRejectedError } =
  await import('./ws/oidc-token-relay.js');
const { computeAttestationVerdict } = await import('./provenance/verify-at-ingest.js');
const { setPendingAttestations, setPendingAttestationOldestAgeSeconds, setRejectedAttestations } =
  await import('./metrics/prometheus.js');
const { provenanceStorageKey } = await import('@kici-dev/engine/provenance/bundle');

// Type-only imports (safe as static — erased at runtime, no meter creation)
import type { IdentityLink, PermissionLevel } from './security/trust-resolver.js';
import type { ProcessingDeps } from './pipeline/processor.js';
import { provisionRemoteSource } from './pipeline/remote-source-store.js';
import { readDeploymentIdentity } from './deployment/deployment-identity.js';
import { dispatchTestRelay } from './ws/test-relay-handlers.js';
import { buildExecutionStatusFrame } from './ws/execution-status-frame.js';
import type { ReleaseSignal } from './contexts/held-runs.js';
import type { OrchestratorHooks } from './orchestrator-core.js';
import type { PeerClient as PeerClientT } from './cluster/peer-client.js';
import {
  tryResolveVerifiedIssuer,
  verifiedIssuerCapabilityUpdate,
} from './cluster/verified-issuer.js';
import { startVerifiedIssuerPoller } from './cluster/verified-issuer-poller.js';
import { verifyInboundWebhook } from './webhook/verify-inbound.js';
import { deliveryFromRelay } from './webhook/ingest-overflow-types.js';
import { buildRelayReinject } from './webhook/relay-reinject.js';
import { buildLocalGithubIngressUrl } from './cli/local-github-ingress-url.js';
import {
  createUnavailableSecretStore,
  loadRoutableStores,
  type ScopedSecretStore,
} from './secrets/scope-routing.js';
import type { AuditLogger } from './secrets/audit-logger.js';
import type { DashboardWritePolicyMap } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  dashboardEncryptionJwkSchema,
  type DashboardEncryptionJwk,
} from '@kici-dev/engine/protocol/messages/dashboard-sealed-write';

setServiceName('orchestrator');
const logger = createLogger({ prefix: 'server' });

/**
 * Return true if `rawUrl` from the static peers list points at this very
 * orchestrator. Compares against the canonical cluster address verbatim and
 * also treats `localhost` / `127.0.0.1` variants at our own port as self so
 * an operator misconfig (listing a loopback URL of this same orch) is a
 * no-op rather than a self-loop dial.
 */
function isSelfPeerUrl(rawUrl: string, clusterAddress: string | undefined, port: number): boolean {
  const normalize = (u: string): string => u.replace(/\/+$/, '');
  if (clusterAddress && normalize(rawUrl) === normalize(clusterAddress)) return true;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    const peerPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    if (peerPort === port && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) {
      return true;
    }
  } catch {
    // Malformed URL — let it through; the WS layer will surface the error.
  }
  return false;
}

await guardStartup(logger, async () => {
  // SDK drift diagnostic (see docs/operator/troubleshooting.md). Emitted before
  // any subsystem init so operators can correlate on a fresh install where
  // config / DB might fail later: the bundle fingerprint is always observable.
  logger.info('orchestrator.build.info', {
    orchestratorVersion: ORCHESTRATOR_VERSION,
    buildCommit: BUILD_COMMIT,
    sdkVersion: SDK_VERSION,
    sdkBundleHash: SDK_BUNDLE_HASH,
    sharedVersion: SHARED_VERSION,
    sharedBundleHash: SHARED_BUNDLE_HASH,
    engineVersion: ENGINE_VERSION,
    engineBundleHash: ENGINE_BUNDLE_HASH,
  });

  // 1. Load configuration and validate mode
  const config = loadConfig();

  // Worker mode: branch to worker bootstrap (separate lifecycle, no DB/Platform/Raft)
  // Works from any entry point — workers don't care about KICI_MODE
  if (config.cluster.role === 'worker') {
    const { bootstrapWorker } = await import('./worker-core.js');
    await bootstrapWorker(config, { otelSdk });
    return;
  }

  if (!PLATFORM_CONNECTED_MODES.includes(config.mode)) {
    logger.error(`server.ts requires KICI_MODE=${PLATFORM_CONNECTED_MODES.join('/')}`, {
      mode: config.mode,
    });
    process.exit(1);
  }

  // `observed` keeps the Platform WebSocket purely for observability + its
  // observe-only source registration: it ingests only its OWN webhooks, so the
  // relay callbacks below are wired to a refusing guard instead of the pipeline.
  const relayEnabled = RELAY_INGRESS_MODES.includes(config.mode);
  if (!relayEnabled) {
    logger.info('Observed mode: serving own webhook ingress only, Platform relays are refused', {
      mode: config.mode,
    });
  }

  // Platform-specific state (closures captured by hooks)
  let platformClient: InstanceType<typeof PlatformClient>;
  // Deferred-attestation retrier: constructed after the platform client, driven
  // on a timer (leader-gated) and on every Platform re-authentication.
  let attestationRetrier: InstanceType<typeof AttestationRetrier> | undefined;

  const hooks: OrchestratorHooks = {
    logPrefix: 'server',

    // Browser fan-out for step logs the coordinator persisted on behalf of a
    // worker. The local-agent path forwards its own chunks from `app.ts`.
    forwardLogChunk: (chunk) => {
      platformClient.send({
        type: 'log.chunk',
        messageId: crypto.randomUUID(),
        runId: chunk.runId,
        jobId: chunk.jobId,
        stepIndex: chunk.stepIndex,
        lines: chunk.lines,
        timestamp: chunk.timestamp,
        ...(chunk.stream !== undefined && { stream: chunk.stream }),
      });
    },

    executionTrackerExtras: () => ({
      onExecutionStatusChange: (
        runId,
        status,
        context,
        jobCount,
        startedAt,
        completedAt,
        durationMs,
        failureReason,
        logBytes,
        initFailure,
      ) => {
        try {
          platformClient.send(
            buildExecutionStatusFrame({
              messageId: crypto.randomUUID(),
              runId,
              status,
              context,
              jobCount,
              startedAt,
              timestamp: Date.now(),
              ...(completedAt !== undefined && { completedAt }),
              ...(durationMs !== undefined && { durationMs }),
              ...(failureReason !== undefined && { failureReason }),
              ...(logBytes !== undefined && { logBytes }),
              ...(initFailure && { initFailure }),
            }),
          );
        } catch (err) {
          logger.warn('Failed to forward execution status to Platform', {
            runId,
            status,
            error: toErrorMessage(err),
          });
        }
      },
      onJobStatusChange: (
        runId,
        jobId,
        jobName,
        status,
        timestamp,
        startedAt,
        completedAt,
        durationMs,
        errorMessage,
        agentId,
        runsOnLabels,
        logBytes,
        initFailure,
        environments,
      ) => {
        try {
          platformClient.send({
            type: 'job.status.forward',
            messageId: crypto.randomUUID(),
            runId,
            jobId,
            jobName,
            // Cast to the shared enum, never to a hand-listed union: the wire
            // schema's field IS `ExecutionJobStatus`, so a literal list here
            // silently goes stale every time a status joins the enum.
            status: status as ExecutionJobStatus,
            timestamp,
            ...(startedAt !== undefined && { startedAt }),
            ...(completedAt !== undefined && { completedAt }),
            ...(durationMs !== undefined && { durationMs }),
            ...(errorMessage !== undefined && { errorMessage }),
            ...(logBytes !== undefined && { logBytes }),
            ...(agentId && { agentId }),
            ...(runsOnLabels?.length && { runsOnLabels }),
            ...(environments?.length && { environments }),
            ...(initFailure && { initFailure }),
            orchestratorId: config.instanceId,
          });
        } catch (err) {
          logger.warn('Failed to forward job status to Platform', {
            runId,
            jobId,
            status,
            error: toErrorMessage(err),
          });
        }
      },
      onStepStatusForward: (
        runId,
        jobId,
        jobName,
        stepIndex,
        stepName,
        state,
        timestamp,
        data,
        reqId,
      ) => {
        const doWork = () => {
          // Extract top-level forward fields from data (merged there by app.ts).
          const secretsAccessed = data?.secretsAccessed as string[] | undefined;
          const concurrencyKind = data?.concurrencyKind as
            'sequential' | 'parallel-child' | 'parallel-group' | undefined;
          const groupId = data?.groupId as string | undefined;
          const { secretsAccessed: _s, concurrencyKind: _c, groupId: _g, ...restData } = data ?? {};
          const hasRestData = Object.keys(restData).length > 0;

          platformClient.send({
            type: 'step.status.forward',
            messageId: crypto.randomUUID(),
            runId,
            jobId,
            jobName,
            stepIndex,
            stepName,
            state: state as 'running' | 'success' | 'failed' | 'skipped' | 'pending' | 'cancelled',
            timestamp,
            ...(hasRestData && { data: restData }),
            ...(secretsAccessed !== undefined && { secretsAccessed }),
            ...(concurrencyKind !== undefined && { concurrencyKind }),
            ...(groupId !== undefined && { groupId }),
          });
        };
        if (reqId) {
          requestContext.run({ requestId: reqId, runId }, doWork);
        } else {
          doWork();
        }
      },
      onRunEventEmit: (event) => {
        try {
          platformClient.send({
            type: 'run.event',
            ...event,
          } as any);
        } catch (err) {
          logger.warn('Failed to forward run event to Platform', {
            runId: event.runId,
            eventType: event.eventType,
            error: toErrorMessage(err),
          });
        }
      },
      onOrchLog: (chunk) => {
        // Best-effort live forward of orch/provisioning log lines to Platform,
        // which fans them out to run-detail browser subscribers. A push failure
        // must never break dispatch — persistence stays authoritative.
        try {
          platformClient.send({
            type: 'orch-log.chunk',
            ...chunk,
          } as any);
        } catch (err) {
          logger.warn('Failed to forward orch log to Platform', {
            runId: chunk.runId,
            jobId: chunk.jobId,
            error: toErrorMessage(err),
          });
        }
      },
    }),

    onSecretsInitialized: ({ pgSecretStore, backendStores, db, auditLogger }) =>
      buildContextSecretResolver({ pgSecretStore, backendStores, db, auditLogger, logger }),

    onSubsystemsReady: async (sub) => {
      // Trust resolution state (updated by Platform push)
      const contributorCache = new ContributorCache({
        ttlMs: sub.config.contributorCacheTtlMs,
        clusterSettings: sub.clusterSettings,
      });
      const trustResolver = new TrustResolver(contributorCache);
      let identityLinks: IdentityLink[] = [];
      let orgMemberPermissions = new Map<string, PermissionLevel>();
      // Operator-defined teams pushed from the Platform (the orchestrator has
      // no identity store). Keyed by team name → set of member user ids. The
      // approval resolver reads this to satisfy `{team}` clauses.
      let teamMemberships = new Map<string, Set<string>>();
      const teamMembershipLookup = {
        getTeamMembers(name: string): Set<string> {
          return teamMemberships.get(name) ?? new Set<string>();
        },
      };
      const heldRunStore = new HeldRunStore(sub.db);
      const trustPolicyStore = new TrustPolicyStore(sub.db);

      // Provider sources advertised to the Platform: GitHub-app sources
      // (SourceManager, DB-first) + servable generic-webhook sources. The same
      // builder feeds the live republish wired below, so a runtime source
      // add/remove re-sends the complete set rather than a partial list.
      const loadGenericRows = () => loadActiveGenericRoutingKeys(sub.db);
      const providerSources = await buildPlatformProviderSources(
        sub.sourceManager,
        loadGenericRows,
      );

      // Create LogPullHandler
      let logPullSendFn: ((msg: unknown) => void) | null = null;
      const logPullHandler = new LogPullHandler({
        logStorage: sub.logStorage,
        executionTracker: sub.executionTracker,
        send: (msg) => logPullSendFn?.(msg),
      });

      // Resolved tenant context for diagnostics access_log rows. Populated in
      // onAuthenticated when the sources table yields a real customer_id /
      // routing_key; until then the diagnostics handler records rows with
      // null orgId/routingKey (same behaviour as DashboardHandler pre-resolve).
      let resolvedOrgContext: { orgId: string; routingKey: string } | null = null;

      // Step-approval bridge: opens step-scoped holds when an agent blocks a
      // `requireApproval` step, and relays the resolution (approve / reject /
      // expire) back to that agent. Shared by the agent WS handler (via
      // appDepsExtras), the dashboard approve/reject applier (`onStepRelease` /
      // `onStepReject`), and the stale detector (expiry).
      const stepApprovalBridge = new StepApprovalBridge({
        store: heldRunStore,
        resolveOrgId: () => resolvedOrgContext?.orgId ?? '__default__',
        resolveExpirySeconds: async (orgId) => {
          try {
            const row = await sub.db
              .selectFrom('org_settings')
              .select('approval_expiry_seconds')
              .where('customer_id', '=', orgId)
              .executeTakeFirst();
            return row?.approval_expiry_seconds ?? 86400;
          } catch {
            return 86400;
          }
        },
        accessLogWriter: sub.accessLogWriter,
      });

      // Subscription to dashboard-write policy changes for the resolved
      // customer. Installed once after the first successful org-context
      // resolution and lives for the process lifetime — the orchestrator
      // is single-tenant so the customer_id never changes between
      // resolutions. The handler rebroadcasts `orch.capabilities.update`
      // to Platform via the WebSocket client.
      let policyChangeSubscriber:
        ((evt: { customerId: string; policy: DashboardWritePolicyMap }) => void) | null = null;

      // Installed once and lives for the process lifetime, like the policy
      // subscriber above — the orchestrator is single-tenant.
      let stopVerifiedIssuerPoller: (() => void) | null = null;

      // The inbound webhook delivery log writer is constructed by
      // orchestrator-core (so the cleanup scheduler can share it). The relay
      // path here just borrows the same instance.
      const eventLogWriter = sub.eventLogWriter;

      // Create DashboardHandler
      let dashboardSendFn: ((msg: unknown) => void) | null = null;
      const dashboardHandler = new DashboardHandler({
        db: sub.db,
        logStorage: sub.logStorage,
        // Orchestrator-owned provenance issuer (when signing is configured) so
        // the Platform surfaces it as `trustedIssuer` on attestations reads.
        provenanceSigningIssuer: config.provenanceSigningIssuer ?? null,
        provenanceStorage: sub.cacheStorage,
        artifactStore: sub.artifactStore,
        coldStore: sub.coldStore,
        eventStore: sub.eventStore,
        // Drains the deferred-attestation outbox in this process (owns the
        // Platform WS). Wired lazily — the retrier is constructed below.
        retryAttestations: (opts: { runId?: string; includeRejected?: boolean }) =>
          attestationRetrier
            ? attestationRetrier.runOnce(opts)
            : Promise.resolve({ minted: 0, stillPending: 0, rejected: 0 }),
        send: (msg) => dashboardSendFn?.(msg),
        orchestratorId: config.instanceId,
        accessLog: sub.accessLogWriter,
        testMode: config.testMode,
        testRerunDelayMs: config.testRerunDelayMs,
        onRerun: async (runId, triggeredBy, triggeredByAgentLabel, requestId, routingKey) => {
          return handleRerun(
            runId,
            triggeredBy,
            triggeredByAgentLabel,
            {
              db: sub.db,
              logStorage: sub.logStorage,
              providerRegistry: sub.providerRegistry,
              executionTracker: sub.executionTracker,
              dispatcher: sub.dispatcher,
              jobQueue: sub.queue,
              platformClient,
              checkRunReporter: sub.checkRunReporter,
              coordinator: sub.coordinator,
              secretResolver: sub.secretResolver,
              eventRouter: sub.eventRouter,
              agentRegistry: sub.agentRegistry,
              sourceCache: sub.sourceCache ?? null,
              depCache: sub.depCache ?? null,
              buildCoordinator: sub.buildCoordinator ?? null,
              pendingBuilds: sub.pendingBuilds ?? null,
              coldStore: sub.coldStore,
            },
            requestId,
            routingKey,
          );
        },
        onManualSchedule: async (registrationId, triggeredBy, triggeredByAgentLabel, requestId) => {
          return handleManualSchedule(
            registrationId,
            triggeredBy,
            triggeredByAgentLabel,
            {
              db: sub.db,
              logStorage: sub.logStorage,
              providerRegistry: sub.providerRegistry,
              executionTracker: sub.executionTracker,
              dispatcher: sub.dispatcher,
              jobQueue: sub.queue,
              platformClient,
              checkRunReporter: sub.checkRunReporter,
              coordinator: sub.coordinator,
              secretResolver: sub.secretResolver,
              eventRouter: sub.eventRouter,
              agentRegistry: sub.agentRegistry,
              sourceCache: sub.sourceCache ?? null,
              depCache: sub.depCache ?? null,
              buildCoordinator: sub.buildCoordinator ?? null,
              pendingBuilds: sub.pendingBuilds ?? null,
              registrationIndex: sub.registrationIndex,
              coldStore: sub.coldStore,
            },
            requestId,
          );
        },
        onCancel: createDashboardCancelHandler({
          db: sub.db,
          jobQueue: sub.queue,
          dispatcher: sub.dispatcher,
          registry: sub.agentRegistry,
          executionTracker: sub.executionTracker,
        }),
      });

      // Create global workflow policy for org-level permission enforcement
      const globalWorkflowPolicy = new GlobalWorkflowPolicy(
        sub.db,
        sub.clusterSettings,
        sub.config.globalWorkflowsEnabled,
      );

      // Create environment stores and DashboardContextHandler
      const contextStore = new ContextStore(sub.db);
      const variableStore = new VariableStore(sub.db);
      const bindingStore = new BindingStore(sub.db);

      // Assemble the ProcessingDeps bundle once so both the inbound webhook path
      // and the workflow install-hold resume path use the same live deps.
      const buildProcessingDeps = (): ProcessingDeps => ({
        dedup: sub.dedup,
        providerRegistry: sub.providerRegistry,
        ensureProviderBundle: sub.ensureProviderBundle,
        lockFileCache: sub.lockFileCache,
        contentRequirementsCache: sub.contentRequirementsCache,
        dispatcher: sub.dispatcher,
        platformClient,
        webhookPayloadDir: config.webhookPayloadDir,
        sourceCache: sub.sourceCache,
        buildCoordinator: sub.buildCoordinator,
        depCache: sub.depCache,
        pendingBuilds: sub.pendingBuilds,
        pendingInits: sub.pendingInits,
        pendingDynamics: sub.pendingDynamics,
        pendingGlobalEvals: sub.pendingGlobalEvals,
        globalEvalCache: sub.globalEvalCache,
        checkRunReporter: sub.checkRunReporter,
        executionTracker: sub.executionTracker,
        coordinator: sub.coordinator,
        secretResolver: sub.secretResolver ?? undefined,
        sandboxAllowListReader: sub.sandboxAllowListReader,
        onSourceLocationsExtracted: (workflowName, jobName, locations) =>
          sub.sourceLocationStore.set(workflowName, jobName, locations),
        eventRouter: sub.eventRouter,
        registrationStore: sub.registrationStore,
        registrationIndex: sub.registrationIndex,
        db: sub.db,
        secretKey: config.secretKey,
        logStorage: sub.logStorage,
        trustResolver,
        identityLinks,
        orgMemberPermissions,
        teamMembershipLookup,
        heldRunStore,
        trustPolicyStore,
        orchestratorMode: config.mode,
        contextStore,
        variableStore,
        globalWorkflowPolicy,
        eventLog: eventLogWriter,
        contributorCache,
        accessLogWriter: sub.accessLogWriter,
        hostRosterStore: sub.hostRosterStore,
        instanceId: config.instanceId,
        rosterGraceMs: config.rosterGraceMs,
        maxFanoutHosts: config.maxFanoutHosts,
        globalEvalRoundTimeoutMs: config.globalEvalRoundTimeoutMs,
        globalEvalCandidateTimeoutMs: config.globalEvalCandidateTimeoutMs,
        globalEvalWaitTimeoutMs: config.globalEvalWaitTimeoutMs,
        clusterSettings: sub.clusterSettings,
      });
      let dashboardEnvSendFn: ((msg: unknown) => void) | null = null;
      // The configured default-backend store. Falls back to the degraded store
      // only when the orchestrator runs without a pg secret store at all (reads
      // report no secrets, writes refuse), never to the registry's own
      // synthesized PgSecretStore — see `loadRoutableStores`.
      const dashboardSecretStore: ScopedSecretStore =
        sub.pgSecretStore ?? createUnavailableSecretStore();
      const dashboardEnvHandler = new DashboardContextHandler({
        orgId: '__default__',
        send: (msg) => dashboardEnvSendFn?.(msg),
        contextStore,
        variableStore,
        bindingStore,
        secretStore: dashboardSecretStore,
        loadBackendStores: sub.adminDeps?.backendRegistry
          ? () =>
              loadRoutableStores<ScopedSecretStore, AuditLogger>(
                sub.adminDeps!.backendRegistry,
                sub.adminDeps!.auditLogger,
                dashboardSecretStore,
              )
          : undefined,
        db: sub.db,
        accessLog: sub.accessLogWriter,
        dashboardEncryption: sub.dashboardEncryption,
        approvals: {
          store: heldRunStore,
          teamMembershipLookup: (team: string) => teamMembershipLookup.getTeamMembers(team),
          // Resume a released job/workflow hold by re-dispatching through the
          // same path the needs scheduler uses (the hold stored a pending
          // job context keyed by run id + job name).
          resumeJob: async (signal) => {
            await dispatchReadyJob(
              signal.runId,
              signal.jobId,
              sub.dispatcher,
              sub.executionTracker,
              sub.coordinator,
              sub.db,
            );
          },
          // Step-scoped release/reject: relay the resolution to the waiting
          // agent through the step-approval bridge.
          resumeStep: async (signal) => {
            stepApprovalBridge.resolve(signal.holdId, 'approved');
          },
          rejectStep: (heldRunId, reason) => {
            stepApprovalBridge.resolve(heldRunId, 'rejected', reason);
          },
          // Workflow-scoped install-gate release/reject: rebuild the dispatch
          // context and resume past the gate, or cancel the run.
          resumeWorkflow: async (signal) => {
            await resumeWorkflow(signal, buildProcessingDeps(), sub.db);
          },
          rejectWorkflow: async (runId) => {
            await rejectWorkflow(
              runId,
              buildProcessingDeps(),
              sub.db,
              'Workflow install gate rejected',
            );
          },
        },
      });

      // Create registrations handler
      let dashboardRegSendFn: ((msg: unknown) => void) | null = null;
      const dashboardRegistrationsHandler = new DashboardRegistrationsHandler({
        orgId: '__default__',
        send: (msg) => dashboardRegSendFn?.(msg),
        registrationStore: sub.registrationStore,
        registrationIndex: sub.registrationIndex,
        db: sub.db,
        accessLog: sub.accessLogWriter,
      });

      // Create global-workflows handler for dashboard org-settings edits.
      // The customer/org id is resolved post-auth from the sources table;
      // until then the handler operates against an empty id (queries return
      // the default "disabled" settings, which is correct for unconnected
      // orchs).
      let dashboardGlobalWorkflowsSendFn: ((msg: unknown) => void) | null = null;
      const dashboardGlobalWorkflowsHandler = new DashboardGlobalWorkflowsHandler({
        customerId: '',
        send: (msg) => dashboardGlobalWorkflowsSendFn?.(msg),
        db: sub.db,
        accessLog: sub.accessLogWriter,
        clusterSettings: sub.clusterSettings,
        globalWorkflowsEnabledDefault: sub.config.globalWorkflowsEnabled,
      });

      // Create backends handler for dashboard backend management
      let dashboardBackendsSendFn: ((msg: unknown) => void) | null = null;
      const dashboardBackendsHandler = new DashboardBackendsHandler({
        send: (msg) => dashboardBackendsSendFn?.(msg),
        registry:
          sub.adminDeps?.backendRegistry ??
          ({
            listBackends: async () => [],
            getBackend: async () => null,
            getBackendConfig: async () => null,
          } as any),
        healthChecker:
          sub.adminDeps?.backendHealthChecker ??
          ({
            testConnection: async () => ({
              ok: false,
              error: 'Health checker not available',
              latencyMs: 0,
            }),
          } as any),
        syncManager: sub.adminDeps?.backendSyncManager,
        accessLog: sub.accessLogWriter,
        db: sub.db,
      });

      // Fleet host writes (Model C: declare / remove). Policy-gated via
      // enforcePolicy + access-log audit; mirrors dashboardBackendsHandler.
      let dashboardFleetWriteSendFn: ((msg: unknown) => void) | null = null;
      const dashboardFleetWriteHandler = new DashboardFleetWriteHandler({
        send: (msg) => dashboardFleetWriteSendFn?.(msg),
        rosterStore: sub.hostRosterStore!,
        accessLog: sub.accessLogWriter,
        db: sub.db,
      });

      // Outbound PeerClient factory shared by Platform-mediated discovery
      // (onPeerDiscover) and the static dial loop driven by config.cluster.peers.
      // The initialKey argument is the placeholder under which the caller
      // registers the client in sub.peerClients before the handshake completes
      // (URL for static dial, peer.instanceId for discovery). On a successful
      // handshake the onAuthenticated callback re-keys the entry from
      // initialKey to the canonical target instanceId so subsequent discovery
      // events dedupe against the same client.
      // One coordinator shared by every sibling peer-client of this
      // orchestrator: it owns the credential file and serializes token-joins so
      // a reconnect storm never cascades credential revocations across siblings.
      const peerCredentialFile = config.cluster.credentialFile.replace(
        /^~/,
        process.env.HOME ?? '~',
      );
      const peerAuthCoordinator = new PeerAuthCoordinator({
        credentialFile: peerCredentialFile,
        instanceId: config.instanceId,
        joinToken: config.cluster.joinToken,
      });

      const createOutboundPeerClient = (rawUrl: string, initialKey: string): PeerClientT => {
        const peerUrl = rawUrl.replace(/^https?:\/\//, 'ws://') + '/ws/peer';
        let client: PeerClientT;
        client = new PeerClient({
          url: peerUrl,
          joinToken: config.cluster.joinToken,
          credentialFile: peerCredentialFile,
          authCoordinator: peerAuthCoordinator,
          instanceId: config.instanceId,
          peerRegistry: sub.peerRegistry,
          getLocalInventory: sub.getLocalInventory,
          heartbeatIntervalMs: config.cluster.peerHeartbeatIntervalMs,
          maxReconnectDelayMs: config.cluster.peerMaxReconnectDelayMs,
          onJobReroute: async (msg) => {
            const result = await sub.coordinator.handleIncomingReroute(msg);
            client.send({
              type: 'job.reroute.ack',
              messageId: msg.messageId,
              accepted: result.accepted,
              reason: result.reason,
            });
          },
          onJobProgress: (msg, fromPeerId, reply) =>
            sub.coordinator.onPeerJobProgress(msg, fromPeerId, reply),
          onJobCancel: (msg) => {
            if (!msg.jobId) return;
            const agentId = sub.dispatcher.getAgentIdForJob(msg.jobId);
            if (agentId) {
              const entry = sub.agentRegistry.get(agentId);
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
          onRaftVoteRequest: (msg) => sub.raft.handleVoteRequest(msg),
          onRaftVoteResponse: (msg) => sub.raft.handleVoteResponse(msg),
          onRaftAppendEntries: (msg) => sub.raft.handleAppendEntries(msg),
          onPeerLeaving: (msg) => sub.raft.handlePeerLeaving(msg.instanceId),
          onAgentTokenRevoke: (msg) => {
            const kicked = sub.agentRegistry.disconnectByTokenId(msg.tokenId);
            // Always log on receipt -- see orchestrator-core.ts for the
            // KICI_AGENT_AUTH=none rationale.
            logger.info('Kicked agent connections after cross-peer revoke', {
              tokenId: msg.tokenId,
              senderInstanceId: msg.senderInstanceId,
              kicked,
            });
          },
          onPeerConfigReload: async (msg) => {
            const reloader = sub.configReloader;
            if (!reloader) {
              return {
                success: false,
                errors: ['Config reloader not initialized on target peer'],
              };
            }
            return reloader.executeReload({ source: 'cluster', drain: msg.drain });
          },
          onLogsCollectRequest: (msg, send) => sub.fleetCollectResponder(msg, send),
          onAuthenticated: (targetInstanceId) => {
            if (initialKey === targetInstanceId) return;
            const existing = sub.peerClients.get(initialKey);
            if (existing === client) {
              sub.peerClients.delete(initialKey);
            }
            sub.peerClients.set(targetInstanceId, client);
          },
        });
        return client;
      };

      // Fleet read-relay (roster, host detail, runsOnAll preview). Each read
      // answers from the host roster store and writes a platform_proxy
      // access-log row, mirroring onDashboardDiagnostics.
      const buildFleetDeps = () => ({
        db: sub.db,
        rosterStore: sub.hostRosterStore!,
        rosterGraceMs: config.rosterGraceMs,
        resolveRunsOnAll: (workflowName: string) => resolveWorkflowRunsOnAll(sub.db, workflowName),
        registrationStore: sub.registrationStore,
      });
      const runFleetRead = async (
        requestId: string,
        actor: ActorPrincipal,
        targetId: string,
        run: () => Promise<{ type: string; requestId: string }>,
      ): Promise<void> => {
        try {
          const response = await run();
          void sub.accessLogWriter?.record({
            orgId: resolvedOrgContext?.orgId ?? null,
            routingKey: resolvedOrgContext?.routingKey ?? null,
            actor,
            action: 'fleet.read',
            target: { type: 'fleet', id: targetId },
            requestId,
            source: 'platform_proxy',
            outcome: 'allowed',
          });
          platformClient!.sendRaw(response);
        } catch (err) {
          void sub.accessLogWriter?.record({
            orgId: resolvedOrgContext?.orgId ?? null,
            routingKey: resolvedOrgContext?.routingKey ?? null,
            actor,
            action: 'fleet.read',
            target: { type: 'fleet', id: targetId },
            requestId,
            source: 'platform_proxy',
            outcome: 'error',
            errorMessage: toErrorMessage(err),
          });
          throw err;
        }
      };

      // Create PlatformClient
      const clusterName = await getClusterName(sub.db);
      const clusterId = await getClusterId(sub.db);
      platformClient = new PlatformClient({
        url: config.platformUrl!,
        token: config.platformToken!,
        providerSources,
        instanceId: config.instanceId,
        clusterName,
        clusterId,
        address: config.cluster.address ?? null,
        version: ORCHESTRATOR_VERSION,
        mode: config.mode,
        scalerBackends: sub.scalerManager
          ? sub.scalerManager.getStatus().backends.map((b) => b.type)
          : [],
        deployment: readDeploymentIdentity(),
        s3LogAccess: !!sub.cacheStorage,
        queueTimeoutMs: config.queueTimeoutMs,
        orchCapabilities: { orchRole: OrchRole.enum.coordinator },
        testMode: config.testMode,
        testOmitDashboardRequestTypes: config.testOmitDashboardRequestTypes,
        onAdmit: async (routingKey) => {
          // Webhook-ingest admission for the WS relay path. Non-queueing
          // (allowQueue:false) — Platform awaits this ack synchronously, so a
          // queued admission risks the 5s ack timeout + spurious pool failover;
          // shed instead and let the sender redeliver.
          const { key, orgCap } = await sub.ingestCapReader.resolve(routingKey);
          return sub.ingestController.admit(key, orgCap, { allowQueue: false });
        },
        onShedCapture:
          config.ingestOverflowEnabled && sub.ingestOverflowBuffer
            ? async (meta, body) => {
                await sub.ingestOverflowBuffer.capture(deliveryFromRelay(meta, body));
              }
            : undefined,
        onOrgIdentified: ({ orgId, clusterId: cid }) => {
          // Auto-provision the `remote_sources` anchor (`remote:<orgId>`) so a
          // Platform-relayed `kici run remote` resolves the real tenant through
          // the same local-source path a webhook takes. Idempotent upsert; safe
          // on every (re)connect.
          provisionRemoteSource(sub.db, { orgId, clusterId: cid }).catch((err) =>
            logger.error('Failed to provision remote_sources anchor', {
              orgId,
              error: toErrorMessage(err),
            }),
          );
        },
        onProvenanceIssuer: (issuer) => {
          // Learn the provenance trust root from the Platform so the
          // agent-handler can verify provenance bundles at ingest.
          sub.provenanceTrustRoot.setIssuer(issuer);
        },
        onTestRelay: async (msg) => {
          // Platform-relayed `kici run remote` control plane: route the parsed
          // `test.relay.*` request to its handler (reusing the test pipeline /
          // upload / cancel internals) and relay the response over the WS.
          try {
            const response = await dispatchTestRelay(msg, {
              // The full ProcessingDeps bag the webhook entry uses, so the test
              // dispatch path runs through the same shared core (needs-DAG, host
              // fan-out, deferred init/dynamic). coordinator is left in for
              // parity; in the single-orch test path it is simply unused.
              ...buildProcessingDeps(),
              db: sub.db,
              agentRegistry: sub.agentRegistry,
              cacheStorage: sub.cacheStorage,
              logWriter: sub.logWriter,
              accessLog: sub.accessLogWriter,
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
            });
            platformClient.sendRaw(response);
          } catch (err) {
            logger.error('Test-relay handler failed', {
              type: msg.type,
              requestId: msg.requestId,
              error: toErrorMessage(err),
            });
            platformClient.sendRaw({
              type: `${msg.type}.response`,
              requestId: msg.requestId,
              error: toErrorMessage(err),
            });
          }
        },
        onJoinRequest: (msg) => sub.joinHandler.handleJoinRequest(msg),
        onLogPullRequest: (msg) => logPullHandler.handleRequest(msg),
        onDashboardRunDetail: (msg) => dashboardHandler.handleRunDetail(msg),
        onDashboardRunStructured: (msg) => dashboardHandler.handleRunStructured(msg),
        onDashboardRunsList: async (msg) => {
          // The handler records its own access_log row internally and
          // returns the response envelope; relay it over the WS connection.
          const response = await dashboardHandler.handleRunsList(msg);
          platformClient.sendRaw(response);
        },
        onDashboardRunsFilters: async (msg) => {
          // The handler records its own access_log row internally and
          // returns the response envelope; relay it over the WS connection.
          const response = await dashboardHandler.handleRunsFilters(msg);
          platformClient.sendRaw(response);
        },
        onDashboardSourcesList: async (msg) => {
          const response = await dashboardHandler.handleSourcesList(msg);
          platformClient.sendRaw(response);
        },
        onDashboardStepLogs: (msg) => dashboardHandler.handleStepLogs(msg),
        onDashboardAttestationsList: (msg) => dashboardHandler.handleAttestationsList(msg),
        onDashboardAttestationsListAll: (msg) => dashboardHandler.handleAttestationsListAll(msg),
        onDashboardAttestationGet: (msg) => dashboardHandler.handleAttestationGet(msg),
        onDashboardAttestationRetry: (msg) => dashboardHandler.handleAttestationRetry(msg),
        onDashboardArtifactsList: (msg) => dashboardHandler.handleArtifactsList(msg),
        onRunRerun: (msg) => dashboardHandler.handleRerunRequest(msg),
        onManualSchedule: (msg) => dashboardHandler.handleManualScheduleRequest(msg),
        onRunCancel: (msg) => dashboardHandler.handleCancelRequest(msg),
        onDashboardPayload: (msg) => dashboardHandler.handlePayload(msg),
        onDashboardOrchLogs: (msg) => dashboardHandler.handleOrchLogs(msg),
        onDashboardDiagnostics: async (msg) => {
          const diagDeps = {
            agentRegistry: sub.agentRegistry,
            config,
            version: ORCHESTRATOR_VERSION,
            scalerBackends: sub.scalerManager
              ? sub.scalerManager.getStatus().backends.map((b) => b.type)
              : [],
            jobQueue: sub.queue,
            scalerManager: sub.scalerManager,
            scalerConfig: sub.scalerConfig,
            peerRegistry: sub.peerRegistry,
            raftNode: sub.raft,
          };
          try {
            const response = await handleDiagnosticsRequest(
              diagDeps,
              msg.requestId,
              msg.includeAgents,
            );
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'diagnostics.read',
              target: { type: 'diagnostics', id: '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'allowed',
            });
            platformClient.sendRaw(response);
          } catch (err) {
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'diagnostics.read',
              target: { type: 'diagnostics', id: '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'error',
              errorMessage: toErrorMessage(err),
            });
            throw err;
          }
        },
        onDashboardRunState: async (msg) => {
          // System reconciliation read for the Platform RunMirrorReconciler:
          // project the current run state and reply. Deliberately NOT
          // access-logged (a system read, not user data access).
          const response = await handleRunState({ db: sub.db }, msg);
          platformClient!.sendRaw(response);
        },
        onFleetHosts: async (msg) => {
          await runFleetRead(msg.requestId, msg.actor, 'hosts', () =>
            handleFleetHostsRequest(buildFleetDeps(), msg.requestId),
          );
        },
        onFleetHost: async (msg) => {
          await runFleetRead(msg.requestId, msg.actor, msg.agentId, () =>
            handleFleetHostRequest(buildFleetDeps(), msg.requestId, msg.agentId),
          );
        },
        onFleetPreview: async (msg) => {
          await runFleetRead(msg.requestId, msg.actor, msg.workflowName, () =>
            handleFleetPreviewRequest(buildFleetDeps(), msg.requestId, msg.workflowName),
          );
        },
        onFleetWorkflowsForHost: async (msg) => {
          await runFleetRead(msg.requestId, msg.actor, msg.agentId, () =>
            handleFleetWorkflowsForHostRequest(buildFleetDeps(), msg.requestId, msg.agentId),
          );
        },
        onDashboardScalerCapacity: (msg) => {
          try {
            const response = handleScalerCapacityRequest(sub.scalerManager ?? null, msg.requestId);
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'scaler.capacity.read',
              target: { type: 'scaler', id: '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'allowed',
            });
            platformClient.sendRaw(response);
          } catch (err) {
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'scaler.capacity.read',
              target: { type: 'scaler', id: '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'error',
              errorMessage: toErrorMessage(err),
            });
            throw err;
          }
        },
        onDashboardScalerAgents: (msg) => {
          const diagDeps = {
            agentRegistry: sub.agentRegistry,
            config,
            version: ORCHESTRATOR_VERSION,
            scalerBackends: sub.scalerManager
              ? sub.scalerManager.getStatus().backends.map((b) => b.type)
              : [],
            scalerManager: sub.scalerManager,
          };
          try {
            const response = handleScalerAgentsRequest(diagDeps, msg.requestId, msg.scalerName);
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'scaler.agents.read',
              target: { type: 'scaler', id: msg.scalerName ?? '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'allowed',
            });
            platformClient.sendRaw(response);
          } catch (err) {
            void sub.accessLogWriter?.record({
              orgId: resolvedOrgContext?.orgId ?? null,
              routingKey: resolvedOrgContext?.routingKey ?? null,
              actor: msg.actor,
              action: 'scaler.agents.read',
              target: { type: 'scaler', id: msg.scalerName ?? '_' },
              requestId: msg.requestId,
              source: 'platform_proxy',
              outcome: 'error',
              errorMessage: toErrorMessage(err),
            });
            throw err;
          }
        },
        onDashboardEnvMessage: async (msg) =>
          // The guard guarantees exactly one response frame per forwarded
          // request: a thrown handler or an unhandled type returns a fast
          // structured error instead of a silently dropped frame (which the
          // Platform would surface as a 10s 504 at its forward window).
          guardedDashboardDispatch(
            {
              sendRaw: (m) => platformClient.sendRaw(m),
              // The guard re-passes the same message object to dispatch; reuse
              // the outer `msg` (already typed DashboardPlatformToOrchMessage)
              // so the per-type branches keep full discriminated-union typing.
              dispatch: async () => {
                const dm = msg;
                if (
                  dm.type === 'dashboard.registrations.list' ||
                  dm.type === 'dashboard.registration.disable' ||
                  dm.type === 'dashboard.registration.delete'
                ) {
                  await dashboardRegistrationsHandler.handle(dm);
                  return true;
                }
                if (
                  dm.type === 'dashboard.backends.list' ||
                  dm.type === 'dashboard.backends.get' ||
                  dm.type === 'dashboard.backends.sync' ||
                  dm.type === 'dashboard.backends.sync.one' ||
                  dm.type === 'dashboard.backends.test'
                ) {
                  await dashboardBackendsHandler.handleMessage(dm);
                  return true;
                }
                if (
                  dm.type === 'dashboard.fleet.host.declare' ||
                  dm.type === 'dashboard.fleet.host.remove'
                ) {
                  await dashboardFleetWriteHandler.handleMessage(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-log.list') {
                  await dashboardHandler.handleEventLogList(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-log.activity') {
                  await dashboardHandler.handleEventLogActivity(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-log.detail') {
                  await dashboardHandler.handleEventLogDetail(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-log.payload.stream') {
                  await dashboardHandler.handleEventLogPayloadStream(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-dlq.list') {
                  await dashboardHandler.handleEventDlqList(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-dlq.count') {
                  await dashboardHandler.handleEventDlqCount(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-dlq.retry') {
                  await dashboardHandler.handleEventDlqRetry(dm);
                  return true;
                }
                if (dm.type === 'dashboard.event-dlq.discard') {
                  await dashboardHandler.handleEventDlqDiscard(dm);
                  return true;
                }
                if (dm.type === 'dashboard.access-log.list') {
                  await dashboardHandler.handleAccessLogList(dm);
                  return true;
                }
                if (isDashboardGlobalWorkflowsMessage(dm)) {
                  await dashboardGlobalWorkflowsHandler.handleMessage(dm);
                  return true;
                }
                // dashboardEnvHandler.handleMessage returns false for an
                // unrecognised type; propagate that so the guard answers it.
                return await dashboardEnvHandler.handleMessage(dm);
              },
            },
            msg as { type: string; requestId: string },
          ),
        onTrustPolicyUpdate: (msg) => {
          // Fire-and-forget with an error log: the callback is synchronous and
          // the in-memory identity state must still refresh even if the DB write
          // fails. A stale policy row beats dropping the identity-link refresh.
          void trustPolicyStore.upsertFromPlatform(msg.orgId, msg.policy).catch((err: unknown) =>
            logger.error('Failed to persist pushed trust policy', {
              orgId: msg.orgId,
              error: toErrorMessage(err),
            }),
          );
          identityLinks = msg.identityLinks;
          orgMemberPermissions = new Map(Object.entries(msg.memberCiTrustLevels));
          teamMemberships = new Map(
            (msg.teamMemberships ?? []).map((t) => [t.teamName, new Set(t.memberUserIds)]),
          );
          logger.info('Trust policy state updated', {
            orgId: msg.orgId,
            identityLinks: identityLinks.length,
            memberPermissions: orgMemberPermissions.size,
            teams: teamMemberships.size,
          });
        },
        onStaleCheckrunCleanup: (msg) => {
          for (const run of msg.runs) {
            const [owner, repo] = run.repoIdentifier.split('/');
            sub.checkRunReporter.cleanupStaleCheckRuns({
              provider: run.provider,
              routingKey: run.routingKey,
              owner,
              repo,
              sha: run.sha,
              workflowName: run.workflowName,
              // Present only for a cross-repository global run, and absent from
              // every run a Platform predating the field sends. Both cases name
              // the unqualified check — see `workflowLabel`.
              ...(run.workflowRepoIdentifier && {
                workflowRepoIdentifier: run.workflowRepoIdentifier,
              }),
              jobNames: run.jobNames,
            });
          }
        },
        onPeerDiscover: (peer) => {
          logger.info('Peer discovered', {
            connectionId: peer.connectionId,
            instanceId: peer.instanceId,
            address: peer.address,
            routingKeys: peer.routingKeys,
            orchRole: peer.orchRole,
          });

          // Skip workers — they're edge elements that dial OUT to every coord
          // (one PeerClient per coord) and do NOT host /ws/peer servers.
          // Treat undefined orchRole as coordinator for back-compat with peers
          // that don't yet advertise the field.
          if (peer.orchRole === 'worker') {
            return;
          }

          if (peer.address && peer.instanceId) {
            if (peer.instanceId === config.instanceId) return;

            // If a PeerClient already exists for this peer (e.g. from a previous
            // connection), close it and create a fresh one. This resets the
            // exponential backoff so the reconnect happens immediately instead
            // of waiting up to 60s for the old backoff timer to expire.
            const existingClient = sub.peerClients.get(peer.instanceId);
            if (existingClient) {
              existingClient.disconnect();
              sub.peerClients.delete(peer.instanceId);
            }

            const client = createOutboundPeerClient(peer.address, peer.instanceId);
            sub.peerClients.set(peer.instanceId, client);
            client.connect();

            logger.info('PeerClient created for discovered peer', {
              peerId: peer.instanceId,
              address: peer.address,
            });
          }
        },
        onAuthenticated: async () => {
          // Post-cutover: customer HMAC secrets never leave the orchestrator.
          // The previous bulk `sendSourceSecrets()` push has been removed --
          // Platform asks the orchestrator to verify each inbound webhook on
          // demand via the chunked relay protocol instead.

          // Resolve orgId + routing key for dashboard handlers. Prefer the
          // `sources` table (GitHub App orchestrators); fall back to
          // `generic_webhook_sources` so orchestrators that run only with
          // generic / internal webhooks still scope their dashboard queries
          // to the real tenant org instead of '__default__'. Both tables hold
          // the same (customer_id, routing_key) shape for a single tenant.
          try {
            let resolved: { customer_id: string; routing_key: string } | undefined;
            const ghSource = await sub.db
              .selectFrom('sources')
              .select(['customer_id', 'routing_key'])
              .where('customer_id', '!=', '__default__')
              .limit(1)
              .executeTakeFirst();
            if (ghSource?.customer_id) {
              resolved = {
                customer_id: ghSource.customer_id,
                routing_key: ghSource.routing_key,
              };
            } else {
              const genericSource = await sub.db
                .selectFrom('generic_webhook_sources')
                .select(['customer_id', 'routing_key'])
                .where('deleted_at', 'is', null)
                .limit(1)
                .executeTakeFirst();
              if (genericSource?.customer_id) {
                resolved = {
                  customer_id: genericSource.customer_id,
                  routing_key: genericSource.routing_key,
                };
              } else {
                // Sourceless Platform-first org: no webhook source exists, only
                // the auto-provisioned `remote_sources` anchor maps the
                // `remote:<orgId>` routing key to the canonical org. Scope the
                // dashboard handlers (environments, secrets, registrations, …)
                // to that real tenant so reads like `kici secrets list` /
                // `kici types` see the org's data instead of '__default__'.
                const remoteSource = await sub.db
                  .selectFrom('remote_sources')
                  .select(['customer_id', 'routing_key'])
                  .where('customer_id', '!=', '__default__')
                  .limit(1)
                  .executeTakeFirst();
                if (remoteSource?.customer_id) {
                  resolved = {
                    customer_id: remoteSource.customer_id,
                    routing_key: remoteSource.routing_key,
                  };
                }
              }
            }
            if (resolved) {
              dashboardEnvHandler.setOrgId(resolved.customer_id);
              dashboardEnvHandler.setRoutingKey(resolved.routing_key);
              dashboardRegistrationsHandler.setOrgId(resolved.customer_id);
              dashboardRegistrationsHandler.setRoutingKey(resolved.routing_key);
              // Global-workflows is org-scoped: only customer_id matters.
              dashboardGlobalWorkflowsHandler.setOrgId(resolved.customer_id);
              dashboardBackendsHandler.setOrgContext(resolved.customer_id, resolved.routing_key);
              dashboardFleetWriteHandler.setOrgContext(resolved.customer_id, resolved.routing_key);
              dashboardHandler.setOrgContext(resolved.customer_id, resolved.routing_key);
              resolvedOrgContext = {
                orgId: resolved.customer_id,
                routingKey: resolved.routing_key,
              };
              logger.info('Dashboard handler orgId resolved', {
                orgId: resolved.customer_id,
                routingKey: resolved.routing_key,
              });
            }
          } catch (err) {
            logger.warn('Failed to resolve orgId for dashboard handlers', {
              error: toErrorMessage(err),
            });
          }

          // Broadcast the orchestrator's current dashboard-write policy so
          // Platform's per-org capability cache is populated immediately
          // and on every reconnect. The first call also installs the
          // change-event subscriber, which keeps Platform's cache in sync
          // when an operator flips a switch via `kici-admin`.
          if (resolvedOrgContext) {
            const customerId = resolvedOrgContext.orgId;
            try {
              const policy = await getDashboardWritePolicy(sub.db, customerId);
              platformClient.broadcastCapabilities({ dashboardWrites: policy });
            } catch (err) {
              logger.warn('Failed to broadcast initial dashboard-write policy', {
                customerId,
                error: toErrorMessage(err),
              });
            }
            if (!policyChangeSubscriber) {
              policyChangeSubscriber = (evt) => {
                if (evt.customerId !== customerId) return;
                platformClient.broadcastCapabilities({ dashboardWrites: evt.policy });
              };
              dashboardWritePolicyEvents.on('changed', policyChangeSubscriber);
            }
          }

          // Broadcast the browser-sealed-write trust anchors. Both are
          // cluster-global (one orchestrator identity, one `.well-known`), so
          // this is outside the per-org block above. The public encryption key
          // is what feeds the Convenient tier — the dashboard reads it back
          // from the control plane when no verified issuer is configured; the
          // verified issuer, when set, tells the dashboard to fetch the key
          // straight from the customer's own origin instead.
          void (async () => {
            let lastVerifiedIssuer: string | null = null;
            const resolveKey = async () =>
              dashboardEncryptionJwkSchema.safeParse(
                (await sub.dashboardEncryption?.resolve())?.publicJwk,
              );
            const broadcast = async (key: { success: boolean; data?: unknown }) => {
              // An unreadable knob OMITS the field: broadcastCapabilities merges,
              // so the last known issuer survives a DB blip during a reconnect
              // instead of being cleared back to the Convenient tier.
              // `lastVerifiedIssuer` only advances on a real read, so an
              // unreadable first read seeds the poller with null — which is
              // exactly what the control plane sees at that point (this process
              // has advertised no issuer yet), so the first readable tick still
              // reports a configured issuer as a change and the tier heals
              // within one poll interval. Holding cannot cover that window: a
              // freshly started process has no last known issuer to hold, so a
              // cold boot whose first read fails leaves the dashboard on the
              // Convenient tier until that first readable tick.
              const read = await tryResolveVerifiedIssuer(sub.clusterSettings);
              if (read.ok) lastVerifiedIssuer = read.issuer;
              platformClient.broadcastCapabilities({
                ...(key.success
                  ? { dashboardEncryptionKey: key.data as DashboardEncryptionJwk }
                  : {}),
                ...verifiedIssuerCapabilityUpdate(read),
              });
            };
            try {
              let key = await resolveKey();
              await broadcast(key);
              if (!stopVerifiedIssuerPoller) {
                stopVerifiedIssuerPoller = startVerifiedIssuerPoller({
                  reader: sub.clusterSettings,
                  initial: lastVerifiedIssuer,
                  // The WS heartbeat cadence: fast enough that an operator's
                  // change lands in seconds, cheap enough to run forever.
                  intervalMs: 30_000,
                  onChange: (issuer) => {
                    platformClient.broadcastCapabilities({ dashboardVerifiedIssuer: issuer });
                  },
                });
              }
              // Key generation is leader-gated, so on a cold boot it can land
              // AFTER this connection is already up. Re-broadcast once it does:
              // the upstream capability cache is otherwise only refreshed on the
              // next reconnect, which would leave every `encrypted`-posture
              // dashboard write fail-closed in the meantime.
              for (
                let attempt = 0;
                !key.success && sub.dashboardEncryption && attempt < 120;
                attempt++
              ) {
                await new Promise((res) => setTimeout(res, 500));
                key = await resolveKey();
                if (key.success) await broadcast(key);
              }
            } catch (err) {
              logger.warn('Failed to broadcast dashboard encryption capabilities', {
                error: toErrorMessage(err),
              });
            }
          })();

          // Send state replay so Platform can reconcile execution_runs and execution_jobs.
          // The DB-backed variant adds terminal runs that completed before an orchestrator
          // crash/restart and so are no longer in memory — without this, Platform's
          // mirror table (and the kici_org_executions_count operator-aggregate gauge)
          // permanently undercounts after a crash. Bounded window (env override)
          // keeps the payload size reasonable after long downtime.
          const replayWindowHours = config.reconnectReplayWindowHours;
          try {
            const replayData = await sub.executionTracker.getReplayDataWithDb(replayWindowHours);
            if (replayData.length > 0) {
              // Chunked, validated and paced by the client: the wire schema caps
              // a frame at 500 runs, and an oversized frame is rejected with a
              // 4003 close that reconnecting cannot clear.
              await platformClient.sendStateReplay(replayData);
            }
          } catch (err) {
            logger.warn('Failed to send state replay to Platform', {
              error: toErrorMessage(err),
            });
          }

          // Platform is back: drain any deferred attestations now (leader-gated
          // inside the retrier) rather than waiting for the next timer tick.
          attestationRetrier?.triggerNow();
        },
        onVerifyInbound: async (meta, body) => {
          if (!relayEnabled) return observedRelayVerify();
          if (!sub.pgSecretStore) {
            return {
              result: 'rejected_misconfigured',
              reason: 'orchestrator has no PgSecretStore configured',
            };
          }
          return verifyInboundWebhook(
            {
              db: sub.db,
              secretStore: sub.pgSecretStore,
              genericSourceManager: sub.genericSourceManager,
            },
            {
              routingKey: meta.routingKey,
              body,
              headers: meta.headers,
              signatureHeaderName: meta.signatureHeaderName ?? null,
              signatureHeader: meta.signatureHeader ?? null,
              clientIp: meta.clientIp ?? null,
            },
          );
        },
        onWebhookRelay: async (relay) => {
          if (!relayEnabled) return observedRelayReject(logger, relay);
          const payload = relay.payload as Record<string, unknown>;
          const routingKey = relay.routingKey;
          // Look up the bundle FIRST; its normalizer.provider is authoritative.
          // Falls back to the routing-key prefix ONLY when the bundle has not
          // been registered yet (e.g. a direct-mode github app whose bundle is
          // created lazily). New code paths (local sources, generic sources)
          // MUST be bundle-resolved — the legacy prefix cast is retained only
          // as a last resort for already-working providers.
          const relayBundle = sub.providerRegistry.getByRoutingKey(routingKey);
          const provider =
            (relayBundle?.normalizer.provider as
              'github' | 'gitlab' | 'bitbucket' | 'generic' | 'local' | undefined) ??
            (routingKey.split(':')[0] as 'github' | 'gitlab' | 'bitbucket');
          const action = relay.action ?? null;

          const info = {
            routingKey,
            deliveryId: relay.deliveryId,
            event: relay.event,
            action,
            provider,
            payload,
          };

          try {
            await processWebhook(info, {
              ...buildProcessingDeps(),
              eventLogSource: 'relay',
            });
          } catch (err) {
            // Record `failed` before rethrowing so the dashboard sees the
            // delivery (and the operator can see WHY processing died).
            // Best-effort org resolve — same default as processWebhook.
            try {
              await eventLogWriter.record(info, payloadFromObject(info.payload), {
                orgId: '__default__',
                source: 'relay',
                status: 'failed',
                errorMessage: toErrorMessage(err),
              });
            } catch (recordErr) {
              logger.warn('Failed to record failed event-log row for relay path', {
                deliveryId: info.deliveryId,
                error: toErrorMessage(recordErr),
              });
            }
            throw err;
          }
        },
      });

      // Relay-origin overflow replay: re-verify each captured raw body against
      // its stored headers, then re-inject through the admission-gated relay
      // pipeline. Wired only when the overflow buffer + a secret store exist
      // (verify needs the secret store); otherwise relay rows are not replayable
      // and the replayer reverts them (a no-op fallback).
      if (relayEnabled && config.ingestOverflowEnabled && sub.pgSecretStore) {
        const secretStore = sub.pgSecretStore;
        sub.ingestOverflowReplayer.setReinjectRelay(
          buildRelayReinject({
            admit: async (routingKey) => {
              const { key, orgCap } = await sub.ingestCapReader.resolve(routingKey);
              return sub.ingestController.admit(key, orgCap, { allowQueue: false });
            },
            verify: (d, body) =>
              verifyInboundWebhook(
                { db: sub.db, secretStore, genericSourceManager: sub.genericSourceManager },
                {
                  routingKey: d.routingKey,
                  body,
                  headers: d.meta.headers,
                  signatureHeaderName: d.meta.signatureHeaderName,
                  signatureHeader: d.meta.signatureHeader,
                  clientIp: d.meta.clientIp,
                },
              ),
            resolveProvider: (routingKey) => {
              const bundle = sub.providerRegistry.getByRoutingKey(routingKey);
              return bundle?.normalizer.provider ?? routingKey.split(':')[0]!;
            },
            process: (info) =>
              processWebhook(info, { ...buildProcessingDeps(), eventLogSource: 'relay' }),
          }),
        );
      }

      // Late-bind the public-alias resolver on the check-run emitter.
      // The reporter was constructed in orchestrator-core (before
      // PlatformClient existed); the resolver pulls the alias that
      // Platform supplies on `auth.success`, so `details_url` on each
      // outbound check run points at the dashboard's alias resolver
      // route instead of leaking the canonical `org_<12-char>` id.
      sub.checkRunReporter.setOrgPublicAliasResolver(() => platformClient.getOrgPublicAlias());

      // Bind LogPullHandler send to platformClient.sendRaw
      logPullSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardHandler send to platformClient.sendRaw
      dashboardSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardContextHandler send to platformClient.sendRaw
      dashboardEnvSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardRegistrationsHandler send to platformClient.sendRaw
      dashboardRegSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardBackendsHandler send to platformClient.sendRaw
      dashboardBackendsSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardFleetWriteHandler send to platformClient.sendRaw
      dashboardFleetWriteSendFn = (msg) => platformClient.sendRaw(msg);

      // Bind DashboardGlobalWorkflowsHandler send to platformClient.sendRaw
      dashboardGlobalWorkflowsSendFn = (msg) => platformClient.sendRaw(msg);

      // Live source propagation: when a source is added/removed on this running
      // orchestrator — GitHub-app sources via SourceManager, generic sources
      // via the change listener — re-push the FULL source list to the Platform
      // so its webhook_sources (and therefore the dashboard + webhook routing)
      // reflect the change immediately, instead of only at the next boot
      // registration. Rebuilding the full set keeps updateSources' diff correct
      // (a partial list would deregister the untouched sources).
      const republishSources = () => {
        void buildPlatformProviderSources(sub.sourceManager, loadGenericRows)
          .then((sources) => platformClient.updateSources(sources))
          .catch((err) =>
            logger.warn('Failed to republish sources to Platform', {
              error: toErrorMessage(err),
            }),
          );
      };
      sub.sourceManager.setOnSourcesChanged(() => republishSources());
      sub.genericSourcesChangeListener.setOnChange(() => republishSources());

      // Start periodic metrics push to Platform (30s interval). The
      // reporter concatenates the agent metrics aggregator's snapshot
      // onto its own OTel snapshot before sending so `kici_agent_*`
      // metrics land in Mimir per-org alongside `kici_orch_*`. The
      // aggregator is built once in orchestrator-core (subsystems) and
      // shared with the HTTP /metrics scrape path via createApp deps.
      const metricsReporter = new MetricsReporter({
        // Feature-gated: the periodic telemetry push rides the Platform→orchestrator
        // capability pre-flight (`orchMetrics`). Backward-safe — a Platform that
        // never advertises capabilities is treated as "supports it" and metrics
        // still flow; only an advertised set that explicitly drops `orchMetrics`
        // suppresses the push with a diagnosable capability-gap warning.
        send: (msg) => platformClient.sendIfPlatformSupports('orchMetrics', msg),
        intervalMs: 30_000,
        agentMetricsAggregator: sub.agentMetricsAggregator,
      });
      metricsReporter.start();

      // Deferred-attestation retrier. Leader-gated inside each tick, so it is
      // safe to start on every coordinator; only the Raft leader mints, and the
      // `attestations` unique index makes fulfilment idempotent cluster-wide.
      const pendingAttestationsRepo = new PendingAttestationsRepo(sub.db);
      const instanceId = config.instanceId;
      attestationRetrier = new AttestationRetrier({
        repo: pendingAttestationsRepo,
        orchestratorId: instanceId,
        intervalMs: 60_000,
        isLeader: () => sub.raft.isLeader(),
        provenanceStorageKey,
        requestMint: async (a) => {
          // Test-only fault injection: force a TERMINAL rejection for the reject
          // marker audience so an E2E can exercise the markRejected → gauge-
          // exclusion → `--include-rejected` re-arm cycle with a REAL deferred
          // row. Double-gated (testMode AND the marker audience) so production —
          // which leaves both unset — never reaches it. Permanent for that
          // audience: `--include-rejected` re-arms then re-rejects.
          if (
            config.testMode &&
            config.testMintRejectAudience &&
            a.audience === config.testMintRejectAudience
          ) {
            return {
              rejected: true,
              reason: 'test-only mint-reject fault-injection (KICI_TEST_MINT_REJECT_AUDIENCE)',
            };
          }
          try {
            return await requestMint({
              platformClient,
              orchestratorId: a.orchestratorId,
              runId: a.runId,
              jobId: a.jobId,
              audience: a.audience,
              deferred: a.deferred,
            });
          } catch (err) {
            // A transient mint failure DEFERS (retried later). A definitive
            // Platform rejection (run/job absent) is terminal — surfaced so the
            // retrier stamps rejected_at and stops re-attempting it.
            if (err instanceof MintUnavailableError) return { deferred: true, code: 'unavailable' };
            if (err instanceof MintRelayError) return { deferred: true, code: 'failed' };
            if (err instanceof MintRejectedError) return { rejected: true, reason: err.message };
            throw err;
          }
        },
        uploadBundle: async ({ bundle, storageKey }) => {
          if (!sub.cacheStorage) throw new Error('provenance storage unavailable');
          await sub.cacheStorage.put(storageKey, JSON.stringify(bundle));
          await sub.cacheStorage.initMeta(storageKey);
        },
        computeVerdict: async (storageKey) => {
          const v = await computeAttestationVerdict({
            trustRoot: sub.provenanceTrustRoot,
            storage: sub.cacheStorage,
            storageKey,
          });
          return {
            verifyStatus: v.verifyStatus,
            verifyReason: v.verifyReason,
            verifiedAt: v.verifiedAt,
          };
        },
        recordAttestation: async (r) => {
          // Idempotent across the cluster via the uq_attestations_run_job_subject
          // unique index (migration 065).
          await sub.db
            .insertInto('attestations')
            .values({
              id: crypto.randomUUID(),
              run_id: r.runId,
              job_id: r.jobId,
              subject_name: r.subjectName,
              subject_digest: r.subjectDigest,
              storage_key: r.storageKey,
              mode: 'kici',
              media_type: r.mediaType,
              verify_status: r.verifyStatus,
              verify_reason: r.verifyReason,
              verified_at: r.verifiedAt,
            })
            .onConflict((oc) => oc.columns(['run_id', 'job_id', 'subject_digest']).doNothing())
            .execute();
        },
        backfillRun: (runId) =>
          backfillRunToPlatform(
            {
              send: (m) => platformClient.send(m),
              loadRun: async (rid) => {
                const row = await sub.db
                  .selectFrom('execution_runs')
                  .select([
                    'run_id',
                    'workflow_name',
                    'status',
                    'routing_key',
                    'repo_identifier',
                    'workflow_repo_identifier',
                    'provider',
                    'local_working_tree',
                    'sha',
                    'ref',
                    'started_at',
                    'completed_at',
                    'duration_ms',
                  ])
                  .where('run_id', '=', rid)
                  .executeTakeFirst();
                return row
                  ? {
                      run_id: row.run_id,
                      workflow_name: row.workflow_name,
                      status: row.status,
                      routing_key: row.routing_key,
                      repo_identifier: row.repo_identifier,
                      workflow_repo_identifier: row.workflow_repo_identifier,
                      provider: row.provider,
                      local_working_tree: row.local_working_tree,
                      sha: row.sha,
                      ref: row.ref,
                      job_count: null,
                      started_at: row.started_at,
                      completed_at: row.completed_at,
                      duration_ms: row.duration_ms,
                    }
                  : null;
              },
              loadJobs: async (rid) => {
                const rows = await sub.db
                  .selectFrom('execution_jobs')
                  .select([
                    'run_id',
                    'job_id',
                    'job_name',
                    'status',
                    'agent_id',
                    'started_at',
                    'completed_at',
                  ])
                  .where('run_id', '=', rid)
                  .execute();
                return rows.map((j) => ({
                  run_id: j.run_id,
                  job_id: j.job_id,
                  job_name: j.job_name,
                  status: j.status,
                  started_at: j.started_at,
                  completed_at: j.completed_at,
                  agent_id: j.agent_id,
                  orchestrator_id: instanceId,
                }));
              },
            },
            runId,
          ),
        setMetrics: (count, oldest, rejected) => {
          setPendingAttestations(count);
          setPendingAttestationOldestAgeSeconds(
            oldest ? (Date.now() - oldest.getTime()) / 1000 : 0,
          );
          setRejectedAttestations(rejected);
        },
      });
      attestationRetrier.start();

      // Static peer dial: when KICI_CLUSTER_PEERS is configured, dial each
      // listed peer directly so coord-to-coord WS mesh forms without waiting
      // on Platform-mediated discovery. Workers already use coordinatorUrls
      // for the same purpose; this gives coordinators an equivalent path so
      // every coord pair connects regardless of Platform announcement state.
      for (const rawUrl of config.cluster.peers) {
        if (isSelfPeerUrl(rawUrl, config.cluster.address, config.port)) {
          logger.info('Skipping self in static peer list', { rawUrl });
          continue;
        }
        const client = createOutboundPeerClient(rawUrl, rawUrl);
        sub.peerClients.set(rawUrl, client);
        client.connect();
        logger.info('Static peer client dialing', { rawUrl });
      }

      // Resolve a newly added source's public webhook URL for the CLI. GitHub-App
      // ingress is Platform-relayed, so we register the source and read the URL
      // the Platform computed back on the ack. The full-source push also doubles
      // as the live propagation for this add (the NOTIFY-driven republish then
      // diffs to a no-op).
      const resolveSourceWebhookUrl = async (params: {
        routingKey: string;
        provider: string;
        sourceId: string;
      }): Promise<{ webhookUrl: string | null; webhookNote?: string }> => {
        if (params.provider !== 'github') {
          return { webhookUrl: null, webhookNote: 'unsupported-provider' };
        }
        try {
          const fullSources = await buildPlatformProviderSources(
            sub.sourceManager,
            loadGenericRows,
          );
          const webhookUrl = await platformClient.registerSourceAndAwait(
            fullSources,
            params.routingKey,
          );
          if (webhookUrl) {
            return { webhookUrl };
          }
          // Platform relayed no public URL — fall back to this orchestrator's
          // own direct GitHub ingress if a public base is configured.
          const local = buildLocalGithubIngressUrl(
            config.webhookPublicUrl,
            resolvedOrgContext?.orgId ?? '__default__',
            params.sourceId,
          );
          return local
            ? { webhookUrl: local }
            : { webhookUrl: null, webhookNote: 'platform-no-public-url' };
        } catch (err) {
          logger.warn('Failed to resolve GitHub webhook URL from Platform', {
            routingKey: params.routingKey,
            error: toErrorMessage(err),
          });
          return { webhookUrl: null, webhookNote: 'platform-unavailable' };
        }
      };

      // Resolve the org-scoped GitHub webhook URL for the manifest setup
      // pre-flight. The URL is org-scoped (not app-scoped), so it can be
      // computed before any App exists. The org id comes from the
      // Platform-identified `remote_sources` anchor; the public base from
      // `config.webhookPublicUrl`. Returns null + a note when either is
      // missing so the CLI can surface an honest "not yet available" message.
      const resolveGithubWebhookUrl = async (): Promise<{
        webhookUrl: string | null;
        webhookNote?: string;
      }> => {
        const orgId = resolvedOrgContext?.orgId;
        if (!orgId) {
          return { webhookUrl: null, webhookNote: 'org-not-identified' };
        }
        if (!config.webhookPublicUrl) {
          return { webhookUrl: null, webhookNote: 'platform-no-public-url' };
        }
        const base = config.webhookPublicUrl.replace(/\/$/, '');
        return { webhookUrl: `${base}${githubWebhookPath(orgId)}` };
      };

      return {
        appDepsExtras: {
          platformClient,
          retryAttestations: (opts: { runId?: string; includeRejected?: boolean }) =>
            attestationRetrier
              ? attestationRetrier.runOnce(opts)
              : Promise.resolve({ minted: 0, stillPending: 0, rejected: 0 }),
          contextStore,
          variableStore,
          heldRunStore,
          stepApprovalBridge,
          globalWorkflowPolicy,
          contributorCache,
          resolveSourceWebhookUrl,
          resolveGithubWebhookUrl,
          // Resume a workflow whose install-gate wait-timer / concurrency hold
          // released (same path as a reviewer approval).
          onWorkflowRelease: (signal: ReleaseSignal) =>
            resumeWorkflow(signal, buildProcessingDeps(), sub.db),
          // eventLogWriter is provided by orchestrator-core directly to createApp.
        },

        configReloaderExtras: {
          onProviderChange: async (_newConfig: any, _oldConfig: any, s: any) => {
            // Providers are DB-managed via SourceManager -- reload from DB
            await s.sourceManager.reload();
            const newRegistry = s.sourceManager.getRegistry();

            s.providerRegistry = newRegistry;
            s.checkRunReporter.updateRegistry(newRegistry);

            logger.info('Provider registry reloaded from sources', {
              routingKeys: newRegistry.getRoutingKeys(),
            });
          },
          onPlatformReconnect: async (newConfig: any) => {
            logger.info('Platform connection settings changed, reconnect needed', {
              platformUrl: newConfig.platformUrl,
            });
          },
        },

        shutdownExtras: [
          {
            label: 'Stopping metrics reporter',
            fn: () => {
              metricsReporter.stop();
            },
          },
          {
            label: 'Stopping attestation retrier',
            fn: () => {
              attestationRetrier?.stop();
            },
          },
          {
            label: 'Stopping verified-issuer poller',
            fn: () => {
              stopVerifiedIssuerPoller?.();
            },
          },
          {
            label: 'Disconnecting Platform client',
            fn: () => {
              platformClient.disconnect();
            },
          },
        ],

        onServerStarted: async () => {
          platformClient.connect();
        },
      };
    },

    startupLogMessage: (port) => `Orchestrator started on port ${port}`,
  };

  await bootstrapOrchestrator(config, hooks, { otelSdk });
});
