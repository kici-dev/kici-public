import { describe, expect, it } from 'vitest';
import { computeChunkId } from './chunk-id.js';

describe('computeChunkId', () => {
  const BASE = {
    db: 'platform' as const,
    table: 'run_events',
    tenantId: 'kiciStg00001',
    partitionDate: '2026-04-24',
    minRowId: 1000,
    maxRowId: 2000,
  };

  it('returns a 16-hex string', () => {
    const id = computeChunkId(BASE);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic across calls', () => {
    expect(computeChunkId(BASE)).toBe(computeChunkId(BASE));
  });

  it('changes when any field changes', () => {
    const base = computeChunkId(BASE);
    expect(computeChunkId({ ...BASE, db: 'orchestrator' })).not.toBe(base);
    expect(computeChunkId({ ...BASE, table: 'execution_runs' })).not.toBe(base);
    expect(computeChunkId({ ...BASE, tenantId: 'other' })).not.toBe(base);
    expect(computeChunkId({ ...BASE, partitionDate: '2026-04-25' })).not.toBe(base);
    expect(computeChunkId({ ...BASE, minRowId: 999 })).not.toBe(base);
    expect(computeChunkId({ ...BASE, maxRowId: 2001 })).not.toBe(base);
  });

  it('treats numeric and string row ids with equal string form identically', () => {
    expect(computeChunkId({ ...BASE, minRowId: 1000 })).toBe(
      computeChunkId({ ...BASE, minRowId: '1000' }),
    );
  });
});
