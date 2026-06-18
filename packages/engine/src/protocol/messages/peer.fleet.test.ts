import { describe, it, expect } from 'vitest';
import {
  peerLogsCollectRequestSchema,
  peerLogsCollectChunkSchema,
  peerLogsCollectErrorSchema,
  peerToPeerMessageSchema,
  peerFromPeerMessageSchema,
} from './peer.js';

describe('peer fleet collect messages', () => {
  it('parses a peer.logs.collect.request with selection + loop guard', () => {
    const m = {
      type: 'peer.logs.collect.request',
      messageId: 'm1',
      logWindowHours: 4,
      includeCoordinatorMesh: false,
      selection: { all: false, agentIds: ['a1'], workerInstanceIds: ['w1'] },
    };
    expect(peerLogsCollectRequestSchema.parse(m).selection.agentIds).toEqual(['a1']);
    expect(peerToPeerMessageSchema.parse(m).type).toBe('peer.logs.collect.request');
    expect(peerFromPeerMessageSchema.parse(m).type).toBe('peer.logs.collect.request');
  });

  it('parses chunk + error', () => {
    const c = {
      type: 'peer.logs.collect.chunk',
      messageId: 'm1',
      seq: 0,
      isLast: true,
      dataB64: 'AA==',
    };
    expect(peerLogsCollectChunkSchema.parse(c).isLast).toBe(true);
    const e = { type: 'peer.logs.collect.error', messageId: 'm1', message: 'x' };
    expect(peerLogsCollectErrorSchema.parse(e).message).toBe('x');
  });
});
