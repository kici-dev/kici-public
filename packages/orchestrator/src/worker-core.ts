/**
 * Worker mode bootstrap for the orchestrator.
 *
 * Workers are orchestrators in 'worker' mode. They connect to a coordinator
 * via PeerClient, receive rerouted jobs, dispatch them to local agents,
 * and report progress back to the coordinator.
 *
 * Workers do NOT have:
 * - Database access (no PG, no Kysely, no migrations)
 * - Platform relay connection
 * - Raft consensus
 * - Secrets management (secrets arrive pre-resolved in job.reroute)
 * - Webhook handling, dedup, event routing, trust store
 * - Registration/source management
 * - Cache infra (bundle/dep cache, build coordinator)
 * - Concurrency tracking, ownership tracking
 * - Config reloader
 *
 * Workers DO have:
 * - ScalerManager (local scaler backends)
 * - AgentRegistry (in-memory agent tracking)
 * - Dispatcher (local agent dispatch)
 * - PeerClient (coordinator connection)
 * - PeerRegistry (coordinator tracking)
 * - InMemoryExecutionTracker (local state with forwarding)
 * - InMemoryJobQueue (no-op queue)
 * - StaticAgentTokenStore (in-memory tokens)
 * - StepLogBuffer (log chunk buffering)
 * - ObserverRegistry (CLI observer support)
 * - HTTP server with /health and agent WS endpoint
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  hostname as osHostname,
  release,
  totalmem,
  freemem,
  cpus,
  uptime,
  userInfo,
} from 'node:os';
import { createLogger, setupGracefulShutdown, toErrorMessage } from '@kici-dev/shared';
import { createHealthRoutes as createBaseHealthRoutes } from '@kici-dev/shared';
import type { AppConfig } from './config.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// SDK drift diagnostic is visible on worker startup too — workers accept
// dispatched jobs and would hit the same lock-file drift class.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_COMMIT: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;
const ORCHESTRATOR_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.1';
const WORKER_BUILD_COMMIT =
  typeof KICI_BUILD_COMMIT !== 'undefined' ? KICI_BUILD_COMMIT : 'unknown';
const WORKER_SDK_VERSION = typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown';
const WORKER_SDK_BUNDLE_HASH =
  typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown';
const WORKER_SHARED_VERSION =
  typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : 'unknown';
const WORKER_SHARED_BUNDLE_HASH =
  typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : 'unknown';
const WORKER_ENGINE_VERSION =
  typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : 'unknown';
const WORKER_ENGINE_BUNDLE_HASH =
  typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : 'unknown';
import { AgentRegistry } from './agent/registry.js';
import { Dispatcher } from './agent/dispatcher.js';
import { PeerClient, PeerRegistry, PeerAuthCoordinator } from './cluster/index.js';
import { TERMINAL_JOB_STATES, WS_CLOSE_DISPATCH_ACK_TIMEOUT } from '@kici-dev/engine';
import { InMemoryExecutionTracker } from './worker/in-memory-execution-tracker.js';
import { InMemoryJobQueue } from './worker/in-memory-job-queue.js';
import { StaticAgentTokenStore } from './worker/static-agent-token-store.js';
import { StepLogBuffer } from './reporting/step-log-buffer.js';
import { ObserverRegistry } from './ws/observer-registry.js';
import {
  ScalerManager,
  ContainerScalerBackend,
  BareMetalScalerBackend,
  FirecrackerScalerBackend,
  InMemoryIpAllocator,
  loadScalerConfig,
  detectLabelSetOverlaps,
} from './scaler/index.js';
import type { ScalerBackend, ScalerConfig, ScalerEvent } from './scaler/index.js';
import { runDiskGuard } from './scaler/disk-guard.js';
import { createAgentWsHandler } from './ws/agent-handler.js';
import { FleetAgentCollector } from './ws/fleet-agent-collector.js';
import { FLEET_NODE_TIMEOUT_MS } from './diagnostics/fleet-constants.js';
import { makeFleetCollectResponder, type FleetRuntime } from './diagnostics/fleet-wiring.js';
import { createWorkerStatusHandler, createWorkerDrainHandler } from './worker/worker-status.js';
import { AgentHeartbeatMonitor } from './ws/agent-heartbeat.js';
import { resolveDataDir } from './data-dir.js';
import { PeerOutbox } from './worker/peer-outbox.js';
import { buildTerminalJobProgress, replayPending } from './worker/worker-outbox-relay.js';
import { join } from 'node:path';
import type { PeerJobCancel, JobReroute, JobProgress } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'worker' });
const DRAIN_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Subsystems available in worker mode.
 * Subset of OrchestratorSubsystems with in-memory replacements.
 */
interface WorkerSubsystems {
  config: AppConfig;
  agentRegistry: AgentRegistry;
  dispatcher: Dispatcher;
  peerRegistry: PeerRegistry;
  /** Outbound PeerClients keyed by coord URL. Workers fan out so every coord can dispatch directly. */
  peerClients: Map<string, PeerClient>;
  /** Convenience: first PeerClient (deterministic insertion order) for legacy single-client APIs. */
  peerClient: PeerClient;
  executionTracker: InMemoryExecutionTracker;
  jobQueue: InMemoryJobQueue;
  tokenStore: StaticAgentTokenStore;
  stepLogBuffer: StepLogBuffer;
  observerRegistry: ObserverRegistry;
  scalerManager: ScalerManager | null;
  scalerConfig: ScalerConfig | null;
}

/**
 * Initialize scaler backends for worker mode.
 *
 * Similar to the coordinator's initializeScaler but uses the in-memory
 * token store and an in-memory `IpAllocator` for Firecracker backends
 * (workers have no cluster DB; per-orch IP state is by design — each
 * orch owns its own bridge subnet).
 */
async function initializeWorkerScaler(
  config: AppConfig,
  tokenStore: StaticAgentTokenStore,
  onScalerEvent: (runId: string, jobId: string, event: ScalerEvent) => void,
): Promise<{ manager: ScalerManager; config: ScalerConfig } | null> {
  if (!config.scalerConfigPath) return null;

  const scalerConfig = await loadScalerConfig(config.scalerConfigPath, config.scalerConfigDir);

  // Disk-space guard: free leaked FC chroots before any heavy startup write so
  // a 100%-full data disk self-heals instead of crash-looping on ENOSPC.
  const guard = await runDiskGuard({ scalerConfig });
  if (!guard.recovered) {
    logger.error(
      `Data disk below free-space threshold and orphan reap did not free enough; ` +
        `run 'kici-admin scaler reap-orphans' on this host. Free bytes: ${guard.freeBytesAfter}`,
    );
    process.exit(1);
  }

  const overlaps = detectLabelSetOverlaps(scalerConfig.scalers);
  if (overlaps.length > 0) {
    logger.error('Scaler config has label-set overlaps', { overlaps });
    process.exit(1);
  }

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
            tokenStore: config.agentAuth === 'token' ? (tokenStore as any) : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
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
            tokenStore: config.agentAuth === 'token' ? (tokenStore as any) : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
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
        const ipAllocator = new InMemoryIpAllocator({ cidr, gateway, netmask });
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
            tokenStore: config.agentAuth === 'token' ? (tokenStore as any) : undefined,
            tokenTtlMs: config.agentTokenTtlMs,
            roles: s.roles,
            requireSudo: s.requireSudo,
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

  if (backends.length === 0) {
    logger.warn('No scaler backends available in worker mode');
    return null;
  }

  const scalerManager = new ScalerManager({
    config: scalerConfig,
    backends,
    machineLedger: {
      dir: config.machineLedgerDir,
      instanceId: config.cluster.instanceId,
    },
    onScalerEvent,
  });

  // Run orphan cleanup for container backends
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
    }
  }

  scalerManager.start();
  logger.info('Worker scaler initialized', {
    backends: backends.map((b) => b.name),
    globalMaxAgents: scalerConfig.globalMaxAgents,
  });

  return { manager: scalerManager, config: scalerConfig };
}

/**
 * Build the onDispatch callback for worker mode.
 *
 * Workers do NOT re-query DB for provider context. The cloneToken and
 * providerContext are already included in the job.reroute message and
 * embedded in the job's jobConfig.
 */
function buildWorkerOnDispatch(agentRegistry: AgentRegistry) {
  return async (agentId: string, job: any) => {
    const entry = agentRegistry.get(agentId);
    if (!entry) return;

    // In worker mode, the job config already contains everything needed:
    // cloneToken, secrets (pre-resolved), provider context, etc.
    // No DB lookup needed -- just forward to the agent.
    const dispatchSecrets = job.jobConfig.secrets as Record<string, string> | undefined;
    const dispatchNamespacedSecrets = job.jobConfig.namespacedSecrets as
      | Record<string, Record<string, string>>
      | undefined;
    const dispatchRunPublicKey = job.jobConfig.runPublicKey as string | undefined;
    const dispatchNpmRegistries = job.jobConfig.npmRegistries as
      | Array<Record<string, unknown>>
      | undefined;
    const dispatchInstallEnvSecrets = job.jobConfig.installEnvSecrets as
      | Record<string, string>
      | undefined;
    // The coordinator pre-resolves a clone token in its onJobReroute path
    // (mintSourceAuth at the dispatch site) and stuffs it into
    // jobConfig.cloneToken — workers have no provider credentials of their
    // own to mint a token. Forward it as the dispatch.job `token` field so
    // the agent's git-clone authenticates against private repos. Without
    // this propagation the agent attempts an unauthenticated HTTPS clone
    // and fails with "could not read Username for 'https://github.com'".
    const dispatchToken = job.jobConfig.cloneToken as string | undefined;
    const cleanJobConfig = Object.fromEntries(
      Object.entries(job.jobConfig).filter(
        ([k]) =>
          k !== 'secrets' &&
          k !== 'namespacedSecrets' &&
          k !== 'runPublicKey' &&
          k !== 'npmRegistries' &&
          k !== 'installEnvSecrets' &&
          k !== 'cloneToken',
      ),
    );

    entry.ws.send(
      JSON.stringify({
        type: 'job.dispatch',
        messageId: randomUUID(),
        timestamp: Date.now(),
        runId: job.runId,
        jobId: job.id,
        jobName: job.jobName,
        workflowName: job.workflowName,
        repoUrl: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        lockFileUrl: job.jobConfig.lockFileUrl ?? '',
        jobConfig: cleanJobConfig,
        // Lift user-cache namespacing from jobConfig to top-level dispatch
        // fields so the worker's agent-WS handler resolves the cache ref from
        // the tracked dispatch (matches the coordinator dispatch path).
        ...(typeof cleanJobConfig.cacheOrgId === 'string' && {
          orgId: cleanJobConfig.cacheOrgId,
        }),
        ...(typeof cleanJobConfig.cacheRepoId === 'string' && {
          repoId: cleanJobConfig.cacheRepoId,
        }),
        ...(typeof cleanJobConfig.cacheRefScope === 'string' && {
          cacheRefScope: cleanJobConfig.cacheRefScope,
        }),
        ...(dispatchToken && { token: dispatchToken }),
        ...(dispatchSecrets && { secrets: dispatchSecrets }),
        ...(dispatchNamespacedSecrets && { namespacedSecrets: dispatchNamespacedSecrets }),
        ...(dispatchRunPublicKey && { runPublicKey: dispatchRunPublicKey }),
        ...(dispatchNpmRegistries &&
          dispatchNpmRegistries.length > 0 && { npmRegistries: dispatchNpmRegistries }),
        ...(dispatchInstallEnvSecrets &&
          Object.keys(dispatchInstallEnvSecrets).length > 0 && {
            installEnvSecrets: dispatchInstallEnvSecrets,
          }),
      }),
    );

    logger.info('Dispatched rerouted job to agent', {
      agentId,
      jobId: job.id,
      runId: job.runId,
      jobName: job.jobName,
    });
  };
}

/**
 * Bootstrap the orchestrator in worker mode.
 *
 * Initializes only worker-relevant subsystems, connects to the coordinator
 * via PeerClient, and starts an HTTP server with agent WS and health endpoints.
 */
export async function bootstrapWorker(
  config: AppConfig,
  _opts?: { otelSdk?: unknown },
): Promise<WorkerSubsystems> {
  // 1. Validate config
  if (config.cluster.role !== 'worker') {
    throw new Error(`bootstrapWorker called with role="${config.cluster.role}", expected "worker"`);
  }
  // Resolve list of coord URLs to dial. Plural form takes precedence; singular
  // is treated as a one-element list (back-compat with single-coord workers).
  const coordUrls =
    config.cluster.coordinatorUrls && config.cluster.coordinatorUrls.length > 0
      ? [...config.cluster.coordinatorUrls]
      : config.cluster.coordinatorUrl
        ? [config.cluster.coordinatorUrl]
        : [];
  if (coordUrls.length === 0) {
    throw new Error(
      'Worker mode requires cluster.coordinatorUrl or cluster.coordinatorUrls to be set',
    );
  }

  // Set structured identity fields on all log lines
  logger.defaultMeta = {
    ...logger.defaultMeta,
    'kici.instanceId': config.cluster.instanceId,
    'kici.role': 'worker',
  };

  // Shared mutable draining flag
  let draining = false;
  const getDraining = () => draining;
  const setDraining = (v: boolean) => {
    draining = v;
  };
  const startedAt = Date.now();

  // SDK drift diagnostic (see docs/operator/troubleshooting.md).
  logger.info('orchestrator.build.info', {
    orchestratorVersion: ORCHESTRATOR_VERSION,
    buildCommit: WORKER_BUILD_COMMIT,
    sdkVersion: WORKER_SDK_VERSION,
    sdkBundleHash: WORKER_SDK_BUNDLE_HASH,
    sharedVersion: WORKER_SHARED_VERSION,
    sharedBundleHash: WORKER_SHARED_BUNDLE_HASH,
    engineVersion: WORKER_ENGINE_VERSION,
    engineBundleHash: WORKER_ENGINE_BUNDLE_HASH,
    role: 'worker',
  });

  logger.info('Worker mode — connecting to coordinator(s)', {
    coordinatorUrls: coordUrls,
    coordCount: coordUrls.length,
    instanceId: config.cluster.instanceId,
    port: config.port,
  });

  // Crash diagnostics. A worker must never exit silently — the
  // graceful-shutdown error handlers (enabled below) log an uncaught JS
  // exception / unhandled rejection through Winston before exiting, and Node's
  // diagnostic report captures fatal errors that bypass JS handlers (e.g. a
  // native fault) as a JSON file carrying the native + JS stack. Both land in
  // the worker's data dir / log stream so a crash in, say, the microVM teardown
  // path is diagnosable instead of a bare systemd restart.
  try {
    const reportDir = join(resolveDataDir(config.dataDir), 'crash-reports');
    mkdirSync(reportDir, { recursive: true });
    process.report.directory = reportDir;
    process.report.reportOnFatalError = true;
    process.report.reportOnUncaughtException = true;
  } catch (err) {
    logger.warn('Failed to enable Node diagnostic reports', { error: toErrorMessage(err) });
  }

  // 2. Initialize worker-only subsystems
  const observerRegistry = new ObserverRegistry();
  const stepLogBuffer = new StepLogBuffer();
  const tokenStore = new StaticAgentTokenStore();
  const agentRegistry = new AgentRegistry();
  const jobQueue = new InMemoryJobQueue();
  const peerRegistry = new PeerRegistry();

  // Fleet log collection: a worker collects bundles only from its own agents.
  const fleetAgentCollector = new FleetAgentCollector({ timeoutMs: FLEET_NODE_TIMEOUT_MS });

  // 3. Initialize execution tracker with forwarding callback.
  //
  // jobOwnership: jobId → coord URL of the coord that dispatched the job.
  // Used to route status updates and log chunks back to the originating coord
  // (the one with the run rows in its DB). Populated in onJobReroute, cleared
  // on terminal job state.
  const peerClients = new Map<string, PeerClient>();
  const jobOwnership = new Map<string, string>();

  // Durable outbox: terminal job statuses are persisted here before the
  // best-effort live send, replayed to the owning coord on every (re)connect,
  // and pruned when the coord ACKs. Keyed by the same coord URL that
  // jobOwnership/peerClients use (the raw coordUrls entry).
  const outbox = new PeerOutbox(join(resolveDataDir(config.dataDir), 'worker-outbox'));
  await outbox.loadFromDisk();
  await outbox.prune(24 * 60 * 60 * 1000);

  const sendToOwningCoord = (jobId: string, msg: unknown): void => {
    const ownerUrl = jobOwnership.get(jobId);
    if (!ownerUrl) {
      logger.warn('No owning coord for job — dropping forward', {
        jobId,
        knownJobIds: [...jobOwnership.keys()],
      });
      return;
    }
    const client = peerClients.get(ownerUrl);
    if (!client) {
      logger.warn('Owning coord client missing for job — dropping forward', {
        jobId,
        ownerUrl,
      });
      return;
    }
    client.send(msg as any);
  };
  const executionTracker = new InMemoryExecutionTracker({
    onStatusForward: (update) => {
      const ownerUrl = jobOwnership.get(update.jobId);
      const terminal = buildTerminalJobProgress(update);
      // Persist a terminal job status durably BEFORE the best-effort live
      // send. The record carries its own coordUrl, so it survives a dropped
      // socket and is replayed on reconnect / pruned on ack.
      //
      // Synchronous + fsynced so the record is on disk before this callback
      // returns. A fire-and-forget async enqueue can lose its un-flushed write
      // if the worker process is killed moments later — exactly the failure
      // when a worker orchestrator crashes during microVM teardown right after
      // the job completes: the terminal `success` was never durably buffered,
      // so it could not be replayed on reconnect and the run was orphan-failed.
      if (terminal && ownerUrl) {
        try {
          outbox.enqueueSync(ownerUrl, terminal);
        } catch (err) {
          logger.error('Failed to persist terminal job status to outbox', {
            jobId: update.jobId,
            error: toErrorMessage(err),
          });
        }
      }
      // `kind` is the discriminator the owning coord uses to route the
      // update to the right ExecutionTracker call. Job updates feed the
      // run-level state machine (onJobStatus), step updates only persist
      // step rows (onStepStatus). Conflating them caused job terminals to
      // be silently absorbed by onStepStatus and runs never advanced past
      // `running`.
      sendToOwningCoord(update.jobId, {
        type: 'job.progress',
        kind: update.type,
        runId: update.runId,
        jobId: update.jobId,
        jobName: '',
        stepIndex: update.stepIndex ?? 0,
        stepName: update.stepName ?? '',
        state: update.status as any,
        timestamp: update.timestamp,
        data: update.data,
      });
      // Only clear ownership when the *job* itself terminates. A *step*
      // can also report status='success' (and is in TERMINAL_JOB_STATES,
      // since the enum is shared between job and step states), so without
      // this `update.type === 'job'` guard the very first step.success
      // would delete the jobOwnership entry — and every subsequent step
      // and the final job.success would then warn "No owning coord for
      // job — dropping forward" with an empty map. The owning coord would
      // never see the job reach success and the run would stall at
      // `running` forever.
      if (update.type === 'job' && TERMINAL_JOB_STATES.has(update.status)) {
        jobOwnership.delete(update.jobId);
      }
    },
    observerRegistry,
  });

  // 4. Initialize scaler
  // Workers have no database, so a scaler provisioning event is forwarded to
  // the coordinator that owns the job; the coordinator's ExecutionTracker
  // persists it. Routing reuses jobOwnership, exactly like job/step progress.
  const scalerResult = await initializeWorkerScaler(config, tokenStore, (runId, jobId, ev) => {
    sendToOwningCoord(jobId, {
      type: 'scaler.event',
      runId,
      jobId,
      agentId: ev.agentId,
      eventType: ev.eventType,
      detail: ev.detail,
      timestampMs: ev.timestampMs,
    });
  });
  const scalerManager = scalerResult?.manager ?? null;
  const scalerConfig = scalerResult?.config ?? null;

  // 5. Create dispatcher with worker onDispatch
  const onDispatch = buildWorkerOnDispatch(agentRegistry);
  const noopMetrics = {
    incJobsDispatched: () => {},
    setQueueDepth: () => {},
  };
  const dispatcher = new Dispatcher({
    registry: agentRegistry,
    // InMemoryJobQueue is structurally compatible for the subset Dispatcher uses
    queue: jobQueue as any,
    metrics: noopMetrics,
    onDispatch,
    onNoMatchingAgent: scalerManager
      ? async (labels, jobId, runId, excludeLabels, resources) =>
          scalerManager.requestScale(labels, jobId, runId, excludeLabels, resources)
      : undefined,
    // The worker has no DB; the deadline is the cluster-wide default.
    getAckTimeoutMs: async () => config.dispatchAckTimeoutMs,
    onAckTimeout: (agentId, jobId, runId) => {
      const entry = agentRegistry.get(agentId);
      if (!entry) return;
      try {
        entry.ws.send(
          JSON.stringify({
            type: 'job.cancel',
            messageId: randomUUID(),
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
      } catch {
        // Best-effort close.
      }
    },
  });

  // 6. Create one PeerClient per coordinator URL.
  // The worker fans out so every coord can dispatch directly. Each PeerClient
  // closes over its own canonical URL; jobOwnership records which coord
  // dispatched each job so progress and log chunks route back to the right
  // coord (the one with the run rows in its DB).
  const getLocalInventory = () => ({
    instanceId: config.cluster.instanceId,
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
    draining,
    capabilities: { s3LogAccess: false },
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
    configVersion: 0,
    registryVersion: 0,
    term: 0,
    leaderId: null,
    hostname: osHostname(),
    osRelease: release(),
    totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
    memoryUsedMb: Math.round((totalmem() - freemem()) / (1024 * 1024)),
    memoryAvailableMb: Math.round(freemem() / (1024 * 1024)),
    cpuCount: cpus().length,
    uptimeSeconds: Math.round(uptime()),
    nodeVersion: process.versions.node,
    runningAsUser: (() => {
      try {
        return userInfo().username;
      } catch {
        return null;
      }
    })(),
    runningAsUid: (() => {
      try {
        return userInfo().uid;
      } catch {
        return null;
      }
    })(),
    version: ORCHESTRATOR_VERSION,
  });

  // Fleet runtime for the worker — collects only its own local bundle + agents
  // (workers have no downstream orchestrators). The responder fires when the
  // worker's coordinator forwards a peer.logs.collect.request down the WS.
  const workerFleetRuntime: FleetRuntime = {
    instanceId: config.cluster.instanceId,
    role: 'worker',
    logWindowHours: 4,
    timeoutMs: FLEET_NODE_TIMEOUT_MS,
    logDir: process.env.KICI_LOG_DIR,
    agentRegistry,
    peerRegistry,
    fleetAgentCollector,
    peerClients: new Map(),
    peerHandler: {
      sendLogsCollectAndWait: () => Promise.reject(new Error('worker has no downstream peers')),
    },
    diagnosticDeps: {
      platformUrl: config.platformUrl,
      agentRegistry,
      config: config as unknown as Record<string, unknown>,
      tlsCertPath: config.tlsCertPath,
      scalerManager: scalerManager ?? undefined,
    },
    config: config as unknown as Record<string, unknown>,
    clusterHealthUrl: `http://127.0.0.1:${config.port}/cluster/health`,
  };
  const workerFleetResponder = makeFleetCollectResponder(workerFleetRuntime);

  // One coordinator shared by every sibling peer-client of this orchestrator:
  // it owns the credential file and serializes token-joins so a reconnect storm
  // never cascades credential revocations across the siblings.
  const workerCredentialFile = config.cluster.credentialFile.replace(/^~/, process.env.HOME ?? '~');
  const peerAuthCoordinator = new PeerAuthCoordinator({
    credentialFile: workerCredentialFile,
    instanceId: config.cluster.instanceId,
    joinToken: config.cluster.joinToken,
  });

  const createPeerClientForCoord = (rawUrl: string): PeerClient => {
    const baseUrl = rawUrl.replace(/^https?:\/\//, 'ws://');
    const wsUrl = baseUrl.endsWith('/ws/peer') ? baseUrl : baseUrl + '/ws/peer';

    const client: PeerClient = new PeerClient({
      url: wsUrl,
      onLogsCollectRequest: (msg, send) => workerFleetResponder(msg, send),
      joinToken: config.cluster.joinToken,
      credentialFile: workerCredentialFile,
      authCoordinator: peerAuthCoordinator,
      instanceId: config.cluster.instanceId,
      role: 'worker',
      peerRegistry,
      heartbeatIntervalMs: config.cluster.peerHeartbeatIntervalMs,
      maxReconnectDelayMs: config.cluster.peerMaxReconnectDelayMs,

      // On every (re)connect, replay every pending terminal job status for
      // this coord. The outbox is keyed by `rawUrl` (the same key
      // jobOwnership/peerClients use), NOT the transformed wsUrl that the
      // hook passes as `url` — so we key replay and ack on `rawUrl`.
      onConnected: () => replayPending(outbox, (m) => client.send(m), rawUrl),
      // Coord ACKed a terminal job status — prune the matching outbox record.
      onJobProgressAck: (ack) => {
        void outbox.ack(rawUrl, ack.runId, ack.jobId);
      },

      getLocalInventory,

      onJobReroute: async (msg: JobReroute) => {
        if (draining) {
          client.send({
            type: 'job.reroute.ack',
            messageId: msg.messageId,
            accepted: false,
            reason: 'Worker is draining',
          });
          return;
        }

        const flatLabels = msg.runsOnLabels.length > 0 ? msg.runsOnLabels[0] : [];

        const jobConfig = {
          ...(msg.jobConfig ?? msg.payload),
          ...(msg.cloneToken && { cloneToken: msg.cloneToken }),
        };

        const jobInput = {
          // Honor the sender-allocated jobId so the agent's status updates
          // reference the same id the owning coord wrote into
          // execution_runs/execution_jobs.
          jobId: msg.jobId,
          runId: msg.runId,
          workflowName: msg.workflowName,
          jobName: msg.jobName,
          runsOnLabels: flatLabels,
          excludeLabels: msg.excludeLabels,
          // Carry the glob/regex selectors so the worker's local dispatch
          // applies the same matching the single-orchestrator path does — a
          // pure-regex job must not match an agent lacking the pattern.
          runsOnPatterns: msg.runsOnPatterns,
          excludePatterns: msg.excludePatterns,
          jobConfig,
          repoUrl: msg.repoUrl ?? '',
          ref: msg.ref ?? '',
          sha: msg.sha ?? '',
          deliveryId: msg.deliveryId,
          provider: msg.provider ?? '',
          providerContext: msg.providerContext ?? {},
          routingKey: msg.routingKey,
          requestId: msg.requestId,
          sourceTarUrl: msg.sourceTarUrl,
          sourceTarHash: msg.sourceTarHash,
          depsUrl: msg.depsUrl,
          depsHash: msg.depsHash,
        };

        // Dispatch first so we can use the queue's jobId — that is the same
        // id the FC scaler binds at spawn time and that the agent reports back
        // via job.status / step.status, so jobOwnership and the execution
        // tracker MUST key on it. Generating a fresh randomUUID here would
        // lose ownership the moment the agent's first progress update arrived
        // ("No owning coord for job — dropping forward"), and the run on the
        // owning coordinator would never advance past `running`.
        const result = await dispatcher.dispatch(jobInput);

        if (
          result.status === 'dispatched' ||
          result.status === 'queued' ||
          result.status === 'queued-no-backend'
        ) {
          const jobId = result.jobId;
          jobOwnership.set(jobId, rawUrl);
          // reroute projection — owning orchestrator holds the authoritative deadline
          await executionTracker.onExecutionStarted(
            msg.runId,
            jobInput.workflowName,
            jobInput.provider,
            '',
            jobInput.ref,
            jobInput.sha,
            jobInput.deliveryId,
            jobInput.providerContext,
            null,
            [{ jobId, jobName: jobInput.jobName }],
          );
          client.send({
            type: 'job.reroute.ack',
            messageId: msg.messageId,
            accepted: true,
          });
        } else {
          client.send({
            type: 'job.reroute.ack',
            messageId: msg.messageId,
            accepted: false,
            reason: result.status === 'rejected' ? result.reason : 'No matching agent available',
          });
        }
      },

      onJobProgress: (_msg: JobProgress) => {
        // Workers send progress to coordinator, not the other way around.
      },

      onJobCancel: (msg: PeerJobCancel) => {
        if (!msg.jobId) return;
        const agentId = dispatcher.getAgentIdForJob(msg.jobId);
        if (agentId) {
          const entry = agentRegistry.get(agentId);
          if (entry?.ws) {
            entry.ws.send(
              JSON.stringify({
                type: 'job.cancel',
                messageId: randomUUID(),
                runId: msg.runId,
                jobId: msg.jobId,
                reason: msg.reason,
              }),
            );
          }
        }
      },

      onAgentTokenRevoke: (msg) => {
        const kicked = agentRegistry.disconnectByTokenId(msg.tokenId);
        // Always log on receipt -- see orchestrator-core.ts for the
        // KICI_AGENT_AUTH=none rationale.
        logger.info('Kicked agent connections after cross-peer revoke', {
          tokenId: msg.tokenId,
          senderInstanceId: msg.senderInstanceId,
          kicked,
        });
      },

      // Workers don't participate in Raft
      onRaftVoteRequest: undefined,
      onRaftVoteResponse: undefined,
      onRaftAppendEntries: undefined,
    });

    return client;
  };

  for (const url of coordUrls) {
    peerClients.set(url, createPeerClientForCoord(url));
  }

  // Pick a deterministic primary client for legacy single-client APIs.
  const peerClient = peerClients.get(coordUrls[0])!;

  // 7. Create HTTP server with minimal routes
  const app = new Hono().basePath(config.basePath);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Health endpoint (no DB readiness check for workers). Drift-diagnostic fields
  // mirror coordinator/health so curl-diffing across roles works uniformly.
  const healthRoutes = createBaseHealthRoutes({
    livenessInfo: () => ({
      role: 'worker',
      version: ORCHESTRATOR_VERSION,
      buildCommit: WORKER_BUILD_COMMIT,
      sdkVersion: WORKER_SDK_VERSION,
      sdkBundleHash: WORKER_SDK_BUNDLE_HASH,
      sharedVersion: WORKER_SHARED_VERSION,
      sharedBundleHash: WORKER_SHARED_BUNDLE_HASH,
      engineVersion: WORKER_ENGINE_VERSION,
      engineBundleHash: WORKER_ENGINE_BUNDLE_HASH,
    }),
  });
  app.route('/', healthRoutes);

  // Cluster health endpoint. Worker is healthy when ALL coord connections are
  // up; degraded when some are down; down only when none are connected.
  app.get('/cluster/health', (c) => {
    let connectedCount = 0;
    for (const client of peerClients.values()) {
      if (client.state === 'connected') connectedCount += 1;
    }
    const total = peerClients.size;
    const status = connectedCount === total ? 'healthy' : connectedCount > 0 ? 'degraded' : 'down';
    return c.json({
      status,
      instanceId: config.cluster.instanceId,
      role: 'worker',
      term: 0,
      leaderId: null,
      peerCount: total,
      connectedPeers: connectedCount,
      agentCount: agentRegistry.getActiveCount(),
      activeRuns: 0,
    });
  });

  // Worker status and drain endpoints
  const statusHandler = createWorkerStatusHandler({
    instanceId: config.cluster.instanceId,
    executionTracker,
    agentRegistry,
    peerClient,
    startedAt,
    getDraining,
    setDraining,
  });
  const drainHandler = createWorkerDrainHandler({
    instanceId: config.cluster.instanceId,
    executionTracker,
    agentRegistry,
    peerClient,
    startedAt,
    getDraining,
    setDraining,
  });

  app.get('/status', (c) => {
    return new Promise<Response>((resolve) => {
      const mockRes = {
        _status: 200,
        _body: '',
        writeHead(status: number) {
          mockRes._status = status;
          return mockRes;
        },
        end(body: string) {
          resolve(c.json(JSON.parse(body), mockRes._status as any));
        },
      };
      statusHandler({} as any, mockRes as any);
    });
  });

  app.post('/drain', (c) => {
    return new Promise<Response>((resolve) => {
      const mockRes = {
        _status: 200,
        _body: '',
        writeHead(status: number) {
          mockRes._status = status;
          return mockRes;
        },
        end(body: string) {
          resolve(c.json(JSON.parse(body), mockRes._status as any));
        },
      };
      drainHandler({} as any, mockRes as any);
    });
  });

  // Agent WS endpoint (same as coordinator -- agents connect to worker locally)
  const agentWsHandler = createAgentWsHandler({
    registry: agentRegistry,
    dispatcher,
    // StaticAgentTokenStore is structurally compatible with AgentTokenStore
    tokenStore: tokenStore as any,
    agentAuthMode: config.agentAuth,
    fleetAgentCollector,
    onJobStatus: (_agentId, msg) => {
      executionTracker.onJobStatus(
        msg.runId,
        msg.jobId,
        msg.state,
        msg.timestamp,
        _agentId,
        msg.data,
      );
    },
    onLogChunk: (_agentId, msg) => {
      stepLogBuffer.addLines(
        { runId: msg.runId, jobId: msg.jobId, stepIndex: msg.stepIndex },
        msg.lines,
      );
      // Forward log chunks to the coord that dispatched this job (the one
      // with the run rows in its DB).
      sendToOwningCoord(msg.jobId, {
        type: 'peer.log.chunk',
        messageId: randomUUID(),
        runId: msg.runId,
        jobId: msg.jobId,
        stepIndex: msg.stepIndex,
        lines: msg.lines,
        timestamp: msg.timestamp,
      });
    },
    onStepStatus: (_agentId, msg) => {
      // Merge top-level wire fields back into data for the persistence/forward pipeline.
      const data = {
        ...msg.data,
        ...(msg.secretsAccessed !== undefined && { secretsAccessed: msg.secretsAccessed }),
        ...(msg.concurrencyKind !== undefined && { concurrencyKind: msg.concurrencyKind }),
        ...(msg.groupId !== undefined && { groupId: msg.groupId }),
      };
      executionTracker.onStepStatus(
        msg.runId,
        msg.jobId,
        msg.stepIndex,
        msg.stepName,
        msg.state,
        msg.timestamp,
        data,
      );
    },
    onScalerAgentRegistered: scalerManager
      ? (agentId, labels) => scalerManager.onAgentRegistered(agentId, labels)
      : undefined,
    onScalerAgentDisconnected: scalerManager
      ? (agentId) => scalerManager.onAgentDisconnected(agentId)
      : undefined,
    onScalerJobComplete: scalerManager
      ? (agentId) => scalerManager.onJobComplete(agentId)
      : undefined,
    onJobHeartbeat: undefined,
    onAgentLog: undefined,
    onConfigAck: undefined,
    onEventEmit: undefined,
    onRunEvent: undefined,
    onJobContext: undefined,
    onSecretOutputs: undefined,
    onConcurrencyReport: undefined,
  });

  app.get(
    '/ws',
    upgradeWebSocket(() => agentWsHandler),
  );

  // Start HTTP server
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info(`Worker started on port ${info.port}`, {
      port: info.port,
      role: 'worker',
      coordinatorUrls: coordUrls,
      instanceId: config.cluster.instanceId,
    });
  });

  injectWebSocket(server);

  // 8. Start heartbeat monitor
  const heartbeatMonitor = new AgentHeartbeatMonitor({
    registry: agentRegistry,
    dispatcher,
  });
  heartbeatMonitor.start();

  // Periodic outbox re-send while connected. Covers a dropped-but-not-closed
  // socket where no `onConnected` fires: every 30s, replay each connected
  // client's pending terminal job statuses. Acks prune them, so a delivered
  // record is not re-sent.
  const outboxResendInterval = setInterval(() => {
    for (const [rawUrl, client] of peerClients.entries()) {
      if (client.state !== 'connected') continue;
      replayPending(outbox, (m) => client.send(m), rawUrl);
    }
  }, 30_000);
  outboxResendInterval.unref();

  // 9. Register graceful shutdown with drain support
  setupGracefulShutdown({
    logger,
    timeoutMs: DRAIN_TIMEOUT_MS + 30_000, // drain timeout + 30s buffer
    // Install uncaughtException / unhandledRejection handlers so a worker
    // crash is logged (with stack) through Winston before exit instead of
    // dying silently to stderr. Worker mode runs in its own process (standalone
    // returns before bootstrapping the coordinator), so there is no double
    // registration with orchestrator-core's handlers.
    skipErrorHandlers: false,
    steps: [
      {
        name: 'Draining in-flight jobs',
        fn: async () => {
          setDraining(true);
          const drainStart = Date.now();
          while (Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
            const agents = [...agentRegistry.getAllEntries()];
            const activeJobs = agents.reduce((sum, a) => sum + a.activeJobs, 0);
            if (activeJobs === 0) break;
            logger.info(`Draining: ${activeJobs} job${activeJobs !== 1 ? 's' : ''} in flight`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        },
      },
      {
        name: 'Stopping heartbeat monitor',
        fn: () => heartbeatMonitor.stop(),
      },
      {
        name: 'Stopping outbox re-send interval',
        fn: () => clearInterval(outboxResendInterval),
      },
      {
        name: 'Broadcasting peer.leaving to all coordinators',
        fn: () => {
          const msg = {
            type: 'peer.leaving' as const,
            instanceId: config.instanceId,
            term: 0, // Workers don't participate in Raft elections
          };
          for (const client of peerClients.values()) {
            client.send(msg);
          }
        },
      },
      {
        name: 'Disconnecting from coordinators',
        fn: () => {
          for (const client of peerClients.values()) {
            client.disconnect();
          }
        },
      },
      {
        name: 'Shutting down scaler',
        fn: async () => {
          if (scalerManager) await scalerManager.shutdownAll();
        },
      },
      {
        name: 'Closing HTTP server',
        fn: () => {
          // Force-close open sockets (peer WS, agent WS, dashboard streams)
          // so server.close() can return immediately instead of waiting for
          // long-lived connections to idle. Same rationale as orchestrator-core.
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close();
        },
      },
    ],
  });

  // 10. Connect to all coordinators (final step)
  for (const client of peerClients.values()) {
    client.connect();
  }

  const subsystems: WorkerSubsystems = {
    config,
    agentRegistry,
    dispatcher,
    peerRegistry,
    peerClients,
    peerClient,
    executionTracker,
    jobQueue,
    tokenStore,
    stepLogBuffer,
    observerRegistry,
    scalerManager,
    scalerConfig,
  };

  return subsystems;
}
