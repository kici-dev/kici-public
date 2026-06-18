import { describe, it, expect } from 'vitest';
import {
  normalizeLabelSet,
  labelSetsMatch,
  detectLabelSetOverlaps,
  findBackendForLabels,
} from './label-matcher.js';

describe('normalizeLabelSet', () => {
  it('sorts labels alphabetically', () => {
    expect(normalizeLabelSet(['docker', 'linux'])).toBe('docker,linux');
    expect(normalizeLabelSet(['linux', 'docker'])).toBe('docker,linux');
  });

  it('deduplicates labels', () => {
    expect(normalizeLabelSet(['linux', 'linux', 'docker'])).toBe('docker,linux');
  });

  it('lowercases labels', () => {
    expect(normalizeLabelSet(['Docker', 'Linux'])).toBe('docker,linux');
    expect(normalizeLabelSet(['LINUX', 'DOCKER'])).toBe('docker,linux');
  });

  it('handles combined sort, dedup, and lowercase', () => {
    expect(normalizeLabelSet(['Docker', 'linux', 'linux'])).toBe('docker,linux');
  });

  it('returns empty string for empty array', () => {
    expect(normalizeLabelSet([])).toBe('');
  });
});

describe('labelSetsMatch', () => {
  it('returns true for exact match', () => {
    expect(labelSetsMatch(['linux', 'docker'], ['linux', 'docker'])).toBe(true);
  });

  it('returns true for different order (still matches)', () => {
    expect(labelSetsMatch(['docker', 'linux'], ['linux', 'docker'])).toBe(true);
  });

  it('returns false for different sets', () => {
    expect(labelSetsMatch(['linux', 'docker'], ['linux', 'gpu'])).toBe(false);
  });

  it('returns false for subset (does NOT match)', () => {
    expect(labelSetsMatch(['linux'], ['linux', 'docker'])).toBe(false);
  });

  it('returns false for superset (does NOT match)', () => {
    expect(labelSetsMatch(['linux', 'docker', 'gpu'], ['linux', 'docker'])).toBe(false);
  });

  it('handles case-insensitive matching', () => {
    expect(labelSetsMatch(['Linux', 'Docker'], ['linux', 'docker'])).toBe(true);
  });
});

describe('detectLabelSetOverlaps', () => {
  it('returns empty array when no overlaps', () => {
    const scalers = [
      { name: 'docker-linux', labelSets: [{ labels: ['linux', 'docker'] }] },
      { name: 'bare-metal-gpu', labelSets: [{ labels: ['linux', 'gpu'] }] },
    ];

    expect(detectLabelSetOverlaps(scalers)).toEqual([]);
  });

  it('detects overlap between two scalers', () => {
    const scalers = [
      { name: 'docker-1', labelSets: [{ labels: ['linux', 'docker'] }] },
      { name: 'docker-2', labelSets: [{ labels: ['linux', 'docker'] }] },
    ];

    const overlaps = detectLabelSetOverlaps(scalers);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({
      labels: 'docker,linux',
      scaler1: 'docker-1',
      scaler2: 'docker-2',
    });
  });

  it('detects overlap with different label order', () => {
    const scalers = [
      { name: 'scaler-a', labelSets: [{ labels: ['docker', 'linux'] }] },
      { name: 'scaler-b', labelSets: [{ labels: ['linux', 'docker'] }] },
    ];

    const overlaps = detectLabelSetOverlaps(scalers);
    expect(overlaps).toHaveLength(1);
  });

  it('allows same scaler with duplicate label sets (intra-scaler)', () => {
    const scalers = [
      {
        name: 'docker-multi',
        labelSets: [{ labels: ['linux', 'docker'] }, { labels: ['linux', 'docker'] }],
      },
    ];

    // Intra-scaler duplicates are allowed
    expect(detectLabelSetOverlaps(scalers)).toEqual([]);
  });

  it('detects multiple overlapping pairs', () => {
    const scalers = [
      {
        name: 'scaler-a',
        labelSets: [{ labels: ['linux', 'docker'] }, { labels: ['linux', 'gpu'] }],
      },
      { name: 'scaler-b', labelSets: [{ labels: ['linux', 'docker'] }] },
      { name: 'scaler-c', labelSets: [{ labels: ['linux', 'gpu'] }] },
    ];

    const overlaps = detectLabelSetOverlaps(scalers);
    expect(overlaps).toHaveLength(2);
    expect(overlaps).toContainEqual({
      labels: 'docker,linux',
      scaler1: 'scaler-a',
      scaler2: 'scaler-b',
    });
    expect(overlaps).toContainEqual({
      labels: 'gpu,linux',
      scaler1: 'scaler-a',
      scaler2: 'scaler-c',
    });
  });
});

describe('findBackendForLabels', () => {
  const scalers = [
    {
      name: 'docker-linux',
      labelSets: [{ labels: ['linux', 'docker'] }, { labels: ['linux', 'node20'] }],
    },
    {
      name: 'bare-metal-gpu',
      labelSets: [{ labels: ['linux', 'gpu', 'cuda'] }],
    },
  ];

  it('returns scaler name and index for exact match', () => {
    const result = findBackendForLabels(['linux', 'docker'], scalers);
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 0 });
  });

  it('matches second label set in a scaler', () => {
    const result = findBackendForLabels(['linux', 'node20'], scalers);
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 1 });
  });

  it('matches label set in second scaler', () => {
    const result = findBackendForLabels(['linux', 'gpu', 'cuda'], scalers);
    expect(result).toEqual({ scalerName: 'bare-metal-gpu', labelSetIndex: 0 });
  });

  it('returns null when no match', () => {
    const result = findBackendForLabels(['windows', 'docker'], scalers);
    expect(result).toBeNull();
  });

  it('matches subset (job labels subset of scaler labels)', () => {
    // ['linux'] is a subset of ['linux', 'docker'] — should match
    const result = findBackendForLabels(['linux'], scalers);
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 0 });
  });

  it('handles different label order', () => {
    const result = findBackendForLabels(['docker', 'linux'], scalers);
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 0 });
  });

  it('handles case-insensitive matching', () => {
    const result = findBackendForLabels(['Linux', 'Docker'], scalers);
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 0 });
  });

  it('skips backends with excluded labels', () => {
    const result = findBackendForLabels(['linux'], scalers, ['gpu']);
    // Should match docker-linux (no gpu label) rather than bare-metal-gpu (has gpu)
    expect(result).toEqual({ scalerName: 'docker-linux', labelSetIndex: 0 });
  });

  it('returns same result with no exclusions (backward compat)', () => {
    const withEmpty = findBackendForLabels(['linux', 'docker'], scalers, []);
    const withoutParam = findBackendForLabels(['linux', 'docker'], scalers);
    expect(withEmpty).toEqual(withoutParam);
  });

  it('tries next backend when first match has excluded label', () => {
    const orderedScalers = [
      { name: 'gpu-scaler', labelSets: [{ labels: ['linux', 'gpu'] }] },
      { name: 'docker-scaler', labelSets: [{ labels: ['linux', 'docker'] }] },
    ];
    const result = findBackendForLabels(['linux'], orderedScalers, ['gpu']);
    expect(result).toEqual({ scalerName: 'docker-scaler', labelSetIndex: 0 });
  });

  it('returns null when all matching backends have excluded labels', () => {
    const gpuScalers = [
      { name: 'gpu-1', labelSets: [{ labels: ['linux', 'gpu'] }] },
      { name: 'gpu-2', labelSets: [{ labels: ['linux', 'gpu', 'cuda'] }] },
    ];
    const result = findBackendForLabels(['linux'], gpuScalers, ['gpu']);
    expect(result).toBeNull();
  });

  // ── mandatoryLabels gate (k8s-taint-style opt-in) ─────────────────────
  describe('mandatoryLabels gate', () => {
    const gatedScalers = [
      {
        name: 'gpu-pool',
        labelSets: [{ labels: ['linux', 'gpu'] }],
        mandatoryLabels: ['gpu'],
      },
      {
        name: 'generic',
        labelSets: [{ labels: ['linux', 'docker'] }],
        mandatoryLabels: [],
      },
    ];

    it('matches when runsOn includes every mandatory label', () => {
      const result = findBackendForLabels(['linux', 'gpu'], gatedScalers);
      expect(result).toEqual({ scalerName: 'gpu-pool', labelSetIndex: 0 });
    });

    it('blocks generic job from gated scaler even when subset matches its labelSet', () => {
      // ['linux'] is a subset of gpu-pool's ['linux', 'gpu'] labelSet, but
      // the mandatoryLabels gate requires `gpu` in runsOn — so gpu-pool is
      // skipped and generic wins.
      const result = findBackendForLabels(['linux'], gatedScalers);
      expect(result).toEqual({ scalerName: 'generic', labelSetIndex: 0 });
    });

    it('returns null when runsOn is missing mandatory label and no fallback scaler matches', () => {
      const onlyGated = [
        {
          name: 'gpu-only',
          labelSets: [{ labels: ['linux', 'gpu'] }],
          mandatoryLabels: ['gpu'],
        },
      ];
      // ['linux'] is a subset of the labelSet but doesn't include 'gpu'.
      const result = findBackendForLabels(['linux'], onlyGated);
      expect(result).toBeNull();
    });

    it('treats undefined mandatoryLabels the same as []', () => {
      const noGate = [{ name: 'plain', labelSets: [{ labels: ['linux'] }] }];
      const result = findBackendForLabels(['linux'], noGate);
      expect(result).toEqual({ scalerName: 'plain', labelSetIndex: 0 });
    });

    it('case-insensitive matching for mandatory labels', () => {
      const scalers = [
        {
          name: 'gpu',
          labelSets: [{ labels: ['linux', 'GPU'] }],
          mandatoryLabels: ['GPU'],
        },
      ];
      const result = findBackendForLabels(['linux', 'gpu'], scalers);
      expect(result).toEqual({ scalerName: 'gpu', labelSetIndex: 0 });
    });

    it('all mandatory labels must be present (multi-gate)', () => {
      const scalers = [
        {
          name: 'gpu+cuda',
          labelSets: [{ labels: ['linux', 'gpu', 'cuda'] }],
          mandatoryLabels: ['gpu', 'cuda'],
        },
      ];
      // Missing one of the mandatory labels → blocked.
      expect(findBackendForLabels(['linux', 'gpu'], scalers)).toBeNull();
      // All mandatory labels present → matches.
      expect(findBackendForLabels(['linux', 'gpu', 'cuda'], scalers)).toEqual({
        scalerName: 'gpu+cuda',
        labelSetIndex: 0,
      });
    });

    it('empty runsOn cannot match a gated scaler (early-return walks list)', () => {
      const scalers = [
        {
          name: 'gpu-first',
          labelSets: [{ labels: ['linux', 'gpu'] }],
          mandatoryLabels: ['gpu'],
        },
        {
          name: 'plain-second',
          labelSets: [{ labels: ['linux'] }],
          mandatoryLabels: [],
        },
      ];
      // Empty target: the gated scaler is first, but the matcher walks past
      // it because its mandatoryLabels is non-empty, and lands on the plain one.
      const result = findBackendForLabels([], scalers);
      expect(result).toEqual({ scalerName: 'plain-second', labelSetIndex: 0 });
    });

    it('empty runsOn returns null when only gated scalers exist', () => {
      const scalers = [
        {
          name: 'gpu-only',
          labelSets: [{ labels: ['linux', 'gpu'] }],
          mandatoryLabels: ['gpu'],
        },
      ];
      const result = findBackendForLabels([], scalers);
      expect(result).toBeNull();
    });

    it('smallest-labelSet tiebreaker still wins among gated scalers', () => {
      const scalers = [
        {
          name: 'gpu-broad',
          labelSets: [{ labels: ['linux', 'gpu', 'cuda', 'extra'] }],
          mandatoryLabels: ['gpu'],
        },
        {
          name: 'gpu-narrow',
          labelSets: [{ labels: ['linux', 'gpu'] }],
          mandatoryLabels: ['gpu'],
        },
      ];
      const result = findBackendForLabels(['linux', 'gpu'], scalers);
      expect(result).toEqual({ scalerName: 'gpu-narrow', labelSetIndex: 0 });
    });

    it('mandatoryLabels gate stacks with excludeLabels opt-out', () => {
      const scalers = [
        {
          name: 'gpu',
          labelSets: [{ labels: ['linux', 'gpu', 'spot'] }],
          mandatoryLabels: ['gpu'],
        },
      ];
      // runsOn satisfies the gate, but the job opts out of `spot` → no match.
      expect(findBackendForLabels(['linux', 'gpu'], scalers, ['spot'])).toBeNull();
    });
  });
});
