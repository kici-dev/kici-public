import { describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk } from './chunk-encoder.js';

interface Row {
  id: number;
  ts: string;
  payload: string;
}

async function* gen(rows: Row[]): AsyncIterable<Row> {
  for (const r of rows) yield r;
}

describe('encodeChunk / decodeChunk', () => {
  const rows: Row[] = [
    { id: 3, ts: '2026-04-24T10:00:00.000Z', payload: 'c' },
    { id: 1, ts: '2026-04-24T08:00:00.000Z', payload: 'a' },
    { id: 2, ts: '2026-04-24T09:00:00.000Z', payload: 'b' },
  ];

  it('round-trips rows through gzip + JSONL', async () => {
    const encoded = await encodeChunk<Row>({
      rows: gen(rows),
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.ts,
    });
    expect(encoded.rowCount).toBe(3);
    expect(encoded.gzipByteCount).toBeLessThan(encoded.byteCount);
    expect(encoded.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(encoded.minRowId).toBe(1);
    expect(encoded.maxRowId).toBe(3);
    expect(encoded.minTimestamp).toBe('2026-04-24T08:00:00.000Z');
    expect(encoded.maxTimestamp).toBe('2026-04-24T10:00:00.000Z');

    const decoded: Row[] = [];
    for await (const r of decodeChunk<Row>({ gzipped: encoded.data })) {
      decoded.push(r);
    }
    expect(decoded).toEqual(rows);
  });

  it('produces identical output across encodings', async () => {
    const a = await encodeChunk<Row>({
      rows: gen(rows),
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.ts,
    });
    const b = await encodeChunk<Row>({
      rows: gen(rows),
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.ts,
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('rejects an empty stream', async () => {
    await expect(
      encodeChunk<Row>({
        rows: gen([]),
        rowId: (r) => r.id,
        rowTimestamp: (r) => r.ts,
      }),
    ).rejects.toThrow(/empty row stream/);
  });

  it('respects custom encodeRow for non-JSON payloads', async () => {
    const encoded = await encodeChunk<Row>({
      rows: gen(rows.slice(0, 1)),
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.ts,
      encodeRow: (r) => `${r.id}:${r.payload}`,
    });
    const decoded: string[] = [];
    for await (const line of decodeChunk<string>({
      gzipped: encoded.data,
      decodeLine: (s) => s,
    })) {
      decoded.push(line);
    }
    expect(decoded).toEqual(['3:c']);
  });
});
