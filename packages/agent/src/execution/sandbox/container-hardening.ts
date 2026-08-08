/**
 * Container sandbox hardening posture builder.
 *
 * A pure function that produces the dockerode `HostConfig` fragment (plus an
 * optional top-level `User`) applied to every per-job container sandbox. It
 * brings the container backend to parity with the bare-metal bwrap sandbox
 * (`fork-runner.ts`) — which runs rootless, with a read-only system tree,
 * private dev/proc/tmp, and namespace isolation — and exceeds it with cgroup
 * resource caps that bwrap (a namespace tool, not a cgroup tool) cannot set.
 *
 * The default posture ("hardened"):
 * - `CapDrop: ['ALL']` — drop every Linux capability (no default add-back).
 * - `SecurityOpt: ['no-new-privileges']` — a step can never gain privileges via
 *   setuid binaries, matching bwrap's `--new-session` lifecycle posture.
 * - `PidsLimit` / `Memory` / `NanoCpus` — cgroup caps bounding fork-bomb, memory
 *   and CPU DoS against the host.
 * - `Tmpfs: { '/tmp': '' }` — a private, non-persistent /tmp (mirrors bwrap's
 *   `--tmpfs /tmp`).
 * - `User` — honored as configured on the image; an explicit override sets it,
 *   but a root image is never silently rewritten (parity is best-effort here:
 *   bwrap runs as the unprivileged invoker uid by construction).
 * - `ReadonlyRootfs` — OPT-IN only (many images write outside /workspace: npm
 *   cache, /home, tool state), enabled via the resolved `readonlyRootfs` input.
 * - `NetworkMode` — `none` for the isolated network posture (bwrap's
 *   `--unshare-net`); the default (bridge) otherwise.
 *
 * The `grant` input is the dispatch-resolved per-job escape hatch (allow-listed
 * orchestrator-side). It is honored strictly additively on top of the hardened
 * baseline: requested capabilities become `CapAdd` entries while `CapDrop:
 * ['ALL']` still applies, and a grant may switch the network to `host` or set
 * an explicit user / read-only rootfs. The builder never reads an allow-list —
 * it applies whatever grant dispatch already resolved (single enforcement
 * point). When `hardened` is false (the documented-temporary
 * `KICI_SANDBOX_HARDENED` rollback affordance), the builder emits an empty
 * posture, reproducing the unhardened container behavior.
 */

import type Docker from 'dockerode';
import type { ResolvedSandboxGrant, SandboxNetworkMode } from '@kici-dev/engine';

export type { ResolvedSandboxGrant, SandboxNetworkMode };

/** Inputs to the hardening builder, already resolved from agent config + dispatch. */
export interface SandboxHardeningOptions {
  /**
   * Master switch. When false (the `KICI_SANDBOX_HARDENED=false` rollback
   * affordance) the builder emits an empty posture — the legacy unhardened
   * container behavior. Defaults are ON in the shipping config.
   */
  hardened: boolean;
  /** Opt-in read-only rootfs (config `KICI_SANDBOX_READONLY_ROOTFS`). */
  readonlyRootfs: boolean;
  /** Explicit user override (config `KICI_SANDBOX_USER`); honors the image user when unset. */
  user?: string;
  /** Max PIDs in the container cgroup. */
  pidsLimit: number;
  /** Memory cap in bytes for the container cgroup. */
  memoryBytes: number;
  /** CPU cap in nano-CPUs (1 CPU = 1_000_000_000). */
  nanoCpus: number;
  /** Config-derived network posture (`isolated` → `none`, else `default`). */
  networkMode: SandboxNetworkMode;
  /** Optional dispatch-resolved escape hatch (Sub-wish B populates this at dispatch). */
  grant?: ResolvedSandboxGrant;
}

/** The builder output: a HostConfig fragment merged into createContainer, plus an optional top-level User. */
export interface ContainerHardening {
  hostConfig: Partial<Docker.HostConfig>;
  user?: string;
}

/** Drop every Linux capability. Add-backs come only from an allow-listed grant. */
const CAP_DROP_ALL = ['ALL'] as const;
/** Prevent privilege escalation via setuid binaries (bwrap `--new-session` parity). */
const NO_NEW_PRIVILEGES = ['no-new-privileges'] as const;

/** Default cgroup caps — operator-visible constants, overridable via scaler `resources`. */
export const DEFAULT_PIDS_LIMIT = 512;
export const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const DEFAULT_NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs

/**
 * Build the hardened HostConfig fragment for a job sandbox container.
 *
 * Pure and side-effect-free: given resolved inputs it returns the fields the
 * container-sandbox merges into `docker.createContainer`. When `hardened` is
 * false it returns an empty posture (the rollback affordance).
 */
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
    // Match MemorySwap to Memory so the cap bounds total RAM+swap — otherwise
    // the runtime defaults MemorySwap to 2x Memory and a job can spill an equal
    // amount into swap, defeating the memory-DoS bound.
    MemorySwap: opts.memoryBytes,
    NanoCpus: opts.nanoCpus,
    // A private, non-persistent /tmp (mirrors bwrap's `--tmpfs /tmp`). The mount
    // options are set EXPLICITLY rather than left empty: docker defaults an
    // empty-option tmpfs to `noexec`, while podman does not, so an empty value
    // silently diverges the two runtimes — a job that execs from /tmp (npm/pnpm
    // install scripts, tools that stage a binary there) runs under podman but
    // fails `Permission denied` under docker. `exec` allows that legitimate
    // execution (matching the already-shipping podman + bwrap posture) while
    // `nosuid,nodev` retain the security hardening.
    Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev' },
  };

  // Grant capabilities are added back on top of CapDrop: ALL (additive, never
  // a re-grant of the whole default set).
  if (grant?.capabilities && grant.capabilities.length > 0) {
    hostConfig.CapAdd = [...grant.capabilities];
  }

  // Read-only rootfs is opt-in via config or an explicit grant.
  const readonlyRootfs = grant?.readonlyRootfs ?? opts.readonlyRootfs;
  if (readonlyRootfs) {
    hostConfig.ReadonlyRootfs = true;
  }

  // Effective network: a grant network wins over the config-derived mode.
  const network = grant?.network ?? opts.networkMode;
  if (network === 'none') {
    hostConfig.NetworkMode = 'none';
  } else if (network === 'host') {
    hostConfig.NetworkMode = 'host';
  }
  // 'default' leaves NetworkMode unset (the runtime's default bridge).

  // User: an explicit grant user wins over the config override; neither set
  // means the image's configured user is honored (never silently rewritten).
  const user = grant?.user ?? opts.user;

  return user ? { hostConfig, user } : { hostConfig };
}
