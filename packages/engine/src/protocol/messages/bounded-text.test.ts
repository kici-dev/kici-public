import { describe, expect, it } from 'vitest';
import {
  KEEP_END_TRUNCATION_MARKER,
  TRUNCATION_MARKER,
  boundedFreeText,
  truncateReasonText,
  truncateReasonTextKeepEnd,
} from './bounded-text.js';

/** Deterministic pseudo-random source (mulberry32), so a failing sample reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text over an alphabet with a carriage return, a newline and an astral character (a surrogate pair). */
const ALPHABET = ['a', 'Z', ' ', '\r', '\n', 'é', '\u{1D362}'];
function randomText(next: () => number, maxLen: number): string {
  const units = Math.floor(next() * maxLen);
  let out = '';
  while (out.length < units) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

describe('truncateReasonText', () => {
  it('caps an oversize string and says it was cut', () => {
    const out = truncateReasonText('x'.repeat(500), 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('leaves a string within the cap byte-identical', () => {
    const text = 'the filter threw: boom';
    expect(truncateReasonText(text, 4_000)).toBe(text);
  });

  it('never returns more than max, even below the marker length', () => {
    // A max under the marker's own length made the naive form return a string
    // LONGER than max — the one thing the cap exists to prevent.
    for (const max of [1, 5, 13, 14]) {
      expect(truncateReasonText('x'.repeat(200), max).length).toBeLessThanOrEqual(max);
    }
  });

  it('returns empty for a non-positive max', () => {
    expect(truncateReasonText('anything', 0)).toBe('');
  });

  it('holds its properties for random text', () => {
    const next = seeded(406);
    let cut = 0;
    for (let sample = 0; sample < 500; sample++) {
      const text = randomText(next, 5_000);
      const max = 1 + Math.floor(next() * 3_000);
      const out = truncateReasonText(text, max);
      // fails-when: the clamp returns more than max code units
      expect(out.length).toBeLessThanOrEqual(max);
      // fails-when: a cut splits a surrogate pair and leaves a lone half
      expect(out.isWellFormed()).toBe(true);
      if (text.length <= max) {
        // breaks-if-wrong: text within the bound is passed through unchanged, with no marker
        expect(out).toBe(text);
        continue;
      }
      cut++;
      if (max > TRUNCATION_MARKER.length) {
        expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(text.startsWith(out.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
      }
    }
    // Positive control: the samples really exercised the cut branch.
    expect(cut).toBeGreaterThan(100);
  });
});

describe('truncateReasonTextKeepEnd', () => {
  it('keeps the end of an oversize string and marks the cut at the start', () => {
    const out = truncateReasonTextKeepEnd(`${'x'.repeat(500)}LAST`, 100);
    expect(out).toHaveLength(100);
    expect(out.startsWith(KEEP_END_TRUNCATION_MARKER)).toBe(true);
    expect(out.endsWith('LAST')).toBe(true);
  });

  it('holds its properties for random text', () => {
    const next = seeded(4060);
    let cut = 0;
    for (let sample = 0; sample < 500; sample++) {
      const text = randomText(next, 5_000);
      const max = 1 + Math.floor(next() * 3_000);
      const out = truncateReasonTextKeepEnd(text, max);
      // fails-when: the clamp returns more than max code units
      expect(out.length).toBeLessThanOrEqual(max);
      // fails-when: a cut at the start splits a surrogate pair and leaves a lone low half
      expect(out.isWellFormed()).toBe(true);
      if (text.length <= max) {
        expect(out).toBe(text);
        continue;
      }
      cut++;
      if (max > KEEP_END_TRUNCATION_MARKER.length) {
        expect(out.startsWith(KEEP_END_TRUNCATION_MARKER)).toBe(true);
        expect(text.endsWith(out.slice(KEEP_END_TRUNCATION_MARKER.length))).toBe(true);
      }
    }
    expect(cut).toBeGreaterThan(100);
  });
});

describe('boundedFreeText', () => {
  it('clamps a 10,400-character carriage-return progress dump instead of refusing it', () => {
    const fixture = '\rDownloading 42%'.repeat(650);
    expect(fixture).toHaveLength(10_400);
    const parsed = boundedFreeText(2_000).safeParse(fixture);
    // fails-when: the field refuses an over-long value (a .max() bound) instead of clamping
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveLength(2_000);
    expect(parsed.data!.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('still refuses a value that is not a string', () => {
    // breaks-if-wrong: the clamp must not widen the field's type
    expect(boundedFreeText(2_000).safeParse(42).success).toBe(false);
  });
});
