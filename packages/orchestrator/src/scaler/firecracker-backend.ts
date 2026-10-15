/**
 * Ephemeral agent microVMs under the Firecracker jailer. Lifecycle: prepare chroot, hardlink
 * rootfs+kernel, create overlay drive, invoke jailer, inject MMDS metadata, destroy with cleanup.
 * Mirrors the Docker backend's structure.
 *
 * Log capture is internal: the jailer runs as a non-daemonized detached child with stdout
 * redirected to a serial console log file and VMM logs captured via --log-path. Both files are
 * tailed and forwarded with logsSource tags 'firecracker-serial' and 'firecracker-vmm'. The
 * serial path is best-effort defense-in-depth: Firecracker's Rust BufWriter around stdout plus
 * the jailer's uid drop make sparse userspace writes unreliable. The canonical agent log path
 * is WS agent.log (attached unconditionally by the agent; see packages/agent/src/server.ts step 6).
 */

import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { link, copyFile, mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  KICI_AGENT_ENV_PREFIX,
  scalerAgentLabels,
  ScalerBackendType,
  ScalerVmStopOutcome,
  ScalerVmTracker,
  type ScalerVmStopResult,
} from '@kici-dev/engine';
import {
  createLogger,
  toCommandError,
  toErrorMessage,
  type ToolRequirement,
} from '@kici-dev/shared';
import { normalizeLabelSet } from './label-matcher.js';
import {
  ensureKiciTable,
  addIsolationRules,
  addHostIsolationRules,
  removeIsolationRules,
  listIsolationRules,
  deleteForwardRules,
} from '@kici-dev/shared/net';
import { FirecrackerApi } from './firecracker-api.js';
import { resolveAgentHostAccess } from './host-access.js';
import { renderGuestExtraHosts } from './firecracker-extra-hosts.js';
import { tailFile } from './file-tail.js';
import { forwardLine } from './log-forwarder.js';
import { ScalerEventType } from './types.js';
import { generateTapName } from './ip-allocator.js';
import { OverlayTemplates } from './overlay-template.js';
import type { LiveVmBackend, LiveVmProbe } from './live-vms.js';
import type { IpAllocator, IpAllocationResult, IpAllocationRecord } from './ip-allocator.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import {
  provisionBridge as defaultProvisionBridge,
  verifyBridge as defaultVerifyBridge,
  type FirecrackerBridgeConfig,
  type BridgeHealth,
  type ExecOptions,
} from '../firecracker/host-network.js';

/** Hardlink src to dest; fall back to copy if on different filesystems (EXDEV). */
async function linkOrCopy(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(src, dest);
    } else {
      throw err;
    }
  }
}
import type {
  ScalerBackend,
  ScalerDestroyContext,
  ScalerEntry,
  ManagedAgent,
  LabelSetConfig,
  ScalerEventCallback,
  ValidationResult,
  EffectiveLimits,
  SpawnContext,
} from './types.js';
import { runDetached } from '../helpers/run-detached.js';

const execFileAsync = promisify(execFile);

/** Timeout for each host command a spawn or teardown step runs. */
const EXEC_TIMEOUT_MS = 30_000;

/** Overlay drive size when a label set sets none. */
const DEFAULT_OVERLAY_MIB = 2048;

const logger = createLogger({ prefix: 'firecracker-backend' });

/**
 * Unit of `/proc/<pid>/stat` field 22 (starttime). Linux fixes USER_HZ at 100 on every
 * architecture this runs on, and Node cannot read it, so the conversion only compares
 * timestamps orders of magnitude apart — see {@link PID_START_SLACK_MS}.
 */
const USER_HZ = 100;

/**
 * Slack between a process's start time and the mtime of the PID file naming it. The jailer
 * writes the file after forking, so the slack only absorbs clock granularity and a slow write;
 * a process that started well after the file cannot be the one it names.
 */
const PID_START_SLACK_MS = 60_000;

/**
 * A signal that aborts when the jailer exits with a non-zero code, carrying
 * the code as its reason. A clean exit is normal: under `--new-pid-ns` the
 * jailer parent exits 0 once firecracker runs.
 */
function watchJailerBootFailure(child: ChildProcess): AbortSignal {
  const controller = new AbortController();
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) controller.abort(code);
  });
  return controller.signal;
}

/**
 * Field 22 (`starttime`, in USER_HZ ticks since boot) of a `/proc/<pid>/stat`
 * line. `comm` is parenthesised and may itself contain spaces and parens, so
 * the remaining fields start after the LAST ')'.
 */
function procStartTicks(procStat: string): number | undefined {
  const commClose = procStat.lastIndexOf(')');
  if (commClose < 0) return undefined;
  const ticks = Number(
    procStat
      .slice(commClose + 1)
      .trim()
      .split(/\s+/)[19],
  );
  return Number.isFinite(ticks) ? ticks : undefined;
}

/**
 * How long a spawn waits for the VM's API socket when nothing configures it.
 * Generous on purpose: under heavy disk write-back the jailer's copy of the
 * firecracker binary into the chroot alone can take several seconds.
 */
export const DEFAULT_API_SOCKET_WAIT_MS = 30_000;

/** Interval between liveness probes of a spawned VM whose agent has not registered. */
const UNREGISTERED_VM_PROBE_MS = 2_000;

/**
 * Consecutive probes that must find the VM's process gone before it is torn
 * down, so one racy read of the PID file cannot destroy a live VM.
 */
const UNREGISTERED_VM_GONE_PROBES = 2;

/** Log file names within the jailer chroot directory */
const SERIAL_LOG_FILE = 'serial-console.log';
const VMM_LOG_FILE = 'vmm.log';

/**
 * Byte budget for forwarded env vars in one VM's MMDS payload. Firecracker's default MMDS
 * store cap is ~51 KiB across all of a VM's metadata; the static fields (URL, agent ID, labels,
 * token, gateway, backpressure) total under 1 KiB. Vars past the budget are skipped with a
 * warning instead of failing the MMDS PUT mid-spawn.
 */
const MMDS_FORWARDED_ENV_BUDGET_BYTES = 32 * 1024;

/** POSIX shell-safe env var name pattern. Reject anything else to avoid MMDS path injection. */
const POSIX_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Per-VM TAP name, as {@link generateTapName} produces it: `kici-` plus the LAST 8 chars of
 * the VM id (8 lowercase hex for a scaler-minted id). The orphan sweep considers only this
 * shape, so `kici-br0` and other operator interfaces are never candidates. The configured
 * bridge is also skipped by name, in case it has this shape: deleting it kills every VM.
 */
const VM_TAP_PATTERN = /^kici-[0-9a-f]{8}$/;

/** Convert a dotted IPv4 netmask ('255.255.255.0') to a CIDR prefix length (24). */
function netmaskToPrefix(netmask: string): number {
  return (
    netmask
      .split('.')
      .map((o) => Number(o).toString(2).padStart(8, '0'))
      .join('')
      .split('1').length - 1
  );
}

/** Extended ManagedAgent that includes the allocated IP for cleanup */
export interface FirecrackerManagedAgent extends ManagedAgent {
  /** Allocated IP address for TAP/IP release during destroy */
  ip: string;
  /** TAP device name for cleanup */
  tapDevice: string;
  /**
   * The `hostAccess` policy resolved at provision time. Carried because a bridge self-heal
   * re-applies isolation for every live VM and has no `orchestratorUrl` to re-derive it.
   */
  hostAccess?: string[];
  /**
   * Set once the VM's agent registered. Until then a VM that stops on its own is a failed
   * spawn nothing else tears down; afterwards the agent's disconnect does.
   */
  registered?: boolean;
}

export interface FirecrackerScalerBackendOptions {
  /** Human-readable name for this scaler */
  name: string;
  /** Label sets this backend can provision */
  labelSets: LabelSetConfig[];
  maxAgents: number;
  /** Shared IP allocator instance */
  ipAllocator: IpAllocator;
  /**
   * Extra `hostAccess` entries the orchestrator itself directed agents at (its object-storage
   * endpoint), folded into the agent default so the narrowing keeps a host-local object store.
   */
  hostServices?: string[];
  firecrackerPath: string;
  jailerPath: string;
  /** Default kernel image path */
  kernelPath: string;
  /** Jailer chroot base directory @default '/srv/jailer' */
  chrootBaseDir?: string;
  /** Jailer uid */
  uid: number;
  /** Jailer gid */
  gid: number;
  /** Default vCPU count @default 2 */
  vcpuCount?: number;
  /** Default memory in MiB @default 512 */
  memSizeMib?: number;
  /** Bridge interface name for TAP attachment */
  bridgeName: string;
  /** Network CIDR (e.g. '10.0.0.0/24'); supplies the prefix for the bridge gateway CIDR. */
  cidr?: string;
  /** Gateway IP for guest networking */
  gateway: string;
  /**
   * Extra `host:address` mappings the rootfs `/init` appends to each guest's
   * `/etc/hosts`; `host-gateway` resolves to {@link gateway}. None by default.
   */
  extraHosts?: string[];
  /** Netmask for guest networking */
  netmask: string;
  /** nft table name for host-network diagnostics. @default 'kici' */
  table?: string;
  /** Token store for ephemeral agent auth tokens; when undefined, no token is injected. */
  tokenStore?: AgentTokenStore;
  /** TTL for ephemeral agent tokens in ms. Default: 1 hour. */
  tokenTtlMs?: number;
  /**
   * Live per-spawn resolver for the ephemeral agent-token TTL (ms), so the leader serves the
   * fleet-wide `cluster_settings.agent_token_ttl_ms` override; falls back to `tokenTtlMs`.
   */
  tokenTtlProvider?: () => Promise<number>;
  /**
   * How long (ms) a spawn waits for the VM's API socket after the jailer starts.
   * Default {@link DEFAULT_API_SOCKET_WAIT_MS}.
   */
  apiSocketWaitMs?: number;
  /**
   * Live per-spawn resolver for the API-socket wait, so the fleet-wide
   * `cluster_settings.firecracker_api_socket_wait_ms` applies without a restart. Falls back
   * to `apiSocketWaitMs`.
   */
  apiSocketWaitMsProvider?: () => Promise<number>;
  /** Agent roles for this scaler. undefined = all, [] = execution only. */
  roles?: string[];
  /**
   * Wrap privileged commands (`ip`, `chown`) with `sudo -n`. Required when the orchestrator
   * runs as a non-root user (e.g. user-mode systemd on edge worker nodes) with a sudoers
   * NOPASSWD rule for those binaries; leave false when it runs as root.
   * @default false
   */
  requireSudo?: boolean;
  /**
   * When true, `ensureHostReady()` verifies and provisions this host bridge on startup
   * (self-heal); when false it is a no-op. Threaded from `firecracker.autoProvisionHost`.
   * @default false (cores pass the real value)
   */
  autoProvisionHost?: boolean;
  /** Injectable bridge verifier (tests). @default host-network verifyBridge */
  verifyBridgeFn?: (cfg: FirecrackerBridgeConfig, opts: ExecOptions) => Promise<BridgeHealth>;
  /** Injectable bridge provisioner (tests). @default host-network provisionBridge */
  provisionBridgeFn?: (cfg: FirecrackerBridgeConfig, opts: ExecOptions) => Promise<void>;
}

/**
 * What a VM's PID file, cross-checked against `/proc`, says about the process it names.
 *
 * A bare `parseInt` of the file is not an identity: the file outlives its process and Linux
 * recycles PIDs. Acting on the raw number lets `destroy` and `reapUnowned` `SIGKILL` an
 * unrelated host process (the orchestrator runs as root or under `sudo -n`), and lets a
 * liveness check call a long-dead VM live forever, so no sweep reclaims its chroot or IP.
 *
 * Two callers ask opposite questions, so the states stay distinct. `gone` and `recycled` both
 * mean the VM that wrote the file is over. `running` means a process with that number exists
 * now; `identityConfirmed` says whether it is provably this VM's firecracker, which decides
 * whether it may be signalled, not whether it exists. `startedAtMs` comes from `/proc/<pid>/stat`.
 */
type VmPidProbe =
  | { state: 'gone' }
  | { state: 'recycled'; pid: number }
  | { state: 'running'; pid: number; startedAtMs: number; identityConfirmed: true }
  | {
      state: 'running';
      pid: number;
      startedAtMs: number;
      identityConfirmed: false;
      detail: string;
    };

export class FirecrackerScalerBackend implements ScalerBackend, LiveVmBackend {
  readonly type = ScalerBackendType.enum.firecracker;
  readonly spawnsOnLocalHost = true;
  maxAgents: number;

  // The ScalerBackend-level identifier; the forwarding loops tag each stream
  // (firecracker-serial, firecracker-vmm) themselves.
  readonly logsSource = 'firecracker-serial';

  /** AbortControllers for file tailing per managed VM (keyed by agent ID) */
  private readonly tailAbortControllers = new Map<string, AbortController>();

  /**
   * Per-spawn `scaler.failed` emitters, keyed by agent id. The jailer's `exit` handler and the
   * spawn-deadline abort fire outside `spawn`'s scope, and the manager releases a spawn
   * reservation only on a failure event; without this the reservation stays held until restart.
   */
  private readonly spawnFailureHandlers = new Map<string, (reason: string) => void>();
  /** Liveness probes of spawned VMs whose agent has not registered yet, by agent id. */
  private readonly registrationWatches = new Map<string, NodeJS.Timeout>();

  private _labelSets: LabelSetConfig[];
  private readonly name: string;
  private readonly ipAllocator: IpAllocator;
  private readonly firecrackerPath: string;
  private readonly jailerPath: string;
  private readonly kernelPath: string;
  private readonly chrootBaseDir: string;
  /** Pre-formatted overlay drive templates under {@link chrootBaseDir}. */
  private readonly overlayTemplates: OverlayTemplates;
  private readonly uid: number;
  private readonly gid: number;
  private readonly vcpuCount: number;
  private readonly memSizeMib: number;
  private readonly bridgeName: string;
  private readonly cidr: string | undefined;
  private readonly gateway: string;
  /** The MMDS `kici-extra-hosts` value, or undefined when the scaler maps no host. */
  private readonly guestExtraHosts: string | undefined;
  /** Host services the orchestrator directed agents at, as `hostAccess` entries. */
  private readonly hostServices?: string[];
  private readonly netmask: string;
  private readonly table: string;
  private readonly tokenStore?: AgentTokenStore;
  private readonly tokenTtlMs: number;
  private readonly tokenTtlProvider?: () => Promise<number>;
  private readonly apiSocketWaitMs: number;
  private readonly apiSocketWaitMsProvider?: () => Promise<number>;
  private readonly roles: string[] | undefined;
  private readonly requireSudo: boolean;
  private readonly autoProvisionHost: boolean;
  private readonly verifyBridgeFn: (
    cfg: FirecrackerBridgeConfig,
    opts: ExecOptions,
  ) => Promise<BridgeHealth>;
  private readonly provisionBridgeFn: (
    cfg: FirecrackerBridgeConfig,
    opts: ExecOptions,
  ) => Promise<void>;

  /** Tracks all managed VM agents by ManagedAgent.id */
  private readonly agents = new Map<string, FirecrackerManagedAgent>();

  /** Periodic orphan sweep timer (null when stopped). */
  private orphanSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Guard against re-entrant sweeps if a single run takes longer than the interval. */
  private orphanSweepInFlight = false;

  /** Tail of the host reclaim chain; see {@link withHostReclaimLock}. */
  private hostReclaimChain: Promise<unknown> = Promise.resolve();

  constructor(options: FirecrackerScalerBackendOptions) {
    this.name = options.name;
    this._labelSets = options.labelSets;
    this.maxAgents = options.maxAgents;
    this.ipAllocator = options.ipAllocator;
    this.firecrackerPath = options.firecrackerPath;
    this.jailerPath = options.jailerPath;
    this.kernelPath = options.kernelPath;
    this.chrootBaseDir = options.chrootBaseDir ?? '/srv/jailer';
    this.overlayTemplates = new OverlayTemplates(this.chrootBaseDir, (cmd, args, timeoutMs) =>
      this.execAsync(cmd, args, timeoutMs),
    );
    this.uid = options.uid;
    this.gid = options.gid;
    this.vcpuCount = options.vcpuCount ?? 2;
    this.memSizeMib = options.memSizeMib ?? 512;
    this.bridgeName = options.bridgeName;
    this.cidr = options.cidr;
    this.gateway = options.gateway;
    this.guestExtraHosts = renderGuestExtraHosts(options.extraHosts, options.gateway);
    this.hostServices = options.hostServices;
    this.netmask = options.netmask;
    this.table = options.table ?? 'kici';
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.tokenTtlProvider = options.tokenTtlProvider;
    this.apiSocketWaitMs = options.apiSocketWaitMs ?? DEFAULT_API_SOCKET_WAIT_MS;
    this.apiSocketWaitMsProvider = options.apiSocketWaitMsProvider;
    this.roles = options.roles;
    this.requireSudo = options.requireSudo ?? false;
    this.autoProvisionHost = options.autoProvisionHost ?? false;
    this.verifyBridgeFn = options.verifyBridgeFn ?? defaultVerifyBridge;
    this.provisionBridgeFn = options.provisionBridgeFn ?? defaultProvisionBridge;
  }

  /**
   * Declare required tools for a firecracker scaler entry.
   */
  static getRequiredTools(entry: ScalerEntry): ToolRequirement[] {
    const reqs: ToolRequirement[] = [];
    const name = entry.name;

    if (entry.firecrackerPath) {
      reqs.push({
        type: 'file-access',
        path: entry.firecrackerPath,
        mode: 'executable',
        reason: `firecracker binary for scaler "${name}"`,
      });
    }
    if (entry.jailerPath) {
      reqs.push({
        type: 'file-access',
        path: entry.jailerPath,
        mode: 'executable',
        reason: `jailer binary for scaler "${name}"`,
      });
    }
    if (entry.kernelPath) {
      reqs.push({
        type: 'file-access',
        path: entry.kernelPath,
        mode: 'readable',
        reason: `kernel image for scaler "${name}"`,
      });
    }
    for (const ls of entry.labelSets) {
      if (ls.rootfsPath) {
        reqs.push({
          type: 'file-access',
          path: ls.rootfsPath,
          mode: 'readable',
          reason: `rootfs image for scaler "${name}" label set [${ls.labels.join(',')}]`,
        });
      }
    }
    reqs.push({
      type: 'path-binary',
      name: 'ip',
      reason: `required by firecracker scaler "${name}" for TAP device management`,
    });
    reqs.push({
      type: 'path-binary',
      name: 'mkfs.ext4',
      reason: `required by firecracker scaler "${name}" for overlay drive templates`,
    });
    reqs.push({
      type: 'path-binary',
      name: 'cp',
      reason: `required by firecracker scaler "${name}" for sparse overlay drive copies`,
    });

    return reqs;
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
    signal?: AbortSignal,
  ): Promise<ManagedAgent> {
    const emit = (eventType: Parameters<ScalerEventCallback>[0]['eventType'], detail: string) => {
      onEvent?.({ agentId, eventType, detail, timestampMs: Date.now() });
    };

    // 1. Find matching label set config
    const normalizedTarget = normalizeLabelSet(labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );
    if (!matchedLabelSet) {
      throw new Error(
        `Label set [${labelSet.join(', ')}] not supported by Firecracker backend "${this.name}"`,
      );
    }

    // 2. Check capacity
    if (this.getActiveCount() >= this.maxAgents) {
      throw new Error(
        `Firecracker backend "${this.name}" at capacity (${this.maxAgents}/${this.maxAgents})`,
      );
    }

    // 3. Create tracking entry
    const managed: FirecrackerManagedAgent = {
      id: agentId,
      labelSet,
      backendRef: '',
      spawnedAt: Date.now(),
      state: 'spawning',
      ip: '',
      tapDevice: '',
      hostAccess: resolveAgentHostAccess({
        policy: matchedLabelSet.networkPolicy,
        orchestratorUrl,
        gateway: this.gateway,
        ...(this.hostServices ? { hostServices: this.hostServices } : {}),
      }),
    };
    this.agents.set(managed.id, managed);
    this.spawnFailureHandlers.set(agentId, (reason) => {
      emit(ScalerEventType.enum['scaler.failed'], reason);
    });

    let alloc: IpAllocationResult | undefined;

    // The ScalerManager's spawn deadline aborts this signal and forgets the agent. Without a
    // listener the tracking entry above survives forever: `maxAgents` such timeouts wedge the
    // scaler at capacity with zero live VMs, and every sweep skips its IP, TAP and chroot
    // because `trackedVmIds` still names it.
    const onSpawnAbort = () => {
      this.abandonSpawnDetached(agentId, alloc, 'spawn aborted (deadline or shutdown)');
    };
    signal?.addEventListener('abort', onSpawnAbort, { once: true });

    try {
      emit(ScalerEventType.enum['scaler.provisioning'], 'preparing rootfs and kernel');

      // 4. Allocate IP
      alloc = await this.ipAllocator.allocate(agentId, this.name);
      managed.ip = alloc.ip;
      managed.tapDevice = alloc.tapDevice;

      // 5. Create TAP device and attach to bridge
      emit(ScalerEventType.enum['scaler.network'], `configuring TAP device ${alloc.tapDevice}`);
      await this.execAsync('ip', ['tuntap', 'add', alloc.tapDevice, 'mode', 'tap']);
      // `isolated on` is the entire VM-to-VM boundary. Every VM's TAP hangs off one bridge on
      // one subnet, so traffic between two tenants' VMs is switched at L2 and never enters the
      // IP forward hook: no nft rule, including the RFC1918 drop, sees it. An isolated port
      // still forwards to the bridge itself (VM → gateway → NAT → internet), never to another
      // isolated port.
      await this.execAsync('ip', ['link', 'set', alloc.tapDevice, 'master', this.bridgeName]);
      // Two commands, not one: the combined
      // `ip link set <tap> master <br> type bridge_slave isolated on` is rejected with
      // `RTNETLINK answers: Operation not supported` on kernels that accept the flag once the
      // port is already a bridge member. The split form works everywhere the combined one does.
      await this.execAsync('ip', [
        'link',
        'set',
        alloc.tapDevice,
        'type',
        'bridge_slave',
        'isolated',
        'on',
      ]);
      await this.execAsync('ip', ['link', 'set', alloc.tapDevice, 'up']);
      emit(ScalerEventType.enum['scaler.network'], `allocating IP ${alloc.ip}`);

      // 5b. Apply per-VM nftables isolation rules, keyed on the VM's source
      //     IP. The TAP is enslaved to the bridge, so forwarded traffic enters
      //     the forward hook with iifname = the BRIDGE: an iifname rule naming
      //     the TAP never matches, leaving isolation and any networkPolicy
      //     allowlist ineffective. On a non-root orchestrator nft runs via sudo -n.
      const nftOpts = this.nftOpts();
      await ensureKiciTable({ ...nftOpts, requireBaselineChain: true });
      // Pre-clean: rules are removed only on the teardown paths this process
      // drives, so a crash, `kill -9` or a VM that died while the orchestrator
      // was down leaves this IP's rules behind, and the allocator recycles IPs
      // — the new tenant would inherit the dead job's allowlist. Idempotent.
      await removeIsolationRules(alloc.ip, nftOpts);
      await addIsolationRules(
        alloc.ip,
        this.gateway,
        matchedLabelSet.networkPolicy,
        'saddr',
        nftOpts,
      );
      // Host-destined packets arrive on the input hook, which the forward
      // rules above never see.
      await addHostIsolationRules(alloc.ip, managed.hostAccess ?? [], 'saddr', nftOpts);

      // 6. Prepare jailer chroot directory
      const chrootDir = this.getChrootDir(agentId);
      await mkdir(chrootDir, { recursive: true });

      // 7. Hardlink rootfs (read-only, shared via CoW overlay in guest).
      // Falls back to copy when source and chroot are on different filesystems.
      await linkOrCopy(matchedLabelSet.rootfsPath!, join(chrootDir, 'rootfs.ext4'));

      // 8. Hardlink kernel (read-only, shared across VMs)
      const kernelSrc = matchedLabelSet.kernelPath ?? this.kernelPath;
      await linkOrCopy(kernelSrc, join(chrootDir, 'kernel'));

      // 8b. Create per-VM overlay drive (sparse ext4 for writable layer)
      const overlayPath = join(chrootDir, 'overlay.ext4');
      const overlayMib = matchedLabelSet.overlayDriveSizeMib ?? DEFAULT_OVERLAY_MIB;
      await this.createOverlayDrive(overlayPath, overlayMib);

      // 9-10. Build and write Firecracker config JSON.
      // ScalerManager's resolved `effectiveLimits` (when present) overrides
      // the label-set / scaler-level vcpuCount and memSizeMib.
      const config = this.buildVmConfig(alloc, matchedLabelSet, effectiveLimits);
      await writeFile(join(chrootDir, 'config.json'), JSON.stringify(config, null, 2));

      // 11a. Pre-create log files in chroot (before spawn, avoids ENOENT in fs.watchFile)
      const serialLogPath = join(chrootDir, SERIAL_LOG_FILE);
      const vmmLogPath = join(chrootDir, VMM_LOG_FILE);
      writeFileSync(serialLogPath, '');
      writeFileSync(vmmLogPath, '');

      // 11b. Open file descriptors for stdout/stderr redirection BEFORE chowning
      // the chroot to the jailer uid/gid. The kernel does not re-check perms on
      // writes to an open FD, so the jailer child keeps writing after its
      // privilege drop. On a non-root orchestrator (e.g. user-mode systemd on
      // edge worker nodes), opening *after* chown fails with EACCES.
      const stdoutFd = openSync(serialLogPath, 'w');
      const stderrFd = openSync(serialLogPath, 'a'); // stderr also goes to serial log file

      // 11c. chown the entire VM directory to the jailer UID/GID.
      // The jailer drops to uid:gid before exec'ing Firecracker, which otherwise
      // fails with "Permission denied" opening --log-path and other chroot files.
      const vmDir = join(this.chrootBaseDir, 'firecracker', agentId);
      await this.execAsync('chown', ['-R', `${this.uid}:${this.gid}`, vmDir]);

      // 11c-bis. Restore source-owner on the hardlinked rootfs.ext4 + kernel.
      // chown -R operates on inodes, so the chown above also rewrote the owner
      // of the source files at matchedLabelSet.rootfsPath / kernelPath. On a
      // non-root orchestrator (Pi worker running as `kici`) the next spawn then
      // fails to ln them: fs.protected_hardlinks=1 forbids hardlinking a file you
      // neither own nor can write. Re-chowning the chroot entries to our own uid
      // restores the shared inode. Root needs no restore and hardlinks freely.
      const orchUid = process.getuid?.();
      const orchGid = process.getgid?.();
      if (orchUid !== undefined && orchUid !== 0) {
        await this.execAsync('chown', [
          `${orchUid}:${orchGid}`,
          join(chrootDir, 'rootfs.ext4'),
          join(chrootDir, 'kernel'),
        ]);
      }

      emit(ScalerEventType.enum['scaler.provisioning'], 'booting microVM');

      // 11c. Spawn jailer as detached child (no --daemonize, so firecracker
      // inherits stdout/stderr, which go to the log files). With --new-pid-ns
      // this child, the jailer parent, exits once firecracker runs in the new
      // PID namespace; the VM's own PID is in its PID file.
      const child = nodeSpawn(
        this.jailerPath,
        [
          '--id',
          agentId,
          '--exec-file',
          this.firecrackerPath,
          '--uid',
          String(this.uid),
          '--gid',
          String(this.gid),
          '--chroot-base-dir',
          this.chrootBaseDir,
          // NO --daemonize -- firecracker keeps the log-file stdout/stderr
          '--new-pid-ns',
          '--',
          '--config-file',
          '/config.json',
          '--log-path',
          '/vmm.log', // Relative to chroot root
          '--level',
          'Warning',
        ],
        {
          detached: true,
          stdio: ['ignore', stdoutFd, stderrFd],
        },
      );

      child.unref();

      // 11d. Close FDs in parent (child has its own copy)
      closeSync(stdoutFd);
      closeSync(stderrFd);

      // 11e. Set up log tailing (serial console + VMM logs, forwarded internally)
      this.startLogTailing(agentId, serialLogPath, vmmLogPath, child, alloc);

      // 12. Wait for the API socket; a jailer that exits non-zero ends the wait
      // at once. A rootless host loosens chroot permissions in parallel
      // (`loosenChrootPermissions`).
      const bootFailed = watchJailerBootFailure(child);
      const api = new FirecrackerApi(
        this.getSocketPath(agentId),
        signal ? AbortSignal.any([signal, bootFailed]) : bootFailed,
      );
      const stopLoosening = this.requireSudo ? this.loosenChrootPermissions(agentId) : undefined;
      try {
        await this.waitForApiSocket(api, agentId, bootFailed);
      } finally {
        stopLoosening?.();
      }

      // Full label set the agent will present (base + scaler-assigned kici:
      // labels). Bind the ephemeral token to exactly this set so register-time
      // labels pass the scope gate; the agent adds only self-reported
      // os/arch/host facts on top, which the gate exempts.
      const fullLabels = scalerAgentLabels(
        labelSet,
        this.type,
        this.name,
        this.roles,
        spawnContext?.platformTaints,
      );

      // 13. Create ephemeral agent token if token store is available
      let agentToken: string | undefined;
      if (this.tokenStore) {
        const tokenTtlMs = this.tokenTtlProvider ? await this.tokenTtlProvider() : this.tokenTtlMs;
        agentToken = await this.tokenStore.createEphemeral(agentId, fullLabels, tokenTtlMs);
      }

      // 13b. Build forwarded env map for the agent (see `buildForwardedEnv`).
      const acceptedEnv = this.buildForwardedEnv(matchedLabelSet, agentId);

      // 14. PUT MMDS metadata. Labels and agent ID are needed before the WS
      // connection: loadConfig() reads KICI_LABELS and KICI_AGENT_ID from env.
      await api.putMmds({
        latest: {
          'meta-data': {
            'kici-orchestrator-url': orchestratorUrl,
            'kici-agent-id': agentId,
            'kici-labels': fullLabels.join(','),
            'kici-scaler-managed': '1', // Agent skips WS log streaming
            ...(agentToken ? { 'kici-agent-token': agentToken } : {}),
            ...(this.guestExtraHosts ? { 'kici-extra-hosts': this.guestExtraHosts } : {}),
            ...(matchedLabelSet.backpressureMode
              ? { 'kici-backpressure-mode': matchedLabelSet.backpressureMode }
              : {}),
            ...(Object.keys(acceptedEnv).length > 0 ? { 'kici-env': acceptedEnv } : {}),
          },
        },
      });

      emit(ScalerEventType.enum['scaler.ready'], 'microVM booted');

      // 14. Update tracking
      this.markSpawned(managed, alloc);

      emit(ScalerEventType.enum['agent.connecting'], 'waiting for agent WS registration from VM');

      return managed;
    } catch (err) {
      // Emit failure event with error details (may include boot panic text)
      emit(ScalerEventType.enum['scaler.failed'], err instanceof Error ? err.message : String(err));
      // 15. Cleanup on failure
      await this.cleanupFailedSpawn(agentId, alloc);
      throw err;
    } finally {
      signal?.removeEventListener('abort', onSpawnAbort);
    }
  }

  /**
   * Tear down a spawn that will never produce a usable VM, from a path that is
   * not `spawn`'s own `catch` — a deadline abort, or the jailer exiting during
   * boot.
   *
   * Idempotent: whichever of the two fires first wins and the other is a no-op,
   * because `cleanupFailedSpawn` removes the tracking entry.
   */
  private async abandonSpawn(
    agentId: string,
    alloc: IpAllocationResult | undefined,
    reason: string,
  ): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed || managed.state === 'destroying') return;
    logger.warn(`Abandoning Firecracker spawn ${agentId}: ${reason}`);
    this.spawnFailureHandlers.get(agentId)?.(reason);
    try {
      await this.cleanupFailedSpawn(agentId, alloc);
    } catch (err) {
      logger.warn(`Cleanup after abandoned spawn ${agentId} failed: ${toErrorMessage(err)}`);
    }
  }

  /**
   * {@link abandonSpawn} from a path that cannot await it (an abort listener, a
   * process exit handler). A failure is logged.
   */
  private abandonSpawnDetached(
    agentId: string,
    alloc: IpAllocationResult | undefined,
    reason: string,
  ): void {
    runDetached(
      logger,
      'Abandoned spawn teardown',
      () => this.abandonSpawn(agentId, alloc, reason),
      {
        agentId,
      },
    );
  }

  getScalerContext(agentId: string): Record<string, unknown> | undefined {
    const managed = this.agents.get(agentId);
    if (!managed) return undefined;

    const normalizedTarget = normalizeLabelSet(managed.labelSet);
    const matchedLabelSet = this._labelSets.find(
      (ls) => normalizeLabelSet(ls.labels) === normalizedTarget,
    );

    return {
      backendType: 'firecracker',
      scalerName: this.name,
      rootfsPath: matchedLabelSet?.rootfsPath,
      kernelPath: matchedLabelSet?.kernelPath ?? this.kernelPath,
      vcpuCount: matchedLabelSet?.vcpuCount ?? this.vcpuCount,
      memSizeMib: matchedLabelSet?.memSizeMib ?? this.memSizeMib,
      ip: managed.ip,
      bridgeName: this.bridgeName,
      gateway: this.gateway,
      netmask: this.netmask,
    };
  }

  /**
   * Bridge config for host-network diagnostics (read-only snapshot).
   * `bridgeCidr` is the gateway IP with the network prefix (e.g. '10.0.0.1/24'),
   * which is exactly what `provisionBridge`/`verifyBridge` consume. The prefix
   * comes from the configured network `cidr`; if absent, it is derived from the
   * dotted `netmask`.
   */
  getBridgeConfig(): { bridgeName: string; bridgeCidr: string; table: string } {
    const prefix = this.cidr ? this.cidr.split('/')[1] : netmaskToPrefix(this.netmask);
    return {
      bridgeName: this.bridgeName,
      bridgeCidr: `${this.gateway}/${prefix}`,
      table: this.table,
    };
  }

  /**
   * nft options for this backend's own rules. `table` is the operator-configured one, not the
   * literal `kici`: with two coordinators on one host, B's per-VM rules in A's `kici` table
   * would be swept by A's next re-provision and evaluated against A's subnet-scoped baseline.
   */
  private nftOpts(): { requireSudo: boolean; table: string } {
    return { requireSudo: this.requireSudo, table: this.table };
  }

  /**
   * Verify and (if needed) provision this backend's host bridge on startup.
   * No-op unless autoProvisionHost is set. Throws on a real provision failure;
   * ScalerManager.ensureHostsReady catches per-backend and degrades this scaler.
   */
  async ensureHostReady(): Promise<void> {
    this.prewarmOverlayTemplates();
    if (!this.autoProvisionHost) return;
    const cfg = this.getBridgeConfig();
    const opts: ExecOptions = { requireSudo: this.requireSudo };
    const health = await this.verifyBridgeFn(cfg, opts);
    if (health.healthy) {
      logger.info(
        `bridge ${cfg.bridgeName} already healthy (${cfg.bridgeCidr}); skipping self-provision`,
      );
      return;
    }
    logger.info(`self-provisioning bridge ${cfg.bridgeName} (${cfg.bridgeCidr}): ${health.detail}`);
    await this.provisionBridgeFn(cfg, opts);
    await this.assertBridgePortIsolationSupported();
    await this.reapplyIsolationForTrackedVms();
  }

  /**
   * Fail loudly on a kernel that will not honour bridge port isolation. Without the flag every
   * tenant VM reaches every other one at L2, unseen by nft, so the documented isolation silently
   * does not exist. Fail-closed like `validateNftablesAvailability` for a missing `nft`.
   *
   * The probe is end-to-end (create a TAP, enslave it isolated, delete it) because the kernel,
   * iproute2 or the bridge can each reject the flag, and only the real command exercises all three.
   */
  private async assertBridgePortIsolationSupported(): Promise<void> {
    const probeTap = 'kici-isoprobe';
    try {
      await this.execAsync('ip', ['link', 'del', probeTap]);
    } catch {
      // Expected: no leftover probe from an earlier run.
    }
    try {
      await this.execAsync('ip', ['tuntap', 'add', probeTap, 'mode', 'tap']);
    } catch (err) {
      // No TAP at all is a distinct failure the spawn path reports; it is not
      // missing isolation support.
      logger.warn(`skipping bridge port-isolation probe: ${toErrorMessage(err)}`);
      return;
    }
    try {
      // Same two-step form the spawn path uses — see the note there.
      await this.execAsync('ip', ['link', 'set', probeTap, 'master', this.bridgeName]);
      await this.execAsync('ip', [
        'link',
        'set',
        probeTap,
        'type',
        'bridge_slave',
        'isolated',
        'on',
      ]);
    } catch (err) {
      throw new Error(
        `bridge port isolation is not available on ${this.bridgeName}: ${toErrorMessage(err)}. ` +
          'Without it every tenant VM on this host can reach every other one at L2, and no ' +
          'nftables rule sees that traffic. Upgrade the host kernel and iproute2, or run this ' +
          'scaler on a host that supports `ip link set <tap> master <bridge> type bridge_slave ' +
          'isolated on`.',
      );
    } finally {
      try {
        await this.execAsync('ip', ['link', 'del', probeTap]);
      } catch {
        // Best effort — the leak sweep does not match this name, so a stray
        // probe TAP is inert.
      }
    }
  }

  /**
   * Re-apply per-VM isolation rules for every tracked VM. Provisioning sweeps the `forward`
   * chain of everything no live VM owns (an old-shaped host carries its baseline there too), so
   * this keeps a self-heal from leaving a running VM fail-open. Each identifier is removed
   * before it is re-added, so a self-heal that fires twice does not duplicate the rules.
   */
  private async reapplyIsolationForTrackedVms(): Promise<void> {
    const tracked = [...this.agents.values()].filter((a) => a.ip.length > 0);
    if (tracked.length === 0) return;
    logger.warn(
      `re-applying isolation rules for ${tracked.length} live VM(s) after provisioning ` +
        `${this.bridgeName}; they were briefly without per-VM rules`,
    );
    const nftOpts = this.nftOpts();
    for (const managed of tracked) {
      const matched = this._labelSets.find(
        (ls) => normalizeLabelSet(ls.labels) === normalizeLabelSet(managed.labelSet),
      );
      try {
        await removeIsolationRules(managed.ip, nftOpts);
        await addIsolationRules(managed.ip, this.gateway, matched?.networkPolicy, 'saddr', nftOpts);
        await addHostIsolationRules(managed.ip, managed.hostAccess ?? [], 'saddr', nftOpts);
      } catch (err) {
        logger.error(
          `failed to re-apply isolation rules for ${managed.id} (${managed.ip}): ` +
            toErrorMessage(err),
        );
      }
    }
  }

  markRegistered(managedId: string): void {
    const managed = this.agents.get(managedId);
    if (managed) managed.registered = true;
    this.stopRegistrationWatch(managedId);
  }

  /**
   * Wait for the VM's API socket for the live setting (else the configured
   * default), and throw when it does not appear in that time.
   */
  private async waitForApiSocket(
    api: FirecrackerApi,
    agentId: string,
    bootFailed: AbortSignal,
  ): Promise<void> {
    const waitMs = this.apiSocketWaitMsProvider
      ? await this.apiSocketWaitMsProvider()
      : this.apiSocketWaitMs;
    if (await api.waitForSocket(waitMs)) return;
    if (bootFailed.aborted) {
      throw new Error(
        `Jailer exited during boot (code ${String(bootFailed.reason)}) for agent ${agentId}`,
      );
    }
    throw new Error(`Firecracker API socket not ready within ${waitMs} ms for agent ${agentId}`);
  }

  /**
   * Keep loosening a rootless VM's chroot permissions while firecracker starts.
   *
   * The jailer chmods the chroot root and every directory it creates (`/run`) to 0700 owned by
   * its `--uid`, locking an orchestrator running as another user out of
   * `/run/firecracker.socket`. A `chmod -R go+rX` every 100 ms reopens each one as it appears
   * (host-side view only). One chmod runs at a time: on a slow disk a `sudo chmod -R` can
   * outlast the tick, and overlapping ones would pile up for the whole wait.
   *
   * @returns a function that stops the loosening
   */
  private loosenChrootPermissions(agentId: string): () => void {
    const chrootHostPath = join(this.chrootBaseDir, 'firecracker', agentId, 'root');
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      runDetached(
        logger,
        'Chroot permission loosening',
        async () => {
          try {
            await this.execAsync('chmod', ['-R', 'go+rX', chrootHostPath]);
          } catch {
            // Best effort: the directory may not exist yet, or the jailer may
            // still be changing it.
          } finally {
            running = false;
          }
        },
        { agentId },
      );
    }, 100);
    return () => clearInterval(timer);
  }

  /** Record a spawn that resolved, and watch its VM until its agent registers. */
  private markSpawned(managed: FirecrackerManagedAgent, alloc: IpAllocationResult): void {
    managed.state = 'running';
    managed.backendRef = managed.id;
    this.watchUntilRegistered(managed.id, alloc);
  }

  /**
   * Tear the VM down if its process stops before its agent registers.
   *
   * A guest whose init exits (fatal agent startup error, kernel panic) reboots and firecracker
   * exits; nothing else releases its `maxAgents` slot, TAP, nft rules, IP and chroot until the
   * manager's stale-spawn prune. The jailer child's exit cannot tell: under `--new-pid-ns` it
   * exits 0 right after the start. So the VM's PID file is probed until the agent registers (its
   * disconnect then owns the teardown), the VM is being destroyed, or it is no longer tracked.
   */
  private watchUntilRegistered(agentId: string, alloc: IpAllocationResult): void {
    // Firecracker started before this point, so a later-started holder of its
    // PID is another process. Seconds since boot: a wall-clock step cannot fake it.
    const watchStartUptimeS = uptime();
    let goneProbes = 0;
    let probing = false;
    const timer = setInterval(() => {
      const managed = this.agents.get(agentId);
      if (!managed || managed.state === 'destroying' || managed.registered) {
        this.stopRegistrationWatch(agentId);
        return;
      }
      if (probing) return;
      probing = true;
      runDetached(
        logger,
        'Unregistered VM liveness probe',
        async () => {
          try {
            const gone = await this.isVmProcessGone(agentId, watchStartUptimeS);
            // The agent may have registered, or destroy() begun, while the
            // probe was reading.
            if (this.registrationWatches.get(agentId) !== timer) return;
            goneProbes = gone ? goneProbes + 1 : 0;
            if (goneProbes < UNREGISTERED_VM_GONE_PROBES) return;
            this.stopRegistrationWatch(agentId);
            this.abandonSpawnDetached(agentId, alloc, 'VM exited before its agent registered');
          } finally {
            probing = false;
          }
        },
        { agentId },
      );
    }, UNREGISTERED_VM_PROBE_MS);
    timer.unref();
    this.registrationWatches.set(agentId, timer);
  }

  /**
   * Whether there is positive evidence a VM's firecracker is gone: no PID file, no such PID, or
   * the PID belongs to a process started after `sinceUptimeS` (seconds since boot, taken once
   * firecracker was running). Any other failure (unreadable PID file, invisible `/proc`) is
   * "not gone": the caller tears down on "gone", and tearing down a live VM leaves firecracker
   * running without its TAP, IP and chroot.
   */
  private async isVmProcessGone(vmId: string, sinceUptimeS: number): Promise<boolean> {
    const pidFile = join(this.getChrootDir(vmId), 'firecracker.pid');
    let pid: number;
    try {
      pid = parseInt(String(await readFile(pidFile, 'utf-8')).trim(), 10);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!(pid > 0)) return false;
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM: the process exists but runs as the jailer uid.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    let procStat: string;
    try {
      procStat = String(await readFile(`/proc/${pid}/stat`, 'utf-8'));
    } catch {
      return false;
    }
    const startTicks = procStartTicks(procStat);
    // One second of slack: field 22 counts in USER_HZ ticks.
    return startTicks !== undefined && startTicks / USER_HZ > sinceUptimeS + 1;
  }

  /** Stop forwarding a VM's serial console and VMM logs. */
  private stopLogTailing(agentId: string): void {
    this.tailAbortControllers.get(agentId)?.abort();
    this.tailAbortControllers.delete(agentId);
  }

  private stopRegistrationWatch(agentId: string): void {
    const timer = this.registrationWatches.get(agentId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.registrationWatches.delete(agentId);
  }

  async destroy(managedId: string, _context?: ScalerDestroyContext): Promise<void> {
    // _context (teardown reason) is only meaningful to the event backend.
    const managed = this.agents.get(managedId);
    if (!managed) return;

    managed.state = 'destroying';
    this.stopRegistrationWatch(managedId);

    // 0. Stop log tailing
    this.stopLogTailing(managedId);

    // 1. Attempt graceful shutdown via SendCtrlAltDel (x86_64 only)
    try {
      const socketPath = this.getSocketPath(managedId);
      const api = new FirecrackerApi(socketPath);
      await api.sendCtrlAltDel();

      // Wait up to 5s for jailer process to exit
      await this.waitForProcessExit(managedId, 5000);
    } catch {
      // SendCtrlAltDel may fail on arm64 or dead VMs -- that's expected
    }

    // 2. Force kill, but only a PID that is provably still this VM's own
    //    firecracker process — see `readVmPid`.
    const forceKillPid = await this.readVmPid(managedId);
    const stillRunning =
      forceKillPid !== undefined && !(await this.signalVmProcessOrLog(managedId, forceKillPid));

    // 3. Clean up per-VM nftables rules (saddr-keyed, before TAP deletion)
    if (managed.ip) {
      try {
        await removeIsolationRules(managed.ip, this.nftOpts());
      } catch {
        // Best effort -- cleanup should not block destruction
      }
    }

    // 4. Delete TAP device (best effort)
    if (managed.tapDevice) {
      try {
        await this.execAsync('ip', ['link', 'del', managed.tapDevice]);
      } catch {
        // TAP may already be cleaned up
      }
    }

    // 5. Release IP
    await this.ipAllocator.release(managedId);

    // 6. Clean up chroot directory, unless the process could not be signalled:
    //    it still runs out of those files, and its chroot is what lets
    //    `kici-admin scaler orphans` list and stop it once it is untracked.
    if (!stillRunning) {
      try {
        await this.removeChrootDir(managedId);
      } catch {
        // Best effort
      }
    }

    // 6. Remove from tracking
    this.agents.delete(managedId);
    this.spawnFailureHandlers.delete(managedId);
  }

  /**
   * Force-reclaim a VM this backend no longer tracks in memory.
   *
   * After an orchestrator restart `destroy()` no-ops (`if (!managed) return`) while the VM keeps
   * its RAM and IP, and `cleanupOrphans()` deliberately skips any id whose jailer process is
   * alive: sweeping blind, a live process is all that tells a healthy VM from a leaked one.
   *
   * This is the same reclaim for ONE id the caller already established as an orphan, so the
   * liveness check must not apply. See `ScalerBackend.reapUnowned` for the two properties the
   * caller relies on; the host-local half is enforced here by refusing to act unless the jailer
   * chroot for `managedId` exists on THIS host. That directory is the only host-local artifact a
   * VM leaves: an HA pair shares PostgreSQL, scalers and routing key
   * (`docs/operator/orchestrator/clustering.md`), so a peer's live VM has an `ip_allocations`
   * row naming this very scaler. The row is read only to finish a reclaim the chroot authorized.
   */
  reapUnowned(managedId: string): Promise<boolean> {
    return this.withHostReclaimLock(() => this.reapUnownedLocked(managedId));
  }

  private async reapUnownedLocked(managedId: string): Promise<boolean> {
    if (this.agents.has(managedId)) {
      // Still tracked, so `destroy()` owns this id and holds the live TAP and
      // IP for it. Reaping underneath it would race its teardown.
      return false;
    }

    // THE ONE GATE. Without a chroot nothing places this VM on this host, and a
    // shared `ip_allocations` row cannot (see the method comment): releasing a
    // peer's row hands its address to the next VM — two guests on one IP,
    // sharing the saddr-keyed isolation rules meant to separate them. A
    // row-without-chroot needs no reclaim: there is no PID file to kill through,
    // and `cleanupOrphans()` Pass 1 releases it (`isChrootPidRunning` reads false).
    if (!(await this.hasChrootOnHost(managedId))) return false;

    // A running process this backend cannot identify is not signalled, and the
    // files it may be running out of are not deleted under it.
    const probe = await this.probeVmPid(managedId);
    if (probe.state === 'running' && !probe.identityConfirmed) {
      logger.warn('firecracker: unowned VM left alone, its process is not provably its own', {
        managedId,
        pid: probe.pid,
        detail: probe.detail,
      });
      return false;
    }

    const alloc = await this.lookupAllocation(managedId);
    logger.warn('firecracker: reclaiming an unowned VM', {
      managedId,
      ownsAllocation: alloc !== null && alloc.scaler_name === this.name,
    });

    // No graceful SendCtrlAltDel, unlike `destroy()`: the guest is a refused
    // agent with no work in flight, and this process never opened its socket.
    // A process that could not be signalled keeps running out of its chroot,
    // so nothing is torn down under it and the chroot stays listable.
    if (probe.state === 'running' && !(await this.signalVmProcessOrLog(managedId, probe.pid))) {
      return false;
    }

    await this.teardownUntrackedVm(managedId, alloc);
    return true;
  }

  /** Whether the jailer chroot for `vmId` exists on this host. */
  private async hasChrootOnHost(vmId: string): Promise<boolean> {
    try {
      return (await stat(join(this.chrootBaseDir, 'firecracker', vmId))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * The `ip_allocations` row for `vmId`, or null. Best effort: a failed read
   * only costs the IP release, which the next sweep redoes.
   */
  private async lookupAllocation(vmId: string): Promise<IpAllocationRecord | null> {
    try {
      return await this.ipAllocator.getAllocationForVm(vmId);
    } catch (err) {
      logger.warn('firecracker: allocation lookup failed during orphan reclaim', {
        managedId: vmId,
        error: toErrorMessage(err),
      });
      return null;
    }
  }

  /** Whether this scaler's allocator holds the address of `vmId`. */
  async ownsAllocationFor(vmId: string): Promise<boolean> {
    const alloc = await this.lookupAllocation(vmId);
    return alloc !== null && alloc.scaler_name === this.name;
  }

  /**
   * Reclaim the host resources of a dead, untracked VM: forward its remaining logs, remove its
   * isolation rules, TAP and IP, and delete its chroot.
   *
   * Only a row naming THIS scaler is ours to release: a second firecracker scaler on this host
   * has its own IP space and teardown. With no such row (a worker's in-memory allocator forgets
   * every row on restart) the TAP named after the VM's id is deleted; that name cannot be
   * another VM's.
   */
  private async teardownUntrackedVm(vmId: string, alloc: IpAllocationRecord | null): Promise<void> {
    // The logs are the only record of why the VM was orphaned.
    try {
      await this.forwardRemainingLogs(vmId, this.getChrootDir(vmId));
    } catch {
      // Best effort — the log files may not exist.
    }

    if (alloc !== null && alloc.scaler_name === this.name) {
      try {
        await removeIsolationRules(alloc.ip, this.nftOpts());
      } catch {
        // Best effort — a stale rule is inert once the TAP is gone.
      }
      try {
        await this.execAsync('ip', ['link', 'del', alloc.tap_device]);
      } catch {
        // TAP may already be gone.
      }
      try {
        await this.ipAllocator.release(vmId);
      } catch (err) {
        logger.warn('firecracker: IP release failed during orphan reclaim', {
          managedId: vmId,
          error: toErrorMessage(err),
        });
      }
    } else {
      try {
        await this.execAsync('ip', ['link', 'del', generateTapName(vmId)]);
      } catch {
        // TAP may already be gone.
      }
    }

    try {
      await this.removeChrootDir(vmId);
    } catch {
      // Best effort — the next sweep sees it now that the process is dead.
    }
  }

  /** Whether a live VM is one this backend spawned and still tracks. */
  isTrackingVm(vmId: string): boolean {
    return this.agents.has(vmId);
  }

  /**
   * Every VM under this scaler's chroot base whose firecracker process is
   * running right now. A VM whose process is gone, or whose PID number was
   * recycled, is dead and belongs to the orphan sweep, so it is not listed.
   */
  async listLiveVms(): Promise<LiveVmProbe[]> {
    let entries: string[];
    try {
      // A dot-entry is not a VM chroot: the overlay templates live in one.
      entries = (await readdir(join(this.chrootBaseDir, 'firecracker'))).filter(
        (entry) => !entry.startsWith('.'),
      );
    } catch {
      // The chroot parent may not exist yet.
      return [];
    }
    const live: LiveVmProbe[] = [];
    for (const vmId of entries) {
      const probe = await this.probeVmPid(vmId);
      if (probe.state !== 'running') continue;
      live.push({
        vmId,
        scaler: this.name,
        pid: probe.pid,
        startedAtMs: probe.startedAtMs,
        chrootDir: this.getChrootDir(vmId),
        identityConfirmed: probe.identityConfirmed,
        ...(probe.identityConfirmed ? {} : { detail: probe.detail }),
      });
    }
    return live;
  }

  /**
   * Stop one live VM nothing on this node tracks, on an operator's request.
   *
   * The tracked check and the first `kill(2)` run in one synchronous tick: tracking only changes
   * between ticks (a registration, a rehydrated spawn row, a new spawn), so nothing can claim the
   * VM in between. The kernel can still recycle the PID in that window, as in `destroy` and
   * `reapUnowned`; Node has no pidfd to close it.
   *
   * Runs under the host reclaim lock, so a sweep cannot release this VM's address to a new VM
   * while the stop is still removing its rules.
   *
   * @param trackersOf what else on this node tracks the VM, read in the
   *   kill's tick; it must not await.
   */
  stopUntrackedVm(vmId: string, trackersOf: () => ScalerVmTracker[]): Promise<ScalerVmStopResult> {
    return this.withHostReclaimLock(() => this.stopUntrackedVmLocked(vmId, trackersOf));
  }

  private async stopUntrackedVmLocked(
    vmId: string,
    trackersOf: () => ScalerVmTracker[],
  ): Promise<ScalerVmStopResult> {
    const refused = (
      outcome: ScalerVmStopOutcome,
      detail: string,
      pid?: number,
    ): ScalerVmStopResult => {
      logger.warn('firecracker: untracked VM stop refused', { vmId, outcome, detail });
      return { vmId, outcome, detail, ...(pid !== undefined ? { pid } : {}) };
    };

    // `join` resolves `..`, so `x/../<tracked id>` would reach a tracked VM's
    // chroot while every tracker lookup misses the string: one segment only.
    if (vmId.includes('/') || vmId === '.' || vmId === '..') {
      return refused(ScalerVmStopOutcome.enum['not-found'], 'not a VM id: it names a path');
    }
    if (this.isTrackingVm(vmId)) {
      return refused(ScalerVmStopOutcome.enum.tracked, `tracked: ${ScalerVmTracker.enum.backend}`);
    }
    if (!(await this.hasChrootOnHost(vmId))) {
      return refused(ScalerVmStopOutcome.enum['not-found'], 'no chroot for this VM on this host');
    }
    const probe = await this.probeVmPid(vmId);
    if (probe.state !== 'running') {
      // A dead VM's chroot belongs to the orphan sweep and `reap-orphans`.
      return refused(ScalerVmStopOutcome.enum['not-live'], 'the VM process is not running');
    }
    if (!probe.identityConfirmed) {
      return refused(
        ScalerVmStopOutcome.enum.unverified,
        `PID ${probe.pid} is not provably this VM's firecracker (${probe.detail})`,
        probe.pid,
      );
    }

    // No await from here to the signal: see the method comment.
    const trackers = [
      ...(this.isTrackingVm(vmId) ? [ScalerVmTracker.enum.backend] : []),
      ...trackersOf(),
    ];
    if (trackers.length > 0) {
      return refused(
        ScalerVmStopOutcome.enum.tracked,
        `tracked: ${trackers.join(', ')}`,
        probe.pid,
      );
    }
    logger.warn('firecracker: stopping an untracked live VM', {
      vmId,
      pid: probe.pid,
      scaler: this.name,
    });
    try {
      // signalVmProcess opens with the synchronous kill(2), so the signal goes
      // out in this tick.
      await this.signalVmProcess(probe.pid);
    } catch (err) {
      return refused(ScalerVmStopOutcome.enum.error, toErrorMessage(err), probe.pid);
    }

    if (!(await this.waitForProcessExit(vmId, 5000))) {
      return refused(
        ScalerVmStopOutcome.enum.error,
        'process did not exit after SIGKILL; chroot kept',
        probe.pid,
      );
    }
    await this.teardownUntrackedVm(vmId, await this.lookupAllocation(vmId));
    return {
      vmId,
      outcome: ScalerVmStopOutcome.enum.stopped,
      pid: probe.pid,
      detail: 'stopped',
    };
  }

  /**
   * SIGKILL a VM's firecracker process.
   *
   * The jailer drops firecracker to `--uid`, so another unprivileged user gets EPERM from
   * `kill(2)`. On a rootless host (`requireSudo`) the signal goes through
   * `sudo -n -u #<uid> kill`; elsewhere EPERM means the process lacks CAP_KILL. ESRCH (already
   * gone) is success.
   *
   * The first statement is the synchronous `kill(2)`: `stopUntrackedVm` relies on the signal
   * leaving in its caller's tick.
   */
  private async signalVmProcess(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGKILL');
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw err;
    }
    if (!this.requireSudo) {
      throw new Error(
        `EPERM signalling PID ${pid} (firecracker runs as uid ${this.uid}): grant the ` +
          'orchestrator CAP_KILL, or run it as root',
      );
    }
    try {
      await this.execAsync('kill', ['-s', 'KILL', String(pid)]);
    } catch (err) {
      // The process may have exited on its own between the two signals.
      if (!(await this.procEntryExists(pid))) return;
      throw new Error(
        `EPERM signalling PID ${pid}, and sudo could not signal it as uid ${this.uid} ` +
          `(${toErrorMessage(err)}): add "<orchestrator user> ALL=(#${this.uid}) NOPASSWD: ` +
          '/usr/bin/kill" to the sudoers allowlist',
      );
    }
  }

  /** Whether `/proc/<pid>` names a process right now. */
  private async procEntryExists(pid: number): Promise<boolean> {
    try {
      await readFile(`/proc/${pid}/stat`, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * {@link signalVmProcess} for the teardown paths: a failure is logged and reported, so the
   * caller keeps the chroot of a process that still runs.
   *
   * @returns whether the process was signalled or was already gone
   */
  private async signalVmProcessOrLog(managedId: string, pid: number): Promise<boolean> {
    try {
      await this.signalVmProcess(pid);
      return true;
    } catch (err) {
      logger.error('firecracker: could not signal a VM process; it keeps running', {
        managedId,
        pid,
        error: toErrorMessage(err),
      });
      return false;
    }
  }

  /**
   * Serialise host reclaims: the orphan sweep, the unowned-VM reclaim and the
   * operator stop. Each frees addresses and deletes rules and TAPs by name, so
   * two interleaved can hand an address one is still tearing down to a new VM
   * and then delete the new VM's rules.
   */
  private withHostReclaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.hostReclaimChain.then(fn, fn);
    this.hostReclaimChain = run.catch(() => undefined);
    return run;
  }

  async shutdownAll(): Promise<void> {
    this.stopPeriodicOrphanSweep();
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /**
   * Clear an agent's MMDS data after its config.ack arrives via WS, so nothing is left to read
   * post-startup (belt-and-suspenders). Called by `ScalerManager.onConfigAck` structurally
   * (`'clearAgentMmds' in backend`), not through `ScalerBackend`: no other backend has an MMDS.
   */
  async clearAgentMmds(agentId: string): Promise<void> {
    try {
      const socketPath = this.getSocketPath(agentId);
      const api = new FirecrackerApi(socketPath);
      await api.clearMmds();
    } catch (err) {
      // Non-fatal: in-VM iptables blocking backs this up.
      void err;
    }
  }

  reload(
    labelSets: LabelSetConfig[],
    opts?: { maxAgents?: number; entry?: ScalerEntry },
  ): ValidationResult {
    // Validate: all Firecracker label sets must have rootfsPath
    const errors: string[] = [];
    labelSets.forEach((ls, i) => {
      if (!ls.rootfsPath) {
        errors.push(`Label set [${i}] requires a 'rootfsPath' field for Firecracker backend`);
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
   * Clean up orphaned VMs; returns the count cleaned.
   *
   * Safe at startup AND periodically (startPeriodicOrphanSweep): each pass skips VMs tracked
   * in-memory (spawning / running / destroying), and Pass 3 re-reads DB allocations after
   * listing host interfaces to close the spawn race (allocate → ip tuntap add is not atomic).
   *
   * Passes:
   * 1. DB allocations: check if VM process is still running, clean dead ones
   * 2. Filesystem: scan chroot dir for directories not in DB allocations
   * 3. Network: scan host interfaces for orphan TAP devices
   * 4. nftables: reap isolation rules no live VM owns
   */
  cleanupOrphans(): Promise<number> {
    return this.withHostReclaimLock(() => this.cleanupOrphansLocked());
  }

  private async cleanupOrphansLocked(): Promise<number> {
    let cleaned = 0;

    // Tracked VMs are never touched, even if a transient filesystem or
    // process-table state makes them look dead.
    const trackedVmIds = new Set(this.agents.keys());

    // One PID-liveness pre-scan shared by every pass, so a standalone reap
    // (empty DB + empty tracking) never deletes a live VM's chroot or TAP.
    const chrootParent = join(this.chrootBaseDir, 'firecracker');
    let chrootEntries: string[] = [];
    try {
      // A dot-entry is not a VM chroot: the overlay templates live in one.
      chrootEntries = (await readdir(chrootParent)).filter((entry) => !entry.startsWith('.'));
    } catch {
      // Chroot parent may not exist yet.
    }
    const liveVmIds = new Set<string>();
    for (const entry of chrootEntries) {
      if (trackedVmIds.has(entry) || (await this.isChrootPidRunning(entry))) {
        liveVmIds.add(entry);
      }
    }
    // Derive the live-TAP set for Pass 3 through the same helper the allocator
    // uses, so the guard can never disagree with the name actually created.
    const liveTapNames = new Set([...liveVmIds].map((id) => generateTapName(id)));

    // Pass 1: Check DB allocations for this scaler
    try {
      const allocations = await this.ipAllocator.getAllocations();
      const scalerAllocations = allocations.filter((a) => a.scaler_name === this.name);

      for (const alloc of scalerAllocations) {
        // Mid-spawn or mid-destroy, the PID file may not exist yet or may be gone.
        if (trackedVmIds.has(alloc.vm_id)) continue;

        const isAlive = liveVmIds.has(alloc.vm_id) || (await this.isChrootPidRunning(alloc.vm_id));
        if (!isAlive) {
          // Dead VM: forward remaining logs, release IP, delete TAP, clean chroot
          try {
            const chrootDir = this.getChrootDir(alloc.vm_id);
            await this.forwardRemainingLogs(alloc.vm_id, chrootDir);
          } catch {
            // Best effort -- log files may not exist
          }
          try {
            await this.execAsync('ip', ['link', 'del', alloc.tap_device]);
          } catch {
            // TAP may already be gone
          }
          await this.ipAllocator.release(alloc.vm_id);
          try {
            await this.removeChrootDir(alloc.vm_id);
          } catch {
            // Best effort
          }
          cleaned++;
        }
      }

      // Pass 2: Scan filesystem for directories with no corresponding DB allocation
      const allocatedVmIds = new Set(allocations.map((a) => a.vm_id));
      for (const entry of chrootEntries) {
        if (allocatedVmIds.has(entry)) continue;
        if (trackedVmIds.has(entry)) continue; // in-flight spawn/destroy
        if (liveVmIds.has(entry)) continue; // live VM — never reap
        // Filesystem orphan: no DB record -- forward remaining logs before deletion
        try {
          const orphanChrootDir = join(chrootParent, entry, 'root');
          await this.forwardRemainingLogs(entry, orphanChrootDir);
        } catch {
          // Best effort
        }
        try {
          await this.removeChrootDir(entry);
          cleaned++;
        } catch {
          // Best effort
        }
      }

      // Pass 3: Scan host network interfaces for orphan TAP devices matching the
      // per-VM naming pattern with no DB allocation. Covers an orchestrator
      // SIGKILLed mid-destroy, after the DB row and chroot went but before
      // `ip link del`. NetworkManager polls every orphan, so even a few leaked
      // TAPs burn CPU (2026-04-14 incident: NM main thread wedged for 10 days).
      //
      // Race: spawn() inserts the DB row BEFORE `ip tuntap add`, but our first
      // read may predate that insert. So re-read AFTER listing interfaces and
      // skip any TAP in either snapshot or tracked by an in-memory agent.
      const trackedTapDevices = new Set(
        [...this.agents.values()].map((a) => a.tapDevice).filter((tap) => tap.length > 0),
      );
      const allocatedTapsBefore = new Set(allocations.map((a) => a.tap_device));
      try {
        const { stdout } = await this.execAsync('ip', ['-br', 'link']);
        const ifaceNames = stdout
          .split('\n')
          .map((line) => line.split(/\s+/)[0])
          .filter((name): name is string => !!name);
        let allocatedTapsAfter: Set<string>;
        try {
          const allocationsAfter = await this.ipAllocator.getAllocations();
          allocatedTapsAfter = new Set(allocationsAfter.map((a) => a.tap_device));
        } catch {
          // Fall back to the first snapshot: at worst a genuine orphan waits
          // for the next sweep.
          allocatedTapsAfter = allocatedTapsBefore;
        }
        for (const name of ifaceNames) {
          if (!VM_TAP_PATTERN.test(name)) continue;
          if (name === this.bridgeName) continue;
          if (allocatedTapsBefore.has(name)) continue;
          if (allocatedTapsAfter.has(name)) continue;
          if (trackedTapDevices.has(name)) continue;
          if (liveTapNames.has(name)) continue; // TAP of a live VM — never delete
          try {
            await this.execAsync('ip', ['link', 'del', name]);
            cleaned++;
          } catch {
            // TAP may have been deleted concurrently; best effort
          }
        }
      } catch {
        // `ip` may be missing in the test environment
      }
    } catch {
      // DB may not be available on first startup
    }

    // Pass 4: nftables rules. A crash, `kill -9`, a VM that died while the
    // orchestrator was down, or a swallowed `removeIsolationRules` failure
    // leaves `ip saddr <ip> …` rules in the shared chain forever: the next
    // tenant on that IP inherits the dead job's allowlist, and duplicate drops
    // pile up unboundedly across restarts.
    cleaned += await this.reapUnownedIsolationRules(liveVmIds);

    return cleaned;
  }

  /**
   * Delete isolation rules for every identifier no live VM owns.
   *
   * The live set is the passes' live VM ids, mapped to this scaler's allocated IPs. An
   * identifier the DB does not attribute to this scaler is left alone: a second scaler on the
   * host writes to the same chain, and reaping its rules would cut its running jobs off.
   *
   * @returns the number of rules deleted
   */
  private async reapUnownedIsolationRules(liveVmIds: Set<string>): Promise<number> {
    const nftOpts = this.nftOpts();
    let allocations: IpAllocationRecord[];
    try {
      allocations = await this.ipAllocator.getAllocations();
    } catch {
      // Without the allocation table there is no way to tell which identifiers
      // are ours, and guessing would reap another scaler's live rules.
      return 0;
    }
    const ours = allocations.filter((a) => a.scaler_name === this.name);
    const ownedIps = new Set(ours.map((a) => a.ip));
    const liveIps = new Set(ours.filter((a) => liveVmIds.has(a.vm_id)).map((a) => a.ip));
    // A VM this backend is spawning may not have its allocation row visible
    // yet; its rules must never be reaped out from under it.
    for (const managed of this.agents.values()) {
      if (managed.ip.length > 0) {
        ownedIps.add(managed.ip);
        liveIps.add(managed.ip);
      }
    }

    let deleted = 0;
    for (const [identifier, handles] of await listIsolationRules(nftOpts)) {
      if (!ownedIps.has(identifier) || liveIps.has(identifier)) continue;
      const n = await deleteForwardRules(handles, nftOpts);
      if (n > 0) {
        logger.info(`reaped ${n} stale isolation rule(s) for ${identifier}`);
        deleted += n;
      }
    }
    return deleted;
  }

  /**
   * Default periodic orphan sweep interval (15 minutes). A host-level cleanup job skips TAP
   * cleanup while an orchestrator is active (to avoid racing spawns), so without this sweep
   * leaked TAPs accumulate until the orchestrator restarts, which can be weeks.
   */
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

  /**
   * Start a periodic orphan sweep. Idempotent; stopPeriodicOrphanSweep() stops it.
   *
   * @param intervalMs override the default interval (primarily for tests)
   */
  startPeriodicOrphanSweep(
    intervalMs: number = FirecrackerScalerBackend.ORPHAN_SWEEP_INTERVAL_MS,
  ): void {
    if (this.orphanSweepTimer !== null) return;

    const runSweep = async (): Promise<void> => {
      if (this.orphanSweepInFlight) return;
      this.orphanSweepInFlight = true;
      try {
        const cleaned = await this.cleanupOrphans();
        if (cleaned > 0) {
          logger.info(`Periodic orphan sweep cleaned ${cleaned} resources`, {
            backend: this.name,
          });
        }
      } catch (err) {
        logger.warn('Periodic orphan sweep failed', {
          backend: this.name,
          error: toErrorMessage(err),
        });
      } finally {
        this.orphanSweepInFlight = false;
      }
    };

    this.orphanSweepTimer = setInterval(() => {
      runSweep().catch(() => {
        // runSweep never throws — but appease the linter
      });
    }, intervalMs);
    this.orphanSweepTimer.unref?.();
  }

  /**
   * Stop the periodic orphan sweep started by startPeriodicOrphanSweep().
   * Safe to call when the sweep was never started.
   */
  stopPeriodicOrphanSweep(): void {
    if (this.orphanSweepTimer !== null) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Build the merged forwarded-env map for an agent's MMDS payload.
   *
   * Mirrors bare-metal/container precedence: KICI_AGENT_ENV_*-prefixed vars from the
   * orchestrator's process.env (prefix stripped) first, then scalers.yaml `env:` (yaml wins).
   *
   * Safety filters:
   * - Keys must match POSIX_ENV_NAME_PATTERN, keeping MMDS path construction safe and never
   *   asking the guest to `export` something the shell can't represent.
   * - The cumulative cost (key + value + 2 bytes per entry) must stay under
   *   MMDS_FORWARDED_ENV_BUDGET_BYTES; entries past it are skipped with a warning, protecting
   *   the ~51 KiB MMDS store cap from a huge env value.
   */
  buildForwardedEnv(matchedLabelSet: LabelSetConfig, agentId: string): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith(KICI_AGENT_ENV_PREFIX) || v === undefined) continue;
      const stripped = k.slice(KICI_AGENT_ENV_PREFIX.length);
      if (stripped.length === 0) continue;
      merged[stripped] = v;
    }
    Object.assign(merged, matchedLabelSet.env ?? {});

    const accepted: Record<string, string> = {};
    let usedBytes = 0;
    for (const [k, v] of Object.entries(merged)) {
      if (!POSIX_ENV_NAME_PATTERN.test(k)) {
        logger.warn(
          `Skipping forwarded env var "${k}" for agent ${agentId}: not a POSIX-safe identifier`,
        );
        continue;
      }
      const cost = Buffer.byteLength(k) + Buffer.byteLength(v) + 2;
      if (usedBytes + cost > MMDS_FORWARDED_ENV_BUDGET_BYTES) {
        logger.warn(
          `Skipping forwarded env var "${k}" for agent ${agentId}: would exceed ${MMDS_FORWARDED_ENV_BUDGET_BYTES}-byte MMDS budget`,
        );
        continue;
      }
      accepted[k] = v;
      usedBytes += cost;
    }
    return accepted;
  }

  /**
   * Build the Firecracker VM configuration JSON.
   *
   * Resolution order for vcpu_count and mem_size_mib:
   *   1. effectiveLimits (resolved by ScalerManager from job/scaler/global caps) — wins if set.
   *   2. label-set's vcpuCount/memSizeMib.
   *   3. backend-level default vcpuCount/memSizeMib.
   *
   * Firecracker requires integer vCPUs and MiB: CPUs round UP (a 0.5-CPU request gets a whole
   * vCPU, never under-provisioned) and bytes floor-divide to MiB. A rounding that changes the
   * value logs at debug, so operators can spot frequent fractional requests.
   */
  buildVmConfig(
    alloc: IpAllocationResult,
    labelSet: LabelSetConfig,
    effectiveLimits?: EffectiveLimits,
  ): Record<string, unknown> {
    let vcpuCount = labelSet.vcpuCount ?? this.vcpuCount;
    let memSizeMib = labelSet.memSizeMib ?? this.memSizeMib;

    if (effectiveLimits) {
      if (typeof effectiveLimits.cpus === 'number' && effectiveLimits.cpus > 0) {
        const rounded = Math.max(1, Math.ceil(effectiveLimits.cpus));
        if (rounded !== effectiveLimits.cpus) {
          logger.debug(
            `Rounding effective CPU limit ${effectiveLimits.cpus} up to ${rounded} vCPUs for Firecracker (integer vCPU required)`,
          );
        }
        vcpuCount = rounded;
      }
      if (typeof effectiveLimits.memBytes === 'number' && effectiveLimits.memBytes > 0) {
        const mib = Math.floor(effectiveLimits.memBytes / (1024 * 1024));
        if (mib > 0) {
          if (mib * 1024 * 1024 !== effectiveLimits.memBytes) {
            logger.debug(
              `Truncating effective memory limit ${effectiveLimits.memBytes}B to ${mib} MiB for Firecracker (integer MiB required)`,
            );
          }
          memSizeMib = mib;
        }
      }
    }

    return {
      'boot-source': {
        kernel_image_path: '/kernel',
        boot_args: `console=ttyS0 reboot=k panic=1 random.trust_cpu=on init=/init ip=${alloc.ip}::${this.gateway}:${this.netmask}::eth0:off`,
      },
      drives: [
        {
          drive_id: 'rootfs',
          path_on_host: '/rootfs.ext4',
          is_root_device: true,
          is_read_only: true,
        },
        {
          drive_id: 'overlay',
          path_on_host: '/overlay.ext4',
          is_root_device: false,
          is_read_only: false,
        },
      ],
      'machine-config': {
        vcpu_count: vcpuCount,
        mem_size_mib: memSizeMib,
        smt: false,
      },
      'network-interfaces': [
        {
          iface_id: 'eth0',
          guest_mac: alloc.mac,
          host_dev_name: alloc.tapDevice,
        },
      ],
      'mmds-config': {
        network_interfaces: ['eth0'],
        ipv4_address: '169.254.169.254',
      },
    };
  }

  /**
   * Create the per-VM writable overlay drive: a sparse copy of this host's
   * pre-formatted ext4 template for the size, so the guest can mount it
   * immediately. See `overlay-template.ts` for why a spawn never formats.
   */
  private async createOverlayDrive(path: string, sizeMib: number): Promise<void> {
    await this.overlayTemplates.createOverlay(path, sizeMib);
  }

  /**
   * Build the overlay template of every configured drive size in the
   * background, so the first spawn after startup copies instead of formatting.
   * A failure is logged; the first spawn of that size builds it instead.
   */
  private prewarmOverlayTemplates(): void {
    const sizes = new Set(
      this._labelSets.map((ls) => ls.overlayDriveSizeMib ?? DEFAULT_OVERLAY_MIB),
    );
    for (const sizeMib of sizes) {
      runDetached(
        logger,
        'Overlay template pre-build',
        () => this.overlayTemplates.ensure(sizeMib),
        {
          sizeMib,
        },
      );
    }
  }

  /**
   * Run a host command with a timeout (30s unless the caller passes one).
   *
   * A failure rejects with a `CommandError` whose message names the command,
   * its exit code or signal, whether the timeout killed it, how long it ran,
   * and the tail of its stderr. Spawn steps throw it as-is, so the same text
   * reaches the `scaler.failed` event detail and the spawn-failure logs.
   */
  private async execAsync(
    cmd: string,
    args: string[],
    timeoutMs = EXEC_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    // A non-root orchestrator (edge worker nodes) needs a NOPASSWD sudoers entry
    // for `ip`, `chown`, `chmod` and `kill`; `-n` fails fast if sudo would prompt.
    // `kill` runs as the jailer uid, so its grant only signals jailer-owned processes.
    const sudoArgv =
      cmd === 'kill' ? ['-n', '-u', `#${this.uid}`, cmd, ...args] : ['-n', cmd, ...args];
    const [file, argv] =
      this.requireSudo && (cmd === 'ip' || cmd === 'chown' || cmd === 'chmod' || cmd === 'kill')
        ? ['sudo', sudoArgv]
        : [cmd, args];
    const startedAt = Date.now();
    try {
      return await execFileAsync(file, argv, { timeout: timeoutMs });
    } catch (err) {
      throw toCommandError(err, {
        command: [file, ...argv].join(' '),
        timeoutMs,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Remove a VM's jailer chroot directory.
   *
   * On rootless nodes (requireSudo) the jailer leaves inner directories owned by its uid with
   * mode 0755, so a plain `rm` by the orchestrator's uid fails with EACCES. destroy() and both
   * cleanupOrphans passes swallow that failure, so each spawn would leak a multi-GiB chroot
   * until the data disk fills and the orchestrator crash-loops on ENOSPC (unable to start, so
   * its orphan sweep never recovers). Ownership is reclaimed via the sudo-wrapped `chown` first;
   * root nodes skip it.
   */
  private async removeChrootDir(vmId: string): Promise<void> {
    const dir = join(this.chrootBaseDir, 'firecracker', vmId);
    if (this.requireSudo) {
      // The `?? 0` only satisfies the optional typing; every POSIX host has getuid.
      const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
      try {
        await this.execAsync('chown', ['-R', owner, dir]);
      } catch {
        // Best effort: a partial chown still lets the rm reclaim what we own; a
        // total failure is a sudoers misconfig, and the dir stays for the next sweep.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  getSocketPath(agentId: string): string {
    return join(this.chrootBaseDir, 'firecracker', agentId, 'root', 'run', 'firecracker.socket');
  }

  getChrootDir(agentId: string): string {
    return join(this.chrootBaseDir, 'firecracker', agentId, 'root');
  }

  /**
   * Probe the process a VM's PID file names.
   *
   * Checks, in order:
   *  1. the file parses to a plausible PID;
   *  2. `/proc/<pid>/stat` exists at all — the file is world-readable
   *     regardless of the jailer's `--uid` drop, so an unreadable one means no
   *     such process;
   *  3. field 22 (`starttime`) is not later than the PID file's mtime — a
   *     recycled number belongs to a process that started after the file
   *     naming it was written;
   *  4. field 2 (`comm`) is `firecracker` (11 characters, so it is not
   *     truncated by the 15-character `comm` limit) and `/proc/<pid>/root` —
   *     where the jailer pivot_roots — resolves to this VM's chroot (same
   *     device and inode) when it is readable at all. Those carry
   *     `identityConfirmed`, not liveness.
   */
  private async probeVmPid(vmId: string): Promise<VmPidProbe> {
    const pidFile = join(this.getChrootDir(vmId), 'firecracker.pid');
    let pid: number;
    let pidFileMtimeMs: number;
    try {
      const [pidStr, pidFileStat] = await Promise.all([readFile(pidFile, 'utf-8'), stat(pidFile)]);
      pid = parseInt(String(pidStr).trim(), 10);
      pidFileMtimeMs = pidFileStat.mtimeMs;
    } catch {
      // No PID file: the VM never started, or its chroot is already gone.
      return { state: 'gone' };
    }
    // `> 0` and not merely `!isNaN`: a truncated or zeroed file parses to 0,
    // and both `process.kill(0, …)` and signal 0 reach the orchestrator's OWN
    // process group.
    if (!(pid > 0)) return { state: 'gone' };

    let procStat: string;
    try {
      procStat = String(await readFile(`/proc/${pid}/stat`, 'utf-8'));
    } catch {
      // No /proc entry — the process is gone.
      return { state: 'gone' };
    }

    // Fields after the LAST ')' start at field 3 (see `procStartTicks`).
    const commOpen = procStat.indexOf('(');
    const commClose = procStat.lastIndexOf(')');
    if (commOpen < 0 || commClose < commOpen) return { state: 'gone' };
    const comm = procStat.slice(commOpen + 1, commClose);

    const laterFields = procStat
      .slice(commClose + 1)
      .trim()
      .split(/\s+/);
    const startTicks = Number(laterFields[19]); // field 22, zero-based from field 3
    if (!Number.isFinite(startTicks)) return { state: 'gone' };
    const startedMs = Date.now() - uptime() * 1000 + (startTicks / USER_HZ) * 1000;
    if (startedMs > pidFileMtimeMs + PID_START_SLACK_MS) {
      logger.warn(
        `PID ${pid} named by ${vmId}'s PID file started after the file was written — ` +
          'the number has been recycled; treating the VM as dead',
      );
      return { state: 'recycled', pid };
    }

    if (comm !== 'firecracker') {
      return {
        state: 'running',
        pid,
        startedAtMs: startedMs,
        identityConfirmed: false,
        detail: `comm="${comm}"`,
      };
    }

    // The jailer pivot_roots in its own mount namespace, so the text of
    // `/proc/<pid>/root` reads `/` from the host for every VM. The directory
    // the link resolves to is still the VM's chroot: compare device and inode.
    const chrootDir = this.getChrootDir(vmId);
    try {
      const [procRoot, chroot] = await Promise.all([stat(`/proc/${pid}/root`), stat(chrootDir)]);
      if (procRoot.dev !== chroot.dev || procRoot.ino !== chroot.ino) {
        return {
          state: 'running',
          pid,
          startedAtMs: startedMs,
          identityConfirmed: false,
          detail: `its root directory is not ${chrootDir}`,
        };
      }
    } catch {
      // EACCES under the jailer's --uid drop, or ESRCH on a race. Not evidence
      // either way, and checks 3 and 4's `comm` already carry the identity.
    }

    return { state: 'running', pid, startedAtMs: startedMs, identityConfirmed: true };
  }

  /**
   * The PID from a VM's PID file, only when it is provably still *this* VM's firecracker.
   * `destroy` and `reapUnowned` SIGKILL through it, so it fails closed: anything short of a
   * confirmed identity yields `undefined` and nothing is signalled.
   */
  private async readVmPid(vmId: string): Promise<number | undefined> {
    const probe = await this.probeVmPid(vmId);
    if (probe.state !== 'running') return undefined;
    if (!probe.identityConfirmed) {
      logger.warn(
        `PID ${probe.pid} named by ${vmId}'s PID file is not provably its firecracker ` +
          `process (${probe.detail}) — leaving the process alone`,
      );
      return undefined;
    }
    return probe.pid;
  }

  /**
   * Whether a chroot's PID file names a process that is running right now.
   *
   * The orphan reaper's guard fails closed opposite to {@link readVmPid}: that refuses to signal
   * a PID it cannot claim; the reaper must refuse to DELETE THE ROOTFS under one. A process whose
   * `comm` or `/proc/<pid>/root` does not match is still a process, and deleting its files
   * corrupts it, while sparing it costs one chroot's disk. A recycled PID is still detected by
   * start time, so a chroot whose VM is genuinely over is still reclaimed.
   */
  private async isChrootPidRunning(vmId: string): Promise<boolean> {
    const probe = await this.probeVmPid(vmId);
    if (probe.state !== 'running') return false;
    if (!probe.identityConfirmed) {
      logger.warn(
        `PID ${probe.pid} named by ${vmId}'s PID file is running but is not provably its ` +
          `firecracker process (${probe.detail}) — sparing the chroot rather than deleting ` +
          'files under a live process',
      );
    }
    return true;
  }

  /**
   * Whether *this* VM's own firecracker process is still up: `readVmPid` plus signal 0, the
   * identity-bearing question {@link waitForProcessExit} needs. Without the identity checks a
   * recycled PID answers signal 0 and the VM is spared forever. The orphan reaper uses
   * {@link isChrootPidRunning} instead.
   */
  private async isVmProcessAlive(vmId: string): Promise<boolean> {
    const pid = await this.readVmPid(vmId);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: the process exists but runs as the jailer uid, which an
      // unprivileged orchestrator may not signal.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async waitForProcessExit(vmId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const interval = 200;

    while (Date.now() < deadline) {
      const alive = await this.isVmProcessAlive(vmId);
      if (!alive) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }

    return false;
  }

  private async cleanupFailedSpawn(
    agentId: string,
    alloc: IpAllocationResult | undefined,
  ): Promise<void> {
    // The tracking entry is dropped here, not per call site: one outliving its
    // VM is counted by `getActiveCount()` forever and hides its leaked
    // resources from every sweep.
    //
    // The delete is also the load-bearing run-once latch: an aborted spawn is
    // torn down by `abandonSpawn` and AGAIN by `spawn`'s catch, and the
    // allocator recycles the address and TAP name immediately, so a second
    // pass would delete another VM's rules and TAP. `Map.delete`'s return makes
    // the test-and-clear atomic against that interleaving.
    //
    // A VM `destroy()` is tearing down is left to it, so the IP and TAP are
    // not released twice.
    if (this.agents.get(agentId)?.state === 'destroying') return;
    if (!this.agents.delete(agentId)) return;
    this.spawnFailureHandlers.delete(agentId);
    this.stopRegistrationWatch(agentId);

    // Release IP if allocated
    if (alloc) {
      // Clean up per-VM nftables rules (saddr-keyed)
      try {
        await removeIsolationRules(alloc.ip, this.nftOpts());
      } catch {
        // Best effort
      }

      try {
        await this.ipAllocator.release(agentId);
      } catch {
        // Best effort
      }

      // Delete TAP device if created
      try {
        await this.execAsync('ip', ['link', 'del', alloc.tapDevice]);
      } catch {
        // TAP may not have been created yet
      }
    }

    this.stopLogTailing(agentId);

    // `removeChrootDir` reclaims ownership on rootless hosts, where the chroot
    // may already belong to the jailer uid.
    try {
      await this.removeChrootDir(agentId);
    } catch {
      // Best effort
    }
  }

  // ── Log tailing & boot failure detection ───────────────────────

  /**
   * Tail the serial console and VMM log files, forwarding lines via forwardLine() with distinct
   * logsSource tags, and watch the jailer child for early exit (boot failure). Forwarding is
   * internal, not through ScalerManager/AgentLogForwarder, because each VM has two log sources.
   */
  private startLogTailing(
    agentId: string,
    serialLogPath: string,
    vmmLogPath: string,
    child: ChildProcess,
    alloc: IpAllocationResult | undefined,
  ): void {
    const abortController = new AbortController();
    this.tailAbortControllers.set(agentId, abortController);

    const signal = abortController.signal;
    const output = process.stdout;

    // Tail serial console log (Firecracker stdout = guest ttyS0)
    runDetached(
      logger,
      'Serial console tail',
      () => this.tailAndForward(serialLogPath, agentId, 'firecracker-serial', signal, output),
      { agentId },
    );

    // Tail VMM diagnostic log (Firecracker --log-path)
    runDetached(
      logger,
      'VMM log tail',
      () => this.tailAndForward(vmmLogPath, agentId, 'firecracker-vmm', signal, output),
      { agentId },
    );

    child.on('exit', (code, sig) => {
      // A small delay lets the final log lines be tailed.
      setTimeout(() => {
        if (code !== 0 && code !== null) {
          this.stopLogTailing(agentId);
          const failureType = this.detectFailureType(serialLogPath);
          forwardLine(
            JSON.stringify({
              level: 'error',
              message: 'VM boot failed',
              exitCode: code,
              signal: sig,
              failureType,
            }),
            agentId,
            output,
            undefined,
            'firecracker-serial',
          );
          // The tracking entry, chroot, TAP, nft rules and IP all outlive a
          // jailer that died during boot, and `cleanupOrphans` skips them while
          // `trackedVmIds` names the VM. Tear down and report the failure so
          // the manager releases its reservation.
          this.abandonSpawnDetached(
            agentId,
            alloc,
            `jailer exited during boot (code ${code}${sig ? `, signal ${sig}` : ''}, ${failureType})`,
          );
        }
        // A clean exit says nothing about the VM (`--new-pid-ns`, see
        // `watchJailerBootFailure`), so the tails keep running until destroy()
        // or the failed-spawn cleanup stops them, and `watchUntilRegistered`
        // watches the VM's own process.
      }, 500);
    });
  }

  /**
   * Tail one log file into forwardLine(). Non-JSON serial lines (kernel boot output) are wrapped
   * as debug-level JSON; failure patterns (kernel panic, init failure) are elevated to error.
   */
  private async tailAndForward(
    filePath: string,
    agentId: string,
    logsSource: string,
    signal: AbortSignal,
    output: NodeJS.WritableStream,
  ): Promise<void> {
    try {
      for await (const line of tailFile(filePath, signal)) {
        if (logsSource === 'firecracker-serial') {
          // JSON lines are agent structured logs.
          let isJson = false;
          try {
            JSON.parse(line);
            isJson = true;
          } catch {
            // Not JSON -- kernel boot output or other non-structured text
          }

          if (!isJson) {
            const level = this.isFailurePattern(line) ? 'error' : 'debug';
            forwardLine(
              JSON.stringify({ level, message: line }),
              agentId,
              output,
              undefined,
              logsSource,
            );
            continue;
          }
        }
        forwardLine(line, agentId, output, undefined, logsSource);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // Not critical: forwarded as a warning.
      forwardLine(
        JSON.stringify({ level: 'warn', message: `Log tailing error for ${filePath}: ${err}` }),
        agentId,
        output,
        undefined,
        logsSource,
      );
    }
  }

  /** Whether a serial console line matches a known boot failure pattern. */
  private isFailurePattern(line: string): boolean {
    const patterns = [
      /Kernel panic/i,
      /Failed to execute \/init/i,
      /failed to start/i,
      /systemd\[1\]: Failed/i,
      /VFS: Unable to mount root fs/i,
      /not syncing/i,
    ];
    return patterns.some((p) => p.test(line));
  }

  /** Classify a boot failure from the serial console log. */
  private detectFailureType(serialLogPath: string): string {
    try {
      const content = readFileSync(serialLogPath, 'utf-8');
      if (/Kernel panic/i.test(content)) return 'kernel-panic';
      if (/Failed to execute \/init/i.test(content) || /systemd\[1\]: Failed/i.test(content))
        return 'init-failure';
      if (/VFS: Unable to mount root fs/i.test(content)) return 'rootfs-mount-failure';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Forward a dead VM's remaining log content before its chroot is deleted. */
  private async forwardRemainingLogs(vmId: string, chrootDir: string): Promise<void> {
    const output = process.stdout;

    for (const [fileName, logsSource] of [
      [SERIAL_LOG_FILE, 'firecracker-serial'],
      [VMM_LOG_FILE, 'firecracker-vmm'],
    ] as const) {
      try {
        const content = await readFile(join(chrootDir, fileName), 'utf-8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          forwardLine(line, vmId, output, undefined, logsSource);
        }
      } catch {
        // File may not exist
      }
    }
  }
}
