import { describe, it, expect } from 'vitest';
import { assertLockFileRegexesSafe } from './lockfile-redos-guard.js';

const lockWith = (runsOn: unknown) =>
  ({
    schemaVersion: 20,
    workflows: [{ name: 'w', jobs: [{ _type: 'static', name: 'j', runsOn }] }],
  }) as never;

describe('assertLockFileRegexesSafe', () => {
  it('passes a benign regex matcher', () => {
    expect(() =>
      assertLockFileRegexesSafe(lockWith([{ kind: 'regex', source: '^box-', flags: '' }])),
    ).not.toThrow();
  });

  it('throws on a smuggled ReDoS regex matcher', () => {
    expect(() =>
      assertLockFileRegexesSafe(lockWith([{ kind: 'regex', source: '(a+)+$', flags: '' }])),
    ).toThrow(/ReDoS-prone/);
  });

  it('ignores exact matchers and pattern-free jobs', () => {
    expect(() =>
      assertLockFileRegexesSafe(lockWith([{ kind: 'exact', value: 'role:web' }])),
    ).not.toThrow();
    expect(() => assertLockFileRegexesSafe(lockWith(undefined))).not.toThrow();
  });

  it('validates excludeLabels and runsOnAll matchers', () => {
    const lock = {
      schemaVersion: 20,
      workflows: [
        {
          name: 'w',
          jobs: [
            {
              _type: 'static',
              name: 'j',
              excludeLabels: [{ kind: 'regex', source: '(a+)+$', flags: '' }],
            },
          ],
        },
      ],
    } as never;
    expect(() => assertLockFileRegexesSafe(lock)).toThrow(/excludeLabels/);

    const lockAll = {
      schemaVersion: 20,
      workflows: [
        {
          name: 'w',
          jobs: [
            {
              _type: 'static',
              name: 'j',
              runsOnAll: {
                include: [[{ kind: 'regex', source: '(a+)+$', flags: '' }]],
                exclude: [],
              },
            },
          ],
        },
      ],
    } as never;
    expect(() => assertLockFileRegexesSafe(lockAll)).toThrow(/runsOnAll/);
  });

  it('skips dynamic job generators', () => {
    const lock = {
      schemaVersion: 20,
      workflows: [{ name: 'w', jobs: [{ _type: 'dynamic', fn: () => [] }] }],
    } as never;
    expect(() => assertLockFileRegexesSafe(lock)).not.toThrow();
  });
});
