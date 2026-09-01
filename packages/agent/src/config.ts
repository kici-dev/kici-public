import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars, LOGGER_ENV_VARS } from '@kici-dev/shared/env';
import {
  KNOWN_ROLES,
  parseHostPropertyAssignments,
  validateNoReservedLabels,
} from '@kici-dev/engine';
import { ContainerBuildCli } from './execution/image-build/build-engine.js';

/** Execution mode for the agent's sandbox backend. Mirrors the runtime enum. */
export const ExecutionMode = z.enum(['container', 'bare-metal', 'firecracker']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/** When the operator between-jobs reset command runs. */
export const BetweenJobsRunOn = z.enum(['always', 'on-failure']);
export type BetweenJobsRunOn = z.infer<typeof BetweenJobsRunOn>;

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
  // Local directory holding version-keyed self-contained agent payloads
  // (`<dir>/<version>/kici-agent-<platform>.tar.gz`), produced by
  // `kici-admin agent package`. When set, an ops agent stages the matching
  // payload onto a bare box during bring-up so it boots with no system Node.
  agentPayloadDir: z.string().optional(),
  // Golden-image escape hatch: a fixed command to start the init-runner on a
  // bring-up target that already ships `kici-agent` + a Node runtime at a known
  // path. When set, payload staging is skipped. Leave unset for a stock rescue
  // box (a payload dir is staged instead).
  agentCommand: z.string().optional(),
  sandbox: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Trusted fleet-agent execution profile (default false). When true, the step
  // sandbox passes the ambient host env through (minus the agent's own KiCI
  // identity/operational secrets) instead of restricting to the system-var
  // allowlist. Orthogonal to KICI_SANDBOX (bwrap namespace isolation). Set ONLY
  // by the operator at agent/scaler launch — never derivable from a dispatch
  // payload or workflow. Intended for trusted host-configuration / fleet agents.
  trustedEnv: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // In-place no-clone execution profile (default false). When true, and the
  // dispatched source is a `file://` local source, the agent uses the source's
  // real repo path as the job workDir and skips the git clone (checkout=false)
  // instead of cloning into a throwaway tmpdir. This lets an operator run their
  // own already-built working tree directly (module-relative paths, node_modules,
  // dist all present) — the profile KiCI's own routed `deploy:stg` uses. Gated to
  // `file://` sources and set ONLY by the operator at agent/scaler launch (the
  // local dev plane's trusted+in-place label set) — never derivable from a
  // dispatch payload, so a Platform-connected agent (https sources) can never be
  // pushed onto the operator's tree.
  inPlace: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Sandbox network posture for BOTH backends.
  // 'isolated' (default): bwrap --unshare-net (loopback only, strongest
  // isolation, breaks workflows that need npm/git/etc.); the container backend
  // keeps the runtime default bridge (egress works).
  // 'host': keep the host network namespace and allow outbound traffic — use
  // when workflows must reach package registries or external services. On the
  // container backend this also binds the host /etc/hosts read-only so a
  // host-resolved-only registry name resolves inside the job container. The
  // container backend applies this under the default hardened posture
  // (KICI_SANDBOX_HARDENED=true).
  sandboxNetwork: z.enum(['isolated', 'host']).default('isolated'),
  // Container-sandbox hardening posture (the per-job Docker/Podman sandbox).
  // Secure-by-default: every job container drops all Linux capabilities, sets
  // no-new-privileges, and gets pids/memory/CPU cgroup caps + a private
  // tmpfs /tmp. These knobs tune that posture; see execution/sandbox/
  // container-hardening.ts for how they map to the HostConfig.
  //
  // Master rollback affordance (documented-temporary): setting this false
  // reproduces the legacy unhardened container posture. Default ON.
  sandboxHardened: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  // Opt-in read-only rootfs. Off by default — many images write outside
  // /workspace (npm cache, /home, tool state); /tmp is always a writable tmpfs.
  sandboxReadonlyRootfs: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Explicit container user override (uid, uid:gid, or name). When unset the
  // image's configured user is honored as-is — a root image is never silently
  // rewritten.
  sandboxUser: z.string().optional(),
  // cgroup caps for the job container. Defaults mirror the operator-visible
  // constants in container-hardening.ts (512 pids / 2 GiB / 2 CPUs). Raise
  // these for heavy builds; they bound fork-bomb / memory / CPU DoS on the host.
  sandboxPidsLimit: z.coerce.number().int().positive().default(512),
  sandboxMemoryBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  sandboxNanoCpus: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1_000_000_000),
  // Scaler integration. The auto-scaler injects KICI_SCALER_MANAGED=1 into
  // every ephemeral agent it spawns; the agent uses these to know when it
  // should self-shutdown after going idle.
  scalerManaged: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  // Set by the scaler when it spawned this agent FROM the job's own container
  // image. Such an agent is already inside the image the job asked for, so it
  // must run steps directly rather than nesting a second container from the
  // same image — which would need a runtime inside a runtime and fail.
  jobImageAgent: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  // Where the KiCI runtime comes from when this agent NESTS a job container.
  //
  // A job may name any image, and that image is no more likely to ship Node
  // than one a scaler spawns — so the agent injects the same pinned,
  // glibc-2.17 Node the published agent image carries. It needs an image to
  // copy that tree out of: a bind mount needs a host path, and the agent may
  // itself be containerized, so it materializes the tree into a named volume
  // exactly as the scaler does.
  //
  // Set automatically on every agent a scaler spawns (to the pool's own agent
  // image, which is by construction present on that host). An operator running
  // an agent by hand sets it to the kici-agent image matching their agent.
  // Unset means no injection: the job container falls back to the image's own
  // `node`, which is the historical contract and still correct for an image
  // that ships one.
  runtimeImage: z.string().optional(),
  // Pre-provisioned Node tree to inject instead of materializing one — a host
  // directory whose `bin/node` is the runtime, or the name of a volume holding
  // it. Wins over runtimeImage. For a host that provisions the tree out of band
  // (an air-gapped fleet with no agent image to pull).
  runtimeNodeSource: z.string().optional(),
  // Which build CLI runs a job's `container.dockerfile`. Unset auto-detects,
  // preferring docker. Set it explicitly on a host that has both CLIs and whose
  // container runtime is the other one — the build and the job container have to
  // land on the same daemon, or the sandbox starts on a daemon that has never
  // seen the image.
  containerBuildCli: ContainerBuildCli.optional(),
  // Self-bootstrap: a single-use claim code the agent exchanges for its own
  // ephemeral credentials (scaler.claim-credentials) before registering. Set by
  // an event-scaler provisioning path (e.g. a GitHub Actions runner) so the real
  // token never transits the provisioning channel. Ignored when a static
  // KICI_AGENT_TOKEN is present.
  scalerClaimCode: z.string().optional(),
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
  // Co-located guard for workflow-level host restart: when true, this agent
  // shares its host with the orchestrator, so a `restartHost()` request is
  // refused locally (the orchestrator also refuses it). Defaults to false.
  isOrchestratorHost: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Operator-supplied host-reset command run between jobs on a reused agent
  // (unset = disabled). Runs in the supervisor after the job's process tree is
  // reaped and its workdir removed. Meaningful on host-sharing backends
  // (bare-metal / in-place); a no-op elsewhere. Fail-open: a failure never
  // crashes the agent and never changes the finished job's result.
  betweenJobsResetCommand: z.string().optional(),
  // Timeout for the between-jobs reset command. Default 60s.
  betweenJobsResetTimeoutMs: z.coerce.number().int().positive().default(60_000),
  // When the reset command runs: 'always' (default) or only 'on-failure'.
  betweenJobsResetRunOn: BetweenJobsRunOn.default('always'),
  // Master switch for bare-metal process-group reaping of a finished job's
  // descendant tree. Default on. 'false' restores the single-child-signal
  // behavior — an escape hatch for a workload that legitimately backgrounds a
  // daemon meant to outlive the job.
  orphanCleanup: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  // Opt-in: drain the agent (stop accepting new jobs) after repeated
  // consecutive between-jobs reset failures, so a persistently dirty host stops
  // taking work. Default off.
  drainOnResetFailure: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
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
    isOrchestratorHost: 'KICI_AGENT_IS_ORCHESTRATOR_HOST',
    githubToken: 'KICI_GITHUB_TOKEN',
    maxLogSizeBytes: 'KICI_MAX_LOG_SIZE_BYTES',
    defaultStepTimeoutMs: 'KICI_DEFAULT_STEP_TIMEOUT_MS',
    dockerKeepFailed: 'KICI_DOCKER_KEEP_FAILED',
    jobHeartbeatIntervalMs: 'KICI_JOB_HEARTBEAT_INTERVAL_MS',
    backpressureMode: 'KICI_BACKPRESSURE_MODE',
    agentPayloadDir: 'KICI_AGENT_PAYLOAD_DIR',
    agentCommand: 'KICI_AGENT_COMMAND',
    sandbox: 'KICI_SANDBOX',
    trustedEnv: 'KICI_TRUSTED_ENV',
    inPlace: 'KICI_IN_PLACE',
    sandboxNetwork: 'KICI_SANDBOX_NETWORK',
    sandboxHardened: 'KICI_SANDBOX_HARDENED',
    sandboxReadonlyRootfs: 'KICI_SANDBOX_READONLY_ROOTFS',
    sandboxUser: 'KICI_SANDBOX_USER',
    sandboxPidsLimit: 'KICI_SANDBOX_PIDS_LIMIT',
    sandboxMemoryBytes: 'KICI_SANDBOX_MEMORY_BYTES',
    sandboxNanoCpus: 'KICI_SANDBOX_NANO_CPUS',
    scalerManaged: 'KICI_SCALER_MANAGED',
    jobImageAgent: 'KICI_JOB_IMAGE_AGENT',
    runtimeImage: 'KICI_RUNTIME_IMAGE',
    runtimeNodeSource: 'KICI_RUNTIME_NODE_SOURCE',
    containerBuildCli: 'KICI_CONTAINER_BUILD_CLI',
    scalerClaimCode: 'KICI_SCALER_CLAIM_CODE',
    scalerIdleTimeoutMs: 'KICI_SCALER_IDLE_TIMEOUT',
    scalerPendingDispatchTimeoutMs: 'KICI_SCALER_PENDING_DISPATCH_TIMEOUT',
    executionMode: 'KICI_EXECUTION_MODE',
    otelExporterOtlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    concurrencyWaitTimeoutMs: 'KICI_CONCURRENCY_WAIT_TIMEOUT_MS',
    betweenJobsResetCommand: 'KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND',
    betweenJobsResetTimeoutMs: 'KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS',
    betweenJobsResetRunOn: 'KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON',
    orphanCleanup: 'KICI_AGENT_ORPHAN_CLEANUP',
    drainOnResetFailure: 'KICI_AGENT_DRAIN_ON_RESET_FAILURE',
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
 * - KICI_TRUSTED_ENV (default: false) — trusted fleet-agent profile: pass the ambient host env (minus the agent's own KiCI identity secrets) through to steps
 * - KICI_IN_PLACE (default: false) — in-place no-clone profile: for a file:// source, use the real repo path as workDir and skip the clone (the routed deploy:stg profile)
 * - KICI_SANDBOX_NETWORK (default: isolated, options: isolated | host) — sandbox network posture for BOTH backends: the bwrap network namespace (when sandbox=true) and the container job network. `host` shares the host network (container backend also binds host /etc/hosts read-only for name resolution); applies to the container backend under the default hardened posture (KICI_SANDBOX_HARDENED=true)
 * - KICI_SANDBOX_HARDENED (default: true) — hardened-by-default job containers (CapDrop ALL, no-new-privileges, cgroup caps, tmpfs /tmp); set false to roll back to the legacy unhardened posture
 * - KICI_SANDBOX_READONLY_ROOTFS (default: false) — opt-in read-only container rootfs (/tmp stays a writable tmpfs)
 * - KICI_SANDBOX_USER (optional) — container user override (uid, uid:gid, or name); honors the image user when unset
 * - KICI_SANDBOX_PIDS_LIMIT (default: 512) — max PIDs in the job container cgroup
 * - KICI_SANDBOX_MEMORY_BYTES (default: 2 GiB) — memory cap in bytes for the job container cgroup
 * - KICI_SANDBOX_NANO_CPUS (default: 2 CPUs) — CPU cap in nano-CPUs for the job container cgroup
 * - KICI_SCALER_MANAGED (set to "1" by the orchestrator's auto-scaler — agent self-shuts down on idle)
 * - KICI_SCALER_CLAIM_CODE (optional single-use claim code the agent exchanges for its own ephemeral credentials before registering; ignored when KICI_AGENT_TOKEN is set)
 * - KICI_SCALER_IDLE_TIMEOUT (ms, default 5000) — how long a scaler-managed agent waits before shutdown after going idle
 * - KICI_SCALER_PENDING_DISPATCH_TIMEOUT (ms, default 60000) — extended idle window when register.ack signals a queued bound job
 * - KICI_EXECUTION_MODE (optional, options: container | bare-metal | firecracker) — override the runner's mode-pick logic
 * - KICI_CONCURRENCY_WAIT_TIMEOUT_MS (default: 3_600_000) — workflow-runner timeout when long-polling for a slot-release follow-up `concurrency.ack`
 * - KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND (optional) — host-reset command run between jobs on a reused agent (fail-open)
 * - KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS (default: 60000) — reset command timeout
 * - KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON (default: always, options: always | on-failure) — when the reset command runs
 * - KICI_AGENT_ORPHAN_CLEANUP (default: true) — reap a finished job's leaked process tree (bare-metal); false = only signal the runner child
 * - KICI_AGENT_DRAIN_ON_RESET_FAILURE (default: false) — drain the agent after repeated consecutive reset failures
 */
export function loadConfig(): AppConfig {
  const data = envDef.parse();

  // Validate no reserved kici:* prefix in user-provided labels. This is a
  // client-side guardrail against a user spoofing a system label; it does NOT
  // apply when the orchestrator is the authority on which reserved labels the
  // agent may advertise:
  //   - scaler-managed agents get kici:role:* injected into KICI_LABELS by the
  //     orchestrator's scaler;
  //   - token-authenticated agents (an ssh-transport ops agent advertising
  //     kici:capability:ssh-transport, or an init-runner advertising
  //     kici:init / kici:privileged:root / kici:host:* from its bootstrap
  //     token) have every wire label checked against the token's authorized set
  //     at register time (agent-handler Gate 1), so an unauthorized reserved
  //     label is rejected there rather than needing a client-side block.
  if (!data.scalerManaged && !data.agentToken) {
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
