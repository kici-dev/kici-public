/**
 * Core type definitions for the agent auto-scaler module.
 *
 * Provides the foundational types that all scaler backends, the ScalerManager,
 * and the configuration layer depend on.
 */

import { z } from 'zod';
import { ScalerEventType } from '@kici-dev/engine';
import type { ResourceRequest, ResourceSpec, ScalerBackendType } from '@kici-dev/engine';

export type { ResourceRequest, ResourceSpec } from '@kici-dev/engine';
export { ScalerEventType } from '@kici-dev/engine';

/**
 * Resource limits for spawned agents.
 *
 * Alias of `ResourceSpec` from `@kici-dev/engine`. Single source of truth for
 * the (cpus, memory) pair used by both scaler config and per-job resource
 * declarations. Memory uses container-style suffixes (e.g., "2g", "512m").
 * CPUs use fractional cores (e.g., 1.5 = 1.5 cores).
 */
export type ResourceLimits = ResourceSpec;

/**
 * Aggregate cap on summed `requests` for a group of agents (per-scaler,
 * per-orchestrator, or per-machine pool). Memory is pre-parsed to bytes at
 * config-load so the scaler doesn't re-parse on every spawn check.
 */
export interface ResourceCap {
  /** Maximum total CPU (sum of `requests.cpus`) across all active agents in the group. */
  maxCpu?: number;
  /** Maximum total memory in bytes (sum of `requests.memory`) across all active agents in the group. */
  maxMemoryBytes?: number;
}

/**
 * Definition of a named machine pool. Multiple orchestrators on the same host
 * can share a pool by referencing it by name; the file-backed ledger
 * (`machine-ledger.ts`) coordinates reservation accounting across processes.
 */
export interface MachinePoolConfig {
  name: string;
  cap: ResourceCap;
}

/**
 * Pre-resolved kernel-side limits passed to `ScalerBackend.spawn()`.
 *
 * Memory is in bytes (already parsed) so the backend doesn't re-run the
 * memory-string parser on every spawn. Either field may be zero or omitted
 * to mean "no limit on this dimension"; the backend falls back to its
 * label-set or default limits when both are zero.
 */
export interface EffectiveLimits {
  cpus?: number;
  memBytes?: number;
}

/**
 * Identity of the work a spawn was provisioned for, passed to
 * `ScalerBackend.spawn()`. Backends surface it on the provisioned resource
 * (container labels today) so an operator inspecting the backend — e.g.
 * `podman ps` — can tell which job/run each agent serves, and so tests can
 * select the exact container a trigger produced instead of guessing among
 * concurrent kici-managed containers. Absent for unbound spawns (warm pool).
 */
export interface SpawnContext {
  /** Execution job id the spawn is bound to. */
  boundJobId?: string;
  /** Execution run id the bound job belongs to. */
  runId?: string;
}

/**
 * Network policy controlling RFC1918 and internet access for agents in this label set.
 */
export interface NetworkPolicy {
  /** CIDR ranges allowed as exceptions to the default RFC1918 block */
  allowlist?: string[];
  /** Block all outbound traffic except allowlisted ranges */
  denyAll?: boolean;
}

/**
 * Configuration for a single label-set mapping within a scaler backend.
 * Maps an exact set of labels to the agent provisioning details.
 */
export interface LabelSetConfig {
  /** Exact label set (sorted for deterministic comparison) */
  labels: string[];
  /** Container image (Docker backend) */
  image?: string;
  /** Image pull policy: Always (default), IfNotPresent, or Never */
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  /** Path to agent binary (bare-metal backend) */
  binaryPath?: string;
  /**
   * Per-label-set resource request and limit (override scaler defaults).
   * After config-load normalization the internal representation is always nested:
   * `{ requests?: { cpus, memory }, limits?: { cpus, memory } }`.
   * The legacy flat shorthand (`{ cpus, memory }`) is accepted at config-load
   * and treated as `limits` (with `requests` auto-mirrored).
   */
  resources?: ResourceRequest;
  /**
   * Mount container runtime socket into container.
   * WARNING: Enabling gives CI jobs FULL ROOT ACCESS to the host container runtime.
   * Only enable for fully trusted workloads on isolated infrastructure.
   * @default false
   */
  containerSocket?: boolean;
  /** Additional bind-mount volumes for spawned containers (e.g. ["/host/path:/container/path:ro"]) */
  volumes?: string[];
  /** Additional environment variables passed to spawned agents */
  env?: Record<string, string>;
  /** Network isolation policy for agents in this label set */
  networkPolicy?: NetworkPolicy;
  /** Backpressure mode for agent log streaming: 'pause' (default) or 'drop'.
   * When set, injected as KICI_BACKPRESSURE_MODE into spawned agent environment. */
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
 * Represents a single spawned agent instance tracked by the scaler.
 * Separate from the AgentRegistry which only knows about registered (WS-connected) agents.
 */
export interface ManagedAgent {
  /** Unique ID for this managed agent instance (scaler-internal tracking) */
  id: string;
  /** The label set this agent was spawned for */
  labelSet: string[];
  /** Backend-specific identifier (container ID or PID) */
  backendRef: string;
  /** When this agent was spawned (epoch ms) */
  spawnedAt: number;
  /** Current lifecycle state */
  state: 'spawning' | 'running' | 'destroying';
  /** The agentId the spawned agent registered with via WS (set after registration) */
  registeredAgentId?: string;
}

/**
 * Result of a scaling decision.
 * Discriminated union on 'action' for exhaustive pattern matching.
 */
export type ScaleResult =
  | { action: 'spawning'; backendType: string }
  | { action: 'at-capacity' }
  | { action: 'no-backend'; labels: string[] }
  | { action: 'failed'; error: string };

/**
 * Result of a configuration validation or reload operation.
 */
export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Common interface for all scaler backends.
 * Each backend manages a specific pool of agents for specific label sets.
 * Designed to be pluggable -- Docker, bare-metal, and future K8s/VM backends
 * all implement this interface.
 */
export interface ScalerBackend {
  /** Backend type identifier */
  readonly type: ScalerBackendType;

  /** Log source identifier for ELK app.logsSource field. Set by each backend. */
  readonly logsSource?: string;

  /** Label sets this backend can provision */
  readonly labelSets: LabelSetConfig[];

  /** Per-backend maximum agents */
  readonly maxAgents: number;

  /**
   * Whether this backend spawns its agents on the orchestrator's own host.
   * True for bare-metal and Firecracker (local processes / local VMs) and for
   * container backends using a local runtime socket; false when the backend
   * provisions elsewhere (remote container runtime, future cloud backends).
   * Drives the static spawning-host display on the diagnostics page.
   */
  readonly spawnsOnLocalHost: boolean;

  /** Current count of agents managed by this backend (including spawning) */
  getActiveCount(): number;

  /**
   * Spawn an agent for the given label set.
   * @param labelSet - The exact label set to spawn for
   * @param agentId - Pre-generated agent ID for WS registration correlation
   * @param orchestratorUrl - URL for the agent to connect back to
   * @param onEvent - Lifecycle event callback
   * @param effectiveLimits - Resolved kernel-side limits (`{ cpus, memBytes }`)
   *   for this spawn. Computed by ScalerManager from the job/label-set/scaler
   *   default chain. When omitted (or both fields zero), the backend falls
   *   back to its label-set / default limits the same way it always has.
   * @param spawnContext - Identity of the bound job/run this spawn serves
   *   (omitted for unbound spawns, e.g. warm pool). Backends surface it on
   *   the provisioned resource for operator inspection.
   * @returns The managed agent tracking object
   * @throws If the label set is not supported by this backend
   */
  spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
    spawnContext?: SpawnContext,
  ): Promise<ManagedAgent>;

  /**
   * Destroy a specific managed agent.
   * Docker: docker rm -f; Bare-metal: SIGTERM -> SIGKILL
   */
  destroy(managedId: string): Promise<void>;

  /**
   * Get the LogCapture for a managed agent (optional -- container and bare-metal backends
   * support stdout capture. Firecracker handles log forwarding internally via file tailing
   * (serial console + VMM logs) and does not return a LogCapture here).
   */
  getLogCapture?(managedId: string): LogCapture | undefined;

  /** Shutdown all agents managed by this backend (called during graceful shutdown) */
  shutdownAll(): Promise<void>;

  /**
   * Return scaler-specific configuration metadata for a managed agent.
   * Used by the orchestrator to enrich job.context before forwarding to Platform.
   */
  getScalerContext?(agentId: string): Record<string, unknown> | undefined;

  /**
   * Reload configuration (called on SIGHUP).
   * Returns validation errors if new config is invalid.
   */
  reload(labelSets: LabelSetConfig[]): ValidationResult;
}

/**
 * Parsed and validated scaler configuration from YAML.
 * Loaded at startup and reloaded on SIGHUP.
 */
/**
 * Firecracker network configuration.
 * Defines the CIDR pool, bridge name, and gateway for VM networking.
 * Global across all Firecracker scalers on the orchestrator.
 */
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
}

/**
 * Parsed and validated scaler configuration from YAML.
 * Loaded at startup and reloaded on SIGHUP.
 */
export interface ScalerConfig {
  /** Config format version (currently always 1) */
  version: 1;
  /** Global maximum agents across all backends */
  globalMaxAgents: number;
  /** Global defaults applied to all label sets */
  defaults?: {
    /**
     * Default resource request and limit applied when neither the job nor the
     * label-set declares resources. Internal representation is always nested.
     */
    resources?: ResourceRequest;
  };
  /**
   * Cap on the total summed `requests` across every agent this orchestrator
   * has active (across all scalers). Counterpart to `globalMaxAgents` for
   * resource-based pressure.
   */
  globalResourceCap?: ResourceCap;
  /**
   * Optional named machine pools shared by scaler entries on the same host.
   * Each entry's cap is enforced via the file-backed ledger so multiple
   * orchestrator processes on one machine cannot collectively oversubscribe.
   */
  machinePools?: MachinePoolConfig[];
  /** Individual scaler backend configurations */
  scalers: ScalerEntry[];
  /** Global Firecracker network configuration (shared across all Firecracker scalers) */
  firecracker?: FirecrackerNetworkConfig;
}

/**
 * Configuration for a single scaler backend entry.
 */
export interface ScalerEntry {
  /** Human-readable name for this scaler */
  name: string;
  /** Backend type */
  type: Exclude<ScalerBackendType, 'kubernetes'>;
  /** Maximum concurrent agents for this scaler */
  maxAgents: number;
  /** Label-set to image/binary mappings */
  labelSets: LabelSetConfig[];
  /** Container runtime host (e.g. 'tcp://192.168.1.10:2376'). Works for both Docker and Podman remote. */
  host?: string;
  /** Explicit container runtime socket path. Overrides auto-detection. Use for non-standard socket locations. */
  socketPath?: string;
  /** Container runtime type. 'auto' probes known socket paths. Default: 'auto' */
  runtime?: 'docker' | 'podman' | 'auto';
  /** Orchestrator URL for spawned agents to connect back to */
  orchestratorUrl?: string;
  /** Extra host:IP mappings injected into spawned containers (e.g. ["verdaccio.local:host-gateway"]) */
  extraHosts?: string[];
  /** Disable nftables-based network isolation for container backend (default: true). Set to false when nft is unavailable. */
  networkIsolation?: boolean;
  /** Warm pool configuration */
  warmPool?: WarmPoolConfig;

  /**
   * Labels a job MUST declare in `runsOn` to be allowed on this scaler.
   * Mirrors the Kubernetes "taints" concept: a generic job that does not
   * include every mandatory label is blocked from this scaler entirely,
   * even when its other labels are a subset of one of the scaler's
   * `labelSets`. Default: `[]` (no gating).
   */
  mandatoryLabels?: string[];

  /**
   * Agent roles this scaler handles. scaler-entry level, not per-label-set.
   * - undefined (not set): handles all job types including build and init (backward compat,)
   * - []: execution jobs only, no build/init
   * - ['builder']: handles build jobs + execution
   * - ['init-runner']: handles init jobs + execution
   * - ['builder', 'init-runner']: handles both internal job types + execution
   * - ['all']: same as undefined
   */
  roles?: string[];

  /**
   * Cap on summed `requests` (cpus + memory) across active agents in this
   * scaler. Stacks with `maxAgents`; both must allow the spawn.
   */
  resourceCap?: ResourceCap;
  /**
   * Reference to a named machine pool defined at top level. Scalers that
   * reference the same pool name on the same host share a file-backed ledger
   * so multiple orchestrators can't collectively exceed the pool cap.
   */
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
   * Wrap privileged commands (`ip`, `chown`) with `sudo -n` when the
   * orchestrator runs as a non-root user (e.g. user-mode systemd on edge
   * worker nodes). Operators must have NOPASSWD sudoers entries for those
   * binaries. Default false.
   */
  requireSudo?: boolean;
}

/**
 * Warm pool configuration for pre-provisioned idle agents.
 */
export interface WarmPoolConfig {
  /** Whether the warm pool is enabled */
  enabled: boolean;
  /** Number of idle agents to maintain */
  size: number;
  /** Seconds before an idle warm-pool agent is destroyed
   * @default 300
   */
  idleTimeoutSeconds: number;
}

// ── Scaler lifecycle events ──────────────────────────────────────

/**
 * A single scaler lifecycle event.
 * Each backend emits these at key provisioning milestones.
 */
export interface ScalerEvent {
  agentId: string;
  eventType: z.infer<typeof ScalerEventType>;
  /** Backend-specific detail text (e.g. "pulling image nginx:latest", "booting microVM") */
  detail: string;
  timestampMs: number;
}

/**
 * Callback type for scaler event emission.
 * Passed from ScalerManager to each backend during spawn().
 */
export type ScalerEventCallback = (event: ScalerEvent) => void;

/**
 * Interface for capturing agent log output from scaler backends.
 * Each backend implements this to expose the spawned agent's stdout/stderr
 * as an async iterable of individual log lines.
 */
export interface LogCapture {
  /** Async iterable yielding individual log lines from the agent process. */
  lines(): AsyncIterable<string>;
  /**
   * Return the most recent buffered output lines (bounded ring buffer),
   * joined oldest→newest. Used to enrich a `scaler.failed` event when a
   * spawn dies before WS registration. Empty string when nothing captured.
   */
  tail(): string;
  /** Stop capturing and destroy underlying streams. Safe to call multiple times. */
  close(): void;
}
