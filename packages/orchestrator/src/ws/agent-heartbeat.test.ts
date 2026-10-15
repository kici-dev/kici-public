import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentHeartbeatMonitor } from './agent-heartbeat.js';
import { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import { WS_CLOSE_HEARTBEAT_TIMEOUT } from '@kici-dev/engine';
import { mockWs } from '../__test-helpers__/mock-ws.js';

function mockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'queued', jobId: 'test' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
  } as unknown as Dispatcher;
}

describe('AgentHeartbeatMonitor', () => {
  let registry: AgentRegistry;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new AgentRegistry();
    dispatcher = mockDispatcher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not act on agents with recent heartbeat', () => {
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      unhealthyThresholdMs: 90_000,
      disconnectThresholdMs: 180_000,
      checkIntervalMs: 30_000,
    });
    monitor.start();

    // Advance 30s (first check, but heartbeat is fresh)
    vi.advanceTimersByTime(30_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
    expect(registry.get('agent-1')).toBeDefined();

    monitor.stop();
  });

  it('logs but does not disconnect agents past unhealthy threshold', () => {
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      unhealthyThresholdMs: 90_000,
      disconnectThresholdMs: 180_000,
      checkIntervalMs: 30_000,
    });
    monitor.start();

    // Advance 120s (past 90s unhealthy, but below 180s disconnect)
    vi.advanceTimersByTime(120_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
    expect(registry.get('agent-1')).toBeDefined();

    monitor.stop();
  });

  it('disconnects agents past disconnect threshold', () => {
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      unhealthyThresholdMs: 90_000,
      disconnectThresholdMs: 180_000,
      checkIntervalMs: 30_000,
    });
    monitor.start();

    // Advance past 180s + next check interval (210s = 7 checks)
    vi.advanceTimersByTime(210_000);

    expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');

    monitor.stop();
  });

  it('stop() prevents further checks', () => {
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      unhealthyThresholdMs: 90_000,
      disconnectThresholdMs: 180_000,
      checkIntervalMs: 30_000,
    });
    monitor.start();

    monitor.stop();

    vi.advanceTimersByTime(300_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
  });

  it('only disconnects stale agents, not healthy ones', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register('agent-stale', ws1, ['linux'], 2);
    registry.register('agent-healthy', ws2, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      unhealthyThresholdMs: 90_000,
      disconnectThresholdMs: 180_000,
      checkIntervalMs: 30_000,
    });
    monitor.start();

    vi.advanceTimersByTime(90_000);

    registry.updateHeartbeat('agent-healthy');

    // Advance another 120s (total 210s for agent-stale, 120s for agent-healthy)
    vi.advanceTimersByTime(120_000);

    expect(ws1.close).toHaveBeenCalledWith(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-stale');

    // agent-healthy: 120s < 180s
    expect(ws2.close).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('uses default thresholds when not specified', () => {
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
    });
    monitor.start();

    // Defaults: 30s check interval, 180s disconnect threshold.
    vi.advanceTimersByTime(210_000);

    expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');

    monitor.stop();
  });

  it('stores dynamic metadata in AgentEntry after status update', () => {
    const ws = mockWs();
    registry.register('agent-meta', ws, ['linux'], 'linux', 'x64');

    const entry = registry.get('agent-meta')!;
    expect(entry.memoryUsedMb).toBeNull();
    expect(entry.memoryAvailableMb).toBeNull();
    expect(entry.uptimeSeconds).toBeNull();

    entry.memoryUsedMb = 4096;
    entry.memoryAvailableMb = 12288;
    entry.uptimeSeconds = 86400;

    const updated = registry.get('agent-meta')!;
    expect(updated.memoryUsedMb).toBe(4096);
    expect(updated.memoryAvailableMb).toBe(12288);
    expect(updated.uptimeSeconds).toBe(86400);
  });

  it('start() is idempotent', () => {
    const monitor = new AgentHeartbeatMonitor({
      registry,
      dispatcher,
      checkIntervalMs: 30_000,
    });

    monitor.start();
    monitor.start();
    monitor.start();

    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    vi.advanceTimersByTime(210_000);

    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});
