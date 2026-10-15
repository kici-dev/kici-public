import { describe, it, expect } from 'vitest';
import * as closeCodes from './close-codes.js';

describe('WebSocket close codes', () => {
  it('assigns a unique numeric value to every WS_CLOSE_ constant', () => {
    // This module is the single source of truth: two names sharing a number
    // make that code ambiguous to every consumer.
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
