import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uptime as osUptime } from 'node:os';
import type { LabelSetConfig } from './types.js';
import type { IpAllocationResult } from './ip-allocator.js';
import type { BridgeHealth } from '../firecracker/host-network.js';

// ── Mocks ────────────────────────────────────────────────────────

// Default execFile implementation (always succeeds)
const defaultExecFileImpl = (
  _cmd: string,
  _args: string[],
  _opts: unknown,
  callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => {
  callback(null, { stdout: '', stderr: '' });
};

// Mock child_process.execFile + spawn
const mockExecFile = vi.fn(defaultExecFileImpl);

const mockChildProcess = {
  unref: vi.fn(),
  pid: 99999,
  on: vi.fn(),
};
const mockSpawn = vi.fn().mockReturnValue(mockChildProcess);

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs (sync functions)
const mockWriteFileSync = vi.fn();
const mockOpenSync = vi.fn().mockReturnValue(42); // fake fd
const mockCloseSync = vi.fn();
const mockReadFileSync = vi.fn().mockReturnValue('');

vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Mock fs/promises
const mockLink = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRm = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue('12345');
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const mockReadlink = vi
  .fn()
  .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
const mockFdTruncate = vi.fn().mockResolvedValue(undefined);
const mockFdClose = vi.fn().mockResolvedValue(undefined);
const mockOpen = vi.fn().mockResolvedValue({ truncate: mockFdTruncate, close: mockFdClose });

vi.mock('node:fs/promises', () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  link: (...args: unknown[]) => mockLink(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  readlink: (...args: unknown[]) => mockReadlink(...args),
}));

// ── /proc scaffolding for `readVmPid` ────────────────────────────
//
// `readVmPid` cross-checks the number in a PID file against
// `/proc/<pid>/stat`: field 2 (`comm`) must be `firecracker`, and field 22
// (`starttime`) must not be later than the PID file's mtime. Tests that need a
// PID to read as live therefore have to serve both halves.

/**
 * A `/proc/<pid>/stat` line for a process named `comm` that started
 * `startedAgoMs` ago. Only fields 2 and 22 are read; the rest are placeholders.
 */
function procStatLine(comm = 'firecracker', startedAgoMs = 5 * 60_000): string {
  const ticksAtStart = Math.max(0, Math.round(((osUptime() * 1000 - startedAgoMs) / 1000) * 100));
  const later = new Array(30).fill('0');
  later[0] = 'S'; // field 3
  later[19] = String(ticksAtStart); // field 22
  return `4242 (${comm}) ${later.join(' ')}\n`;
}

/**
 * Serve PID-file reads with `pidStr` while still answering the
 * `/proc/<pid>/stat` read that `readVmPid` cross-checks the number against.
 */
function mockPidFile(pidStr: string, comm = 'firecracker'): void {
  mockReadFile.mockImplementation(async (p: string) =>
    String(p).startsWith('/proc/') ? procStatLine(comm) : pidStr,
  );
}

/**
 * Serve every PID-file and `/proc` read as ENOENT: no chroot on the host is
 * backed by a running process, which is what an orphan sweep expects to find.
 */
function mockDeadPidFiles(): void {
  mockReadFile.mockImplementation(async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

/** A PID file mtime recent enough that any `procStatLine` start time precedes it. */
function pidFileStat() {
  return { mtimeMs: Date.now(), isDirectory: () => false };
}

// Mock file-tail (prevent real fs.watchFile/unwatchFile calls from tailFile)
vi.mock('./file-tail.js', () => ({
  tailFile: async function* () {
    // no-op async generator
  },
}));

// Mock FirecrackerApi
const mockPutMmds = vi.fn().mockResolvedValue(undefined);
const mockClearMmds = vi.fn().mockResolvedValue(undefined);
const mockSendCtrlAltDel = vi.fn().mockResolvedValue(undefined);
const mockWaitForSocket = vi.fn().mockResolvedValue(true);

vi.mock('./firecracker-api.js', () => ({
  FirecrackerApi: vi.fn().mockImplementation(function () {
    return {
      putMmds: mockPutMmds,
      clearMmds: mockClearMmds,
      sendCtrlAltDel: mockSendCtrlAltDel,
      waitForSocket: mockWaitForSocket,
    };
  }),
}));

// Mock nftables module
const mockEnsureKiciTable = vi.fn().mockResolvedValue(undefined);
const mockAddHostIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockAddIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockRemoveIsolationRules = vi.fn().mockResolvedValue(undefined);
vi.mock('@kici-dev/shared/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared/net')>()),
  ensureKiciTable: (...args: unknown[]) => mockEnsureKiciTable(...args),
  addIsolationRules: (...args: unknown[]) => mockAddIsolationRules(...args),
  addHostIsolationRules: (...args: unknown[]) => mockAddHostIsolationRules(...args),
  removeIsolationRules: (...args: unknown[]) => mockRemoveIsolationRules(...args),
}));

// Mock IpAllocator
function createMockIpAllocator() {
  const defaultAllocation: IpAllocationResult = {
    ip: '10.0.0.2',
    gateway: '10.0.0.1',
    netmask: '255.255.255.0',
    mac: '06:00:AC:00:00:02',
    tapDevice: 'kici-aaaaaaaa',
  };

  return {
    allocate: vi.fn().mockResolvedValue(defaultAllocation),
    release: vi.fn().mockResolvedValue(undefined),
    releaseByIp: vi.fn().mockResolvedValue(undefined),
    getAllocations: vi.fn().mockResolvedValue([]),
    getAllocationForVm: vi.fn().mockResolvedValue(null),
  };
}

// Import after mocking
const { FirecrackerScalerBackend } = await import('./firecracker-backend.js');

// ── Test setup ───────────────────────────────────────────────────

const defaultLabelSets: LabelSetConfig[] = [
  {
    labels: ['linux', 'firecracker'],
    rootfsPath: '/opt/rootfs/ubuntu-22.04.ext4',
  },
  {
    labels: ['linux', 'firecracker', 'node20'],
    rootfsPath: '/opt/rootfs/node20.ext4',
    kernelPath: '/opt/kernels/custom-vmlinux',
    vcpuCount: 4,
    memSizeMib: 1024,
  },
];

function createBackend(
  overrides?: Partial<ConstructorParameters<typeof FirecrackerScalerBackend>[0]>,
) {
  const mockIpAllocator = createMockIpAllocator();
  const backend = new FirecrackerScalerBackend({
    name: 'test-fc',
    labelSets: defaultLabelSets,
    maxAgents: 5,
    ipAllocator: mockIpAllocator as any,
    firecrackerPath: '/usr/bin/firecracker',
    jailerPath: '/usr/bin/jailer',
    kernelPath: '/opt/kernels/vmlinux',
    chrootBaseDir: '/srv/jailer',
    uid: 1000,
    gid: 1000,
    vcpuCount: 2,
    memSizeMib: 512,
    bridgeName: 'kici-br0',
    gateway: '10.0.0.1',
    netmask: '255.255.255.0',
    ...overrides,
  });

  return { backend, mockIpAllocator };
}

describe('FirecrackerScalerBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default implementations after each test
    mockExecFile.mockImplementation(defaultExecFileImpl);
    mockSpawn.mockReturnValue(mockChildProcess);
    mockOpenSync.mockReturnValue(42);
    mockWaitForSocket.mockResolvedValue(true);
    mockPidFile('12345');
    mockReaddir.mockResolvedValue([]);
    mockStat.mockImplementation(async (p: string) => {
      if (String(p).endsWith('firecracker.pid')) return pidFileStat();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadlink.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    mockLink.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockPutMmds.mockResolvedValue(undefined);
    mockClearMmds.mockResolvedValue(undefined);
    mockSendCtrlAltDel.mockResolvedValue(undefined);
    mockEnsureKiciTable.mockResolvedValue(undefined);
    mockAddIsolationRules.mockResolvedValue(undefined);
    mockRemoveIsolationRules.mockResolvedValue(undefined);
  });

  describe('getBridgeConfig()', () => {
    it('derives the gateway CIDR from the network cidr and defaults table to kici', () => {
      const { backend } = createBackend({ cidr: '10.0.0.0/24' });
      expect(backend.getBridgeConfig()).toEqual({
        bridgeName: 'kici-br0',
        bridgeCidr: '10.0.0.1/24',
        table: 'kici',
      });
    });

    it('honors a custom bridge/table (coord B shape)', () => {
      const { backend } = createBackend({
        cidr: '10.0.1.0/24',
        bridgeName: 'kici-br1',
        gateway: '10.0.1.1',
        table: 'kici_b',
      });
      expect(backend.getBridgeConfig()).toEqual({
        bridgeName: 'kici-br1',
        bridgeCidr: '10.0.1.1/24',
        table: 'kici_b',
      });
    });

    it('falls back to the dotted netmask when no cidr is configured', () => {
      const { backend } = createBackend({ netmask: '255.255.0.0' });
      expect(backend.getBridgeConfig().bridgeCidr).toBe('10.0.0.1/16');
    });
  });

  describe('spawn()', () => {
    it('creates TAP device, copies rootfs+kernel, writes config, invokes jailer, puts MMDS', async () => {
      const { backend } = createBackend();

      const managed = await backend.spawn(
        ['linux', 'firecracker'],
        'agent-1',
        'ws://localhost:8080/ws/agent',
      );

      // TAP device creation (3 calls: tuntap add, link set master, link set up)
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['tuntap', 'add', 'kici-aaaaaaaa', 'mode', 'tap'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'set', 'kici-aaaaaaaa', 'master', 'kici-br0'],
        expect.any(Object),
        expect.any(Function),
      );
      // Port isolation is set as its OWN command: the combined
      // `master <br> type bridge_slave isolated on` form is rejected with
      // "Operation not supported" on kernels that accept the flag once the
      // port is already a bridge member.
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'set', 'kici-aaaaaaaa', 'type', 'bridge_slave', 'isolated', 'on'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'set', 'kici-aaaaaaaa', 'up'],
        expect.any(Object),
        expect.any(Function),
      );

      // Chroot directory creation
      expect(mockMkdir).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-1/root', {
        recursive: true,
      });

      // Rootfs copy
      expect(mockLink).toHaveBeenCalledWith(
        '/opt/rootfs/ubuntu-22.04.ext4',
        '/srv/jailer/firecracker/agent-1/root/rootfs.ext4',
      );

      // Kernel copy
      expect(mockLink).toHaveBeenCalledWith(
        '/opt/kernels/vmlinux',
        '/srv/jailer/firecracker/agent-1/root/kernel',
      );

      // Config JSON written
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [configPath, configJson] = mockWriteFile.mock.calls[0];
      expect(configPath).toBe('/srv/jailer/firecracker/agent-1/root/config.json');
      const config = JSON.parse(configJson);
      expect(config['boot-source'].kernel_image_path).toBe('/kernel');
      expect(config['boot-source'].boot_args).toContain('ip=10.0.0.2');
      expect(config.drives[0].drive_id).toBe('rootfs');
      expect(config['machine-config'].vcpu_count).toBe(2);
      expect(config['machine-config'].mem_size_mib).toBe(512);
      expect(config['network-interfaces'][0].guest_mac).toBe('06:00:AC:00:00:02');
      expect(config['mmds-config'].ipv4_address).toBe('169.254.169.254');

      // Jailer invoked via spawn (non-daemonized)
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/jailer',
        [
          '--id',
          'agent-1',
          '--exec-file',
          '/usr/bin/firecracker',
          '--uid',
          '1000',
          '--gid',
          '1000',
          '--chroot-base-dir',
          '/srv/jailer',
          '--new-pid-ns',
          '--',
          '--config-file',
          '/config.json',
          '--log-path',
          '/vmm.log',
          '--level',
          'Warning',
        ],
        {
          detached: true,
          stdio: ['ignore', 42, 42],
        },
      );

      // waitForSocket called
      expect(mockWaitForSocket).toHaveBeenCalledWith(5000);

      // MMDS metadata injected (orchestrator URL, agent ID, labels, scaler-managed flag, gateway IP)
      expect(mockPutMmds).toHaveBeenCalledWith({
        latest: {
          'meta-data': {
            'kici-orchestrator-url': 'ws://localhost:8080/ws/agent',
            'kici-agent-id': 'agent-1',
            'kici-labels':
              'linux,firecracker,kici:agent:firecracker,kici:scaler:test-fc,kici:role:builder,kici:role:init-runner',
            'kici-scaler-managed': '1',
            'kici-gateway-ip': '10.0.0.1',
          },
        },
      });

      // Tracking updated
      expect(managed.state).toBe('running');
      expect(managed.id).toBe('agent-1');
    });

    it('uses label-set-specific rootfsPath', async () => {
      const { backend } = createBackend();

      await backend.spawn(
        ['linux', 'firecracker', 'node20'],
        'agent-2',
        'ws://localhost:8080/ws/agent',
      );

      // Should use the node20 rootfsPath
      expect(mockLink).toHaveBeenCalledWith(
        '/opt/rootfs/node20.ext4',
        expect.stringContaining('rootfs.ext4'),
      );
    });

    it('uses label-set-specific kernelPath override', async () => {
      const { backend } = createBackend();

      await backend.spawn(
        ['linux', 'firecracker', 'node20'],
        'agent-2',
        'ws://localhost:8080/ws/agent',
      );

      // Should use the custom kernel path from label set
      expect(mockLink).toHaveBeenCalledWith(
        '/opt/kernels/custom-vmlinux',
        expect.stringContaining('kernel'),
      );
    });

    it('uses label-set-specific vcpuCount/memSizeMib overrides', async () => {
      const { backend } = createBackend();

      await backend.spawn(
        ['linux', 'firecracker', 'node20'],
        'agent-2',
        'ws://localhost:8080/ws/agent',
      );

      const configJson = mockWriteFile.mock.calls[0][1];
      const config = JSON.parse(configJson);
      expect(config['machine-config'].vcpu_count).toBe(4);
      expect(config['machine-config'].mem_size_mib).toBe(1024);
    });

    it('uses scaler-level defaults when label-set has no overrides', async () => {
      const { backend } = createBackend();

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      const configJson = mockWriteFile.mock.calls[0][1];
      const config = JSON.parse(configJson);
      expect(config['machine-config'].vcpu_count).toBe(2);
      expect(config['machine-config'].mem_size_mib).toBe(512);
    });

    it('allocates IP and passes correct network config in boot args', async () => {
      const { backend, mockIpAllocator } = createBackend();

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      expect(mockIpAllocator.allocate).toHaveBeenCalledWith('agent-1', 'test-fc');

      const configJson = mockWriteFile.mock.calls[0][1];
      const config = JSON.parse(configJson);
      expect(config['boot-source'].boot_args).toBe(
        'console=ttyS0 reboot=k panic=1 random.trust_cpu=on init=/init ip=10.0.0.2::10.0.0.1:255.255.255.0::eth0:off',
      );
    });

    it('throws when at capacity', async () => {
      const { backend } = createBackend({ maxAgents: 1 });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      await expect(
        backend.spawn(['linux', 'firecracker'], 'agent-2', 'ws://localhost:8080/ws/agent'),
      ).rejects.toThrow('Firecracker backend "test-fc" at capacity (1/1)');
    });

    it('throws when label set not found', async () => {
      const { backend } = createBackend();

      await expect(
        backend.spawn(['windows', 'gpu'], 'agent-1', 'ws://localhost:8080/ws/agent'),
      ).rejects.toThrow('Label set [windows, gpu] not supported by Firecracker backend "test-fc"');
    });

    it('cleans up on failure: releases IP, deletes TAP, cleans chroot', async () => {
      const { backend, mockIpAllocator } = createBackend();

      // Make jailer spawn throw (spawn is used instead of execFile for jailer)
      mockSpawn.mockImplementation(() => {
        throw new Error('jailer failed');
      });

      await expect(
        backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent'),
      ).rejects.toThrow('jailer failed');

      // IP should be released
      expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-1');

      // TAP should be deleted (cleanup call)
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-aaaaaaaa'],
        expect.any(Object),
        expect.any(Function),
      );

      // Chroot should be cleaned
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-1', {
        recursive: true,
        force: true,
      });

      // Agent should not remain in tracking
      expect(backend.getActiveCount()).toBe(0);
    });

    it('throws when socket is not ready within timeout', async () => {
      const { backend } = createBackend();
      mockWaitForSocket.mockResolvedValue(false);

      await expect(
        backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent'),
      ).rejects.toThrow('Firecracker API socket not ready within 5s');
    });

    it('applies per-VM saddr-keyed nftables isolation rules during spawn', async () => {
      const { backend } = createBackend();

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      expect(mockEnsureKiciTable).toHaveBeenCalledWith({
        requireSudo: false,
        table: 'kici',
        requireBaselineChain: true,
      });
      // Pre-clean before add: the allocator recycles IPs, and a crash or a
      // `kill -9` leaves the previous holder's rules — including its
      // allowlist — behind for the next tenant to inherit.
      expect(mockRemoveIsolationRules).toHaveBeenCalledWith('10.0.0.2', {
        requireSudo: false,
        table: 'kici',
      });
      expect(mockAddIsolationRules).toHaveBeenCalledWith(
        '10.0.0.2',
        '10.0.0.1',
        undefined,
        'saddr',
        { requireSudo: false, table: 'kici' },
      );
    });

    it('writes per-VM rules to the CONFIGURED table, not the literal kici', async () => {
      // With two coordinators on one host, coordinator B's baseline goes to
      // kici_b while its per-VM rules used to go to kici — coordinator A's
      // table. A's next re-provision then swept B's live VMs' isolation along
      // with its own, and B's rules were evaluated against A's baseline.
      const { backend } = createBackend({ table: 'kici_b' });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      const optsSeen = [
        ...mockEnsureKiciTable.mock.calls.map((c) => c[0]),
        ...mockAddIsolationRules.mock.calls.map((c) => c[4]),
        ...mockRemoveIsolationRules.mock.calls.map((c) => c[1]),
      ];
      expect(optsSeen.length).toBeGreaterThan(0);
      for (const opts of optsSeen) {
        expect(opts).toMatchObject({ table: 'kici_b' });
      }
    });

    it('passes networkPolicy from label set to addIsolationRules', async () => {
      const { backend } = createBackend({
        labelSets: [
          {
            labels: ['linux', 'firecracker'],
            rootfsPath: '/opt/rootfs/ubuntu-22.04.ext4',
            networkPolicy: { allowlist: ['1.2.3.0/24'], denyAll: true },
          },
        ],
      });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      expect(mockAddIsolationRules).toHaveBeenCalledWith(
        '10.0.0.2',
        '10.0.0.1',
        {
          allowlist: ['1.2.3.0/24'],
          denyAll: true,
        },
        'saddr',
        { requireSudo: false, table: 'kici' },
      );
    });
  });

  describe('forwarded env (KICI_AGENT_ENV_* + scalers.yaml env:)', () => {
    // Snapshot/restore process.env so each test starts clean and we don't
    // pollute other suites in the same vitest worker.
    const envSnapshot: Record<string, string | undefined> = {};
    const trackedEnvKeys = ['KICI_AGENT_ENV_HTTP_PROXY', 'KICI_AGENT_ENV_HUGE'];

    beforeEach(() => {
      for (const k of trackedEnvKeys) {
        envSnapshot[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of trackedEnvKeys) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
      }
    });

    function getMmdsKiciEnv(): Record<string, string> | undefined {
      const call = mockPutMmds.mock.calls[0]?.[0] as
        { latest: { 'meta-data': Record<string, unknown> } } | undefined;
      return call?.latest['meta-data']['kici-env'] as Record<string, string> | undefined;
    }

    it('forwards KICI_AGENT_ENV_* vars from process.env with prefix stripped', async () => {
      process.env.KICI_AGENT_ENV_HTTP_PROXY = 'http://proxy:3128';
      const { backend } = createBackend();

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      expect(getMmdsKiciEnv()).toEqual({ HTTP_PROXY: 'http://proxy:3128' });
    });

    it('label-set env: overrides KICI_AGENT_ENV_* on conflict (yaml wins)', async () => {
      process.env.KICI_AGENT_ENV_HTTP_PROXY = 'lower-precedence';
      const { backend } = createBackend({
        labelSets: [
          {
            labels: ['linux', 'firecracker'],
            rootfsPath: '/opt/rootfs/ubuntu-22.04.ext4',
            env: { HTTP_PROXY: 'override' },
          },
        ],
      });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      expect(getMmdsKiciEnv()).toEqual({ HTTP_PROXY: 'override' });
    });

    it('omits the kici-env MMDS field entirely when no env is forwarded', async () => {
      const { backend } = createBackend();

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      const call = mockPutMmds.mock.calls[0]?.[0] as {
        latest: { 'meta-data': Record<string, unknown> };
      };
      expect(call.latest['meta-data']).not.toHaveProperty('kici-env');
    });

    it('skips env vars that exceed the 32 KiB MMDS budget', async () => {
      // 40 KiB string blows past the 32 KiB budget.
      process.env.KICI_AGENT_ENV_HUGE = 'x'.repeat(40 * 1024);
      const { backend } = createBackend({
        labelSets: [
          {
            labels: ['linux', 'firecracker'],
            rootfsPath: '/opt/rootfs/ubuntu-22.04.ext4',
            env: { SMALL: 'fits' },
          },
        ],
      });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      const env = getMmdsKiciEnv();
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty('HUGE');
      expect(env).toHaveProperty('SMALL', 'fits');
    });

    it('skips env keys that are not POSIX-safe identifiers', async () => {
      const { backend } = createBackend({
        labelSets: [
          {
            labels: ['linux', 'firecracker'],
            rootfsPath: '/opt/rootfs/ubuntu-22.04.ext4',
            env: { 'BAD/KEY': 'rejected', GOOD_KEY: 'kept', '0BAD': 'rejected', GOOD2: 'kept' },
          },
        ],
      });

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      const env = getMmdsKiciEnv();
      expect(env).toEqual({ GOOD_KEY: 'kept', GOOD2: 'kept' });
    });
  });

  describe('destroy()', () => {
    it('sends SendCtrlAltDel, reads PID, force kills, cleans up TAP+IP+chroot', async () => {
      const { backend, mockIpAllocator } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockResolvedValue('12345');

      // Mock process.kill: process is dead
      const origKill = process.kill;
      const mockKill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      process.kill = mockKill as any;

      try {
        await backend.destroy('agent-1');

        // SendCtrlAltDel attempted
        expect(mockSendCtrlAltDel).toHaveBeenCalledOnce();

        // IP released
        expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-1');

        // Chroot cleaned
        expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-1', {
          recursive: true,
          force: true,
        });

        // Agent removed from tracking
        expect(backend.getActiveCount()).toBe(0);
      } finally {
        process.kill = origKill;
      }
    });

    it('never signals PID 0 read from a truncated PID file', async () => {
      // `process.kill(0, 'SIGKILL')` signals the orchestrator's OWN process
      // group, so a zeroed or truncated `firecracker.pid` must not reach it.
      const { backend, mockIpAllocator } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockResolvedValue('0');

      const origKill = process.kill;
      const mockKill = vi.fn();
      process.kill = mockKill as never;

      try {
        await backend.destroy('agent-1');

        expect(mockKill).not.toHaveBeenCalled();
        // The rest of the teardown still runs.
        expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-1');
      } finally {
        process.kill = origKill;
      }
    });

    it('reads a truncated PID file as a dead VM, not as a live process group', async () => {
      // Signal 0 to PID 0 probes this process's own group, which always exists,
      // so a `!isNaN` liveness check would call every truncated-PID VM alive —
      // and every sweep would skip its chroot and its IP forever.
      const { backend } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockResolvedValue('0');
      mockReaddir.mockResolvedValue(['agent-2']);

      const origKill = process.kill;
      const mockKill = vi.fn();
      process.kill = mockKill as never;

      try {
        // `agent-2` has a chroot, a truncated PID file, and no DB allocation:
        // the Pass-2 filesystem orphan, reaped only when it reads as dead.
        await backend.cleanupOrphans();

        expect(mockKill).not.toHaveBeenCalled();
        expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-2', {
          recursive: true,
          force: true,
        });
      } finally {
        process.kill = origKill;
      }
    });

    it('reclaims chroot ownership via sudo chown before rm on rootless nodes (requireSudo)', async () => {
      const { backend } = createBackend({ requireSudo: true });
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockResolvedValue('12345');

      const origKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as any;

      try {
        await backend.destroy('agent-1');

        // The jailer chowns the chroot to its own uid; the rootless
        // orchestrator must reclaim ownership before rm can unlink the tree.
        expect(mockExecFile).toHaveBeenCalledWith(
          'sudo',
          [
            '-n',
            'chown',
            '-R',
            `${process.getuid!()}:${process.getgid!()}`,
            '/srv/jailer/firecracker/agent-1',
          ],
          expect.any(Object),
          expect.any(Function),
        );
        expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-1', {
          recursive: true,
          force: true,
        });
      } finally {
        process.kill = origKill;
      }
    });

    it('does NOT chown the chroot on root nodes (requireSudo false)', async () => {
      const { backend } = createBackend({ requireSudo: false });
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockResolvedValue('12345');

      const origKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as any;

      try {
        await backend.destroy('agent-1');

        const chownCalls = mockExecFile.mock.calls.filter(
          (c) => c[0] === 'chown' || (c[0] === 'sudo' && (c[1] as string[])?.includes('chown')),
        );
        expect(chownCalls).toHaveLength(0);
        expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/agent-1', {
          recursive: true,
          force: true,
        });
      } finally {
        process.kill = origKill;
      }
    });

    it('handles arm64 (SendCtrlAltDel failure) gracefully', async () => {
      const { backend, mockIpAllocator } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);

      // SendCtrlAltDel fails on arm64
      mockSendCtrlAltDel.mockRejectedValue(new Error('action not supported on arm64'));
      mockReadFile.mockResolvedValue('12345');

      // Mock process.kill to simulate dead VM
      const origKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as any;

      try {
        // Should not throw despite SendCtrlAltDel failure
        await backend.destroy('agent-1');

        expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-1');
        expect(backend.getActiveCount()).toBe(0);
      } finally {
        process.kill = origKill;
      }
    });

    it('handles already-dead VM (no process to kill)', async () => {
      const { backend } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);

      // PID file doesn't exist
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      await backend.destroy('agent-1');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('handles non-existent managed ID gracefully', async () => {
      const { backend } = createBackend();
      // Should not throw
      await backend.destroy('non-existent');
    });

    it('removes per-TAP nftables rules on destroy', async () => {
      const { backend } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockPidFile('12345');
      mockRemoveIsolationRules.mockResolvedValue(undefined);

      const origKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as any;

      try {
        await backend.destroy('agent-1');
        expect(mockRemoveIsolationRules).toHaveBeenCalledWith('10.0.0.2', {
          requireSudo: false,
          table: 'kici',
        });
      } finally {
        process.kill = origKill;
      }
    });
  });

  describe('reapUnowned()', () => {
    /** A directory `stat` result — only `isDirectory()` is read. */
    const dirStat = { isDirectory: () => true };

    function withMockedKill<T>(kill: ReturnType<typeof vi.fn>, body: () => Promise<T>): Promise<T> {
      const origKill = process.kill;
      process.kill = kill as never;
      return body().finally(() => {
        process.kill = origKill;
      });
    }

    it('reclaims a VM whose chroot is on this host but which the backend no longer tracks', async () => {
      // The leak: an orchestrator restart empties the in-memory agent map, so
      // `destroy()` returns at its first line while the VM keeps running, and
      // `cleanupOrphans()` skips it too because its jailer process is alive.
      const { backend, mockIpAllocator } = createBackend();
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockPidFile('12345');
      mockIpAllocator.getAllocationForVm.mockResolvedValue({
        ip: '10.0.0.2',
        vm_id: 'scaler-firecracker-deadbeef',
        scaler_name: 'test-fc',
        tap_device: 'kici-aaaaaaaa',
        mac_address: '06:00:AC:00:00:02',
      });
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () =>
        backend.reapUnowned('scaler-firecracker-deadbeef'),
      );

      expect(reaped).toBe(true);
      expect(kill).toHaveBeenCalledWith(12345, 'SIGKILL');
      expect(mockRemoveIsolationRules).toHaveBeenCalledWith('10.0.0.2', expect.anything());
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-aaaaaaaa'],
        expect.anything(),
        expect.anything(),
      );
      expect(mockIpAllocator.release).toHaveBeenCalledWith('scaler-firecracker-deadbeef');
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/scaler-firecracker-deadbeef', {
        recursive: true,
        force: true,
      });
    });

    it('touches nothing when this host carries no artifact for the id', async () => {
      // THE DANGEROUS DIRECTION. On an HA cluster a refused agent's VM lives on
      // whichever host spawned it, and the coordinator it happens to reach may
      // not be that host. Reclaiming on a bare id would let one coordinator's
      // refusal destroy a peer's live VM — so the on-host artifact is the only
      // thing that authorizes the reap.
      const { backend, mockIpAllocator } = createBackend();
      // mockStat rejects ENOENT and getAllocationForVm resolves null by default.
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () =>
        backend.reapUnowned('scaler-firecracker-elsewhere'),
      );

      expect(reaped).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
      expect(mockRemoveIsolationRules).not.toHaveBeenCalled();
    });

    it('never acts on an allocation row alone, which a peer coordinator shares', async () => {
      // THE SAME DANGEROUS DIRECTION, by the other route. An HA pair is "two
      // identical orchestrators sharing the same PostgreSQL, scalers, and
      // routing key", so a peer's LIVE VM has a row in this same table naming
      // this same scaler. Releasing it hands its address to the next VM — two
      // guests on one IP, sharing the saddr-keyed rules that separate them. The
      // chroot is the only artifact that places a VM on this host.
      const { backend, mockIpAllocator } = createBackend();
      // No chroot here: mockStat rejects ENOENT by default.
      mockIpAllocator.getAllocationForVm.mockResolvedValue({
        ip: '10.0.0.9',
        vm_id: 'scaler-firecracker-peer',
        scaler_name: 'test-fc',
        tap_device: 'kici-bbbbbbbb',
        mac_address: '06:00:AC:00:00:09',
      });
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () =>
        backend.reapUnowned('scaler-firecracker-peer'),
      );

      expect(reaped).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
      expect(mockRemoveIsolationRules).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('leaves a second scaler on this host holding its own IP', async () => {
      // The chroot authorizes the VM teardown, but the IP space belongs to
      // whichever scaler allocated it, and that scaler runs its own teardown.
      const { backend, mockIpAllocator } = createBackend();
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockIpAllocator.getAllocationForVm.mockResolvedValue({
        ip: '10.0.0.9',
        vm_id: 'scaler-firecracker-other',
        scaler_name: 'some-other-fc',
        tap_device: 'kici-bbbbbbbb',
        mac_address: '06:00:AC:00:00:09',
      });
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () =>
        backend.reapUnowned('scaler-firecracker-other'),
      );

      expect(reaped).toBe(true);
      expect(kill).toHaveBeenCalledWith(12345, 'SIGKILL');
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
      expect(mockRemoveIsolationRules).not.toHaveBeenCalled();
    });

    it('never signals PID 0 read from a truncated PID file', async () => {
      // Same guard as `destroy()`: killing 0 kills this orchestrator's own
      // process group. The chroot teardown still runs.
      const { backend } = createBackend();
      mockStat.mockResolvedValue(dirStat);
      mockReadFile.mockResolvedValue('0');
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () =>
        backend.reapUnowned('scaler-firecracker-truncated'),
      );

      expect(reaped).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/scaler-firecracker-truncated', {
        recursive: true,
        force: true,
      });
    });

    it('defers to destroy() while the backend still tracks the agent', async () => {
      // A tracked agent has a live TAP and IP that `destroy()` holds; reaping
      // underneath it would race that teardown.
      const { backend, mockIpAllocator } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');

      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockStat.mockResolvedValue(dirStat);
      const kill = vi.fn();

      const reaped = await withMockedKill(kill, () => backend.reapUnowned('agent-1'));

      expect(reaped).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });
  });

  describe('shutdownAll()', () => {
    it('destroys all managed agents', async () => {
      const { backend, mockIpAllocator } = createBackend();

      // Track different allocations for each spawn
      const alloc1: IpAllocationResult = {
        ip: '10.0.0.2',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:02',
        tapDevice: 'kici-aaaaaaaa',
      };
      const alloc2: IpAllocationResult = {
        ip: '10.0.0.3',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:03',
        tapDevice: 'kici-bbbbbbbb',
      };
      mockIpAllocator.allocate.mockResolvedValueOnce(alloc1).mockResolvedValueOnce(alloc2);

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');
      await backend.spawn(
        ['linux', 'firecracker', 'node20'],
        'agent-2',
        'ws://localhost:8080/ws/agent',
      );

      expect(backend.getActiveCount()).toBe(2);

      // Mock process.kill for destroy
      const origKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as any;

      try {
        await backend.shutdownAll();
        expect(backend.getActiveCount()).toBe(0);
        expect(mockIpAllocator.release).toHaveBeenCalledTimes(2);
      } finally {
        process.kill = origKill;
      }
    });
  });

  describe('clearAgentMmds()', () => {
    it('calls clearMmds on the FirecrackerApi for the agent socket path', async () => {
      const { backend } = createBackend();

      await backend.clearAgentMmds('agent-1');

      expect(mockClearMmds).toHaveBeenCalledOnce();
    });

    it('does not throw when clearMmds fails (non-fatal)', async () => {
      const { backend } = createBackend();
      mockClearMmds.mockRejectedValueOnce(new Error('socket not found'));

      // Should not throw
      await backend.clearAgentMmds('agent-1');
    });
  });

  describe('reload()', () => {
    it('validates rootfsPath requirement', () => {
      const { backend } = createBackend();
      const result = backend.reload([
        { labels: ['linux', 'fc'], rootfsPath: '/opt/rootfs/valid.ext4' },
        { labels: ['linux', 'fc', 'node20'] }, // Missing rootfsPath
      ]);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("'rootfsPath'");
      }
    });

    it('accepts valid label sets with rootfsPath', () => {
      const { backend } = createBackend();
      const result = backend.reload([
        { labels: ['linux', 'fc'], rootfsPath: '/opt/rootfs/valid.ext4' },
      ]);
      expect(result.valid).toBe(true);
    });

    it('updates label sets on successful reload', () => {
      const { backend } = createBackend();
      const newLabelSets: LabelSetConfig[] = [
        { labels: ['linux', 'new'], rootfsPath: '/opt/rootfs/new.ext4' },
      ];
      backend.reload(newLabelSets);
      expect(backend.labelSets).toEqual(newLabelSets);
    });

    it('applies a new maxAgents on reload', () => {
      const { backend } = createBackend();
      expect(backend.maxAgents).toBe(5);

      const result = backend.reload(
        [{ labels: ['linux', 'new'], rootfsPath: '/opt/rootfs/n.ext4' }],
        { maxAgents: 9 },
      );

      expect(result.valid).toBe(true);
      expect(backend.maxAgents).toBe(9);
    });

    it('keeps the current maxAgents when the opts argument is omitted', () => {
      const { backend } = createBackend();
      backend.reload([{ labels: ['linux', 'new'], rootfsPath: '/opt/rootfs/n.ext4' }]);
      expect(backend.maxAgents).toBe(5);
    });

    it('leaves maxAgents untouched when the new label sets are invalid', () => {
      const { backend } = createBackend();
      const result = backend.reload([{ labels: ['linux', 'node20'] }], { maxAgents: 9 });

      expect(result.valid).toBe(false);
      expect(backend.maxAgents).toBe(5);
    });
  });

  describe('cleanupOrphans()', () => {
    it('releases stale IPs and cleans stale directories', async () => {
      const { backend, mockIpAllocator } = createBackend();

      // DB has an allocation for a dead VM
      mockIpAllocator.getAllocations.mockResolvedValueOnce([
        {
          ip: '10.0.0.5',
          vm_id: 'dead-vm-1',
          scaler_name: 'test-fc',
          tap_device: 'kici-deadvm01',
          mac_address: '06:00:AC:00:00:05',
          allocated_at: new Date(),
        },
      ]);

      // Neither chroot is backed by a running process (both VMs are dead).
      mockDeadPidFiles();

      // Filesystem also has an orphan directory not in DB
      mockReaddir.mockResolvedValueOnce(['dead-vm-1', 'orphan-dir-1']);

      const cleaned = await backend.cleanupOrphans();

      // DB orphan: TAP deleted + IP released + chroot cleaned
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-deadvm01'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockIpAllocator.release).toHaveBeenCalledWith('dead-vm-1');

      // Filesystem orphan: directory cleaned
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/orphan-dir-1', {
        recursive: true,
        force: true,
      });

      // 1 DB orphan + 1 filesystem orphan = 2
      expect(cleaned).toBe(2);
    });

    it('reclaims filesystem-orphan chroot ownership via sudo chown before rm on rootless nodes', async () => {
      const { backend, mockIpAllocator } = createBackend({ requireSudo: true });

      // No DB allocations — the chroot dir is a pure filesystem orphan (Pass 2),
      // backed by no running process.
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValueOnce(['orphan-dir-1']);
      mockDeadPidFiles();

      const cleaned = await backend.cleanupOrphans();

      expect(mockExecFile).toHaveBeenCalledWith(
        'sudo',
        [
          '-n',
          'chown',
          '-R',
          `${process.getuid!()}:${process.getgid!()}`,
          '/srv/jailer/firecracker/orphan-dir-1',
        ],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/orphan-dir-1', {
        recursive: true,
        force: true,
      });
      expect(cleaned).toBe(1);
    });

    it('skips allocations for other scalers', async () => {
      const { backend, mockIpAllocator } = createBackend();

      mockIpAllocator.getAllocations.mockResolvedValueOnce([
        {
          ip: '10.0.0.5',
          vm_id: 'other-scaler-vm',
          scaler_name: 'other-scaler',
          tap_device: 'kici-othervm0',
          mac_address: '06:00:AC:00:00:05',
          allocated_at: new Date(),
        },
      ]);

      mockReaddir.mockResolvedValueOnce([]);

      const cleaned = await backend.cleanupOrphans();
      expect(cleaned).toBe(0);
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
    });

    it('returns 0 when no orphans exist', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValueOnce([]);
      mockReaddir.mockResolvedValueOnce([]);

      const cleaned = await backend.cleanupOrphans();
      expect(cleaned).toBe(0);
    });

    it('Pass 3: deletes orphan TAP devices, skips protected bridges and DB-allocated TAPs', async () => {
      const { backend, mockIpAllocator } = createBackend();

      mockIpAllocator.getAllocations.mockResolvedValueOnce([
        {
          ip: '10.0.0.5',
          vm_id: 'live-vm',
          scaler_name: 'test-fc',
          tap_device: 'kici-aaaaaaaa',
          mac_address: '06:00:AC:00:00:05',
          allocated_at: new Date(),
        },
      ]);
      // PID file read returns the current process PID -> isVmProcessAlive() returns true,
      // so DB allocation is considered live and not cleaned in Pass 1.
      mockPidFile(String(process.pid));
      mockReaddir.mockResolvedValueOnce([]);

      // Feed fake `ip -br link` output: 2 orphan TAPs, protected bridges, live DB TAP, and a non-matching iface
      const ipBrLinkOutput =
        'kici-br0            UP             06:00:00:00:00:01 <BROADCAST,MULTICAST,UP,LOWER_UP>\n' +
        'kici-br1            UP             06:00:00:00:00:02 <BROADCAST,MULTICAST,UP,LOWER_UP>\n' +
        'kici-m01            DOWN           06:00:00:00:00:03 <BROADCAST,MULTICAST>\n' +
        'kici-aaaaaaaa       UP             06:00:AC:00:00:05 <BROADCAST,MULTICAST,UP,LOWER_UP>\n' +
        'kici-deadbeef       DOWN           06:00:00:00:00:04 <NO-CARRIER,BROADCAST,MULTICAST>\n' +
        'kici-cafebabe       DOWN           06:00:00:00:00:05 <NO-CARRIER,BROADCAST,MULTICAST>\n' +
        'eth0                UP             aa:bb:cc:dd:ee:ff <BROADCAST,MULTICAST,UP,LOWER_UP>\n';

      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        if (cmd === 'ip' && args[0] === '-br' && args[1] === 'link') {
          callback(null, { stdout: ipBrLinkOutput, stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const cleaned = await backend.cleanupOrphans();

      // Only kici-deadbeef and kici-cafebabe are orphan TAPs
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-deadbeef'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-cafebabe'],
        expect.any(Object),
        expect.any(Function),
      );
      // Protected bridges and DB-allocated TAP are NOT deleted
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-br0'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-br1'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-m01'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-aaaaaaaa'],
        expect.any(Object),
        expect.any(Function),
      );
      // eth0 doesn't match VM_TAP_PATTERN
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'eth0'],
        expect.any(Object),
        expect.any(Function),
      );

      expect(cleaned).toBe(2);
    });

    it('Pass 3: tolerates `ip` command failure', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValueOnce([]);
      mockReaddir.mockResolvedValueOnce([]);

      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        if (cmd === 'ip' && args[0] === '-br' && args[1] === 'link') {
          callback(new Error('ip not found'), { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      await expect(backend.cleanupOrphans()).resolves.toBe(0);
    });

    it('Pass 3 race protection: re-reads allocations after listing interfaces', async () => {
      // Simulates the narrow race where a spawn's `allocate()` lands AFTER
      // cleanupOrphans has already read the DB but BEFORE it lists interfaces
      // (since `allocate()` happens before `ip tuntap add` in spawn(), any
      // TAP on the host must have a DB row by the time it's visible).
      const { backend, mockIpAllocator } = createBackend();

      // First DB read: empty (spawn's allocate() hasn't landed yet).
      mockIpAllocator.getAllocations.mockResolvedValueOnce([]);
      mockReaddir.mockResolvedValueOnce([]);

      // Second DB read (Pass 3 re-read, after listing interfaces): the new
      // spawn's allocation is now visible. The race-protection branch kicks
      // in and the newly-spawned TAP is NOT deleted.
      mockIpAllocator.getAllocations.mockResolvedValueOnce([
        {
          ip: '10.0.0.6',
          vm_id: 'fresh-spawn',
          scaler_name: 'test-fc',
          tap_device: 'kici-freshvm0',
          mac_address: '06:00:AC:00:00:06',
          allocated_at: new Date(),
        },
      ]);

      const ipBrLinkOutput =
        'kici-freshvm0      DOWN           06:00:AC:00:00:06 <NO-CARRIER,BROADCAST,MULTICAST>\n';

      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        if (cmd === 'ip' && args[0] === '-br' && args[1] === 'link') {
          callback(null, { stdout: ipBrLinkOutput, stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const cleaned = await backend.cleanupOrphans();

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-freshvm0'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(cleaned).toBe(0);
    });

    it('skips in-memory tracked TAP devices even when DB re-read fails', async () => {
      // Belt-and-suspenders: an agent in this.agents with a set tapDevice
      // must never have its TAP deleted, even if both DB reads miss it.
      const { backend, mockIpAllocator } = createBackend();

      // First spawn a real agent so this.agents has a tapDevice entry.
      await backend.spawn(['linux', 'firecracker'], 'live-agent', 'ws://localhost:8080/ws/agent');

      // cleanupOrphans() reads the DB twice — return empty both times.
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([]);

      // The spawned agent's tap is visible on the host.
      const ipBrLinkOutput =
        'kici-aaaaaaaa      UP             06:00:AC:00:00:02 <BROADCAST,MULTICAST,UP,LOWER_UP>\n';

      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        if (cmd === 'ip' && args[0] === '-br' && args[1] === 'link') {
          callback(null, { stdout: ipBrLinkOutput, stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const cleaned = await backend.cleanupOrphans();

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', 'kici-aaaaaaaa'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(cleaned).toBe(0);
    });

    it('never reaps a live VM (PID alive) even with empty DB + empty tracking', async () => {
      const { backend, mockIpAllocator } = createBackend();

      // No DB allocations and no in-memory tracking: a naive reap would treat
      // every chroot/TAP as an orphan. The liveness pre-scan must protect the
      // live VM.
      mockIpAllocator.getAllocations.mockResolvedValue([]);

      // A realistic scaler-minted id: `generateAgentId` produces
      // `scaler-firecracker-<8 hex>`, so its TAP is the LAST 8 characters.
      const liveVmId = 'scaler-firecracker-a1b2c3d4';
      // Imported dynamically: a static value import of ip-allocator pulls
      // node:child_process into the graph before the mock consts initialize.
      const { generateTapName } = await import('./ip-allocator.js');
      const liveTap = generateTapName(liveVmId); // kici-a1b2c3d4
      // The name the buggy first-8 derivation would have produced. It also has
      // to satisfy VM_TAP_PATTERN, or Pass 3 would skip it before ever
      // consulting the live-TAP guard and the negative control would be vacuous.
      const wrongSliceTap = 'kici-deadbeef';

      // Chroot parent holds one live VM dir and one dead orphan dir.
      // (Single readdir — the pre-scan and Pass 2 share it.)
      mockReaddir.mockResolvedValue([liveVmId, 'dead-vm-1']);

      // Liveness pre-scan reads each VM's firecracker.pid:
      //  - the live VM -> our own pid (alive)
      //  - dead-vm-1   -> ENOENT (dead)
      mockReadFile.mockImplementation(async (p: string) => {
        if (String(p).startsWith('/proc/')) return procStatLine();
        if (p.includes(liveVmId)) return `${process.pid}`;
        throw new Error('ENOENT');
      });

      // Host has the live VM's real TAP and one orphan TAP.
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        if (cmd === 'ip' && args[0] === '-br') {
          cb(null, { stdout: `${liveTap}\n${wrongSliceTap}\n`, stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      await backend.cleanupOrphans();

      // Live VM's chroot must NOT be removed.
      expect(mockRm).not.toHaveBeenCalledWith(
        `/srv/jailer/firecracker/${liveVmId}`,
        expect.anything(),
      );
      // Dead orphan's chroot IS removed.
      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/dead-vm-1', {
        recursive: true,
        force: true,
      });
      // Live VM's TAP must NOT be deleted.
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ip',
        ['link', 'del', liveTap],
        expect.any(Object),
        expect.any(Function),
      );
      // Negative control: a TAP that is NOT any live VM's must still be
      // reaped. Without it the assertion above passes on a guard that spares
      // everything.
      expect(mockExecFile).toHaveBeenCalledWith(
        'ip',
        ['link', 'del', wrongSliceTap],
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('startPeriodicOrphanSweep() / stopPeriodicOrphanSweep()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('invokes cleanupOrphans on the configured interval', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
        if (cmd === 'ip' && args[0] === '-br' && args[1] === 'link') {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const cleanupSpy = vi.spyOn(backend, 'cleanupOrphans');

      backend.startPeriodicOrphanSweep(1000);
      expect(cleanupSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(cleanupSpy).toHaveBeenCalledTimes(3);

      backend.stopPeriodicOrphanSweep();

      await vi.advanceTimersByTimeAsync(5000);
      expect(cleanupSpy).toHaveBeenCalledTimes(3); // no more ticks
    });

    it('is idempotent — second start is a no-op', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const cleanupSpy = vi.spyOn(backend, 'cleanupOrphans');

      backend.startPeriodicOrphanSweep(1000);
      backend.startPeriodicOrphanSweep(1000); // ignored

      await vi.advanceTimersByTimeAsync(1000);
      // Exactly one timer, not two — would be 2 if the second start had created a second interval
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      backend.stopPeriodicOrphanSweep();
    });

    it('stop is safe to call without a running timer', () => {
      const { backend } = createBackend();
      expect(() => backend.stopPeriodicOrphanSweep()).not.toThrow();
      expect(() => backend.stopPeriodicOrphanSweep()).not.toThrow();
    });

    it('guards against re-entrant sweeps when one takes longer than the interval', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        callback(null, { stdout: '', stderr: '' });
      });

      // Make cleanupOrphans take longer than the interval.
      let resolveSlow!: () => void;
      const slow = new Promise<number>((resolve) => {
        resolveSlow = () => resolve(0);
      });
      const cleanupSpy = vi.spyOn(backend, 'cleanupOrphans').mockReturnValue(slow);

      backend.startPeriodicOrphanSweep(100);

      // Fire multiple interval ticks while cleanupOrphans is still pending.
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      // Only one invocation should have been started; the re-entrant guard
      // drops the overlapping ticks.
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      // Complete the slow run and let the next tick fire.
      resolveSlow();
      await slow;
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupSpy).toHaveBeenCalledTimes(2);

      backend.stopPeriodicOrphanSweep();
    });

    it('shutdownAll stops the periodic sweep timer', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const cleanupSpy = vi.spyOn(backend, 'cleanupOrphans');

      backend.startPeriodicOrphanSweep(1000);
      await backend.shutdownAll();
      await vi.advanceTimersByTimeAsync(5000);

      expect(cleanupSpy).not.toHaveBeenCalled();
    });
  });

  describe('getActiveCount()', () => {
    it('returns correct count', async () => {
      const { backend, mockIpAllocator } = createBackend();
      expect(backend.getActiveCount()).toBe(0);

      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');
      expect(backend.getActiveCount()).toBe(1);

      // Provide a second allocation for the second spawn
      mockIpAllocator.allocate.mockResolvedValueOnce({
        ip: '10.0.0.3',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:03',
        tapDevice: 'kici-bbbbbbbb',
      });
      await backend.spawn(
        ['linux', 'firecracker', 'node20'],
        'agent-2',
        'ws://localhost:8080/ws/agent',
      );
      expect(backend.getActiveCount()).toBe(2);
    });
  });

  describe('buildVmConfig()', () => {
    it('generates correct JSON structure', () => {
      const { backend } = createBackend();

      const alloc: IpAllocationResult = {
        ip: '10.0.0.5',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:05',
        tapDevice: 'kici-testvm01',
      };

      const labelSetConfig: LabelSetConfig = {
        labels: ['linux', 'firecracker'],
        rootfsPath: '/opt/rootfs/ubuntu.ext4',
        vcpuCount: 4,
        memSizeMib: 2048,
      };

      const config = backend.buildVmConfig(alloc, labelSetConfig);

      expect(config).toEqual({
        'boot-source': {
          kernel_image_path: '/kernel',
          boot_args:
            'console=ttyS0 reboot=k panic=1 random.trust_cpu=on init=/init ip=10.0.0.5::10.0.0.1:255.255.255.0::eth0:off',
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
          vcpu_count: 4,
          mem_size_mib: 2048,
          smt: false,
        },
        'network-interfaces': [
          {
            iface_id: 'eth0',
            guest_mac: '06:00:AC:00:00:05',
            host_dev_name: 'kici-testvm01',
          },
        ],
        'mmds-config': {
          network_interfaces: ['eth0'],
          ipv4_address: '169.254.169.254',
        },
      });
    });

    it('uses scaler defaults when label set has no overrides', () => {
      const { backend } = createBackend();

      const alloc: IpAllocationResult = {
        ip: '10.0.0.5',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:05',
        tapDevice: 'kici-testvm01',
      };

      const labelSetConfig: LabelSetConfig = {
        labels: ['linux', 'firecracker'],
        rootfsPath: '/opt/rootfs/ubuntu.ext4',
        // No vcpuCount or memSizeMib overrides
      };

      const config = backend.buildVmConfig(alloc, labelSetConfig) as any;

      expect(config['machine-config'].vcpu_count).toBe(2);
      expect(config['machine-config'].mem_size_mib).toBe(512);
    });

    it('overrides vcpu_count and mem_size_mib from effectiveLimits when provided', () => {
      const { backend } = createBackend();

      const alloc: IpAllocationResult = {
        ip: '10.0.0.5',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:05',
        tapDevice: 'kici-testvm01',
      };

      const labelSetConfig: LabelSetConfig = {
        labels: ['linux', 'firecracker'],
        rootfsPath: '/opt/rootfs/ubuntu.ext4',
        vcpuCount: 4,
        memSizeMib: 2048,
      };

      // Override with effective limits resolved by ScalerManager
      const config = backend.buildVmConfig(alloc, labelSetConfig, {
        cpus: 1,
        memBytes: 1024 * 1024 * 1024, // 1 GiB = 1024 MiB
      }) as any;

      expect(config['machine-config'].vcpu_count).toBe(1);
      expect(config['machine-config'].mem_size_mib).toBe(1024);
    });

    it('rounds fractional cpu request up to nearest integer (Firecracker requires integer vCPU)', () => {
      const { backend } = createBackend();

      const alloc: IpAllocationResult = {
        ip: '10.0.0.5',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:05',
        tapDevice: 'kici-testvm01',
      };

      const labelSetConfig: LabelSetConfig = {
        labels: ['linux', 'firecracker'],
        rootfsPath: '/opt/rootfs/ubuntu.ext4',
      };

      // 0.5 cpus -> rounds up to 1 vCPU
      const config = backend.buildVmConfig(alloc, labelSetConfig, {
        cpus: 0.5,
        memBytes: 512 * 1024 * 1024,
      }) as any;

      expect(config['machine-config'].vcpu_count).toBe(1);
      expect(config['machine-config'].mem_size_mib).toBe(512);
    });

    it('falls back to label-set/scaler values when effectiveLimits has zero/missing fields', () => {
      const { backend } = createBackend();

      const alloc: IpAllocationResult = {
        ip: '10.0.0.5',
        gateway: '10.0.0.1',
        netmask: '255.255.255.0',
        mac: '06:00:AC:00:00:05',
        tapDevice: 'kici-testvm01',
      };

      const labelSetConfig: LabelSetConfig = {
        labels: ['linux', 'firecracker'],
        rootfsPath: '/opt/rootfs/ubuntu.ext4',
        vcpuCount: 4,
        memSizeMib: 2048,
      };

      const config = backend.buildVmConfig(alloc, labelSetConfig, {
        cpus: 0,
        memBytes: 0,
      }) as any;

      // Zero / missing -> keep label-set values
      expect(config['machine-config'].vcpu_count).toBe(4);
      expect(config['machine-config'].mem_size_mib).toBe(2048);
    });
  });

  describe('type', () => {
    it('returns "firecracker"', () => {
      const { backend } = createBackend();
      expect(backend.type).toBe('firecracker');
    });
  });

  describe('getSocketPath()', () => {
    it('returns correct socket path', () => {
      const { backend } = createBackend();
      expect(backend.getSocketPath('agent-1')).toBe(
        '/srv/jailer/firecracker/agent-1/root/run/firecracker.socket',
      );
    });
  });

  describe('getChrootDir()', () => {
    it('returns correct chroot directory', () => {
      const { backend } = createBackend();
      expect(backend.getChrootDir('agent-1')).toBe('/srv/jailer/firecracker/agent-1/root');
    });
  });

  describe('constructor defaults', () => {
    it('uses default chrootBaseDir /srv/jailer when not specified', () => {
      const { backend } = createBackend({ chrootBaseDir: undefined });
      expect(backend.getSocketPath('test')).toContain('/srv/jailer/');
    });

    it('uses custom chrootBaseDir when specified', () => {
      const { backend } = createBackend({ chrootBaseDir: '/custom/jailer' });
      expect(backend.getSocketPath('test')).toBe(
        '/custom/jailer/firecracker/test/root/run/firecracker.socket',
      );
    });
  });

  describe('ensureHostReady', () => {
    const healthy: BridgeHealth = {
      bridgeName: 'kici-br0',
      bridgeExists: true,
      bridgeUp: true,
      addrPresent: true,
      tablePresent: true,
      baselineChainPresent: true,
      tapIsolationPresent: true,
      healthy: true,
      detail: 'healthy',
    };
    const unhealthy: BridgeHealth = {
      ...healthy,
      healthy: false,
      tablePresent: false,
      detail: 'nft table missing',
    };

    it('is a no-op when autoProvisionHost is false', async () => {
      const verifyBridgeFn = vi.fn(async () => unhealthy);
      const provisionBridgeFn = vi.fn(async () => {});
      const { backend } = createBackend({
        autoProvisionHost: false,
        verifyBridgeFn,
        provisionBridgeFn,
      });
      await backend.ensureHostReady();
      expect(verifyBridgeFn).not.toHaveBeenCalled();
      expect(provisionBridgeFn).not.toHaveBeenCalled();
    });

    it('does not provision when the bridge is already healthy', async () => {
      const verifyBridgeFn = vi.fn(async () => healthy);
      const provisionBridgeFn = vi.fn(async () => {});
      const { backend } = createBackend({
        autoProvisionHost: true,
        verifyBridgeFn,
        provisionBridgeFn,
      });
      await backend.ensureHostReady();
      expect(verifyBridgeFn).toHaveBeenCalledOnce();
      expect(provisionBridgeFn).not.toHaveBeenCalled();
    });

    it('provisions with the bridge config + requireSudo when unhealthy', async () => {
      const verifyBridgeFn = vi.fn(async () => unhealthy);
      const provisionBridgeFn = vi.fn(async () => {});
      const { backend } = createBackend({
        autoProvisionHost: true,
        requireSudo: true,
        verifyBridgeFn,
        provisionBridgeFn,
      });
      await backend.ensureHostReady();
      expect(provisionBridgeFn).toHaveBeenCalledOnce();
      const [cfg, opts] = provisionBridgeFn.mock.calls[0];
      expect(cfg).toMatchObject({
        bridgeName: 'kici-br0',
        bridgeCidr: '10.0.0.1/24',
        table: 'kici',
      });
      expect(opts).toMatchObject({ requireSudo: true });
    });

    it('propagates a provision failure (manager decides degraded)', async () => {
      const verifyBridgeFn = vi.fn(async () => unhealthy);
      const provisionBridgeFn = vi.fn(async () => {
        throw new Error('sudo: a password is required');
      });
      const { backend } = createBackend({
        autoProvisionHost: true,
        verifyBridgeFn,
        provisionBridgeFn,
      });
      await expect(backend.ensureHostReady()).rejects.toThrow(/password is required/);
    });
  });
  describe('PID identity (readVmPid)', () => {
    // `destroy()` is the observable surface: it SIGKILLs the PID only when the
    // number is provably still this VM's own firecracker process. Acting on the
    // raw number lets PID reuse point a root-privileged SIGKILL at an arbitrary
    // host process.
    const dirStat = { isDirectory: () => true, mtimeMs: Date.now() };

    function withMockedKill<T>(kill: ReturnType<typeof vi.fn>, body: () => Promise<T>): Promise<T> {
      const origKill = process.kill;
      process.kill = kill as never;
      return body().finally(() => {
        process.kill = origKill;
      });
    }

    async function destroyWithProc(
      readFileImpl: (p: string) => Promise<string>,
      kill: ReturnType<typeof vi.fn>,
      readlinkImpl?: (p: string) => Promise<string>,
    ): Promise<void> {
      const { backend } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-1', 'ws://localhost:8080/ws/agent');
      vi.clearAllMocks();
      mockExecFile.mockImplementation(defaultExecFileImpl);
      mockReadFile.mockImplementation(readFileImpl);
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      if (readlinkImpl) {
        mockReadlink.mockImplementation(readlinkImpl);
      } else {
        mockReadlink.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      await withMockedKill(kill, () => backend.destroy('agent-1'));
    }

    it('kills a PID whose /proc entry matches comm and start time', async () => {
      const kill = vi.fn();
      await destroyWithProc(
        async (p) => (String(p).startsWith('/proc/') ? procStatLine('firecracker') : '4242'),
        kill,
      );
      expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('refuses to kill a recycled PID now owned by another program', async () => {
      const kill = vi.fn();
      await destroyWithProc(
        async (p) => (String(p).startsWith('/proc/') ? procStatLine('postgres') : '4242'),
        kill,
      );
      expect(kill).not.toHaveBeenCalled();
    });

    it('refuses to kill a PID that started after the PID file naming it was written', async () => {
      // The PID file's mtime is now; a process that started a minute into the
      // future cannot be the one it names.
      const kill = vi.fn();
      await destroyWithProc(
        async (p) =>
          String(p).startsWith('/proc/') ? procStatLine('firecracker', -5 * 60_000) : '4242',
        kill,
      );
      expect(kill).not.toHaveBeenCalled();
    });

    it('refuses to kill a firecracker process rooted in another VM chroot', async () => {
      const kill = vi.fn();
      await destroyWithProc(
        async (p) => (String(p).startsWith('/proc/') ? procStatLine('firecracker') : '4242'),
        kill,
        async () => '/srv/jailer/firecracker/some-other-vm/root',
      );
      expect(kill).not.toHaveBeenCalled();
    });

    it('still kills when /proc/<pid>/root is unreadable under the jailer uid drop', async () => {
      // EACCES is not evidence either way; comm + start time already carry the
      // identity, and failing closed here would leak every VM on a rootless host.
      const kill = vi.fn();
      await destroyWithProc(
        async (p) => (String(p).startsWith('/proc/') ? procStatLine('firecracker') : '4242'),
        kill,
        async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      );
      expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('reads a VM whose /proc entry is gone as dead, so its chroot is reclaimed', async () => {
      const { backend, mockIpAllocator } = createBackend();
      // A stale PID file naming a number the kernel has since handed out, but
      // whose /proc entry does not exist at all.
      mockReadFile.mockImplementation(async (p: string) => {
        if (String(p).startsWith('/proc/')) throw new Error('ENOENT');
        return '4242';
      });
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue(['stale-vm']);
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        cb(null, { stdout: cmd === 'ip' && args[0] === '-br' ? '' : '', stderr: '' });
      });

      await backend.cleanupOrphans();

      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/stale-vm', {
        recursive: true,
        force: true,
      });
    });
  });
  // The reap guard asks a DIFFERENT question from the kill guard above: not
  // "may I signal this PID?" but "may I delete the files under a PID that is
  // still running?". The safe answer inverts between them, so an identity the
  // kill path refuses to act on must still spare the chroot.
  describe('reap liveness guard (a running PID this backend cannot identify)', () => {
    const dirStat = { isDirectory: () => true, mtimeMs: Date.now() };

    /**
     * One chroot dir named `vmId`, whose `firecracker.pid` holds `4242` and
     * whose `/proc/4242/stat` is `stat`. Empty DB, empty tracking — the
     * standalone-reap shape.
     */
    async function reapWith(
      vmId: string,
      stat: string,
    ): Promise<ReturnType<typeof createBackend>['backend']> {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue([vmId]);
      mockReadFile.mockImplementation(async (p: string) =>
        String(p).startsWith('/proc/') ? stat : '4242',
      );
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        cb(null, { stdout: cmd === 'ip' && args[0] === '-br' ? '' : '', stderr: '' });
      });
      await backend.cleanupOrphans();
      return backend;
    }

    it('spares the chroot of a running PID whose comm is not firecracker', async () => {
      // A live process the identity checks cannot claim — the shape a jailer
      // wrapper, a renamed binary, or a `comm` this backend does not recognise
      // produces. Deleting the rootfs out from under it corrupts a running
      // tenant; leaving it costs disk.
      await reapWith('unidentified-vm', procStatLine('MainThread'));

      expect(mockRm).not.toHaveBeenCalledWith(
        '/srv/jailer/firecracker/unidentified-vm',
        expect.anything(),
      );
    });

    it('spares the chroot of a running firecracker rooted somewhere else', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue(['elsewhere-vm']);
      mockReadFile.mockImplementation(async (p: string) =>
        String(p).startsWith('/proc/') ? procStatLine('firecracker') : '4242',
      );
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockReadlink.mockResolvedValue('/srv/jailer/firecracker/some-other-vm/root');
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        cb(null, { stdout: cmd === 'ip' && args[0] === '-br' ? '' : '', stderr: '' });
      });

      await backend.cleanupOrphans();

      expect(mockRm).not.toHaveBeenCalledWith(
        '/srv/jailer/firecracker/elsewhere-vm',
        expect.anything(),
      );
    });

    it('spares a live VM the orchestrator is not privileged to signal', async () => {
      // A rootless node: the jailer runs under `sudo -n`, so firecracker is
      // root-owned while the orchestrator is not. `process.kill(pid, 0)` throws
      // EPERM there — which proves the process EXISTS. A guard that read that
      // throw as death would reap every live VM's chroot on every such host.
      const origKill = process.kill;
      process.kill = ((): never => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }) as never;
      try {
        await reapWith('rootless-vm', procStatLine('firecracker'));
      } finally {
        process.kill = origKill;
      }

      expect(mockRm).not.toHaveBeenCalledWith(
        '/srv/jailer/firecracker/rootless-vm',
        expect.anything(),
      );
    });

    // ── Controls: the guard still reaps everything it should ──────────────
    //
    // Without these, a guard that called every chroot live would pass the
    // sparing assertions above and leak disk forever.

    it('still reaps a chroot whose PID started after the PID file naming it', async () => {
      // The recycled-number case: the kernel handed 4242 to something that
      // started a minute AFTER the file claiming it was written, so the VM
      // that wrote it is gone whatever is running now.
      await reapWith('recycled-vm', procStatLine('MainThread', -5 * 60_000));

      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/recycled-vm', {
        recursive: true,
        force: true,
      });
    });

    it('still reaps a chroot whose PID has no /proc entry at all', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue(['gone-vm']);
      mockReadFile.mockImplementation(async (p: string) => {
        if (String(p).startsWith('/proc/')) throw new Error('ENOENT');
        return '4242';
      });
      mockStat.mockImplementation(async (p: string) =>
        String(p).endsWith('firecracker.pid') ? pidFileStat() : dirStat,
      );
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        cb(null, { stdout: cmd === 'ip' && args[0] === '-br' ? '' : '', stderr: '' });
      });

      await backend.cleanupOrphans();

      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/gone-vm', {
        recursive: true,
        force: true,
      });
    });

    it('still reaps a chroot with no PID file', async () => {
      const { backend, mockIpAllocator } = createBackend();
      mockIpAllocator.getAllocations.mockResolvedValue([]);
      mockReaddir.mockResolvedValue(['nopid-vm']);
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockExecFile.mockImplementation((cmd, args, _o, cb) => {
        cb(null, { stdout: cmd === 'ip' && args[0] === '-br' ? '' : '', stderr: '' });
      });

      await backend.cleanupOrphans();

      expect(mockRm).toHaveBeenCalledWith('/srv/jailer/firecracker/nopid-vm', {
        recursive: true,
        force: true,
      });
    });
  });

  describe('spawn lifecycle (abandoned VMs are not tracked forever)', () => {
    it('releases the IP and drops tracking when the spawn deadline aborts', async () => {
      const { backend, mockIpAllocator } = createBackend();
      // Hang the boot wait so the spawn is still in flight when the manager's
      // deadline fires, which is exactly when the leak happened.
      mockWaitForSocket.mockImplementation(() => new Promise<boolean>(() => {}));
      const controller = new AbortController();

      void backend
        .spawn(
          ['linux', 'firecracker'],
          'agent-hung',
          'ws://localhost:8080/ws/agent',
          undefined,
          undefined,
          undefined,
          controller.signal,
        )
        .catch(() => {
          /* never settles; the deadline is the manager's business */
        });
      // Let the spawn reach the boot wait.
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(backend.getActiveCount()).toBe(1);

      controller.abort();
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(backend.getActiveCount()).toBe(0);
      expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-hung');
    });

    it('tears an aborted spawn down exactly once, not once per path', async () => {
      // The abort listener tears the spawn down, and then the aborted API call
      // rejects so `spawn`'s own catch tears it down again. The allocator
      // recycles the released address and TAP name immediately, so a second
      // teardown deletes the NEXT VM's isolation rules and its TAP by name —
      // the sweep-kills-a-live-workload shape, reached from the spawn path.
      const { backend, mockIpAllocator } = createBackend();
      let failBoot: ((err: Error) => void) | undefined;
      mockWaitForSocket.mockImplementation(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            failBoot = reject;
          }),
      );
      const controller = new AbortController();

      const settled = backend
        .spawn(
          ['linux', 'firecracker'],
          'agent-race',
          'ws://localhost:8080/ws/agent',
          undefined,
          undefined,
          undefined,
          controller.signal,
        )
        .catch(() => 'failed');
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(failBoot, 'spawn never reached the boot wait').toBeTypeOf('function');

      controller.abort();
      failBoot!(new Error('aborted'));
      await settled;
      await new Promise<void>((r) => setTimeout(r, 0));

      const releases = (mockIpAllocator.release as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'agent-race',
      );
      expect(releases).toHaveLength(1);
    });

    it('cleans up and reports failure when the jailer exits during boot', async () => {
      const { backend, mockIpAllocator } = createBackend();
      const events: string[] = [];
      await backend.spawn(
        ['linux', 'firecracker'],
        'agent-panic',
        'ws://localhost:8080/ws/agent',
        (e) => events.push(e.eventType),
      );
      expect(backend.getActiveCount()).toBe(1);
      mockIpAllocator.release.mockClear();

      const exitHandler = mockChildProcess.on.mock.calls.find((c) => c[0] === 'exit')?.[1] as (
        code: number | null,
        sig: string | null,
      ) => void;
      expect(exitHandler).toBeTypeOf('function');

      exitHandler(1, null);
      // The handler defers 500ms so the last serial lines are tailed first.
      await new Promise<void>((r) => setTimeout(r, 600));

      expect(backend.getActiveCount()).toBe(0);
      expect(mockIpAllocator.release).toHaveBeenCalledWith('agent-panic');
      expect(events).toContain('scaler.failed');
    });

    it('leaves a healthy VM tracked when the jailer exits cleanly', async () => {
      // Negative control: `destroy()` ends with a clean exit, and a clean exit
      // must not be read as a boot failure.
      const { backend, mockIpAllocator } = createBackend();
      await backend.spawn(['linux', 'firecracker'], 'agent-ok', 'ws://localhost:8080/ws/agent');
      mockIpAllocator.release.mockClear();

      const exitHandler = mockChildProcess.on.mock.calls.find((c) => c[0] === 'exit')?.[1] as (
        code: number | null,
        sig: string | null,
      ) => void;
      exitHandler(0, null);
      await new Promise<void>((r) => setTimeout(r, 600));

      expect(backend.getActiveCount()).toBe(1);
      expect(mockIpAllocator.release).not.toHaveBeenCalled();
    });
  });
});
