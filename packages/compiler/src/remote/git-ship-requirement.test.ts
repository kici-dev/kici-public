import { describe, expect, it } from 'vitest';
import { matchAllWorkflows, type LockJobOrFactory, type LockWorkflow } from '@kici-dev/engine';
import type { FixtureEvent } from '../fixtures/event.js';
import { GitTagMode } from './shipped-git/git-ship-types.js';
import {
  describeGitShipment,
  jobsInScope,
  requirementFromJobs,
  resolveGitShipRequirement,
  type GitShipRequirement,
} from './git-ship-requirement.js';

// Test data only: `_type: 'static'` is the lock shape the fixture must carry; the
// implementation tests it with isLockStaticJob, never the literal.
const job = (name: string, extra = {}): LockJobOrFactory =>
  ({ _type: 'static', name, steps: [], needs: [], ...extra }) as LockJobOrFactory;
const dynamicJob = (name: string, extra = {}): LockJobOrFactory =>
  ({ _type: 'dynamic', name, ...extra }) as unknown as LockJobOrFactory;

const pushTrigger = (branch: string, paths: string[] = []) => ({
  _type: 'push',
  branches: [{ type: 'glob', pattern: branch }],
  paths,
});

const workflow = (name: string, triggers: unknown[], jobs: LockJobOrFactory[]): LockWorkflow =>
  ({ name, contentHash: '', compileSchemaVersion: 0, triggers, jobs }) as unknown as LockWorkflow;

const pushMain: FixtureEvent = {
  type: 'push',
  targetBranch: 'main',
  payload: { ref: 'refs/heads/main' },
};

const names = (jobs: LockJobOrFactory[]): string[] => jobs.map((j) => (j as { name: string }).name);

describe('requirementFromJobs', () => {
  it('defaults to depth 1 and git default tags', () =>
    expect(requirementFromJobs([job('a')])).toEqual({
      depth: 1,
      tags: GitTagMode.Default,
      reasons: [],
    }));

  it('takes the deepest depth, 0 beating any number', () =>
    expect(
      requirementFromJobs([
        job('a', { checkoutOptions: { fetchDepth: 50 } }),
        job('release', { checkoutOptions: { fetchDepth: 0 } }),
        job('later', { checkoutOptions: { fetchDepth: 500 } }),
      ]),
    ).toEqual({
      depth: 0,
      tags: GitTagMode.Default,
      reasons: ['job "release" asks for fetchDepth 0'],
    }));

  it('names the first job that sets the deepest depth', () =>
    expect(
      requirementFromJobs([
        job('a', { checkoutOptions: { fetchDepth: 20 } }),
        job('b', { checkoutOptions: { fetchDepth: 20 } }),
      ]).reasons,
    ).toEqual(['job "a" asks for fetchDepth 20']));

  it('ORs tags', () =>
    expect(
      requirementFromJobs([
        job('a', { checkoutOptions: { fetchTags: false } }),
        job('b', { checkoutOptions: { fetchTags: true } }),
        job('c', { checkoutOptions: { fetchTags: true } }),
      ]),
    ).toEqual({ depth: 1, tags: GitTagMode.All, reasons: ['job "b" asks for tags'] }));

  it('lists the depth reason before the tags reason', () =>
    expect(
      requirementFromJobs([
        job('b', { checkoutOptions: { fetchTags: true } }),
        job('a', { checkoutOptions: { fetchDepth: 20 } }),
      ]),
    ).toEqual({
      depth: 20,
      tags: GitTagMode.All,
      reasons: ['job "a" asks for fetchDepth 20', 'job "b" asks for tags'],
    }));

  it('ignores checkout: false jobs and dynamic entries', () =>
    // fails-when: a job that never clones, or a generator entry, raises the requirement
    expect(
      requirementFromJobs([
        job('noclone', { checkout: false, checkoutOptions: { fetchDepth: 0, fetchTags: true } }),
        dynamicJob('gen', { checkoutOptions: { fetchDepth: 0, fetchTags: true } }),
        job('a'),
      ]),
    ).toEqual({ depth: 1, tags: GitTagMode.Default, reasons: [] }));
});

describe('jobsInScope', () => {
  const lock = {
    workflows: [
      workflow('w1', [pushTrigger('main')], [job('w1a'), job('w1b')]),
      workflow('w2', [pushTrigger('release/*')], [job('w2a')]),
      workflow('w3', [pushTrigger('main', ['docs/**'])], [job('w3a')]),
    ],
  };

  it('scopes to --workflow', () =>
    expect(names(jobsInScope(lock, { workflowName: 'w2' }))).toEqual(['w2a']));

  it('scopes to the fixture workflowName even when an event is also given', () =>
    // fails-when: the event match wins over the named workflow (pushMain also matches w1)
    expect(names(jobsInScope(lock, { workflowName: 'w2', event: pushMain }))).toEqual(['w2a']));

  it('scopes to the workflows the event matches', () =>
    // A paths filter matches conservatively: the CLI does not know the changed files.
    expect(names(jobsInScope(lock, { event: pushMain }))).toEqual(['w1a', 'w1b', 'w3a']));

  it('falls back to every job when the event matches no workflow', () => {
    // A `repos` filter needs the event's source repository, which the CLI
    // event does not carry, so the CLI never matches this trigger.
    const unmatchable = {
      workflows: [
        workflow(
          'w1',
          [{ ...pushTrigger('main'), repos: [{ type: 'glob', pattern: 'acme/*' }] }],
          [job('release', { checkoutOptions: { fetchDepth: 0 } })],
        ),
        workflow('w2', [pushTrigger('release/*')], [job('w2a')]),
      ],
    };
    // Positive control: the event really matches neither workflow.
    expect(matchAllWorkflows(unmatchable.workflows, { ...pushMain }).map((d) => d.matched)).toEqual(
      [false, false],
    );
    // fails-when: the empty match is returned and the run ships depth 1
    expect(names(jobsInScope(unmatchable, { event: pushMain }))).toEqual(['release', 'w2a']);
    expect(requirementFromJobs(jobsInScope(unmatchable, { event: pushMain })).depth).toBe(0);
    // breaks-if-wrong: an event that matches one workflow still scopes to its jobs
    expect(
      names(jobsInScope(unmatchable, { event: { ...pushMain, targetBranch: 'release/1' } })),
    ).toEqual(['w2a']);
  });

  it('takes every job with neither a workflow nor an event', () =>
    expect(names(jobsInScope(lock, {}))).toEqual(['w1a', 'w1b', 'w2a', 'w3a']));

  it('falls back to every job when matching throws', () => {
    // A catastrophic regex makes the branch matcher throw.
    const throwing = {
      workflows: [
        workflow(
          'w1',
          [{ _type: 'push', branches: [{ type: 'regex', pattern: '(a+)+$' }], paths: [] }],
          [job('w1a')],
        ),
        workflow('w2', [pushTrigger('release/*')], [job('w2a')]),
      ],
    };
    // Positive control: the matcher really throws on this lock.
    expect(() => matchAllWorkflows(throwing.workflows, { ...pushMain })).toThrow();
    expect(names(jobsInScope(throwing, { event: pushMain }))).toEqual(['w1a', 'w2a']);
  });
});

describe('resolveGitShipRequirement', () => {
  const lockAskingDepth0 = JSON.stringify({
    workflows: [
      workflow(
        'w1',
        [pushTrigger('main')],
        [job('release', { checkoutOptions: { fetchDepth: 0, fetchTags: true } })],
      ),
      workflow('w2', [pushTrigger('main')], [job('plain')]),
    ],
  });

  it('derives the requirement from the lock', () =>
    expect(resolveGitShipRequirement({ inlineLockFile: lockAskingDepth0, flags: {} })).toEqual({
      depth: 0,
      tags: GitTagMode.All,
      reasons: ['job "release" asks for fetchDepth 0', 'job "release" asks for tags'],
    }));

  it('flags override their dimension entirely', () => {
    // The lock asks fetchDepth 0; --git-depth 2 wins (no max with the lock).
    expect(
      resolveGitShipRequirement({
        inlineLockFile: lockAskingDepth0,
        flags: { gitDepth: 2, gitTags: false },
      }),
    ).toEqual({ depth: 2, tags: GitTagMode.None, reasons: ['--git-depth 2', '--no-git-tags'] });
  });

  it('keeps the lock dimension a flag does not set', () =>
    expect(
      resolveGitShipRequirement({ inlineLockFile: lockAskingDepth0, flags: { gitDepth: 2 } }),
    ).toEqual({
      depth: 2,
      tags: GitTagMode.All,
      reasons: ['--git-depth 2', 'job "release" asks for tags'],
    }));

  it('maps --git-tags to every tag', () =>
    expect(
      resolveGitShipRequirement({ inlineLockFile: '{"workflows":[]}', flags: { gitTags: true } }),
    ).toEqual({ depth: 1, tags: GitTagMode.All, reasons: ['--git-tags'] }));

  it('scopes to the named workflow', () =>
    expect(
      resolveGitShipRequirement({
        inlineLockFile: lockAskingDepth0,
        workflowName: 'w2',
        event: pushMain,
        flags: {},
      }),
    ).toEqual({ depth: 1, tags: GitTagMode.Default, reasons: [] }));

  it('takes the default for an unparsable lock, flags still applying', () => {
    expect(resolveGitShipRequirement({ inlineLockFile: '{not json', flags: {} })).toEqual({
      depth: 1,
      tags: GitTagMode.Default,
      reasons: [],
    });
    expect(
      resolveGitShipRequirement({ inlineLockFile: '{not json', flags: { gitDepth: 0 } }),
    ).toEqual({ depth: 0, tags: GitTagMode.Default, reasons: ['--git-depth 0'] });
  });
});

describe('describeGitShipment', () => {
  it.each<[GitShipRequirement, string]>([
    [{ depth: 1, tags: GitTagMode.Default, reasons: [] }, 'Git: depth 1, default tags (default)'],
    [
      { depth: 0, tags: GitTagMode.Default, reasons: ['job "release" asks for fetchDepth 0'] },
      'Git: full history + tags (job "release" asks for fetchDepth 0)',
    ],
    [
      { depth: 0, tags: GitTagMode.All, reasons: ['--git-depth 0', '--git-tags'] },
      'Git: full history + tags (--git-depth 0; --git-tags)',
    ],
    [
      { depth: 0, tags: GitTagMode.None, reasons: ['--no-git-tags'] },
      'Git: full history, no tags (--no-git-tags)',
    ],
    [
      {
        depth: 20,
        tags: GitTagMode.All,
        reasons: ['job "a" asks for fetchDepth 20', 'job "b" asks for tags'],
      },
      'Git: depth 20, all tags (job "a" asks for fetchDepth 20; job "b" asks for tags)',
    ],
    [
      { depth: 3, tags: GitTagMode.None, reasons: ['--git-depth 3', '--no-git-tags'] },
      'Git: depth 3, no tags (--git-depth 3; --no-git-tags)',
    ],
  ])('describes %j', (req, line) => expect(describeGitShipment(req)).toBe(line));
});
