/**
 * Container scaler backend implementation.
 *
 * Manages ephemeral agent containers using Docker or Podman via dockerode.
 * Supports auto-detection of container runtime socket.
 * Handles full container lifecycle: pull, create, start, stop, remove.
 * Supports container socket sharing, resource limits, and orphan cleanup.
 */

import { access, constants } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import Docker from 'dockerode';
import { createLogger, toErrorMessage, type ToolRequirement } from '@kici-dev/shared';
import { KICI_AGENT_ENV_PREFIX, scalerAgentLabels, ScalerBackendType } from '@kici-dev/engine';
import { normalizeLabelSet } from './label-matcher.js';
import {
  validateNftablesAvailability,
  ensureKiciTable,
  addIsolationRules,
  removeIsolationRules,
} from './nftables.js';
import { parseMemoryString } from './config.js';
import { ScalerEventType } from './types.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type {
  ScalerBackend,
  ManagedAgent,
  LabelSetConfig,
  LogCapture,
  ResourceRequest,
  EffectiveLimits,
  SpawnContext,
  ScalerEventCallback,
  ValidationResult,
  ScalerEntry,
} from './types.js';

const logger = createLogger({ prefix: 'container-backend' });

/** Name of the isolated bridge network for agent containers. */
const ISOLATED_NETWORK_NAME = 'kici-agent-net';

/** Subnet for the isolated agent network. */
const ISOLATED_NETWORK_SUBNET = '172.30.0.0/16';

/** Gateway IP for the isolated agent network (host-side). */
const ISOLATED_NETWORK_GATEWAY = '172.30.0.1';

/**
 * Result of runtime detection.
 */
export interface DetectedRuntime {
  socketPath: string;
  runtime: 'docker' | 'podman';
}

const PROBE_ORDER: Array<{ path: string; runtime: 'docker' | 'podman' }> = [
  { path: '/var/run/docker.sock', runtime: 'docker' },
  { path: '/run/podman/podman.sock', runtime: 'podman' },
];

/**
 * Probe known socket paths to detect which container runtime is available.
 * Returns the first accessible socket found, or null if none found.
 */
export async function detectRuntime(
  runtimeHint?: 'docker' | 'podman' | 'auto',
): Promise<DetectedRuntime | null> {
  const probes = [...PROBE_ORDER];

  // Add rootless Podman socket path
  const xdgDir = process.env.XDG_RUNTIME_DIR;
  if (xdgDir) {
    probes.push({
      path: `${xdgDir}/podman/podman.sock`,
      runtime: 'podman',
    });
  }

  // If runtime hint is specific, filter probes to only that runtime
  const filtered =
    runtimeHint && runtimeHint !== 'auto'
      ? probes.filter((p) => p.runtime === runtimeHint)
      : probes;

  for (const probe of filtered) {
    try {
      await access(probe.path, constants.R_OK | constants.W_OK);
      return { socketPath: probe.path, runtime: probe.runtime };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Create a LogCapture from a running container's stdout/stderr streams.
 * Uses dockerode's demuxStream to strip Docker's 8-byte multiplexed headers.
 */
async function createContainerLogCapture(docker: Docker, containerId: string): Promise<LogCapture> {
  const stream = (await docker.getContainer(containerId).logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: false,
  })) as unknown as NodeJS.ReadableStream;

  const passthrough = new PassThrough();
  docker.modem.demuxStream(stream, passthrough, passthrough);

  // Bounded ring buffer of the most recent output lines, kept so a container
  // that dies before WS registration can ride its stderr along in the
  // scaler.failed event detail.
  const TAIL_MAX_LINES = 50;
  const tailBuf: string[] = [];
  const pushTail = (line: string) => {
    tailBuf.push(line);
    if (tailBuf.length > TAIL_MAX_LINES) tailBuf.shift();
  };

  const rl = createInterface({ input: passthrough, crlfDelay: Infinity });
  rl.on('line', pushTail);

  return {
    async *lines() {
      for await (const line of rl) {
        yield line;
      }
    },
    tail() {
      return tailBuf.join('\n');
    },
    close() {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      rl.close();
    },
  };
}

export interface ContainerScalerBackendOptions {
  /** Human-readable name for this scaler */
  name: string;
  /** Label sets this backend can provision */
  labelSets: LabelSetConfig[];
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Container runtime host for remote connections (works for Docker and Podman remote) */
  host?: string;
  /** Explicit socket path (overrides auto-detection) */
  socketPath?: string;
  /** Runtime type hint: 'docker', 'podman', or 'auto' (default: 'auto') */
  runtime?: 'docker' | 'podman' | 'auto';
  /** Default resource limits applied when label set has none */
  defaultResources?: ResourceRequest;
  /** Extra host:IP mappings injected into spawned containers (e.g. ["verdaccio.local:host-gateway"]) */
  extraHosts?: string[];
  /** Disable nftables-based network isolation (default: true). Set to false when nft is unavailable (e.g. rootless containers without NET_ADMIN). */
  networkIsolation?: boolean;
  /** Token store for creating ephemeral agent auth tokens. Optional -- when undefined, no token is injected. */
  tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms. Default: 1 hour. */
  tokenTtlMs?: number;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  roles?: string[];
}

export class ContainerScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum.container;
  readonly spawnsOnLocalHost: boolean;
  readonly maxAgents: number;

  private _labelSets: LabelSetConfig[];
  private readonly name: string;
  private readonly docker: Docker;
  private readonly defaultResources?: ResourceRequest;
  /** The resolved socket path (for socket sharing bind mounts) */
  private readonly resolvedSocketPath: string;
  /** The detected or configured runtime type */
  private readonly detectedRuntime: 'docker' | 'podman';
  /** Extra host:IP mappings for spawned containers */
  private readonly extraHosts?: string[];
  /** Whether nftables-based network isolation is enabled */
  private readonly networkIsolation: boolean;
  /** Token store for creating ephemeral agent auth tokens */
  private readonly tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms */
  private readonly tokenTtlMs: number;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  private readonly roles: string[] | undefined;

  /** ID of the isolated bridge network (set after creation/discovery) */
  private isolatedNetworkId = '';
  /** Host bridge interface name for the isolated network (used by nftables) */
  private isolatedBridgeIface = '';

  /** Tracks all managed agent containers by ManagedAgent.id */
  private readonly agents = new Map<string, ManagedAgent>();
  /** Maps container ID to ManagedAgent.id for reverse lookup */
  private readonly containerToManaged = new Map<string, string>();
  /** LogCapture instances for each managed agent (keyed by ManagedAgent.id) */
  private readonly logCaptures = new Map<string, LogCapture>();
  /** Maps managedId → container IP on the isolated network (for per-container nftables cleanup) */
  private readonly containerIps = new Map<string, string>();

  private constructor(
    options: ContainerScalerBackendOptions,
    socketPath: string,
    runtime: 'docker' | 'podman',
  ) {
    this.name = options.name;
    this._labelSets = options.labelSets;
    this.maxAgents = options.maxAgents;
    this.defaultResources = options.defaultResources;
    this.extraHosts = options.extraHosts;
    this.networkIsolation = options.networkIsolation !== false;
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.roles = options.roles;
    this.resolvedSocketPath = socketPath;
    this.detectedRuntime = runtime;
    // A configured remote runtime host means containers spawn on that machine,
    // not on this orchestrator's host.
    this.spawnsOnLocalHost = !options.host;

    if (options.host) {
      this.docker = new Docker({ host: options.host });
      // For remote connections, we don't have a local socket
      this.resolvedSocketPath = '';
      this.detectedRuntime = options.runtime === 'podman' ? 'podman' : 'docker';
    } else {
      this.docker = new Docker({ socketPath });
    }
  }

  /**
   * Ensure the isolated bridge network exists and nftables rules are applied.
   *
   * Creates `kici-agent-net` if it doesn't exist, inspects the network to
   * discover the host bridge interface name, then applies RFC1918 + metadata
   * blocking rules via nftables with a gateway exception.
   *
   * Idempotent: safe to call across orchestrator restarts.
   */
  private async ensureIsolatedNetwork(): Promise<void> {
    // 1. Check if network already exists (Docker's name filter does substring matching)
    const networks = await this.docker.listNetworks({
      filters: { name: [ISOLATED_NETWORK_NAME] },
    });
    const existing = networks.find((n) => n.Name === ISOLATED_NETWORK_NAME);

    let networkId: string;

    if (existing) {
      networkId = existing.Id;
      logger.info(
        `Isolated network ${ISOLATED_NETWORK_NAME} already exists (${networkId.slice(0, 12)})`,
      );
    } else {
      // 2. Create the network
      try {
        const network = await this.docker.createNetwork({
          Name: ISOLATED_NETWORK_NAME,
          Driver: 'bridge',
          IPAM: {
            Config: [{ Subnet: ISOLATED_NETWORK_SUBNET, Gateway: ISOLATED_NETWORK_GATEWAY }],
          },
          Labels: { 'kici-managed': 'true' },
        });
        networkId = network.id;
        logger.info(
          `Created isolated network ${ISOLATED_NETWORK_NAME} (${networkId.slice(0, 12)})`,
        );
      } catch (err: unknown) {
        // Handle race condition: 409 means another instance created it concurrently
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 409) {
          logger.info('Isolated network creation raced -- using existing network');
          const retryNetworks = await this.docker.listNetworks({
            filters: { name: [ISOLATED_NETWORK_NAME] },
          });
          const found = retryNetworks.find((n) => n.Name === ISOLATED_NETWORK_NAME);
          if (!found) {
            throw new Error(
              `Failed to find isolated network ${ISOLATED_NETWORK_NAME} after 409 conflict`,
            );
          }
          networkId = found.Id;
        } else {
          throw err;
        }
      }
    }

    this.isolatedNetworkId = networkId;

    // 3. Inspect network to get the host bridge interface name
    const networkInfo = await this.docker.getNetwork(networkId).inspect();
    // Docker stores bridge name in Options['com.docker.network.bridge.name']
    // Podman/netavark may use a different key or generate br-<id> pattern
    const bridgeName =
      networkInfo.Options?.['com.docker.network.bridge.name'] ?? `br-${networkId.slice(0, 12)}`;
    this.isolatedBridgeIface = bridgeName;

    logger.info(`Isolated network bridge interface: ${bridgeName}`);

    // 4. Prepare nftables table (skip when network isolation is disabled)
    // Per-container rules are applied during spawn(), not here.
    if (this.networkIsolation) {
      await ensureKiciTable();
      logger.info('nftables kici table ready — per-container rules will be applied during spawn');
    } else {
      logger.warn(
        'Network isolation DISABLED for container backend — nftables rules will NOT be applied. ' +
          'Agent containers will have unrestricted network access.',
      );
    }
  }

  /**
   * Declare required tools for a container scaler entry.
   *
   * For the auto-detect case (no explicit socketPath / remote host) the
   * orchestrator must have a local container runtime — docker OR podman — on
   * PATH, otherwise the scaler cannot spawn agent containers. Declaring it
   * here lets the startup tool-validation gate fail fast with a clear error
   * instead of the first job hanging. When a socketPath or remote host is
   * configured the binary need not be on PATH (the runtime may be remote), so
   * reachability is validated later in create().
   */
  static getRequiredTools(entry: ScalerEntry): ToolRequirement[] {
    if (entry.host || entry.socketPath) {
      return [];
    }
    return [
      {
        type: 'any-path-binary',
        names: ['docker', 'podman'],
        reason:
          `container scaler "${entry.name}" needs a local container runtime to spawn agents. ` +
          `Install Docker or Podman, or set socketPath / host in scalers.yaml for a remote runtime.`,
      },
    ];
  }

  /**
   * Create a ContainerScalerBackend with auto-detected or configured socket.
   * Throws if no container runtime is found and no host is configured.
   */
  static async create(options: ContainerScalerBackendOptions): Promise<ContainerScalerBackend> {
    // Validate nftables availability before any other setup (skip when networkIsolation is disabled)
    if (options.networkIsolation !== false) {
      await validateNftablesAvailability();
    }

    let backend: ContainerScalerBackend;

    if (options.host) {
      // Remote connection -- no socket detection needed
      const runtime = options.runtime === 'podman' ? 'podman' : 'docker';
      backend = new ContainerScalerBackend(options, '', runtime);
    } else if (options.socketPath) {
      // Explicit socket path -- detect runtime type from path
      const runtime = options.socketPath.includes('podman') ? 'podman' : 'docker';
      logger.info(`Using configured socket at ${options.socketPath}`, { runtime });
      backend = new ContainerScalerBackend(options, options.socketPath, runtime);
    } else {
      // Auto-detect
      const detected = await detectRuntime(options.runtime);
      if (!detected) {
        throw new Error('No container runtime found. Install Docker or Podman, or configure host.');
      }

      logger.info(`Detected ${detected.runtime} at ${detected.socketPath}`);
      backend = new ContainerScalerBackend(options, detected.socketPath, detected.runtime);
    }

    // Create isolated network and apply nftables rules before any containers are spawned
    if (options.networkIsolation !== false) {
      await backend.ensureIsolatedNetwork();
    } else {
      logger.info('Network isolation disabled — skipping isolated network and nftables setup');
    }

    return backend;
  }

  /** Log source identifier: 'docker' or 'podman' based on detected runtime. */
  get logsSource(): string {
    return this.detectedRuntime;
  }

  get labelSets(): LabelSetConfig[] {
    return this._labelSets;
  }

  getActiveCount(): number {
    return this.agents.size;
  }

  async spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
    spawnContext?: SpawnContext,
  ): Promise<ManagedAgent> {
    const emit = (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => {
      onEvent?.({ agentId, eventType, detail, timestampMs: Date.now() });
    };

    // Find matching label set config
    const normalizedTarget = normalizeLabelSet(labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );
    if (!matchedLabelSet) {
      throw new Error(
        `Label set [${labelSet.join(', ')}] not supported by container backend "${this.name}"`,
      );
    }

    // Check capacity
    if (this.getActiveCount() >= this.maxAgents) {
      throw new Error(
        `Container backend "${this.name}" at capacity (${this.maxAgents}/${this.maxAgents})`,
      );
    }

    // Create ManagedAgent tracking
    const managed: ManagedAgent = {
      id: agentId,
      labelSet,
      backendRef: '',
      spawnedAt: Date.now(),
      state: 'spawning',
    };
    this.agents.set(managed.id, managed);

    try {
      // Forward KICI_AGENT_ENV_ prefixed vars from orchestrator process.env
      const agentEnvForwarded: string[] = [];
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith(KICI_AGENT_ENV_PREFIX) && value !== undefined) {
          const stripped = key.slice(KICI_AGENT_ENV_PREFIX.length);
          if (stripped.length > 0) agentEnvForwarded.push(`${stripped}=${value}`);
        }
      }

      // Full label set the agent will present (base + scaler-assigned kici:
      // labels). Bind the ephemeral token to exactly this set so the agent's
      // register-time labels don't trip the scope gate — the agent adds only
      // self-reported os/arch/host facts on top, which the gate exempts.
      const fullLabels = scalerAgentLabels(labelSet, this.type, this.name, this.roles);

      // Create ephemeral agent token if token store is available
      let agentToken: string | undefined;
      if (this.tokenStore) {
        agentToken = await this.tokenStore.createEphemeral(agentId, fullLabels, this.tokenTtlMs);
      }

      // Build env array
      const env: string[] = [
        `KICI_ORCHESTRATOR_URL=${orchestratorUrl}`,
        `KICI_AGENT_ID=${agentId}`,
        `KICI_LABELS=${fullLabels.join(',')}`,
        `KICI_SCALER_MANAGED=1`,
        `KICI_EXECUTION_MODE=bare-metal`,
        ...(agentToken ? [`KICI_AGENT_TOKEN=${agentToken}`] : []),
        ...(matchedLabelSet.backpressureMode
          ? [`KICI_BACKPRESSURE_MODE=${matchedLabelSet.backpressureMode}`]
          : []),
        ...agentEnvForwarded,
        ...Object.entries(matchedLabelSet.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ];

      // Build binds array (user-defined volumes + optional container socket)
      const binds: string[] = [...(matchedLabelSet.volumes ?? [])];
      if (matchedLabelSet.containerSocket && this.resolvedSocketPath) {
        // Mount at native path (not remapped to /var/run/docker.sock)
        binds.push(`${this.resolvedSocketPath}:${this.resolvedSocketPath}`);
      }

      // Resolve resource limits.
      // 1. `effectiveLimits` from ScalerManager wins -- it already accounts for
      //    job overrides, label-set, and scaler defaults.
      // 2. Otherwise fall back to `matchedLabelSet.resources?.limits`.
      // 3. Otherwise fall back to `this.defaultResources?.limits`.
      let memoryBytes: number | undefined;
      let nanoCpus: number | undefined;

      if (effectiveLimits && (effectiveLimits.cpus || effectiveLimits.memBytes)) {
        if (effectiveLimits.memBytes) memoryBytes = effectiveLimits.memBytes;
        if (effectiveLimits.cpus) nanoCpus = effectiveLimits.cpus * 1e9;
      } else {
        const resources = matchedLabelSet.resources ?? this.defaultResources;
        const limits = resources?.limits;
        if (limits?.memory) {
          memoryBytes = parseMemoryString(limits.memory);
        }
        if (limits?.cpus) {
          nanoCpus = limits.cpus * 1e9;
        }
      }

      // Pull image based on pull policy
      const pullPolicy = matchedLabelSet.imagePullPolicy ?? 'Always';
      let shouldPull = pullPolicy === 'Always';

      if (pullPolicy === 'IfNotPresent') {
        try {
          await this.docker.getImage(matchedLabelSet.image!).inspect();
          shouldPull = false;
        } catch {
          shouldPull = true;
        }
      }

      if (shouldPull) {
        emit(ScalerEventType.enum['scaler.provisioning'], `pulling image ${matchedLabelSet.image}`);
        const stream = await this.docker.pull(matchedLabelSet.image!);
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Create container attached to the isolated network
      emit(ScalerEventType.enum['scaler.provisioning'], 'creating container');
      const normalizedLabelSetStr = normalizeLabelSet(labelSet);
      const container = await this.docker.createContainer({
        Image: matchedLabelSet.image!,
        Env: env,
        Labels: {
          'kici-managed': 'true',
          'kici-scaler-name': this.name,
          'kici-agent-id': agentId,
          'kici-labels': normalizedLabelSetStr,
          // Bound-work identity, when this spawn serves a specific job: lets
          // an operator (or a test) map a running container back to the
          // job/run it was provisioned for via `podman ps --filter label=…`.
          ...(spawnContext?.boundJobId && { 'kici-bound-job-id': spawnContext.boundJobId }),
          ...(spawnContext?.runId && { 'kici-run-id': spawnContext.runId }),
        },
        HostConfig: {
          Memory: memoryBytes,
          NanoCpus: nanoCpus,
          Binds: binds.length > 0 ? binds : undefined,
          ExtraHosts: this.extraHosts?.length ? this.extraHosts : undefined,
          AutoRemove: false,
        },
        ...(this.networkIsolation && {
          NetworkingConfig: {
            EndpointsConfig: {
              [ISOLATED_NETWORK_NAME]: {},
            },
          },
        }),
      });

      // Emit network event if network isolation is enabled
      if (this.networkIsolation) {
        emit(ScalerEventType.enum['scaler.network'], 'configuring network isolation');
      }

      // Start container
      await container.start();
      emit(ScalerEventType.enum['scaler.ready'], 'container started');

      // Apply per-container nftables isolation rules based on container IP
      if (this.networkIsolation) {
        const info = await this.docker.getContainer(container.id).inspect();
        const containerIp = info.NetworkSettings?.Networks?.[ISOLATED_NETWORK_NAME]?.IPAddress as
          | string
          | undefined;
        if (containerIp) {
          this.containerIps.set(managed.id, containerIp);
          await addIsolationRules(
            containerIp,
            ISOLATED_NETWORK_GATEWAY,
            matchedLabelSet.networkPolicy,
            'saddr',
          );
        } else {
          logger.warn('Could not determine container IP for nftables rules', { agentId });
        }
      }

      // Create log capture from container stdout/stderr
      try {
        const capture = await createContainerLogCapture(this.docker, container.id);
        this.logCaptures.set(managed.id, capture);
      } catch (err) {
        logger.warn('Failed to create log capture for container', {
          agentId,
          error: toErrorMessage(err),
        });
      }

      // Update tracking
      managed.state = 'running';
      managed.backendRef = container.id;
      this.containerToManaged.set(container.id, managed.id);

      emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration');

      return managed;
    } catch (err) {
      // Emit failure event before cleanup, enriching with any captured
      // container output so a "binary found but crashed on startup" failure
      // carries its stderr along.
      const t = this.logCaptures.get(managed.id)?.tail() ?? '';
      const base = toErrorMessage(err);
      emit(
        ScalerEventType.enum['scaler.failed'],
        t ? `${base}\n--- captured output ---\n${t}` : base,
      );
      // Clean up per-container nftables rules if applied
      const failedIp = this.containerIps.get(managed.id);
      if (failedIp) {
        try {
          await removeIsolationRules(failedIp);
        } catch {
          // Best effort
        }
        this.containerIps.delete(managed.id);
      }
      // Clean up tracking on failure
      this.agents.delete(managed.id);
      throw err;
    }
  }

  getScalerContext(agentId: string): Record<string, unknown> | undefined {
    const managed = this.agents.get(agentId);
    if (!managed) return undefined;

    const normalizedTarget = normalizeLabelSet(managed.labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );

    return {
      backendType: 'container',
      scalerName: this.name,
      image: matchedLabelSet?.image,
      imagePullPolicy: matchedLabelSet?.imagePullPolicy ?? 'Always',
      runtime: this.detectedRuntime,
      resources: matchedLabelSet?.resources ?? this.defaultResources,
      networkIsolation: this.networkIsolation,
      volumes: matchedLabelSet?.volumes,
      extraHosts: this.extraHosts,
    };
  }

  async destroy(managedId: string): Promise<void> {
    const managed = this.agents.get(managedId);
    if (!managed) return;

    managed.state = 'destroying';

    // Capture container IP before clearing tracking maps
    const containerIp = this.containerIps.get(managedId);
    this.containerIps.delete(managedId);

    // Remove from tracking maps IMMEDIATELY before any async operations.
    // This ensures getActiveCount() reflects the reduced count right away,
    // preventing state corruption where subsequent spawns see stale active counts
    // (e.g., after lock-file-drift failure when destroy is called fire-and-forget).
    this.containerToManaged.delete(managed.backendRef);
    this.agents.delete(managedId);

    // Clean up per-container nftables rules (before container stop)
    if (containerIp && this.networkIsolation) {
      try {
        await removeIsolationRules(containerIp);
      } catch {
        // Best effort -- cleanup should not block destruction
      }
    }

    // Close log capture before stopping container
    const capture = this.logCaptures.get(managedId);
    if (capture) {
      capture.close();
      this.logCaptures.delete(managedId);
    }

    // Container cleanup is best-effort -- internal state is already consistent
    try {
      const container = this.docker.getContainer(managed.backendRef);

      try {
        await container.stop({ t: 10 });
      } catch {
        // Container may already be stopped
      }

      try {
        await container.remove({ force: true });
      } catch {
        // Container may already be removed
      }
    } catch {
      // Container may not exist at all
    }
  }

  /**
   * Get the LogCapture for a managed agent (used by ScalerManager for log forwarding).
   */
  getLogCapture(managedId: string): LogCapture | undefined {
    return this.logCaptures.get(managedId);
  }

  async shutdownAll(): Promise<void> {
    // Per-container nftables rules are cleaned up inside each destroy() call
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  reload(labelSets: LabelSetConfig[]): ValidationResult {
    // Validate: all container label sets must have an image
    const errors: string[] = [];
    labelSets.forEach((ls, i) => {
      if (!ls.image) {
        errors.push(`Label set [${i}] requires an 'image' field for container backend`);
      }
    });

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    this._labelSets = labelSets;
    return { valid: true };
  }

  /**
   * Clean up orphaned kici-managed containers on startup.
   * Finds containers with the `kici-managed=true` label and removes them.
   * Returns the count of cleaned containers.
   */
  async cleanupOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ['kici-managed=true'],
      },
    });

    let cleaned = 0;
    for (const info of containers) {
      const container = this.docker.getContainer(info.Id);
      try {
        await container.stop({ t: 5 });
      } catch {
        // May already be stopped
      }
      try {
        await container.remove({ force: true });
        cleaned++;
      } catch {
        // Best effort
      }
    }

    return cleaned;
  }
}
