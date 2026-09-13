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

// ── Tests ───────────────────────────────────────────────────────

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

    // Should NOT be disconnected
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

    // Agent should be disconnected
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

    // Stop before any meaningful check
    monitor.stop();

    // Advance far past disconnect threshold
    vi.advanceTimersByTime(300_000);

    // Should NOT have been disconnected since we stopped
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

    // Advance 90s
    vi.advanceTimersByTime(90_000);

    // Now update heartbeat for agent-healthy
    registry.updateHeartbeat('agent-healthy');

    // Advance another 120s (total 210s for agent-stale, 120s for agent-healthy)
    vi.advanceTimersByTime(120_000);

    // agent-stale should be disconnected
    expect(ws1.close).toHaveBeenCalledWith(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-stale');

    // agent-healthy should NOT be disconnected (120s < 180s)
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

    // Default check interval is 30s, disconnect threshold is 180s
    // Advance 210s (past disconnect threshold + one check interval)
    vi.advanceTimersByTime(210_000);

    expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_HEARTBEAT_TIMEOUT, 'Heartbeat timeout');
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');

    monitor.stop();
  });

  it('stores dynamic metadata in AgentEntry after status update', () => {
    const ws = mockWs();
    registry.register('agent-meta', ws, ['linux'], 'linux', 'x64');

    // Verify initial metadata is null
    const entry = registry.get('agent-meta')!;
    expect(entry.memoryUsedMb).toBeNull();
    expect(entry.memoryAvailableMb).toBeNull();
    expect(entry.uptimeSeconds).toBeNull();

    // Simulate agent.status handler updating dynamic metadata
    entry.memoryUsedMb = 4096;
    entry.memoryAvailableMb = 12288;
    entry.uptimeSeconds = 86400;

    // Verify metadata is stored
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

    // Multiple starts should not create multiple intervals
    monitor.start();
    monitor.start();
    monitor.start();

    // Register and advance to verify only one check fires
    const ws = mockWs();
    registry.register('agent-1', ws, ['linux'], 2);

    // Advance past disconnect threshold
    vi.advanceTimersByTime(210_000);

    // onAgentDisconnect should be called exactly once
    expect(dispatcher.onAgentDisconnect).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});
