import { describe, expect, it } from 'vitest';
import { resolveLockOrigin, resolveLockRepo } from './lock-origin.js';

describe('resolveLockRepo', () => {
  it('prefers the orchestrator-provided lock repository', () => {
    expect(
      resolveLockRepo({
        repoUrl: 'https://github.com/acme/app.git',
        jobConfig: { lockRepoIdentifier: 'acme/workflows', workflowRepoIdentifier: 'acme/other' },
      }),
    ).toBe('acme/workflows');
  });

  it('falls back to a global job workflow repository', () => {
    expect(
      resolveLockRepo({
        repoUrl: 'https://github.com/acme/app.git',
        jobConfig: { workflowRepoIdentifier: 'acme/workflows' },
      }),
    ).toBe('acme/workflows');
  });

  // fails-when: the clone URL's user-info (a token) reaches the error message
  it('names the clone URL repository without its credentials', () => {
    const repo = resolveLockRepo({
      repoUrl: 'https://x-access-token:SECRET@github.com/o/r.git',
      jobConfig: {},
    });
    expect(repo).toBe('o/r');
    expect(repo).not.toContain('SECRET');
  });

  it('reads an scp-like clone URL', () => {
    expect(resolveLockRepo({ repoUrl: 'git@github.com:o/r.git' })).toBe('o/r');
  });

  it('names nothing for a local clone', () => {
    expect(resolveLockRepo({ repoUrl: 'file:///tmp/x', jobConfig: {} })).toBeUndefined();
    expect(resolveLockRepo({ repoUrl: '/srv/repos/app' })).toBeUndefined();
    expect(resolveLockRepo({})).toBeUndefined();
  });
});

describe('resolveLockOrigin', () => {
  // fails-when: the re-run lock the orchestrator sends never reaches the mismatch message
  it("carries a re-run's recorded lock", () => {
    expect(
      resolveLockOrigin({
        repoUrl: 'https://github.com/o/r.git',
        jobConfig: { lockRerun: { repo: 'o/wf', sha: 'abc1234' } },
      }),
    ).toEqual({ repo: 'o/r', rerun: { repo: 'o/wf', sha: 'abc1234' } });
  });

  it('ignores a malformed re-run lock and a first run', () => {
    expect(
      resolveLockOrigin({
        repoUrl: 'https://github.com/o/r.git',
        jobConfig: { lockRerun: { repo: 1 } },
      }),
    ).toEqual({ repo: 'o/r' });
    expect(resolveLockOrigin({ repoUrl: 'file:///x' })).toEqual({});
  });
});
