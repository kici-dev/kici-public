import { describe, it, expect } from 'vitest';

import * as holdTypeModule from './hold-type.js';
import { HoldType } from './hold-type.js';

describe('HoldType', () => {
  it('has exactly the four gate hold types', () => {
    expect(HoldType.options).toEqual(['reviewer', 'timer', 'concurrency', 'security']);
  });

  it('parses every known member', () => {
    for (const member of ['reviewer', 'timer', 'concurrency', 'security']) {
      expect(HoldType.parse(member)).toBe(member);
    }
  });

  it('rejects an unknown value', () => {
    expect(HoldType.safeParse('wait_timer').success).toBe(false);
    expect(HoldType.safeParse('made_up').success).toBe(false);
  });

  it('exposes members via .enum', () => {
    expect(HoldType.enum.security).toBe('security');
  });
});

describe('retired alias readers', () => {
  it('exports no legacy hold-type mapping', () => {
    // fails-when: normalizePersistedHoldType or persistedHoldTypeSpellings is re-added.
    expect(Object.keys(holdTypeModule).sort()).toEqual(['HoldType']);
  });
});
