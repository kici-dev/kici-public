/**
 * Tests for the DB-backed CIDR IP allocator.
 *
 * Tests cover:
 * - CIDR parsing and IP arithmetic helpers
 * - MAC address generation
 * - TAP device naming
 * - Allocation, release, and pool exhaustion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ipToNumber,
  numberToIp,
  parseCidr,
  generateMac,
  generateTapName,
  DbIpAllocator,
  InMemoryIpAllocator,
} from './ip-allocator.js';

// ── Helper function tests ──────────────────────────────────────

describe('ipToNumber', () => {
  it('converts 0.0.0.0 to 0', () => {
    expect(ipToNumber('0.0.0.0')).toBe(0);
  });

  it('converts 255.255.255.255 to 4294967295', () => {
    expect(ipToNumber('255.255.255.255')).toBe(4294967295);
  });

  it('converts 10.0.0.1 correctly', () => {
    expect(ipToNumber('10.0.0.1')).toBe(167772161);
  });

  it('converts 192.168.1.100 correctly', () => {
    expect(ipToNumber('192.168.1.100')).toBe(3232235876);
  });

  it('throws on invalid IP', () => {
    expect(() => ipToNumber('not-an-ip')).toThrow(/Invalid IP address/);
    expect(() => ipToNumber('10.0.0')).toThrow(/Invalid IP address/);
    expect(() => ipToNumber('10.0.0.256')).toThrow(/Invalid IP address/);
  });
});

describe('numberToIp', () => {
  it('converts 0 to 0.0.0.0', () => {
    expect(numberToIp(0)).toBe('0.0.0.0');
  });

  it('converts 4294967295 to 255.255.255.255', () => {
    expect(numberToIp(4294967295)).toBe('255.255.255.255');
  });

  it('converts 167772161 to 10.0.0.1', () => {
    expect(numberToIp(167772161)).toBe('10.0.0.1');
  });

  it('round-trips with ipToNumber', () => {
    const ips = ['10.0.0.5', '192.168.100.42', '172.16.0.1', '0.0.0.0', '255.255.255.255'];
    for (const ip of ips) {
      expect(numberToIp(ipToNumber(ip))).toBe(ip);
    }
  });
});

describe('parseCidr', () => {
  it('parses 10.0.0.0/24 correctly', () => {
    const range = parseCidr('10.0.0.0/24');
    expect(range.prefixLength).toBe(24);
    expect(numberToIp(range.networkAddress)).toBe('10.0.0.0');
    expect(numberToIp(range.startIp)).toBe('10.0.0.1');
    expect(numberToIp(range.endIp)).toBe('10.0.0.254');
  });

  it('parses 192.168.100.0/28 correctly', () => {
    const range = parseCidr('192.168.100.0/28');
    expect(range.prefixLength).toBe(28);
    expect(numberToIp(range.networkAddress)).toBe('192.168.100.0');
    expect(numberToIp(range.startIp)).toBe('192.168.100.1');
    expect(numberToIp(range.endIp)).toBe('192.168.100.14');
  });

  it('parses 10.0.0.0/22 correctly (larger range)', () => {
    const range = parseCidr('10.0.0.0/22');
    expect(range.prefixLength).toBe(22);
    expect(numberToIp(range.startIp)).toBe('10.0.0.1');
    expect(numberToIp(range.endIp)).toBe('10.0.3.254');
  });

  it('parses 10.0.0.0/30 correctly (small range)', () => {
    const range = parseCidr('10.0.0.0/30');
    expect(range.prefixLength).toBe(30);
    expect(numberToIp(range.startIp)).toBe('10.0.0.1');
    expect(numberToIp(range.endIp)).toBe('10.0.0.2');
  });

  it('throws on invalid CIDR', () => {
    expect(() => parseCidr('not-cidr')).toThrow(/Invalid CIDR/);
    expect(() => parseCidr('10.0.0.0/33')).toThrow(/Invalid CIDR prefix/);
    expect(() => parseCidr('10.0.0.0/')).toThrow(/Invalid CIDR prefix/);
  });
});

describe('generateMac', () => {
  it('produces deterministic MAC from IP', () => {
    expect(generateMac('10.0.0.5')).toBe('06:00:AC:00:00:05');
  });

  it('produces different MACs for different IPs', () => {
    const mac1 = generateMac('10.0.0.5');
    const mac2 = generateMac('10.0.0.6');
    expect(mac1).not.toBe(mac2);
  });

  it('encodes IP octets as hex', () => {
    expect(generateMac('10.0.1.42')).toBe('06:00:AC:00:01:2A');
  });

  it('handles 255 octets', () => {
    expect(generateMac('10.255.255.255')).toBe('06:00:AC:FF:FF:FF');
  });

  it('uses locally-administered unicast prefix', () => {
    const mac = generateMac('10.0.0.1');
    // 06:00:AC prefix - bit 1 of first octet is set (locally administered)
    expect(mac.startsWith('06:00:AC:')).toBe(true);
  });

  it('throws on invalid IP', () => {
    expect(() => generateMac('not-an-ip')).toThrow(/Invalid IP/);
  });
});

describe('generateTapName', () => {
  it('produces name within IFNAMSIZ limit (15 chars)', () => {
    const name = generateTapName('a1b2c3d4e5f6g7h8');
    expect(name.length).toBeLessThanOrEqual(15);
  });

  it('uses kici- prefix with last 8 chars of vmId', () => {
    expect(generateTapName('abcdef1234567890')).toBe('kici-34567890');
  });

  it('handles short vmId', () => {
    expect(generateTapName('abc')).toBe('kici-abc');
  });

  it('is exactly 13 chars for 8+ char vmId', () => {
    const name = generateTapName('12345678abcd');
    expect(name).toBe('kici-5678abcd');
    expect(name.length).toBe(13);
  });

  it('produces unique names for scaler-firecracker agent IDs', () => {
    // Agent IDs have format scaler-firecracker-XXXXXXXX
    // Using slice(-8) extracts the unique random suffix
    const name1 = generateTapName('scaler-firecracker-1d993749');
    const name2 = generateTapName('scaler-firecracker-ac2629ac');
    expect(name1).toBe('kici-1d993749');
    expect(name2).toBe('kici-ac2629ac');
    expect(name1).not.toBe(name2);
  });
});

// ── DbIpAllocator class tests ──────────────────────────────────

/**
 * Create a mock Kysely DB for IpAllocator.
 * Supports the query chains: selectFrom().select().execute(),
 * insertInto().values().execute(), deleteFrom().where().execute(),
 * selectFrom().selectAll().execute(), selectFrom().selectAll().where().executeTakeFirst()
 */
function createMockAllocatorDb(
  options: {
    /** IPs already allocated (returned by selectFrom('ip_allocations').select('ip').execute()) */
    allocatedIps?: string[];
    /** Full allocation rows (returned by selectAll queries) */
    allocationRows?: Record<string, unknown>[];
    /** Single allocation row (returned by executeTakeFirst) */
    singleAllocation?: Record<string, unknown> | undefined;
  } = {},
) {
  const { allocatedIps = [], allocationRows = [], singleAllocation = undefined } = options;

  const insertExecute = vi.fn().mockResolvedValue(undefined);
  const deleteExecute = vi.fn().mockResolvedValue(undefined);

  // Track insert calls
  const insertValues = vi.fn().mockReturnValue({ execute: insertExecute });

  // Track delete calls
  const deleteWhere = vi.fn().mockReturnValue({ execute: deleteExecute });

  // For selectFrom, we need to distinguish between select('ip') and selectAll()
  const selectExecute = vi.fn().mockResolvedValue(allocatedIps.map((ip) => ({ ip })));
  const selectAllExecute = vi.fn().mockResolvedValue(allocationRows);
  const selectAllWhereTakeFirst = vi.fn().mockResolvedValue(singleAllocation);

  const selectIp = vi.fn().mockReturnValue({ execute: selectExecute });
  const selectAllWhere = vi.fn().mockReturnValue({
    executeTakeFirst: selectAllWhereTakeFirst,
    execute: selectAllExecute,
  });
  const selectAll = vi.fn().mockReturnValue({
    execute: selectAllExecute,
    where: selectAllWhere,
  });

  const selectFrom = vi.fn().mockReturnValue({
    select: selectIp,
    selectAll,
  });

  return {
    selectFrom,
    insertInto: vi.fn().mockReturnValue({ values: insertValues }),
    deleteFrom: vi.fn().mockReturnValue({ where: deleteWhere }),
    // Expose mocks for assertions
    _mocks: {
      insertExecute,
      insertValues,
      deleteExecute,
      deleteWhere,
      selectExecute,
      selectAllExecute,
      selectAllWhereTakeFirst,
      selectFrom,
    },
  } as any;
}

describe('DbIpAllocator', () => {
  describe('allocate', () => {
    it('allocates the first available IP in the range', async () => {
      const db = createMockAllocatorDb({ allocatedIps: [] });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.allocate('vm-001', 'fc-scaler');

      // First usable IP after gateway (10.0.0.1 is gateway, so first is 10.0.0.2)
      expect(result.ip).toBe('10.0.0.2');
      expect(result.gateway).toBe('10.0.0.1');
      expect(result.netmask).toBe('255.255.255.0');
      expect(result.mac).toBe(generateMac('10.0.0.2'));
      expect(result.tapDevice).toBe('kici-vm-001');

      // Verify INSERT was called
      expect(db.insertInto).toHaveBeenCalledWith('ip_allocations');
    });

    it('skips the gateway IP', async () => {
      const db = createMockAllocatorDb({ allocatedIps: [] });
      // Gateway is the first usable IP (10.0.0.1)
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.allocate('vm-001', 'fc-scaler');

      // Should skip 10.0.0.1 (gateway) and allocate 10.0.0.2
      expect(result.ip).toBe('10.0.0.2');
    });

    it('skips already-allocated IPs', async () => {
      const db = createMockAllocatorDb({ allocatedIps: ['10.0.0.2', '10.0.0.3'] });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.allocate('vm-004', 'fc-scaler');

      expect(result.ip).toBe('10.0.0.4');
    });

    it('throws when pool is exhausted', async () => {
      // /30 has only 2 usable IPs: 10.0.0.1 and 10.0.0.2
      // Gateway takes 10.0.0.1, so only 10.0.0.2 is available
      const db = createMockAllocatorDb({ allocatedIps: ['10.0.0.2'] });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/30',
        gateway: '10.0.0.1',
        netmask: '255.255.255.252',
      });

      await expect(allocator.allocate('vm-full', 'fc-scaler')).rejects.toThrow(/IP pool exhausted/);
    });

    it('returns correct allocation info with TAP and MAC', async () => {
      const db = createMockAllocatorDb({ allocatedIps: [] });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.allocate('abcdef1234567890', 'fc-scaler');

      expect(result.tapDevice).toBe('kici-34567890');
      expect(result.mac).toMatch(/^06:00:AC:/);
      expect(result.gateway).toBe('10.0.0.1');
      expect(result.netmask).toBe('255.255.255.0');
    });
  });

  describe('release', () => {
    it('deletes allocation by vm_id', async () => {
      const db = createMockAllocatorDb();
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await allocator.release('vm-001');

      expect(db.deleteFrom).toHaveBeenCalledWith('ip_allocations');
      expect(db._mocks.deleteWhere).toHaveBeenCalledWith('vm_id', '=', 'vm-001');
    });
  });

  describe('releaseByIp', () => {
    it('deletes allocation by ip address', async () => {
      const db = createMockAllocatorDb();
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await allocator.releaseByIp('10.0.0.5');

      expect(db.deleteFrom).toHaveBeenCalledWith('ip_allocations');
      expect(db._mocks.deleteWhere).toHaveBeenCalledWith('ip', '=', '10.0.0.5');
    });
  });

  describe('getAllocations', () => {
    it('returns all allocations from DB', async () => {
      const rows = [
        {
          ip: '10.0.0.2',
          vm_id: 'vm-1',
          scaler_name: 'fc',
          tap_device: 'kici-vm-1',
          mac_address: '06:00:AC:00:00:02',
        },
        {
          ip: '10.0.0.3',
          vm_id: 'vm-2',
          scaler_name: 'fc',
          tap_device: 'kici-vm-2',
          mac_address: '06:00:AC:00:00:03',
        },
      ];
      const db = createMockAllocatorDb({ allocationRows: rows });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.getAllocations();

      expect(result).toEqual(rows);
      expect(db.selectFrom).toHaveBeenCalledWith('ip_allocations');
    });
  });

  describe('getAllocationForVm', () => {
    it('returns allocation when found', async () => {
      const allocation = {
        ip: '10.0.0.2',
        vm_id: 'vm-1',
        scaler_name: 'fc',
        tap_device: 'kici-vm-1',
        mac_address: '06:00:AC:00:00:02',
      };
      const db = createMockAllocatorDb({ singleAllocation: allocation });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.getAllocationForVm('vm-1');

      expect(result).toEqual(allocation);
    });

    it('returns null when no allocation exists', async () => {
      const db = createMockAllocatorDb({ singleAllocation: undefined });
      const allocator = new DbIpAllocator({
        db,
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.getAllocationForVm('vm-nonexistent');

      expect(result).toBeNull();
    });
  });
});

// ── InMemoryIpAllocator class tests ────────────────────────────

describe('InMemoryIpAllocator', () => {
  describe('allocate', () => {
    it('allocates the first available IP in the range, skipping the gateway', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const result = await allocator.allocate('vm-001', 'fc-scaler');

      expect(result.ip).toBe('10.0.0.2');
      expect(result.gateway).toBe('10.0.0.1');
      expect(result.netmask).toBe('255.255.255.0');
      expect(result.mac).toBe(generateMac('10.0.0.2'));
      expect(result.tapDevice).toBe('kici-vm-001');
    });

    it('hands out consecutive IPs across multiple allocate() calls', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const a = await allocator.allocate('vm-a', 'fc');
      const b = await allocator.allocate('vm-b', 'fc');
      const c = await allocator.allocate('vm-c', 'fc');

      expect([a.ip, b.ip, c.ip]).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4']);
    });

    it('reuses an IP after release()', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const first = await allocator.allocate('vm-001', 'fc');
      await allocator.release('vm-001');
      const second = await allocator.allocate('vm-002', 'fc');

      expect(first.ip).toBe('10.0.0.2');
      expect(second.ip).toBe('10.0.0.2');
    });

    it('reuses an IP after releaseByIp()', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const first = await allocator.allocate('vm-001', 'fc');
      await allocator.releaseByIp(first.ip);
      const second = await allocator.allocate('vm-002', 'fc');

      expect(second.ip).toBe(first.ip);
    });

    it('throws when the CIDR pool is exhausted', async () => {
      // /30 has 4 addresses: network (.0), gateway (.1), one usable (.2), broadcast (.3)
      // startIp..endIp covers .1..2; gateway .1 is skipped → exactly one allocation possible.
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/30',
        gateway: '10.0.0.1',
        netmask: '255.255.255.252',
      });

      const first = await allocator.allocate('vm-001', 'fc');
      expect(first.ip).toBe('10.0.0.2');

      await expect(allocator.allocate('vm-002', 'fc')).rejects.toThrow(/IP pool exhausted/);
    });

    it('does NOT reallocate the same IP to a second VM without release', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const a = await allocator.allocate('vm-a', 'fc');
      const b = await allocator.allocate('vm-b', 'fc');

      expect(a.ip).not.toBe(b.ip);
    });
  });

  describe('release', () => {
    it('is a no-op for an unknown vmId', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await expect(allocator.release('vm-unknown')).resolves.toBeUndefined();
      const all = await allocator.getAllocations();
      expect(all).toEqual([]);
    });
  });

  describe('getAllocations / getAllocationForVm', () => {
    it('returns all live allocations as full IpAllocationRecord objects', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await allocator.allocate('vm-a', 'fc-scaler');
      await allocator.allocate('vm-b', 'fc-scaler');

      const all = await allocator.getAllocations();
      expect(all).toHaveLength(2);

      const a = all.find((r) => r.vm_id === 'vm-a');
      expect(a).toEqual({
        ip: '10.0.0.2',
        vm_id: 'vm-a',
        scaler_name: 'fc-scaler',
        tap_device: 'kici-vm-a',
        mac_address: generateMac('10.0.0.2'),
      });
    });

    it('omits released allocations from getAllocations()', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await allocator.allocate('vm-a', 'fc');
      await allocator.allocate('vm-b', 'fc');
      await allocator.release('vm-a');

      const all = await allocator.getAllocations();
      expect(all.map((r) => r.vm_id)).toEqual(['vm-b']);
    });

    it('returns null from getAllocationForVm for an unknown vmId', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      expect(await allocator.getAllocationForVm('vm-missing')).toBeNull();
    });

    it('returns the matching record from getAllocationForVm after allocate()', async () => {
      const allocator = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      await allocator.allocate('vm-x', 'fc');
      const rec = await allocator.getAllocationForVm('vm-x');
      expect(rec).not.toBeNull();
      expect(rec!.ip).toBe('10.0.0.2');
      expect(rec!.scaler_name).toBe('fc');
    });
  });

  describe('isolation', () => {
    it('two allocator instances with the same CIDR keep independent pools', async () => {
      const a = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });
      const b = new InMemoryIpAllocator({
        cidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
      });

      const fromA = await a.allocate('vm-1', 'scaler-a');
      const fromB = await b.allocate('vm-2', 'scaler-b');

      // Both start fresh — both get 10.0.0.2. This is by design: each orch
      // owns its own bridge subnet, so independent pools are correct.
      expect(fromA.ip).toBe('10.0.0.2');
      expect(fromB.ip).toBe('10.0.0.2');
    });
  });
});
