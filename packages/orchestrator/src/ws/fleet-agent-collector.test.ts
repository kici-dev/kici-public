import { describe, it, expect, vi } from 'vitest';
import { FleetAgentCollector } from './fleet-agent-collector.js';
import { chunkBuffer } from '@kici-dev/shared';

describe('FleetAgentCollector', () => {
  it('resolves with the reassembled buffer when all chunks arrive', async () => {
    const c = new FleetAgentCollector({ timeoutMs: 1000 });
    const payload = Buffer.from('hello fleet'.repeat(100));
    const send = vi.fn();
    const p = c.request('req-1', 'agent-a', send);
    expect(send).toHaveBeenCalledTimes(1); // the fleet.logs.request was sent
    for (const f of chunkBuffer(payload)) c.onChunk('req-1', f.seq, f.dataB64, f.isLast);
    await expect(p).resolves.toEqual(payload);
  });

  it('rejects on error frame', async () => {
    const c = new FleetAgentCollector({ timeoutMs: 1000 });
    const p = c.request('req-2', 'agent-a', () => {});
    c.onError('req-2', 'boom');
    await expect(p).rejects.toThrow('boom');
  });

  it('rejectAgent rejects only the disconnected agent’s requests', async () => {
    const c = new FleetAgentCollector({ timeoutMs: 1000 });
    const pA = c.request('req-a', 'agent-a', () => {});
    const pB = c.request('req-b', 'agent-b', () => {});
    c.rejectAgent('agent-a', 'agent disconnected');
    await expect(pA).rejects.toThrow('agent disconnected');
    // agent-b's request is still pending — resolve it to prove it survived.
    for (const f of chunkBuffer(Buffer.from('x'))) c.onChunk('req-b', f.seq, f.dataB64, f.isLast);
    await expect(pB).resolves.toEqual(Buffer.from('x'));
  });

  it('rejects all pending on rejectAll', async () => {
    const c = new FleetAgentCollector({ timeoutMs: 1000 });
    const p = c.request('req-3', 'agent-a', () => {});
    c.rejectAll('shutdown');
    await expect(p).rejects.toThrow('shutdown');
  });

  it('rejects on timeout', async () => {
    const c = new FleetAgentCollector({ timeoutMs: 5 });
    const p = c.request('req-4', 'agent-a', () => {});
    await expect(p).rejects.toThrow(/timed out/);
  });
});
