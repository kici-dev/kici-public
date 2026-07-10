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
const { PeerClient, PeerAuthCoordinator } = await import('./cluster/index.js');
const { bootstrapOrchestrator } = await import('./orchestrator-core.js');
const { buildContextSecretResolver } = await import('./secrets/context-secret-resolver.js');
const { ContextStore } = await import('./contexts/context-store.js');
const { VariableStore } = await import('./contexts/variable-store.js');

import type { OrchestratorHooks } from './orchestrator-core.js';
import { buildLocalGithubIngressUrl } from './cli/local-github-ingress-url.js';

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

    // Independent mode resolves NO context-scoped secrets at dispatch by
    // default (the secrets subsystem still initializes PgSecretStore for admin
    // deps). The local dev plane opts in via KICI_INDEPENDENT_SECRETS=1 so a
    // workflow's `secrets.yaml` contexts resolve through the real resolver —
    // gated so a bare independent orchestrator that doesn't want dispatch-time
    // resolution is unaffected.
    onSecretsInitialized: config.independentSecrets
      ? ({ pgSecretStore, backendStores, db, auditLogger }) =>
          buildContextSecretResolver({ pgSecretStore, backendStores, db, auditLogger, logger })
      : undefined,

    onSubsystemsReady: async (sub) => {
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

      // Create PeerClient instances for statically configured peers
      for (const peerAddr of config.cluster.peers) {
        const peerUrl = peerAddr.replace(/^https?:\/\//, 'ws://') + '/ws/peer';
        const client = new PeerClient({
          url: peerUrl,
          joinToken: config.cluster.joinToken,
          credentialFile: peerCredentialFile,
          authCoordinator: peerAuthCoordinator,
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
          onJobProgress: (msg, reply) => sub.coordinator.onPeerJobProgress(msg, reply),
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
          // Independent mode serves its OWN direct GitHub ingress route
          // (`/webhook/:orgId/github/:sourceId`), so `source add github`
          // resolves the ingress URL locally from KICI_WEBHOOK_PUBLIC_URL — no
          // Platform round-trip. The orgId comes from the source's customer_id.
          resolveSourceWebhookUrl: async (params: {
            routingKey: string;
            provider: string;
            sourceId: string;
          }) => {
            if (params.provider !== 'github') {
              return { webhookUrl: null, webhookNote: 'unsupported-provider' };
            }
            const source = await sub.sourceStore?.getSourceById(params.sourceId);
            const orgId = source?.customer_id ?? '__default__';
            const url = buildLocalGithubIngressUrl(config.webhookPublicUrl, orgId, params.sourceId);
            return url ? { webhookUrl: url } : { webhookUrl: null, webhookNote: 'no-public-url' };
          },
          // Manifest setup pre-flight: the org-scoped GitHub webhook URL is
          // resolvable locally once a public base is configured. Independent
          // mode has no central org, so an App-level manifest is org-scoped by
          // the operator-provided org id when one is known; absent that we
          // return an honest note rather than a fabricated URL.
          resolveGithubWebhookUrl: async () => {
            if (!config.webhookPublicUrl) {
              return { webhookUrl: null, webhookNote: 'no-public-url' };
            }
            return { webhookUrl: null, webhookNote: 'org-not-identified' };
          },

          // Dispatch-time context resolution (variables + scoped secrets) for
          // independent mode is opt-in via KICI_INDEPENDENT_SECRETS. When on
          // (the local dev plane), wire the context + variable stores so a job's
          // bound context is matched and its scoped secrets resolve through the
          // SecretResolver. Off (a bare independent orchestrator) leaves these
          // undefined, so context matching is skipped exactly as before.
          ...(config.independentSecrets && {
            contextStore: new ContextStore(sub.db),
            variableStore: new VariableStore(sub.db),
          }),
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
