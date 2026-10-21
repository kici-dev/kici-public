/**
 * Bare-metal scaler backend: ephemeral agent processes via child_process.spawn.
 * On Linux and macOS each agent leads its own process group, which teardown
 * signals; on Windows teardown ends the agent's process tree with taskkill.
 * An agent exits once it is idle past its idle window (a follow-up job that
 * arrives within the window reuses it), and the backend destroys it on disconnect.
 */

import type { ChildProcess } from 'node:child_process';
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  ALLOWED_SYSTEM_VARS,
  KICI_AGENT_ENV_PREFIX,
  buildTrustedPassthroughEnv,
  scalerAgentLabels,
  ScalerBackendType,
} from '@kici-dev/engine';
import { createLogger, stderrTail, toErrorMessage, type ToolRequirement } from '@kici-dev/shared';
import { labelSetsMatch, normalizeLabelSet } from './label-matcher.js';
import { ScalerEventType } from './types.js';
import Docker from 'dockerode';
import { detectRuntime } from './container-backend.js';
import {
  pullImageIfMissing,
  ensureRuntimeVolume,
  runtimeInjectBind,
  injectedAgentCommand,
  agentImageLabels,
  runtimeInitCommand,
} from '@kici-dev/shared/container-runtime';
import { KICI_RUNTIME_DOCKER_LABEL } from './container-routing.js';
import { spawnsInJobImage } from './agent-fit.js';
import {
  versionManagerExecutable,
  versionManagerRemedy,
  versionManagerShimMessage,
} from './agent-binary-location.js';
import {
  ensureIsolatedNetwork,
  ISOLATED_NETWORK_NAME,
  ISOLATED_NETWORK_GATEWAY,
} from './container-backend.js';
import { buildAgentContainerHostConfig } from './container-hostconfig.js';
import { resolveAgentHostAccess } from './host-access.js';
import {
  addIsolationRules,
  addHostIsolationRules,
  ensureKiciTable,
  probeNftables,
  removeIsolationRules,
} from '@kici-dev/shared/net';
import type { NetworkPolicy, NftOptions } from '@kici-dev/shared/net';
import type { ResolvedContainerSpawn } from './types.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type {
  ScalerBackend,
  ScalerDestroyContext,
  ScalerEntry,
  ManagedAgent,
  LabelSetConfig,
  LogCapture,
  ResourceRequest,
  ScalerEventCallback,
  ValidationResult,
  EffectiveLimits,
  SpawnContext,
} from './types.js';

import {
  agentLaunchRefusal,
  buildAgentLaunch,
  killWindowsTree,
  startAgentProcess,
} from './bare-metal-launch.js';

/**
 * The `scaler.failed` detail for an agent process that exited before it
 * registered, with the end of what it wrote (bounded like a failed command's
 * stderr tail).
 */
function exitedBeforeRegisteringDetail(
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): string {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  const detail = `agent process exited with ${how} before it registered`;
  const tail = stderrTail(output);
  return tail ? `${detail}\n--- captured output ---\n${tail}` : detail;
}

/**
 * Indexes of the label sets that run the job's own image as the agent: an
 * `image` and no `binaryPath`. Only these spawn agent containers, so only these
 * need nftables.
 */
function jobImageLabelSetIndexes(labelSets: LabelSetConfig[]): number[] {
  return labelSets.flatMap((ls, i) =>
    spawnsInJobImage(ScalerBackendType.enum['bare-metal'], ls) ? [i] : [],
  );
}

/** The sudoers line the refusal and the docs suggest. */
const NFT_SUDOERS_EXAMPLE = 'kici ALL=(root) NOPASSWD: /usr/sbin/nft';

/**
 * Why a bare-metal scaler with job-image label sets cannot run here, and the
 * two ways to fix it.
 */
function nftUnusableMessage(
  name: string,
  indexes: number[],
  requireSudo: boolean,
  failure: string,
): string {
  const sets = indexes.map((i) => `labelSets[${i}]`).join(', ');
  // A non-root service often has no /usr/sbin on its PATH, which reads as a
  // missing binary rather than a missing privilege. Through sudo, the binary
  // that could not start may be sudo itself.
  const notFound = !/ENOENT/.test(failure)
    ? ''
    : requireSudo
      ? `sudo or nft is not installed, or sudo is not on the orchestrator's PATH. `
      : `nft is not installed, or not on the orchestrator's PATH. `;
  const head =
    `Bare-metal scaler "${name}" runs agents in job images (${sets}: an image and no ` +
    `binaryPath). Each such agent container is isolated with nftables rules, and this ` +
    `orchestrator cannot run nft${requireSudo ? ' through "sudo -n"' : ''}: ${failure.trim()}. ` +
    notFound;
  return requireSudo
    ? head +
        `requireSudo is set, so give the orchestrator's user a NOPASSWD sudoers rule for nft, ` +
        `for example "${NFT_SUDOERS_EXAMPLE}".`
    : head +
        `Run the orchestrator as root or with the CAP_NET_ADMIN capability, or set ` +
        `"requireSudo: true" on the scaler and give the orchestrator's user a NOPASSWD sudoers ` +
        `rule for nft, for example "${NFT_SUDOERS_EXAMPLE}".`;
}

/**
 * Whether the runtime behind `docker` runs rootless. A rootless runtime keeps its
 * networks in a network namespace of its own, so the per-address rules this
 * backend writes into the host's nftables never see an agent container's
 * traffic. Docker and Podman both list `name=rootless` in `SecurityOptions`.
 */
async function runtimeIsRootless(docker: Docker): Promise<boolean> {
  const info = (await docker.info()) as { SecurityOptions?: string[] };
  return (info.SecurityOptions ?? []).some((option) => option.split(',').includes('name=rootless'));
}

/** Why a job-image agent cannot run on a rootless runtime. */
function rootlessRefusal(name: string, socketPath: string): string {
  return (
    `Bare-metal scaler "${name}" cannot run a job image as the agent through ${socketPath}: ` +
    `the container runtime is rootless, so its networks live in a network namespace of their ` +
    `own and the host's nftables isolation rules would never apply to the agent container. ` +
    `Point the orchestrator at a rootful Docker or Podman socket.`
  );
}

/**
 * Whether this host can run nft the way the scaler will: `null` when it can,
 * or why it cannot. nftables exists on Linux only, so elsewhere nothing is run.
 */
async function probeNftForScaler(requireSudo: boolean): Promise<string | null> {
  if (process.platform !== 'linux') {
    return `nftables is available on Linux only, and this host is ${process.platform}`;
  }
  return probeNftables({ requireSudo });
}

/**
 * How long `destroy()` waits for an agent to exit after asking it to stop, and
 * the most a Windows tree kill may take.
 */
const EXIT_WAIT_MS = 5_000;

// One logger for the module: with KICI_LOG_DIR set, each createLogger() call opens
// its own log file stream, so a logger per spawn would leak one per agent.
const logger = createLogger({ prefix: 'bare-metal-backend' });

interface BareMetalManagedAgent extends ManagedAgent {
  /** Absent for a container-backed agent, which has no local child process. */
  process?: ChildProcess;
  /** Set for a container-backed agent; `destroy` removes it instead of killing a PID. */
  containerId?: string;
  /** Set by `markRegistered` once the agent process registered with the orchestrator. */
  registered?: boolean;
}

export interface BareMetalScalerBackendOptions {
  /** Human-readable name for this scaler */
  name: string;
  /** Label sets this backend can provision */
  labelSets: LabelSetConfig[];
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Default resource limits applied when label set has none */
  defaultResources?: ResourceRequest;
  /**
   * Extra `hostAccess` entries the orchestrator itself directed agents at —
   * today its object-storage endpoint. Folded into the agent default for the
   * container mode, which is the only mode with a network boundary.
   */
  hostServices?: string[];
  /** Token store for ephemeral agent auth tokens; when undefined, no token is injected. */
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
   * When true, wrap each spawned agent process in a transient systemd scope
   * (`systemd-run --user --scope --slice=kici-scaler`) and translate the
   * job's effective CPU / memory limits into `CPUQuota=` / `MemoryMax=`
   * properties so the kernel cgroup actually enforces the limits. When
   * false (the default), limits are advisory only — they drive the scaler's
   * per-machine cap math but no cgroup is created.
   *
   * Linux-only. On macOS / Windows hosts the option is silently a no-op
   * (`systemd-run` does not exist), with a one-time startup warning.
   */
  enforceCgroups?: boolean;
  /**
   * Run the `nft` calls of job-image mode (the scaler-level `requireSudo`)
   * through `sudo -n`, for an orchestrator that runs as a non-root user with a
   * NOPASSWD sudoers rule for nft. Process mode runs no nft. Default false.
   */
  requireSudo?: boolean;
  /**
   * Extra `host:address` mappings (the scaler-level `extraHosts`) for the agent
   * containers of job-image mode, passed to the runtime as `ExtraHosts`.
   * Process mode ignores them.
   */
  extraHosts?: string[];
}

export class BareMetalScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum['bare-metal'];
  readonly spawnsOnLocalHost = true;
  readonly logsSource = 'bare-metal';
  maxAgents: number;

  private _labelSets: LabelSetConfig[];
  private readonly name: string;
  private readonly defaultResources?: ResourceRequest;
  private readonly tokenStore?: AgentTokenStore;
  private readonly tokenTtlMs: number;
  private readonly tokenTtlProvider?: () => Promise<number>;
  private readonly roles: string[] | undefined;
  private readonly enforceCgroups: boolean;
  /** Host services the orchestrator directed agents at, as `hostAccess` entries. */
  private readonly hostServices?: string[];

  /** Tracks all managed agent processes */
  private readonly agents = new Map<string, BareMetalManagedAgent>();
  /** LogCapture instances for each managed agent (keyed by ManagedAgent.id) */
  private readonly logCaptures = new Map<string, LogCapture>();
  /** Container-mode agents' IPs on the isolated network, for nftables cleanup. */
  private readonly containerIps = new Map<string, string>();
  /** Whether job-image mode's nft calls run through `sudo -n`. */
  private readonly requireSudo: boolean;
  private readonly extraHosts?: string[];
  /**
   * Why this host cannot run nft the way {@link requireSudo} asks, as `create`
   * probed it; `null` when it can. `reload` is synchronous and reads it to
   * refuse job-image label sets a reload adds.
   */
  private readonly nftFailure: string | null;

  /**
   * Build a backend and check, once, that this host can run nft the way the
   * scaler asks. A scaler with a job-image label set is refused here when it
   * cannot, so the orchestrator stops at startup (and a reload that adds the
   * scaler fails) instead of failing every spawn. A process-only scaler is
   * never refused: process mode runs no nft.
   */
  static async create(options: BareMetalScalerBackendOptions): Promise<BareMetalScalerBackend> {
    const requireSudo = options.requireSudo ?? false;
    const nftFailure = await probeNftForScaler(requireSudo);
    const imageSets = jobImageLabelSetIndexes(options.labelSets);
    if (imageSets.length > 0) {
      if (nftFailure !== null) {
        throw new Error(nftUnusableMessage(options.name, imageSets, requireSudo, nftFailure));
      }
      // The first write, at load rather than on the first job, and what every
      // per-container rule needs to exist.
      try {
        await ensureKiciTable({ requireSudo });
      } catch (err) {
        throw new Error(
          nftUnusableMessage(options.name, imageSets, requireSudo, toErrorMessage(err)),
          { cause: err },
        );
      }
      // A rootless runtime is refused here too when it is already reachable;
      // every spawn checks again, since the runtime may come up later.
      const runtime = await detectRuntime();
      if (runtime) {
        const rootless = await runtimeIsRootless(
          new Docker({ socketPath: runtime.socketPath }),
        ).catch(() => false);
        if (rootless) throw new Error(rootlessRefusal(options.name, runtime.socketPath));
      }
    }
    return new BareMetalScalerBackend(options, nftFailure);
  }

  /**
   * @param nftFailure - The `create` probe's answer. A backend built directly
   * was not probed, and is treated as able to run nft.
   */
  constructor(options: BareMetalScalerBackendOptions, nftFailure: string | null = null) {
    this.name = options.name;
    this.requireSudo = options.requireSudo ?? false;
    this.extraHosts = options.extraHosts;
    this.nftFailure = nftFailure;
    this._labelSets = options.labelSets;
    this.maxAgents = options.maxAgents;
    this.defaultResources = options.defaultResources;
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.tokenTtlProvider = options.tokenTtlProvider;
    this.roles = options.roles;
    this.enforceCgroups = options.enforceCgroups ?? false;
    this.hostServices = options.hostServices;

    logger.warn(
      `Bare-metal scaler "${options.name}" configured. Bare-metal agents run as child processes ` +
        `with full host filesystem and network access. This mode is intended for trusted environments only.`,
    );
    logger.warn(
      `Consider enabling bubblewrap (bwrap) for process isolation. See docs/operator/agent-security.md`,
    );

    if (this.enforceCgroups && process.platform !== 'linux') {
      logger.warn(
        `Bare-metal scaler "${options.name}" has enforceCgroups: true, but this host is ` +
          `${process.platform} -- systemd-run is unavailable. CPU/memory limits will be advisory ` +
          `(no kernel enforcement) on this platform.`,
      );
    } else if (this.enforceCgroups) {
      logger.info(
        `Bare-metal scaler "${options.name}" will wrap spawned agents in transient systemd scopes ` +
          `(slice=kici-scaler) and apply CPU/memory limits via systemd properties.`,
      );
    }

    this.warnNetworkPolicy(options.labelSets);
  }

  /**
   * Why a reload's job-image label sets cannot run here. `reload` is
   * synchronous and cannot probe nft, so it reads what `create` probed — which
   * holds only for the `requireSudo` the backend was built with.
   */
  private jobImageReloadErrors(labelSets: LabelSetConfig[], entry?: ScalerEntry): string[] {
    const imageSets = jobImageLabelSetIndexes(labelSets);
    if (imageSets.length === 0) return [];
    if (entry && (entry.requireSudo ?? false) !== this.requireSudo) {
      return [
        `Bare-metal scaler "${this.name}": requireSudo cannot change on reload while a label ` +
          `set runs job images; restart the orchestrator to apply`,
      ];
    }
    if (this.nftFailure !== null) {
      return [nftUnusableMessage(this.name, imageSets, this.requireSudo, this.nftFailure)];
    }
    return [];
  }

  /** How every nft call of job-image mode runs: through `sudo -n` or not. */
  private nftOpts(): NftOptions {
    return { requireSudo: this.requireSudo };
  }

  /**
   * Warn about label sets whose `networkPolicy` this backend cannot enforce.
   *
   * Only process-mode label sets qualify. A label set that declares an `image`
   * and no `binaryPath` spawns its agent as a container on the isolated agent
   * network, where the policy IS applied — warning about it tells an operator
   * their working configuration does nothing, which invites them to remove it.
   */
  private warnNetworkPolicy(labelSets: LabelSetConfig[]): void {
    const count = labelSets.filter(
      (ls) => ls.networkPolicy && !(ls.image !== undefined && !ls.binaryPath),
    ).length;
    if (count > 0) {
      logger.warn(
        `Bare-metal scaler "${this.name}" has ${count} process-mode label set(s) with ` +
          `networkPolicy configured. A bare-metal agent that runs as a host process has no ` +
          `network isolation boundary, so neither its egress policy nor its hostAccess policy ` +
          `is enforced for it — the process runs with the host's own reachability. Give the ` +
          `label set an "image" and no "binaryPath" to run its agent in a container on the ` +
          `isolated network, or use the container or Firecracker backend.`,
      );
    }
  }

  /**
   * Declare required tools for a bare-metal scaler entry.
   *
   * - Every label set's `binaryPath` must be an executable file on disk.
   * - If `KICI_SANDBOX=true` is forwarded to spawned agents (via the
   *   orchestrator's `KICI_AGENT_ENV_KICI_SANDBOX=true` or a label set's
   *   `env.KICI_SANDBOX=true`), `bwrap` must be on PATH.
   *
   *   Checked at orchestrator startup so misconfiguration fails fast instead of
   *   crashing every job at dispatch. On macOS and Windows (no bwrap) enabling
   *   KICI_SANDBOX is rejected here.
   */
  static getRequiredTools(entry: ScalerEntry): ToolRequirement[] {
    const requirements: ToolRequirement[] = entry.labelSets
      .filter((ls) => ls.binaryPath)
      .map((ls) => ({
        type: 'file-access' as const,
        path: ls.binaryPath!,
        mode: 'executable' as const,
        reason: `agent binary for bare-metal scaler "${entry.name}"`,
      }));

    // kici-agent is a `#!/usr/bin/env node` script and inherits the
    // orchestrator's PATH; without `node` there it dies at job time with
    // `env: 'node': No such file or directory`.
    requirements.push({
      type: 'path-binary',
      name: 'node',
      reason:
        `bare-metal scaler "${entry.name}" spawns the kici-agent node script. ` +
        `node must be on the orchestrator's PATH (it is forwarded to spawned agents). ` +
        `Ensure the orchestrator service's PATH includes your node install (e.g. the ` +
        `systemd unit's Environment=PATH covers the mise/nvm node bin dir).`,
    });

    const sandboxViaGlobalEnv = process.env.KICI_AGENT_ENV_KICI_SANDBOX === 'true';
    const sandboxViaLabelSet = entry.labelSets.some(
      (ls) => ls.env && ls.env.KICI_SANDBOX === 'true',
    );
    if (sandboxViaGlobalEnv || sandboxViaLabelSet) {
      requirements.push({
        type: 'path-binary',
        name: 'bwrap',
        reason:
          `bare-metal scaler "${entry.name}" has KICI_SANDBOX=true configured. ` +
          `bubblewrap is required for namespace isolation. Install via ` +
          `'apt install bubblewrap' (Debian/Ubuntu) or 'dnf install bubblewrap' (Fedora/RHEL). ` +
          `bwrap is Linux-only — set KICI_SANDBOX=false on macOS/Windows hosts.`,
      });
    }

    return requirements;
  }

  get labelSets(): LabelSetConfig[] {
    return this._labelSets;
  }

  /**
   * Identity of the agent binary a spawn of this label set would run:
   * `realpath:inode:size:mtime` of `binaryPath`. A version-manager or npm
   * upgrade replaces the file, so the fingerprint changes with the build.
   * `null` in job-image mode or when the file cannot be read.
   */
  async spawnSourceFingerprint(labelSet: string[]): Promise<string | null> {
    const ls = this._labelSets.find((l) => labelSetsMatch(l.labels, labelSet));
    if (!ls?.binaryPath || spawnsInJobImage(this.type, ls)) return null;
    try {
      const real = await fsRealpath(ls.binaryPath);
      const st = await fsStat(real);
      return `${real}:${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
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
    // Container path only (slow image pull); the local-process path needs no
    // guard beyond the ScalerManager deadline race.
    signal?: AbortSignal,
  ): Promise<ManagedAgent> {
    const emit = (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => {
      onEvent?.({ agentId, eventType, detail, timestampMs: Date.now() });
    };

    const normalizedTarget = normalizeLabelSet(labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );
    if (!matchedLabelSet) {
      throw new Error(
        `Label set [${labelSet.join(', ')}] not supported by bare-metal backend "${this.name}"`,
      );
    }

    if (this.getActiveCount() >= this.maxAgents) {
      throw new Error(
        `Bare-metal backend "${this.name}" at capacity (${this.maxAgents}/${this.maxAgents})`,
      );
    }

    emit(ScalerEventType.enum['scaler.provisioning'], 'spawning agent process');

    // Trusted fleet-agent profile: an agent-launch property ONLY, never
    // derivable from a dispatch payload.
    const trustedEnv =
      matchedLabelSet.env?.KICI_TRUSTED_ENV === 'true' ||
      process.env.KICI_AGENT_ENV_KICI_TRUSTED_ENV === 'true';

    // No blanket ...process.env spread.
    const env: Record<string, string> = {};

    // 1. System vars. Default profile copies only the explicit allowlist; the
    //    trusted profile forwards the ambient host env minus the scrub-list:
    //    the operator's ambient credentials (sops/ssh/aws) pass, the
    //    orchestrator's own KiCI identity/operational secrets do not. The
    //    explicit KICI_* identity assignments below then re-set the agent's own.
    if (trustedEnv) {
      Object.assign(env, buildTrustedPassthroughEnv(process.env));
    } else {
      for (const key of ALLOWED_SYSTEM_VARS) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
    }

    // 2. KICI_AGENT_ENV_ forwarded vars (prefix stripped)
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(KICI_AGENT_ENV_PREFIX) && value !== undefined) {
        const strippedKey = key.slice(KICI_AGENT_ENV_PREFIX.length);
        if (strippedKey.length > 0) env[strippedKey] = value;
      }
    }

    // The ephemeral token is bound to exactly this set so register-time labels
    // pass the scope gate; the agent adds only the self-reported os/arch/host
    // facts the gate exempts.
    const fullLabels = scalerAgentLabels(
      labelSet,
      this.type,
      this.name,
      this.roles,
      spawnContext?.platformTaints,
    );

    // 2.5. Create ephemeral agent token if token store is available
    if (this.tokenStore) {
      const tokenTtlMs = this.tokenTtlProvider ? await this.tokenTtlProvider() : this.tokenTtlMs;
      env.KICI_AGENT_TOKEN = await this.tokenStore.createEphemeral(agentId, fullLabels, tokenTtlMs);
    }

    // 3. Required agent KICI_* vars (explicit values, not from process.env)
    env.KICI_ORCHESTRATOR_URL = orchestratorUrl;
    env.KICI_AGENT_ID = agentId;
    env.KICI_LABELS = fullLabels.join(',');
    env.KICI_SCALER_MANAGED = '1';
    env.KICI_EXECUTION_MODE = 'bare-metal';
    env.KICI_PORT = '0';

    // Source of the KiCI runtime when the agent NESTS a job container: a host
    // process has no /opt/kici, so without it a `container:` job needs an image
    // that ships Node itself — still the contract for a label set with no image.
    if (matchedLabelSet.image) env.KICI_RUNTIME_IMAGE = matchedLabelSet.image;

    // 3.5. Backpressure mode (before label-set env so explicit env: can override)
    if (matchedLabelSet.backpressureMode) {
      env.KICI_BACKPRESSURE_MODE = matchedLabelSet.backpressureMode;
    }

    // 4. Label-set env from scalers.yaml (highest priority, overrides KICI_AGENT_ENV_)
    Object.assign(env, matchedLabelSet.env ?? {});

    // Logged so the trusted-env decision (ambient host env passed to steps) is
    // auditable at spawn time; mirrors the KICI_SANDBOX validation surface.
    if (trustedEnv) {
      logger.info(
        `Spawning TRUSTED-ENV agent "${agentId}" for scaler "${this.name}" ` +
          `(label set [${labelSet.join(', ')}]). Ambient host env is passed through to ` +
          `workflow steps (minus the agent's own KiCI identity secrets). ` +
          `KICI_SANDBOX=${env.KICI_SANDBOX ?? 'false'}.`,
      );
    }

    // Dual mode: a job that declared its own container image runs IN that
    // image with the KiCI runtime injected; only the launch differs from the
    // local-process path.
    //
    // OPT-IN, not automatic: a `container:` job also runs as a local agent that
    // nests a job container, and switching every such job would silently flip
    // the topology of working jobs. The opt-in is the label set's shape: an
    // `image` and NO `binaryPath`. The scaler reads the same function, so the two
    // cannot disagree.
    const jobImageMode = spawnsInJobImage(this.type, matchedLabelSet);
    if (spawnContext?.container && jobImageMode) {
      return await this.spawnContainerAgent({
        agentId,
        labelSet,
        container: spawnContext.container,
        agentImage: matchedLabelSet.image,
        env,
        emit,
        ...(effectiveLimits ? { effectiveLimits } : {}),
        ...(matchedLabelSet.networkPolicy ? { networkPolicy: matchedLabelSet.networkPolicy } : {}),
        hostAccess: resolveAgentHostAccess({
          policy: matchedLabelSet.networkPolicy,
          orchestratorUrl,
          gateway: ISOLATED_NETWORK_GATEWAY,
          ...(this.hostServices ? { hostServices: this.hostServices } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
    }

    // Linux with enforceCgroups wraps the agent in a systemd scope, Windows runs
    // a batch-file launcher through cmd.exe, and anything else runs directly. A
    // launch the host refuses outright is reported here; the DeterministicSpawnError
    // tells the manager to defer this scaler rather than retry at once.
    let child: ChildProcess;
    try {
      const launch = buildAgentLaunch({
        binaryPath: matchedLabelSet.binaryPath!,
        agentId,
        effectiveLimits,
        enforceCgroups: this.enforceCgroups,
        platform: process.platform,
        hostEnv: process.env,
      });
      child = startAgentProcess(launch, env, process.platform);
    } catch (err) {
      emit(ScalerEventType.enum['scaler.failed'], toErrorMessage(err));
      throw err;
    }

    child.unref();

    const merged = new PassThrough();
    child.stdout?.pipe(merged, { end: false });
    child.stderr?.pipe(merged, { end: false });

    // 'close' follows 'exit' and the last output, so a fatal startup error
    // still reaches the capture.
    child.on('close', () => {
      merged.end();
    });

    // Recent output lines, so a spawn that dies before WS registration carries
    // its stderr in the scaler.failed detail.
    const TAIL_MAX_LINES = 50;
    const tailBuf: string[] = [];
    const pushTail = (line: string) => {
      tailBuf.push(line);
      if (tailBuf.length > TAIL_MAX_LINES) tailBuf.shift();
    };

    const rl = createInterface({ input: merged, crlfDelay: Infinity });
    rl.on('line', pushTail);
    const capture: LogCapture = {
      async *lines() {
        for await (const line of rl) {
          yield line;
        }
      },
      tail() {
        return tailBuf.join('\n');
      },
      close() {
        rl.close();
        merged.destroy();
      },
    };

    const managed: BareMetalManagedAgent = {
      id: agentId,
      labelSet,
      backendRef: String(child.pid),
      spawnedAt: Date.now(),
      state: 'running',
      process: child,
    };

    this.agents.set(managed.id, managed);
    this.logCaptures.set(managed.id, capture);

    emit(ScalerEventType.enum['scaler.ready'], `agent process started (PID ${child.pid})`);
    emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration');

    // On spawn error (e.g. ENOENT) 'exit' may not fire, so untrack here too.
    child.on('error', (err) => {
      const t = capture.tail();
      const detail = t
        ? `agent process error: ${err.message}\n--- captured output (last ${TAIL_MAX_LINES} lines) ---\n${t}`
        : `agent process error: ${err.message}`;
      emit(ScalerEventType.enum['scaler.failed'], detail);
      this.logCaptures.delete(managed.id);
      this.agents.delete(managed.id);
    });

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      this.logCaptures.delete(managed.id);
      this.agents.delete(managed.id);
    });
    // The capture closes after the last output line. A process that exited
    // before it registered will never register; report it with that output.
    // The manager treats the report as a refused launch and defers the scaler.
    rl.on('close', () => {
      if (!exit || managed.state === 'destroying' || managed.registered) return;
      emit(
        ScalerEventType.enum['scaler.failed'],
        exitedBeforeRegisteringDetail(exit.code, exit.signal, capture.tail()),
      );
    });

    return managed;
  }

  /**
   * Record that the agent registered. From then on its exit is a disconnect
   * the manager handles, not a failed spawn.
   */
  markRegistered(managedId: string): void {
    const managed = this.agents.get(managedId);
    if (managed) managed.registered = true;
  }

  /**
   * Launch the agent inside the job's own container image.
   *
   * With the KiCI runtime injected the image needs neither Node nor git, so an
   * arbitrary customer image can host the agent. Split out of `spawn()`: the two
   * launches share nothing past the env.
   */
  private async spawnContainerAgent(args: {
    agentId: string;
    labelSet: string[];
    container: ResolvedContainerSpawn;
    agentImage: string | undefined;
    env: Record<string, string>;
    emit: (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => void;
    /** Resolved cpu / memory ceiling. */
    effectiveLimits?: EffectiveLimits;
    /** Egress policy for the label set this agent serves. */
    networkPolicy?: NetworkPolicy;
    /** What this agent may reach on the host, already resolved by the caller. */
    hostAccess: string[];
    signal?: AbortSignal;
  }): Promise<ManagedAgent> {
    const {
      agentId,
      labelSet,
      container,
      agentImage,
      env,
      emit,
      effectiveLimits,
      networkPolicy,
      signal,
    } = args;

    const runtime = await detectRuntime();
    if (!runtime) {
      // Routing should keep this job off a runtime-less pool, so reaching here
      // means the label requirement was bypassed: say which half is wrong.
      throw new Error(
        `Job requires a container runtime, but scaler "${this.name}" found none on this host. ` +
          `Install docker or podman, or route container jobs to a pool that advertises ` +
          `${KICI_RUNTIME_DOCKER_LABEL}.`,
      );
    }
    if (!agentImage) {
      throw new Error(
        `Scaler "${this.name}" cannot run a container job: its label set declares no agent ` +
          `image, which is where the injected KiCI runtime comes from.`,
      );
    }

    // Tell the agent it IS the job's image, so it runs the steps here instead
    // of nesting a second container from the same image.
    env.KICI_JOB_IMAGE_AGENT = '1';

    const docker = new Docker({ socketPath: runtime.socketPath });
    // Fail closed before anything starts: on a rootless runtime the isolation
    // rules below would be written and match nothing.
    if (await runtimeIsRootless(docker)) {
      throw new Error(rootlessRefusal(this.name, runtime.socketPath));
    }

    await pullImageIfMissing({
      docker,
      image: container.image,
      ...(container.authconfig ? { authconfig: container.authconfig } : {}),
      ...(signal ? { signal } : {}),
      onProgress: (message) => emit(ScalerEventType.enum['scaler.provisioning'], message),
    });

    const runtimeVolume = await ensureRuntimeVolume({
      docker,
      agentImage,
      ...(signal ? { signal } : {}),
      onProgress: (message) => emit(ScalerEventType.enum['scaler.provisioning'], message),
    });
    const agentInit = runtimeInitCommand(await agentImageLabels(docker, agentImage));

    await ensureIsolatedNetwork(docker);
    // The table and its chains must exist before the first per-container rule:
    // nothing else on a bare-metal host is guaranteed to have created them, and a
    // reload can add a job-image label set after `create` ran. Idempotent.
    await ensureKiciTable(this.nftOpts());

    emit(ScalerEventType.enum['scaler.provisioning'], 'creating container');
    const created = await docker.createContainer({
      Image: container.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      // The agent runs on the INJECTED node, never the image's own — the image
      // is not required to ship one — and under the runtime's tini when the
      // agent image ships it.
      Cmd: injectedAgentCommand(agentInit),
      Labels: {
        'kici-managed': 'true',
        'kici-scaler-name': this.name,
        'kici-agent-id': agentId,
        'kici-labels': normalizeLabelSet(labelSet),
      },
      // Shared with the container backend, so the operator's limits apply here
      // too; without them a job can take the host down.
      HostConfig: buildAgentContainerHostConfig({
        ...(effectiveLimits ? { limits: effectiveLimits } : {}),
        binds: [runtimeInjectBind(runtimeVolume)],
        ...(this.extraHosts ? { extraHosts: this.extraHosts } : {}),
      }),
      // Without it the container sits on the runtime's default bridge with full
      // LAN, RFC1918 and cloud-metadata reach.
      NetworkingConfig: { EndpointsConfig: { [ISOLATED_NETWORK_NAME]: {} } },
    });

    // Record BEFORE starting: a throw from `start()` must not leave an untracked
    // container, and `cleanupOrphans` does not cover bare-metal at all.
    const managed: BareMetalManagedAgent = {
      id: agentId,
      labelSet,
      backendRef: created.id,
      containerId: created.id,
      spawnedAt: Date.now(),
      state: 'spawning',
    };
    this.agents.set(managed.id, managed);

    try {
      await created.start();

      const info = await docker.getContainer(created.id).inspect();
      const containerIp = info.NetworkSettings?.Networks?.[ISOLATED_NETWORK_NAME]?.IPAddress as
        string | undefined;
      if (containerIp) {
        this.containerIps.set(managed.id, containerIp);
        // Pre-clean: the network recycles addresses, so without this the new
        // container inherits whatever the previous holder was allowed.
        await removeIsolationRules(containerIp, this.nftOpts());
        await addIsolationRules(
          containerIp,
          ISOLATED_NETWORK_GATEWAY,
          networkPolicy,
          'saddr',
          this.nftOpts(),
        );
        // Host-destined packets arrive on the input hook, which the forward
        // rules above never see.
        await addHostIsolationRules(containerIp, args.hostAccess, 'saddr', this.nftOpts());
      } else {
        // Fail closed: without an address there are no rules, and the chains'
        // policy is accept. The catch below removes the container.
        throw new Error(
          `Agent container ${created.id.slice(0, 12)} has no address on ${ISOLATED_NETWORK_NAME}, ` +
            `so its network isolation rules cannot be applied`,
        );
      }
    } catch (err) {
      this.agents.delete(managed.id);
      const failedIp = this.containerIps.get(managed.id);
      if (failedIp) {
        this.containerIps.delete(managed.id);
        try {
          await removeIsolationRules(failedIp, this.nftOpts());
        } catch {
          // Best effort — a stale rule is inert once the container is gone.
        }
      }
      try {
        await created.remove({ force: true });
      } catch {
        // Best effort — the container may not exist.
      }
      throw err;
    }

    managed.state = 'running';
    emit(
      ScalerEventType.enum['scaler.ready'],
      `agent container started (${created.id.slice(0, 12)}) on ${container.image}`,
    );
    emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration');
    return managed;
  }

  getScalerContext(agentId: string): Record<string, unknown> | undefined {
    const managed = this.agents.get(agentId);
    if (!managed) return undefined;

    const normalizedTarget = normalizeLabelSet(managed.labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );

    return {
      backendType: 'bare-metal',
      scalerName: this.name,
      binaryPath: matchedLabelSet?.binaryPath,
      resources: matchedLabelSet?.resources ?? this.defaultResources,
    };
  }

  async destroy(managedId: string, _context?: ScalerDestroyContext): Promise<void> {
    // _context (teardown reason) is only meaningful to the event backend.
    const managed = this.agents.get(managedId);
    if (!managed) return;

    managed.state = 'destroying';

    // Close log capture before killing the process
    const capture = this.logCaptures.get(managedId);
    if (capture) {
      capture.close();
      this.logCaptures.delete(managedId);
    }

    // A container-backed agent has no PID to signal — remove the container.
    if (managed.containerId) {
      try {
        const runtime = await detectRuntime();
        if (runtime) {
          await new Docker({ socketPath: runtime.socketPath })
            .getContainer(managed.containerId)
            .remove({ force: true });
        }
      } catch {
        // Already gone, or the runtime disappeared — either way there is
        // nothing left to reap, and the tracking entry must still be dropped.
      }
      const containerIp = this.containerIps.get(managedId);
      if (containerIp) {
        this.containerIps.delete(managedId);
        try {
          await removeIsolationRules(containerIp, this.nftOpts());
        } catch {
          // Best effort — a stale rule is inert once the container is gone,
          // and the orphan sweep reclaims it.
        }
      }
      this.agents.delete(managedId);
      return;
    }

    const pid = parseInt(managed.backendRef, 10);

    // NaN when spawn failed before a PID was assigned (e.g. ENOENT).
    if (isNaN(pid)) {
      this.agents.delete(managedId);
      return;
    }

    if (process.platform === 'win32') {
      await this.endWindowsTree(managed, pid);
      this.agents.delete(managedId);
      return;
    }

    // Negative PID signals the whole process group.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err: unknown) {
      // ESRCH: already dead.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        this.agents.delete(managedId);
        return;
      }
      throw err;
    }

    const exited = await this.waitForExit(managed, EXIT_WAIT_MS);
    if (!exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process may have exited between check and kill
      }
    }

    this.agents.delete(managedId);
  }

  /**
   * Force-reclaim a container-mode agent this backend no longer tracks.
   *
   * After an orchestrator restart `destroy()` (an in-memory lookup) is a silent
   * no-op while the container keeps running, and the container backend's sweep
   * reaps only its OWN `kici-scaler-name` and runs only with a container scaler
   * configured.
   *
   * The evidence is the container itself, stamped with `kici-agent-id` and
   * `kici-scaler-name`; a container listing names only this host's containers,
   * so a coordinator cannot reach a peer's compute — a wrongly-routed id matches
   * nothing.
   *
   * A process-mode agent is NOT reclaimed: its PID lives only in memory, so a
   * restart leaves no durable host-local artifact, and scanning the process
   * table would risk signalling a recycled PID.
   *
   * @returns `true` when a container for `managedId` was found and removed.
   */
  async reapUnowned(managedId: string): Promise<boolean> {
    if (this.agents.has(managedId)) {
      // Still tracked, so `destroy()` owns this id and unwinds it in full.
      return false;
    }

    const runtime = await detectRuntime();
    if (!runtime) return false;
    const docker = new Docker({ socketPath: runtime.socketPath });

    const found = await docker.listContainers({
      all: true,
      filters: { label: [`kici-agent-id=${managedId}`, `kici-scaler-name=${this.name}`] },
    });
    if (found.length === 0) return false;

    logger.warn('bare-metal: reclaiming an unowned agent container', {
      managedId,
      containers: found.length,
    });

    let reaped = false;
    for (const info of found) {
      try {
        await docker.getContainer(info.Id).remove({ force: true });
        reaped = true;
      } catch {
        // Already gone, or the runtime disappeared — either way there is
        // nothing left to reap.
      }
    }
    return reaped;
  }

  /** Used by ScalerManager for log forwarding. */
  getLogCapture(managedId: string): LogCapture | undefined {
    return this.logCaptures.get(managedId);
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  reload(
    labelSets: LabelSetConfig[],
    opts?: { maxAgents?: number; entry?: ScalerEntry },
  ): ValidationResult {
    // A label set names a local binary, an agent image (job-image mode), or
    // both. Mirrors the config schema's load rule, so a SIGHUP never fails on a
    // file that started the process fine.
    const errors: string[] = [];
    labelSets.forEach((ls, i) => {
      if (!ls.binaryPath && !ls.image) {
        errors.push(
          `Label set [${i}] requires a 'binaryPath' or an 'image' field for bare-metal backend`,
        );
      }
      if (ls.binaryPath) {
        const refusal = agentLaunchRefusal(ls.binaryPath, process.platform);
        if (refusal) errors.push(`Label set [${i}]: ${refusal}`);
        // Startup refuses a version-manager shim, so a reload refuses it too.
        const shim = versionManagerExecutable(ls.binaryPath);
        if (shim) {
          errors.push(
            `Label set [${i}]: ${versionManagerShimMessage(ls.binaryPath, shim)} ` +
              versionManagerRemedy(shim),
          );
        }
      }
    });
    errors.push(...this.jobImageReloadErrors(labelSets, opts?.entry));

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    this._labelSets = labelSets;
    if (opts?.maxAgents !== undefined) {
      this.maxAgents = opts.maxAgents;
    }
    this.warnNetworkPolicy(labelSets);
    return { valid: true };
  }

  /**
   * End a Windows agent's whole process tree.
   *
   * Windows has no process groups to signal and no SIGTERM, and Node.js cannot
   * send a ctrl-C there (`process.kill` terminates the target unconditionally),
   * so the tree is ended at once with `taskkill /T /F`. The pid is cmd.exe's,
   * which runs the agent's `node` and everything it started.
   *
   * Nothing runs once Node.js has seen the child exit: libuv then releases its
   * handle on the process, Windows may give the pid to an unrelated process,
   * and `/T` would end that process's tree. While the child runs, the open
   * handle keeps the pid ours.
   */
  private async endWindowsTree(managed: BareMetalManagedAgent, pid: number): Promise<void> {
    const child = managed.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await killWindowsTree(pid, process.env, EXIT_WAIT_MS);
    await this.waitForExit(managed, EXIT_WAIT_MS);
  }

  /** True if the process exited within `timeoutMs`, false on timeout. */
  private waitForExit(managed: BareMetalManagedAgent, timeoutMs: number): Promise<boolean> {
    const child = managed.process;
    // A container-backed agent has no child process; `destroy` removes the
    // container and returns before ever reaching here.
    if (!child) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };

      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolve(true);
        return;
      }

      child.once('exit', onExit);
    });
  }
}
