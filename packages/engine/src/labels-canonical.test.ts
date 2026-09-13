import { describe, it, expect } from 'vitest';
import { canonicalizeLabel, canonicalizeLabels, canonicalizeLabelSet } from './labels-canonical.js';
import type { CanonicalLabel } from './labels-canonical.js';

describe('the CanonicalLabel brand', () => {
  // Both assertions below are compile-time: `pnpm typecheck:tests` is what runs
  // them, since the package tsconfig excludes test files.
  it('stays assignable to string[], so existing consumers need no change', () => {
    const asStrings: string[] = canonicalizeLabels(['Docker']);
    expect(asStrings).toEqual(['docker']);
  });

  it('refuses a plain string where a folded label is required', () => {
    const takesCanonical = (label: CanonicalLabel): string => label;
    // The directive sits on a line of its own so an unrelated future type error
    // on a busier line cannot satisfy it and silently disable the brand check.
    // @ts-expect-error a plain string has not been folded, so the brand refuses it
    takesCanonical('docker');
    expect(takesCanonical(canonicalizeLabel('Docker'))).toBe('docker');
  });
});

describe('canonicalizeLabel', () => {
  it('lowercases', () => {
    expect(canonicalizeLabel('Docker')).toBe('docker');
    expect(canonicalizeLabel('KICI:OS:Linux')).toBe('kici:os:linux');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalizeLabel('  gpu  ')).toBe('gpu');
  });

  it('is idempotent', () => {
    expect(canonicalizeLabel(canonicalizeLabel('Docker'))).toBe('docker');
  });
});

describe('canonicalizeLabels', () => {
  it('folds every element and preserves order', () => {
    expect(canonicalizeLabels(['Linux', 'GPU'])).toEqual(['linux', 'gpu']);
  });

  it('does NOT deduplicate — the caller chooses', () => {
    expect(canonicalizeLabels(['GPU', 'gpu'])).toEqual(['gpu', 'gpu']);
  });
});

describe('canonicalizeLabelSet', () => {
  it('folds and collapses case-only duplicates', () => {
    const set = canonicalizeLabelSet(['GPU', 'gpu', 'Linux']);
    expect([...set].sort()).toEqual(['gpu', 'linux']);
  });
});
