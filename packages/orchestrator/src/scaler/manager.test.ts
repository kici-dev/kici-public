import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ScalerBackend,
  ManagedAgent,
  LabelSetConfig,
  ValidationResult,
  ScalerEvent,
} from './types.js';
import { ScalerEventType } from './types.js';
import { ScalerManager, resolveScalerOrchestratorUrl } from './manager.js';

/**
 * Creates a mock ScalerBackend for testing.
 */
function createMockBackend(
  overrides: Partial<ScalerBackend> & {
    type: ScalerBackend['type'];
    labelSets: LabelSetConfig[];
    maxAgents: number;
  },
): ScalerBackend {
  let activeCount = 0;

  return {
    type: overrides.type,
    labelSets: overrides.labelSets,
    maxAgents: overrides.maxAgents,
    getActiveCount: overrides.getActiveCount ?? (() => activeCount),
    spawn:
      overrides.spawn ??
      vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
        activeCount++;
        return {
          id: agentId,
          labelSet,
          backendRef: `ref-${agentId}`,
          spawnedAt: Date.now(),
          state: 'running',
        };
      }),
    destroy:
      overrides.destroy ??
      vi.fn(async () => {
        activeCount = Math.max(0, activeCount - 1);
      }),
    shutdownAll:
      overrides.shutdownAll ??
      vi.fn(async () => {
        activeCount = 0;
      }),
    reload:
      overrides.reload ??
      vi.fn((): ValidationResult => {
        return { valid: true };
      }),
  };
}

function createDefaultConfig() {
  return {
    version: 1 as const,
    globalMaxAgents: 10,
    scalers: [
      {
        name: 'container-prod',
        type: 'container' as const,
        maxAgents: 5,
        labelSets: [
          { labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' },
          { labels: ['linux', 'node20'], image: 'ghcr.io/org/agent-node20:latest' },
        ],
      },
      {
        name: 'bare-metal-gpu',
        type: 'bare-metal' as const,
        maxAgents: 3,
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
      },
    ],
  };
}

type NamedBackend = { name: string; backend: ScalerBackend };

describe('ScalerManager', () => {
  let containerBackend: ScalerBackend;
  let bareMetalBackend: ScalerBackend;

  beforeEach(() => {
    vi.useFakeTimers();

    containerBackend = createMockBackend({
      type: 'container',
      labelSets: [
        { labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' },
        { labels: ['linux', 'node20'], image: 'ghcr.io/org/agent-node20:latest' },
      ],
      maxAgents: 5,
    });

    bareMetalBackend = createMockBackend({
      type: 'bare-metal',
      labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
      maxAgents: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(
    configOverrides?: Partial<ReturnType<typeof createDefaultConfig>>,
    backendsOverride?: NamedBackend[],
    onScalerEvent?: (runId: string, jobId: string, event: ScalerEvent) => void,
  ): ScalerManager {
    const config = { ...createDefaultConfig(), ...configOverrides };
    return new ScalerManager({
      config,
      backends: backendsOverride ?? [
        { name: 'container-prod', backend: containerBackend },
        { name: 'bare-metal-gpu', backend: bareMetalBackend },
      ],
      onScalerEvent,
    });
  }

  describe('requestScale()', () => {
    it('routes to correct backend by label set', async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      expect(result).toEqual({ action: 'spawning', backendType: 'container' });
      expect(containerBackend.spawn).toHaveBeenCalled();
    });

    it('routes to bare-metal backend for gpu labels', async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'gpu'], 'job-2', 'run-test');

      expect(result).toEqual({ action: 'spawning', backendType: 'bare-metal' });
      expect(bareMetalBackend.spawn).toHaveBeenCalled();
    });

    it("returns 'no-backend' when no backend matches labels", async () => {
      const manager = createManager();

      const result = await manager.requestScale(['windows', 'arm64'], 'job-3', 'run-test');

      expect(result).toEqual({ action: 'no-backend', labels: ['windows', 'arm64'] });
    });

    it("returns 'at-capacity' when global cap reached", async () => {
      const fullContainerBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 20,
        getActiveCount: () => 10,
      });

      const manager = createManager(
        {
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 20,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: fullContainerBackend }],
      );

      const result = await manager.requestScale(['linux', 'docker'], 'job-4', 'run-test');

      expect(result).toEqual({ action: 'at-capacity' });
    });

    it("returns 'at-capacity' when per-backend cap reached", async () => {
      const fullContainerBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 3,
        getActiveCount: () => 3,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 3,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: fullContainerBackend }],
      );

      const result = await manager.requestScale(['linux', 'docker'], 'job-5', 'run-test');

      expect(result).toEqual({ action: 'at-capacity' });
    });

    it('counts spawning agents toward per-backend capacity via backend.getActiveCount()', async () => {
      // Real backends (container, bare-metal, firecracker) add to their internal
      // agents map synchronously at the start of spawn(). This means getActiveCount()
      // reflects spawning agents immediately, before the spawn promise resolves.
      // The manager relies solely on backend.getActiveCount() for capacity checks
      // and does NOT separately count spawningAgents to avoid double-counting.
      let activeCount = 4;
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        getActiveCount: () => activeCount,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Synchronously increment, matching real backend behavior
          activeCount++;
          return new Promise<ManagedAgent>((resolve) => {
            setTimeout(() => {
              resolve({
                id: agentId,
                labelSet,
                backendRef: `ref-${agentId}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            }, 5000);
          });
        }),
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // First request: activeCount=4, backend increments to 5 during spawn
      const result1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test');
      expect(result1.action).toBe('spawning');

      // Second request: activeCount=5 >= maxAgents(5) -> at-capacity
      const result2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test');
      expect(result2.action).toBe('at-capacity');
    });

    it("returns 'spawning' and triggers async spawn", async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'docker'], 'job-6', 'run-test');

      expect(result.action).toBe('spawning');
      expect((result as { backendType: string }).backendType).toBe('container');
      expect(containerBackend.spawn).toHaveBeenCalledWith(
        ['linux', 'docker'],
        expect.stringMatching(/^scaler-container-[a-f0-9]{8}$/),
        expect.any(String),
        expect.any(Function),
        undefined,
        { boundJobId: 'job-6', runId: 'run-test' },
      );
    });

    it('consumes from warm pool when available', async () => {
      const config = {
        ...createDefaultConfig(),
        scalers: [
          {
            name: 'container-prod',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            warmPool: { enabled: true, size: 2, idleTimeoutSeconds: 300 },
          },
        ],
      };

      const manager = new ScalerManager({
        config,
        backends: [{ name: 'container-prod', backend: containerBackend }],
      });

      // Clear the spawn mock to track fresh calls
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      // The warm pool is empty so first request goes to spawn
      const result = await manager.requestScale(['linux', 'docker'], 'job-warm', 'run-test');
      expect(result.action).toBe('spawning');
      expect(containerBackend.spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAgentRegistered()', () => {
    it('correlates spawned agent to tracking entry', async () => {
      const manager = createManager();

      // Trigger a spawn
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      // Get the agentId from the spawn call
      const spawnCall = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const agentId = spawnCall[1] as string;

      // Let spawn complete
      await vi.advanceTimersToNextTimerAsync();

      // Register the agent
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Verify agent is now in managedAgentIndex (check via getStatus)
      const status = manager.getStatus();
      expect(status.spawningCount).toBe(0);
    });

    it('returns the bound jobId so the orchestrator can eager-dispatch it', async () => {
      const manager = createManager();

      // Trigger a spawn for a specific queued jobId
      await manager.requestScale(['linux', 'docker'], 'queued-job-42', 'run-test');

      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();

      // Registration should hand back the queued jobId so the agent-handler
      // can dispatch it directly, bypassing the generic queue drain race.
      // mandatoryLabels is always returned (empty here — this scaler has no gate).
      const result = manager.onAgentRegistered(agentId, ['linux', 'docker']);
      expect(result).toEqual({ boundJobId: 'queued-job-42', mandatoryLabels: [] });
    });

    it('returns null for unknown (static) agents', () => {
      const manager = createManager();
      const result = manager.onAgentRegistered('static-agent-1', ['linux', 'docker']);
      expect(result).toBeNull();
    });

    it('removes from spawningAgents on registration', async () => {
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        spawn: vi.fn(
          async (labelSet: string[], agentId: string): Promise<ManagedAgent> =>
            new Promise<ManagedAgent>((resolve) => {
              setTimeout(() => {
                resolve({
                  id: agentId,
                  labelSet,
                  backendRef: `ref-${agentId}`,
                  spawnedAt: Date.now(),
                  state: 'running',
                });
              }, 10_000);
            }),
        ),
      });

      const manager = createManager(
        {
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (slowBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

      // Before registration, spawning count = 1
      expect(manager.getStatus().spawningCount).toBe(1);

      // Agent registers (before spawn promise resolves)
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Spawning count should be 0
      expect(manager.getStatus().spawningCount).toBe(0);
    });

    it('ignores non-scaler-managed agents', () => {
      const manager = createManager();

      // This should not throw
      manager.onAgentRegistered('static-agent-1', ['linux', 'docker']);

      // Status should show 0 spawning
      expect(manager.getStatus().spawningCount).toBe(0);
    });
  });

  describe('onAgentDisconnected()', () => {
    it('triggers destroy on agent disconnect', async () => {
      const manager = createManager();

      // Spawn and register an agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Disconnect
      manager.onAgentDisconnected(agentId);

      expect(containerBackend.destroy).toHaveBeenCalledWith(agentId);
    });

    it('ignores non-managed (static) agents', () => {
      const manager = createManager();

      // Should not throw or call destroy
      manager.onAgentDisconnected('static-agent-123');

      expect(containerBackend.destroy).not.toHaveBeenCalled();
      expect(bareMetalBackend.destroy).not.toHaveBeenCalled();
    });

    it('cleans up managedAgentIndex even when destroy fails', async () => {
      const failingBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 5,
        destroy: vi.fn(async () => {
          throw new Error('Container not found');
        }),
      });

      const manager = createManager(
        {
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: failingBackend }],
      );

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (failingBackend.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Disconnect -- destroy will fail but managedAgentIndex should still be cleaned
      manager.onAgentDisconnected(agentId);

      // Verify the agent is no longer tracked (a second disconnect is a no-op)
      manager.onAgentDisconnected(agentId);
      expect(failingBackend.destroy).toHaveBeenCalledTimes(1); // Only first call triggers destroy
    });
  });

  describe('onJobComplete()', () => {
    it('does not destroy agent on job completion (agent disconnects on its own)', async () => {
      const manager = createManager();

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      manager.onJobComplete(agentId);

      // Single-job model: agent disconnects on its own, no destroy called
      expect(containerBackend.destroy).not.toHaveBeenCalled();
    });
  });

  describe('onConfigAck()', () => {
    it('calls clearAgentMmds on Firecracker backend', async () => {
      const clearAgentMmds = vi.fn(async () => {});
      const firecrackerBackend = createMockBackend({
        type: 'firecracker',
        labelSets: [{ labels: ['linux', 'vm'], rootfsPath: '/rootfs.ext4' }],
        maxAgents: 5,
      });
      // Add clearAgentMmds to the mock
      (firecrackerBackend as any).clearAgentMmds = clearAgentMmds;

      const manager = createManager(
        {
          scalers: [
            {
              name: 'fc-prod',
              type: 'firecracker' as any,
              maxAgents: 5,
              labelSets: [{ labels: ['linux', 'vm'], rootfsPath: '/rootfs.ext4' }],
            },
          ],
        },
        [{ name: 'fc-prod', backend: firecrackerBackend }],
      );

      // Spawn and register an agent
      await manager.requestScale(['linux', 'vm'], 'job-1', 'run-test');
      const agentId = (firecrackerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'vm']);

      // Send config.ack
      manager.onConfigAck(agentId);

      expect(clearAgentMmds).toHaveBeenCalledWith(agentId);
    });

    it('does not call clearAgentMmds on non-Firecracker backends', async () => {
      const manager = createManager();

      // Spawn and register a container agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Send config.ack -- should not throw
      manager.onConfigAck(agentId);

      // No clearAgentMmds should exist on container backend
      expect((containerBackend as any).clearAgentMmds).toBeUndefined();
    });

    it('ignores config.ack from non-managed (static) agents', () => {
      const manager = createManager();

      // Should not throw
      manager.onConfigAck('static-agent-123');
    });
  });

  describe('getGlobalActiveCount()', () => {
    it('sums all backends active counts without double-counting spawning', async () => {
      // Realistic mock: getActiveCount reflects spawning agents (like real backends).
      // Real backends (container, bare-metal, firecracker) add to their internal agents
      // map synchronously at the start of spawn(), so getActiveCount() already includes
      // spawning agents. The manager must NOT add spawningAgents.size on top.
      let dockerActive = 2;
      let bmActive = 1;

      const containerBE = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 10,
        getActiveCount: () => dockerActive,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Synchronously increment active count, matching real backend behavior
          dockerActive++;
          return new Promise<ManagedAgent>((resolve) => {
            setTimeout(() => {
              resolve({
                id: agentId,
                labelSet,
                backendRef: `ref-${agentId}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            }, 10_000);
          });
        }),
      });

      const bmBE = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/bin/agent' }],
        maxAgents: 10,
        getActiveCount: () => bmActive,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
            {
              name: 'bare-metal-gpu',
              type: 'bare-metal',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/bin/agent' }],
            },
          ],
        },
        [
          { name: 'container-prod', backend: containerBE },
          { name: 'bare-metal-gpu', backend: bmBE },
        ],
      );

      // Before spawning: docker(2) + bm(1) = 3
      expect(manager.getGlobalActiveCount()).toBe(3);

      // Trigger a slow spawn (backend increments active count synchronously)
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      // docker(3) + bm(1) = 4 -- no double-count from spawningAgents
      expect(manager.getGlobalActiveCount()).toBe(4);
    });
  });

  describe('stale spawning entry pruning', () => {
    it('prunes spawning entries older than 5 minutes on next requestScale', async () => {
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 10,
        spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
          // Never resolve: simulates agent that crashes before WS registration
          return new Promise(() => {});
        }),
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'container-prod',
              type: 'container',
              maxAgents: 10,
              labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
            },
          ],
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // Spawn an agent (stays in spawningAgents forever since spawn never resolves)
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      expect(manager.getStatus().spawningCount).toBe(1);

      // Advance time past the 5-minute stale threshold
      vi.advanceTimersByTime(301_000);

      // Next requestScale prunes the stale entry
      await manager.requestScale(['linux', 'docker'], 'job-2', 'run-test');
      // The stale entry was pruned, new one was added
      expect(manager.getStatus().spawningCount).toBe(1);
    });
  });

  describe('shutdownAll()', () => {
    it('stops warm pool and shuts down all backends', async () => {
      const manager = createManager();
      manager.start();

      await manager.shutdownAll();

      expect(containerBackend.shutdownAll).toHaveBeenCalled();
      expect(bareMetalBackend.shutdownAll).toHaveBeenCalled();

      // Status should show 0 spawning after shutdown
      expect(manager.getStatus().spawningCount).toBe(0);
    });

    it('clears all tracking maps', async () => {
      const manager = createManager();

      // Spawn an agent
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      await manager.shutdownAll();

      expect(manager.getStatus().spawningCount).toBe(0);
    });
  });

  describe('reload()', () => {
    it('validates new config and updates backends', async () => {
      const manager = createManager();

      const newConfig = {
        ...createDefaultConfig(),
        globalMaxAgents: 20,
      };

      const result = await manager.reload(newConfig);

      expect(result).toEqual({ valid: true });
      expect(containerBackend.reload).toHaveBeenCalledWith(newConfig.scalers[0].labelSets);
      expect(bareMetalBackend.reload).toHaveBeenCalledWith(newConfig.scalers[1].labelSets);
    });

    it('rejects config with label-set overlaps', async () => {
      const manager = createManager();

      const overlappingConfig = {
        version: 1 as const,
        globalMaxAgents: 10,
        scalers: [
          {
            name: 'container-a',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'a:latest' }],
          },
          {
            name: 'container-b',
            type: 'container' as const,
            maxAgents: 5,
            labelSets: [{ labels: ['linux', 'docker'], image: 'b:latest' }],
          },
        ],
      };

      const result = await manager.reload(overlappingConfig);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain('docker,linux');
        expect(result.errors[0]).toContain('container-a');
        expect(result.errors[0]).toContain('container-b');
      }
    });

    it('updates globalMaxAgents', async () => {
      const manager = createManager();

      await manager.reload({
        ...createDefaultConfig(),
        globalMaxAgents: 50,
      });

      expect(manager.getStatus().globalMaxAgents).toBe(50);
    });
  });

  describe('getStatus()', () => {
    it('returns summary with correct backend information', () => {
      const manager = createManager();

      const status = manager.getStatus();

      expect(status.globalMaxAgents).toBe(10);
      expect(status.globalActiveCount).toBe(0);
      expect(status.spawningCount).toBe(0);
      expect(status.backends).toHaveLength(2);
      expect(status.backends[0].type).toBe('container');
      expect(status.backends[1].type).toBe('bare-metal');
    });

    it('reports usage and resource caps in status', async () => {
      const manager = createManager({
        globalResourceCap: { maxCpu: 8, maxMemoryBytes: 8 * 1024 ** 3 },
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 5,
            resourceCap: { maxCpu: 4, maxMemoryBytes: 4 * 1024 ** 3 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      await manager.requestScale(['linux', 'docker'], 'job-cap-1', 'run-test', [], {
        requests: { cpus: 1, memory: '1g' },
      });
      const status = manager.getStatus();
      expect(status.globalUsage.cpus).toBe(1);
      expect(status.globalUsage.memBytes).toBe(1024 ** 3);
      expect(status.backends[0].usage.cpus).toBe(1);
      expect(status.backends[0].resourceCap?.maxCpu).toBe(4);
      expect(status.globalResourceCap?.maxCpu).toBe(8);
    });
  });

  describe('resource caps', () => {
    it('refuses spawn when per-scaler cpu cap would be exceeded', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 1.5 },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');
    });

    it('refuses spawn when global resource cap would be exceeded', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        globalResourceCap: { maxMemoryBytes: 2 * 1024 ** 3 },
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { memory: '1500m' },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { memory: '1g' },
      });
      expect(r2.action).toBe('at-capacity');
    });

    it('releases reservation on agent disconnect', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      // First reservation maxes out the per-scaler cpu cap.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');

      // Second is denied.
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');

      // Find the spawn'd agent's id and call onAgentDisconnected.
      const spawnArgs = vi.mocked(containerBackend.spawn).mock.calls;
      const spawnedAgentId = spawnArgs[0][1] as string;
      // Simulate registration to populate managedAgentIndex (so the destroy path runs).
      manager.onAgentRegistered(spawnedAgentId, ['linux', 'docker']);
      manager.onAgentDisconnected(spawnedAgentId);

      // Now the third request should succeed since the reservation was released.
      const r3 = await manager.requestScale(['linux', 'docker'], 'job-c', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r3.action).toBe('spawning');
    });

    it('mirrors limits-only resources into requests for cap math', async () => {
      const manager = createManager({
        globalMaxAgents: 100,
        scalers: [
          {
            name: 'container-prod',
            type: 'container',
            maxAgents: 100,
            resourceCap: { maxCpu: 2 },
            labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
          },
        ],
      });
      // Limits-only: requests = limits per the mirroring rule.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        limits: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        limits: { cpus: 0.5 },
      });
      expect(r2.action).toBe('at-capacity');
    });
  });

  describe('handleScalerEvent() — failure attribution', () => {
    /**
     * Pull the per-agent event emitter the manager handed to backend.spawn().
     * The closure ignores the agentId it captured and routes whatever event it
     * receives through handleScalerEvent(), so a single captured emitter can
     * synthesize an event for any agentId.
     */
    function captureOnEvent(backend: ScalerBackend): (event: ScalerEvent) => void {
      const call = (backend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      return call[3] as (event: ScalerEvent) => void;
    }

    it('attributes a bound pre-registration failure via the spawning entry', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // Spawn a job-bound agent but do NOT register or correlate it: this is a
      // spawn that dies before the agent ever connects via WS.
      await manager.requestScale(['linux', 'docker'], 'job-77', 'run-77');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);

      const event: ScalerEvent = {
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'node not found (ENOENT)',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // The failure is routed to the bound job via the spawning entry's
      // runId/boundJobId even though no correlation was established.
      expect(onScalerEvent).toHaveBeenCalledWith('run-77', 'job-77', event);
    });

    it('does not route an unbound/warm-pool failure (count + warn only)', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // A spawn gives us a real emitter closure; firing it with an event for a
      // DIFFERENT agentId (no spawning entry, no correlation) exercises the
      // unattributable path.
      await manager.requestScale(['linux', 'docker'], 'job-88', 'run-88');
      const onEvent = captureOnEvent(containerBackend);

      const event: ScalerEvent = {
        agentId: 'orphan-agent',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'spawn failed for an agent the manager never tracked',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // No attribution → not relayed, only counted + warned. The event is
      // buffered for a (never-arriving) correlation, but onScalerEvent must
      // not fire for it.
      expect(onScalerEvent).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), event);
    });

    it('attributes a post-registration failure via the correlation map after the spawning entry is gone', async () => {
      const onScalerEvent = vi.fn();
      const manager = createManager(undefined, undefined, onScalerEvent);

      // Spawn an agent, then register it: registration deletes the spawning
      // entry and records the backend in managedAgentIndex, mimicking the state
      // a long-lived bare-metal child 'error' listener sees if it fires after
      // the agent has already connected via WS.
      await manager.requestScale(['linux', 'docker'], undefined, undefined);
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // A job is then dispatched to the registered agent, establishing
      // correlation — the only remaining attribution source now that the
      // spawning entry is gone.
      manager.correlateAgentToJob(agentId, 'run-99', 'job-99');

      const event: ScalerEvent = {
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'bare-metal child error after registration',
        timestampMs: Date.now(),
      };
      onEvent(event);

      // The failure routes to the correlated job even though no spawning entry
      // remains.
      expect(onScalerEvent).toHaveBeenCalledWith('run-99', 'job-99', event);
    });
  });

  describe('recentSpawnFailures()', () => {
    function captureOnEvent(backend: ScalerBackend): (event: ScalerEvent) => void {
      const call = (backend.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      return call[3] as (event: ScalerEvent) => void;
    }

    it('records scaler.failed events grouped per backend with bound/unbound counts', async () => {
      const manager = createManager();

      // A job-bound spawn that fails before the agent ever connects.
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      const onEvent = captureOnEvent(containerBackend);

      const ts = Date.now();
      onEvent({
        agentId,
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'no such image',
        timestampMs: ts,
      });

      const map = manager.recentSpawnFailures(300_000, ts + 1);
      expect(map).toBeInstanceOf(Map);
      const summary = map.get('container-prod');
      expect(summary).toMatchObject({
        backendType: 'container',
        boundCount: 1,
        unboundCount: 0,
        lastError: 'no such image',
        lastAtMs: ts,
      });
    });
  });
});

describe('resolveScalerOrchestratorUrl', () => {
  it('prefers the per-scaler config URL', () => {
    expect(resolveScalerOrchestratorUrl('ws://192.168.1.85:4000/ws', 'ws://env:1/ws', '4000')).toBe(
      'ws://192.168.1.85:4000/ws',
    );
  });

  it('falls back to KICI_ORCHESTRATOR_URL when no config URL is set', () => {
    expect(resolveScalerOrchestratorUrl(undefined, 'ws://env-host:9/ws', '4000')).toBe(
      'ws://env-host:9/ws',
    );
  });

  it('defaults to the orchestrator port (not the agent 8080) for local agents', () => {
    // A bare-metal scaler with no explicit URL must reach the orchestrator on
    // its own bind port, not the agent default 8080.
    expect(resolveScalerOrchestratorUrl(undefined, undefined, '4000')).toBe(
      'ws://127.0.0.1:4000/ws',
    );
  });

  it('uses 4000 when no port is provided', () => {
    expect(resolveScalerOrchestratorUrl(undefined, undefined, undefined)).toBe(
      'ws://127.0.0.1:4000/ws',
    );
  });
});
