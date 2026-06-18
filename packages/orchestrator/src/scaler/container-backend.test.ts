import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LabelSetConfig } from './types.js';

// Mock node:fs/promises for socket detection tests
const mockAccess = vi.fn();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...args),
  };
});

// Mock nftables module
const mockValidateNftablesAvailability = vi.fn().mockResolvedValue(undefined);
const mockEnsureKiciTable = vi.fn().mockResolvedValue(undefined);
const mockAddIsolationRules = vi.fn().mockResolvedValue(undefined);
const mockRemoveIsolationRules = vi.fn().mockResolvedValue(undefined);
vi.mock('./nftables.js', () => ({
  validateNftablesAvailability: (...args: unknown[]) => mockValidateNftablesAvailability(...args),
  ensureKiciTable: (...args: unknown[]) => mockEnsureKiciTable(...args),
  addIsolationRules: (...args: unknown[]) => mockAddIsolationRules(...args),
  removeIsolationRules: (...args: unknown[]) => mockRemoveIsolationRules(...args),
}));

// Mock dockerode
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);

const mockContainerInspect = vi.fn().mockResolvedValue({
  NetworkSettings: {
    Networks: {
      'kici-agent-net': { IPAddress: '172.30.0.5' },
    },
  },
});

const mockContainer = {
  id: 'container-abc123',
  start: mockStart,
  stop: mockStop,
  remove: mockRemove,
  inspect: mockContainerInspect,
};

const mockCreateContainer = vi.fn().mockResolvedValue(mockContainer);
const mockListContainers = vi.fn().mockResolvedValue([]);
const mockGetContainer = vi.fn().mockReturnValue({
  ...mockContainer,
  inspect: mockContainerInspect,
});
const mockPull = vi.fn().mockResolvedValue('mock-stream');
const mockFollowProgress = vi.fn((_stream: unknown, onFinished: (err: Error | null) => void) => {
  onFinished(null);
});

// Network-related mocks
const mockListNetworks = vi.fn().mockResolvedValue([]);
const mockCreateNetwork = vi.fn().mockResolvedValue({ id: 'net-abc123456789' });
const mockNetworkInspect = vi.fn().mockResolvedValue({
  Id: 'net-abc123456789',
  Options: { 'com.docker.network.bridge.name': 'br-abc123456789' },
});
const mockGetNetwork = vi.fn().mockReturnValue({ inspect: mockNetworkInspect });

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        createContainer: mockCreateContainer,
        listContainers: mockListContainers,
        getContainer: mockGetContainer,
        listNetworks: mockListNetworks,
        createNetwork: mockCreateNetwork,
        getNetwork: mockGetNetwork,
        pull: mockPull,
        modem: {
          followProgress: mockFollowProgress,
        },
      };
    }),
  };
});

// Import after mocking
const { ContainerScalerBackend, detectRuntime } = await import('./container-backend.js');

const defaultLabelSets: LabelSetConfig[] = [
  {
    labels: ['linux', 'docker'],
    image: 'ghcr.io/org/kici-agent:latest',
    resources: { limits: { memory: '2g', cpus: 2 } },
  },
  {
    labels: ['linux', 'node20'],
    image: 'ghcr.io/org/kici-agent-node20:latest',
    containerSocket: true,
    env: { NODE_VERSION: '20' },
  },
];

async function createBackend(
  overrides?: Partial<Parameters<typeof ContainerScalerBackend.create>[0]>,
) {
  return ContainerScalerBackend.create({
    name: 'test-container',
    labelSets: defaultLabelSets,
    maxAgents: 5,
    socketPath: '/var/run/docker.sock',
    ...overrides,
  });
}

describe('ContainerScalerBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContainer.id = 'container-abc123';
    mockContainerInspect.mockResolvedValue({
      NetworkSettings: {
        Networks: {
          'kici-agent-net': { IPAddress: '172.30.0.5' },
        },
      },
    });
    mockCreateContainer.mockResolvedValue(mockContainer);
    mockGetContainer.mockReturnValue({
      ...mockContainer,
      inspect: mockContainerInspect,
    });
    mockListContainers.mockResolvedValue([]);
    // Reset network mocks for isolated network creation
    mockListNetworks.mockResolvedValue([]);
    mockCreateNetwork.mockResolvedValue({ id: 'net-abc123456789' });
    mockNetworkInspect.mockResolvedValue({
      Id: 'net-abc123456789',
      Options: { 'com.docker.network.bridge.name': 'br-abc123456789' },
    });
    mockGetNetwork.mockReturnValue({ inspect: mockNetworkInspect });
    mockValidateNftablesAvailability.mockResolvedValue(undefined);
    mockEnsureKiciTable.mockResolvedValue(undefined);
    mockAddIsolationRules.mockResolvedValue(undefined);
    mockRemoveIsolationRules.mockResolvedValue(undefined);
  });

  describe('spawn()', () => {
    it('creates container with correct env vars', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockCreateContainer).toHaveBeenCalledOnce();
      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.Env).toContain('KICI_ORCHESTRATOR_URL=http://localhost:4000');
      expect(args.Env).toContain('KICI_AGENT_ID=agent-1');
      expect(args.Env).toContain(
        'KICI_LABELS=linux,docker,kici:agent:container,kici:scaler:test-container,kici:role:builder,kici:role:init-runner',
      );
      expect(args.Env).toContain('KICI_SCALER_MANAGED=1');
    });

    it('passes additional env from label set config', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.Env).toContain('NODE_VERSION=20');
    });

    it('applies resource limits (Memory and NanoCpus)', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024); // 2g in bytes
      expect(args.HostConfig.NanoCpus).toBe(2 * 1e9);
    });

    it('applies default resources when label set has none', async () => {
      const backend = await createBackend({
        labelSets: [{ labels: ['linux', 'basic'], image: 'basic:latest' }],
        defaultResources: { limits: { memory: '1g', cpus: 1 } },
      });
      await backend.spawn(['linux', 'basic'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.Memory).toBe(1024 * 1024 * 1024); // 1g
      expect(args.HostConfig.NanoCpus).toBe(1e9);
    });

    it('uses effectiveLimits when provided (overrides label-set / default)', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000', undefined, {
        cpus: 0.5,
        memBytes: 1024 * 1024 * 1024,
      });

      const args = mockCreateContainer.mock.calls[0][0];
      // effectiveLimits beat the label-set's 2g/2cpus.
      expect(args.HostConfig.Memory).toBe(1024 * 1024 * 1024);
      expect(args.HostConfig.NanoCpus).toBe(0.5 * 1e9);
    });

    it('adds container labels (kici-managed, kici-scaler-name, kici-agent-id)', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.Labels['kici-managed']).toBe('true');
      expect(args.Labels['kici-scaler-name']).toBe('test-container');
      expect(args.Labels['kici-agent-id']).toBe('agent-1');
      expect(args.Labels['kici-labels']).toBe('docker,linux');
      // No spawn context — bound-work labels absent.
      expect(args.Labels['kici-bound-job-id']).toBeUndefined();
      expect(args.Labels['kici-run-id']).toBeUndefined();
    });

    it('adds bound-work labels (kici-bound-job-id, kici-run-id) when spawn context is provided', async () => {
      const backend = await createBackend();
      await backend.spawn(
        ['linux', 'docker'],
        'agent-1',
        'http://localhost:4000',
        undefined,
        undefined,
        {
          boundJobId: 'job-123',
          runId: 'run-456',
        },
      );

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.Labels['kici-bound-job-id']).toBe('job-123');
      expect(args.Labels['kici-run-id']).toBe('run-456');
    });

    it('mounts socket at native path when containerSocket is true', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.Binds).toContain('/var/run/docker.sock:/var/run/docker.sock');
    });

    it('mounts podman socket at native path when detected', async () => {
      const backend = await createBackend({
        socketPath: '/run/podman/podman.sock',
      });
      await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.Binds).toContain('/run/podman/podman.sock:/run/podman/podman.sock');
    });

    it('does NOT mount socket when containerSocket is false (default)', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.Binds).toBeUndefined();
    });

    it('throws when label set not found', async () => {
      const backend = await createBackend();
      await expect(
        backend.spawn(['windows', 'gpu'], 'agent-1', 'http://localhost:4000'),
      ).rejects.toThrow(
        'Label set [windows, gpu] not supported by container backend "test-container"',
      );
    });

    it('throws when at maxAgents capacity', async () => {
      const backend = await createBackend({ maxAgents: 1 });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      await expect(
        backend.spawn(['linux', 'docker'], 'agent-2', 'http://localhost:4000'),
      ).rejects.toThrow('Container backend "test-container" at capacity (1/1)');
    });

    it('tracks agent in internal map', async () => {
      const backend = await createBackend();
      expect(backend.getActiveCount()).toBe(0);

      const managed = await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(1);
      expect(managed.id).toBe('agent-1');
      expect(managed.state).toBe('running');
      expect(managed.backendRef).toBe('container-abc123');
      expect(managed.labelSet).toEqual(['linux', 'docker']);
    });

    it('pulls image before creating container', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockPull).toHaveBeenCalledWith('ghcr.io/org/kici-agent:latest');
      expect(mockFollowProgress).toHaveBeenCalledOnce();
    });

    it('starts container after creation', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockStart).toHaveBeenCalledOnce();
    });

    it('sets AutoRemove to false', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.AutoRemove).toBe(false);
    });

    it('passes extraHosts to HostConfig.ExtraHosts', async () => {
      const backend = await createBackend({
        extraHosts: ['verdaccio.local:host-gateway'],
      });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.ExtraHosts).toEqual(['verdaccio.local:host-gateway']);
    });

    it('does NOT set ExtraHosts when extraHosts is not configured', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.HostConfig.ExtraHosts).toBeUndefined();
    });

    it('forwards KICI_AGENT_ENV_ prefixed vars with prefix stripped', async () => {
      const originalEnv = { ...process.env };
      try {
        process.env.KICI_AGENT_ENV_HTTP_PROXY = 'http://proxy:3128';
        process.env.KICI_AGENT_ENV_NO_PROXY = 'localhost,.internal';

        const backend = await createBackend();
        await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

        const args = mockCreateContainer.mock.calls[0][0];
        expect(args.Env).toContain('HTTP_PROXY=http://proxy:3128');
        expect(args.Env).toContain('NO_PROXY=localhost,.internal');

        // Should NOT include the original KICI_AGENT_ENV_ prefixed entries
        for (const entry of args.Env) {
          expect(entry).not.toMatch(/^KICI_AGENT_ENV_/);
        }
      } finally {
        process.env = originalEnv;
      }
    });

    it('scalers.yaml env overrides KICI_AGENT_ENV_ forwarded vars', async () => {
      const originalEnv = { ...process.env };
      try {
        process.env.KICI_AGENT_ENV_NODE_VERSION = 'forwarded-value';

        const backend = await createBackend();
        // linux,node20 label set has env: { NODE_VERSION: '20' }
        await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');

        const args = mockCreateContainer.mock.calls[0][0];
        // scalers.yaml env comes after KICI_AGENT_ENV_ in the array, so it has higher precedence
        // Both entries may be present, but the last one wins for Docker env
        const nodeVersionEntries = args.Env.filter((e: string) => e.startsWith('NODE_VERSION='));
        // The last entry should be the scalers.yaml value
        expect(nodeVersionEntries[nodeVersionEntries.length - 1]).toBe('NODE_VERSION=20');
      } finally {
        process.env = originalEnv;
      }
    });

    it('cleans up tracking if spawn fails', async () => {
      mockCreateContainer.mockRejectedValueOnce(new Error('Container error'));
      const backend = await createBackend();

      await expect(
        backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000'),
      ).rejects.toThrow('Container error');

      expect(backend.getActiveCount()).toBe(0);
    });

    it('applies per-container nftables rules with saddr match after spawn', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockAddIsolationRules).toHaveBeenCalledWith(
        '172.30.0.5',
        '172.30.0.1',
        undefined,
        'saddr',
      );
    });

    it('passes networkPolicy from label set to addIsolationRules', async () => {
      const backend = await createBackend({
        labelSets: [
          {
            labels: ['linux', 'docker'],
            image: 'test:latest',
            networkPolicy: { allowlist: ['8.8.8.0/24'], denyAll: true },
          },
        ],
      });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockAddIsolationRules).toHaveBeenCalledWith(
        '172.30.0.5',
        '172.30.0.1',
        { allowlist: ['8.8.8.0/24'], denyAll: true },
        'saddr',
      );
    });

    it('skips nftables rules when network isolation is disabled', async () => {
      const backend = await createBackend({ networkIsolation: false });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      expect(mockAddIsolationRules).not.toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('stops and removes container', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      await backend.destroy('agent-1');

      expect(mockGetContainer).toHaveBeenCalledWith('container-abc123');
      expect(mockStop).toHaveBeenCalledWith({ t: 10 });
      expect(mockRemove).toHaveBeenCalledWith({ force: true });
      expect(backend.getActiveCount()).toBe(0);
    });

    it('handles already-removed container gracefully', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      mockStop.mockRejectedValueOnce(new Error('container already stopped'));
      mockRemove.mockRejectedValueOnce(new Error('container already removed'));

      // Should not throw
      await backend.destroy('agent-1');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('handles non-existent managed ID gracefully', async () => {
      const backend = await createBackend();
      // Should not throw
      await backend.destroy('non-existent');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('removes per-container nftables rules on destroy', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      await backend.destroy('agent-1');

      expect(mockRemoveIsolationRules).toHaveBeenCalledWith('172.30.0.5');
    });
  });

  describe('shutdownAll()', () => {
    it('destroys all tracked agents', async () => {
      const backend = await createBackend();

      // Spawn two different containers
      mockContainer.id = 'container-1';
      mockCreateContainer.mockResolvedValueOnce({
        id: 'container-1',
        start: mockStart,
        stop: mockStop,
        remove: mockRemove,
      });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      mockCreateContainer.mockResolvedValueOnce({
        id: 'container-2',
        start: mockStart,
        stop: mockStop,
        remove: mockRemove,
      });
      await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');

      expect(backend.getActiveCount()).toBe(2);

      await backend.shutdownAll();
      expect(backend.getActiveCount()).toBe(0);
    });

    it('includes all role labels when roles is undefined (default)', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      const labelsEnv = args.Env.find((e: string) => e.startsWith('KICI_LABELS='));
      expect(labelsEnv).toContain('kici:role:builder');
      expect(labelsEnv).toContain('kici:role:init-runner');
    });

    it('includes only kici:role:builder when roles is ["builder"]', async () => {
      const backend = await createBackend({ roles: ['builder'] });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      const labelsEnv = args.Env.find((e: string) => e.startsWith('KICI_LABELS='));
      expect(labelsEnv).toContain('kici:role:builder');
      expect(labelsEnv).not.toContain('kici:role:init-runner');
    });

    it('includes no role labels when roles is [] (execution only)', async () => {
      const backend = await createBackend({ roles: [] });
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      const labelsEnv = args.Env.find((e: string) => e.startsWith('KICI_LABELS='));
      expect(labelsEnv).not.toContain('kici:role:');
    });
  });

  describe('cleanupOrphans()', () => {
    it('finds and removes kici-managed containers', async () => {
      const mockContainerInfo = [
        { Id: 'orphan-1', Names: ['/kici-orphan-1'] },
        { Id: 'orphan-2', Names: ['/kici-orphan-2'] },
      ];
      mockListContainers.mockResolvedValueOnce(mockContainerInfo);

      const backend = await createBackend();
      const cleaned = await backend.cleanupOrphans();

      expect(mockListContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['kici-managed=true'] },
      });
      expect(cleaned).toBe(2);
      // Should have called getContainer, stop, remove for each
      expect(mockGetContainer).toHaveBeenCalledWith('orphan-1');
      expect(mockGetContainer).toHaveBeenCalledWith('orphan-2');
    });

    it('returns 0 when no orphans found', async () => {
      mockListContainers.mockResolvedValueOnce([]);
      const backend = await createBackend();
      const cleaned = await backend.cleanupOrphans();
      expect(cleaned).toBe(0);
    });

    it('handles stop failures gracefully during cleanup', async () => {
      mockListContainers.mockResolvedValueOnce([{ Id: 'orphan-1' }]);
      mockStop.mockRejectedValueOnce(new Error('already stopped'));

      const backend = await createBackend();
      const cleaned = await backend.cleanupOrphans();
      expect(cleaned).toBe(1);
    });
  });

  describe('getActiveCount()', () => {
    it('returns correct count', async () => {
      const backend = await createBackend();
      expect(backend.getActiveCount()).toBe(0);

      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(1);

      mockCreateContainer.mockResolvedValueOnce({
        id: 'container-2',
        start: mockStart,
        stop: mockStop,
        remove: mockRemove,
      });
      await backend.spawn(['linux', 'node20'], 'agent-2', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(2);

      await backend.destroy('agent-1');
      expect(backend.getActiveCount()).toBe(1);
    });
  });

  describe('reload()', () => {
    it('validates container label sets must have image', async () => {
      const backend = await createBackend();
      const result = backend.reload([
        { labels: ['linux', 'docker'], image: 'valid:latest' },
        { labels: ['linux', 'node20'] }, // Missing image
      ]);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("'image'");
      }
    });

    it('accepts valid label sets', async () => {
      const backend = await createBackend();
      const result = backend.reload([{ labels: ['linux', 'docker'], image: 'new-image:latest' }]);

      expect(result.valid).toBe(true);
    });

    it('updates label sets on successful reload', async () => {
      const backend = await createBackend();
      const newLabelSets: LabelSetConfig[] = [{ labels: ['linux', 'new'], image: 'new:latest' }];
      backend.reload(newLabelSets);

      expect(backend.labelSets).toEqual(newLabelSets);
    });
  });

  describe('type', () => {
    it('returns "container"', async () => {
      const backend = await createBackend();
      expect(backend.type).toBe('container');
    });
  });

  describe('create() factory', () => {
    it('succeeds with host option (no socket detection)', async () => {
      const backend = await ContainerScalerBackend.create({
        name: 'remote',
        labelSets: defaultLabelSets,
        maxAgents: 5,
        host: 'tcp://192.168.1.10:2376',
      });

      expect(backend.type).toBe('container');
      expect(backend.maxAgents).toBe(5);
    });

    it('succeeds with explicit socketPath', async () => {
      const backend = await ContainerScalerBackend.create({
        name: 'explicit',
        labelSets: defaultLabelSets,
        maxAgents: 5,
        socketPath: '/custom/path.sock',
      });

      expect(backend.type).toBe('container');
    });

    it('throws when no runtime found and no host configured', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await expect(
        ContainerScalerBackend.create({
          name: 'missing',
          labelSets: defaultLabelSets,
          maxAgents: 5,
        }),
      ).rejects.toThrow('No container runtime found');
    });

    it('declares spawnsOnLocalHost=false for a remote runtime host', async () => {
      const backend = await ContainerScalerBackend.create({
        name: 'remote',
        labelSets: defaultLabelSets,
        maxAgents: 5,
        host: 'tcp://192.168.1.10:2376',
      });

      expect(backend.spawnsOnLocalHost).toBe(false);
    });

    it('declares spawnsOnLocalHost=true for a local socket', async () => {
      const backend = await createBackend();

      expect(backend.spawnsOnLocalHost).toBe(true);
    });
  });

  describe('isolated network', () => {
    it('creates kici-agent-net network on startup if not exists', async () => {
      mockListNetworks.mockResolvedValueOnce([]);
      await createBackend();

      expect(mockCreateNetwork).toHaveBeenCalledWith({
        Name: 'kici-agent-net',
        Driver: 'bridge',
        IPAM: {
          Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }],
        },
        Labels: { 'kici-managed': 'true' },
      });
    });

    it('reuses existing kici-agent-net network', async () => {
      mockListNetworks.mockResolvedValueOnce([{ Name: 'kici-agent-net', Id: 'existing-net-id' }]);
      mockGetNetwork.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: 'existing-net-id',
          Options: { 'com.docker.network.bridge.name': 'br-existing' },
        }),
      });

      await createBackend();

      // Should NOT try to create a new network
      expect(mockCreateNetwork).not.toHaveBeenCalled();
    });

    it('handles Docker substring matching by verifying exact name', async () => {
      // Docker's name filter does substring matching, so "kici-agent-net" might
      // match "kici-agent-network-other" -- we verify exact name match
      mockListNetworks.mockResolvedValueOnce([
        { Name: 'kici-agent-network-other', Id: 'wrong-net-id' },
      ]);

      await createBackend();

      // Should create network since exact name doesn't match
      expect(mockCreateNetwork).toHaveBeenCalled();
    });

    it('prepares nftables table during network creation (rules applied per-container in spawn)', async () => {
      await createBackend();

      expect(mockEnsureKiciTable).toHaveBeenCalledOnce();
      // addIsolationRules is NOT called at creation time — it's per-container during spawn
      expect(mockAddIsolationRules).not.toHaveBeenCalled();
    });

    it('fails backend creation when nftables validation fails', async () => {
      mockValidateNftablesAvailability.mockRejectedValueOnce(
        new Error('nftables binary not found at /usr/sbin/nft.'),
      );

      await expect(createBackend()).rejects.toThrow('nftables binary not found');
    });

    it('fails backend creation when ensureKiciTable fails (strict enforcement)', async () => {
      mockEnsureKiciTable.mockRejectedValueOnce(new Error('nft: command failed'));

      await expect(createBackend()).rejects.toThrow('nft: command failed');
    });

    it('fails spawn when addIsolationRules fails (strict enforcement)', async () => {
      mockAddIsolationRules.mockRejectedValueOnce(new Error('nftables rule error'));

      const backend = await createBackend();
      await expect(
        backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000'),
      ).rejects.toThrow('nftables rule error');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('calls validateNftablesAvailability and ensureKiciTable during creation, addIsolationRules during spawn', async () => {
      const callOrder: string[] = [];
      mockValidateNftablesAvailability.mockImplementation(async () => {
        callOrder.push('validate');
      });
      mockEnsureKiciTable.mockImplementation(async () => {
        callOrder.push('ensureTable');
      });
      mockAddIsolationRules.mockImplementation(async () => {
        callOrder.push('addRules');
      });

      const backend = await createBackend();
      expect(callOrder).toEqual(['validate', 'ensureTable']);

      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');
      expect(callOrder).toEqual(['validate', 'ensureTable', 'addRules']);
    });

    it('handles 409 conflict on createNetwork race condition', async () => {
      mockListNetworks
        .mockResolvedValueOnce([]) // First check: empty
        .mockResolvedValueOnce([{ Name: 'kici-agent-net', Id: 'raced-net-id' }]); // Retry after 409
      mockCreateNetwork.mockRejectedValueOnce(
        Object.assign(new Error('Conflict'), { statusCode: 409 }),
      );
      mockGetNetwork.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: 'raced-net-id',
          Options: { 'com.docker.network.bridge.name': 'br-raced' },
        }),
      });

      const backend = await createBackend();
      expect(backend).toBeDefined();
    });

    it('attaches containers to isolated network', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      const args = mockCreateContainer.mock.calls[0][0];
      expect(args.NetworkingConfig).toEqual({
        EndpointsConfig: {
          'kici-agent-net': {},
        },
      });
    });

    it('falls back to br-<id> pattern when bridge name not in Options', async () => {
      mockNetworkInspect.mockResolvedValueOnce({
        Id: 'net-abc123456789',
        Options: {}, // No bridge name in Options (Podman/netavark)
      });

      // Should not throw — br-<id> fallback is used internally
      const backend = await createBackend();
      expect(backend).toBeDefined();
    });

    it('cleans up per-container nftables rules on shutdownAll', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      mockRemoveIsolationRules.mockResolvedValue(undefined);
      await backend.shutdownAll();

      expect(mockRemoveIsolationRules).toHaveBeenCalledWith('172.30.0.5');
    });

    it('handles per-container nftables cleanup failure gracefully', async () => {
      const backend = await createBackend();
      await backend.spawn(['linux', 'docker'], 'agent-1', 'http://localhost:4000');

      mockRemoveIsolationRules.mockRejectedValueOnce(new Error('nft failed'));

      // Should NOT throw
      await backend.shutdownAll();
    });
  });

  describe('detectRuntime()', () => {
    it('returns null when no sockets accessible', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await detectRuntime();
      expect(result).toBeNull();
    });

    it('only probes podman paths when runtime hint is podman', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await detectRuntime('podman');
      expect(result).toBeNull();

      // Should not have probed the docker socket path
      // (only podman paths are tried)
      const calledPaths = mockAccess.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledPaths).not.toContain('/var/run/docker.sock');
      expect(calledPaths).toContain('/run/podman/podman.sock');
    });

    it('returns docker when docker socket is accessible', async () => {
      mockAccess.mockImplementation(async (path: string) => {
        if (path === '/var/run/docker.sock') return undefined;
        throw new Error('ENOENT');
      });

      const result = await detectRuntime();
      expect(result).toEqual({
        socketPath: '/var/run/docker.sock',
        runtime: 'docker',
      });
    });
  });

  describe('getRequiredTools', () => {
    type Entry = Parameters<typeof ContainerScalerBackend.getRequiredTools>[0];

    it('requires a container runtime (docker or podman) when auto-detecting', () => {
      const entry = {
        name: 'container-default',
        type: 'container',
        labelSets: [{ labels: ['linux', 'container'], image: 'quay.io/kici-dev/kici-agent' }],
      } as Entry;
      const reqs = ContainerScalerBackend.getRequiredTools(entry);
      const runtimeReq = reqs.find((r) => r.type === 'any-path-binary');
      expect(runtimeReq).toBeDefined();
      expect(runtimeReq).toMatchObject({ names: ['docker', 'podman'] });
      expect(runtimeReq!.reason).toMatch(/container scaler "container-default"/);
    });

    it('skips the binary check when a socketPath is configured (reachability validated at create)', () => {
      const entry = {
        name: 'container-default',
        type: 'container',
        socketPath: '/run/user/1000/podman/podman.sock',
        labelSets: [{ labels: ['linux', 'container'], image: 'quay.io/kici-dev/kici-agent' }],
      } as Entry;
      expect(ContainerScalerBackend.getRequiredTools(entry)).toEqual([]);
    });

    it('skips the binary check when a remote host is configured', () => {
      const entry = {
        name: 'remote',
        type: 'container',
        host: 'tcp://192.168.1.10:2376',
        labelSets: [{ labels: ['linux', 'container'], image: 'quay.io/kici-dev/kici-agent' }],
      } as Entry;
      expect(ContainerScalerBackend.getRequiredTools(entry)).toEqual([]);
    });
  });
});
