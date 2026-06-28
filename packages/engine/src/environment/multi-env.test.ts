import { describe, it, expect } from 'vitest';
import { mergeOrderedMaps, EnvGateRejectReason } from './multi-env.js';

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

describe('EnvGateRejectReason', () => {
  it('enumerates the all-must-pass rejection reasons', () => {
    expect(EnvGateRejectReason.options).toEqual([
      'branch_restricted',
      'trigger_filtered',
      'repo_unmatched',
      'trust_too_low',
      'env_disabled',
      'env_not_found',
    ]);
  });
});
