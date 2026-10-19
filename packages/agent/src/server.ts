/**
 * Agent entry point.
 *
 * Graceful shutdown:
 * - SIGTERM/SIGINT: 10s grace for running jobs, then force-kill
 * - SIGUSR1: drain mode (stop accepting, finish current, exit)
 */

// First import: applies the env file a Windows service names in KICI_ENV_FILE
// before any other module reads the environment.
import '@kici-dev/shared/load-service-env-file';

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
  applyProxyKeepAliveTimeouts,
} from '@kici-dev/shared';
import type { JobDispatch, JobCancel } from '@kici-dev/engine';
import {
  loadConfig,
  agentClientConnectionOptions,
  scrubCredentialEnv,
  describeExposedPosture,
} from './config.js';
import { OrchestratorClient } from './ws/orchestrator-client.js';
import { installConsoleCapture } from './execution/console-capture.js';
import { createHealthRoutes } from './routes/health.js';
import { MetricsReporter } from './metrics/metrics-reporter.js';
import { verifyNpmAvailable } from './execution/npm-resolver.js';
import { gcStaleAgentTmpDirs } from './execution/tmp-gc.js';
import { issueReboot } from './execution/reboot.js';
import { decideIdleShutdown, idleShutdownDelayMs } from './idle-shutdown.js';
import { agentToolRequirements } from './required-tools.js';
import { pidOneWarning } from './pid-one.js';
import { handleAgentCliArgs } from './cli-args.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs). The SDK
// drift diagnostic compares the baked sdkBundleHash against the orchestrator's /health.
declare const KICI_PKG_VERSION: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

const AGENT_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown';
const SDK_VERSION = typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown';
const SDK_BUNDLE_HASH =
  typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown';
const SHARED_VERSION = typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : 'unknown';
const SHARED_BUNDLE_HASH =
  typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : 'unknown';
const ENGINE_VERSION = typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : 'unknown';
const ENGINE_BUNDLE_HASH =
  typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : 'unknown';

// --help / --version / an unknown argument exit here, before telemetry or config.
handleAgentCliArgs(process.argv.slice(2));

// OTel must initialize before any module that creates meters at load time. ESM
// static imports are hoisted, so those modules (./metrics/prometheus.js, and
// ./execution/job-runner.js via log-streamer.ts) are imported dynamically below.
// Same pattern as packages/orchestrator/src/server.ts.
initTelemetry({
  serviceName: 'kici-agent',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const { connectionStatus, jobsActive, jobsTotal } = await import('./metrics/prometheus.js');
const { JobRunner } = await import('./execution/job-runner.js');
const { BetweenJobsController } = await import('./execution/between-jobs-controller.js');

setServiceName('agent');
const logger = createLogger({ prefix: 'agent' });

/**
 * Consecutive between-jobs reset failures after which a `drainOnResetFailure`
 * agent drains — a persistently dirty host stops taking work rather than
 * running every subsequent job against unclean state.
 */
const RESET_FAILURE_DRAIN_THRESHOLD = 3;

/**
 * Serialize current Prometheus metrics to text, or '' with no exporter. The
 * PrometheusExporter has no serialize method, so this pipes its request handler
 * into a mock ServerResponse.
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

// Routes console output of in-process jobs (__init__, __build__, __dynamic__)
// to the dashboard via AsyncLocalStorage.
installConsoleCapture();

await guardStartup(logger, async () => {
  const config = loadConfig();
  // Credentials now live in `config`; scrub them so a job step cannot read
  // them from /proc/<agent-pid>/environ.
  const scrubbedEnvVars = scrubCredentialEnv();
  const exposedPosture = describeExposedPosture(config);
  if (exposedPosture) logger.warn(exposedPosture);
  logger.info('Agent starting', {
    scrubbedEnvVars,
    agentId: config.agentId,
    orchestratorUrl: config.orchestratorUrl,
    labels: config.labels,
    roles: config.roles,
    port: config.port,
  });

  // Collect temp dirs leaked by an earlier hard death (SIGKILL/OOM) of an agent
  // on this host. Fire-and-forget: startup must not wait.
  void gcStaleAgentTmpDirs();

  // SDK drift diagnostic (docs/operator/troubleshooting.md): comparing
  // sdkBundleHash across services catches a bundle built with a different
  // @kici-dev/sdk before the first workflow runs.
  logger.info('agent.build.info', {
    agentVersion: AGENT_VERSION,
    sdkVersion: SDK_VERSION,
    sdkBundleHash: SDK_BUNDLE_HASH,
    sharedVersion: SHARED_VERSION,
    sharedBundleHash: SHARED_BUNDLE_HASH,
    engineVersion: ENGINE_VERSION,
    engineBundleHash: ENGINE_BUNDLE_HASH,
  });

  const toolErrors = validateRequiredTools(agentToolRequirements(process.platform));
  if (toolErrors.length > 0) {
    // A job-image agent runs inside the customer's image, so a missing tool is
    // that image's fault, not the host's. Without the hint the symptom is a job
    // stuck queued while the scaler respawns a container that exits at startup.
    const jobImageHint = config.jobImageAgent
      ? `\nThis agent runs inside the job's own container image, so that image must ` +
        `provide these tools. Either add them to the image, or run the job on a pool ` +
        `whose agent stays outside it.`
      : '';
    throw new Error(
      'Agent required-tools validation failed:\n' +
        toolErrors.map((e) => `  - ${e}`).join('\n') +
        jobImageHint,
    );
  }

  // Builder agents run `npm install` for .kici/ deps before compiling; fail fast
  // at startup rather than in every build job when npm is missing.
  const hasBuilderRole = config.roles === undefined || config.roles.includes('builder');
  if (hasBuilderRole) {
    const npmVersion = verifyNpmAvailable();
    logger.info('Builder role: npm verified', { npmVersion });
  }

  let isDraining = false;
  // A single-job agent has accepted its one job (KICI_SCALER_SINGLE_JOB).
  let servedJob = false;
  let idleShutdownTimer: NodeJS.Timeout | undefined;

  // Set by a `restartHost()` step's acked `host.requestReboot` call (the
  // orchestrator already holds its reboot-pending flag); the post-job hook
  // issues the OS reboot and clears it so a follow-up job does not re-reboot.
  let rebootIntent = false;

  // Forward reference: JobRunner and the client reference each other.
  let client: OrchestratorClient;

  // Between-jobs phase: reap the process tree, re-run declared cleanup
  // out-of-band, delete the workdir, run the operator reset command. Held here
  // so job completion can read its consecutive-reset-failure count.
  const betweenJobsController = new BetweenJobsController({
    config: {
      betweenJobsResetCommand: config.betweenJobsResetCommand,
      betweenJobsResetTimeoutMs: config.betweenJobsResetTimeoutMs,
      betweenJobsResetRunOn: config.betweenJobsResetRunOn,
      orphanCleanup: config.orphanCleanup,
      drainOnResetFailure: config.drainOnResetFailure,
    },
  });

  const jobRunner = new JobRunner({
    send: (msg) => client.send(msg),
    config,
    betweenJobsController,
    requestUploadUrl: (jobId, cacheType, key) => client.requestUploadUrl(jobId, cacheType, key),
    sendUploadComplete: (jobId, cacheType, key) => client.sendUploadComplete(jobId, cacheType, key),
    sendEventEmit: (jobId, requestId, eventName, payload, target) =>
      client.sendEventEmit(jobId, requestId, eventName, payload, target),
    // LogStreamer backpressure: checks the WS buffer and waits for drain.
    getBufferedAmount: () => client.getBufferedAmount(),
    onDrain: (cb) => client.onDrain(cb),
    // Lifecycle events forwarded to orchestrator -> Platform.
    sendJobContext: (runId, jobId, context) => client.sendJobContext(runId, jobId, context),
    sendRunEvent: (runId, eventType, opts) => client.sendRunEvent(runId, eventType, opts),
    // Waits for the orchestrator's ack.
    sendConcurrencyReport: (runId, jobId, group) =>
      client.sendConcurrencyReport(runId, jobId, group),
    // host.requestReboot is refused locally when co-located with the
    // orchestrator, and records the reboot intent on a successful ack.
    sendApiRequest: async (method, params) => {
      if (method === 'host.requestReboot') {
        if (config.isOrchestratorHost) {
          throw new Error('refusing to reboot the orchestrator host');
        }
        const result = await client.sendApiRequest(method, params ?? {});
        rebootIntent = true;
        return result;
      }
      // The minted token must not travel the generic agent.api.* envelope or be
      // logged, so scaler.claim-credentials uses its own dedicated WS message.
      if (method === 'scaler.claim-credentials') {
        const claimCode = String((params ?? {}).claimCode ?? '');
        const r = await client.sendClaimCredentials(claimCode);
        if (r.error) {
          throw new Error(r.error);
        }
        return r.credentials;
      }
      return client.sendApiRequest(method, params ?? {});
    },
    requestUserCache: (jobId, request) => client.requestUserCache(jobId, request),
    relayProvenance: (jobId, request) => client.relayProvenance(jobId, request),
    requestUserArtifact: (jobId, request) => client.requestUserArtifact(jobId, request),
    sendStepApproval: (runId, jobId, request) => client.sendStepApproval(runId, jobId, request),
  });

  function sendAgentStatus(): void {
    client.sendDirect({
      type: 'agent.status',
      messageId: randomUUID(),
      agentId: config.agentId,
      activeJobs: jobRunner.activeJobs.size,
      memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
      memoryAvailableMb: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds: Math.round(os.uptime()),
      ...(isDraining && { draining: true }),
    });
  }

  // agentClientConnectionOptions carries the auth token, so KICI_AGENT_TOKEN
  // always reaches the client.
  client = new OrchestratorClient({
    ...agentClientConnectionOptions(config),
    // Exchanged for ephemeral credentials before registering; ignored when a
    // static token is set.
    scalerClaimCode: config.scalerClaimCode,
    // The config is redacted inside the bundle assembler.
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

          // One job at a time. An explicit job.reject lets the orchestrator
          // requeue immediately; a silent drop would leave the job bound to this
          // agent until disconnect.
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

          if (idleShutdownTimer) {
            clearTimeout(idleShutdownTimer);
            idleShutdownTimer = undefined;
          }

          // Resolves the orchestrator's ack deadline; sent before execution so a
          // slow clone cannot eat into it.
          client.sendDirect({
            type: 'job.ack',
            messageId: randomUUID(),
            runId: dispatch.runId,
            jobId: dispatch.jobId,
            timestamp: Date.now(),
          });

          // A single-job agent stops taking work the moment it accepts its job,
          // and says so, so the orchestrator never offers it a second one.
          if (config.scalerSingleJob) {
            servedJob = true;
            isDraining = true;
            sendAgentStatus();
          }

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

              metricsReporter.collectAndSend().catch(() => {});

              // Opt-in (KICI_AGENT_DRAIN_ON_RESET_FAILURE): drain a persistently
              // dirty host, the same way SIGUSR1 drains.
              if (
                config.drainOnResetFailure &&
                !isDraining &&
                betweenJobsController.consecutiveResetFailures >= RESET_FAILURE_DRAIN_THRESHOLD
              ) {
                logger.warn('Draining agent after repeated between-jobs reset failures', {
                  consecutive: betweenJobsController.consecutiveResetFailures,
                });
                isDraining = true;
              }

              sendAgentStatus();

              // Reboot only once the job is fully reported (the orchestrator
              // already holds the pinned post-restart job). On failure (privilege
              // denied), ask it to clear its reboot-pending flag; the deadline
              // sweep is the backstop.
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

              // Scaler-managed agents shut down when idle. The idle timeout leaves
              // room for follow-up jobs (e.g. sequential builds for several
              // workflows triggered by the same commit).
              if (config.scalerManaged && jobRunner.activeJobs.size === 0) {
                // While disconnected, wait: follow-up jobs may arrive after reconnect.
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

  function startIdleShutdownTimer(): void {
    const idleMs = idleShutdownDelayMs({
      scalerIdleTimeoutMs: config.scalerIdleTimeoutMs,
      singleJob: config.scalerSingleJob,
      servedJob,
    });
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

  // On (re)registration, an idle scaler-managed agent arms the idle timer it
  // deferred while disconnected. Two register.ack flags override that:
  // - `warmPool`: the agent waits for work, not a queued job; the warm-pool
  //   reaper owns its lifetime, so any timer here would cycle the pool.
  // - `pendingDispatch`: the orchestrator pre-bound a queued job, and preparing
  //   dispatch.job (provider lookup, secret merging, `needs:` outputs) can take
  //   longer than the default 5s idle timer. A much longer safety timeout
  //   applies instead; the dispatch handler cancels it when the job arrives.
  // `decideIdleShutdown` holds the branch choice so tests share it.
  client.onRegistered = ({ pendingDispatch, warmPool }) => {
    // A fresh registration is never draining on the orchestrator side; say it
    // again, so a reconnect mid-job does not reopen a single-job agent (or a
    // SIGUSR1 drain) to new work.
    if (isDraining) sendAgentStatus();
    const decision = decideIdleShutdown({
      scalerManaged: config.scalerManaged,
      activeJobs: jobRunner.activeJobs.size,
      pendingDispatch,
      warmPool,
      singleJobServed: config.scalerSingleJob && servedJob,
    });
    if (decision === 'none') {
      return;
    }
    if (decision === 'warm') {
      logger.info('Warm-pool agent registered and ready, awaiting work');
      if (idleShutdownTimer) {
        clearTimeout(idleShutdownTimer);
        idleShutdownTimer = undefined;
      }
      return;
    }
    if (decision === 'pending-dispatch') {
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

  // WS log streaming is canonical for all agents: stdout can be unreliable (the
  // Firecracker serial console goes through Rust BufWriter + jailer uid drop and
  // can swallow short-lived output). Container / bare-metal backends get mild,
  // accepted duplication with the orchestrator's stdout LogCapture.
  const wsTransport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, _encoding, callback) {
        client.streamLog(chunk.toString().trimEnd());
        callback();
      },
    }),
    // Always JSON, regardless of TTY.
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  });
  logger.add(wsTransport);

  // Forwarded-env probe: a var matching KICI_*_ENV_PROBE (e.g.
  // KICI_AGENT_ENV_KICI_FC_ENV_PROBE) set on the spawning process reaches here
  // through the scaler's env forwarding; logging it proves end-to-end delivery.
  // Values over 64 chars are truncated. Logged after wsTransport is attached so
  // the WS path carries it (pre-registration lines are buffered in LogBuffer and
  // replayed). Only _ENV_PROBE-named vars are logged, so no real secret leaks.
  const envProbes: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (!/_ENV_PROBE$|_ENV_PROBE_/.test(k)) continue;
    envProbes[k] = v.length <= 64 ? v : `${v.slice(0, 61)}...`;
  }
  if (Object.keys(envProbes).length > 0) {
    logger.info('Agent startup env probes (diagnostic)', envProbes);
  }

  // Emitted after the WS transport is attached, like the env probes, so the
  // warning reaches the orchestrator log.
  const pidOne = pidOneWarning(process.pid);
  if (pidOne) logger.warn(pidOne);

  client.connect();
  connectionStatus.add(1);

  // Pushes OTel metrics to the orchestrator every 30s.
  const metricsReporter = new MetricsReporter({
    agentId: config.agentId,
    send: (msg) => client.sendDirect(msg),
  });
  metricsReporter.start();

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

  const httpServer = applyProxyKeepAliveTimeouts(
    serve(
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
    ),
  );

  // -- Graceful shutdown --

  const { shutdown: gracefulShutdown } = setupGracefulShutdown({
    logger,
    timeoutMs: 10_000,
    onForceExit: () => {
      for (const job of jobRunner.activeJobs.values()) {
        job.abortController.abort();
      }
      // 1s for abort handlers, then exit.
      setTimeout(() => process.exit(1), 1000);
      return true; // suppress the default process.exit; exit after the abort delay
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
        // In Firecracker the agent is PID 1, so process.exit() panics the kernel
        // and kills the TCP stack before the WS close frame flushes. The delay
        // lets the orchestrator see the disconnect and stop dispatching here.
        name: 'Flushing network buffers',
        fn: async () => {
          if (config.scalerManaged) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        },
      },
    ],
  });

  // A self-bootstrap agent (KICI_SCALER_CLAIM_CODE set, no static token) whose
  // claim fails permanently (invalid, expired or consumed code, or an
  // errored/timed-out exchange) can never register; a claim can legitimately
  // expire before a GitHub-hosted runner starts. Exit non-zero through graceful
  // shutdown, or the health server keeps the run hanging until the job timeout.
  client.onClaimFailedPermanently = (reason) => {
    logger.error('Self-bootstrap claim failed permanently, shutting down', { reason });
    void gracefulShutdown('scaler-claim-failed', 1);
  };

  // The client never reconnects after an auth.failure frame or auth-failed close
  // code (revoked token, or an agent below the protocol floor). Exit non-zero so
  // a service manager reports it and a one-shot scaler runner is released,
  // rather than idling behind a healthy-looking HTTP server.
  client.onAuthFailedPermanently = (reason) => {
    logger.error('Authentication failed permanently, shutting down', { reason });
    void gracefulShutdown('auth-failed', 1);
  };

  // -- Drain mode (SIGUSR1) --

  process.on('SIGUSR1', () => {
    logger.info('Received SIGUSR1, entering drain mode');
    isDraining = true;
    // Tell the orchestrator, so it stops offering jobs this agent would reject.
    sendAgentStatus();

    if (jobRunner.activeJobs.size === 0) {
      logger.info('No active jobs, shutting down immediately');
      gracefulShutdown('SIGUSR1-drain');
      return;
    }

    const checkDrained = setInterval(() => {
      if (jobRunner.activeJobs.size === 0) {
        clearInterval(checkDrained);
        logger.info('All jobs drained, shutting down');
        gracefulShutdown('SIGUSR1-drain');
      }
    }, 1000);
  });
});
