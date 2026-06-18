import { describe, it, expect } from 'vitest';
import {
  chunkBuffer,
  BundleChunkAssembler,
  ChunkRequestWaiter,
  FLEET_CHUNK_BYTES,
} from './bundle-chunks.js';

describe('chunkBuffer / BundleChunkAssembler', () => {
  it('round-trips a buffer larger than one chunk', () => {
    const buf = Buffer.alloc(FLEET_CHUNK_BYTES * 2 + 123, 7);
    const frames = chunkBuffer(buf);
    expect(frames.length).toBe(3);
    expect(frames.at(-1)!.isLast).toBe(true);
    expect(frames.slice(0, -1).every((f) => !f.isLast)).toBe(true);

    const asm = new BundleChunkAssembler();
    let result: Buffer | undefined;
    for (const f of frames) result = asm.accept(f.seq, f.dataB64, f.isLast) ?? result;
    expect(result).toBeDefined();
    expect(result!.equals(buf)).toBe(true);
  });

  it('round-trips an empty buffer as a single final frame', () => {
    const frames = chunkBuffer(Buffer.alloc(0));
    expect(frames.length).toBe(1);
    expect(frames[0].isLast).toBe(true);
    const asm = new BundleChunkAssembler();
    const out = asm.accept(frames[0].seq, frames[0].dataB64, frames[0].isLast);
    expect(out!.length).toBe(0);
  });

  it('rejects out-of-order seq', () => {
    const asm = new BundleChunkAssembler();
    asm.accept(0, Buffer.from('a').toString('base64'), false);
    expect(() => asm.accept(2, Buffer.from('b').toString('base64'), true)).toThrow(/out-of-order/);
  });
});

describe('ChunkRequestWaiter', () => {
  it('resolves with the reassembled buffer when all chunks arrive', async () => {
    const w = new ChunkRequestWaiter();
    const payload = Buffer.from('hello fleet'.repeat(100));
    const p = w.add('req-1', 1000);
    for (const f of chunkBuffer(payload)) w.onChunk('req-1', f.seq, f.dataB64, f.isLast);
    await expect(p).resolves.toEqual(payload);
  });

  it('rejects on error frame', async () => {
    const w = new ChunkRequestWaiter();
    const p = w.add('req-2', 1000);
    w.onError('req-2', 'boom');
    await expect(p).rejects.toThrow('boom');
  });

  it('rejects all pending on disconnect', async () => {
    const w = new ChunkRequestWaiter();
    const p = w.add('req-3', 1000);
    w.rejectAll('disconnected');
    await expect(p).rejects.toThrow('disconnected');
  });

  it('rejects on timeout', async () => {
    const w = new ChunkRequestWaiter();
    const p = w.add('req-4', 5);
    await expect(p).rejects.toThrow(/timed out/);
  });
});
