/**
 * Independent mode entry point for the customer orchestrator.
 *
 * Operates in 'independent' mode:
 * - Receives webhooks ONLY via direct HTTP endpoints
 * - No Platform WS relay connection
 * - No event buffer (nothing to buffer for)
 *
 * Same as server.ts but WITHOUT PlatformClient.
 * Webhooks arrive only via the per-source generic webhook endpoints at
 * /webhook/:orgId/generic/:sourceId, registered with `kici-admin source add`.
 *
 * Startup sequence:
 * config -> DB -> provider registry -> dispatcher -> app -> HTTP -> heartbeat
 *
 * Graceful shutdown:
 * agent WS -> heartbeat -> HTTP -> DB
 */

import { createLogger, guardStartup, setServiceName, initTelemetry } from '@kici-dev/shared';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// SDK drift diagnostic — see docs/operator/troubleshooting.md.
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
// ESM static imports are hoisted, so we must use dynamic imports.
const otelSdk = initTelemetry({
  serviceName: 'kici-orchestrator',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const { loadConfig } = await import('./config.js');
const { PeerClient } = await import('./cluster/index.js');
const { bootstrapOrchestrator } = await import('./orchestrator-core.js');

import type { OrchestratorHooks } from './orchestrator-core.js';

setServiceName('orchestrator');
const logger = createLogger({ prefix: 'standalone' });

await guardStartup(logger, async () => {
  // SDK drift diagnostic (see docs/operator/troubleshooting.md).
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
  if (config.cluster.role === 'worker') {
    const { bootstrapWorker } = await import('./worker-core.js');
    await bootstrapWorker(config, { otelSdk });
    return; // worker mode handles its own lifecycle
  }

  if (config.mode !== 'independent') {
    logger.error('standalone.ts requires KICI_MODE=independent', { mode: config.mode });
    process.exit(1);
  }

  const hooks: OrchestratorHooks = {
    logPrefix: 'standalone',

    // No Platform forwarding in standalone mode
    executionTrackerExtras: undefined,

    // No SecretResolver in standalone mode (secrets subsystem still initializes PgSecretStore for admin deps)
    onSecretsInitialized: undefined,

    onSubsystemsReady: async (sub) => {
      // Create PeerClient instances for statically configured peers
      for (const peerAddr of config.cluster.peers) {
        const peerUrl = peerAddr.replace(/^https?:\/\//, 'ws://') + '/ws/peer';
        const client = new PeerClient({
          url: peerUrl,
          joinToken: config.cluster.joinToken,
          credentialFile: config.cluster.credentialFile.replace(/^~/, process.env.HOME ?? '~'),
          instanceId: config.instanceId,
          peerRegistry: sub.peerRegistry,
          getLocalInventory: () => ({
            instanceId: config.instanceId,
            timestamp: Date.now(),
            agents: [...sub.agentRegistry.getAllEntries()].map((e) => ({
              agentId: e.agentId,
              labels: [...e.labels],
              activeJobs: e.activeJobs,
              maxConcurrency: e.maxConcurrency,
              platform: e.platform ?? 'linux',
              arch: e.arch ?? 'x64',
              mandatoryLabels: [...e.mandatoryLabels],
              scalerName: sub.scalerManager?.getBackendForAgent(e.agentId) ?? null,
            })),
            draining: false,
            capabilities: { s3LogAccess: !!sub.cacheStorage },
            ...(sub.scalerManager && {
              scalerCapacity: sub.scalerManager.getStatus().backends.map((b) => ({
                name: b.name,
                type: b.type,
                labelSets: b.labelSets,
                maxAgents: b.maxAgents,
                activeCount: b.activeCount,
                spawnsOnLocalHost: b.spawnsOnLocalHost,
                mandatoryLabels: b.mandatoryLabels,
              })),
            }),
            configVersion: sub.localConfigVersion,
            registryVersion: sub.registrationIndex.getVersion(),
            term: sub.raft?.getCurrentTerm() ?? 0,
            leaderId: sub.raft?.getLeaderId() ?? null,
          }),
          heartbeatIntervalMs: config.cluster.peerHeartbeatIntervalMs,
          maxReconnectDelayMs: config.cluster.peerMaxReconnectDelayMs,
          onLogsCollectRequest: (msg, send) => sub.fleetCollectResponder(msg, send),
          onJobReroute: async (msg) => {
            const result = await sub.coordinator.handleIncomingReroute(msg);
            client.send({
              type: 'job.reroute.ack',
              messageId: msg.messageId,
              accepted: result.accepted,
              reason: result.reason,
            });
          },
          onJobProgress: (msg) => sub.coordinator.onPeerJobProgress(msg),
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
          onAuthenticated: (targetInstanceId) => {
            if (peerAddr === targetInstanceId) return;
            const existing = sub.peerClients.get(peerAddr);
            if (existing === client) {
              sub.peerClients.delete(peerAddr);
            }
            sub.peerClients.set(targetInstanceId, client);
          },
        });
        // Use the peer address as temporary key until instanceId is known after auth
        sub.peerClients.set(peerAddr, client);
        client.connect();
      }

      return {
        // No platformClient in independent mode. The EventLogWriter is
        // constructed by orchestrator-core and passed through createApp()
        // automatically.
        appDepsExtras: {
          // Independent mode has no GitHub-App webhook ingress (that route is
          // Platform-only). `source add` must print an honest "unavailable"
          // note rather than a fabricated URL.
          resolveSourceWebhookUrl: async (params: { provider: string }) =>
            params.provider === 'github'
              ? { webhookUrl: null, webhookNote: 'github-ingress-platform-only' }
              : { webhookUrl: null, webhookNote: 'unsupported-provider' },
        },

        configReloaderExtras: {
          onProviderChange: async (_newConfig: any, _oldConfig: any, s: any) => {
            // Providers are DB-managed via SourceManager -- reload from DB
            await s.sourceManager.reload();
            const newRegistry = s.sourceManager.getRegistry();
            s.providerRegistry = newRegistry;
            s.checkRunReporter.updateRegistry(newRegistry);
            logger.info('Provider registry reloaded from sources (standalone)', {
              routingKeys: newRegistry.getRoutingKeys(),
            });
          },
        },

        // No extra shutdown steps (no Platform client to disconnect)
        shutdownExtras: [],

        onServerStarted: async () => {
          // Nothing extra to start in standalone mode
        },
      };
    },

    startupLogMessage: (port) => `Orchestrator (standalone) started on port ${port}`,
  };

  await bootstrapOrchestrator(config, hooks, { otelSdk });
});
