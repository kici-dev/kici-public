import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars, LOGGER_ENV_VARS } from '@kici-dev/shared/env';
import {
  KNOWN_ROLES,
  parseHostPropertyAssignments,
  validateNoReservedLabels,
} from '@kici-dev/engine';

/** Execution mode for the agent's sandbox backend. Mirrors the runtime enum. */
export const ExecutionMode = z.enum(['container', 'bare-metal', 'firecracker']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

const configSchema = z.object({
  orchestratorUrl: z.string().url().min(1, 'KICI_ORCHESTRATOR_URL is required'),
  agentId: z.string().optional(),
  labels: z
    .string()
    .default('')
    .transform((s) => s.split(',').filter(Boolean)),
  // Typed host-vars reported at registration (the inventory `properties` bag),
  // shallow-merged into the orchestrator's host roster. Comma-separated
  // key=value pairs; values are typed (true/false ⇒ boolean, numeric ⇒ number,
  // otherwise string). e.g. "region=eu,cores=8,gpu=true".
  properties: z
    .string()
    .default('')
    .transform((s) => parseHostPropertyAssignments(s.split(',').filter(Boolean))),
  roles: z
    .string()
    .optional()
    .transform((s) => {
      if (s === undefined) return undefined; // unset = all
      if (s === '') return []; // empty string = execution only
      return s.split(',').filter(Boolean);
    })
    .refine(
      (roles) => {
        if (roles === undefined) return true;
        const validValues = [...KNOWN_ROLES, 'all'];
        return roles.every((r) => validValues.includes(r));
      },
      { message: `KICI_ROLES must contain only: ${[...KNOWN_ROLES, 'all'].join(', ')}` },
    )
    .transform((roles) => {
      if (roles === undefined) return undefined;
      if (roles.includes('all')) return undefined;
      if (roles.length === 0) return [];
      return roles.filter((r) => r !== 'all');
    }),
  port: z.coerce.number().default(8080),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  agentToken: z.string().optional(),
  githubToken: z.string().optional(),
  maxLogSizeBytes: z.coerce.number().default(10 * 1024 * 1024), // 10MB
  defaultStepTimeoutMs: z.coerce.number().default(30 * 60 * 1000), // 30 minutes
  dockerKeepFailed: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  jobHeartbeatIntervalMs: z.coerce.number().default(60_000),
  backpressureMode: z.enum(['pause', 'drop']).default('pause'),
  sandbox: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // 'isolated' (default when sandbox=true): bwrap --unshare-net, loopback only,
  // strongest isolation, but breaks workflows that need to talk to npm/git/etc.
  // 'host': keep host network namespace, allow outbound traffic. Use this when
  // workflows must reach package registries or external services.
  sandboxNetwork: z.enum(['isolated', 'host']).default('isolated'),
  // Scaler integration. The auto-scaler injects KICI_SCALER_MANAGED=1 into
  // every ephemeral agent it spawns; the agent uses these to know when it
  // should self-shutdown after going idle.
  scalerManaged: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  scalerIdleTimeoutMs: z.coerce.number().default(5_000),
  scalerPendingDispatchTimeoutMs: z.coerce.number().default(60_000),
  // Explicit execution-mode override. Optional — when unset, the runner picks
  // 'container' / 'firecracker' / 'bare-metal' from job dispatch + scaler
  // signals (see execution/job-runner.ts#determineExecutionMode).
  executionMode: ExecutionMode.optional(),
  // OpenTelemetry exporter endpoint (optional; consumed by initTelemetry).
  otelExporterOtlpEndpoint: z.string().optional(),
  // Maximum time the workflow-runner waits for a follow-up `concurrency.ack`
  // after receiving `{ action: 'wait' }`. Default 1 hour. Inherited by the
  // workflow-runner child process via env.
  concurrencyWaitTimeoutMs: z.coerce.number().int().min(1000).default(3_600_000),
});

/**
 * App configuration type. Includes computed agentId when not provided.
 */
export type AppConfig = z.infer<typeof configSchema> & {
  /** Unique identifier for this agent instance */
  agentId: string;
};

/**
 * Env-var definition for the agent. Exported so the docs generator and the
 * deploy-stg pre-validator can inspect / re-parse without round-tripping
 * through process.env.
 */
export const envDef = defineEnv({
  service: 'agent',
  schema: configSchema,
  envMap: {
    orchestratorUrl: 'KICI_ORCHESTRATOR_URL',
    agentId: 'KICI_AGENT_ID',
    labels: 'KICI_LABELS',
    properties: 'KICI_PROPERTIES',
    roles: 'KICI_ROLES',
    port: 'KICI_PORT',
    logLevel: 'KICI_LOG_LEVEL',
    agentToken: 'KICI_AGENT_TOKEN',
    githubToken: 'KICI_GITHUB_TOKEN',
    maxLogSizeBytes: 'KICI_MAX_LOG_SIZE_BYTES',
    defaultStepTimeoutMs: 'KICI_DEFAULT_STEP_TIMEOUT_MS',
    dockerKeepFailed: 'KICI_DOCKER_KEEP_FAILED',
    jobHeartbeatIntervalMs: 'KICI_JOB_HEARTBEAT_INTERVAL_MS',
    backpressureMode: 'KICI_BACKPRESSURE_MODE',
    sandbox: 'KICI_SANDBOX',
    sandboxNetwork: 'KICI_SANDBOX_NETWORK',
    scalerManaged: 'KICI_SCALER_MANAGED',
    scalerIdleTimeoutMs: 'KICI_SCALER_IDLE_TIMEOUT',
    scalerPendingDispatchTimeoutMs: 'KICI_SCALER_PENDING_DISPATCH_TIMEOUT',
    executionMode: 'KICI_EXECUTION_MODE',
    otelExporterOtlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    concurrencyWaitTimeoutMs: 'KICI_CONCURRENCY_WAIT_TIMEOUT_MS',
  },
});

/**
 * Load and validate agent configuration from environment variables.
 *
 * Maps env vars with KICI_ prefix:
 * - KICI_ORCHESTRATOR_URL (required)
 * - KICI_AGENT_ID (optional, auto-generated from hostname-uuid8)
 * - KICI_LABELS (comma-separated, e.g. "linux,docker"). Labels with 'kici-' prefix are reserved.
 * - KICI_PROPERTIES (comma-separated key=value host-vars, e.g. "region=eu,cores=8,gpu=true"). Typed (bool/number/string), reported into the host roster.
 * - KICI_ROLES (comma-separated agent roles, e.g. "builder,init-runner". undefined=all, empty=execution-only)
 * - KICI_PORT (default: 8080)
 * - KICI_LOG_LEVEL (default: info)
 * - KICI_AGENT_TOKEN (optional, kat_ prefixed PSK for orchestrator authentication)
 * - KICI_GITHUB_TOKEN (optional)
 * - KICI_MAX_LOG_SIZE_BYTES (default: 10MB)
 * - KICI_DEFAULT_STEP_TIMEOUT_MS (default: 30 min)
 * - KICI_DOCKER_KEEP_FAILED (default: false)
 * - KICI_JOB_HEARTBEAT_INTERVAL_MS (default: 60000)
 * - KICI_BACKPRESSURE_MODE (default: pause, options: pause | drop)
 * - KICI_SANDBOX (default: false) — enable bubblewrap (bwrap) namespace isolation for bare-metal execution
 * - KICI_SANDBOX_NETWORK (default: isolated, options: isolated | host) — when sandbox=true, controls bwrap network namespace
 * - KICI_SCALER_MANAGED (set to "1" by the orchestrator's auto-scaler — agent self-shuts down on idle)
 * - KICI_SCALER_IDLE_TIMEOUT (ms, default 5000) — how long a scaler-managed agent waits before shutdown after going idle
 * - KICI_SCALER_PENDING_DISPATCH_TIMEOUT (ms, default 60000) — extended idle window when register.ack signals a queued bound job
 * - KICI_EXECUTION_MODE (optional, options: container | bare-metal | firecracker) — override the runner's mode-pick logic
 * - KICI_CONCURRENCY_WAIT_TIMEOUT_MS (default: 3_600_000) — workflow-runner timeout when long-polling for a slot-release follow-up `concurrency.ack`
 */
export function loadConfig(): AppConfig {
  const data = envDef.parse();

  // Validate no reserved kici:* prefix in user-provided labels.
  // Skip validation for scaler-managed agents since the orchestrator's scaler
  // injects kici:role:* labels into KICI_LABELS automatically.
  if (!data.scalerManaged) {
    validateNoReservedLabels(data.labels, 'KICI_LABELS');
  }

  // Reject typo'd KICI_* env vars — drift catcher. Adds the logger's vars
  // (KICI_LOG_DIR, KICI_LOG_MAX_SIZE, …) to the known set so they don't trip
  // the unknown-var check.
  validateUnknownKiciVars([...envDef.listKnownEnvVars(), ...LOGGER_ENV_VARS]);

  return {
    ...data,
    agentId: data.agentId ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
  };
}

/**
 * Connection/identity options for the orchestrator WebSocket client, derived
 * purely from config.
 *
 * The agent entry point spreads this into `new OrchestratorClient({ ... })`
 * alongside its dispatch/cancel handler closures. Keeping `token` here — next
 * to the other required connection fields — guarantees it travels with the
 * connection: when `KICI_AGENT_TOKEN` is set the client sends `auth.request`
 * (token mode); when it is absent the client falls back to `agent.register`
 * (unauthenticated mode).
 */
export function agentClientConnectionOptions(config: AppConfig) {
  return {
    url: config.orchestratorUrl,
    agentId: config.agentId,
    labels: config.labels,
    properties: config.properties,
    scalerManaged: config.scalerManaged,
    token: config.agentToken,
  };
}
