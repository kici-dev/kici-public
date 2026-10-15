/**
 * CIDR IP allocator for Firecracker VM networking.
 *
 * - `DbIpAllocator` persists to PostgreSQL (coordinators), so a long-lived VM
 *   keeps its IP across coordinator restarts.
 * - `InMemoryIpAllocator` has no persistence (worker peers, no cluster DB). A
 *   worker restart starts it empty, and the backend's `cleanupOrphans()`
 *   Pass-2/Pass-3 walk of jailer chroots and host TAPs (on every spawn and in
 *   the leak sweep) reaps the leftovers, so the allocator holds no recovery state.
 *
 * Each orch has its own bridge and subnet (coord A: `kici`, coord B: `kici_b`,
 * Pi worker: `kici-br0`), so allocator state is per-orch; no two orchs share
 * an IP space.
 */

import { createLogger, isPgUniqueViolation } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'ip-allocator' });

/**
 * Bound on consecutive `ip_allocations_pkey` conflict retries in
 * `DbIpAllocator.allocate()`. Above any realistic concurrent-spawn fan-out, so
 * hitting it means pathological contention and throws. Not operator-tunable.
 */
const MAX_ALLOC_CONFLICT_RETRIES = 16;

export interface IpAllocationResult {
  ip: string;
  gateway: string;
  netmask: string;
  /** Deterministic, derived from the IP. */
  mac: string;
  /** TAP device name on the host. */
  tapDevice: string;
}

/** IPv4 addresses are 32-bit unsigned numbers. */
export interface CidrRange {
  networkAddress: number;
  prefixLength: number;
  /** First usable IP (network address + 1). */
  startIp: number;
  /** Last usable IP (broadcast - 1). */
  endIp: number;
}

/** Parse an IPv4 address string to a 32-bit unsigned integer. */
export function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new Error(`Invalid IP address: "${ip}"`);
  }
  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IP address: "${ip}"`);
    }
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

export function numberToIp(n: number): string {
  const unsigned = n >>> 0;
  return [
    (unsigned >>> 24) & 0xff,
    (unsigned >>> 16) & 0xff,
    (unsigned >>> 8) & 0xff,
    unsigned & 0xff,
  ].join('.');
}

/**
 * @example parseCidr('10.0.0.0/24')
 * // => { networkAddress: 167772160, prefixLength: 24, startIp: 167772161, endIp: 167772414 }
 */
export function parseCidr(cidr: string): CidrRange {
  const parts = cidr.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid CIDR notation: "${cidr}"`);
  }

  const ip = parts[0];
  const prefixLength = parseInt(parts[1], 10);

  if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid CIDR prefix length: ${parts[1]}`);
  }

  const networkAddress = ipToNumber(ip);
  const hostBits = 32 - prefixLength;

  const broadcastAddress = (networkAddress | ((1 << hostBits) - 1)) >>> 0;

  const startIp = (networkAddress + 1) >>> 0;
  const endIp = (broadcastAddress - 1) >>> 0;

  return { networkAddress, prefixLength, startIp, endIp };
}

/**
 * Deterministic MAC: the locally-administered unicast prefix 06:00:AC, then the
 * last 3 octets of the IP as hex.
 *
 * @example generateMac('10.0.0.5')  // => '06:00:AC:00:00:05'
 * @example generateMac('10.0.1.42') // => '06:00:AC:00:01:2A'
 */
export function generateMac(ip: string): string {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new Error(`Invalid IP address for MAC generation: "${ip}"`);
  }

  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

  return `06:00:AC:${hex(parseInt(parts[1], 10))}:${hex(parseInt(parts[2], 10))}:${hex(parseInt(parts[3], 10))}`;
}

/**
 * `kici-XXXXXXXX` (13 chars): Linux interface names are limited to 15 (IFNAMSIZ).
 *
 * Uses the LAST 8 chars of the vmId: VM IDs are "scaler-firecracker-XXXXXXXX"
 * with the random suffix at the end, so slice(0, 8) would always be "scaler-f".
 */
export function generateTapName(vmId: string): string {
  return `kici-${vmId.slice(-8)}`;
}

/**
 * Matches the `ip_allocations` table columns so the firecracker-backend's
 * `cleanupOrphans()` reads both impls uniformly.
 */
export interface IpAllocationRecord {
  ip: string;
  vm_id: string;
  scaler_name: string;
  tap_device: string;
  mac_address: string;
}

/**
 * The firecracker-backend depends only on this interface, never on a concrete
 * class, so one backend implementation works in both deploy modes.
 */
export interface IpAllocator {
  allocate(vmId: string, scalerName: string): Promise<IpAllocationResult>;
  release(vmId: string): Promise<void>;
  releaseByIp(ip: string): Promise<void>;
  getAllocations(): Promise<IpAllocationRecord[]>;
  getAllocationForVm(vmId: string): Promise<IpAllocationRecord | null>;
}

/**
 * Return the first IP in the range that is neither the gateway nor allocated.
 * Throws if the range is exhausted.
 */
function findFirstFreeIp(
  range: CidrRange,
  gatewayNum: number,
  isAllocated: (ip: string) => boolean,
): string {
  for (let n = range.startIp; n <= range.endIp; n++) {
    const unsigned = n >>> 0;
    if (unsigned === gatewayNum) continue;
    const candidateIp = numberToIp(unsigned);
    if (isAllocated(candidateIp)) continue;
    return candidateIp;
  }
  throw new Error(
    `IP pool exhausted: no available addresses in ${numberToIp(range.startIp)}-${numberToIp(range.endIp)}`,
  );
}

/** Coordinator allocator; allocations persist in PostgreSQL across restarts. */
export class DbIpAllocator implements IpAllocator {
  private readonly db: Kysely<Database>;
  private readonly range: CidrRange;
  private readonly gateway: string;
  private readonly gatewayNum: number;
  private readonly netmask: string;

  constructor(opts: { db: Kysely<Database>; cidr: string; gateway: string; netmask: string }) {
    this.db = opts.db;
    this.range = parseCidr(opts.cidr);
    this.gateway = opts.gateway;
    this.gatewayNum = ipToNumber(opts.gateway);
    this.netmask = opts.netmask;
  }

  async allocate(vmId: string, scalerName: string): Promise<IpAllocationResult> {
    // Loop-invariant: the TAP name derives only from vmId (the MAC is per-IP).
    const tapDevice = generateTapName(vmId);

    for (let attempt = 1; attempt <= MAX_ALLOC_CONFLICT_RETRIES; attempt++) {
      // Re-read every attempt: on a retry the winner's IP is now in the set,
      // so findFirstFreeIp picks the next genuinely-free address.
      const allocations = await this.db.selectFrom('ip_allocations').select('ip').execute();
      const allocatedSet = new Set(allocations.map((a) => a.ip));

      const candidateIp = findFirstFreeIp(this.range, this.gatewayNum, (ip) =>
        allocatedSet.has(ip),
      );
      const mac = generateMac(candidateIp);

      try {
        await this.db
          .insertInto('ip_allocations')
          .values({
            ip: candidateIp,
            vm_id: vmId,
            scaler_name: scalerName,
            tap_device: tapDevice,
            mac_address: mac,
          })
          .execute();

        return { ip: candidateIp, gateway: this.gateway, netmask: this.netmask, mac, tapDevice };
      } catch (err) {
        // A concurrent spawn won this IP between SELECT and INSERT: re-pick.
        if (isPgUniqueViolation(err, 'ip_allocations_pkey')) {
          logger.debug(
            `IP ${candidateIp} lost concurrent-allocation race ` +
              `(attempt ${attempt}/${MAX_ALLOC_CONFLICT_RETRIES}); re-picking`,
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `IP allocation failed: ${MAX_ALLOC_CONFLICT_RETRIES} consecutive ip_allocations_pkey ` +
        `conflicts (heavy concurrent allocation contention)`,
    );
  }

  async release(vmId: string): Promise<void> {
    await this.db.deleteFrom('ip_allocations').where('vm_id', '=', vmId).execute();
  }

  async releaseByIp(ip: string): Promise<void> {
    await this.db.deleteFrom('ip_allocations').where('ip', '=', ip).execute();
  }

  async getAllocations(): Promise<IpAllocationRecord[]> {
    return this.db.selectFrom('ip_allocations').selectAll().execute();
  }

  async getAllocationForVm(vmId: string): Promise<IpAllocationRecord | null> {
    const result = await this.db
      .selectFrom('ip_allocations')
      .selectAll()
      .where('vm_id', '=', vmId)
      .executeTakeFirst();
    return result ?? null;
  }
}

/**
 * Worker allocator, process-lifetime state only. After a restart,
 * `cleanupOrphans()` reaps leftover chroots and TAPs (matching
 * `VM_TAP_PATTERN`): the filesystem is the source of truth.
 *
 * No locking needed: every method is synchronous on the Map and only awaits
 * to satisfy the async interface.
 */
export class InMemoryIpAllocator implements IpAllocator {
  private readonly range: CidrRange;
  private readonly gateway: string;
  private readonly gatewayNum: number;
  private readonly netmask: string;
  private readonly byVmId = new Map<string, IpAllocationRecord>();
  private readonly allocatedIps = new Set<string>();

  constructor(opts: { cidr: string; gateway: string; netmask: string }) {
    this.range = parseCidr(opts.cidr);
    this.gateway = opts.gateway;
    this.gatewayNum = ipToNumber(opts.gateway);
    this.netmask = opts.netmask;
  }

  async allocate(vmId: string, scalerName: string): Promise<IpAllocationResult> {
    const candidateIp = findFirstFreeIp(this.range, this.gatewayNum, (ip) =>
      this.allocatedIps.has(ip),
    );
    const mac = generateMac(candidateIp);
    const tapDevice = generateTapName(vmId);

    this.byVmId.set(vmId, {
      ip: candidateIp,
      vm_id: vmId,
      scaler_name: scalerName,
      tap_device: tapDevice,
      mac_address: mac,
    });
    this.allocatedIps.add(candidateIp);

    return { ip: candidateIp, gateway: this.gateway, netmask: this.netmask, mac, tapDevice };
  }

  async release(vmId: string): Promise<void> {
    const existing = this.byVmId.get(vmId);
    if (existing) {
      this.allocatedIps.delete(existing.ip);
      this.byVmId.delete(vmId);
    }
  }

  async releaseByIp(ip: string): Promise<void> {
    for (const [vmId, record] of this.byVmId) {
      if (record.ip === ip) {
        this.byVmId.delete(vmId);
        this.allocatedIps.delete(ip);
        return;
      }
    }
  }

  async getAllocations(): Promise<IpAllocationRecord[]> {
    return [...this.byVmId.values()];
  }

  async getAllocationForVm(vmId: string): Promise<IpAllocationRecord | null> {
    return this.byVmId.get(vmId) ?? null;
  }
}
