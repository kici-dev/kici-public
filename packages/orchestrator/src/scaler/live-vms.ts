/**
 * Live Firecracker VMs on this host, and how the orchestrator relates to each.
 *
 * A Firecracker backend inventories the VMs whose firecracker process is still
 * running under its chroot base (`listLiveVms`); the manager classifies each
 * one against everything on this node that tracks a VM.
 */
import {
  ScalerVmStatus,
  ScalerVmStopOutcome,
  type ScalerLiveVm,
  type ScalerVmStopResult,
  type ScalerVmTracker,
} from '@kici-dev/engine';

/** One running VM a Firecracker backend found under its chroot base. */
export interface LiveVmProbe {
  vmId: string;
  /** The scaler whose chroot base holds the VM. */
  scaler: string;
  pid: number;
  /** When the process started, from `/proc/<pid>/stat`. */
  startedAtMs: number;
  chrootDir: string;
  /** Whether the process is provably this VM's own firecracker. */
  identityConfirmed: boolean;
  /** Why the identity is unconfirmed; set only when `identityConfirmed` is false. */
  detail?: string;
}

/** Why an orphaned VM is listed as one. */
export const ORPHANED_REASON =
  'no in-memory VM, spawning entry, registered agent or active job binding';

/** The Firecracker backend surface the live-VM listing and stop rely on. */
export interface LiveVmBackend {
  listLiveVms(): Promise<LiveVmProbe[]>;
  /** Synchronous: the stop reads it in the same tick as its kill. */
  isTrackingVm(vmId: string): boolean;
  stopUntrackedVm(vmId: string, trackersOf: () => ScalerVmTracker[]): Promise<ScalerVmStopResult>;
  /** Whether this scaler's allocator holds the VM's address. */
  ownsAllocationFor(vmId: string): Promise<boolean>;
}

/**
 * Classify one live VM: tracked by anything wins, then a confirmed identity is
 * an orphan, and a running process that is not provably the VM's firecracker
 * is unverified — listed, but never stopped.
 */
export function classifyLiveVm(
  probe: LiveVmProbe,
  trackers: ScalerVmTracker[],
  nowMs: number = Date.now(),
): ScalerLiveVm {
  const base = {
    vmId: probe.vmId,
    scaler: probe.scaler,
    pid: probe.pid,
    startedAt: new Date(probe.startedAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round((nowMs - probe.startedAtMs) / 1000)),
    chrootDir: probe.chrootDir,
  };
  const trackedBy = [...new Set(trackers)];
  if (trackedBy.length > 0) {
    return {
      ...base,
      status: ScalerVmStatus.enum.tracked,
      trackedBy,
      reason: `tracked: ${trackedBy.join(', ')}`,
    };
  }
  if (probe.identityConfirmed) {
    return { ...base, status: ScalerVmStatus.enum.orphaned, trackedBy, reason: ORPHANED_REASON };
  }
  return {
    ...base,
    status: ScalerVmStatus.enum.unverified,
    trackedBy,
    reason:
      `PID ${probe.pid} is running but is not provably this VM's firecracker ` +
      `(${probe.detail ?? 'unknown'})`,
  };
}

/** A local Firecracker backend under its scaler name. */
export type NamedLiveVmBackend = readonly [name: string, backend: LiveVmBackend];

/**
 * Every live VM across `backends`, classified against `trackersOf`. Two
 * scalers sharing a chroot base both list the same VM; it is reported once.
 */
export async function listClassifiedLiveVms(
  backends: readonly NamedLiveVmBackend[],
  trackersOf: (vmId: string) => ScalerVmTracker[],
): Promise<ScalerLiveVm[]> {
  const seen = new Set<string>();
  const vms: ScalerLiveVm[] = [];
  for (const [, backend] of backends) {
    for (const probe of await backend.listLiveVms()) {
      if (seen.has(probe.chrootDir)) continue;
      seen.add(probe.chrootDir);
      vms.push(classifyLiveVm(probe, trackersOf(probe.vmId)));
    }
  }
  return vms;
}

/**
 * Stop each VM in turn through the backend whose chroot holds it.
 *
 * The backend is the one whose scan lists the VM, preferring the one whose
 * allocator holds its address when two scalers share a chroot base. A VM no
 * scan lists is not running: each backend is asked in turn, so the answer
 * names why (`not-live` for a dead chroot), and `not-found` when no backend
 * holds a chroot for it.
 */
export async function stopLiveVms(
  backends: readonly NamedLiveVmBackend[],
  vmIds: readonly string[],
  trackersOf: (vmId: string) => ScalerVmTracker[],
): Promise<ScalerVmStopResult[]> {
  const listedBy = new Map<string, LiveVmBackend[]>();
  for (const [, backend] of backends) {
    for (const probe of await backend.listLiveVms()) {
      listedBy.set(probe.vmId, [...(listedBy.get(probe.vmId) ?? []), backend]);
    }
  }
  const results: ScalerVmStopResult[] = [];
  for (const vmId of vmIds) {
    const track = (): ScalerVmTracker[] => trackersOf(vmId);
    const holders = listedBy.get(vmId) ?? [];
    if (holders.length > 0) {
      results.push(await (await pickHolder(holders, vmId)).stopUntrackedVm(vmId, track));
      continue;
    }
    results.push(await stopUnlisted(backends, vmId, track));
  }
  return results;
}

async function pickHolder(holders: LiveVmBackend[], vmId: string): Promise<LiveVmBackend> {
  if (holders.length === 1) return holders[0]!;
  for (const holder of holders) {
    if (await holder.ownsAllocationFor(vmId)) return holder;
  }
  return holders[0]!;
}

async function stopUnlisted(
  backends: readonly NamedLiveVmBackend[],
  vmId: string,
  track: () => ScalerVmTracker[],
): Promise<ScalerVmStopResult> {
  let result: ScalerVmStopResult = {
    vmId,
    outcome: ScalerVmStopOutcome.enum['not-found'],
    detail: 'no Firecracker scaler on this node holds a chroot for this VM',
  };
  for (const [, backend] of backends) {
    result = await backend.stopUntrackedVm(vmId, track);
    if (result.outcome !== ScalerVmStopOutcome.enum['not-found']) break;
  }
  return result;
}
