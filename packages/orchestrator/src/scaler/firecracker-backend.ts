/**
 * Firecracker scaler backend implementation.
 *
 * Manages ephemeral agent microVMs using the Firecracker VMM via the jailer.
 * Handles full VM lifecycle: prepare chroot, hardlink rootfs+kernel, create overlay drive,
 * invoke jailer, inject MMDS metadata, and destroy with cleanup.
 *
 * Log capture: Firecracker backend handles log forwarding internally.
 * The jailer is spawned as a non-daemonized detached child with stdout redirected to a
 * serial console log file and VMM logs captured via --log-path. Both files are tailed
 * using fs.watchFile() and forwarded with distinct logsSource tags ('firecracker-serial',
 * 'firecracker-vmm'). The serial-console path is best-effort only: Firecracker's Rust
 * BufWriter around stdout + jailer's uid drop make sparse userspace writes unreliable,
 * so it's treated as defense-in-depth. The canonical agent log path is WS agent.log
 * (attached unconditionally by the agent; see packages/agent/src/server.ts step 6).
 *
 * Follows the Docker backend pattern closely for consistency.
 */

import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import {
  open,
  link,
  copyFile,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  readlink,
  stat,
} from 'node:fs/promises';
import { openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { KICI_AGENT_ENV_PREFIX, scalerAgentLabels, ScalerBackendType } from '@kici-dev/engine';
import { createLogger, toErrorMessage, type ToolRequirement } from '@kici-dev/shared';
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
import { tailFile } from './file-tail.js';
import { forwardLine } from './log-forwarder.js';
import { ScalerEventType } from './types.js';
import { generateTapName } from './ip-allocator.js';
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

const execFileAsync = promisify(execFile);

const logger = createLogger({ prefix: 'firecracker-backend' });

/**
 * Unit of `/proc/<pid>/stat` field 22 (starttime). Linux fixes USER_HZ at 100
 * on every architecture this runs on and exposes no way to read it from Node,
 * so the conversion is only ever used to compare orders of magnitude apart
 * timestamps — see {@link PID_START_SLACK_MS}.
 */
const USER_HZ = 100;

/**
 * Slack allowed between a process's start time and the mtime of the PID file
 * that names it. The jailer writes the file after forking, so the file is
 * normally the newer of the two; the slack only absorbs clock granularity and
 * a slow write. A process that started well after the file cannot be the one
 * the file names.
 */
const PID_START_SLACK_MS = 60_000;

/** Log file names within the jailer chroot directory */
const SERIAL_LOG_FILE = 'serial-console.log';
const VMM_LOG_FILE = 'vmm.log';

/**
 * Maximum total bytes allowed for forwarded env vars in a single VM's MMDS payload.
 *
 * Firecracker's default MMDS data store cap is ~51 KiB shared across every metadata
 * field for that VM. The other static fields (URL, agent ID, labels, token, gateway,
 * backpressure) total well under 1 KiB, so 32 KiB is a generous-but-safe budget for
 * operator-defined env vars. Vars exceeding the remaining budget are skipped with a
 * warning rather than silently triggering an opaque MMDS PUT failure mid-spawn.
 */
const MMDS_FORWARDED_ENV_BUDGET_BYTES = 32 * 1024;

/** POSIX shell-safe env var name pattern. Reject anything else to avoid MMDS path injection. */
const POSIX_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Interface-name pattern for per-VM TAP devices.
 * Matches what {@link generateTapName} produces — `kici-` plus the LAST 8
 * characters of the VM id, which for a scaler-minted id is 8 lowercase hex.
 */
const VM_TAP_PATTERN = /^kici-[0-9a-f]{8}$/;

/**
 * Infrastructure interfaces that share the `kici-` prefix but must NEVER be
 * deleted by the orphan sweep. Bridges (kici-br0/kici-br1) carry all VM
 * traffic; kici-m01 is the staging metadata interface. Losing any of these
 * kills all running VMs.
 */
export const PROTECTED_INTERFACES: readonly string[] = ['kici-br0', 'kici-br1', 'kici-m01'];

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
   * The `hostAccess` policy resolved for this VM at provision time.
   *
   * Carried on the record because a bridge self-heal re-applies isolation for
   * every live VM, and that path has no `orchestratorUrl` to re-derive the
   * default from.
   */
  hostAccess?: string[];
}

export interface FirecrackerScalerBackendOptions {
  /** Human-readable name for this scaler */
  name: string;
  /** Label sets this backend can provision */
  labelSets: LabelSetConfig[];
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Shared IP allocator instance */
  ipAllocator: IpAllocator;
  /**
   * Extra `hostAccess` entries the orchestrator itself directed agents at —
   * today its object-storage endpoint. Folded into the agent default so the
   * narrowing does not cut off a host-local object store.
   */
  hostServices?: string[];
  /** Path to firecracker binary */
  firecrackerPath: string;
  /** Path to jailer binary */
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
  /** Netmask for guest networking */
  netmask: string;
  /** nft table name for host-network diagnostics. @default 'kici' */
  table?: string;
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
   * Wrap privileged commands (`ip`, `chown`) with `sudo -n`. Required when the
   * orchestrator runs as a non-root user (e.g. user-mode systemd on edge worker
   * nodes) and operators have set up a sudoers NOPASSWD rule for those binaries.
   * On hosts where the orchestrator already runs as root, leave this false.
   * @default false
   */
  requireSudo?: boolean;
  /**
   * When true, `ensureHostReady()` verifies and provisions this host bridge on
   * startup (self-heal). Threaded from `firecracker.autoProvisionHost`. When
   * false the method is a no-op. @default false (cores pass the real value)
   */
  autoProvisionHost?: boolean;
  /** Injectable bridge verifier (tests). @default host-network verifyBridge */
  verifyBridgeFn?: (cfg: FirecrackerBridgeConfig, opts: ExecOptions) => Promise<BridgeHealth>;
  /** Injectable bridge provisioner (tests). @default host-network provisionBridge */
  provisionBridgeFn?: (cfg: FirecrackerBridgeConfig, opts: ExecOptions) => Promise<void>;
}

/**
 * What a VM's PID file, cross-checked against `/proc`, says about the process
 * it names.
 *
 * A bare `parseInt` of the file is not an identity: the PID file outlives the
 * process it names, and Linux recycles PID numbers. Acting on the raw number
 * means `destroy` and `reapUnowned` can `SIGKILL` an unrelated host process
 * (the orchestrator runs as root or under `sudo -n` on these hosts), and a
 * liveness check can call a long-dead VM live forever, so no sweep ever
 * reclaims its chroot or its IP.
 *
 * The states stay distinct because two callers ask opposite questions of them. `gone` and `recycled` both mean the VM that wrote the file is over.
 * `running` means a process with that number is on the host right now, and
 * `identityConfirmed` says whether it is provably this VM's own firecracker —
 * which decides whether that process may be signalled, not whether it exists.
 */
type VmPidProbe =
  | { state: 'gone' }
  | { state: 'recycled'; pid: number }
  | { state: 'running'; pid: number; identityConfirmed: true }
  | { state: 'running'; pid: number; identityConfirmed: false; detail: string };

export class FirecrackerScalerBackend implements ScalerBackend {
  readonly type = ScalerBackendType.enum.firecracker;
  readonly spawnsOnLocalHost = true;
  maxAgents: number;

  // Firecracker uses two logsSource values (firecracker-serial, firecracker-vmm),
  // but the getter returns a general identifier for the ScalerBackend interface.
  // The actual per-stream tagging is handled inside the internal forwarding loops.
  readonly logsSource = 'firecracker-serial';

  /** AbortControllers for file tailing per managed VM (keyed by agent ID) */
  private readonly tailAbortControllers = new Map<string, AbortController>();

  /**
   * Per-spawn `scaler.failed` emitters, keyed by agent id.
   *
   * The jailer's `exit` handler and the spawn-deadline abort both fire outside
   * `spawn`'s own scope, and the manager releases a spawn reservation only on a
   * failure event. Holding the emitter here is what lets those two paths report
   * the failure instead of leaving the reservation held until restart.
   */
  private readonly spawnFailureHandlers = new Map<string, (reason: string) => void>();

  private _labelSets: LabelSetConfig[];
  private readonly name: string;
  private readonly ipAllocator: IpAllocator;
  private readonly firecrackerPath: string;
  private readonly jailerPath: string;
  private readonly kernelPath: string;
  private readonly chrootBaseDir: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly vcpuCount: number;
  private readonly memSizeMib: number;
  private readonly bridgeName: string;
  private readonly cidr: string | undefined;
  private readonly gateway: string;
  /** Host services the orchestrator directed agents at, as `hostAccess` entries. */
  private readonly hostServices?: string[];
  private readonly netmask: string;
  private readonly table: string;
  private readonly tokenStore?: AgentTokenStore;
  private readonly tokenTtlMs: number;
  private readonly tokenTtlProvider?: () => Promise<number>;
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

  constructor(options: FirecrackerScalerBackendOptions) {
    this.name = options.name;
    this._labelSets = options.labelSets;
    this.maxAgents = options.maxAgents;
    this.ipAllocator = options.ipAllocator;
    this.firecrackerPath = options.firecrackerPath;
    this.jailerPath = options.jailerPath;
    this.kernelPath = options.kernelPath;
    this.chrootBaseDir = options.chrootBaseDir ?? '/srv/jailer';
    this.uid = options.uid;
    this.gid = options.gid;
    this.vcpuCount = options.vcpuCount ?? 2;
    this.memSizeMib = options.memSizeMib ?? 512;
    this.bridgeName = options.bridgeName;
    this.cidr = options.cidr;
    this.gateway = options.gateway;
    this.hostServices = options.hostServices;
    this.netmask = options.netmask;
    this.table = options.table ?? 'kici';
    this.tokenStore = options.tokenStore;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000; // 1 hour default
    this.tokenTtlProvider = options.tokenTtlProvider;
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
      reason: `required by firecracker scaler "${name}" for overlay drive creation`,
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

    // The ScalerManager's spawn deadline aborts this signal and then forgets
    // the agent. Without a listener the backend's own tracking entry — set
    // above, before any I/O — survives forever: `getActiveCount()` keeps
    // counting it, so `maxAgents` such timeouts wedge the scaler at capacity
    // with zero live VMs, and every sweep skips its IP, TAP and chroot because
    // `trackedVmIds` still names it.
    const onSpawnAbort = () => {
      void this.abandonSpawn(agentId, alloc, 'spawn aborted (deadline or shutdown)');
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
      // `isolated on` is the entire VM-to-VM boundary. Every VM's TAP hangs off
      // one bridge on one subnet, so traffic between two tenants' VMs is
      // switched at L2 and never enters the IP forward hook — no nft rule can
      // see it, and the RFC1918 drop that exists to stop exactly this never
      // evaluates. An isolated port may still forward to the bridge itself, so
      // VM → gateway → NAT → internet is unaffected; it may not forward to
      // another isolated port, which is precisely the boundary.
      await this.execAsync('ip', ['link', 'set', alloc.tapDevice, 'master', this.bridgeName]);
      // Two commands, not one. The combined form —
      // `ip link set <tap> master <br> type bridge_slave isolated on` — is
      // rejected with `RTNETLINK answers: Operation not supported` on kernels
      // that support the flag perfectly well when it is set after the port is
      // already a bridge member. Setting it separately works everywhere the
      // combined form does, so there is no reason to prefer the one-shot.
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
      //     IP. The TAP is enslaved to the bridge, so L3-forwarded traffic
      //     enters the forward hook with iifname = the BRIDGE device — an
      //     iifname rule naming the TAP never matches forwarded packets,
      //     which would leave the VM's isolation (and any networkPolicy
      //     allowlist) ineffective. saddr matches the routed packet exactly.
      //     When the orchestrator runs as a non-root user (edge worker), nft
      //     itself goes through sudo -n.
      const nftOpts = this.nftOpts();
      await ensureKiciTable({ ...nftOpts, requireBaselineChain: true });
      // Pre-clean before re-adding: rules are removed only on the synchronous
      // teardown paths this process drives, so a crash, a `kill -9`, or a VM
      // that died while the orchestrator was down can leave this IP's rules
      // behind. The allocator recycles IPs, so without this the new tenant
      // inherits the dead job's allowlist. Idempotent and cheap.
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
      const overlayMib = matchedLabelSet.overlayDriveSizeMib ?? 2048;
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
      // the chroot to the jailer uid/gid. We open them here while the orchestrator
      // process still owns the files; the kernel doesn't re-check perms on each
      // write to an already-open FD, so writes from the jailer child (after privilege
      // drop) continue to work even though the file is now owned by uid 10000.
      // This matters when the orchestrator runs as a non-root user (e.g. user-mode
      // systemd on edge worker nodes) — there, opening the file *after* chown would
      // fail with EACCES because the orchestrator no longer owns it.
      const stdoutFd = openSync(serialLogPath, 'w');
      const stderrFd = openSync(serialLogPath, 'a'); // stderr also goes to serial log file

      // 11c. chown the entire VM directory to the jailer UID/GID.
      // The jailer drops privileges to uid:gid before exec'ing Firecracker,
      // so all files (rootfs, kernel, config, log files) must be owned by the
      // jailer user. Without this, Firecracker fails with "Permission denied"
      // when trying to open --log-path or other files inside the chroot.
      const vmDir = join(this.chrootBaseDir, 'firecracker', agentId);
      await this.execAsync('chown', ['-R', `${this.uid}:${this.gid}`, vmDir]);

      // 11c-bis. Restore source-owner on the hardlinked rootfs.ext4 + kernel.
      // chown -R follows hardlinks (it operates on inodes, not paths), so the
      // recursive chown above also rewrites the OWNER of the source files at
      // matchedLabelSet.rootfsPath / kernelPath. On a non-root orchestrator
      // (Pi worker running as `kici`), the next spawn would then fail to ln
      // those files because fs.protected_hardlinks=1 forbids hardlinking to
      // a file you don't own and don't have write access to. Re-chown the
      // hardlinked entries inside the chroot to the orch process's own uid
      // — since hardlinks share an inode, this restores the source's owner
      // too. Skip when the orch runs as root (uid 0 case): there's no source
      // ownership to restore, and root can hardlink unconditionally anyway.
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

      // 11c. Spawn jailer as detached child (no --daemonize).
      // The child stays alive for the VM lifetime; stdout/stderr go to log files.
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
          // NO --daemonize -- child stays alive for VM lifetime
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

      // 11f. Loosen the chroot dir mode so a non-root orchestrator can traverse
      // it to reach the API socket. Jailer chmods the chroot to 0700 owned by
      // its --uid (10000) right before pivot_root, which locks out the orch
      // process when it isn't running as that user. We chmod back to 0755 from
      // the host side; this only affects the orch's view (the chroot is locked
      // from inside FC's perspective regardless). Only does anything when the
      // backend is in requireSudo mode (root-running orchs already have access).
      // 12. Wait for API socket. When the orch runs as a non-root user
      // (requireSudo mode), keep recursively loosening permissions on the
      // chroot tree in parallel — jailer chmods every new subdir (chroot root
      // and /run) to 0700 owned by uid 10000, which locks out the orch from
      // traversing down to /run/firecracker.socket. We do `chmod -R go+rX`
      // every 100ms so as soon as FC creates /run, our next pass picks it up.
      const socketPath = this.getSocketPath(agentId);
      const api = new FirecrackerApi(socketPath, signal);
      let chmodLoosenInterval: NodeJS.Timeout | undefined;
      if (this.requireSudo) {
        const vmDirHost = join(this.chrootBaseDir, 'firecracker', agentId);
        const chrootHostPath = join(vmDirHost, 'root');
        chmodLoosenInterval = setInterval(() => {
          // Best-effort; ignore errors (the dir may not exist yet on the very
          // first tick, or jailer may still be racing us).
          this.execAsync('chmod', ['-R', 'go+rX', chrootHostPath]).catch(() => {});
        }, 100);
      }
      let ready: boolean;
      try {
        ready = await api.waitForSocket(5000);
      } finally {
        if (chmodLoosenInterval) clearInterval(chmodLoosenInterval);
      }
      if (!ready) {
        throw new Error(`Firecracker API socket not ready within 5s for agent ${agentId}`);
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

      // 13b. Build forwarded env map for the agent (matches bare-metal/container precedence:
      // KICI_AGENT_ENV_* from orchestrator process.env first, then scalers.yaml `env:` overlays).
      // Apply per-VM byte budget so a runaway value can't push the MMDS payload over Firecracker's
      // ~51 KiB cap. Reject keys that aren't POSIX-safe to defend against MMDS path injection.
      const acceptedEnv = this.buildForwardedEnv(matchedLabelSet, agentId);

      // 14. PUT MMDS metadata: orchestrator URL, labels, scaler-managed flag, optional token,
      // optional forwarded env. Labels and agent ID are needed by the agent at startup
      // (before WS connection), since loadConfig() reads KICI_LABELS and KICI_AGENT_ID from
      // environment.
      await api.putMmds({
        latest: {
          'meta-data': {
            'kici-orchestrator-url': orchestratorUrl,
            'kici-agent-id': agentId,
            'kici-labels': fullLabels.join(','),
            'kici-scaler-managed': '1', // Agent skips WS log streaming
            'kici-gateway-ip': this.gateway, // Used by /init for verdaccio.local /etc/hosts entry
            ...(agentToken ? { 'kici-agent-token': agentToken } : {}),
            ...(matchedLabelSet.backpressureMode
              ? { 'kici-backpressure-mode': matchedLabelSet.backpressureMode }
              : {}),
            ...(Object.keys(acceptedEnv).length > 0 ? { 'kici-env': acceptedEnv } : {}),
          },
        },
      });

      emit(ScalerEventType.enum['scaler.ready'], 'microVM booted');

      // 14. Update tracking
      managed.state = 'running';
      managed.backendRef = agentId;

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
   * Verify and (if needed) provision this backend's host bridge on startup.
   * No-op unless autoProvisionHost is set. Throws on a real provision failure;
   * ScalerManager.ensureHostsReady catches per-backend and degrades this scaler.
   */
  /**
   * nft options for this backend's own rules.
   *
   * `table` is the operator-configured one, not the literal `kici`: with two
   * coordinators on one host, coordinator B's baseline goes to `kici_b` while
   * its per-VM rules used to go to `kici` — coordinator A's table. A's next
   * re-provision then swept B's live VMs' isolation along with its own, and B's
   * rules were evaluated against A's subnet-scoped baseline.
   */
  private nftOpts(): { requireSudo: boolean; table: string } {
    return { requireSudo: this.requireSudo, table: this.table };
  }

  async ensureHostReady(): Promise<void> {
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
   * Fail loudly on a kernel that will not honour bridge port isolation.
   *
   * Without the flag every concurrent tenant's VM can reach every other one at
   * L2, and no nft rule sees that traffic — so the isolation the operator docs
   * promise silently does not exist. The same fail-closed posture
   * `validateNftablesAvailability` takes for a missing `nft`: better to refuse
   * to run VMs than to run them unisolated.
   *
   * The probe is an end-to-end one — create a TAP, enslave it isolated, delete
   * it — because the flag can be rejected by the kernel, by iproute2, or by the
   * bridge itself, and only the real command exercises all three.
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
      // Cannot create a TAP at all — a distinct failure the spawn path reports
      // on its own; do not misattribute it to missing isolation support.
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
   * Re-apply per-VM isolation rules for every VM this backend still tracks.
   *
   * Provisioning no longer deletes the table, but it does sweep the `forward`
   * chain of everything no live VM owns, and an old-shaped host carries its
   * baseline there too. Re-applying is what guarantees a self-heal cannot leave
   * a running VM fail-open. Each identifier is removed before it is re-added,
   * so a self-heal that fires twice does not duplicate the rules.
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

  async destroy(managedId: string, _context?: ScalerDestroyContext): Promise<void> {
    // _context (teardown reason) is only meaningful to the event backend.
    const managed = this.agents.get(managedId);
    if (!managed) return;

    managed.state = 'destroying';

    // 0. Stop log tailing
    const abortController = this.tailAbortControllers.get(managedId);
    if (abortController) {
      abortController.abort();
      this.tailAbortControllers.delete(managedId);
    }

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
    if (forceKillPid !== undefined) {
      try {
        process.kill(forceKillPid, 'SIGKILL');
      } catch {
        // ESRCH = process already dead -- expected
      }
    }

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

    // 6. Clean up chroot directory
    try {
      await this.removeChrootDir(managedId);
    } catch {
      // Best effort
    }

    // 6. Remove from tracking
    this.agents.delete(managedId);
    this.spawnFailureHandlers.delete(managedId);
  }

  /**
   * Force-reclaim a VM this backend no longer tracks in memory.
   *
   * `destroy()` opens with `if (!managed) return`, so after an orchestrator
   * restart it silently no-ops while the VM keeps running, holding its RAM and
   * its IP. `cleanupOrphans()` cannot recover that VM either: every one of its
   * three passes skips an id whose jailer process is alive, deliberately, since
   * a live process is the only thing that distinguishes a healthy VM from a
   * leaked one when you are sweeping blind.
   *
   * This is the same reclaim addressed to ONE id whose orphan status the caller
   * already established, so the liveness check is exactly what must not apply.
   * See `ScalerBackend.reapUnowned` for the two properties the caller relies on;
   * the host-local half is enforced here by refusing to act unless the jailer
   * chroot for `managedId` exists on THIS host. That directory is the only
   * host-local artifact a VM leaves: an `ip_allocations` row is not one, because
   * an HA pair is "two identical orchestrators sharing the same PostgreSQL,
   * scalers, and routing key" (`docs/operator/orchestrator/clustering.md`), so a
   * peer's live VM has a row naming this very scaler. The row is read only to
   * finish a reclaim the chroot already authorized.
   */
  async reapUnowned(managedId: string): Promise<boolean> {
    if (this.agents.has(managedId)) {
      // Still tracked, so `destroy()` owns this id and holds the live TAP and
      // IP for it. Reaping underneath it would race its teardown.
      return false;
    }

    const vmDir = join(this.chrootBaseDir, 'firecracker', managedId);
    let hasChroot = false;
    try {
      hasChroot = (await stat(vmDir)).isDirectory();
    } catch {
      // No chroot for this id on this host.
    }
    // THE ONE GATE. Without a chroot here, nothing places this VM on this host,
    // and a shared `ip_allocations` row cannot stand in for one: on an HA pair
    // both coordinators run the same named scalers against one database, so a
    // peer's live VM carries a row that names this scaler. Releasing it would
    // hand its address to the next VM — two guests on one IP, sharing the
    // saddr-keyed isolation rules that are supposed to separate them. The
    // row-without-chroot case needs no reclaim anyway: with no chroot there is
    // no PID file to kill through, and `cleanupOrphans()` Pass 1 already
    // releases such a row (no PID file means `isChrootPidRunning` reads false).
    if (!hasChroot) return false;

    let alloc: IpAllocationRecord | null = null;
    try {
      alloc = await this.ipAllocator.getAllocationForVm(managedId);
    } catch (err) {
      // Best effort: the chroot already authorized the reclaim, and a failed
      // read only costs the IP release, which the next sweep redoes.
      logger.warn('firecracker: allocation lookup failed during orphan reclaim', {
        managedId,
        error: toErrorMessage(err),
      });
    }
    // A second firecracker scaler on this host has its own IP space and its own
    // teardown, so only a row naming THIS scaler is ours to release.
    const ownsAllocation = alloc !== null && alloc.scaler_name === this.name;

    logger.warn('firecracker: reclaiming an unowned VM', {
      managedId,
      ownsAllocation,
    });

    // Forward whatever the serial console and VMM logs still hold before the
    // chroot goes — this is the only record of why the VM was orphaned.
    try {
      await this.forwardRemainingLogs(managedId, this.getChrootDir(managedId));
    } catch {
      // Best effort — the log files may not exist.
    }

    // Kill the jailer process. Unlike `destroy()` there is no graceful
    // SendCtrlAltDel first: the guest is a refused agent with no work in
    // flight, and the API socket belongs to a VM this process never opened.
    const reapPid = await this.readVmPid(managedId);
    if (reapPid !== undefined) {
      try {
        process.kill(reapPid, 'SIGKILL');
      } catch {
        // ESRCH — already dead, which is the outcome we wanted.
      }
    }

    if (alloc !== null && ownsAllocation) {
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
        await this.ipAllocator.release(managedId);
      } catch (err) {
        logger.warn('firecracker: IP release failed during orphan reclaim', {
          managedId,
          error: toErrorMessage(err),
        });
      }
    }

    try {
      await this.removeChrootDir(managedId);
    } catch {
      // Best effort — the next sweep sees it now that the process is dead.
    }

    return true;
  }

  async shutdownAll(): Promise<void> {
    this.stopPeriodicOrphanSweep();
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /**
   * Clear MMDS data for an agent after receiving config.ack via WS.
   * Belt-and-suspenders: even though MMDS only contains orchestrator URL,
   * clearing it reduces the attack surface to zero post-startup.
   *
   * Called by `ScalerManager.onConfigAck`, which reaches it structurally
   * (`'clearAgentMmds' in backend`) rather than through `ScalerBackend` — no
   * other backend has an MMDS to clear.
   *
   * @param agentId - The agent ID whose VM MMDS should be cleared
   */
  async clearAgentMmds(agentId: string): Promise<void> {
    try {
      const socketPath = this.getSocketPath(agentId);
      const api = new FirecrackerApi(socketPath);
      await api.clearMmds();
      // Log at debug level to avoid noise -- this is a belt-and-suspenders measure
    } catch (err) {
      // Non-fatal: belt + suspenders with in-VM iptables blocking
      // Log as debug -- MMDS only contains orchestrator URL (not credentials)
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
   * Clean up orphaned VMs.
   *
   * Safe to call both at startup AND periodically while the backend is active
   * (see startPeriodicOrphanSweep): each pass explicitly skips VMs that are
   * currently tracked in-memory (spawning / running / destroying), and Pass 3
   * re-reads DB allocations after listing host interfaces to close the spawn
   * race (allocate → ip tuntap add is not atomic).
   *
   * Three passes:
   * 1. DB allocations: check if VM process is still running, clean dead ones
   * 2. Filesystem: scan chroot dir for directories not in DB allocations
   * 3. Network: scan host interfaces for orphan TAP devices
   *
   * Returns the count of cleaned orphans.
   */
  async cleanupOrphans(): Promise<number> {
    let cleaned = 0;

    // Snapshot the set of VM IDs currently tracked in-memory. These are
    // spawning, running, or destroying — never touch their resources even
    // if a transient filesystem / process-table state makes them look dead.
    const trackedVmIds = new Set(this.agents.keys());

    // Single PID-liveness pre-scan of the chroot tree. Built once and consumed
    // by all three passes so a standalone reap (empty DB + empty tracking)
    // never deletes a live VM's chroot or TAP. One readdir for the whole method.
    const chrootParent = join(this.chrootBaseDir, 'firecracker');
    let chrootEntries: string[] = [];
    try {
      chrootEntries = await readdir(chrootParent);
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
        // Skip if the VM is currently being spawned or torn down by this
        // backend — the PID file may not exist yet (spawn) or may have
        // just been removed (destroy).
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
      // per-VM naming pattern with no corresponding DB allocation. Covers the
      // case where the orchestrator was SIGKILLed mid-destroy — the `ip link
      // del` in destroy() never ran, and neither the DB nor the chroot dir
      // retains a record (both are cleaned up first in destroy). NetworkManager
      // polls every orphan, so even a handful of leaked TAPs burn CPU (2026-04-14
      // incident: NM main thread wedged for 10 days under TAP churn).
      //
      // Runtime race protection: spawn() does `allocate()` (DB insert) BEFORE
      // `ip tuntap add`, so a TAP on the host is guaranteed to have a matching
      // DB row by the time it exists. But our first DB read could have happened
      // before that insert. Re-read allocations AFTER listing interfaces and
      // skip any TAP present in either snapshot, plus any TAP tracked by an
      // in-memory agent whose DB row may not have landed yet.
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
        // Re-read the DB to catch allocations that landed between our first
        // read and this interface listing.
        let allocatedTapsAfter: Set<string>;
        try {
          const allocationsAfter = await this.ipAllocator.getAllocations();
          allocatedTapsAfter = new Set(allocationsAfter.map((a) => a.tap_device));
        } catch {
          // If the re-read fails, fall back to the pre-read snapshot — the
          // guard narrows, not the cleanup, so the worst case is that we
          // leave a genuine orphan for the next sweep.
          allocatedTapsAfter = allocatedTapsBefore;
        }
        for (const name of ifaceNames) {
          if (!VM_TAP_PATTERN.test(name)) continue;
          if (PROTECTED_INTERFACES.includes(name)) continue;
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

    // Pass 4: nftables rules. Rules are removed only on the synchronous
    // teardown paths this process drives, so an orchestrator crash, a
    // `kill -9`, a VM that died while the orchestrator was down, or a swallowed
    // `removeIsolationRules` failure leaves `ip saddr <ip> …` rules in the
    // shared chain forever. The allocator then hands that IP to another
    // tenant, who inherits the dead job's allowlist — and duplicate drops pile
    // up unboundedly across restarts.
    cleaned += await this.reapUnownedIsolationRules(liveVmIds);

    return cleaned;
  }

  /**
   * Delete isolation rules for every identifier no live VM owns.
   *
   * The live set is the VM ids the passes above established, mapped to the IPs
   * this scaler allocated for them. An identifier the DB does not attribute to
   * a live VM of this scaler is left alone: a second scaler on the same host
   * writes to the same chain, and reaping its rules would cut its running jobs
   * off the network — the mistake this whole sweep exists to stop making.
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
   * Default interval for periodic orphan sweeps (15 minutes).
   *
   * Long-running orchestrators need in-process orphan sweeps because the
   * external kici-leak-sweep timer skips TAP cleanup while a staging
   * orchestrator is active (to avoid racing spawns). Without this, leaked
   * TAPs accumulate until the orchestrator restarts — which can be weeks.
   */
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

  /**
   * Start a periodic orphan sweep. Idempotent — calling twice has no effect
   * beyond the first call. Use stopPeriodicOrphanSweep() to stop.
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
    // Don't block process exit on the timer.
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
   * orchestrator's process.env (prefix stripped) are seeded first, then scalers.yaml
   * `env:` overlays them (yaml wins on conflict).
   *
   * Two safety filters apply:
   * - Keys must match POSIX_ENV_NAME_PATTERN. Otherwise rejected to keep MMDS path
   *   construction safe inside the VM and to prevent the guest from being asked to
   *   `export` something the shell can't represent.
   * - The cumulative byte cost (key + value + 2-byte overhead per entry) must stay
   *   under MMDS_FORWARDED_ENV_BUDGET_BYTES. Once exceeded, remaining entries are
   *   skipped and warnings logged. This protects the ~51 KiB MMDS data store cap
   *   from being blown by an accidentally-huge env value.
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
   * Firecracker requires integer vCPUs and integer MiB. We round CPUs UP via
   * Math.ceil to never under-provision (a 0.5-CPU request still gets a whole vCPU)
   * and floor-divide bytes -> MiB. A debug log is emitted when rounding actually
   * changes the value, so operators can spot frequent fractional requests.
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
   * Create a sparse ext4 overlay drive for per-VM writable layer.
   * The file is sparse (allocates no disk blocks until written) and
   * pre-formatted as ext4 so the guest can mount it immediately.
   */
  private async createOverlayDrive(path: string, sizeMib: number): Promise<void> {
    const fd = await open(path, 'w');
    await fd.truncate(sizeMib * 1024 * 1024);
    await fd.close();
    await this.execAsync('mkfs.ext4', ['-qF', path]);
  }

  /**
   * Promisified execFile wrapper with 30s timeout.
   */
  private async execAsync(
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    // When the orchestrator runs as a non-root user (edge worker nodes), `ip`
    // and `chown` need sudo. The operator must have a NOPASSWD sudoers entry
    // for these binaries; we use `-n` to fail fast if sudo would prompt.
    if (this.requireSudo && (cmd === 'ip' || cmd === 'chown' || cmd === 'chmod')) {
      return execFileAsync('sudo', ['-n', cmd, ...args], { timeout: 30_000 });
    }
    return execFileAsync(cmd, args, { timeout: 30_000 });
  }

  /**
   * Remove a VM's jailer chroot directory.
   *
   * On rootless nodes (requireSudo), the jailer chowns the chroot contents to
   * the jailer uid/gid, leaving the inner directories owned by that uid with
   * mode 0755 — so the orchestrator process (a different, non-root uid) has no
   * write permission on them and a plain `rm` fails with EACCES. destroy() and
   * both cleanupOrphans passes treat removal as best-effort and swallow that
   * failure, so each spawn would otherwise leak a multi-GiB chroot until the
   * data disk fills and the orchestrator crash-loops on ENOSPC (it can no
   * longer write its own files to start, so the in-process orphan sweep never
   * runs to recover). Reclaim ownership via the same sudo-wrapped `chown` path
   * used for `ip` before the `rm` runs as ourselves. On root nodes (requireSudo
   * false) the chown is skipped and `rm` works directly.
   */
  private async removeChrootDir(vmId: string): Promise<void> {
    const dir = join(this.chrootBaseDir, 'firecracker', vmId);
    if (this.requireSudo) {
      // process.getuid/getgid exist on every POSIX host the Firecracker
      // backend runs on; the `?? 0` only satisfies the optional typing.
      const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
      try {
        await this.execAsync('chown', ['-R', owner, dir]);
      } catch {
        // Best effort — a partial chown still lets the rm reclaim every file
        // we already own; a total failure means a sudoers misconfig and the
        // dir stays put for the next sweep (and is now loudly visible).
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Get the API socket path for an agent's Firecracker VM.
   */
  getSocketPath(agentId: string): string {
    return join(this.chrootBaseDir, 'firecracker', agentId, 'root', 'run', 'firecracker.socket');
  }

  /**
   * Get the chroot directory path for an agent.
   */
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
   *     where the jailer pivot_roots — is this VM's chroot when the link is
   *     readable at all. Those carry `identityConfirmed`, not liveness.
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

    // `comm` is parenthesised and may itself contain spaces and parens, so the
    // remaining fields start after the LAST ')' and the first of them is
    // field 3.
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
      return { state: 'running', pid, identityConfirmed: false, detail: `comm="${comm}"` };
    }

    try {
      const procRoot = await readlink(`/proc/${pid}/root`);
      const chrootDir = this.getChrootDir(vmId);
      if (procRoot !== chrootDir) {
        return {
          state: 'running',
          pid,
          identityConfirmed: false,
          detail: `rooted at ${procRoot}, not ${chrootDir}`,
        };
      }
    } catch {
      // EACCES under the jailer's --uid drop, or ESRCH on a race. Not evidence
      // either way, and checks 3 and 4's `comm` already carry the identity.
    }

    return { state: 'running', pid, identityConfirmed: true };
  }

  /**
   * Read a VM's PID file and return the PID only when the process it names is
   * provably still *this* VM's firecracker process.
   *
   * This is the guard for acting ON the process — `destroy` and `reapUnowned`
   * SIGKILL through it — so it fails closed: anything short of a confirmed
   * identity yields `undefined` and nothing is signalled.
   *
   * @returns the PID when it is provably this VM's, otherwise `undefined`
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
   * This is the guard for the orphan reaper, which asks the opposite question
   * from {@link readVmPid} and therefore fails closed in the opposite
   * direction. `readVmPid` refuses to signal a PID it cannot claim; the reaper
   * must refuse to DELETE THE ROOTFS under one. A process whose `comm` or
   * `/proc/<pid>/root` does not match is still a process, and deleting the
   * files it is running out of corrupts whatever it is — while sparing it costs
   * only the disk one chroot occupies.
   *
   * The leak the identity checks exist to prevent is unaffected: a recycled
   * number is detected by start time, which this guard honours, so a chroot
   * whose VM is genuinely over is still reclaimed.
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
   * Whether *this* VM's own firecracker process is still up.
   *
   * Liveness is `readVmPid` plus signal 0, so it answers the identity-bearing
   * question — "is the VM I started still running?" — that
   * {@link waitForProcessExit} needs. Without the identity checks a recycled
   * PID answers signal 0 successfully and the VM is spared forever.
   *
   * The orphan reaper asks a different question and uses
   * {@link isChrootPidRunning} instead: a PID it cannot claim is still a live
   * process, and its rootfs must not be deleted underneath it.
   */
  private async isVmProcessAlive(vmId: string): Promise<boolean> {
    const pid = await this.readVmPid(vmId);
    if (pid === undefined) return false;
    try {
      // signal 0 checks process existence without sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a VM's jailer process to exit within a timeout.
   */
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

  /**
   * Clean up resources after a failed spawn attempt.
   */
  private async cleanupFailedSpawn(
    agentId: string,
    alloc: IpAllocationResult | undefined,
  ): Promise<void> {
    // Drop the tracking entry here rather than at each call site: an entry that
    // outlives its VM is counted by `getActiveCount()` forever and hides the
    // VM's leaked resources from every sweep, and there is no caller that wants
    // to clean up a failed spawn and keep tracking it.
    //
    // Deleting it is also the run-once latch, and that is load-bearing: an
    // aborted spawn is torn down by `abandonSpawn` and then AGAIN by `spawn`'s
    // own catch when the aborted API call rejects. The allocator recycles the
    // released address and TAP name immediately, so the second pass would
    // delete another VM's isolation rules and its TAP by name. `Map.delete`
    // reports whether the key was there, which makes the test-and-clear atomic
    // against the interleaving that produces the race.
    if (!this.agents.delete(agentId)) return;
    this.spawnFailureHandlers.delete(agentId);

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

    // Clean up chroot directory if created
    try {
      await rm(join(this.chrootBaseDir, 'firecracker', agentId), { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  // ── Log tailing & boot failure detection ───────────────────────

  /**
   * Start tailing serial console and VMM log files, forwarding lines directly
   * via forwardLine() with distinct logsSource tags.
   *
   * Also monitors the jailer child process for early exit (boot failure detection).
   * Forwarding is handled internally (not through ScalerManager/AgentLogForwarder)
   * because Firecracker has two distinct log sources per VM.
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
    this.tailAndForward(serialLogPath, agentId, 'firecracker-serial', signal, output);

    // Tail VMM diagnostic log (Firecracker --log-path)
    this.tailAndForward(vmmLogPath, agentId, 'firecracker-vmm', signal, output);

    // Monitor for early jailer exit (boot failure detection)
    child.on('exit', (code, sig) => {
      // Give a small delay for final log lines to be tailed
      setTimeout(() => {
        abortController.abort();
        this.tailAbortControllers.delete(agentId);

        // Emit structured boot failure event if exit was unexpected
        if (code !== 0 && code !== null) {
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
          // Logging the failure is not enough: the tracking entry, the chroot,
          // the TAP, the nft rules and the IP allocation all outlive a jailer
          // that died during boot, and `cleanupOrphans` skips every one of them
          // because `trackedVmIds` still names the VM. Tear it down here and
          // report the failure so the manager releases its reservation.
          void this.abandonSpawn(
            agentId,
            alloc,
            `jailer exited during boot (code ${code}${sig ? `, signal ${sig}` : ''}, ${failureType})`,
          );
        }
      }, 500);
    });
  }

  /**
   * Tail a single log file and forward each line via forwardLine().
   * For serial console lines: non-JSON lines (kernel boot output) are wrapped
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
          // Check if line is JSON (agent structured logs)
          let isJson = false;
          try {
            JSON.parse(line);
            isJson = true;
          } catch {
            // Not JSON -- kernel boot output or other non-structured text
          }

          if (!isJson) {
            // Non-JSON serial line: check for failure patterns
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
      // Log tailing error -- not critical, just log it
      forwardLine(
        JSON.stringify({ level: 'warn', message: `Log tailing error for ${filePath}: ${err}` }),
        agentId,
        output,
        undefined,
        logsSource,
      );
    }
  }

  /**
   * Check if a serial console line matches known boot failure patterns.
   */
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

  /**
   * Read the serial console log file and detect the type of boot failure.
   */
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

  /**
   * Read and forward any remaining log file content for an orphaned/dead VM.
   * Called during cleanupOrphans() before deleting the chroot directory.
   */
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
