import { describe, it, expect } from 'vitest';
import { runsOnSelectorsForLockJob } from './dispatch-matched-workflow.js';

describe('runsOnSelectorsForLockJob', () => {
  it('splits lock runsOn matchers into exact labels + regex patterns', () => {
    const lockJob = {
      name: 'web',
      runsOn: [
        { kind: 'exact', value: 'role:web' },
        { kind: 'regex', source: '^kici:host:box-', flags: '' },
      ],
      excludeLabels: [{ kind: 'regex', source: '-canary$', flags: '' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:web'],
      runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      excludeLabels: [],
      excludePatterns: [{ kind: 'regex', source: '-canary$', flags: '' }],
    });
  });

  it('returns empty selectors for a job with no runsOn / excludeLabels', () => {
    expect(runsOnSelectorsForLockJob({} as never)).toEqual({
      runsOnLabels: [],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
    });
  });

  it('partitions exact excludeLabels into excludeLabels', () => {
    const lockJob = {
      runsOn: [{ kind: 'exact', value: 'role:db' }],
      excludeLabels: [{ kind: 'exact', value: 'role:retired' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:db'],
      runsOnPatterns: [],
      excludeLabels: ['role:retired'],
      excludePatterns: [],
    });
  });
});
