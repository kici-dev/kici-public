/**
 * Standalone orphan reaper: rebuilds scaler backends from a ScalerConfig and
 * runs their orphan cleanup WITHOUT a running orchestrator and (for
 * Firecracker) WITHOUT a database — an InMemoryIpAllocator stands in for the
 * DbIpAllocator, as in worker mode. Used by `kici-admin scaler reap-orphans`
 * and the startup disk-space guard to recover a node whose full data disk
 * keeps the orchestrator from starting.
 *
 * Writes nothing to disk; it returns counts. removeChrootDir chowns-before-rm on
 * rootless (requireSudo) nodes, so the reap frees disk owned by the jailer subuid.
 */
import { FirecrackerScalerBackend } from './firecracker-backend.js';
import { ContainerScalerBackend } from './container-backend.js';
import { InMemoryIpAllocator } from './ip-allocator.js';
import type { ScalerConfig } from './index.js';

/** Keyed by scaler name. */
export type ReapCounts = Record<string, number>;

/**
 * Reap dead-VM chroots and TAPs for every `firecracker` scaler. Safe alongside
 * a live orchestrator: the reap is liveness-driven and only touches dead VMs.
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
 * Unlike the FC reap, container cleanup removes every kici-managed container,
 * so callers MUST ensure the orchestrator is NOT running, or live agents are
 * killed. The CLI command enforces this via the /health gate.
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
 * Firecracker is always reaped (liveness-driven, safe); containers only when
 * includeContainers is set (the caller confirmed the orchestrator is down).
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
