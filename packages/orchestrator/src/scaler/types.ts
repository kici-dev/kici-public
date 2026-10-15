/** Core types shared by the scaler backends, `ScalerManager` and the config layer. */

import { ImagePullPolicy } from '@kici-dev/shared/container-runtime';
import { z } from 'zod';
import { ScalerEventType } from '@kici-dev/engine';
import type { ScaleDownReason } from './scaler-events.js';
import type {
  ResourceRequest,
  ResourceSpec,
  ScalerBackendType,
  ScalerPlatform,
} from '@kici-dev/engine';

export type { ResourceRequest, ResourceSpec } from '@kici-dev/engine';
export { ScalerEventType } from '@kici-dev/engine';

/**
 * Resource limits for spawned agents: the `(cpus, memory)` pair shared by scaler
 * config and per-job declarations. Memory uses container-style suffixes ("2g",
 * "512m"); CPUs are fractional cores (1.5 = 1.5 cores).
 */
export type ResourceLimits = ResourceSpec;

/**
 * Cap on summed `requests` for a group of agents (scaler, orchestrator or
 * machine pool). Memory is parsed to bytes at config load, not per spawn check.
 */
export interface ResourceCap {
  /** Sum of `requests.cpus` across the group's active agents. */
  maxCpu?: number;
  /** Sum of `requests.memory`, in bytes, across the group's active agents. */
  maxMemoryBytes?: number;
}

/**
 * A named machine pool. Orchestrators on one host share it by name; the
 * file-backed ledger (`machine-ledger.ts`) accounts reservations across processes.
 */
export interface MachinePoolConfig {
  name: string;
  cap: ResourceCap;
}

/**
 * Pre-resolved kernel-side limits passed to `ScalerBackend.spawn()`, memory in
 * bytes. Zero or omitted means no limit on that dimension; when both are zero
 * the backend falls back to its label-set or default limits.
 */
export interface EffectiveLimits {
  cpus?: number;
  memBytes?: number;
}

/**
 * A job's container spec with its registry credentials resolved: the lock
 * carries credential REFERENCES, this is what a runtime pulls with. Produced by
 * `resolveContainerSpawn`, consumed by the container sandbox and by both
 * spawning backends.
 */
export interface ResolvedContainerSpawn {
  image: string;
  authconfig?: { username: string; password: string; serveraddress: string };
  env?: Record<string, string>;
}

/**
 * Identity of the work a spawn serves, passed to `ScalerBackend.spawn()`.
 * Backends surface it on the provisioned resource (container labels) so an
 * operator (`podman ps`) sees which job/run each agent serves and a test selects
 * the exact container a trigger produced. Absent for unbound (warm pool) spawns.
 */
export interface SpawnContext {
  boundJobId?: string;
  runId?: string;
  /**
   * Present when the job declared a container: spawn THIS image with the KiCI
   * runtime injected, not the pool's fixed agent image.
   */
  container?: ResolvedContainerSpawn;
  /**
   * Platform-taint tokens (`windows`, `macos`, `arm64`) for this spawn's pool,
   * derived by `ScalerManager` from the platform its taint gate uses. A backend
   * forwards them to `scalerAgentLabels()`; without them a tainted pool spawns
   * agents no job can be dispatched to. Never derived by a backend: the manager
   * is the single source.
   */
  platformTaints?: readonly string[];
  /**
   * The full taint gate the agent registers under: configured `mandatoryLabels`
   * plus every derived platform taint, as the durable spawn row carries it. A
   * backend publishes it (the event scaler's scale-up payload) so a provisioning
   * workflow sees the real gate. Never derived by a backend: the manager is the
   * single source.
   */
  mandatoryLabels?: readonly string[];
}

/**
 * RFC1918 and internet access policy for a label set's agents. Defined in
 * `@kici-dev/shared/net` beside the nftables rule builder that consumes it.
 */
import type { NetworkPolicy } from '@kici-dev/shared/net';
export type { NetworkPolicy };

/**
 * Image pull policy for container-backend agent images.
 *
 * - `IfNotPresent` (default): pull only when the image is not already local.
 *   KiCI agent images are pinned + immutable, so re-pulling on every spawn only
 *   storms the registry/socket.
 * - `Always`: re-pull on every spawn. Set this on a label set that tracks a
 *   moving tag (e.g. `:latest`) or otherwise needs a fresh image each spawn.
 * - `Never`: never pull; fail if the image is absent.
 *
 * Defined beside `pullImageIfMissing` in `@kici-dev/shared`, which the agent
 * also uses to pull job images.
 */
export { ImagePullPolicy };

/** Maps an exact label set to a scaler backend's agent provisioning details. */
export interface LabelSetConfig {
  /** Exact label set (sorted for deterministic comparison) */
  labels: string[];
  /** Container image (Docker backend) */
  image?: string;
  /** Default: IfNotPresent. */
  imagePullPolicy?: ImagePullPolicy;
  /** Path to agent binary (bare-metal backend) */
  binaryPath?: string;
  /**
   * Per-label-set resource request and limit (override scaler defaults):
   * `{ requests?: { cpus, memory }, limits?: { cpus, memory } }`.
   */
  resources?: ResourceRequest;
  /**
   * Mount container runtime socket into container.
   * WARNING: Enabling gives CI jobs FULL ROOT ACCESS to the host container runtime.
   * Only enable for fully trusted workloads on isolated infrastructure.
   * @default false
   */
  containerSocket?: boolean;
  /** Extra bind mounts for spawned containers (e.g. ["/host/path:/container/path:ro"]). */
  volumes?: string[];
  env?: Record<string, string>;
  networkPolicy?: NetworkPolicy;
  /** Agent log streaming backpressure, default 'pause'; injected as KICI_BACKPRESSURE_MODE. */
  backpressureMode?: 'pause' | 'drop';

  // ── Firecracker-specific fields ──────────────────────────────

  /** Path to ext4 rootfs image (Firecracker backend, required per label-set) */
  rootfsPath?: string;
  /** Override scaler-level kernel path for this label set */
  kernelPath?: string;
  /** Override scaler-level vCPU count for this label set */
  vcpuCount?: number;
  /** Override scaler-level memory in MiB for this label set */
  memSizeMib?: number;
  /** Size in MiB for the per-VM overlay drive (Firecracker CoW mode) @default 2048 */
  overlayDriveSizeMib?: number;
}

/**
 * A spawned agent tracked by the scaler; the AgentRegistry knows only
 * registered (WS-connected) agents.
 */
export interface ManagedAgent {
  /** Scaler-internal tracking id. */
  id: string;
  labelSet: string[];
  /** Container ID or PID. */
  backendRef: string;
  /** Epoch ms. */
  spawnedAt: number;
  state: 'spawning' | 'running' | 'destroying';
  /** Set once the agent registers over WS. */
  registeredAgentId?: string;
}

/** Result of a scaling decision, discriminated on `action`. */
export type ScaleResult =
  /** A spawn started; `agentId` is the scaler-managed id the new agent will register with. */
  | { action: 'spawning'; backendType: string; agentId: string }
  | { action: 'at-capacity' }
  | { action: 'no-backend'; labels: string[] }
  | { action: 'failed'; error: string }
  /**
   * Scale-up declined without attempting a spawn (e.g. coordinator draining).
   * `retryAfterMs` is set when the scaler is deferring after failed launches:
   * a request before then is declined the same way.
   */
  | { action: 'skipped'; reason: string; retryAfterMs?: number };

/**
 * What triggered a pending-scale re-drive (`Dispatcher.retryPendingScaleRequests`):
 * the near-zero-latency capacity-freed `hook` fired from `ScalerManager`, or the
 * leader-gated periodic `sweep` backstop. Used as the `trigger` label on the
 * `kici_orch_scaler_redispatch_total` counter.
 */
export const ScalerRedispatchTrigger = z.enum(['hook', 'sweep']);
export type ScalerRedispatchTrigger = z.infer<typeof ScalerRedispatchTrigger>;

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Optional context passed to `ScalerBackend.destroy`. The event backend surfaces
 * `reason` on its scale-down event; local backends ignore it.
 */
export interface ScalerDestroyContext {
  /** Why the teardown was requested (idle, job-complete, drain, …). */
  reason?: ScaleDownReason;
  /**
   * Overrides an event backend's live delivery targets. Set from the spawn
   * record for an agent adopted from another coordinator, so the teardown
   * reaches the targets the provision was spawned with even after
   * `provisioningTargets` changed. Local backends ignore it.
   */
  targets?: string[];
}

/**
 * Common interface for all scaler backends; each manages a pool of agents for
 * specific label sets.
 */
export interface ScalerBackend {
  readonly type: ScalerBackendType;

  /** The ELK `app.logsSource` field. */
  readonly logsSource?: string;

  readonly labelSets: LabelSetConfig[];

  /** Updated by `reload`, so a `maxAgents` change needs no orchestrator restart. */
  maxAgents: number;

  /**
   * True when agents run on the orchestrator's own host: bare-metal,
   * Firecracker, and container backends on a local runtime socket. False for a
   * remote container runtime or cloud backend. Drives the dashboard
   * Infrastructure page's spawning-host display.
   */
  readonly spawnsOnLocalHost: boolean;

  /** Includes agents still spawning. */
  getActiveCount(): number;

  /**
   * Spawn an agent for the given label set.
   * @param labelSet - The exact label set to spawn for
   * @param agentId - Pre-generated agent ID for WS registration correlation
   * @param orchestratorUrl - URL for the agent to connect back to
   * @param onEvent - Lifecycle event callback
   * @param effectiveLimits - Kernel-side limits `ScalerManager` resolved from the
   *   job / label-set / scaler default chain. When omitted (or both fields
   *   zero), the backend falls back to its label-set / default limits.
   * @param spawnContext - The bound job/run (omitted for unbound spawns, e.g.
   *   warm pool), surfaced on the provisioned resource for operators.
   * @returns The managed agent tracking object
   * @throws If the label set is not supported by this backend
   * @throws DeterministicSpawnError, after emitting `scaler.failed`, when the
   *   host refused the launch itself. The manager defers the scaler instead of
   *   freeing the capacity for an immediate retry.
   */
  spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
    spawnContext?: SpawnContext,
    /**
     * From the ScalerManager spawn-timeout wrapper. Backends thread it into
     * long-running provisioning I/O (container-runtime requests, HTTP calls) so
     * a hung provision cancels instead of pinning the spawn-semaphore slot.
     */
    signal?: AbortSignal,
  ): Promise<ManagedAgent>;

  /**
   * Docker: docker rm -f; Bare-metal: SIGTERM -> SIGKILL.
   *
   * @param context - The event backend carries `reason` onto its
   *   `kici.scaler.scale-down` event, so a teardown workflow (and the timeline)
   *   tells an idle reap from a job-complete teardown or a spawn timeout. Local
   *   backends ignore it.
   */
  destroy(managedId: string, context?: ScalerDestroyContext): Promise<void>;

  /**
   * Called by ScalerManager when a spawn it started registers locally. A backend
   * implements it when it must tell a compute that stops before registering (a
   * failed spawn it tears down itself) from one that stops after (an agent whose
   * disconnect triggers `destroy`).
   */
  markRegistered?(managedId: string): void;

  /**
   * Reclaim the HOST-LOCAL compute of a managed agent this backend no longer
   * tracks in memory, from whatever durable host state survived the loss.
   *
   * `destroy` reads the in-memory agent map, so after a restart it silently
   * no-ops while the VM or host process keeps running. This hook reads the
   * backend's own on-host artifacts for `managedId` instead.
   *
   * Every implementation MUST hold:
   *
   * - **Host-local evidence only.** Reclaim nothing unless an artifact for
   *   exactly this `managedId` exists on THIS host, the proof this backend
   *   spawned it. A coordinator must never reap a peer's compute.
   * - **Caller supplies the orphan verdict.** The hook force-reclaims a *live*
   *   instance, which the liveness-driven orphan sweeps refuse to do. Call it
   *   only where the agent is known to be unowned.
   *
   * A backend whose compute is not host-local (the event backend's cloud
   * instance) cannot implement it. An implementation may cover only the part
   * of its backend that keeps durable state: on bare metal a container-mode
   * agent carries `kici-agent-id` / `kici-scaler-name` host labels and is
   * reclaimed, while a plain-process agent's PID lives only in memory, so the
   * hook reports nothing to reclaim.
   *
   * @returns `true` when host-local state for `managedId` was found and
   *   reclaimed, `false` when there was nothing here to reclaim.
   */
  reapUnowned?(managedId: string): Promise<boolean>;

  /**
   * Container and bare-metal backends capture stdout. Firecracker forwards logs
   * itself by tailing files (serial console + VMM logs) and returns none.
   */
  getLogCapture?(managedId: string): LogCapture | undefined;

  /** Called during graceful shutdown. */
  shutdownAll(): Promise<void>;

  /** Scaler metadata the orchestrator adds to job.context before forwarding to Platform. */
  getScalerContext?(agentId: string): Record<string, unknown> | undefined;

  /**
   * Provision or heal host prerequisites (Firecracker's bridge), once at
   * startup. May throw: the manager then degrades that scaler rather than
   * aborting orchestrator startup.
   */
  ensureHostReady?(): Promise<void>;

  /**
   * Called on config reload / SIGHUP. `opts.maxAgents` replaces the population
   * cap; `opts.entry` is the whole new entry, for a backend that reads more than
   * its label sets. On an invalid result NOTHING is applied.
   */
  reload(
    labelSets: LabelSetConfig[],
    opts?: { maxAgents?: number; entry?: ScalerEntry },
  ): ValidationResult;

  /**
   * The entry the reload rollback restores with `labelSets` and `maxAgents`.
   * Undefined for backends that read only their label sets (container,
   * bare-metal, Firecracker).
   */
  readonly currentEntry?: ScalerEntry;
}

/** VM networking (CIDR pool, bridge, gateway), shared by every Firecracker scaler. */
export interface FirecrackerNetworkConfig {
  /** CIDR range for VM IP allocation @default '10.0.0.0/24' */
  cidr?: string;
  /** Host bridge interface name @default 'kici-br0' */
  bridgeName?: string;
  /** Gateway IP address (assigned to bridge) @default '10.0.0.1' */
  gateway?: string;
  /** Subnet mask for guest networking @default '255.255.255.0' */
  netmask?: string;
  /** nft table name for this coordinator's host bridge @default 'kici' */
  table?: string;
  /**
   * When true (default), the orchestrator verifies and provisions this host
   * bridge on startup (self-heal), so a fresh Firecracker host needs no manual
   * `kici-admin firecracker provision`. @default true
   */
  autoProvisionHost?: boolean;
}

/**
 * Parsed and validated scaler configuration from YAML.
 * Loaded at startup and reloaded on SIGHUP.
 */
export interface ScalerConfig {
  /** Currently always 1. */
  version: 1;
  /** Across all backends. */
  globalMaxAgents: number;
  defaults?: {
    /**
     * Applied when neither the job nor the label set declares resources. The
     * internal representation is always nested.
     */
    resources?: ResourceRequest;
  };
  /** The resource counterpart of `globalMaxAgents`, across every scaler. */
  globalResourceCap?: ResourceCap;
  /**
   * Named pools shared by scaler entries on one host. The file-backed ledger
   * enforces each cap, so orchestrators on one machine cannot jointly
   * oversubscribe it.
   */
  machinePools?: MachinePoolConfig[];
  scalers: ScalerEntry[];
  /** Shared across all Firecracker scalers. */
  firecracker?: FirecrackerNetworkConfig;
}

export interface ScalerEntry {
  name: string;
  type: Exclude<ScalerBackendType, 'kubernetes'>;
  /** Population cap. */
  maxAgents: number;
  /**
   * Provisioning-rate throttle on concurrent `backend.spawn` calls, orthogonal
   * to `maxAgents`: excess in-cap spawns queue instead of storming the socket.
   * Defaults to `DEFAULT_MAX_CONCURRENT_SPAWNS` at config load.
   */
  maxConcurrentSpawns: number;
  /** Label-set to image/binary mappings */
  labelSets: LabelSetConfig[];
  /** Container runtime host (e.g. 'tcp://192.168.1.10:2376'). Works for both Docker and Podman remote. */
  host?: string;
  /** Overrides socket auto-detection, for non-standard socket locations. */
  socketPath?: string;
  /** Container runtime type. 'auto' probes known socket paths. Default: 'auto' */
  runtime?: 'docker' | 'podman' | 'auto';
  /** Orchestrator URL for spawned agents to connect back to */
  orchestratorUrl?: string;
  /**
   * Extra host:IP mappings for spawned agents (e.g. ["registry.local:host-gateway"]): the
   * container runtime's ExtraHosts (container scaler, bare-metal job-image agents), or
   * each Firecracker guest's /etc/hosts.
   */
  extraHosts?: string[];
  /** Enables nftables-based network isolation for the container backend (default: true). Set to false when nft is unavailable. */
  networkIsolation?: boolean;
  /** Warm pool configuration */
  warmPool?: WarmPoolConfig;

  /**
   * Labels a job MUST declare in `runsOn` to run on this scaler, like
   * Kubernetes taints: a job missing any of them is blocked even when its other
   * labels are a subset of a `labelSets` entry. Default: `[]` (no gating).
   */
  mandatoryLabels?: string[];

  /**
   * The pool's platform. When set, the auto-injected `kici:os:*` /
   * `kici:arch:*` labels AND the mandatory platform taint derive from it. When
   * omitted, bare-metal pools use the host OS/arch and container / firecracker
   * pools default to linux.
   */
  readonly platform?: ScalerPlatform;

  /**
   * Agent roles this scaler handles, per entry, not per label set.
   * - undefined: all job types, including build and init (backward compatible)
   * - []: execution jobs only, no build/init
   * - ['builder']: handles build jobs + execution
   * - ['init-runner']: handles init jobs + execution
   * - ['builder', 'init-runner']: handles both internal job types + execution
   * - ['all']: same as undefined
   */
  roles?: string[];

  /** Cap on summed `requests` across this scaler's agents; stacks with `maxAgents`. */
  resourceCap?: ResourceCap;
  /** Name of a top-level machine pool; see `ScalerConfig.machinePools`. */
  machinePool?: string;
  /**
   * Bare-metal opt-in: when true, wrap the spawned binary in a transient
   * `systemd-run --user --scope` with `MemoryMax` and `CPUQuota` derived from
   * the resolved `limits`. Requires user-mode systemd with cgroup-v2 delegate.
   */
  enforceCgroups?: boolean;

  // ── Firecracker-specific fields (scaler-level defaults) ──────

  /** Path to the Firecracker binary (Firecracker backend, required) */
  firecrackerPath?: string;
  /** Path to the jailer binary (Firecracker backend, required) */
  jailerPath?: string;
  /** Default kernel path for all label sets (Firecracker backend, required) */
  kernelPath?: string;
  /** Jailer chroot base directory @default '/srv/jailer' */
  chrootBaseDir?: string;
  /** Jailer uid (Firecracker backend, required) */
  uid?: number;
  /** Jailer gid (Firecracker backend, required) */
  gid?: number;
  /** Default vCPU count for VMs @default 2 */
  vcpuCount?: number;
  /** Default memory in MiB for VMs @default 512 */
  memSizeMib?: number;
  /**
   * Wrap privileged commands with `sudo -n` when the orchestrator runs as a
   * non-root user (e.g. user-mode systemd on edge worker nodes): the Firecracker
   * backend's `ip`, `chown`, `chmod`, `kill` and `nft`, and the `nft` of a
   * bare-metal scaler's job-image label sets. Operators must have NOPASSWD
   * sudoers entries for those binaries. Default false.
   */
  requireSudo?: boolean;

  // ── Event-backend fields (meaningful only when `type: 'event'`) ──

  /**
   * Workflow refs (e.g. `org/infra`) that receive the scale-up / scale-down
   * events, subscribed with `kiciEvent()`. Required for a `type: event` scaler.
   */
  provisioningTargets?: string[];
  /**
   * Seconds a pending provisioning claim code stays valid.
   * @default 300
   */
  claimTtlSeconds?: number;
  /**
   * Seconds the ephemeral agent token minted for a claimed provision stays
   * valid. @default 600
   */
  agentTokenTtlSeconds?: number;
}

/** Pre-provisioned idle agents. */
export interface WarmPoolConfig {
  enabled: boolean;
  /** Idle agents to maintain. */
  size: number;
  /** Seconds before an idle warm-pool agent is destroyed
   * @default 300
   */
  idleTimeoutSeconds: number;
}

// ── Scaler lifecycle events ──────────────────────────────────────

/** Emitted by each backend at key provisioning milestones. */
export interface ScalerEvent {
  agentId: string;
  eventType: z.infer<typeof ScalerEventType>;
  /** Backend-specific detail text (e.g. "pulling image nginx:latest", "booting microVM") */
  detail: string;
  timestampMs: number;
}

/** Passed from ScalerManager to each backend's `spawn()`. */
export type ScalerEventCallback = (event: ScalerEvent) => void;

/** A spawned agent's stdout/stderr, as individual log lines. */
export interface LogCapture {
  lines(): AsyncIterable<string>;
  /**
   * The bounded ring buffer of recent lines, oldest→newest, or an empty string.
   * Enriches a `scaler.failed` event when a spawn dies before WS registration.
   */
  tail(): string;
  /** Stop capturing and destroy underlying streams. Safe to call multiple times. */
  close(): void;
}
