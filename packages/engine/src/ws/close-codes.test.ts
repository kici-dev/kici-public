import { describe, it, expect } from 'vitest';
import * as closeCodes from './close-codes.js';

describe('WebSocket close codes', () => {
  it('assigns a unique numeric value to every WS_CLOSE_ constant', () => {
    // Guards against re-introducing a collision like the historical 4030 clash
    // between the rebalance close and a dead "run not found" constant: the
    // engine module is the single source of truth, so two names sharing a
    // number means a consumer interpreting that number is ambiguous.
    const entries = Object.entries(closeCodes).filter(([name]) => name.startsWith('WS_CLOSE_'));
    const byValue = new Map<number, string[]>();
    for (const [name, value] of entries) {
      const names = byValue.get(value as number) ?? [];
      names.push(name);
      byValue.set(value as number, names);
    }
    const collisions = [...byValue.entries()].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it('exposes WS_CLOSE_REBALANCE at 4030 (the value the Platform actually emits)', () => {
    expect(closeCodes.WS_CLOSE_REBALANCE).toBe(4030);
  });
});
