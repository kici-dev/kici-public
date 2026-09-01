import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WarmPoolManager, type WarmPoolCallbacks } from './warm-pool.js';

/** A registry stand-in the tests drive directly. */
interface FakeRegistry {
  /** Agents the dispatcher would find for any label set. */
  available: number;
  /** Idle agents the reaper may destroy, per backend name. */
  idle: Map<string, Array<{ agentId: string; registeredAt: number }>>;
  /** Cap headroom per backend name. Absent means unbounded. */
  capacity: Map<string, number>;
}

function createCallbacks(registry: FakeRegistry): WarmPoolCallbacks & {
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
    countAvailable: vi.fn(() => registry.available),
    listIdle: vi.fn(
      (_labels: string[], backendName: string) => registry.idle.get(backendName) ?? [],
    ),
    capacityRemaining: vi.fn(
      (backendName: string) => registry.capacity.get(backendName) ?? Number.MAX_SAFE_INTEGER,
    ),
  };
}

describe('WarmPoolManager', () => {
  let pool: WarmPoolManager;
  let callbacks: ReturnType<typeof createCallbacks>;
  let registry: FakeRegistry;

  const DOCKER_LABELS = ['linux', 'docker'];

  function configureDocker(size = 2, idleTimeoutSeconds = 300): void {
    pool.configure('docker,linux', 'docker-prod', {
      size,
      idleTimeoutSeconds,
      labels: DOCKER_LABELS,
      spawnLabels: DOCKER_LABELS,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    registry = { available: 0, idle: new Map(), capacity: new Map() };
    callbacks = createCallbacks(registry);
    pool = new WarmPoolManager(callbacks);
  });

  afterEach(() => {
    pool.stop();
    vi.useRealTimers();
  });

  describe('configure()', () => {
    it('registers a label set with no ready agents', () => {
      configureDocker(3);

      expect(pool.getTotalPoolSize()).toBe(0);
      expect(pool.getStats()).toEqual([
        {
          key: 'docker,linux',
          labels: DOCKER_LABELS,
          backendName: 'docker-prod',
          target: 3,
          ready: 0,
          inFlight: 0,
        },
      ]);
    });
  });

  describe('evaluate()', () => {
    it('spawns exactly the deficit', () => {
      configureDocker(2);

      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
      expect(callbacks.onSpawnRequest).toHaveBeenCalledWith(DOCKER_LABELS, 'docker-prod');
    });

    it('queries with the widened labels but spawns with the declared set', () => {
      // A tainted pool measures readiness with its declared labels PLUS the
      // platform taints, because each agent's mandatory-labels gate demands
      // them. The backend knows only the declared set — it resolves the image /
      // binary by matching the requested set against its own `labelSets` and
      // throws on anything else — so the two must not be the same array.
      pool.configure('docker,linux', 'docker-prod', {
        size: 1,
        idleTimeoutSeconds: 300,
        labels: [...DOCKER_LABELS, 'arm64'],
        spawnLabels: DOCKER_LABELS,
      });

      pool.evaluate();

      expect(callbacks.countAvailable).toHaveBeenCalledWith([...DOCKER_LABELS, 'arm64']);
      expect(callbacks.onSpawnRequest).toHaveBeenCalledWith(DOCKER_LABELS, 'docker-prod');
    });

    it('spawns only what is missing when some agents are ready', () => {
      configureDocker(3);
      registry.available = 2;

      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);
    });

    it('spawns nothing when the pool is at target', () => {
      configureDocker(2);
      registry.available = 2;

      pool.evaluate();

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
    });

    it('does not double-spawn across two passes before registration', () => {
      configureDocker(2);

      pool.evaluate();
      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
    });

    it('resumes filling once an in-flight spawn registers', () => {
      configureDocker(2);

      pool.evaluate();
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);

      // The agent registered but is busy, so `available` has not moved: only
      // the in-flight ledger frees a slot.
      pool.onWarmAgentRegistered(DOCKER_LABELS);
      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(3);
    });

    it('retries after a failed spawn', () => {
      configureDocker(2);

      pool.evaluate();
      pool.onWarmSpawnFailed(DOCKER_LABELS);
      pool.onWarmSpawnFailed(DOCKER_LABELS);
      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(4);
    });

    it('releases the slot when the spawn request itself rejects', async () => {
      configureDocker(2);
      callbacks.onSpawnRequest = vi.fn(() => Promise.reject(new Error('backend gone')));

      pool.evaluate();
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
      // The rejection never reaches the ScalerManager's own failure path, so
      // only the pool's own handler can free the slots.
      await Promise.resolve();
      await Promise.resolve();
      expect(pool.getStats()[0].inFlight).toBe(0);

      pool.evaluate();

      // Still a full deficit: a held slot would have made this pass spawn nothing.
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(4);
    });

    it('is inert for a size-0 pool', () => {
      configureDocker(0);

      pool.evaluate();

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
      expect(callbacks.countAvailable).not.toHaveBeenCalled();
    });

    it('skips a label set whose registry read throws', () => {
      configureDocker(2);
      callbacks.countAvailable = vi.fn(() => {
        throw new Error('registry unavailable');
      });

      pool.evaluate();

      // An unreadable registry is not evidence of an empty pool.
      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
    });

    it('clamps the deficit to the backend cap headroom', () => {
      configureDocker(5);
      registry.capacity.set('docker-prod', 2);

      pool.evaluate();

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
    });

    it('spawns nothing when the backend is at capacity', () => {
      configureDocker(3);
      registry.capacity.set('docker-prod', 0);

      pool.evaluate();

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
      expect(pool.getStats()[0].inFlight).toBe(0);
    });

    it('shares one cap budget across label sets on the same backend', () => {
      configureDocker(2);
      pool.configure('gpu,linux', 'docker-prod', {
        size: 2,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'gpu'],
        spawnLabels: ['linux', 'gpu'],
      });
      registry.capacity.set('docker-prod', 3);

      pool.evaluate();

      // 2 for the first label set, 1 left for the second — never 4.
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(3);
    });

    it('skips a label set whose capacity read throws', () => {
      configureDocker(2);
      callbacks.capacityRemaining = vi.fn(() => {
        throw new Error('backend gone');
      });

      pool.evaluate();

      expect(callbacks.onSpawnRequest).not.toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('fills immediately rather than a tick later', () => {
      configureDocker(1);

      pool.start();

      // Waiting for the first interval would leave the pool empty for 30
      // seconds after every restart — the cold start it exists to remove.
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);
    });

    it('runs a deficit pass on every tick', () => {
      configureDocker(1);
      pool.start();
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);

      // The first spawn registered and is ready, so the next tick is a no-op.
      pool.onWarmAgentRegistered(DOCKER_LABELS);
      registry.available = 1;
      vi.advanceTimersByTime(30_000);
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);

      // …and it resumes once that agent goes away.
      registry.available = 0;
      vi.advanceTimersByTime(30_000);
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(2);
    });

    it('is idempotent', () => {
      configureDocker(1);
      pool.start();
      pool.start();

      // One immediate pass, not one per call. On its own this proves little —
      // a second immediate pass would find the first spawn in flight and do
      // nothing — so the interval count is what the rest of the case pins.
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);

      // `stop()` clears the ONE handle the pool kept, so a second interval
      // would outlive it and keep filling. Free the in-flight slot first, or
      // the ledger alone holds the count at 1 and this asserts nothing.
      pool.stop();
      pool.onWarmSpawnFailed(DOCKER_LABELS);
      vi.advanceTimersByTime(90_000);

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);
    });

    it('stops ticking after stop()', () => {
      configureDocker(1);
      pool.start();
      pool.stop();
      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);

      // The immediate pass left a slot in flight, and a deficit of zero would
      // keep the count at 1 whether or not the interval is still running.
      // Releasing it is what makes a surviving tick observable.
      pool.onWarmSpawnFailed(DOCKER_LABELS);
      vi.advanceTimersByTime(90_000);

      expect(callbacks.onSpawnRequest).toHaveBeenCalledTimes(1);
    });

    it('publishes stats on each tick', () => {
      const onTick = vi.fn();
      const withTick = new WarmPoolManager({ ...callbacks, onTick });
      withTick.configure('docker,linux', 'docker-prod', {
        size: 1,
        idleTimeoutSeconds: 300,
        labels: DOCKER_LABELS,
        spawnLabels: DOCKER_LABELS,
      });

      withTick.start();
      expect(onTick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(onTick).toHaveBeenCalledTimes(2);

      withTick.stop();
    });
  });

  describe('checkIdleTimeouts()', () => {
    it('destroys only the surplus agents idle past the timeout', () => {
      vi.setSystemTime(new Date(1_000_000));
      configureDocker(1, 300);
      registry.idle.set('docker-prod', [
        { agentId: 'older', registeredAt: 1_000_000 - 400_000 },
        { agentId: 'old', registeredAt: 1_000_000 - 301_000 },
      ]);

      pool.checkIdleTimeouts();

      // Two ready agents against a target of 1: exactly one is surplus, and it
      // is the older of the two.
      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(1);
      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('older', 'docker-prod');
    });

    it('never reaps a pool sitting at its target', () => {
      vi.setSystemTime(new Date(1_000_000));
      configureDocker(2, 300);
      registry.idle.set('docker-prod', [
        { agentId: 'a', registeredAt: 1_000_000 - 900_000 },
        { agentId: 'b', registeredAt: 1_000_000 - 800_000 },
      ]);

      pool.checkIdleTimeouts();

      // Both are far past the timeout, and both ARE the pool. Reaping them
      // would destroy the agent and immediately re-spawn it, forever, on a
      // pool nothing is using.
      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });

    it('drains every ready agent when the target is 0', () => {
      vi.setSystemTime(new Date(1_000_000));
      configureDocker(0, 300);
      registry.idle.set('docker-prod', [
        { agentId: 'a', registeredAt: 1_000_000 - 400_000 },
        { agentId: 'b', registeredAt: 1_000_000 - 350_000 },
      ]);

      pool.checkIdleTimeouts();

      // Every agent is surplus at size 0, so setting size to 0 makes the pool
      // go away rather than freezing it at its current membership.
      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(2);
    });

    it('leaves a fresh agent alone', () => {
      vi.setSystemTime(new Date(1_000_000));
      // Target 0, so the agent IS surplus: only the age gate can spare it.
      configureDocker(0, 300);
      registry.idle.set('docker-prod', [{ agentId: 'fresh', registeredAt: 1_000_000 - 10_000 }]);

      pool.checkIdleTimeouts();

      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });

    it('destroys nothing when the idle read throws', () => {
      vi.setSystemTime(new Date(1_000_000));
      configureDocker(2, 300);
      callbacks.listIdle = vi.fn(() => {
        throw new Error('registry unavailable');
      });

      pool.checkIdleTimeouts();

      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });
  });

  describe('getStats()', () => {
    it('reports target, ready and in-flight per label set', () => {
      configureDocker(2);
      registry.available = 1;

      pool.evaluate();

      expect(pool.getStats()).toEqual([
        {
          key: 'docker,linux',
          labels: DOCKER_LABELS,
          backendName: 'docker-prod',
          target: 2,
          ready: 1,
          inFlight: 1,
        },
      ]);
    });

    it('reports zero ready when the registry read throws', () => {
      configureDocker(2);
      callbacks.countAvailable = vi.fn(() => {
        throw new Error('registry unavailable');
      });

      expect(pool.getStats()[0].ready).toBe(0);
    });
  });

  describe('getTotalPoolSize()', () => {
    it('sums ready agents across configured pools', () => {
      configureDocker(2);
      pool.configure('gpu,linux', 'docker-gpu', {
        size: 1,
        idleTimeoutSeconds: 300,
        labels: ['linux', 'gpu'],
        spawnLabels: ['linux', 'gpu'],
      });
      registry.available = 2;

      expect(pool.getTotalPoolSize()).toBe(4);
    });

    it('returns 0 when nothing is configured', () => {
      expect(pool.getTotalPoolSize()).toBe(0);
    });
  });

  describe('reload()', () => {
    it('destroys the surplus when the pool size shrinks', () => {
      configureDocker(5);
      registry.idle.set('docker-prod', [
        { agentId: 'agent-1', registeredAt: 1000 },
        { agentId: 'agent-2', registeredAt: 2000 },
        { agentId: 'agent-3', registeredAt: 3000 },
        { agentId: 'agent-4', registeredAt: 4000 },
      ]);

      pool.reload(
        new Map([
          [
            'docker,linux',
            {
              backendName: 'docker-prod',
              size: 2,
              idleTimeoutSeconds: 300,
              labels: DOCKER_LABELS,
              spawnLabels: DOCKER_LABELS,
            },
          ],
        ]),
      );

      // Oldest first: the two with the most idle time already spent go.
      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(2);
      expect(callbacks.destroyCalls.map((c) => c.managedId)).toEqual(['agent-1', 'agent-2']);
    });

    it('adds new pool configs', () => {
      pool.reload(
        new Map([
          [
            'gpu,linux',
            {
              backendName: 'docker-gpu',
              size: 2,
              idleTimeoutSeconds: 120,
              labels: ['linux', 'gpu'],
              spawnLabels: ['linux', 'gpu'],
            },
          ],
        ]),
      );

      expect(pool.getStats()).toEqual([
        {
          key: 'gpu,linux',
          labels: ['linux', 'gpu'],
          backendName: 'docker-gpu',
          target: 2,
          ready: 0,
          inFlight: 0,
        },
      ]);
    });

    it('destroys idle agents whose config was removed', () => {
      configureDocker(3);
      registry.idle.set('docker-prod', [
        { agentId: 'agent-1', registeredAt: 1000 },
        { agentId: 'agent-2', registeredAt: 2000 },
      ]);

      // The scaler was deleted from the config: its key is absent from the new map.
      pool.reload(new Map());

      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(2);
      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('agent-1', 'docker-prod');
      expect(callbacks.onDestroyRequest).toHaveBeenCalledWith('agent-2', 'docker-prod');
      expect(pool.getStats()).toEqual([]);
    });

    it('destroys idle agents when only a different pool survives the reload', () => {
      configureDocker(3);
      registry.idle.set('docker-prod', [{ agentId: 'agent-1', registeredAt: 1000 }]);

      pool.reload(
        new Map([
          [
            'gpu,linux',
            {
              backendName: 'docker-gpu',
              size: 2,
              idleTimeoutSeconds: 120,
              labels: ['linux', 'gpu'],
              spawnLabels: ['linux', 'gpu'],
            },
          ],
        ]),
      );

      expect(callbacks.onDestroyRequest).toHaveBeenCalledTimes(1);
      expect(callbacks.destroyCalls[0].managedId).toBe('agent-1');
    });

    it('leaves a still-configured pool untouched', () => {
      configureDocker(2);
      registry.idle.set('docker-prod', [{ agentId: 'agent-1', registeredAt: 1000 }]);

      pool.reload(
        new Map([
          [
            'docker,linux',
            {
              backendName: 'docker-prod',
              size: 2,
              idleTimeoutSeconds: 300,
              labels: DOCKER_LABELS,
              spawnLabels: DOCKER_LABELS,
            },
          ],
        ]),
      );

      expect(callbacks.onDestroyRequest).not.toHaveBeenCalled();
    });

    it('drops the in-flight ledger for a removed pool', () => {
      configureDocker(2);
      pool.evaluate();
      expect(pool.getStats()[0].inFlight).toBe(2);

      pool.reload(new Map());
      configureDocker(2);

      // A re-added pool starts with a clean ledger, not the removed pool's.
      expect(pool.getStats()[0].inFlight).toBe(0);
    });
  });
});
