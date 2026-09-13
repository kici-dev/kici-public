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
import { buildAgentContainerHostConfig } from './container-hostconfig.js';
import {
  validateNftablesAvailability,
  ensureKiciTable,
  addIsolationRules,
  addHostIsolationRules,
  removeIsolationRules,
  listIsolationRules,
  deleteForwardRules,
} from '@kici-dev/shared/net';
import { parseMemoryString } from './config.js';
import { resolveAgentHostAccess } from './host-access.js';
import { ImagePullPolicy, ScalerEventType } from './types.js';
import {
  pullImageIfMissing,
  ensureRuntimeVolume,
  runtimeInjectBind,
  injectedAgentCommand,
} from '@kici-dev/shared/container-runtime';
import type { AgentTokenStore } from '../agent/token-store.js';
import type { NetworkPolicy } from '@kici-dev/shared/net';
import type {
  ScalerBackend,
  ScalerDestroyContext,
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
export const ISOLATED_NETWORK_NAME = 'kici-agent-net';

/** Subnet for the isolated agent network. */
const ISOLATED_NETWORK_SUBNET = '172.30.0.0/16';

/** Gateway IP for the isolated agent network (host-side). */
export const ISOLATED_NETWORK_GATEWAY = '172.30.0.1';

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
  /**
   * Extra `hostAccess` entries the orchestrator itself directed agents at —
   * today its object-storage endpoint. Folded into the agent default so the
   * narrowing does not cut off a host-local object store.
   */
  hostServices?: string[];
  /** Token store for creating ephemeral agent auth tokens. Optional -- when undefined, no token is injected. */
  tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms. Default: 1 hour. */
  tokenTtlMs?: number;
  /**
   * Live resolver for the ephemeral agent-token TTL (ms). When set, called per
   * spawn so the leader can serve the fleet-wide
   * `cluster_settings.agent_token_ttl_ms` override; falls back to `tokenTtlMs`.
   */
  tokenTtlProvider?: () => Promise<number>;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  roles?: string[];
  /**
   * Whether an agent id is currently registered with this orchestrator.
   *
   * Used by `cleanupOrphans` to distinguish a running container whose agent is
   * doing work from one whose agent never registered (or has gone). Defaults
   * to "assume registered" when unwired, so an un-plumbed caller never reaps a
   * live agent.
   */
  isRegistered?: (agentId: string) => boolean;
}

/**
 * Create or find the isolated agent bridge network, and return its id.
 *
 * Module-level rather than a method because the bare-metal backend's container
 * mode attaches its agent containers to the same network: both agent-container
 * spawn paths must land on it, or one of them runs on the runtime's default
 * bridge with full LAN, RFC1918 and cloud-metadata reach.
 *
 * Idempotent, including against a concurrent creator (409).
 */
export async function ensureIsolatedNetwork(docker: Docker): Promise<string> {
  // Docker's name filter does substring matching, so the exact name is checked.
  const networks = await docker.listNetworks({ filters: { name: [ISOLATED_NETWORK_NAME] } });
  const existing = networks.find((n) => n.Name === ISOLATED_NETWORK_NAME);
  if (existing) {
    logger.info(
      `Isolated network ${ISOLATED_NETWORK_NAME} already exists (${existing.Id.slice(0, 12)})`,
    );
    return existing.Id;
  }

  try {
    const network = await docker.createNetwork({
      Name: ISOLATED_NETWORK_NAME,
      Driver: 'bridge',
      IPAM: {
        Config: [{ Subnet: ISOLATED_NETWORK_SUBNET, Gateway: ISOLATED_NETWORK_GATEWAY }],
      },
      Labels: { 'kici-managed': 'true' },
    });
    logger.info(`Created isolated network ${ISOLATED_NETWORK_NAME} (${network.id.slice(0, 12)})`);
    return network.id;
  } catch (err: unknown) {
    // 409 means another instance created it concurrently.
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    logger.info('Isolated network creation raced -- using existing network');
    const retryNetworks = await docker.listNetworks({
      filters: { name: [ISOLATED_NETWORK_NAME] },
    });
    const found = retryNetworks.find((n) => n.Name === ISOLATED_NETWORK_NAME);
    if (!found) {
      throw new Error(
        `Failed to find isolated network ${ISOLATED_NETWORK_NAME} after 409 conflict`,
      );
    }
    return found.Id;
  }
}

export class ContainerScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum.container;
  readonly spawnsOnLocalHost: boolean;
  maxAgents: number;

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
  /** Host services the orchestrator directed agents at, as `hostAccess` entries. */
  private readonly hostServices?: string[];
  /** Token store for creating ephemeral agent auth tokens */
  private readonly tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms */
  private readonly tokenTtlMs: number;
  /** Live per-spawn resolver for the ephemeral agent-token TTL (ms). */
  private readonly tokenTtlProvider?: () => Promise<number>;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  private readonly roles: string[] | undefined;
  /** Registration probe for the orphan sweep; fail-safe default assumes registered. */
  private readonly isRegistered: (agentId: string) => boolean;

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
    this.hostServices = options.hostServices;
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.tokenTtlProvider = options.tokenTtlProvider;
    this.roles = options.roles;
    this.isRegistered = options.isRegistered ?? (() => true);
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
    const networkId = await ensureIsolatedNetwork(this.docker);
    this.isolatedNetworkId = networkId;

    // Inspect network to get the host bridge interface name.
    const networkInfo = await this.docker.getNetwork(networkId).inspect();
    // Docker stores bridge name in Options['com.docker.network.bridge.name']
    // Podman/netavark may use a different key or generate br-<id> pattern
    const bridgeName =
      networkInfo.Options?.['com.docker.network.bridge.name'] ?? `br-${networkId.slice(0, 12)}`;
    this.isolatedBridgeIface = bridgeName;

    logger.info(`Isolated network bridge interface: ${bridgeName}`);

    // Prepare nftables table (skip when network isolation is disabled).
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

  /**
   * The full label set the agent will present, and the ephemeral token bound to
   * exactly that set.
   *
   * The binding is the point: the agent's register-time labels must not trip the
   * scope gate, and the only labels it may add on top are the self-reported
   * os/arch/host facts the gate exempts. The pool's platform taints are NOT such
   * a fact — they are a routing grant, so the manager asserts them here via
   * `spawnContext` rather than letting the agent claim them.
   */
  private async mintAgentIdentity(
    labelSet: string[],
    agentId: string,
    spawnContext: SpawnContext | undefined,
  ): Promise<{ fullLabels: string[]; agentToken?: string }> {
    const fullLabels = scalerAgentLabels(
      labelSet,
      this.type,
      this.name,
      this.roles,
      spawnContext?.platformTaints,
    );
    if (!this.tokenStore) return { fullLabels };
    const tokenTtlMs = this.tokenTtlProvider ? await this.tokenTtlProvider() : this.tokenTtlMs;
    const agentToken = await this.tokenStore.createEphemeral(agentId, fullLabels, tokenTtlMs);
    return { fullLabels, agentToken };
  }

  /**
   * Write one agent container's nftables rules, on both hooks.
   *
   * `forward` governs what the container reaches THROUGH the host; `input`
   * governs what it reaches ON the host. A packet to one of the host's own
   * addresses is delivered on input and never traverses forward, so the two
   * are not interchangeable and both are written here.
   */
  private async applyIsolationRules(args: {
    agentId: string;
    managedId: string;
    containerId: string;
    networkPolicy?: NetworkPolicy;
    orchestratorUrl: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const info = await this.docker
      .getContainer(args.containerId)
      .inspect({ abortSignal: args.signal } as Docker.ContainerInspectOptions);
    const containerIp = info.NetworkSettings?.Networks?.[ISOLATED_NETWORK_NAME]?.IPAddress as
      string | undefined;
    if (!containerIp) {
      logger.warn('Could not determine container IP for nftables rules', {
        agentId: args.agentId,
      });
      return;
    }

    this.containerIps.set(args.managedId, containerIp);
    // Pre-clean: the network recycles addresses, and a crash or a `kill -9`
    // leaves the previous holder's rules — allowlist included — for this
    // container to inherit. Idempotent and cheap.
    await removeIsolationRules(containerIp);
    await addIsolationRules(containerIp, ISOLATED_NETWORK_GATEWAY, args.networkPolicy, 'saddr');
    await addHostIsolationRules(
      containerIp,
      resolveAgentHostAccess({
        policy: args.networkPolicy,
        orchestratorUrl: args.orchestratorUrl,
        gateway: ISOLATED_NETWORK_GATEWAY,
        ...(this.hostServices ? { hostServices: this.hostServices } : {}),
      }),
      'saddr',
    );
  }

  async spawn(
    labelSet: string[],
    agentId: string,
    orchestratorUrl: string,
    onEvent?: ScalerEventCallback,
    effectiveLimits?: EffectiveLimits,
    spawnContext?: SpawnContext,
    signal?: AbortSignal,
  ): Promise<ManagedAgent> {
    const emit = (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => {
      onEvent?.({ agentId, eventType, detail, timestampMs: Date.now() });
    };
    // A container created before an abort/failure; removed best-effort in the
    // catch with a fresh (unsignalled) request so cleanup isn't cancelled by
    // the same abort that triggered the failure path.
    let createdContainer: Docker.Container | undefined;

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

    // The agent inside the container registers over WS the moment `start`
    // returns it to life, and can finish its job and disconnect while this
    // method is still awaiting the runtime (a `start` or `logs` call takes
    // 60–95 s under batch load). That disconnect runs `destroy`, which drops
    // the tracking entry — so after every await past that point the spawn
    // checks it still owns one, and unwinds through the catch when it does
    // not: the container it created is removed, and the manager's
    // failure branch releases the reservation. Resolving instead would hand
    // the manager an agent that no longer exists and leave a log capture
    // open on a removed container.
    const assertStillTracked = (): void => {
      if (this.agents.get(managed.id) !== managed) {
        throw new Error(`Agent ${agentId} was torn down while its container was being provisioned`);
      }
    };

    try {
      // Forward KICI_AGENT_ENV_ prefixed vars from orchestrator process.env
      const agentEnvForwarded: string[] = [];
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith(KICI_AGENT_ENV_PREFIX) && value !== undefined) {
          const stripped = key.slice(KICI_AGENT_ENV_PREFIX.length);
          if (stripped.length > 0) agentEnvForwarded.push(`${stripped}=${value}`);
        }
      }

      const { fullLabels, agentToken } = await this.mintAgentIdentity(
        labelSet,
        agentId,
        spawnContext,
      );

      // Build env array
      const env: string[] = [
        `KICI_ORCHESTRATOR_URL=${orchestratorUrl}`,
        `KICI_AGENT_ID=${agentId}`,
        `KICI_LABELS=${fullLabels.join(',')}`,
        `KICI_SCALER_MANAGED=1`,
        `KICI_EXECUTION_MODE=bare-metal`,
        // Where the agent materializes the KiCI runtime from when it NESTS a
        // job container. The pool's own agent image carries /opt/kici and is
        // present on this host by construction, so it is the one image the
        // agent can always reach. Unused by a per-job-image spawn, which runs
        // the steps directly rather than nesting.
        `KICI_RUNTIME_IMAGE=${matchedLabelSet.image!}`,
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
      let resolvedLimits: EffectiveLimits;

      if (effectiveLimits && (effectiveLimits.cpus || effectiveLimits.memBytes)) {
        resolvedLimits = effectiveLimits;
      } else {
        const resources = matchedLabelSet.resources ?? this.defaultResources;
        const limits = resources?.limits;
        resolvedLimits = {
          ...(limits?.memory ? { memBytes: parseMemoryString(limits.memory) } : {}),
          ...(limits?.cpus ? { cpus: limits.cpus } : {}),
        };
      }

      // Pull image based on pull policy. Default IfNotPresent: KiCI agent
      // images are pinned + immutable, so re-pulling on every spawn only storms
      // the registry/socket. A label set on a moving tag sets `Always`.
      // A job that declared its own container image is spawned on THAT image,
      // with the KiCI runtime injected so it needs neither Node nor git. Absent
      // one, the pool's fixed agent image is used exactly as before — the agent
      // image already carries the runtime, so nothing is injected into it.
      const jobContainer = spawnContext?.container;
      const spawnImage = jobContainer?.image ?? matchedLabelSet.image!;

      await pullImageIfMissing({
        docker: this.docker,
        image: spawnImage,
        // A per-job image is the customer's, not ours — it is not pinned and
        // immutable the way an agent image is, so the label set's policy does
        // not describe it.
        ...(!jobContainer && matchedLabelSet.imagePullPolicy
          ? { pullPolicy: matchedLabelSet.imagePullPolicy }
          : {}),
        ...(jobContainer?.authconfig ? { authconfig: jobContainer.authconfig } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (message) => emit(ScalerEventType.enum['scaler.provisioning'], message),
      });

      // Inject the KiCI runtime for a per-job image. Materialized out of the
      // agent image into a named volume, because a bind mount needs a HOST path
      // and the orchestrator may itself be containerized.
      if (jobContainer) {
        // Tell the agent it IS the job's image. Without this it sees the job's
        // `container:` field, decides it needs a container, and nests a second
        // one from the same image — a runtime inside a runtime.
        env.push('KICI_JOB_IMAGE_AGENT=1');

        const runtimeVolume = await ensureRuntimeVolume({
          docker: this.docker,
          agentImage: matchedLabelSet.image!,
          ...(signal ? { signal } : {}),
          onProgress: (message) => emit(ScalerEventType.enum['scaler.provisioning'], message),
        });
        binds.push(runtimeInjectBind(runtimeVolume));
      }

      // Create container attached to the isolated network
      emit(ScalerEventType.enum['scaler.provisioning'], 'creating container');
      const normalizedLabelSetStr = normalizeLabelSet(labelSet);
      const container = await this.docker.createContainer({
        abortSignal: signal,
        Image: spawnImage,
        // A per-job image declares its own CMD, so the agent has to be named
        // explicitly or the container runs the customer's entrypoint and no
        // agent ever registers. The pool's own agent image already starts the
        // agent by default, so it keeps its CMD.
        ...(jobContainer ? { Cmd: injectedAgentCommand() } : {}),
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
        HostConfig: buildAgentContainerHostConfig({
          limits: resolvedLimits,
          binds,
          ...(this.extraHosts ? { extraHosts: this.extraHosts } : {}),
        }),
        ...(this.networkIsolation && {
          NetworkingConfig: {
            EndpointsConfig: {
              [ISOLATED_NETWORK_NAME]: {},
            },
          },
        }),
      });

      createdContainer = container;
      // Record the container the moment it exists, not when the spawn
      // completes: a `destroy` that lands in between must stop and remove
      // THIS container, not the empty ref the entry was created with.
      managed.backendRef = container.id;
      this.containerToManaged.set(container.id, managed.id);
      assertStillTracked();

      // Emit network event if network isolation is enabled
      if (this.networkIsolation) {
        emit(ScalerEventType.enum['scaler.network'], 'configuring network isolation');
      }

      // Start container
      await container.start({ abortSignal: signal } as Docker.ContainerStartOptions);
      assertStillTracked();
      emit(ScalerEventType.enum['scaler.ready'], 'container started');

      // Apply per-container nftables isolation rules based on container IP
      if (this.networkIsolation) {
        await this.applyIsolationRules({
          agentId,
          managedId: managed.id,
          containerId: container.id,
          networkPolicy: matchedLabelSet.networkPolicy,
          orchestratorUrl,
          ...(signal ? { signal } : {}),
        });
        assertStillTracked();
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
      assertStillTracked();

      // Update tracking
      managed.state = 'running';

      emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration');

      return managed;
    } catch (err) {
      // Emit failure event before cleanup, enriching with any captured
      // container output so a "binary found but crashed on startup" failure
      // carries its stderr along. The capture is closed here too: its stream
      // follows a container this path is about to remove.
      const capture = this.logCaptures.get(managed.id);
      const t = capture?.tail() ?? '';
      if (capture) {
        capture.close();
        this.logCaptures.delete(managed.id);
      }
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
      // A hung/aborted provision may have created a container before failing;
      // remove it best-effort with a fresh (unsignalled) request so cleanup
      // itself isn't cancelled by the same abort that triggered this path.
      if (createdContainer) {
        this.containerToManaged.delete(createdContainer.id);
        try {
          await createdContainer.remove({ force: true });
        } catch {
          // Best effort — container may not exist or already be gone.
        }
      }
      // Clean up tracking on failure. Only this spawn's own entry: a destroy
      // that already ran has dropped it, and nothing may have re-registered
      // the id in between.
      if (this.agents.get(managed.id) === managed) this.agents.delete(managed.id);
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
      imagePullPolicy: matchedLabelSet?.imagePullPolicy ?? ImagePullPolicy.enum.IfNotPresent,
      runtime: this.detectedRuntime,
      resources: matchedLabelSet?.resources ?? this.defaultResources,
      networkIsolation: this.networkIsolation,
      volumes: matchedLabelSet?.volumes,
      extraHosts: this.extraHosts,
    };
  }

  async destroy(managedId: string, _context?: ScalerDestroyContext): Promise<void> {
    // _context (teardown reason) is only meaningful to the event backend; a
    // container teardown is the same regardless of why it was requested.
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

    // No container yet: the spawn is still waiting on `createContainer`, and
    // its own unwind removes whatever that call returns (see `spawn`). An
    // empty ref must never reach the runtime — dockerode turns it into
    // `POST /containers//stop`, podman answers with a redirect, and
    // docker-modem follows it to a request nothing listens to for errors: the
    // `getaddrinfo ENOTFOUND containers` that killed the process.
    if (!managed.backendRef) return;

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

  reload(
    labelSets: LabelSetConfig[],
    opts?: { maxAgents?: number; entry?: ScalerEntry },
  ): ValidationResult {
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
    if (opts?.maxAgents !== undefined) {
      this.maxAgents = opts.maxAgents;
    }
    return { valid: true };
  }

  /**
   * Clean up this scaler's orphaned containers and stale isolation rules.
   *
   * Every filter below exists because the sweep used to list every
   * `kici-managed=true` container on the host and force-remove it, running at
   * orchestrator boot, at worker-peer start, on a live config reload that adds
   * a scaler, and from `kici-admin scaler reap-orphans`. Two orchestrators
   * sharing one docker host therefore killed each other's running agents on
   * every boot, and adding a second container scaler removed the first one's
   * agents mid-job — every in-flight job failing as "agent disconnected" on a
   * healthy system.
   *
   * A container is removed only when all of these hold:
   *  - it carries this scaler's own `kici-scaler-name`, so a backend can only
   *    ever reap what it stamped;
   *  - its `kici-agent-id` is not one this backend is currently tracking
   *    (spawning, running, or destroying);
   *  - it is not running, or it is running with an agent id that is not
   *    registered — a running, registered agent is doing work.
   *
   * Returns the count of cleaned containers plus reaped rules.
   */
  async cleanupOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ['kici-managed=true', `kici-scaler-name=${this.name}`],
      },
    });

    let cleaned = 0;
    const liveIps = new Set(this.containerIps.values());
    for (const info of containers) {
      const agentId = info.Labels?.['kici-agent-id'];
      if (agentId && this.agents.has(agentId)) continue;
      const running = info.State === 'running';
      if (running && (!agentId || this.isRegistered(agentId))) continue;

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

    cleaned += await this.reapUnownedIsolationRules(liveIps);
    return cleaned;
  }

  /**
   * Remove containers this backend spawned for one agent id.
   *
   * Implements the optional `ScalerBackend.reapUnowned` hook. It is what
   * reclaims a container whose registration the orchestrator refused — the
   * case `cleanupOrphans` used to cover by removing every `kici-managed`
   * container on the host, which is exactly the breadth that killed other
   * orchestrators' live agents.
   *
   * @returns true when a container was found and removed
   */
  async reapUnowned(managedId: string): Promise<boolean> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [
            'kici-managed=true',
            `kici-scaler-name=${this.name}`,
            `kici-agent-id=${managedId}`,
          ],
        },
      });
    } catch (err) {
      logger.warn('reapUnowned: failed to list containers', {
        managedId,
        error: toErrorMessage(err),
      });
      return false;
    }

    let reaped = false;
    for (const info of containers) {
      const container = this.docker.getContainer(info.Id);
      try {
        await container.remove({ force: true });
        reaped = true;
      } catch (err) {
        logger.warn('reapUnowned: failed to remove container', {
          managedId,
          containerId: info.Id,
          error: toErrorMessage(err),
        });
      }
    }
    if (reaped) {
      logger.info('reapUnowned: removed unowned agent container', { managedId });
    }
    return reaped;
  }

  /**
   * Delete isolation rules for container IPs on this scaler's isolated network
   * that no tracked container holds.
   *
   * Rules are removed only on the teardown paths this process drives, so a
   * crash or a `kill -9` strands them. The network's address pool is recycled,
   * so the next container to take that IP inherits the dead job's allowlist.
   *
   * Scoped to addresses no live container holds: `kici-agent-net` is one fixed
   * network shared by every container-spawning backend on the host, so this
   * backend's own tracking map is not enough to tell an abandoned address from
   * a neighbour's live one.
   */
  private async reapUnownedIsolationRules(snapshotIps: Set<string>): Promise<number> {
    if (!this.networkIsolation) return 0;
    // A rule is reaped only when NOTHING on this host holds its address. The
    // runtime listing is what makes that true across backends: a second
    // container scaler, the bare-metal backend's container mode, and another
    // orchestrator on the same runtime all put their agents on the one
    // `kici-agent-net`, so reaping every address this backend does not track
    // would strip a neighbour's running agent of its RFC1918 and
    // cloud-metadata drops — the silent fail-open this sweep exists to repair.
    const heldOnHost = await this.isolatedNetworkAddressesInUse();
    if (heldOnHost === null) return 0;
    // Union the pre-removal snapshot with a fresh read: a spawn that landed
    // while the container pass was awaiting docker holds rules this sweep would
    // otherwise reap out from under it, and an IP the pass just released is
    // cheap to skip and reclaim on the next sweep. Both directions of the race
    // therefore resolve toward sparing.
    const liveIps = new Set([...snapshotIps, ...this.containerIps.values(), ...heldOnHost]);
    let deleted = 0;
    for (const [identifier, handles] of await listIsolationRules()) {
      if (!isolatedNetworkAddress(identifier) || liveIps.has(identifier)) continue;
      const n = await deleteForwardRules(handles);
      if (n > 0) {
        logger.info('reaped stale isolation rules', { identifier, count: n });
        deleted += n;
      }
    }
    return deleted;
  }

  /**
   * Every address held on the isolated agent network by a kici-managed
   * container, across every scaler and every orchestrator on this runtime.
   *
   * Deliberately NOT filtered by `kici-scaler-name`: the point is to see the
   * neighbours, and a neighbour is by definition stamped with a name this
   * backend does not know.
   *
   * @returns the addresses, or `null` when the runtime could not be listed — in
   * which case the caller reaps nothing rather than reaping blind.
   */
  private async isolatedNetworkAddressesInUse(): Promise<Set<string> | null> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['kici-managed=true'] },
      });
    } catch (err) {
      logger.warn('could not list containers; skipping the isolation-rule reap', {
        error: toErrorMessage(err),
      });
      return null;
    }
    const held = new Set<string>();
    for (const info of containers) {
      const ip = info.NetworkSettings?.Networks?.[ISOLATED_NETWORK_NAME]?.IPAddress;
      if (typeof ip === 'string' && ip.length > 0) held.add(ip);
    }
    return held;
  }
}

/**
 * Whether an nft rule identifier is an address on the isolated agent network.
 *
 * The chain is shared with every other backend on the host, so the sweep has to
 * be able to tell its own addresses from theirs. The isolated network's subnet
 * is a fixed constant, which makes the test exact rather than heuristic.
 */
function isolatedNetworkAddress(identifier: string): boolean {
  const prefix = ISOLATED_NETWORK_SUBNET.split('.').slice(0, 2).join('.');
  return identifier.startsWith(`${prefix}.`);
}
