import { describe, it, expect } from 'vitest';
import {
  matchBranchPattern,
  matchPathPatterns,
  matchRepoPatterns,
  matchWorkflowTriggers,
  matchAllWorkflows,
  matchTrigger,
} from './matcher.js';
import type { TraceEntry } from './decision-trace.js';
import { TRACE_TEXT_MAX } from './decision-trace.js';
import type {
  ChangedFilesStatus,
  LockBranchPattern,
  LockWorkflow,
  LockPrTrigger,
  LockPushTrigger,
  LockTagTrigger,
  LockCommentTrigger,
  LockGenericWebhookTrigger,
  LockJobCompleteTrigger,
  LockKiciEventTrigger,
  LockTextMatch,
  LockTrigger,
  LockWorkflowCompleteTrigger,
  LockWorkflowRunTrigger,
  LockWorkflowsFailedBatchTrigger,
  SimulatedEvent,
} from './types.js';

function wf(...triggers: LockTrigger[]): LockWorkflow {
  return { name: 'test', contentHash: '', compileSchemaVersion: 0, triggers, jobs: [] };
}

function ev(type: string, fields: Partial<SimulatedEvent> = {}): SimulatedEvent {
  return { type, payload: {}, targetBranch: '', ...fields };
}

const prEv = (fields: Partial<SimulatedEvent> = {}): SimulatedEvent =>
  ev('pull_request', { targetBranch: 'main', ...fields });
const pushEv = (fields: Partial<SimulatedEvent> = {}): SimulatedEvent =>
  ev('push', { targetBranch: 'main', ...fields });
const PUSH_MAIN = pushEv();

const pr = (fields: Partial<LockPrTrigger> = {}): LockPrTrigger => ({
  _type: 'pr',
  events: [],
  targetBranches: [],
  sourceBranches: [],
  paths: [],
  ...fields,
});
const push = (fields: Partial<LockPushTrigger> = {}): LockPushTrigger => ({
  _type: 'push',
  branches: [],
  paths: [],
  ...fields,
});
const glob = (pattern: string): LockBranchPattern => ({ type: 'glob', pattern });

/** One row per expectation: a label naming the input, the trigger, the event, the verdict. */
type MatchRow = [label: string, trigger: LockTrigger, event: SimulatedEvent, expected: boolean];

function itMatches(rows: MatchRow[]): void {
  const cases = rows.map(([label, trigger, event, expected]) => ({
    label,
    trigger,
    event,
    expected,
  }));
  it.each(cases)('$label → $expected', ({ trigger, event, expected }) => {
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(expected);
  });
}

describe('matchBranchPattern', () => {
  it.each<[LockBranchPattern, string, boolean]>([
    [glob('main'), 'main', true],
    [glob('main'), 'develop', false],
    [glob('feature/*'), 'feature/login', true],
    [glob('feature/*'), 'feature/signup', true],
    [glob('feature/*'), 'bugfix/login', false],
    [glob('release/**'), 'release/v1.0', true],
    [glob('release/**'), 'release/v1.0/hotfix', true],
    [glob('release/**'), 'main', false],
    [{ type: 'regex', pattern: '^release-\\d+\\.\\d+$' }, 'release-1.0', true],
    [{ type: 'regex', pattern: '^release-\\d+\\.\\d+$' }, 'release-2.5', true],
    [{ type: 'regex', pattern: '^release-\\d+\\.\\d+$' }, 'release-abc', false],
    [{ type: 'regex', pattern: '^FEATURE', flags: 'i' }, 'FEATURE-123', true],
    [{ type: 'regex', pattern: '^FEATURE', flags: 'i' }, 'feature-123', true],
    [{ type: 'regex', pattern: '^FEATURE', flags: 'i' }, 'bugfix-123', false],
    [{ type: 'regex', pattern: '^release-\\d+$' }, 'release-42', true],
    [{ type: 'regex', pattern: '^release-\\d+$' }, 'release-', false],
    [{ type: 'regex', pattern: '^release-\\d+$' }, 'release-abc', false],
  ])('%j against %s → %s', (pattern, branch, expected) => {
    expect(matchBranchPattern(pattern, branch)).toBe(expected);
  });

  it('rejects a catastrophic branch-pattern regex (#1)', () => {
    const pattern: LockBranchPattern = { type: 'regex', pattern: '(a+)+$' };
    expect(() => matchBranchPattern(pattern, 'x')).toThrow(/unsafe|redos|regex/i);
  });
});

describe('matchPathPatterns', () => {
  it.each<[label: string, patterns: string[], files: string[], expected: boolean]>([
    ['no filters', [], ['src/app.ts'], true],
    ['include pattern hit', ['src/**/*.ts'], ['src/app.ts'], true],
    ['include pattern miss', ['src/**/*.ts'], ['tests/app.test.ts'], false],
    ['!-prefixed pattern excludes', ['!**/*.md'], ['README.md'], false],
    ['!-prefixed pattern lets others through', ['!**/*.md'], ['src/app.ts'], true],
    ['include + exclude: included file', ['src/**', '!**/*.test.ts'], ['src/app.ts'], true],
    ['include + exclude: excluded file', ['src/**', '!**/*.test.ts'], ['src/app.test.ts'], false],
    [
      'include + exclude: file outside include',
      ['src/**', '!**/*.test.ts'],
      ['docs/README.md'],
      false,
    ],
    ['exclude beats include: kept file', ['src/**', '!src/temp/**'], ['src/app.ts'], true],
    [
      'exclude beats include: excluded file',
      ['src/**', '!src/temp/**'],
      ['src/temp/cache.ts'],
      false,
    ],
    // README.md is filtered out by the exclusion; it does not veto the trigger.
    [
      'excluded file present beside an included one',
      ['src/**', '!**/*.md'],
      ['src/app.ts', 'README.md'],
      true,
    ],
    // src/app.md matches the include, but after filtering no file remains.
    [
      'every file excluded though it matches an include',
      ['src/**', '!**/*.md'],
      ['src/app.md'],
      false,
    ],
    [
      'mix of included and excluded files, several exclusions',
      ['src/**', '!**/*.test.ts', '!**/*.md'],
      ['src/utils.ts', 'tests/foo.test.ts', 'docs/README.md'],
      true,
    ],
    [
      'only excluded files match the include',
      ['src/**', '!**/*.test.ts'],
      ['src/app.test.ts', 'docs/README.md'],
      false,
    ],
    ['no changed files with a paths filter', ['src/**'], [], false],
    ['no changed files and no paths filter', [], [], true],
    [
      'all-negation array with a non-excluded file (implicit match-all)',
      ['!src/generated/**'],
      ['src/generated/foo.ts', 'src/main.ts'],
      true,
    ],
    [
      'all-negation array with every file excluded',
      ['!src/generated/**'],
      ['src/generated/foo.ts'],
      false,
    ],
  ])('%s: %j over %j → %s', (_label, patterns, files, expected) => {
    expect(matchPathPatterns(patterns, files)).toBe(expected);
  });
});

describe('matchPathPatterns with changedFilesStatus', () => {
  it.each<
    [
      label: string,
      patterns: string[],
      files: string[],
      status: ChangedFilesStatus | undefined,
      expected: boolean,
    ]
  >([
    ['unavailable + path filters → conservative match', ['src/**'], [], 'unavailable', true],
    ['unavailable + no path filters', [], [], 'unavailable', true],
    ['fetched + empty: a genuine empty diff stays no-match', ['src/**'], [], 'fetched', false],
    // The matcher does not special-case skipped; the pipeline gates the fetch.
    ['skipped + empty', ['src/**'], [], 'skipped', false],
    ['undefined status (empty → false)', ['src/**'], [], undefined, false],
    // Conservative match ignores the file list entirely.
    ['unavailable with an all-exclusion filter', ['!docs/**'], [], 'unavailable', true],
    ['fetched + populated list: included file', ['src/**'], ['src/app.ts'], 'fetched', true],
    ['fetched + populated list: other file', ['src/**'], ['docs/x.md'], 'fetched', false],
  ])('%s', (_label, patterns, files, status, expected) => {
    expect(matchPathPatterns(patterns, files, status)).toBe(expected);
  });
});

describe('matchWorkflowTriggers - PR triggers', () => {
  const openedOrSync = pr({ events: ['opened', 'synchronize'] });

  it('matches PR event type', () => {
    const decision = matchWorkflowTriggers(wf(openedOrSync), prEv({ action: 'opened' }));
    expect(decision.matched).toBe(true);
    expect(decision.matchedTrigger).toBe(0);
  });

  it('rejects non-PR events for PR trigger', () => {
    const decision = matchWorkflowTriggers(wf(pr()), PUSH_MAIN);
    expect(decision.matched).toBe(false);
    expect(decision.checks.some((c) => c.check === 'event type' && !c.passed)).toBe(true);
  });

  itMatches([
    ['action filter admits opened', openedOrSync, prEv({ action: 'opened' }), true],
    ['action filter rejects closed', openedOrSync, prEv({ action: 'closed' }), false],
    ['action filter rejects an event without an action', openedOrSync, prEv(), false],
    ['target branch main', pr({ targetBranches: [glob('main')] }), prEv(), true],
    [
      'target branch develop',
      pr({ targetBranches: [glob('main')] }),
      prEv({ targetBranch: 'develop' }),
      false,
    ],
    [
      'source branch feature/login',
      pr({ sourceBranches: [glob('feature/*')] }),
      prEv({ sourceBranch: 'feature/login' }),
      true,
    ],
    [
      'source branch bugfix/crash',
      pr({ sourceBranches: [glob('feature/*')] }),
      prEv({ sourceBranch: 'bugfix/crash' }),
      false,
    ],
    [
      'path filter: src files',
      pr({ paths: ['src/**', '!**/*.md'] }),
      prEv({ changedFiles: ['src/app.ts', 'src/utils.ts'] }),
      true,
    ],
    [
      'path filter: docs files',
      pr({ paths: ['src/**', '!**/*.md'] }),
      prEv({ changedFiles: ['README.md', 'docs/guide.md'] }),
      false,
    ],
    // Matches src/** but is excluded by *.md.
    [
      'path filter: src markdown',
      pr({ paths: ['src/**', '!**/*.md'] }),
      prEv({ changedFiles: ['src/README.md'] }),
      false,
    ],
  ]);

  it('rejects PR with source branch filter when sourceBranch is missing (regression M-3)', () => {
    const decision = matchWorkflowTriggers(wf(pr({ sourceBranches: [glob('feature/*')] })), prEv());
    expect(decision.matched).toBe(false);
    const sourceBranchCheck = decision.checks.find((c) => c.check === 'source branch');
    expect(sourceBranchCheck).toBeDefined();
    expect(sourceBranchCheck?.passed).toBe(false);
    expect(sourceBranchCheck?.value).toBe('(missing)');
  });

  it('PR trigger with paths matches when changedFilesStatus is unavailable (conservative match)', () => {
    const decision = matchWorkflowTriggers(
      wf(pr({ paths: ['src/**'] })),
      prEv({ changedFiles: [], changedFilesStatus: 'unavailable' }),
    );
    expect(decision.matched).toBe(true);
    const pathsTrace = decision.checks.find((t) => t.check === 'paths');
    expect(pathsTrace?.value).toContain('unavailable');
    expect(pathsTrace?.passed).toBe(true);
  });

  it('bounds the paths trace for a pathological changed-file list', () => {
    // A provider paginates a large pull request to thousands of files, which
    // must not land verbatim in the trace's `value`.
    const event = prEv({
      changedFiles: Array.from({ length: 3_000 }, (_, i) => `docs/very/long/path/file-${i}.md`),
    });

    const pathsTrace = matchWorkflowTriggers(wf(pr({ paths: ['src/**'] })), event).checks.find(
      (t) => t.check === 'paths',
    );
    // Positive control: the bound below is read off a real entry, not an absent one.
    expect(pathsTrace?.passed).toBe(false);
    expect(pathsTrace!.value.length).toBeLessThanOrEqual(TRACE_TEXT_MAX + 1);
  });
});

describe('matchWorkflowTriggers - Push triggers', () => {
  it('matches push event type', () => {
    const decision = matchWorkflowTriggers(wf(push()), PUSH_MAIN);
    expect(decision.matched).toBe(true);
    expect(decision.matchedTrigger).toBe(0);
  });

  const branches = push({ branches: [glob('main'), glob('release-*')] });
  itMatches([
    ['rejects a pull_request event', push(), prEv(), false],
    ['branch main', branches, PUSH_MAIN, true],
    ['branch release-1.0', branches, pushEv({ targetBranch: 'release-1.0' }), true],
    ['branch feature/test', branches, pushEv({ targetBranch: 'feature/test' }), false],
    [
      'path filter: .ts file',
      push({ paths: ['src/**/*.ts'] }),
      pushEv({ changedFiles: ['src/app.ts'] }),
      true,
    ],
    [
      'path filter: .js file',
      push({ paths: ['src/**/*.ts'] }),
      pushEv({ changedFiles: ['src/app.js'] }),
      false,
    ],
  ]);
});

describe('matchWorkflowTriggers - Multiple triggers', () => {
  it('matches first trigger that passes (short-circuit)', () => {
    const workflow = wf(pr(), push());

    const prDecision = matchWorkflowTriggers(workflow, prEv());
    expect(prDecision.matched).toBe(true);
    expect(prDecision.matchedTrigger).toBe(0);

    const pushDecision = matchWorkflowTriggers(workflow, PUSH_MAIN);
    expect(pushDecision.matched).toBe(true);
    expect(pushDecision.matchedTrigger).toBe(1);
  });

  it('returns no match if no triggers match', () => {
    const decision = matchWorkflowTriggers(wf(pr({ targetBranches: [glob('develop')] })), prEv());
    expect(decision.matched).toBe(false);
    expect(decision.matchedTrigger).toBeUndefined();
    expect(decision.summary).toBe('No triggers matched');
  });

  it('returns no match for workflow with no triggers', () => {
    const decision = matchWorkflowTriggers(wf(), PUSH_MAIN);
    expect(decision.matched).toBe(false);
    expect(decision.summary).toBe('No triggers defined');
  });
});

describe('matchWorkflowTriggers - Decision traces', () => {
  it('records all checks in trace', () => {
    const workflow = wf(
      pr({
        events: ['opened'],
        targetBranches: [glob('main')],
        sourceBranches: [glob('feature/*')],
        paths: ['src/**', '!**/*.md'],
      }),
    );
    const event = prEv({
      action: 'opened',
      sourceBranch: 'feature/test',
      changedFiles: ['src/app.ts'],
    });

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(true);
    expect(decision.checks.length).toBeGreaterThan(0);

    const checkTypes = decision.checks.map((c) => c.check);
    expect(checkTypes).toContain('event type');
    expect(checkTypes).toContain('action');
    expect(checkTypes).toContain('target branch');
    expect(checkTypes).toContain('source branch');
    expect(checkTypes).toContain('paths');
  });

  it('records failed checks', () => {
    const decision = matchWorkflowTriggers(
      wf(push({ branches: [glob('main')] })),
      pushEv({ targetBranch: 'develop' }),
    );
    expect(decision.matched).toBe(false);

    const branchCheck = decision.checks.find((c) => c.check === 'branch');
    expect(branchCheck).toBeDefined();
    expect(branchCheck?.passed).toBe(false);
    expect(branchCheck?.value).toBe('develop');
  });

  it('includes correct matchedTrigger index', () => {
    const decision = matchWorkflowTriggers(wf(pr(), push()), PUSH_MAIN);
    expect(decision.matched).toBe(true);
    // PR trigger is index 0, push trigger is index 1
    expect(decision.matchedTrigger).toBe(1);
  });
});

describe('matchAllWorkflows', () => {
  it('matches multiple workflows against event', () => {
    const workflows: LockWorkflow[] = [
      { ...wf(pr()), name: 'ci' },
      { ...wf(push({ branches: [glob('main')] })), name: 'deploy' },
    ];

    const decisions = matchAllWorkflows(workflows, prEv());
    expect(decisions.length).toBe(2);
    expect(decisions[0].workflowName).toBe('ci');
    expect(decisions[0].matched).toBe(true);
    expect(decisions[1].workflowName).toBe('deploy');
    expect(decisions[1].matched).toBe(false);
  });

  it('returns empty array for no workflows', () => {
    expect(matchAllWorkflows([], PUSH_MAIN)).toEqual([]);
  });
});

describe('matchWorkflowTriggers - Tag triggers', () => {
  const vStar: LockTagTrigger = { _type: 'tag', patterns: [glob('v*')] };
  const anyTag: LockTagTrigger = { _type: 'tag', patterns: [] };
  itMatches([
    ['v* pattern against v1.0.0', vStar, ev('tag', { targetBranch: 'v1.0.0' }), true],
    ['rejects a push event', anyTag, PUSH_MAIN, false],
    ['empty patterns match any tag', anyTag, ev('tag', { targetBranch: 'anything' }), true],
    ['v* pattern against release-1.0', vStar, ev('tag', { targetBranch: 'release-1.0' }), false],
  ]);
});

describe('matchWorkflowTriggers - Comment triggers', () => {
  const any: LockCommentTrigger = { _type: 'comment', actions: [] };
  const created: LockCommentTrigger = { _type: 'comment', actions: ['created'] };
  const fromIssue: LockCommentTrigger = { _type: 'comment', actions: [], source: 'issue' };
  const fromPr: LockCommentTrigger = { _type: 'comment', actions: [], source: 'pr' };
  // An issue comment carries no pull_request field on payload.issue; a PR comment does.
  const issueComment = ev('comment', { payload: { issue: { id: 1 } } });
  const prComment = ev('comment', { payload: { issue: { id: 2, pull_request: { url: '...' } } } });
  const globBody: LockCommentTrigger = {
    _type: 'comment',
    actions: [],
    bodyMatch: { pattern: '/deploy*', type: 'glob' },
  };
  const regexBody: LockCommentTrigger = {
    _type: 'comment',
    actions: [],
    bodyMatch: { pattern: '^/deploy\\s+\\w+$', type: 'regex' },
  };
  const body = (text: string): SimulatedEvent =>
    ev('comment', { payload: { comment: { body: text } } });

  itMatches([
    ['comment event', any, ev('comment'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['action filter admits created', created, ev('comment', { action: 'created' }), true],
    ['action filter rejects deleted', created, ev('comment', { action: 'deleted' }), false],
    ['source issue admits an issue comment', fromIssue, issueComment, true],
    ['source issue rejects a PR comment', fromIssue, prComment, false],
    ['source pr rejects an issue comment', fromPr, issueComment, false],
    ['source pr admits a PR comment', fromPr, prComment, true],
    ['glob bodyMatch on "/deploy production"', globBody, body('/deploy production'), true],
    ['glob bodyMatch on "just a comment"', globBody, body('just a comment'), false],
    ['regex bodyMatch on a "/deploy <env>" body', regexBody, body('/deploy staging'), true],
    ['regex bodyMatch on a plain body', regexBody, body('hello world'), false],
  ]);

  it('rejects a catastrophic bodyMatch regex (#5)', () => {
    const trigger: LockCommentTrigger = {
      _type: 'comment',
      actions: [],
      bodyMatch: { pattern: '(a+)+$', type: 'regex' },
    };
    expect(() => matchWorkflowTriggers(wf(trigger), body('aaaa'))).toThrow(/unsafe|redos|regex/i);
  });
});

describe('matchWorkflowTriggers - Review triggers', () => {
  const any: LockTrigger = { _type: 'review', actions: [], states: [] };
  const submitted: LockTrigger = { _type: 'review', actions: ['submitted'], states: [] };
  const approved: LockTrigger = { _type: 'review', actions: [], states: ['approved'] };
  const reviewState = (state: string): SimulatedEvent =>
    ev('review', { payload: { review: { state } } });
  itMatches([
    ['review event', any, ev('review'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['action filter admits submitted', submitted, ev('review', { action: 'submitted' }), true],
    ['action filter rejects dismissed', submitted, ev('review', { action: 'dismissed' }), false],
    ['state filter admits approved', approved, reviewState('approved'), true],
    ['state filter rejects changes_requested', approved, reviewState('changes_requested'), false],
    [
      'empty actions and states match all',
      any,
      ev('review', { action: 'submitted', payload: { review: { state: 'approved' } } }),
      true,
    ],
  ]);
});

describe('matchWorkflowTriggers - Review comment triggers', () => {
  const any: LockTrigger = { _type: 'review_comment', actions: [] };
  const created: LockTrigger = { _type: 'review_comment', actions: ['created'] };
  itMatches([
    ['review_comment event', any, ev('review_comment'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['action filter admits created', created, ev('review_comment', { action: 'created' }), true],
    ['action filter rejects edited', created, ev('review_comment', { action: 'edited' }), false],
  ]);
});

describe('matchWorkflowTriggers - Release triggers', () => {
  const any: LockTrigger = { _type: 'release', actions: [] };
  const published: LockTrigger = { _type: 'release', actions: ['published'] };
  itMatches([
    ['release event', any, ev('release'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['action filter admits published', published, ev('release', { action: 'published' }), true],
    [
      'action filter rejects unpublished',
      published,
      ev('release', { action: 'unpublished' }),
      false,
    ],
    ['empty actions match created', any, ev('release', { action: 'created' }), true],
  ]);
});

describe('matchWorkflowTriggers - Dispatch triggers', () => {
  const any: LockTrigger = { _type: 'dispatch', types: [] };
  // Dispatch types match against event.action.
  const deployOrRollback: LockTrigger = { _type: 'dispatch', types: ['deploy', 'rollback'] };
  itMatches([
    ['dispatch event', any, ev('dispatch'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['types filter admits deploy', deployOrRollback, ev('dispatch', { action: 'deploy' }), true],
    ['types filter rejects test', deployOrRollback, ev('dispatch', { action: 'test' }), false],
    ['empty types match anything', any, ev('dispatch', { action: 'anything' }), true],
  ]);
});

describe('matchWorkflowTriggers - Create triggers', () => {
  const tagOnly: LockTrigger = { _type: 'create', refTypes: ['tag'], patterns: [] };
  const featureRefs: LockTrigger = { _type: 'create', refTypes: [], patterns: [glob('feature/*')] };
  const ref = (refType: string, name: string): SimulatedEvent =>
    ev('create', { payload: { ref_type: refType, ref: name } });
  const any: LockTrigger = { _type: 'create', refTypes: [], patterns: [] };
  itMatches([
    ['create event', any, ref('branch', 'feature/new'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['refType filter admits a tag', tagOnly, ref('tag', 'v1.0'), true],
    ['refType filter rejects a branch', tagOnly, ref('branch', 'feature/new'), false],
    ['ref pattern admits feature/new', featureRefs, ref('branch', 'feature/new'), true],
    ['ref pattern rejects bugfix/old', featureRefs, ref('branch', 'bugfix/old'), false],
  ]);
});

describe('matchWorkflowTriggers - Delete triggers', () => {
  const branchOnly: LockTrigger = { _type: 'delete', refTypes: ['branch'], patterns: [] };
  const releaseRefs: LockTrigger = { _type: 'delete', refTypes: [], patterns: [glob('release-*')] };
  const ref = (refType: string, name: string): SimulatedEvent =>
    ev('delete', { payload: { ref_type: refType, ref: name } });
  const any: LockTrigger = { _type: 'delete', refTypes: [], patterns: [] };
  itMatches([
    ['delete event', any, ref('branch', 'feature/old'), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    ['refType filter admits a branch', branchOnly, ref('branch', 'feature/old'), true],
    ['refType filter rejects a tag', branchOnly, ref('tag', 'v0.9'), false],
    ['ref pattern admits release-1.0', releaseRefs, ref('branch', 'release-1.0'), true],
    ['ref pattern rejects feature/new', releaseRefs, ref('branch', 'feature/new'), false],
  ]);
});

describe('matchWorkflowTriggers - Status triggers', () => {
  const status = (contexts: string[], states: string[]): LockTrigger => ({
    _type: 'status',
    contexts,
    states,
  });
  const statusEv = (context: string, state: string): SimulatedEvent =>
    ev('status', { payload: { context, state } });
  itMatches([
    ['status event', status([], []), statusEv('ci/test', 'success'), true],
    ['rejects a push event', status([], []), PUSH_MAIN, false],
    ['context glob admits ci/test', status(['ci/*'], []), statusEv('ci/test', 'success'), true],
    [
      'context glob rejects deploy/staging',
      status(['ci/*'], []),
      statusEv('deploy/staging', 'success'),
      false,
    ],
    ['state filter admits success', status([], ['success']), statusEv('ci/test', 'success'), true],
    [
      'state filter rejects failure',
      status([], ['success']),
      statusEv('ci/test', 'failure'),
      false,
    ],
    [
      'context AND state: both match',
      status(['ci/*'], ['success']),
      statusEv('ci/test', 'success'),
      true,
    ],
    [
      'context AND state: wrong state',
      status(['ci/*'], ['success']),
      statusEv('ci/test', 'failure'),
      false,
    ],
    [
      'context AND state: wrong context',
      status(['ci/*'], ['success']),
      statusEv('deploy/staging', 'success'),
      false,
    ],
  ]);
});

describe('matchWorkflowTriggers - Workflow run triggers', () => {
  const run = (fields: Partial<LockWorkflowRunTrigger> = {}): LockWorkflowRunTrigger => ({
    _type: 'workflow_run',
    actions: [],
    workflows: [],
    conclusions: [],
    ...fields,
  });
  const runEv = (name: string, conclusion: string): SimulatedEvent =>
    ev('workflow_run', { payload: { workflow_run: { name, conclusion } } });
  itMatches([
    ['workflow_run event', run(), ev('workflow_run'), true],
    ['rejects a push event', run(), PUSH_MAIN, false],
    [
      'action filter admits completed',
      run({ actions: ['completed'] }),
      ev('workflow_run', { action: 'completed' }),
      true,
    ],
    [
      'action filter rejects requested',
      run({ actions: ['completed'] }),
      ev('workflow_run', { action: 'requested' }),
      false,
    ],
    [
      'workflow name filter admits CI',
      run({ workflows: ['CI', 'Build'] }),
      runEv('CI', 'success'),
      true,
    ],
    [
      'workflow name filter rejects Deploy',
      run({ workflows: ['CI', 'Build'] }),
      runEv('Deploy', 'success'),
      false,
    ],
    [
      'conclusion filter admits success',
      run({ conclusions: ['success'] }),
      runEv('CI', 'success'),
      true,
    ],
    [
      'conclusion filter rejects failure',
      run({ conclusions: ['success'] }),
      runEv('CI', 'failure'),
      false,
    ],
  ]);
});

describe('matchWorkflowTriggers - Fork triggers', () => {
  itMatches([
    ['fork event, unconditionally', { _type: 'fork' }, ev('fork'), true],
    ['rejects a push event', { _type: 'fork' }, PUSH_MAIN, false],
  ]);
});

describe.each([
  ['star', 'created', 'deleted'],
  ['watch', 'started', 'stopped'],
] as const)('matchWorkflowTriggers - %s triggers', (type, admitted, rejected) => {
  const any: LockTrigger = { _type: type, actions: [] };
  const filtered: LockTrigger = { _type: type, actions: [admitted] };
  itMatches([
    [`${type} event`, any, ev(type), true],
    ['rejects a push event', any, PUSH_MAIN, false],
    [`action filter admits ${admitted}`, filtered, ev(type, { action: admitted }), true],
    [`action filter rejects ${rejected}`, filtered, ev(type, { action: rejected }), false],
  ]);
});

describe('matchWorkflowTriggers - Webhook triggers', () => {
  const deployments: LockTrigger = {
    _type: 'webhook',
    events: ['deployment', 'deployment_status'],
    actions: [],
  };
  const deployment: LockTrigger = { _type: 'webhook', events: ['deployment'], actions: [] };
  const deploymentCreated: LockTrigger = {
    _type: 'webhook',
    events: ['deployment'],
    actions: ['created'],
  };
  itMatches([
    ['events array admits deployment', deployments, ev('deployment'), true],
    ['events array admits deployment_status', deployments, ev('deployment_status'), true],
    ['rejects an event not in the events array', deployment, PUSH_MAIN, false],
    [
      'action filter admits created',
      deploymentCreated,
      ev('deployment', { action: 'created' }),
      true,
    ],
    [
      'action filter rejects deleted',
      deploymentCreated,
      ev('deployment', { action: 'deleted' }),
      false,
    ],
    [
      'action filter rejects an event without an action',
      deploymentCreated,
      ev('deployment'),
      false,
    ],
    ['empty actions match anything', deployment, ev('deployment', { action: 'anything' }), true],
  ]);
});

describe('matchWorkflowTriggers - KiCI event triggers', () => {
  const kici = (fields: Partial<LockKiciEventTrigger> = {}): LockKiciEventTrigger => ({
    _type: 'kici_event',
    eventName: 'deploy-complete',
    ...fields,
  });
  const kiciEv = (
    eventName: string,
    payload: Record<string, unknown> = {},
    sourceRepo?: string,
  ): SimulatedEvent =>
    ev('kici_event', {
      payload: { eventName, payload, ...(sourceRepo !== undefined && { sourceRepo }) },
    });
  const matchAndNot = kici({
    eventName: 'deploy',
    match: { '$.status': 'deployed' },
    not: { '$.env': 'dev' },
  });
  itMatches([
    ['event name deploy-complete', kici(), kiciEv('deploy-complete'), true],
    ['event name build-started', kici(), kiciEv('build-started'), false],
    ['rejects a push event', kici(), PUSH_MAIN, false],
    [
      'match filter env=prod',
      kici({ match: { '$.env': 'prod' } }),
      kiciEv('deploy-complete', { env: 'prod' }),
      true,
    ],
    [
      'match filter env=staging',
      kici({ match: { '$.env': 'prod' } }),
      kiciEv('deploy-complete', { env: 'staging' }),
      false,
    ],
    [
      'not filter env=prod',
      kici({ not: { '$.env': 'staging' } }),
      kiciEv('deploy-complete', { env: 'prod' }),
      true,
    ],
    [
      'not filter env=staging',
      kici({ not: { '$.env': 'staging' } }),
      kiciEv('deploy-complete', { env: 'staging' }),
      false,
    ],
    [
      'source filter org/repo-a',
      kici({ source: 'org/repo-a' }),
      kiciEv('deploy-complete', {}, 'org/repo-a'),
      true,
    ],
    [
      'source filter org/repo-b',
      kici({ source: 'org/repo-a' }),
      kiciEv('deploy-complete', {}, 'org/repo-b'),
      false,
    ],
    [
      'match + not: both pass',
      matchAndNot,
      kiciEv('deploy', { status: 'deployed', env: 'prod' }),
      true,
    ],
    [
      'match + not: not filter trips',
      matchAndNot,
      kiciEv('deploy', { status: 'deployed', env: 'dev' }),
      false,
    ],
    [
      'match + not: match filter misses',
      matchAndNot,
      kiciEv('deploy', { status: 'pending', env: 'prod' }),
      false,
    ],
  ]);
});

describe('matchWorkflowTriggers - Workflow complete triggers', () => {
  const complete = (
    fields: Partial<LockWorkflowCompleteTrigger> = {},
  ): LockWorkflowCompleteTrigger => ({
    _type: 'workflow_complete',
    ...fields,
  });
  const completeEv = (workflowName: string, status: string, sourceRepo?: string): SimulatedEvent =>
    ev('workflow_complete', {
      payload: { workflowName, status, ...(sourceRepo !== undefined && { sourceRepo }) },
    });
  const ciAnyEnd = complete({ name: 'CI', status: ['success', 'failed'] });
  itMatches([
    ['workflow_complete event', complete(), completeEv('CI', 'success'), true],
    ['rejects a push event', complete(), PUSH_MAIN, false],
    ['name filter admits CI', complete({ name: 'CI' }), completeEv('CI', 'success'), true],
    [
      'name filter rejects Deploy',
      complete({ name: 'CI' }),
      completeEv('Deploy', 'success'),
      false,
    ],
    [
      'status filter admits success',
      complete({ status: ['success'] }),
      completeEv('CI', 'success'),
      true,
    ],
    [
      'status filter rejects failed',
      complete({ status: ['success'] }),
      completeEv('CI', 'failed'),
      false,
    ],
    [
      'source filter admits org/backend',
      complete({ source: 'org/backend' }),
      completeEv('CI', 'success', 'org/backend'),
      true,
    ],
    [
      'source filter rejects org/frontend',
      complete({ source: 'org/backend' }),
      completeEv('CI', 'success', 'org/frontend'),
      false,
    ],
    ['name + status: both match', ciAnyEnd, completeEv('CI', 'success'), true],
    ['name + status: wrong name', ciAnyEnd, completeEv('Deploy', 'success'), false],
    ['name + status: wrong status', ciAnyEnd, completeEv('CI', 'cancelled'), false],
  ]);
});

describe('matchWorkflowTriggers - Workflows failed batch triggers', () => {
  const batch = (
    fields: Partial<LockWorkflowsFailedBatchTrigger> = {},
  ): LockWorkflowsFailedBatchTrigger => ({
    _type: 'workflows_failed_batch',
    accumulateFor: 10000,
    ...fields,
  });
  const completeEv = (status: string, sourceRepo?: string): SimulatedEvent =>
    ev('workflow_complete', {
      payload: { workflowName: 'CI', status, ...(sourceRepo !== undefined && { sourceRepo }) },
    });
  itMatches([
    [
      'a failed workflow_complete event (accumulation input)',
      batch(),
      completeEv('failed', 'org/repo'),
      true,
    ],
    ['a non-failed workflow_complete event', batch(), completeEv('success'), false],
    [
      'the synthetic workflows_failed_batch event (dispatch)',
      batch(),
      ev('workflows_failed_batch', { payload: { total: 3, runs: [], sourceRepo: 'org/repo' } }),
      true,
    ],
    ['rejects a push event', batch(), PUSH_MAIN, false],
    [
      'source filter admits org/backend',
      batch({ source: 'org/backend' }),
      completeEv('failed', 'org/backend'),
      true,
    ],
    [
      'source filter rejects org/frontend',
      batch({ source: 'org/backend' }),
      completeEv('failed', 'org/frontend'),
      false,
    ],
  ]);
});

describe('matchWorkflowTriggers - Job complete triggers', () => {
  const job = (fields: Partial<LockJobCompleteTrigger> = {}): LockJobCompleteTrigger => ({
    _type: 'job_complete',
    ...fields,
  });
  const jobEv = (
    workflowName: string,
    jobName: string,
    status: string,
    sourceRepo?: string,
  ): SimulatedEvent =>
    ev('job_complete', {
      payload: { workflowName, jobName, status, ...(sourceRepo !== undefined && { sourceRepo }) },
    });
  const ciBuildSuccess = job({ workflow: 'CI', job: 'build', status: ['success'] });
  itMatches([
    ['job_complete event', job(), jobEv('CI', 'build', 'success'), true],
    ['rejects a push event', job(), PUSH_MAIN, false],
    ['workflow filter admits CI', job({ workflow: 'CI' }), jobEv('CI', 'build', 'success'), true],
    [
      'workflow filter rejects Deploy',
      job({ workflow: 'CI' }),
      jobEv('Deploy', 'build', 'success'),
      false,
    ],
    ['job filter admits build', job({ job: 'build' }), jobEv('CI', 'build', 'success'), true],
    ['job filter rejects test', job({ job: 'build' }), jobEv('CI', 'test', 'success'), false],
    [
      'status filter admits success',
      job({ status: ['success', 'failed'] }),
      jobEv('CI', 'build', 'success'),
      true,
    ],
    [
      'status filter rejects skipped',
      job({ status: ['success', 'failed'] }),
      jobEv('CI', 'build', 'skipped'),
      false,
    ],
    [
      'source filter admits org/backend',
      job({ source: 'org/backend' }),
      jobEv('CI', 'build', 'success', 'org/backend'),
      true,
    ],
    [
      'source filter rejects org/frontend',
      job({ source: 'org/backend' }),
      jobEv('CI', 'build', 'success', 'org/frontend'),
      false,
    ],
    ['workflow + job + status: all match', ciBuildSuccess, jobEv('CI', 'build', 'success'), true],
    ['workflow + job + status: wrong job', ciBuildSuccess, jobEv('CI', 'test', 'success'), false],
  ]);
});

describe('matchWorkflowTriggers - Generic webhook triggers', () => {
  const hook = (fields: Partial<LockGenericWebhookTrigger> = {}): LockGenericWebhookTrigger => ({
    _type: 'generic_webhook',
    source: 'my-service',
    ...fields,
  });
  const hookEv = (payload: Record<string, unknown>, action?: string): SimulatedEvent =>
    ev('generic_webhook', { payload, ...(action !== undefined && { action }) });
  const combined = hook({
    events: ['deploy'],
    match: { '$.status': 'completed' },
    not: { '$.env': 'dev' },
  });
  const full = { source: 'my-service', eventType: 'deploy', status: 'completed', env: 'prod' };
  itMatches([
    ['source my-service', hook(), hookEv({ source: 'my-service' }), true],
    ['source other-service', hook(), hookEv({ source: 'other-service' }), false],
    ['rejects a push event', hook(), PUSH_MAIN, false],
    [
      'events filter admits deploy',
      hook({ events: ['deploy', 'rollback'] }),
      hookEv({ source: 'my-service', eventType: 'deploy' }),
      true,
    ],
    [
      'events filter rejects test',
      hook({ events: ['deploy', 'rollback'] }),
      hookEv({ source: 'my-service', eventType: 'test' }),
      false,
    ],
    [
      'event type falls back to event.action when the payload has no eventType',
      hook({ events: ['deploy'] }),
      hookEv({ source: 'my-service' }, 'deploy'),
      true,
    ],
    [
      'match filter env=prod',
      hook({ match: { '$.env': 'prod' } }),
      hookEv({ source: 'my-service', env: 'prod' }),
      true,
    ],
    [
      'match filter env=staging',
      hook({ match: { '$.env': 'prod' } }),
      hookEv({ source: 'my-service', env: 'staging' }),
      false,
    ],
    [
      'not filter env=prod',
      hook({ not: { '$.env': 'dev' } }),
      hookEv({ source: 'my-service', env: 'prod' }),
      true,
    ],
    [
      'not filter env=dev',
      hook({ not: { '$.env': 'dev' } }),
      hookEv({ source: 'my-service', env: 'dev' }),
      false,
    ],
    ['combined filters: all pass', combined, hookEv(full), true],
    ['combined filters: wrong source', combined, hookEv({ ...full, source: 'other' }), false],
    ['combined filters: wrong event', combined, hookEv({ ...full, eventType: 'test' }), false],
    ['combined filters: match misses', combined, hookEv({ ...full, status: 'pending' }), false],
    ['combined filters: not trips', combined, hookEv({ ...full, env: 'dev' }), false],
  ]);
});

describe('matchWorkflowTriggers - Edge cases', () => {
  itMatches([
    [
      'empty branch patterns match any branch',
      push(),
      pushEv({ targetBranch: 'any-branch-name' }),
      true,
    ],
    [
      'empty path patterns match any file',
      push(),
      pushEv({ changedFiles: ['anything/at/all.txt'] }),
      true,
    ],
    ['a path filter with no changed files', push({ paths: ['src/**'] }), PUSH_MAIN, false],
  ]);
});

describe('matchWorkflowTriggers - Schedule triggers', () => {
  const hourly: LockTrigger = { _type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' };
  const cron = (cronExpression: string): SimulatedEvent =>
    ev('schedule', { payload: { cronExpression } });
  itMatches([
    ['matching cron expression', hourly, cron('0 * * * *'), true],
    ['different cron expression', hourly, cron('0 0 * * *'), false],
    ['rejects a push event', hourly, PUSH_MAIN, false],
    [
      'a trigger carrying a description',
      {
        _type: 'schedule',
        cronExpression: '0 0 * * *',
        timezone: 'America/New_York',
        description: 'Nightly build',
      },
      cron('0 0 * * *'),
      true,
    ],
  ]);
});

describe('matchWorkflowTriggers - Lifecycle triggers', () => {
  const lifecycle = (events: string[], sources?: string[]): LockTrigger => ({
    _type: 'lifecycle',
    events,
    ...(sources !== undefined && { sources }),
  });
  const lifecycleEv = (lifecycleEvent: string, sourceRepo?: string): SimulatedEvent =>
    ev('lifecycle', {
      payload: { lifecycleEvent, ...(sourceRepo !== undefined && { sourceRepo }) },
    });
  itMatches([
    [
      'matching event type',
      lifecycle(['workflow_complete']),
      lifecycleEv('workflow_complete'),
      true,
    ],
    [
      'event type from the events array',
      lifecycle(['workflow_complete', 'job_failed']),
      lifecycleEv('job_failed'),
      true,
    ],
    ['wrong event type', lifecycle(['workflow_complete']), lifecycleEv('job_failed'), false],
    ['rejects a push event', lifecycle(['workflow_complete']), PUSH_MAIN, false],
    [
      'sources filter admits org/deploy-repo',
      lifecycle(['job_complete'], ['org/deploy-repo']),
      lifecycleEv('job_complete', 'org/deploy-repo'),
      true,
    ],
    [
      'sources filter rejects org/other-repo',
      lifecycle(['job_complete'], ['org/deploy-repo']),
      lifecycleEv('job_complete', 'org/other-repo'),
      false,
    ],
    [
      'no sources filter matches any source',
      lifecycle(['workflow_complete']),
      lifecycleEv('workflow_complete', 'org/any-repo'),
      true,
    ],
    [
      'empty sources array matches any source',
      lifecycle(['workflow_complete'], []),
      lifecycleEv('workflow_complete', 'org/any-repo'),
      true,
    ],
  ]);
});

describe('matchRepoPatterns', () => {
  const myorgNoSecrets = [glob('myorg/*'), glob('!myorg/secret-*')];
  it.each<[label: string, patterns: LockBranchPattern[], repo: string, expected: boolean]>([
    ['empty repos array (no filter = match all)', [], 'org/repo', true],
    ['glob hit', [glob('myorg/*')], 'myorg/api', true],
    ['glob miss', [glob('myorg/*')], 'other/repo', false],
    ['!-prefixed pattern excludes', [glob('!myorg/internal-*')], 'myorg/internal-tools', false],
    ['!-prefixed exclusion beats an include', myorgNoSecrets, 'myorg/secret-repo', false],
    ['include hit the exclusion does not cover', myorgNoSecrets, 'myorg/api', true],
    ['regex hit', [{ type: 'regex', pattern: '^myorg/api-v\\d+$' }], 'myorg/api-v2', true],
    ['regex miss', [{ type: 'regex', pattern: '^myorg/api-v\\d+$' }], 'myorg/web', false],
    [
      'all-negation array, non-excluded repo (implicit match-all)',
      [glob('!myorg/secret-*')],
      'myorg/public-repo',
      true,
    ],
    ['all-negation array, excluded repo', [glob('!myorg/secret-*')], 'myorg/secret-repo', false],
  ])('%s: %j against %s → %s', (_label, patterns, repo, expected) => {
    expect(matchRepoPatterns(patterns, repo)).toBe(expected);
  });

  it("matches a dot-prefixed identifier against '**'", () => {
    // Repo identifiers are org/name pairs, not paths, so `repos: ['**']` ("every
    // repo") must include a leading dot. The branch/tag matcher keeps picomatch's
    // default and does NOT match; routing repos through it drops this repo.
    expect(matchBranchPattern({ type: 'glob', pattern: '**' }, '.hidden/repo')).toBe(false);
    expect(matchRepoPatterns([{ type: 'glob', pattern: '**' }], '.hidden/repo')).toBe(true);
    // Positive control: an ordinary identifier still matches.
    expect(matchRepoPatterns([{ type: 'glob', pattern: '**' }], 'acme/canary')).toBe(true);
  });

  it('excludes a dot-prefixed identifier via a !-prefixed wildcard pattern', () => {
    // The exclusion arm compiles through the same matcher; failing open would run
    // the workflow on a repo an operator deliberately excluded.
    //
    // The first segment must be a WILDCARD: `!.hidden/**` matches under
    // picomatch's default too, so it would pass with this arm on the branch
    // matcher. `*/repo` matches `.hidden/repo` only with `dot: true`.
    const patterns = [glob('**'), glob('!*/repo')];
    expect(matchRepoPatterns(patterns, '.hidden/repo')).toBe(false);
    // Control: a dot-prefixed repo the pattern does not name still matches.
    expect(matchRepoPatterns(patterns, '.hidden/other')).toBe(true);
  });
});

describe('matchWorkflowTriggers - repo pattern filtering', () => {
  const mainInMyorg = push({ branches: [glob('main')], repos: [glob('myorg/*')] });
  const prMyorgNoSecrets = pr({
    events: ['opened'],
    repos: [glob('myorg/*'), glob('!myorg/secret-*')],
  });
  itMatches([
    ['push repos + branch: matching repo', mainInMyorg, pushEv({ sourceRepo: 'myorg/api' }), true],
    ['push repos + branch: other repo', mainInMyorg, pushEv({ sourceRepo: 'other/repo' }), false],
    [
      'PR repos with exclusion: included repo',
      prMyorgNoSecrets,
      prEv({ action: 'opened', sourceRepo: 'myorg/api' }),
      true,
    ],
    [
      'PR repos with exclusion: excluded repo',
      prMyorgNoSecrets,
      prEv({ action: 'opened', sourceRepo: 'myorg/secret-keys' }),
      false,
    ],
    [
      'push without a repos field matches any repo',
      push({ branches: [glob('main')] }),
      pushEv({ sourceRepo: 'any/repo' }),
      true,
    ],
  ]);

  it('push trigger with repos returns false when sourceRepo is missing from event', () => {
    const decision = matchWorkflowTriggers(wf(push({ repos: [glob('myorg/*')] })), PUSH_MAIN);
    expect(decision.matched).toBe(false);
    const repoCheck = decision.checks.find((c) => c.check === 'repo');
    expect(repoCheck).toBeDefined();
    expect(repoCheck?.passed).toBe(false);
    expect(repoCheck?.value).toBe('(missing)');
  });
});

describe('action filter with missing event.action', () => {
  itMatches([
    [
      'comment trigger requiring actions',
      { _type: 'comment', actions: ['created'] },
      ev('comment'),
      false,
    ],
    [
      'release trigger requiring actions',
      { _type: 'release', actions: ['published'] },
      ev('release'),
      false,
    ],
    [
      'dispatch trigger requiring types',
      { _type: 'dispatch', types: ['deploy'] },
      ev('dispatch'),
      false,
    ],
    [
      'release trigger with empty actions (match all)',
      { _type: 'release', actions: [] },
      ev('release'),
      true,
    ],
  ]);
});

describe('commitMessage trigger filter', () => {
  const pushTrigger = (commitMessage: LockTextMatch): LockPushTrigger => push({ commitMessage });

  const pushEvent = (commitMessage?: string): SimulatedEvent =>
    pushEv(commitMessage !== undefined ? { commitMessage } : {});

  it('admits an event whose message satisfies the matcher', () => {
    const traces: TraceEntry[] = [];
    expect(
      matchTrigger(pushTrigger({ notContains: ['[skip ci]'] }), pushEvent('feat: thing'), traces),
    ).toBe(true);
  });

  it('rejects an event whose message trips notContains', () => {
    const traces: TraceEntry[] = [];
    expect(
      matchTrigger(pushTrigger({ notContains: ['[skip ci]'] }), pushEvent('wip [skip ci]'), traces),
    ).toBe(false);
    const entry = traces.find((t) => t.check === 'commitMessage');
    expect(entry?.passed).toBe(false);
    expect(entry?.value).toBe('excluded');
  });

  it('matches the multi-line body, not just the subject', () => {
    const traces: TraceEntry[] = [];
    expect(
      matchTrigger(
        pushTrigger({ notContains: ['[skip ci]'] }),
        pushEvent('feat: thing\n\n[skip ci]\n'),
        traces,
      ),
    ).toBe(false);
  });

  it('is INDETERMINATE — not a clean exclusion — when the event carries no message', () => {
    const traces: TraceEntry[] = [];
    expect(
      matchTrigger(pushTrigger({ notContains: ['[skip ci]'] }), pushEvent(undefined), traces),
    ).toBe(false);
    const entry = traces.find((t) => t.check === 'commitMessage');
    expect(entry?.value).toBe('indeterminate');
    expect(entry?.reason).toContain('no commit message');
  });

  it('treats an empty-string message as a real value', () => {
    const traces: TraceEntry[] = [];
    expect(matchTrigger(pushTrigger({ notContains: ['[skip ci]'] }), pushEvent(''), traces)).toBe(
      true,
    );
  });

  it('records no commitMessage entry when the trigger declares none', () => {
    const traces: TraceEntry[] = [];
    matchTrigger(push(), pushEvent(undefined), traces);
    expect(traces.find((t) => t.check === 'commitMessage')).toBeUndefined();
  });

  it('applies to pr and tag triggers too', () => {
    const prTrigger = pr({ events: ['opened'], commitMessage: { contains: ['deploy'] } });
    const prEvent = prEv({ action: 'opened', commitMessage: 'please deploy this' });
    expect(matchTrigger(prTrigger, prEvent, [])).toBe(true);

    const tagTrigger: LockTagTrigger = {
      _type: 'tag',
      patterns: [],
      commitMessage: { contains: ['rc'] },
    };
    const tagEvent = ev('tag', { targetBranch: 'v1.0.0', commitMessage: 'cut rc build' });
    expect(matchTrigger(tagTrigger, tagEvent, [])).toBe(true);
  });
});

describe('deferred paths (unavailable diff with a computable range)', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const pushPaths = (paths: string[]): LockPushTrigger => push({ paths });
  const unavailablePush = (payload: Record<string, unknown>): SimulatedEvent =>
    ev('push', {
      targetBranch: 'feature',
      payload,
      changedFiles: [],
      changedFilesStatus: 'unavailable',
    });

  it('records the paths and decides on the agent when a range exists', () => {
    const d = matchWorkflowTriggers(
      wf(pushPaths(['src/**'])),
      unavailablePush({ before: SHA_A, after: SHA_B }),
    );
    expect(d.matched).toBe(true);
    expect(d.deferredPaths).toEqual([['src/**']]);
    expect(d.checks.find((c) => c.check === 'paths')?.value).toBe(
      '[unavailable — decided on agent]',
    );
  });

  // fails-when: the matcher records deferredPaths for a range-less event
  it('matches conservatively with no deferral when no range exists', () => {
    const d = matchWorkflowTriggers(wf(pushPaths(['src/**'])), unavailablePush({}));
    expect(d.matched).toBe(true);
    expect(d.deferredPaths).toBeUndefined();
    expect(d.checks.find((c) => c.check === 'paths')?.value).toBe(
      '[unavailable — matched conservatively]',
    );
  });

  // fails-when: the matcher returns on the first conservative match
  it('an outright match on a later trigger wins over a conservative first one', () => {
    const d = matchWorkflowTriggers(
      wf(pushPaths(['src/**']), pushPaths([])),
      unavailablePush({ before: SHA_A, after: SHA_B }),
    );
    expect(d.matched).toBe(true);
    expect(d.matchedTrigger).toBe(1);
    expect(d.deferredPaths).toBeUndefined();
  });

  it('collects every conservatively-matched trigger', () => {
    const d = matchWorkflowTriggers(
      wf(pushPaths(['src/**']), pushPaths(['docs/**'])),
      unavailablePush({ before: SHA_A, after: SHA_B }),
    );
    expect(d.deferredPaths).toEqual([['src/**'], ['docs/**']]);
    expect(d.matchedTrigger).toBe(0);
  });

  // breaks-if-wrong: a fetched diff must keep deciding on the orchestrator
  it('a fetched diff never defers', () => {
    const d = matchWorkflowTriggers(wf(pushPaths(['src/**'])), {
      ...unavailablePush({ before: SHA_A, after: SHA_B }),
      changedFiles: ['src/a.ts'],
      changedFilesStatus: 'fetched',
    });
    expect(d.matched).toBe(true);
    expect(d.deferredPaths).toBeUndefined();
  });
});
