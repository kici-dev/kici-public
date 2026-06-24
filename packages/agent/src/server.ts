/**
 * Agent entry point.
 *
 * Startup sequence:
 * 1. Load config
 * 2. Create logger
 * 3. Create JobRunner with send/sendDirect callbacks
 * 4. Create OrchestratorClient with dispatch and cancel handlers
 * 5. Add WS log transport (if not scaler-managed)
 * 6. Connect OrchestratorClient
 * 7. Create Hono app with health routes
 * 8. Start HTTP server
 * 9. Register signal handlers
 *
 * Graceful shutdown:
 * - SIGTERM/SIGINT: 10s grace for running jobs, then force-kill
 * - SIGUSR1: Drain mode (stop accepting, finish current, exit)
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Writable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import winston from 'winston';
import {
  createLogger,
  guardStartup,
  requestContext,
  setServiceName,
  initTelemetry,
  getPrometheusExporter,
  toErrorMessage,
  setupGracefulShutdown,
  validateRequiredTools,
  type ToolRequirement,
} from '@kici-dev/shared';
import type { JobDispatch, JobCancel } from '@kici-dev/engine';
import { loadConfig, agentClientConnectionOptions } from './config.js';
import { OrchestratorClient } from './ws/orchestrator-client.js';
import { installConsoleCapture } from './execution/console-capture.js';
import { createHealthRoutes } from './routes/health.js';
import { MetricsReporter } from './metrics/metrics-reporter.js';
import { verifyNpmAvailable } from './execution/npm-resolver.js';
import { gcStaleAgentTmpDirs } from './execution/tmp-gc.js';
import { issueReboot } from './execution/reboot.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// Workspace dep fingerprints power the SDK drift diagnostic: compare the agent's
// baked sdkBundleHash against the orchestrator's at /health to catch drift in one grep.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_COMMIT: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

const AGENT_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown';
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
// that transitively create OTel meters (./metrics/prometheus.js, and
// ./execution/job-runner.js which pulls log-streamer.ts → prometheus.ts).
// Mirrors the same pattern in packages/orchestrator/src/server.ts.
initTelemetry({
  serviceName: 'kici-agent',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

// Dynamic imports: these modules create OTel meters at module load time,
// so they must be imported after initTelemetry() sets up the MeterProvider.
const { connectionStatus, jobsActive, jobsTotal } = await import('./metrics/prometheus.js');
const { JobRunner } = await import('./execution/job-runner.js');

setServiceName('agent');
const logger = createLogger({ prefix: 'agent' });

/**
 * Serialize the agent's current Prometheus metrics to text. The OTel
 * PrometheusExporter exposes no direct serialize method, so the metrics are
 * piped through its request handler with a mock ServerResponse. Returns an
 * empty string when no exporter is configured. Shared by the /metrics health
 * route and the fleet mini-bundle.
 */
async function serializeAgentMetrics(): Promise<string> {
  const exporter = getPrometheusExporter();
  if (!exporter) return '';
  return new Promise<string>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader: () => {},
      end: (data?: string | Buffer) => {
        resolve(typeof data === 'string' ? data : data ? data.toString() : '');
      },
    };
    exporter.getMetricsRequestHandler(
      {} as import('http').IncomingMessage,
      mockRes as unknown as import('http').ServerResponse,
    );
  });
}

// Install console.* capture so in-process jobs (__init__, __build__, __dynamic__)
// can route user code's console.log output to the dashboard via AsyncLocalStorage.
// See packages/agent/src/execution/console-capture.ts.
installConsoleCapture();

await guardStartup(logger, async () => {
  // 1. Load configuration
  const config = loadConfig();
  logger.info('Agent starting', {
    agentId: config.agentId,
    orchestratorUrl: config.orchestratorUrl,
    labels: config.labels,
    roles: config.roles,
    port: config.port,
  });

  // Collect temp dirs leaked by a previous hard death (SIGKILL/OOM) of this
  // or an earlier agent on the host. Fire-and-forget: startup must not wait.
  void gcStaleAgentTmpDirs();

  // SDK drift diagnostic (see docs/operator/troubleshooting.md): the six hashes
  // below answer "did this agent's bundle ship with the same @kici-dev/sdk as
  // the orchestrator / host?". Comparing sdkBundleHash across services is the
  // cheapest way to catch the 2026-04-08 / 2026-04-19 scaler-container failure
  // class before the first workflow runs.
  logger.info('agent.build.info', {
    agentVersion: AGENT_VERSION,
    buildCommit: BUILD_COMMIT,
    sdkVersion: SDK_VERSION,
    sdkBundleHash: SDK_BUNDLE_HASH,
    sharedVersion: SHARED_VERSION,
    sharedBundleHash: SHARED_BUNDLE_HASH,
    engineVersion: ENGINE_VERSION,
    engineBundleHash: ENGINE_BUNDLE_HASH,
  });

  // 1b. Required tools startup check: verify external binaries are available.
  const agentToolRequirements: ToolRequirement[] = [
    { type: 'path-binary', name: 'git', reason: 'required for repository checkout' },
    { type: 'path-binary', name: 'bash', reason: 'required for step execution' },
  ];
  const toolErrors = validateRequiredTools(agentToolRequirements);
  if (toolErrors.length > 0) {
    throw new Error(
      'Agent required-tools validation failed:\n' + toolErrors.map((e) => `  - ${e}`).join('\n'),
    );
  }

  // 1c. Builder role readiness check: verify npm is available.
  // Builder agents run `npm install` to install .kici/ deps before compiling workflows.
  // Without npm, build jobs will fail at runtime — better to fail fast at startup.
  const hasBuilderRole = config.roles === undefined || config.roles.includes('builder');
  if (hasBuilderRole) {
    const npmVersion = verifyNpmAvailable();
    logger.info('Builder role: npm verified', { npmVersion });
  }

  // 2. Drain and shutdown state
  let isDraining = false;
  let idleShutdownTimer: NodeJS.Timeout | undefined;

  // Workflow-level host restart: a `restartHost()` step's `host.requestReboot`
  // API call sets this intent (the orchestrator has already acked + set its
  // reboot-pending flag). After the job completes, the post-job hook issues the
  // OS reboot. Cleared after firing so a follow-up job does not re-reboot.
  let rebootIntent = false;

  // 3. Create OrchestratorClient (declared early so JobRunner can reference it)
  // We need a forward reference for the client since JobRunner and client reference each other.
  let client: OrchestratorClient;

  // 4. Create JobRunner with send/sendDirect/upload callbacks wired to OrchestratorClient
  const jobRunner = new JobRunner({
    send: (msg) => client.send(msg),
    sendDirect: (msg) => client.sendDirect(msg),
    config,
    requestUploadUrl: (jobId, cacheType, key) => client.requestUploadUrl(jobId, cacheType, key),
    sendUploadComplete: (jobId, cacheType, key) => client.sendUploadComplete(jobId, cacheType, key),
    sendEventEmit: (jobId, requestId, eventName, payload, target) =>
      client.sendEventEmit(jobId, requestId, eventName, payload, target),
    // Backpressure wiring: LogStreamer checks WS buffer and drains via these callbacks
    getBufferedAmount: () => client.getBufferedAmount(),
    onDrain: (cb) => client.onDrain(cb),
    // Run event tracking: agent lifecycle events forwarded to orchestrator -> Platform
    sendJobContext: (runId, jobId, context) => client.sendJobContext(runId, jobId, context),
    sendRunEvent: (runId, eventType, opts) => client.sendRunEvent(runId, eventType, opts),
    // Concurrency protocol: relay concurrency report to orchestrator and wait for ack
    sendConcurrencyReport: (runId, jobId, group) =>
      client.sendConcurrencyReport(runId, jobId, group),
    // Agent private API: relay typed KiCI API calls to orchestrator via WS.
    // host.requestReboot is special: refuse locally when co-located with the
    // orchestrator, and record the reboot intent on a successful ack so the
    // post-job hook can issue the OS reboot after the step completes.
    sendApiRequest: async (method, params) => {
      if (method === 'host.requestReboot') {
        if (config.isOrchestratorHost) {
          throw new Error('refusing to reboot the orchestrator host');
        }
        const result = await client.sendApiRequest(method, params ?? {});
        rebootIntent = true;
        return result;
      }
      return client.sendApiRequest(method, params ?? {});
    },
    // User-facing cache: relay ctx.cache restore/save to orchestrator via WS
    requestUserCache: (jobId, request) => client.requestUserCache(jobId, request),
    // Provenance: relay ctx.attestProvenance bundle uploads to orchestrator via WS
    relayProvenance: (jobId, request) => client.relayProvenance(jobId, request),
    // Step-level approvals: relay an approval step's hold to the
    // orchestrator and await its resolution via WS.
    sendStepApproval: (runId, jobId, request) => client.sendStepApproval(runId, jobId, request),
  });

  /** Build and send an agent.status message with dynamic OS metadata. */
  function sendAgentStatus(): void {
    client.sendDirect({
      type: 'agent.status',
      messageId: randomUUID(),
      agentId: config.agentId,
      activeJobs: jobRunner.activeJobs.size,
      memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
      memoryAvailableMb: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds: Math.round(os.uptime()),
    });
  }

  // 5. Create OrchestratorClient with concurrency-gated dispatch handler.
  // Connection/identity fields (including the auth token) come from
  // agentClientConnectionOptions so KICI_AGENT_TOKEN always reaches the client.
  client = new OrchestratorClient({
    ...agentClientConnectionOptions(config),
    // Fleet log collection inputs: the agent's resolved config (redacted inside
    // the bundle assembler), its log directory, and current Prometheus metrics.
    getFleetBundleInputs: async () => ({
      config: config as unknown as Record<string, unknown>,
      logDir: process.env.KICI_LOG_DIR,
      metricsText: await serializeAgentMetrics(),
    }),
    onJobDispatch: (dispatch: JobDispatch) => {
      const reqId = dispatch.requestId ?? randomUUID();
      requestContext.run(
        {
          requestId: reqId,
          runId: dispatch.runId,
          jobId: dispatch.jobId,
        },
        () => {
          // Drain mode check
          if (isDraining) {
            logger.info('Draining: rejecting job dispatch', { jobId: dispatch.jobId });
            client.sendDirect({
              type: 'job.reject',
              messageId: randomUUID(),
              runId: dispatch.runId,
              jobId: dispatch.jobId,
              reason: 'draining',
              timestamp: Date.now(),
            });
            sendAgentStatus();
            return;
          }

          // Single-job enforcement: reject if already running a job.
          // The explicit job.reject lets the orchestrator undo its dispatch
          // accounting and requeue immediately — a silent drop would leave
          // the job bound to this agent until disconnect.
          if (jobRunner.activeJobs.size > 0) {
            logger.warn('Already running a job, rejecting dispatch', {
              jobId: dispatch.jobId,
              activeJobs: jobRunner.activeJobs.size,
            });
            client.sendDirect({
              type: 'job.reject',
              messageId: randomUUID(),
              runId: dispatch.runId,
              jobId: dispatch.jobId,
              reason: 'busy',
              timestamp: Date.now(),
            });
            sendAgentStatus();
            return;
          }

          // Cancel idle shutdown timer if a follow-up job arrives
          if (idleShutdownTimer) {
            clearTimeout(idleShutdownTimer);
            idleShutdownTimer = undefined;
          }

          // Positive dispatch acknowledgment: resolves the orchestrator's ack
          // deadline. Sent before execution starts so a slow clone cannot eat
          // into the deadline.
          client.sendDirect({
            type: 'job.ack',
            messageId: randomUUID(),
            runId: dispatch.runId,
            jobId: dispatch.jobId,
            timestamp: Date.now(),
          });

          // Accept and execute
          logger.info('Accepting job dispatch', {
            jobId: dispatch.jobId,
            runId: dispatch.runId,
            activeJobs: jobRunner.activeJobs.size + 1,
          });

          jobsActive.add(1);

          jobRunner
            .execute(dispatch)
            .then(() => {
              jobsTotal.add(1, { status: 'success' });
            })
            .catch((err) => {
              logger.error('Job execution error', {
                jobId: dispatch.jobId,
                error: toErrorMessage(err),
              });
              jobsTotal.add(1, { status: 'failed' });
            })
            .finally(() => {
              jobsActive.add(-1);

              // Send final metrics snapshot on job completion
              metricsReporter.collectAndSend().catch(() => {});

              // After job completes, send agent.status with updated counts
              sendAgentStatus();

              // Workflow-level host restart: a `restartHost()` step recorded the
              // intent (and the orchestrator already holds the pinned
              // post-restart job). Now that the job is fully reported, issue the
              // OS reboot. On failure (privilege denied), ask the orchestrator
              // to clear its reboot-pending flag so the host is not stuck — the
              // deadline sweep is the backstop.
              if (rebootIntent) {
                rebootIntent = false;
                issueReboot().catch((err) => {
                  logger.error('Host reboot failed; cancelling reboot-pending flag', {
                    error: toErrorMessage(err),
                  });
                  client.sendApiRequest('host.cancelReboot', {}).catch(() => {
                    /* best-effort; the deadline sweep clears the flag otherwise */
                  });
                });
              }

              // Scaler-managed agents auto-shutdown after all jobs complete.
              // Brief idle timeout allows the orchestrator to dispatch follow-up jobs
              // (e.g., sequential builds for multiple workflows triggered by the same commit).
              if (config.scalerManaged && jobRunner.activeJobs.size === 0) {
                // Don't start idle timer when disconnected -- wait for reconnection first.
                // The orchestrator may dispatch follow-up jobs after the agent reconnects.
                if (client.state !== 'registered') {
                  logger.info(
                    'Scaler-managed agent idle but disconnected, deferring shutdown until reconnected',
                  );
                  return; // onRegistered callback will re-evaluate
                }
                startIdleShutdownTimer();
              }
            });
        },
      );
    },

    onJobCancel: (cancel: JobCancel) => {
      logger.info('Job cancel received', {
        jobId: cancel.jobId,
        reason: cancel.reason,
      });
      jobRunner.cancel(cancel.jobId, cancel.reason, cancel.force ?? false);
    },

    getInFlightJobs: () => {
      return Array.from(jobRunner.activeJobs.entries()).map(([jobId, active]) => ({
        jobId,
        runId: active.runId,
      }));
    },
    roles: config.roles,
  });

  // 5b. Helper: start the idle shutdown timer for scaler-managed agents.
  // Extracted so both the .finally() handler and onRegistered callback can use it.
  function startIdleShutdownTimer(): void {
    const idleMs = config.scalerIdleTimeoutMs;
    if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
    if (idleMs <= 0) {
      logger.info('Scaler-managed agent idle after job completion, shutting down');
      gracefulShutdown('scaler-idle');
    } else {
      logger.info(`Scaler-managed agent idle, waiting ${idleMs}ms for follow-up jobs`);
      idleShutdownTimer = setTimeout(() => {
        if (jobRunner.activeJobs.size === 0) {
          logger.info('Scaler-managed agent still idle after timeout, shutting down');
          gracefulShutdown('scaler-idle');
        }
      }, idleMs);
    }
  }

  // 5c. Hook into onRegistered callback to re-evaluate idle shutdown after reconnection.
  // When a scaler-managed agent reconnects, it should check if it's still idle and
  // start the idle shutdown timer (the timer was deferred during disconnection).
  //
  // Exception: when register.ack carries `pendingDispatch: true`, the orchestrator
  // has already pre-bound a queued job to this agent and is preparing the
  // dispatch.job message. The work between register.ack and dispatch.job send
  // (provider lookup, secret merging, upstream output resolution for jobs with
  // `needs:`) can take several seconds — well past the default 5s scaler-idle
  // timer. Arming the timer here would race the dispatch and kill the agent
  // before the job arrives. Defer to a much longer safety timeout instead; the
  // actual dispatch.job will cancel the timer (server.ts:165-168) when it arrives.
  client.onRegistered = ({ pendingDispatch }) => {
    if (!config.scalerManaged || jobRunner.activeJobs.size > 0) {
      return;
    }
    if (pendingDispatch) {
      const safetyMs = config.scalerPendingDispatchTimeoutMs;
      logger.info(
        `Scaler-managed agent registered with pending bound dispatch, deferring idle shutdown for ${safetyMs}ms`,
      );
      if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
      idleShutdownTimer = setTimeout(() => {
        if (jobRunner.activeJobs.size === 0) {
          logger.warn(
            'Scaler-managed agent pending-dispatch safety timeout exceeded, shutting down',
          );
          gracefulShutdown('scaler-pending-dispatch-timeout');
        }
      }, safetyMs);
      return;
    }
    logger.info('Scaler-managed agent reconnected and idle, starting idle shutdown timer');
    startIdleShutdownTimer();
  };

  // 6. Add WS log transport for all agents.
  // WS streaming is the authoritative path: it delivers structured JSON log lines to
  // the orchestrator even when the agent's stdout is buffered or otherwise unreliable
  // (e.g. Firecracker's serial-console path goes through Rust BufWriter + jailer uid
  // drop, which can swallow short-lived diagnostic output). For scaler-managed agents
  // on container / bare-metal backends this causes mild duplication with the
  // orchestrator's LogCapture of stdout, which is acceptable — WS is canonical.
  const wsTransport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, _encoding, callback) {
        client.streamLog(chunk.toString().trimEnd());
        callback();
      },
    }),
    // Use JSON format (always, regardless of TTY) for structured log forwarding
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  });
  logger.add(wsTransport);

  // 6b. Diagnostic: forwarded-env probe. Operators / E2E can set
  // KICI_AGENT_ENV_KICI_FC_ENV_PROBE (or any var matching the KICI_*_ENV_PROBE
  // pattern) on the process that spawns agents; it flows through the scaler's
  // env-forwarding path and lands in the agent's process.env. Logging it here
  // — with the value redacted unless length <= 64 chars — proves end-to-end
  // delivery. Emitted AFTER wsTransport is attached so the line is captured by
  // the WS log path; pre-registration lines are buffered in LogBuffer and
  // replayed on registration. Serial-console output (Firecracker) is block-
  // buffered and unreliable for sparse writes, so WS is canonical. Intentionally
  // allowlisted by the _ENV_PROBE suffix so this log never leaks real secrets.
  const envProbes: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (!/_ENV_PROBE$|_ENV_PROBE_/.test(k)) continue;
    envProbes[k] = v.length <= 64 ? v : `${v.slice(0, 61)}...`;
  }
  if (Object.keys(envProbes).length > 0) {
    logger.info('Agent startup env probes (diagnostic)', envProbes);
  }

  // 7. Connect to orchestrator
  client.connect();
  connectionStatus.add(1);

  // 7b. Start periodic metrics reporter (pushes OTel metrics to orchestrator every 30s)
  const metricsReporter = new MetricsReporter({
    agentId: config.agentId,
    send: (msg) => client.sendDirect(msg),
  });
  metricsReporter.start();

  // 8. Create Hono app with health routes
  const app = new Hono();

  const healthRoutes = createHealthRoutes({
    getMetrics: async () => ({ contentType: 'text/plain', body: await serializeAgentMetrics() }),
    getStatus: () => ({
      agentId: config.agentId,
      connected: client.state === 'registered',
      activeJobs: jobRunner.activeJobs.size,
    }),
  });

  app.route('/', healthRoutes);

  // 9. Start HTTP server
  const httpServer = serve(
    {
      fetch: app.fetch,
      port: config.port,
    },
    (info) => {
      logger.info(`Agent started on port ${info.port}`, {
        port: info.port,
        agentId: config.agentId,
      });
    },
  );

  // -- Graceful shutdown --

  const { shutdown: gracefulShutdown } = setupGracefulShutdown({
    logger,
    timeoutMs: 10_000,
    onForceExit: () => {
      // Kill remaining child processes
      for (const job of jobRunner.activeJobs.values()) {
        job.abortController.abort();
      }
      // Give 1s for abort handlers, then exit
      setTimeout(() => process.exit(1), 1000);
      return true; // suppress default process.exit — we handle it after abort delay
    },
    steps: [
      {
        name: 'Entering drain mode',
        fn: () => {
          isDraining = true;
        },
      },
      {
        name: 'Waiting for active jobs to complete',
        fn: async () => {
          if (jobRunner.activeJobs.size > 0) {
            logger.info('Active jobs remaining', { activeJobs: jobRunner.activeJobs.size });
            await Promise.allSettled(
              [...jobRunner.activeJobs.values()].map((j) => j.completionPromise),
            );
          }
        },
      },
      {
        name: 'Stopping metrics reporter',
        fn: async () => {
          metricsReporter.stop();
          await metricsReporter.collectAndSend().catch(() => {});
        },
      },
      {
        name: 'Disconnecting from orchestrator',
        fn: () => {
          connectionStatus.add(-1);
          client.disconnect();
        },
      },
      {
        name: 'Stopping HTTP server',
        fn: () =>
          new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
          }),
      },
      {
        // In Firecracker VMs the agent runs as PID 1. process.exit() triggers a
        // kernel panic which kills the TCP stack before the WS close frame can be
        // flushed to the host. A brief delay ensures the orchestrator receives the
        // disconnect and doesn't dispatch new jobs to a dead agent.
        name: 'Flushing network buffers',
        fn: async () => {
          if (config.scalerManaged) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        },
      },
    ],
  });

  // -- Drain mode (SIGUSR1) --

  process.on('SIGUSR1', () => {
    logger.info('Received SIGUSR1, entering drain mode');
    isDraining = true;

    // If no active jobs, shut down immediately
    if (jobRunner.activeJobs.size === 0) {
      logger.info('No active jobs, shutting down immediately');
      gracefulShutdown('SIGUSR1-drain');
      return;
    }

    // Otherwise, poll until drained
    const checkDrained = setInterval(() => {
      if (jobRunner.activeJobs.size === 0) {
        clearInterval(checkDrained);
        logger.info('All jobs drained, shutting down');
        gracefulShutdown('SIGUSR1-drain');
      }
    }, 1000);
  });
});
