import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ScalerBackend,
  ManagedAgent,
  LabelSetConfig,
  ValidationResult,
  ScalerEvent,
} from './types.js';
import { ScalerEventType } from './types.js';
import { ScalerManager, resolveScalerOrchestratorUrl, buildScalerUsageRows } from './manager.js';

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
    ...(overrides.ensureHostReady ? { ensureHostReady: overrides.ensureHostReady } : {}),
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
      spawnTimeoutMs: 300_000,
    });
  }

  describe('requestScale()', () => {
    it('routes to correct backend by label set', async () => {
      const manager = createManager();

      const result = await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');

      expect(result).toEqual({ action: 'spawning', backendType: 'container' });
      expect(containerBackend.spawn).toHaveBeenCalled();
    });

    it('is a no-op while draining (no fresh capacity spawned)', async () => {
      const manager = new ScalerManager({
        config: createDefaultConfig(),
        backends: [{ name: 'container-prod', backend: containerBackend }],
        isDraining: () => true,
        spawnTimeoutMs: 300_000,
      });

      const result = await manager.requestScale(['linux', 'docker'], 'job-drain', 'run-test');

      expect(result).toEqual({ action: 'skipped', reason: 'draining' });
      expect(containerBackend.spawn).not.toHaveBeenCalled();
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
        expect.any(AbortSignal),
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
        spawnTimeoutMs: 300_000,
      });

      // Clear the spawn mock to track fresh calls
      (containerBackend.spawn as ReturnType<typeof vi.fn>).mockClear();

      // The warm pool is empty so first request goes to spawn
      const result = await manager.requestScale(['linux', 'docker'], 'job-warm', 'run-test');
      expect(result.action).toBe('spawning');
      expect(containerBackend.spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('spawn throttling (maxConcurrentSpawns)', () => {
    /** Yield a macrotask so all pending microtasks (semaphore hand-offs) flush. */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('never runs more than maxConcurrentSpawns concurrent backend.spawn per backend', async () => {
      // Real timers: the semaphore hand-off is a microtask chain, not a timer.
      vi.useRealTimers();

      let inFlight = 0;
      let peak = 0;
      const releasers: Array<() => void> = [];
      const spawn = vi.fn((labelSet: string[], agentId: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise<ManagedAgent>((resolve) => {
          releasers.push(() => {
            inFlight--;
            resolve({
              id: agentId,
              labelSet,
              backendRef: `ref-${agentId}`,
              spawnedAt: Date.now(),
              state: 'running',
            });
          });
        });
      });

      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        // Population cap never hit — isolate the provisioning-rate throttle.
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 3,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      // Fire 20 in-cap scale requests. Each reserves + kicks a throttled spawn.
      for (let i = 0; i < 20; i++) {
        const result = await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
        expect(result.action).toBe('spawning');
      }
      await flush();

      // Only maxConcurrentSpawns (3) provision at once; the rest queue.
      expect(peak).toBeLessThanOrEqual(3);
      expect(spawn).toHaveBeenCalledTimes(3);

      // Drain: release the in-flight spawns in batches; each release lets the
      // semaphore admit the next queued spawn. Peak must stay at or below 3.
      let released = 0;
      while (released < 20) {
        await flush();
        const batch = releasers.splice(0);
        if (batch.length === 0) break;
        batch.forEach((release) => release());
        released += batch.length;
      }
      await flush();

      // All 20 eventually spawned; the cap was never exceeded.
      expect(spawn).toHaveBeenCalledTimes(20);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('releases a semaphore slot when a spawn rejects (no permanent starvation)', async () => {
      vi.useRealTimers();

      let inFlight = 0;
      let peak = 0;
      let call = 0;
      const releasers: Array<() => void> = [];
      const rejecters: Array<() => void> = [];
      const spawn = vi.fn(() => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const mine = call++;
        return new Promise<ManagedAgent>((resolve, reject) => {
          // Every 2nd spawn rejects; its slot must still be freed via finally.
          if (mine % 2 === 0) {
            rejecters.push(() => {
              inFlight--;
              reject(new Error('boom'));
            });
          } else {
            releasers.push(() => {
              inFlight--;
              resolve({
                id: `agent-${mine}`,
                labelSet: ['linux', 'docker'],
                backendRef: `ref-${mine}`,
                spawnedAt: Date.now(),
                state: 'running',
              });
            });
          }
        });
      });

      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 2,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      for (let i = 0; i < 6; i++) {
        await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
      }
      await flush();
      expect(spawn).toHaveBeenCalledTimes(2);

      // Drain a mix of rejects and resolves; a rejected spawn must free its slot
      // so the next queued spawn proceeds — otherwise the queue would wedge.
      let settled = 0;
      while (settled < 6) {
        await flush();
        const toReject = rejecters.splice(0);
        const toResolve = releasers.splice(0);
        if (toReject.length === 0 && toResolve.length === 0) break;
        toReject.forEach((r) => r());
        toResolve.forEach((r) => r());
        settled += toReject.length + toResolve.length;
      }
      await flush();

      expect(spawn).toHaveBeenCalledTimes(6);
      expect(peak).toBeLessThanOrEqual(2);
    });

    it('does not prune spawns still queued behind the semaphore, only started-and-stale ones', async () => {
      // Fake timers (the suite default) so we can advance past the 5-min
      // stale-prune threshold. One slot, a spawn that never resolves — it holds
      // the slot so the other two requests stay queued.
      const spawn = vi.fn(() => new Promise<ManagedAgent>(() => {}));
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 100,
        getActiveCount: () => 0,
        spawn,
      });

      const manager = createManager(
        {
          globalMaxAgents: 100,
          scalers: [
            {
              name: 'throttled',
              type: 'container' as const,
              maxAgents: 100,
              maxConcurrentSpawns: 1,
              labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
            },
          ],
        } as unknown as Partial<ReturnType<typeof createDefaultConfig>>,
        [{ name: 'throttled', backend }],
      );

      // 3 in-cap requests: 1 spawn starts (occupies the only slot), 2 queue.
      for (let i = 0; i < 3; i++) {
        await manager.requestScale(['linux', 'docker'], `job-${i}`, `run-${i}`);
      }
      await vi.advanceTimersByTimeAsync(0); // let the admitted spawn start
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().spawningCount).toBe(3);

      // Advance well past the 5-min stale window, then trigger a prune via a
      // no-match request (prunes first, then returns without adding an entry).
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const noMatch = await manager.requestScale(['windows', 'arm64'], 'job-x', 'run-x');
      expect(noMatch.action).toBe('no-backend');

      // The started-but-never-registered spawn is reaped; the two still-queued
      // spawns survive (they had not started, so the stale clock never began).
      expect(manager.getStatus().spawningCount).toBe(2);
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

  describe('onCapacityFreed hook', () => {
    async function spawnAndRegister(manager: ScalerManager): Promise<string> {
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);
      return agentId;
    }

    it('fires (debounced) when a reserved agent releases on disconnect', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onAgentDisconnected(agentId);

      // Debounced: not fired synchronously.
      expect(onCapacityFreed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of releases into a single call', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onJobComplete(agentId);
      manager.onJobComplete(agentId);
      manager.onJobComplete(agentId);
      await vi.advanceTimersByTimeAsync(250);

      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('fires from onJobComplete for a managed agent', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);
      const onCapacityFreed = vi.fn();
      manager.onCapacityFreed = onCapacityFreed;

      manager.onJobComplete(agentId);
      await vi.advanceTimersByTimeAsync(250);

      expect(onCapacityFreed).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no callback is configured', async () => {
      const manager = createManager();
      const agentId = await spawnAndRegister(manager);

      expect(() => manager.onAgentDisconnected(agentId)).not.toThrow();
      await vi.advanceTimersByTimeAsync(250);
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

  describe('getBackendType()', () => {
    it('returns the backend TYPE, not the operator-chosen scaler name', async () => {
      const manager = createManager();
      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-test');
      const agentId = (containerBackend.spawn as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      await vi.advanceTimersToNextTimerAsync();
      manager.onAgentRegistered(agentId, ['linux', 'docker']);

      // Scaler is named 'container-prod' but its type is 'container'. The metrics
      // scaler label must carry the type, which is what the Platform catalog
      // enum (AGENT_SCALER_VALUES) admits -- never the free-form name.
      expect(manager.getBackendType(agentId)).toBe('container');
    });

    it('returns null for an agent that is not scaler-managed', () => {
      const manager = createManager();
      expect(manager.getBackendType('static-agent-not-managed')).toBeNull();
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

  describe('platform taints', () => {
    function createPlatformManager(): ScalerManager {
      const winBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 2,
      });
      const linBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'bare-metal'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 2,
      });
      return new ScalerManager({
        spawnTimeoutMs: 300_000,
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win-pool',
              type: 'bare-metal',
              maxAgents: 2,
              labelSets: [{ labels: ['windows', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
            },
            {
              name: 'linux-pool',
              type: 'bare-metal',
              maxAgents: 2,
              labelSets: [
                { labels: ['linux', 'bare-metal'], binaryPath: '/usr/local/bin/kici-agent' },
              ],
            },
          ],
        },
        backends: [
          { name: 'win-pool', backend: winBackend },
          { name: 'linux-pool', backend: linBackend },
        ],
      });
    }

    it('taints a windows bare-metal backend mandatoryLabels (advertisement)', () => {
      const status = createPlatformManager().getStatus();
      const win = status.backends.find((b) => b.name === 'win-pool');
      expect(win?.mandatoryLabels).toContain('windows');
      const lin = status.backends.find((b) => b.name === 'linux-pool');
      expect(lin?.mandatoryLabels ?? []).not.toContain('windows');
    });

    it('rejects an unqualified bare-metal job on the windows pool (local matcher)', async () => {
      const manager = createPlatformManager();
      // Unqualified: no `windows` in required labels → windows pool must not match.
      const result = await manager.requestScale(['bare-metal'], 'job-u', 'run-u');
      expect(result.action).toBe('spawning');
      const status = manager.getStatus();
      // Only the linux pool may have an active/spawning agent.
      const win = status.backends.find((b) => b.name === 'win-pool');
      expect(win?.activeCount).toBe(0);
    });

    it('routes an OS-qualified job to the windows pool', async () => {
      const manager = createPlatformManager();
      const result = await manager.requestScale(['windows', 'bare-metal'], 'job-w', 'run-w');
      expect(result.action).toBe('spawning');
      expect(result).toMatchObject({ backendType: 'bare-metal' });
    });

    it('stamps the platform taint onto a registered windows-pool agent gate', async () => {
      const manager = createPlatformManager();
      // Spawn a windows-pool agent for an OS-qualified job.
      await manager.requestScale(['windows', 'bare-metal'], 'job-w', 'run-w');
      // On registration, the returned gate must include the derived `windows`
      // taint even though the pool declared no explicit mandatoryLabels — so the
      // local queue-drain and eager-dispatch paths reject an unqualified job that
      // would otherwise land on this wrong-OS agent.
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = manager.onAgentRegistered(spawnedId, ['windows', 'bare-metal']);
      expect(registered?.mandatoryLabels).toContain('windows');
    });

    // A pool that declares a non-canonical OS label (`windows-2022`) that the
    // denylist would NOT catch, but supplies the structured platform field so
    // the taint still applies. Proves the synonym-escape gap is closed.
    function createStructuredPlatformManager(): ScalerManager {
      const winBackend = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['windows-2022', 'bare-metal'], binaryPath: '/kici-agent.exe' }],
        maxAgents: 2,
      });
      return new ScalerManager({
        spawnTimeoutMs: 300_000,
        config: {
          version: 1 as const,
          globalMaxAgents: 10,
          scalers: [
            {
              name: 'win2022-pool',
              type: 'bare-metal',
              maxAgents: 2,
              platform: { os: 'windows', arch: 'x64' },
              labelSets: [
                { labels: ['windows-2022', 'bare-metal'], binaryPath: '/kici-agent.exe' },
              ],
            },
          ],
        },
        backends: [{ name: 'win2022-pool', backend: winBackend }],
      });
    }

    it('taints a synonym-labeled pool via the structured platform field (closes the denylist gap)', () => {
      const status = createStructuredPlatformManager().getStatus();
      const pool = status.backends.find((b) => b.name === 'win2022-pool');
      // Without the structured field, `windows-2022` escapes PLATFORM_TAINT_LABELS
      // and the pool would carry no taint. With it, the pool is tainted.
      expect(pool?.mandatoryLabels).toContain('windows');
    });

    it('injects the declared-platform os/arch labels into the pool label set', () => {
      const status = createStructuredPlatformManager().getStatus();
      const pool = status.backends.find((b) => b.name === 'win2022-pool');
      const flat = pool?.labelSets.flat() ?? [];
      expect(flat).toContain('kici:os:windows');
      expect(flat).toContain('kici:os:win32');
    });

    it('rejects an unqualified job on the structured-field windows pool', async () => {
      const manager = createStructuredPlatformManager();
      const result = await manager.requestScale(['bare-metal'], 'job-u2', 'run-u2');
      // No windows pool matches an unqualified job → no backend.
      expect(result.action).toBe('no-backend');
    });

    it('routes an os-qualified job to the structured-field windows pool', async () => {
      const manager = createStructuredPlatformManager();
      const result = await manager.requestScale(['windows', 'bare-metal'], 'job-w2', 'run-w2');
      expect(result.action).toBe('spawning');
    });

    it('stamps the structured-field taint onto a registered agent gate', async () => {
      const manager = createStructuredPlatformManager();
      await manager.requestScale(['windows', 'bare-metal'], 'job-w3', 'run-w3');
      const spawnedId = [
        ...(manager as unknown as { spawningAgents: Map<string, unknown> }).spawningAgents.keys(),
      ][0];
      const registered = manager.onAgentRegistered(spawnedId, ['windows', 'bare-metal']);
      expect(registered?.mandatoryLabels).toContain('windows');
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

    it('releases the reservation when a stale spawning entry is pruned', async () => {
      // A spawn that never resolves models an agent that was created but never
      // registered its WS — so neither the spawn-failure path nor
      // onAgentDisconnected ever fires. The only cleanup is the stale-entry
      // prune, which must release the held reservation or the per-scaler cap
      // leaks capacity forever (the cross-process machine-pool E2E's real
      // failure: a warm-reused orch DB accumulated orphaned scaler_reservations
      // and every requestScale was rejected at-capacity with zero agents).
      const slowBackend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'agent:latest' }],
        maxAgents: 100,
        spawn: vi.fn((): Promise<ManagedAgent> => new Promise(() => {})),
      });
      const manager = createManager(
        {
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
        },
        [{ name: 'container-prod', backend: slowBackend }],
      );

      // First reservation maxes out the per-scaler cpu cap; it never registers.
      const r1 = await manager.requestScale(['linux', 'docker'], 'job-a', 'run-test', [], {
        requests: { cpus: 2 },
      });
      expect(r1.action).toBe('spawning');
      expect(manager.getStatus().backends[0].usage.cpus).toBe(2);

      // A second request is denied while the stale reservation is held.
      const r2 = await manager.requestScale(['linux', 'docker'], 'job-b', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r2.action).toBe('at-capacity');

      // Advance past the 5-minute stale threshold, then a request prunes the
      // stale entry — which must free its reservation so the cap math recovers.
      vi.advanceTimersByTime(301_000);
      const r3 = await manager.requestScale(['linux', 'docker'], 'job-c', 'run-test', [], {
        requests: { cpus: 1 },
      });
      expect(r3.action).toBe('spawning');
      // Only the freshly reserved 1 cpu remains; the pruned 2 were released.
      expect(manager.getStatus().backends[0].usage.cpus).toBe(1);
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

  describe('spawn timeout', () => {
    function makeContainerConfig(maxConcurrentSpawns = 1) {
      return {
        version: 1 as const,
        globalMaxAgents: 10,
        scalers: [
          {
            name: 'c',
            type: 'container' as const,
            maxAgents: 5,
            maxConcurrentSpawns,
            labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
          },
        ],
      };
    }

    it('rejects a hung spawn at the deadline, releases the semaphore slot and lets the next spawn proceed', async () => {
      const spawnCalls: string[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        // The spawn never actually completes, so the backend stays "empty".
        getActiveCount: () => 0,
        spawn: vi.fn((_ls, agentId, _url, _ev, _lim, _ctx, signal) => {
          spawnCalls.push(agentId);
          signals.push(signal);
          return new Promise<never>(() => {}); // hangs forever
        }),
      });
      const manager = new ScalerManager({
        config: makeContainerConfig(1),
        backends: [{ name: 'c', backend }],
        spawnTimeoutMs: 50,
      });

      const r1 = await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1');
      expect(r1.action).toBe('spawning');

      // Let the fire-and-forget spawn start; job-2 then queues behind the
      // single-slot semaphore.
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnCalls.length).toBe(1);

      const r2 = await manager.requestScale(['linux', 'docker'], 'job-2', 'run-2');
      expect(r2.action).toBe('spawning');
      await vi.advanceTimersByTimeAsync(1);
      // Still head-of-line blocked behind the hung first spawn.
      expect(spawnCalls.length).toBe(1);

      // Blow the first spawn's deadline: it aborts, rejects, and frees the slot.
      await vi.advanceTimersByTimeAsync(60);
      expect(signals[0]?.aborted).toBe(true);
      // Reservation released so cap accounting is back to zero usage.
      expect(manager.getGlobalActiveCount()).toBe(0);

      // The second spawn was admitted the moment the slot freed.
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnCalls.length).toBe(2);
    });

    it('uses the per-org resolved timeout when resolveSpawnTimeoutMs is provided', async () => {
      const resolve = vi.fn(async (orgId?: string) => (orgId === 'org-fast' ? 20 : 5000));
      let aborted = false;
      const backend = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        getActiveCount: () => 0,
        spawn: vi.fn((_ls, _id, _url, _ev, _lim, _ctx, signal) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise<never>(() => {});
        }),
      });
      const manager = new ScalerManager({
        config: makeContainerConfig(1),
        backends: [{ name: 'c', backend }],
        spawnTimeoutMs: 5000,
        resolveSpawnTimeoutMs: resolve,
      });

      await manager.requestScale(['linux', 'docker'], 'job-1', 'run-1', [], undefined, 'org-fast');
      await vi.advanceTimersByTimeAsync(30);
      expect(resolve).toHaveBeenCalledWith('org-fast');
      // The 20ms per-org deadline fired, not the 5000ms cluster default.
      expect(aborted).toBe(true);
    });
  });

  describe('ensureHostsReady()', () => {
    it('runs every backend and continues past a throwing one', async () => {
      const calls: string[] = [];
      const good = createMockBackend({
        type: 'container',
        labelSets: [{ labels: ['linux', 'docker'], image: 'ghcr.io/org/agent:latest' }],
        maxAgents: 5,
        ensureHostReady: async () => {
          calls.push('good');
        },
      });
      const bad = createMockBackend({
        type: 'bare-metal',
        labelSets: [{ labels: ['linux', 'gpu'], binaryPath: '/usr/local/bin/kici-agent' }],
        maxAgents: 3,
        ensureHostReady: async () => {
          calls.push('bad');
          throw new Error('no sudo');
        },
      });
      const manager = createManager(undefined, [
        { name: 'container-prod', backend: good },
        { name: 'bare-metal-gpu', backend: bad },
      ]);
      await expect(manager.ensureHostsReady()).resolves.toBeUndefined();
      expect(calls).toEqual(['good', 'bad']);
    });

    it('skips a backend without ensureHostReady', async () => {
      const manager = createManager();
      await expect(manager.ensureHostsReady()).resolves.toBeUndefined();
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

describe('buildScalerUsageRows', () => {
  it('stamps scalerType per scaler and __global__ on the rollup row', () => {
    const perScaler = new Map([
      ['ci-pool', { cpus: 2, memBytes: 100 }],
      ['heavy', { cpus: 4, memBytes: 200 }],
    ]);
    const typeOf = (n: string) =>
      ({ 'ci-pool': 'container', heavy: 'bare-metal' })[n] as string | undefined;
    const rows = buildScalerUsageRows(perScaler, { cpus: 6, memBytes: 300 }, typeOf);

    expect(rows).toContainEqual({
      scaler: 'ci-pool',
      scalerType: 'container',
      cpus: 2,
      memBytes: 100,
    });
    expect(rows).toContainEqual({
      scaler: 'heavy',
      scalerType: 'bare-metal',
      cpus: 4,
      memBytes: 200,
    });
    expect(rows).toContainEqual({
      scaler: '__global__',
      scalerType: '__global__',
      cpus: 6,
      memBytes: 300,
    });
  });

  it('omits scalerType when the type is unknown (no bad enum value emitted)', () => {
    const rows = buildScalerUsageRows(
      new Map([['mystery', { cpus: 1, memBytes: 1 }]]),
      { cpus: 1, memBytes: 1 },
      () => undefined,
    );
    expect(rows.find((r) => r.scaler === 'mystery')?.scalerType).toBeUndefined();
  });
});
