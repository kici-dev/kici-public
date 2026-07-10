import { describe, it, expect } from 'vitest';
import { mergeOrderedMaps, ContextGateRejectReason } from './multi-context.js';

describe('mergeOrderedMaps', () => {
  it('folds maps last-wins', () => {
    expect(
      mergeOrderedMaps([
        { A: '1', B: '1' },
        { B: '2', C: '3' },
      ]),
    ).toEqual({
      A: '1',
      B: '2',
      C: '3',
    });
  });

  it('returns empty for no maps', () => {
    expect(mergeOrderedMaps([])).toEqual({});
  });

  it('preserves a single map verbatim', () => {
    expect(mergeOrderedMaps([{ A: '1' }])).toEqual({ A: '1' });
  });
});

describe('ContextGateRejectReason', () => {
  it('enumerates the all-must-pass rejection reasons', () => {
    expect(ContextGateRejectReason.options).toEqual([
      'branch_restricted',
      'trigger_filtered',
      'repo_unmatched',
      'trust_too_low',
      'context_disabled',
      'context_not_found',
    ]);
  });
});
