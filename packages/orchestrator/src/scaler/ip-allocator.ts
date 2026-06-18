/**
 * CIDR IP allocator for Firecracker VM networking.
 *
 * Two implementations behind a shared interface:
 *
 * - `DbIpAllocator` — persists allocations to PostgreSQL. Used by
 *   coordinators where the cluster Postgres is reachable. Allocations
 *   survive orchestrator restarts so a long-lived VM keeps its IP across
 *   coord bounces.
 *
 * - `InMemoryIpAllocator` — Map-backed, no persistence. Used by worker
 *   peers where the cluster DB is not reachable. The firecracker backend's
 *   existing `cleanupOrphans()` Pass-2/Pass-3 walks the jailer chroot
 *   tree + host TAP devices on every spawn and during the leak sweep, so
 *   any worker-orch restart starts the allocator empty and the next
 *   cleanup pass reaps the leftover chroots and TAPs naturally — no
 *   recovery state needs to live in the allocator itself.
 *
 * Each orch has its own bridge with its own subnet (coord A: `kici`,
 * coord B: `kici_b`, Pi worker: `kici-br0`), so allocator state is
 * per-orch by design. No two orchs share an IP space.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Result of a successful IP allocation.
 */
export interface IpAllocationResult {
  /** Allocated IP address */
  ip: string;
  /** Gateway IP for guest networking */
  gateway: string;
  /** Subnet mask for guest networking */
  netmask: string;
  /** Deterministic MAC address derived from IP */
  mac: string;
  /** TAP device name on the host */
  tapDevice: string;
}

/**
 * Parsed CIDR range.
 */
export interface CidrRange {
  /** Network address as a 32-bit number */
  networkAddress: number;
  /** Prefix length (e.g. 24 for /24) */
  prefixLength: number;
  /** First usable IP (network address + 1) as a 32-bit number */
  startIp: number;
  /** Last usable IP (broadcast - 1) as a 32-bit number */
  endIp: number;
}

/**
 * Parse an IPv4 address string to a 32-bit unsigned integer.
 */
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
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/**
 * Convert a 32-bit unsigned integer back to an IPv4 address string.
 */
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
 * Parse a CIDR notation string into a CidrRange.
 *
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

  // Broadcast address = network address | all host bits set
  const broadcastAddress = (networkAddress | ((1 << hostBits) - 1)) >>> 0;

  // First usable = network + 1, last usable = broadcast - 1
  const startIp = (networkAddress + 1) >>> 0;
  const endIp = (broadcastAddress - 1) >>> 0;

  return { networkAddress, prefixLength, startIp, endIp };
}

/**
 * Generate a deterministic MAC address from an IP address.
 *
 * Uses the locally-administered unicast prefix 06:00:AC followed by
 * the last 3 octets of the IP address encoded as hex.
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

  // Use octets 2, 3, 4 (0-indexed: 1, 2, 3) for the last 3 MAC bytes
  return `06:00:AC:${hex(parseInt(parts[1], 10))}:${hex(parseInt(parts[2], 10))}:${hex(parseInt(parts[3], 10))}`;
}

/**
 * Generate a TAP device name from a VM ID.
 * Linux interface names are limited to 15 characters (IFNAMSIZ).
 * Format: kici-XXXXXXXX (5 + 8 = 13 chars, well within limit).
 *
 * Uses the LAST 8 characters of the vmId to avoid collisions.
 * VM IDs have format "scaler-firecracker-XXXXXXXX" where the unique
 * random suffix is at the end. Using slice(0, 8) would always produce
 * "scaler-f" for all Firecracker VMs.
 */
export function generateTapName(vmId: string): string {
  return `kici-${vmId.slice(-8)}`;
}

/**
 * Shape of one row returned by `IpAllocator.getAllocations()` /
 * `getAllocationForVm()`. Matches the `ip_allocations` table columns so
 * the firecracker-backend's `cleanupOrphans()` can read both impls
 * uniformly.
 */
export interface IpAllocationRecord {
  ip: string;
  vm_id: string;
  scaler_name: string;
  tap_device: string;
  mac_address: string;
}

/**
 * Per-orch CIDR IP allocator interface.
 *
 * Two implementations: `DbIpAllocator` (Postgres, coordinator) and
 * `InMemoryIpAllocator` (Map-backed, worker). The firecracker-backend
 * depends only on this interface — never on the concrete class — so a
 * single backend implementation works in both deploy modes.
 */
export interface IpAllocator {
  allocate(vmId: string, scalerName: string): Promise<IpAllocationResult>;
  release(vmId: string): Promise<void>;
  releaseByIp(ip: string): Promise<void>;
  getAllocations(): Promise<IpAllocationRecord[]>;
  getAllocationForVm(vmId: string): Promise<IpAllocationRecord | null>;
}

/**
 * Walk the CIDR range and call `pickIp` with each candidate IP (as a
 * dotted-quad string). The first IP for which `pickIp` returns a truthy
 * result is allocated and returned. Skips the gateway. Throws if the
 * range is exhausted. Shared by both `DbIpAllocator` and
 * `InMemoryIpAllocator` — keeps the "scan + skip gateway + skip
 * already-allocated" loop in one place.
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

/**
 * DB-backed CIDR IP allocator.
 *
 * Allocates IPs from a configurable range, skipping the gateway.
 * All allocations are persisted in PostgreSQL — used by coordinators
 * where the cluster DB is reachable. Allocations survive orch restarts
 * so a long-lived VM keeps its IP across coord bounces.
 */
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
    const allocations = await this.db.selectFrom('ip_allocations').select('ip').execute();
    const allocatedSet = new Set(allocations.map((a) => a.ip));

    const candidateIp = findFirstFreeIp(this.range, this.gatewayNum, (ip) => allocatedSet.has(ip));
    const mac = generateMac(candidateIp);
    const tapDevice = generateTapName(vmId);

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
 * In-memory CIDR IP allocator.
 *
 * Used by worker peers where the cluster Postgres is not reachable. State
 * lives in a `Map<vmId, IpAllocationRecord>` for the lifetime of the
 * orch process; on restart the allocator starts empty and the
 * firecracker-backend's existing `cleanupOrphans()` Pass-2/Pass-3 walks
 * the jailer chroot tree + host TAP devices (matching `VM_TAP_PATTERN`)
 * to reap any leftover state. No persistence and no chroot recovery
 * inside the allocator — the filesystem is the source of truth, and the
 * cleanup pass already consults it.
 *
 * Each orch has its own bridge with its own subnet, so per-process
 * state is by design. No locking needed: every method is synchronous on
 * the in-memory Map and only awaits to satisfy the async interface.
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
