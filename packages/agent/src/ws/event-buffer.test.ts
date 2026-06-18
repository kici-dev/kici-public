import { describe, it, expect } from 'vitest';
import type { AgentToOrchestratorMessage } from '@kici-dev/engine';
import { EventBuffer } from './event-buffer.js';

function createJobStatus(id: string): AgentToOrchestratorMessage {
  return {
    type: 'job.status',
    messageId: id,
    runId: `run-${id}`,
    jobId: `job-${id}`,
    state: 'running',
    timestamp: Date.now(),
  };
}

function createLogChunk(id: string): AgentToOrchestratorMessage {
  return {
    type: 'log.chunk',
    messageId: id,
    runId: `run-${id}`,
    jobId: `job-${id}`,
    stepIndex: 0,
    lines: ['hello world'],
    timestamp: Date.now(),
  };
}

describe('EventBuffer', () => {
  // Generic ring buffer behavior (add/flush/size/clear/overflow) is tested
  // in @kici-dev/shared RingBuffer tests. These tests focus on agent-specific
  // concerns: message type compatibility and custom default maxSize.

  it('defaults to 5000 max size', () => {
    const buffer = new EventBuffer();
    for (let i = 0; i < 5_001; i++) {
      buffer.add(createJobStatus(String(i)));
    }
    expect(buffer.size()).toBe(5_000);
  });

  describe('works with real message shapes', () => {
    it('handles job.status messages', () => {
      const buffer = new EventBuffer();
      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'success',
        timestamp: Date.now(),
        data: { exitCode: 0 },
      };

      buffer.add(msg);
      const flushed = buffer.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual(msg);
    });

    it('handles log.chunk messages', () => {
      const buffer = new EventBuffer();
      const msg: AgentToOrchestratorMessage = {
        type: 'log.chunk',
        messageId: 'msg-2',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: ['Step 1 output', 'Step 1 done'],
        timestamp: Date.now(),
      };

      buffer.add(msg);
      const flushed = buffer.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual(msg);
    });

    it('handles step.status messages', () => {
      const buffer = new EventBuffer();
      const msg: AgentToOrchestratorMessage = {
        type: 'step.status',
        messageId: 'msg-3',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        stepName: 'Build',
        state: 'running',
        timestamp: Date.now(),
      };

      buffer.add(msg);
      const flushed = buffer.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual(msg);
    });

    it('handles mixed message types in order', () => {
      const buffer = new EventBuffer();
      buffer.add(createJobStatus('1'));
      buffer.add(createLogChunk('2'));
      buffer.add({
        type: 'step.status',
        messageId: '3',
        runId: 'run-3',
        jobId: 'job-3',
        stepIndex: 1,
        stepName: 'Test',
        state: 'success',
        timestamp: Date.now(),
      });

      const flushed = buffer.flush();
      expect(flushed).toHaveLength(3);
      expect(flushed[0].type).toBe('job.status');
      expect(flushed[1].type).toBe('log.chunk');
      expect(flushed[2].type).toBe('step.status');
    });
  });
});
