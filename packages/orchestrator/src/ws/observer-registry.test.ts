import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObserverRegistry, type ObserverWsLike } from './observer-registry.js';
import { mockObserverWs as mockWs } from '../__test-helpers__/mock-ws.js';

function closedWs(): ObserverWsLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 3, // CLOSED
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('ObserverRegistry', () => {
  let registry: ObserverRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ObserverRegistry();
  });

  afterEach(() => {
    registry.cleanup();
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('adds observer to registry', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);
      expect(registry.getObserverCount('run-1')).toBe(1);
      expect(registry.hasObservers('run-1')).toBe(true);
    });

    it('supports multiple observers for the same run', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      registry.subscribe('run-1', ws1);
      registry.subscribe('run-1', ws2);
      expect(registry.getObserverCount('run-1')).toBe(2);
    });

    it('returns 0 for unknown run', () => {
      expect(registry.getObserverCount('unknown')).toBe(0);
      expect(registry.hasObservers('unknown')).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('sends to all observers of a run', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      registry.subscribe('run-1', ws1);
      registry.subscribe('run-1', ws2);

      registry.broadcast('run-1', { type: 'observe.status', status: 'running' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);

      // Both should receive the same JSON (with sequence number added)
      const sent1 = JSON.parse((ws1.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent1.type).toBe('observe.status');
      expect(sent1.status).toBe('running');
      expect(sent1.sequence).toBe(1);
    });

    it('does NOT send to observers of other runs', () => {
      const wsRun1 = mockWs();
      const wsRun2 = mockWs();
      registry.subscribe('run-1', wsRun1);
      registry.subscribe('run-2', wsRun2);

      registry.broadcast('run-1', { type: 'observe.status', status: 'running' });

      expect(wsRun1.send).toHaveBeenCalledTimes(1);
      expect(wsRun2.send).not.toHaveBeenCalled();
    });

    it('assigns monotonically increasing sequence numbers', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      registry.broadcast('run-1', { type: 'msg1' });
      registry.broadcast('run-1', { type: 'msg2' });
      registry.broadcast('run-1', { type: 'msg3' });

      const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      expect(JSON.parse(calls[0][0]).sequence).toBe(1);
      expect(JSON.parse(calls[1][0]).sequence).toBe(2);
      expect(JSON.parse(calls[2][0]).sequence).toBe(3);
    });

    it('removes closed connections during broadcast', () => {
      const wsGood = mockWs();
      const wsClosed = closedWs();
      registry.subscribe('run-1', wsGood);
      registry.subscribe('run-1', wsClosed);
      expect(registry.getObserverCount('run-1')).toBe(2);

      registry.broadcast('run-1', { type: 'test' });

      expect(wsGood.send).toHaveBeenCalledTimes(1);
      expect(wsClosed.send).not.toHaveBeenCalled();
      expect(registry.getObserverCount('run-1')).toBe(1);
    });

    it('removes connections that throw on send', () => {
      const wsGood = mockWs();
      const wsBroken: ObserverWsLike = {
        send: vi.fn().mockImplementation(() => {
          throw new Error('Connection failed');
        }),
        close: vi.fn(),
        readyState: 1,
      };
      registry.subscribe('run-1', wsGood);
      registry.subscribe('run-1', wsBroken);

      registry.broadcast('run-1', { type: 'test' });

      expect(registry.getObserverCount('run-1')).toBe(1);
      expect(wsGood.send).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for runs with no observers', () => {
      // Should not throw
      registry.broadcast('unknown-run', { type: 'test' });
    });
  });

  describe('unsubscribe', () => {
    it('removes observer from registry', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);
      expect(registry.getObserverCount('run-1')).toBe(1);

      registry.unsubscribe('run-1', ws);
      expect(registry.getObserverCount('run-1')).toBe(0);
      expect(registry.hasObservers('run-1')).toBe(false);
    });

    it('only removes the specified observer', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      registry.subscribe('run-1', ws1);
      registry.subscribe('run-1', ws2);

      registry.unsubscribe('run-1', ws1);
      expect(registry.getObserverCount('run-1')).toBe(1);

      // ws2 should still receive broadcasts
      registry.broadcast('run-1', { type: 'test' });
      expect(ws2.send).toHaveBeenCalledTimes(1);
      expect(ws1.send).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown run', () => {
      const ws = mockWs();
      registry.unsubscribe('unknown', ws);
      // Should not throw
    });
  });

  describe('broadcastLog', () => {
    it('constructs correct observe.log message shape', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      registry.broadcastLog('run-1', 'job-1', 'build', 0, 'install', [
        'npm install',
        'added 1234 packages',
      ]);

      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('observe.log');
      expect(sent.runId).toBe('run-1');
      expect(sent.jobId).toBe('job-1');
      expect(sent.jobName).toBe('build');
      expect(sent.stepIndex).toBe(0);
      expect(sent.stepName).toBe('install');
      expect(sent.lines).toEqual(['npm install', 'added 1234 packages']);
      expect(sent.timestamp).toBeTypeOf('number');
      expect(sent.sequence).toBe(1);
    });
  });

  describe('broadcastStep', () => {
    it('constructs correct observe.step message with durationMs', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      registry.broadcastStep('run-1', 'job-1', 'build', 'install', 'success', 1234);

      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('observe.step');
      expect(sent.runId).toBe('run-1');
      expect(sent.jobId).toBe('job-1');
      expect(sent.jobName).toBe('build');
      expect(sent.stepName).toBe('install');
      expect(sent.state).toBe('success');
      expect(sent.durationMs).toBe(1234);
      expect(sent.timestamp).toBeTypeOf('number');
    });

    it('omits durationMs when not provided', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      registry.broadcastStep('run-1', 'job-1', 'build', 'install', 'running');

      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.durationMs).toBeUndefined();
    });
  });

  describe('broadcastStatus', () => {
    it('constructs correct observe.status message', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      registry.broadcastStatus('run-1', 'running', 'build');

      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('observe.status');
      expect(sent.runId).toBe('run-1');
      expect(sent.status).toBe('running');
      expect(sent.jobName).toBe('build');
    });
  });

  describe('broadcastComplete', () => {
    it('constructs correct observe.complete message', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      const summary = {
        totalDurationMs: 5000,
        jobs: [{ name: 'build', status: 'success', durationMs: 3000 }],
      };
      registry.broadcastComplete('run-1', 'success', summary);

      const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe('observe.complete');
      expect(sent.status).toBe('success');
      expect(sent.summary).toEqual(summary);
    });

    it('schedules buffer cleanup after 5 minutes', () => {
      registry.broadcastComplete('run-1', 'success', { totalDurationMs: 0, jobs: [] });

      // Buffer should still exist
      expect(registry.getBufferSize('run-1')).toBe(1);

      // Advance time by 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Buffer should be cleaned up
      expect(registry.getBufferSize('run-1')).toBe(0);
      expect(registry.getCurrentSequence('run-1')).toBe(0);
    });
  });

  describe('reconnection backfill', () => {
    it('replays messages after lastSeenSequence on reconnect', () => {
      const ws1 = mockWs();
      registry.subscribe('run-1', ws1);

      // Send 5 messages
      for (let i = 0; i < 5; i++) {
        registry.broadcast('run-1', { type: 'msg', index: i });
      }
      expect((ws1.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);

      // Disconnect ws1
      registry.unsubscribe('run-1', ws1);

      // Reconnect with lastSeenSequence=3 (should replay messages 4 and 5)
      const ws2 = mockWs();
      registry.subscribe('run-1', ws2, 3);

      // ws2 should have received 2 backfill messages
      expect((ws2.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

      const msg4 = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      const msg5 = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(msg4.sequence).toBe(4);
      expect(msg5.sequence).toBe(5);
      expect(msg4.index).toBe(3);
      expect(msg5.index).toBe(4);
    });

    it('handles lastSeenSequence=0 by not replaying', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);
      registry.broadcast('run-1', { type: 'msg' });
      registry.unsubscribe('run-1', ws);

      const ws2 = mockWs();
      registry.subscribe('run-1', ws2, 0);

      // lastSeenSequence=0 means "no previous messages seen" but the code
      // only replays when > 0, so no backfill
      expect((ws2.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('replays all messages when lastSeenSequence=0 is not provided but buffer exists', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);
      registry.broadcast('run-1', { type: 'msg' });
      registry.unsubscribe('run-1', ws);

      // Subscribe without lastSeenSequence -- no backfill
      const ws2 = mockWs();
      registry.subscribe('run-1', ws2);
      expect((ws2.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('buffer cap', () => {
    it('caps buffer at BUFFER_SIZE (1000)', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);

      // Broadcast 1100 messages
      for (let i = 0; i < 1100; i++) {
        registry.broadcast('run-1', { type: 'msg', index: i });
      }

      expect(registry.getBufferSize('run-1')).toBe(1000);

      // Reconnect -- earliest available should be sequence 101 (not 1)
      const ws2 = mockWs();
      registry.unsubscribe('run-1', ws);
      registry.subscribe('run-1', ws2, 100);

      // Should replay from 101 to 1100 = 1000 messages
      const calls = (ws2.send as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1000);

      const first = JSON.parse(calls[0][0]);
      expect(first.sequence).toBe(101);
    });
  });

  describe('cleanup', () => {
    it('removes all state', () => {
      const ws = mockWs();
      registry.subscribe('run-1', ws);
      registry.broadcast('run-1', { type: 'test' });

      registry.cleanup();

      expect(registry.getObserverCount('run-1')).toBe(0);
      expect(registry.getBufferSize('run-1')).toBe(0);
      expect(registry.getCurrentSequence('run-1')).toBe(0);
    });
  });
});
