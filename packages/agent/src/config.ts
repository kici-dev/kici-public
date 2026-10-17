import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_DEFAULT_PORT,
  defineEnv,
  validateUnknownKiciVars,
  LOGGER_ENV_VARS,
} from '@kici-dev/shared/env';
import {
  KNOWN_ROLES,
  parseHostPropertyAssignments,
  validateNoReservedLabels,
} from '@kici-dev/engine';
import { ContainerBuildCli } from './execution/image-build/build-engine.js';
import { parseHostInstallRegistries } from './execution/host-install-origins.js';

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
  // Host-vars reported at registration, shallow-merged into the orchestrator's
  // host roster: "region=eu,cores=8,gpu=true" (true/false ⇒ boolean, numeric ⇒
  // number, otherwise string).
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
  port: z.coerce.number().default(AGENT_DEFAULT_PORT),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // `kat_`-prefixed PSK for orchestrator authentication.
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
  // Directory of `kici-admin agent package` payloads
  // (`<dir>/<version>/kici-agent-<platform>.tar.gz`). An ops agent stages the
  // matching one onto a bare box during bring-up, so it boots with no system Node.
  agentPayloadDir: z.string().optional(),
  // Golden-image escape hatch: the command that starts the init-runner on a
  // target already shipping `kici-agent` + Node at a known path. Set, it skips
  // payload staging; leave it unset for a stock rescue box.
  agentCommand: z.string().optional(),
  // Bubblewrap (bwrap) namespace isolation for bare-metal execution.
  sandbox: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Trusted fleet-agent profile: steps get the ambient host env (minus the
  // agent's own KiCI identity/operational secrets) instead of the system-var
  // allowlist. Orthogonal to KICI_SANDBOX. Set ONLY by the operator at
  // agent/scaler launch — never derivable from a dispatch payload or workflow.
  trustedEnv: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // In-place no-clone profile: for a `file://` source, the job workDir is the
  // source's real repo path and the clone is skipped, so an operator runs their
  // already-built tree (node_modules, dist) directly. Set ONLY by the operator
  // at agent/scaler launch (the local dev plane's trusted+in-place label set),
  // never from a dispatch payload, so a Platform-connected agent (https
  // sources) can never be pushed onto the operator's tree.
  inPlace: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Sandbox network posture for BOTH backends.
  // 'isolated': bwrap --unshare-net (loopback only; breaks workflows that need
  // npm/git); the container backend keeps the runtime default bridge (egress works).
  // 'host': share the host network namespace. On the container backend it also
  // binds the host /etc/hosts read-only, so a host-resolved-only registry name
  // resolves in the job container; the container backend applies it under the
  // default hardened posture (KICI_SANDBOX_HARDENED=true).
  sandboxNetwork: z.enum(['isolated', 'host']).default('isolated'),
  // Per-job container hardening: drop all capabilities, no-new-privileges,
  // pids/memory/CPU cgroup caps and a private tmpfs /tmp (HostConfig mapping:
  // execution/sandbox/container-hardening.ts). False is the documented-temporary
  // rollback to the unhardened posture.
  sandboxHardened: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  // Opt-in, because many images write outside /workspace (npm cache, /home,
  // tool state); /tmp is always a writable tmpfs.
  sandboxReadonlyRootfs: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Container user (uid, uid:gid or name). Unset honors the image's user — a
  // root image is never silently rewritten.
  sandboxUser: z.string().optional(),
  // Dedicated uid for the bare-metal runner child (uid, uid:gid or name).
  // Unset, the child runs as the agent's user, so the credential-stripping env
  // allowlist is no boundary: that uid can still reach the agent process.
  // Setting it costs an operator-provisioned account and a chown per workdir.
  runnerUser: z.string().optional(),
  // Echo the runner child's raw stdio onto the agent's stderr. Off by default:
  // a scaler-spawned agent's stderr lands in the orchestrator's journal, readable
  // without the run log's `runs:read` check or per-org scoping. Declared here so
  // the unknown-KICI_*-var check knows it, or the agent refuses to start.
  runnerDebugStdio: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Egress filtering for nested job containers: the container joins the agent's
  // `kici-jobs` bridge and the same RFC1918 + cloud-metadata nftables drops the
  // scaler applies to agent containers. On by default; a host without nft or
  // NET_ADMIN warns and degrades rather than refusing to run.
  sandboxNetworkIsolation: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  // Operator opt-out from `--ignore-scripts` on the `.kici/` install: lifecycle
  // scripts are customer code run by the installing process. Read only here,
  // never from a dispatch payload or workflow, so a pull request cannot
  // re-enable them for itself.
  allowInstallScripts: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  // Extra registry origins (e.g. `http://registry.local:4873`, matched exactly
  // after URL normalization) a container job's host-side `.kici/` install may
  // contact, beyond public npm and the agent user's `~/.npmrc`. The host install
  // bypasses the job egress filter, so a workflow-named registry qualifies only
  // when listed here. Read only here, never from a dispatch payload or workflow.
  // A non-http(s) entry refuses startup.
  hostInstallRegistries: z
    .string()
    .default('')
    .transform((raw, ctx) => {
      const { origins, invalid } = parseHostInstallRegistries(raw);
      // Report entries, never the raw setting: another entry may hold a password.
      for (const { entry, reason } of invalid) {
        ctx.addIssue({
          code: 'custom',
          input: entry,
          message: `KICI_HOST_INSTALL_REGISTRIES entry ${JSON.stringify(entry)} ${reason}`,
        });
      }
      return invalid.length > 0 ? z.NEVER : origins;
    }),
  // Job container cgroup caps bounding fork-bomb / memory / CPU DoS; defaults
  // mirror container-hardening.ts (512 pids / 2 GiB / 2 CPUs).
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
  // The auto-scaler sets KICI_SCALER_MANAGED=1 on every ephemeral agent it
  // spawns; such an agent self-shuts down once idle.
  scalerManaged: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  // Set by the scaler when this agent runs IN the job's own image: steps run
  // directly, because nesting a second container would need a runtime inside a
  // runtime and fail.
  jobImageAgent: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  // Set by the container scaler on an agent it starts from a pool's own agent
  // image. Such an agent runs exactly one job: it stops taking work when it
  // accepts its job and exits when that job ends, so nothing a job leaves in
  // the container reaches another job.
  scalerSingleJob: z
    .string()
    .optional()
    .transform((s) => s === '1'),
  // Image to copy the pinned glibc-2.17 Node out of when this agent NESTS a job
  // container, since a job image may lack Node. The tree goes into a named
  // volume as the scaler does it (a bind mount needs a host path, and the agent
  // may be containerized). A scaler sets it to the pool's agent image, present on
  // the host by construction; a hand-run agent sets its matching kici-agent
  // image. Unset, no injection: the job uses the image's own `node`.
  runtimeImage: z.string().optional(),
  // Pre-provisioned Node tree (a host dir whose `bin/node` is the runtime, or a
  // volume name); wins over runtimeImage. For air-gapped fleets with no agent
  // image to pull.
  runtimeNodeSource: z.string().optional(),
  // Build CLI for `container.dockerfile`; unset auto-detects, preferring docker.
  // Set it on a host with both CLIs whose runtime is the other one: build and job
  // container must share a daemon, or the job's image is missing.
  containerBuildCli: ContainerBuildCli.optional(),
  // Single-use claim code exchanged for ephemeral credentials
  // (scaler.claim-credentials) before registering, so the real token never
  // transits an event-scaler's provisioning channel (e.g. a GitHub Actions
  // runner). Ignored when KICI_AGENT_TOKEN is set.
  scalerClaimCode: z.string().optional(),
  // Idle wait (ms) before a scaler-managed agent shuts down.
  scalerIdleTimeoutMs: z.coerce.number().default(5_000),
  // Extended idle window (ms) when register.ack signals a queued bound job.
  scalerPendingDispatchTimeoutMs: z.coerce.number().default(60_000),
  // Unset, the runner picks the mode from dispatch + scaler signals
  // (execution/job-runner.ts#determineExecutionMode).
  executionMode: ExecutionMode.optional(),
  // Consumed by initTelemetry.
  otelExporterOtlpEndpoint: z.string().optional(),
  // How long the workflow-runner waits for a follow-up `concurrency.ack` after
  // `{ action: 'wait' }`; the runner child inherits it via env.
  concurrencyWaitTimeoutMs: z.coerce.number().int().min(1000).default(3_600_000),
  // True when this agent shares its host with the orchestrator: `restartHost()`
  // is then refused locally (the orchestrator also refuses it).
  isOrchestratorHost: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Host-reset command run between jobs on a reused agent, in the supervisor,
  // after the job's tree is reaped and its workdir removed. Meaningful on
  // bare-metal / in-place only. Fail-open: a failure never crashes the agent or
  // changes the finished job's result.
  betweenJobsResetCommand: z.string().optional(),
  betweenJobsResetTimeoutMs: z.coerce.number().int().positive().default(60_000),
  betweenJobsResetRunOn: BetweenJobsRunOn.default('always'),
  // Bare-metal process-group reaping of a finished job's tree. 'false' signals
  // only the runner child — an escape hatch for a job that backgrounds a daemon
  // meant to outlive it.
  orphanCleanup: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  // Opt-in: drain the agent after repeated consecutive reset failures, so a
  // persistently dirty host stops taking work.
  drainOnResetFailure: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
});

/** App configuration; `agentId` is computed when not provided. */
export type AppConfig = z.infer<typeof configSchema> & {
  /** Unique identifier for this agent instance */
  agentId: string;
};

/** Exported so the docs generator and config pre-validation can re-parse without process.env. */
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
    runnerUser: 'KICI_RUNNER_USER',
    runnerDebugStdio: 'KICI_RUNNER_DEBUG_STDIO',
    sandboxNetworkIsolation: 'KICI_SANDBOX_NETWORK_ISOLATION',
    allowInstallScripts: 'KICI_ALLOW_INSTALL_SCRIPTS',
    hostInstallRegistries: 'KICI_HOST_INSTALL_REGISTRIES',
    sandboxPidsLimit: 'KICI_SANDBOX_PIDS_LIMIT',
    sandboxMemoryBytes: 'KICI_SANDBOX_MEMORY_BYTES',
    sandboxNanoCpus: 'KICI_SANDBOX_NANO_CPUS',
    scalerManaged: 'KICI_SCALER_MANAGED',
    jobImageAgent: 'KICI_JOB_IMAGE_AGENT',
    scalerSingleJob: 'KICI_SCALER_SINGLE_JOB',
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
 * Env vars the unknown-KICI_* validator tolerates **only** under `NODE_ENV=test`:
 * `KICI_SKIP_DB_TESTS` is the vitest Postgres harness opt-out
 * (`scripts/db-test-postgres.ts`), also in the orchestrator list. A production
 * boot with a stray one still fails the validator.
 */
const TEST_ONLY_ENV_VARS = ['KICI_SKIP_DB_TESTS'];

/**
 * Load and validate agent configuration from the `KICI_*` environment variables
 * (see `envDef`). `KICI_AGENT_ID` defaults to `<hostname>-<uuid8>`. Labels with
 * the reserved `kici:` prefix are refused unless the agent is scaler-managed or
 * has `KICI_AGENT_TOKEN`. An unknown `KICI_*` variable fails the load.
 */
export function loadConfig(): AppConfig {
  const data = envDef.parse();

  // Client-side guard against spoofing a reserved kici:* label. Skipped when the
  // orchestrator is the authority: a scaler-managed agent gets kici:role:*
  // injected by the scaler, and a token-authenticated agent (ssh-transport ops
  // agent, init-runner with kici:init / kici:privileged:root / kici:host:*) has
  // every wire label checked against its token at register time (agent-handler
  // Gate 1).
  if (!data.scalerManaged && !data.agentToken) {
    validateNoReservedLabels(data.labels, 'KICI_LABELS');
  }

  // Reject typo'd KICI_* vars; the logger's vars (KICI_LOG_DIR, …) are known too.
  validateUnknownKiciVars([
    ...envDef.listKnownEnvVars(),
    ...LOGGER_ENV_VARS,
    ...(process.env.NODE_ENV === 'test' ? TEST_ONLY_ENV_VARS : []),
  ]);

  return {
    ...data,
    agentId: data.agentId ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
  };
}

/**
 * Credential vars removed from `process.env` once `loadConfig()` has read them.
 * `KICI_ORCHESTRATOR_URL` is deliberately absent: it is no credential, and
 * `resolveOrchestratorUrl` reads it from the env in the agent and runner child.
 */
const CREDENTIAL_ENV_VARS = [
  'KICI_AGENT_TOKEN',
  'KICI_SCALER_CLAIM_CODE',
  'KICI_GITHUB_TOKEN',
] as const;

/**
 * Remove the agent's own credentials from `process.env` after boot; returns the
 * names removed. Under the default bare-metal backend a step can read
 * `/proc/<agent-pid>/environ` and steal the token to register a rogue agent.
 *
 * Defence in depth, not isolation: a same-uid `ptrace` or `/proc/<pid>/mem`
 * read still reaches the config object. The boundary is `KICI_RUNNER_USER` or
 * the container backend. Safe because `loadConfig()` is each variable's only
 * reader and runs before this.
 */
export function scrubCredentialEnv(): string[] {
  const removed: string[] = [];
  for (const name of CREDENTIAL_ENV_VARS) {
    if (process.env[name] !== undefined) {
      delete process.env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * A warning when no boundary separates step code from the agent process, else
 * `undefined`. That is the default bare-metal posture: `KICI_SANDBOX=false`, no
 * `KICI_RUNNER_USER`, no container backend.
 *
 * A warning, not a refusal: bwrap is Linux-only and the container backend needs
 * a runtime, so neither can be a default without breaking existing installs.
 */
export function describeExposedPosture(
  config: Pick<AppConfig, 'sandbox' | 'runnerUser' | 'executionMode' | 'jobImageAgent'>,
): string | undefined {
  if (config.sandbox || config.runnerUser) return undefined;
  if (config.executionMode === 'container' && !config.jobImageAgent) return undefined;
  return (
    "Runner isolation is OFF: job steps run as this agent's own user, so a step can read " +
    'the agent process (for example /proc/<pid>/mem) despite the environment allowlist. ' +
    'Set KICI_RUNNER_USER=<user> to give the runner child a dedicated uid, or ' +
    'KICI_SANDBOX=true (Linux, bubblewrap) for namespace isolation.'
  );
}

/**
 * Orchestrator WebSocket client options derived purely from config. `token`
 * lives here so it always travels with the connection: set, the client sends
 * `auth.request`; absent, it falls back to unauthenticated `agent.register`.
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
