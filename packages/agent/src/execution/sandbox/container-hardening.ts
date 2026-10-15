/**
 * Container sandbox hardening posture: the dockerode `HostConfig` fragment
 * (plus an optional top-level `User`) applied to every per-job container. It
 * matches the bare-metal bwrap sandbox (`fork-runner.ts`: rootless, read-only
 * system tree, private dev/proc/tmp, namespace isolation) and adds cgroup
 * resource caps, which bwrap (a namespace tool) cannot set.
 *
 * The default ("hardened") posture:
 * - `CapDrop: ['ALL']`, with no default add-back.
 * - `SecurityOpt: ['no-new-privileges']`: no privilege gain via setuid
 *   binaries, matching bwrap's `--new-session`.
 * - `PidsLimit` / `Memory` / `NanoCpus`: cgroup caps against fork-bomb,
 *   memory and CPU DoS on the host.
 * - `Tmpfs` on `/tmp`: private and non-persistent (bwrap's `--tmpfs /tmp`).
 * - `User`: the image's user unless explicitly overridden; a root image is
 *   never silently rewritten (bwrap runs as the unprivileged invoker uid by
 *   construction, so parity is best-effort).
 * - `ReadonlyRootfs`: opt-in only, because many images write outside
 *   /workspace (npm cache, /home, tool state).
 * - `NetworkMode`: `none` for the isolated posture (bwrap's `--unshare-net`),
 *   the default bridge otherwise.
 *
 * The `grant` is the per-job escape hatch the orchestrator resolves and
 * allow-lists at dispatch, the single enforcement point; this builder reads no
 * allow-list. It applies strictly on top of the baseline: capabilities become
 * `CapAdd` while `CapDrop: ['ALL']` still applies, and a grant may switch the
 * network to `host` or set a user / read-only rootfs. `hardened: false` (the
 * documented-temporary `KICI_SANDBOX_HARDENED` rollback) emits an empty posture.
 */

import type Docker from 'dockerode';
import type { ResolvedSandboxGrant, SandboxNetworkMode } from '@kici-dev/engine';

export type { ResolvedSandboxGrant, SandboxNetworkMode };

/** Resolved from agent config + dispatch. */
export interface SandboxHardeningOptions {
  /** False (`KICI_SANDBOX_HARDENED=false` rollback) emits an empty posture. On by default. */
  hardened: boolean;
  /** Opt-in read-only rootfs (config `KICI_SANDBOX_READONLY_ROOTFS`). */
  readonlyRootfs: boolean;
  /** Explicit user override (config `KICI_SANDBOX_USER`); honors the image user when unset. */
  user?: string;
  pidsLimit: number;
  /** Bytes. */
  memoryBytes: number;
  /** CPU cap in nano-CPUs (1 CPU = 1_000_000_000). */
  nanoCpus: number;
  /** Config-derived network posture (`isolated` → `none`, else `default`). */
  networkMode: SandboxNetworkMode;
  /**
   * The agent's `kici-jobs` bridge, joined instead of the runtime's default so
   * per-container egress rules key on the container IP
   * (`KICI_SANDBOX_NETWORK_ISOLATION`). Applies only to the `default` network.
   */
  jobNetworkName?: string;
  grant?: ResolvedSandboxGrant;
}

/** A HostConfig fragment merged into createContainer, plus an optional top-level User. */
export interface ContainerHardening {
  hostConfig: Partial<Docker.HostConfig>;
  user?: string;
}

/** Add-backs come only from an allow-listed grant. */
const CAP_DROP_ALL = ['ALL'] as const;
const NO_NEW_PRIVILEGES = ['no-new-privileges'] as const;

/** Default cgroup caps, overridable via scaler `resources`. */
export const DEFAULT_PIDS_LIMIT = 512;
export const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const DEFAULT_NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs

/** Pure: returns the fields the container sandbox merges into `docker.createContainer`. */
export function buildContainerHardening(opts: SandboxHardeningOptions): ContainerHardening {
  if (!opts.hardened) {
    return { hostConfig: {} };
  }

  const grant = opts.grant;

  const hostConfig: Partial<Docker.HostConfig> = {
    CapDrop: [...CAP_DROP_ALL],
    SecurityOpt: [...NO_NEW_PRIVILEGES],
    PidsLimit: opts.pidsLimit,
    Memory: opts.memoryBytes,
    // MemorySwap = Memory bounds RAM+swap; the runtime default (2x Memory) lets a
    // job spill an equal amount into swap, defeating the memory-DoS bound.
    MemorySwap: opts.memoryBytes,
    NanoCpus: opts.nanoCpus,
    // Explicit options: docker defaults an empty-option tmpfs to `noexec` and
    // podman does not, so a job that execs from /tmp (npm/pnpm install scripts,
    // staged binaries) would fail `Permission denied` only under docker. `exec`
    // matches podman + bwrap; `nosuid,nodev` keep the hardening.
    Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev' },
  };

  // Additive on top of CapDrop: ALL, never a re-grant of the default set.
  if (grant?.capabilities && grant.capabilities.length > 0) {
    hostConfig.CapAdd = [...grant.capabilities];
  }

  const readonlyRootfs = grant?.readonlyRootfs ?? opts.readonlyRootfs;
  if (readonlyRootfs) {
    hostConfig.ReadonlyRootfs = true;
  }

  // A grant network wins over the config-derived mode.
  const network = grant?.network ?? opts.networkMode;
  if (network === 'none') {
    hostConfig.NetworkMode = 'none';
  } else if (network === 'host') {
    hostConfig.NetworkMode = 'host';
  } else if (opts.jobNetworkName) {
    // A predictable IP for the egress rules; the runtime's default bridge
    // reaches the host private network and 169.254.169.254.
    hostConfig.NetworkMode = opts.jobNetworkName;
  }
  // 'default' with no job network: the runtime's default bridge (egress
  // filtering off).

  // A grant user wins over the config override; neither keeps the image user.
  const user = grant?.user ?? opts.user;

  return user ? { hostConfig, user } : { hostConfig };
}
