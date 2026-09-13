/**
 * Standalone orphan reaper.
 *
 * Reconstructs scaler backends from a loaded ScalerConfig and runs their
 * liveness-driven orphan cleanup WITHOUT a running orchestrator and (for
 * Firecracker) WITHOUT a database — an InMemoryIpAllocator stands in for the
 * coordinator's DbIpAllocator, exactly as worker mode does. Used by the
 * `kici-admin scaler reap-orphans` command and by the startup disk-space guard
 * to recover a node whose data disk is full and whose orchestrator therefore
 * cannot start.
 *
 * Writes nothing to disk: progress is the caller's concern (counts are
 * returned). removeChrootDir already chowns-before-rm on rootless (requireSudo)
 * nodes, so the reap frees disk owned by the jailer subuid.
 */
import { FirecrackerScalerBackend } from './firecracker-backend.js';
import { ContainerScalerBackend } from './container-backend.js';
import { InMemoryIpAllocator } from './ip-allocator.js';
import type { ScalerConfig } from './index.js';

/** Per-scaler orphan counts, keyed by scaler name. */
export type ReapCounts = Record<string, number>;

/**
 * Reap orphan Firecracker resources (dead-VM chroots + TAPs) for every
 * `firecracker` scaler in the config. Safe to run alongside a live
 * orchestrator: the reap is liveness-driven and only touches dead VMs.
 */
export async function reapFirecrackerOrphans(scalerConfig: ScalerConfig): Promise<ReapCounts> {
  const counts: ReapCounts = {};
  const fcNet = scalerConfig.firecracker;
  const cidr = fcNet?.cidr ?? '10.0.0.0/24';
  const bridgeName = fcNet?.bridgeName ?? 'kici-br0';
  const gateway = fcNet?.gateway ?? '10.0.0.1';
  const netmask = fcNet?.netmask ?? '255.255.255.0';
  const table = fcNet?.table ?? 'kici';

  for (const s of scalerConfig.scalers) {
    if (s.type !== 'firecracker') continue;
    const backend = new FirecrackerScalerBackend({
      name: s.name,
      labelSets: s.labelSets,
      maxAgents: s.maxAgents,
      ipAllocator: new InMemoryIpAllocator({ cidr, gateway, netmask }),
      firecrackerPath: s.firecrackerPath!,
      jailerPath: s.jailerPath!,
      kernelPath: s.kernelPath!,
      chrootBaseDir: s.chrootBaseDir,
      uid: s.uid!,
      gid: s.gid!,
      vcpuCount: s.vcpuCount,
      memSizeMib: s.memSizeMib,
      bridgeName,
      cidr,
      gateway,
      netmask,
      table,
      roles: s.roles,
      requireSudo: s.requireSudo,
    });
    counts[s.name] = await backend.cleanupOrphans();
  }
  return counts;
}

/**
 * Reap orphan container resources for every `container` scaler. Unlike the FC
 * reap, container cleanup is unconditional (it removes every kici-managed
 * container), so callers MUST ensure the orchestrator is NOT running before
 * invoking this — otherwise live agents are killed. The CLI command enforces
 * this via the /health gate.
 */
export async function reapContainerOrphans(scalerConfig: ScalerConfig): Promise<ReapCounts> {
  const counts: ReapCounts = {};
  for (const s of scalerConfig.scalers) {
    if (s.type !== 'container') continue;
    const backend = await ContainerScalerBackend.create({
      name: s.name,
      labelSets: s.labelSets,
      maxAgents: s.maxAgents,
      host: s.host,
      socketPath: s.socketPath,
      runtime: s.runtime,
    });
    counts[s.name] = await backend.cleanupOrphans();
  }
  return counts;
}

/**
 * Reap orphans for all supported backends. Firecracker is always reaped
 * (liveness-driven, safe). Containers are reaped only when includeContainers
 * is set (caller has confirmed the orchestrator is down).
 */
export async function reapAllOrphans(opts: {
  scalerConfig: ScalerConfig;
  includeContainers: boolean;
}): Promise<ReapCounts> {
  const fc = await reapFirecrackerOrphans(opts.scalerConfig);
  if (!opts.includeContainers) return fc;
  const ct = await reapContainerOrphans(opts.scalerConfig);
  return { ...fc, ...ct };
}
