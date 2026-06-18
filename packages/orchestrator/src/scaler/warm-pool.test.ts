import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WarmPoolManager, type WarmPoolCallbacks } from './warm-pool.js';

function createCallbacks(): WarmPoolCallbacks & {
  spawnCalls: Array<{ labelSet: string[]; backendName: string }>;
  destroyCalls: Array<{ managedId: string; backendName: string }>;
} {
  const spawnCalls: Array<{ labelSet: string[]; backendName: string }> = [];
  const destroyCalls: Array<{ managedId: string; backendName: string }> = [];

  return {
    spawnCalls,
    destroyCalls,
    onSpawnRequest: vi.fn(async (labelSet: string[], backendName: string) => {
      spawnCalls.push({ labelSet, backendName });
    }),
    onDestroyRequest: vi.fn(async (managedId: string, backendName: string) => {
      destroyCalls.push({ managedId, backendName });
    }),
  };
}

describe('WarmPoolManager', () => {
  let pool: WarmPoolManager;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = createCallbacks();
    pool = new WarmPoolManager(callbacks);
  });

  afterEach(() => {
    pool.stop();
    vi.useRealTimers();
  });

  describe('configure()', () => {
    it('stores config for label set', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });

      expect(pool.getPoolSize('docker,linux')).toBe(0);
    });

    it('initializes empty pool for configured label set', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 2,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });

      // Pool exists but is empty
      expect(pool.getTotalPoolSize()).toBe(0);
    });
  });

  describe('addIdleAgent()', () => {
    it('adds agent to pool', () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      expect(pool.getPoolSize('docker,linux')).toBe(1);
    });

    it('creates pool if not exists', () => {
      pool.addIdleAgent('gpu,linux', 'agent-gpu-1', 'docker-gpu');

      expect(pool.getPoolSize('gpu,linux')).toBe(1);
    });

    it('adds multiple agents to same pool', () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-3', 'docker-prod');

      expect(pool.getPoolSize('docker,linux')).toBe(3);
    });
  });

  describe('consumeAgent()', () => {
    beforeEach(() => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 2,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
    });

    it('returns managedId from pool', () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      const result = pool.consumeAgent('docker,linux');

      expect(result).toBe('agent-1');
      expect(pool.getPoolSize('docker,linux')).toBe(0);
    });

    it('returns null for empty pool', () => {
      const result = pool.consumeAgent('docker,linux');

      expect(result).toBeNull();
    });

    it('returns null for unknown label set', () => {
      const result = pool.consumeAgent('nonexistent');

      expect(result).toBeNull();
    });

    it('is FIFO (first in, first out)', () => {
      pool.addIdleAgent('docker,linux', 'agent-first', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-second', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-third', 'docker-prod');

      expect(pool.consumeAgent('docker,linux')).toBe('agent-first');
      expect(pool.consumeAgent('docker,linux')).toBe('agent-second');
      expect(pool.consumeAgent('docker,linux')).toBe('agent-third');
      expect(pool.consumeAgent('docker,linux')).toBeNull();
    });

    it('triggers replenishment callback after consuming', async () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');

      pool.consumeAgent('docker,linux');

      // Replenishment is scheduled via queueMicrotask
      await vi.advanceTimersToNextTimerAsync();
      // Let microtask run
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // Pool was size=2, after consuming 1 there's 1 left, so deficit=1 -> 1 spawn request
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);
      expect(callbacks.spawnCalls[0]).toEqual({
        labelSet: ['linux', 'docker'],
        backendName: 'docker-prod',
      });
    });
  });

  describe('replenish()', () => {
    it('calls onSpawnRequest for deficit', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      pool.replenish('docker,linux');

      // size=3, pool=1, deficit=2
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
    });

    it('does nothing when pool is at capacity', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 2,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');

      pool.replenish('docker,linux');

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
    });

    it('does nothing for unconfigured label set', () => {
      pool.replenish('unknown');

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
    });
  });

  describe('idle timeout', () => {
    it('destroys agents past idle timeout', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 60,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-old', 'docker-prod');

      // Advance past idle timeout
      vi.advanceTimersByTime(61_000);

      pool.checkIdleTimeouts();

      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('agent-old', 'docker-prod');
      expect(pool.getPoolSize('docker,linux')).toBe(0);
    });

    it('keeps agents within timeout window', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-fresh', 'docker-prod');

      // Advance less than timeout
      vi.advanceTimersByTime(100_000);

      pool.checkIdleTimeouts();

      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
      expect(pool.getPoolSize('docker,linux')).toBe(1);
    });

    it('only destroys expired agents from mixed pool', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 5,
        idleTimeoutSeconds: 120,
        labels: ['linux', 'docker'],
      });

      // Add first agent
      pool.addIdleAgent('docker,linux', 'agent-old', 'docker-prod');

      // Advance 100 seconds
      vi.advanceTimersByTime(100_000);

      // Add second agent (fresher)
      pool.addIdleAgent('docker,linux', 'agent-fresh', 'docker-prod');

      // Advance 30 more seconds (total: old=130s, fresh=30s, timeout=120s)
      vi.advanceTimersByTime(30_000);

      pool.checkIdleTimeouts();

      // Only old agent should be destroyed
      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(1);
      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('agent-old', 'docker-prod');
      expect(pool.getPoolSize('docker,linux')).toBe(1);
    });
  });

  describe('start() / stop()', () => {
    it('start() begins periodic idle checks', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 10,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      pool.start();

      // Advance past idle timeout + one check interval (30s)
      vi.advanceTimersByTime(31_000);

      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('agent-1', 'docker-prod');
    });

    it('stop() clears the interval', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 10,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      pool.start();
      pool.stop();

      // Advance past timeout + check interval
      vi.advanceTimersByTime(60_000);

      // Should not have been called because interval was stopped
      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });

    it('start() is idempotent', () => {
      pool.start();
      pool.start(); // Second call should not create another interval

      // No error thrown, pool works normally
      pool.stop();
    });
  });

  describe('getPoolSize()', () => {
    it('returns correct count for populated pool', () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');

      expect(pool.getPoolSize('docker,linux')).toBe(2);
    });

    it('returns 0 for empty or unknown pool', () => {
      expect(pool.getPoolSize('docker,linux')).toBe(0);
      expect(pool.getPoolSize('unknown')).toBe(0);
    });
  });

  describe('getTotalPoolSize()', () => {
    it('sums all pools', () => {
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');
      pool.addIdleAgent('gpu,linux', 'agent-3', 'docker-gpu');

      expect(pool.getTotalPoolSize()).toBe(3);
    });

    it('returns 0 when all pools are empty', () => {
      expect(pool.getTotalPoolSize()).toBe(0);
    });
  });

  describe('reload()', () => {
    it('drains excess agents when pool size shrinks', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 5,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-2', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-3', 'docker-prod');
      pool.addIdleAgent('docker,linux', 'agent-4', 'docker-prod');

      // Reload with smaller size
      const newConfigs = new Map([
        [
          'docker,linux',
          {
            backendName: 'docker-prod',
            size: 2,
            idleTimeoutSeconds: 300,
            labels: ['linux', 'docker'],
          },
        ],
      ]);

      pool.reload(newConfigs);

      // Should have destroyed 2 excess agents (from position 2 onward)
      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(2);
      expect(callbacks.destroyCalls[0].managedId).toBe('agent-3');
      expect(callbacks.destroyCalls[1].managedId).toBe('agent-4');
      expect(pool.getPoolSize('docker,linux')).toBe(2);
    });

    it('adds new pool configs', () => {
      const newConfigs = new Map([
        [
          'gpu,linux',
          {
            backendName: 'docker-gpu',
            size: 2,
            idleTimeoutSeconds: 120,
            labels: ['linux', 'gpu'],
          },
        ],
      ]);

      pool.reload(newConfigs);

      expect(pool.getPoolSize('gpu,linux')).toBe(0);
    });

    it('does not remove agents from pools whose config was removed', () => {
      pool.configure('docker,linux', 'docker-prod', {
        size: 3,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'docker'],
      });
      pool.addIdleAgent('docker,linux', 'agent-1', 'docker-prod');

      // Reload with a completely different config (old one absent)
      const newConfigs = new Map([
        [
          'gpu,linux',
          {
            backendName: 'docker-gpu',
            size: 2,
            idleTimeoutSeconds: 120,
            labels: ['linux', 'gpu'],
          },
        ],
      ]);

      pool.reload(newConfigs);

      // Old pool agent is still there (idle timeout will handle it)
      expect(pool.getPoolSize('docker,linux')).toBe(1);
      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });
  });
});
