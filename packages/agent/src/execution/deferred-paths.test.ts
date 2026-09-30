import { describe, it, expect } from 'vitest';
import { describePathsVerdict, evaluateDeferredPaths } from './deferred-paths.js';

describe('evaluateDeferredPaths', () => {
  it('true when any deferred list matches the diff', () => {
    expect(
      evaluateDeferredPaths([['docs/**'], ['src/**']], { files: ['src/a.ts'], status: 'fetched' }),
    ).toBe(true);
  });
  // fails-when: the agent treats a no-match as a match
  it('false when no list matches', () => {
    expect(evaluateDeferredPaths([['src/**']], { files: ['docs/a.md'], status: 'fetched' })).toBe(
      false,
    );
  });
  it('an empty fetched diff matches nothing', () => {
    expect(evaluateDeferredPaths([['src/**']], { files: [], status: 'fetched' })).toBe(false);
  });
  it('honours exclusions', () => {
    expect(
      evaluateDeferredPaths([['src/**', '!src/gen/**']], {
        files: ['src/gen/a.ts'],
        status: 'fetched',
      }),
    ).toBe(false);
  });
  // breaks-if-wrong: an agent that cannot diff must still run the workflow
  it('an unavailable diff runs conservatively', () => {
    expect(evaluateDeferredPaths([['src/**']], { files: [], status: 'unavailable' })).toBe(true);
  });
});

describe('describePathsVerdict', () => {
  it('names the lists and the changed-file count', () => {
    expect(describePathsVerdict([['src/**'], ['docs/**']], { files: ['a', 'b', 'c'] })).toBe(
      'paths: no match for [src/**] or [docs/**] against 3 changed file(s) — workflow does not run',
    );
  });
});
