import { describe, it, expect } from 'vitest';
import type { OrchestratorToPlatformMessage } from '@kici-dev/engine';
import { EventBuffer } from './event-buffer.js';

describe('EventBuffer', () => {
  // Generic ring buffer behavior (add/flush/size/clear/overflow) is tested
  // in @kici-dev/shared RingBuffer tests. These tests verify orchestrator-specific
  // concerns: OrchestratorToPlatformMessage type compatibility and default maxSize.

  it('buffers and flushes OrchestratorToPlatformMessage objects', () => {
    const buffer = new EventBuffer();
    const msg: OrchestratorToPlatformMessage = {
      type: 'webhook.ack',
      messageId: 'ack-1',
      deliveryId: 'delivery-1',
    };

    buffer.add(msg);
    const flushed = buffer.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(msg);
  });

  it('inherits default maxSize of 10000 from RingBuffer', () => {
    const buffer = new EventBuffer();
    for (let i = 0; i < 10_001; i++) {
      buffer.add({ type: 'webhook.ack', messageId: String(i), deliveryId: `d-${i}` });
    }
    expect(buffer.size()).toBe(10_000);
  });
});
