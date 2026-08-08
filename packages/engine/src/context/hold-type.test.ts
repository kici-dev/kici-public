import { describe, it, expect } from 'vitest';

import { HoldType, normalizePersistedHoldType, persistedHoldTypeSpellings } from './hold-type.js';

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

describe('normalizePersistedHoldType', () => {
  it('maps the legacy approval spelling to the reviewer gate type', () => {
    expect(normalizePersistedHoldType('approval')).toBe(HoldType.enum.reviewer);
  });

  it('maps the legacy wait_timer spelling to the timer gate type', () => {
    // A row an un-upgraded orchestrator wrote for an install-gate wait hold
    // carries `wait_timer`, while a dispatch-gate one carries `timer`. Both
    // are the same hold semantically, so both must read back as `timer`.
    expect(normalizePersistedHoldType('wait_timer')).toBe(HoldType.enum.timer);
  });

  it('passes an already-current value through unchanged', () => {
    for (const member of HoldType.options) {
      expect(normalizePersistedHoldType(member)).toBe(member);
    }
  });

  it('passes an unrecognised value through rather than defaulting it', () => {
    // The wire field is z.string() so a NEWER orchestrator's hold type survives
    // an older reader. Coercing to a default would throw that away, and the
    // dashboard's gray badge is the right rendering for an unknown type.
    expect(normalizePersistedHoldType('some_future_type')).toBe('some_future_type');
  });

  it('passes an Object.prototype key through as its own string', () => {
    // A bare index into an object literal walks the prototype chain, so these
    // keys resolve to functions rather than `undefined`. Returning one would
    // put a non-string on a `z.string()` wire field and reject the whole
    // relayed held-runs message.
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(normalizePersistedHoldType(key)).toBe(key);
    }
  });
});

describe('persistedHoldTypeSpellings', () => {
  it('lists the timer type alongside its legacy spelling', () => {
    expect(persistedHoldTypeSpellings(HoldType.enum.timer)).toEqual(['timer', 'wait_timer']);
  });

  it('lists the reviewer type alongside its legacy spelling', () => {
    expect(persistedHoldTypeSpellings(HoldType.enum.reviewer)).toEqual(['reviewer', 'approval']);
  });

  it('returns just the type itself when it never had a legacy spelling', () => {
    expect(persistedHoldTypeSpellings(HoldType.enum.concurrency)).toEqual(['concurrency']);
    expect(persistedHoldTypeSpellings(HoldType.enum.security)).toEqual(['security']);
  });

  it('always leads with the current spelling and normalizes back to it', () => {
    // A query filtering on these spellings and a reader normalizing them must
    // agree, or the sweep and the UI disagree about what a row means.
    for (const member of HoldType.options) {
      const spellings = persistedHoldTypeSpellings(member);
      expect(spellings[0]).toBe(member);
      for (const spelling of spellings) {
        expect(normalizePersistedHoldType(spelling)).toBe(member);
      }
    }
  });
});
