/**
 * Tests for trigger matching engine.
 * Consolidated from packages/compiler and packages/orchestrator tests.
 */
import { describe, it, expect } from 'vitest';
import {
  matchBranchPattern,
  matchPathPatterns,
  matchRepoPatterns,
  matchWorkflowTriggers,
  matchAllWorkflows,
} from './matcher.js';
import type {
  LockBranchPattern,
  LockWorkflow,
  LockPrTrigger,
  LockPushTrigger,
  LockTagTrigger,
  LockCommentTrigger,
  LockReviewTrigger,
  LockReviewCommentTrigger,
  LockReleaseTrigger,
  LockDispatchTrigger,
  LockCreateTrigger,
  LockDeleteTrigger,
  LockStatusTrigger,
  LockWorkflowRunTrigger,
  LockForkTrigger,
  LockStarTrigger,
  LockWatchTrigger,
  LockWebhookTrigger,
  LockKiciEventTrigger,
  LockWorkflowCompleteTrigger,
  LockJobCompleteTrigger,
  LockGenericWebhookTrigger,
  LockScheduleTrigger,
  LockLifecycleTrigger,
  SimulatedEvent,
} from './types.js';

describe('matchBranchPattern', () => {
  it('matches exact glob pattern', () => {
    const pattern: LockBranchPattern = { type: 'glob', pattern: 'main' };
    expect(matchBranchPattern(pattern, 'main')).toBe(true);
    expect(matchBranchPattern(pattern, 'develop')).toBe(false);
  });

  it('matches wildcard glob pattern', () => {
    const pattern: LockBranchPattern = { type: 'glob', pattern: 'feature/*' };
    expect(matchBranchPattern(pattern, 'feature/login')).toBe(true);
    expect(matchBranchPattern(pattern, 'feature/signup')).toBe(true);
    expect(matchBranchPattern(pattern, 'bugfix/login')).toBe(false);
  });

  it('matches double-star glob pattern', () => {
    const pattern: LockBranchPattern = { type: 'glob', pattern: 'release/**' };
    expect(matchBranchPattern(pattern, 'release/v1.0')).toBe(true);
    expect(matchBranchPattern(pattern, 'release/v1.0/hotfix')).toBe(true);
    expect(matchBranchPattern(pattern, 'main')).toBe(false);
  });

  it('matches regex pattern', () => {
    const pattern: LockBranchPattern = {
      type: 'regex',
      pattern: '^release-\\d+\\.\\d+$',
    };
    expect(matchBranchPattern(pattern, 'release-1.0')).toBe(true);
    expect(matchBranchPattern(pattern, 'release-2.5')).toBe(true);
    expect(matchBranchPattern(pattern, 'release-abc')).toBe(false);
  });

  it('matches regex with flags', () => {
    const pattern: LockBranchPattern = {
      type: 'regex',
      pattern: '^FEATURE',
      flags: 'i',
    };
    expect(matchBranchPattern(pattern, 'FEATURE-123')).toBe(true);
    expect(matchBranchPattern(pattern, 'feature-123')).toBe(true);
    expect(matchBranchPattern(pattern, 'bugfix-123')).toBe(false);
  });
});

describe('matchPathPatterns', () => {
  it('matches when no filters provided', () => {
    expect(matchPathPatterns([], ['src/app.ts'])).toBe(true);
  });

  it('matches files against include patterns', () => {
    expect(matchPathPatterns(['src/**/*.ts'], ['src/app.ts'])).toBe(true);
    expect(matchPathPatterns(['src/**/*.ts'], ['tests/app.test.ts'])).toBe(false);
  });

  it('excludes files matching !-prefixed patterns', () => {
    expect(matchPathPatterns(['!**/*.md'], ['README.md'])).toBe(false);
    expect(matchPathPatterns(['!**/*.md'], ['src/app.ts'])).toBe(true);
  });

  it('applies include and exclude together', () => {
    // Include src files, exclude tests
    expect(matchPathPatterns(['src/**', '!**/*.test.ts'], ['src/app.ts'])).toBe(true);
    expect(matchPathPatterns(['src/**', '!**/*.test.ts'], ['src/app.test.ts'])).toBe(false);
    expect(matchPathPatterns(['src/**', '!**/*.test.ts'], ['docs/README.md'])).toBe(false);
  });

  it('excludes take priority over includes', () => {
    // Match src/* but exclude src/temp/*
    expect(matchPathPatterns(['src/**', '!src/temp/**'], ['src/app.ts'])).toBe(true);
    expect(matchPathPatterns(['src/**', '!src/temp/**'], ['src/temp/cache.ts'])).toBe(false);
  });

  it('matches include when excluded files are also present (regression C-1)', () => {
    // src/app.ts matches src/** and does NOT match **/*.md
    // README.md matches **/*.md but should be filtered out, not veto the trigger
    expect(matchPathPatterns(['src/**', '!**/*.md'], ['src/app.ts', 'README.md'])).toBe(true);
  });

  it('rejects when all files are excluded even if they match includes (regression C-1)', () => {
    // src/app.md matches src/** but also matches **/*.md -- after filtering, no files remain
    expect(matchPathPatterns(['src/**', '!**/*.md'], ['src/app.md'])).toBe(false);
  });

  it('matches when mix of included and excluded files with multiple patterns', () => {
    // src/utils.ts matches src/** and is not excluded
    // tests/foo.test.ts is excluded by **/*.test.ts
    // docs/README.md is excluded by **/*.md
    expect(
      matchPathPatterns(
        ['src/**', '!**/*.test.ts', '!**/*.md'],
        ['src/utils.ts', 'tests/foo.test.ts', 'docs/README.md'],
      ),
    ).toBe(true);
  });

  it('rejects when only excluded files match includes', () => {
    // src/app.test.ts matches src/** but is excluded by **/*.test.ts
    // After filtering, no relevant files match src/**
    expect(
      matchPathPatterns(['src/**', '!**/*.test.ts'], ['src/app.test.ts', 'docs/README.md']),
    ).toBe(false);
  });

  it('returns false when no changed files and paths filter exists', () => {
    expect(matchPathPatterns(['src/**'], [])).toBe(false);
  });

  it('returns true when no changed files and no paths filter', () => {
    expect(matchPathPatterns([], [])).toBe(true);
  });

  it('all-negation array with non-excluded files matches (implicit match-all)', () => {
    expect(matchPathPatterns(['!src/generated/**'], ['src/generated/foo.ts', 'src/main.ts'])).toBe(
      true,
    );
  });

  it('all-negation array with all files excluded returns false', () => {
    expect(matchPathPatterns(['!src/generated/**'], ['src/generated/foo.ts'])).toBe(false);
  });
});

describe('matchWorkflowTriggers - PR triggers', () => {
  it('matches PR event type', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: ['opened', 'synchronize'],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const prEvent: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, prEvent);
    expect(decision.matched).toBe(true);
    expect(decision.matchedTrigger).toBe(0);
  });

  it('rejects non-PR events for PR trigger', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const pushEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, pushEvent);
    expect(decision.matched).toBe(false);
    expect(decision.checks.some((c) => c.check === 'event type' && !c.passed)).toBe(true);
  });

  it('matches PR action filter', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: ['opened', 'synchronize'],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const openedEvent: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
    };

    const closedEvent: SimulatedEvent = {
      type: 'pull_request',
      action: 'closed',
      payload: {},
      targetBranch: 'main',
    };

    expect(matchWorkflowTriggers(workflow, openedEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, closedEvent).matched).toBe(false);
  });

  it('rejects PR event without action when trigger requires specific actions', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: ['opened', 'synchronize'],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const noActionEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
    };

    expect(matchWorkflowTriggers(workflow, noActionEvent).matched).toBe(false);
  });

  it('matches target branch patterns', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [{ type: 'glob', pattern: 'main' }],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const mainEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
    };

    const devEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'develop',
    };

    expect(matchWorkflowTriggers(workflow, mainEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, devEvent).matched).toBe(false);
  });

  it('matches source branch patterns', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [{ type: 'glob', pattern: 'feature/*' }],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const featureEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      sourceBranch: 'feature/login',
    };

    const bugfixEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      sourceBranch: 'bugfix/crash',
    };

    expect(matchWorkflowTriggers(workflow, featureEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, bugfixEvent).matched).toBe(false);
  });

  it('rejects PR with source branch filter when sourceBranch is missing (regression M-3)', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [{ type: 'glob', pattern: 'feature/*' }],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    // Event with no sourceBranch should NOT match when trigger requires source branch filtering
    const noSourceBranchEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      // sourceBranch intentionally omitted
    };

    const decision = matchWorkflowTriggers(workflow, noSourceBranchEvent);
    expect(decision.matched).toBe(false);
    const sourceBranchCheck = decision.checks.find((c) => c.check === 'source branch');
    expect(sourceBranchCheck).toBeDefined();
    expect(sourceBranchCheck?.passed).toBe(false);
    expect(sourceBranchCheck?.value).toBe('(missing)');
  });

  it('matches path filters for PRs', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [],
          paths: ['src/**', '!**/*.md'],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const srcEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['src/app.ts', 'src/utils.ts'],
    };

    const docsEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['README.md', 'docs/guide.md'],
    };

    const mixedEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['src/README.md'], // Matches src/** but excluded by *.md
    };

    expect(matchWorkflowTriggers(workflow, srcEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, docsEvent).matched).toBe(false);
    expect(matchWorkflowTriggers(workflow, mixedEvent).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Push triggers', () => {
  it('matches push event type', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const pushEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, pushEvent);
    expect(decision.matched).toBe(true);
    expect(decision.matchedTrigger).toBe(0);
  });

  it('rejects non-push events for push trigger', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const prEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, prEvent);
    expect(decision.matched).toBe(false);
  });

  it('matches branch patterns for push', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [
            { type: 'glob', pattern: 'main' },
            { type: 'glob', pattern: 'release-*' },
          ],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const mainEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const releaseEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'release-1.0',
    };

    const featureEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'feature/test',
    };

    expect(matchWorkflowTriggers(workflow, mainEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, releaseEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, featureEvent).matched).toBe(false);
  });

  it('matches path filters for push', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: ['src/**/*.ts'],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const tsEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['src/app.ts'],
    };

    const jsEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['src/app.js'],
    };

    expect(matchWorkflowTriggers(workflow, tsEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, jsEvent).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Multiple triggers', () => {
  it('matches first trigger that passes (short-circuit)', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
        {
          _type: 'push',
          branches: [],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const prEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
    };

    const pushEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const prDecision = matchWorkflowTriggers(workflow, prEvent);
    expect(prDecision.matched).toBe(true);
    expect(prDecision.matchedTrigger).toBe(0);

    const pushDecision = matchWorkflowTriggers(workflow, pushEvent);
    expect(pushDecision.matched).toBe(true);
    expect(pushDecision.matchedTrigger).toBe(1);
  });

  it('returns no match if no triggers match', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [{ type: 'glob', pattern: 'develop' }],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main', // Doesn't match 'develop'
    };

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(false);
    expect(decision.matchedTrigger).toBeUndefined();
    expect(decision.summary).toBe('No triggers matched');
  });

  it('returns no match for workflow with no triggers', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(false);
    expect(decision.summary).toBe('No triggers defined');
  });
});

describe('matchWorkflowTriggers - Decision traces', () => {
  it('records all checks in trace', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: ['opened'],
          targetBranches: [{ type: 'glob', pattern: 'main' }],
          sourceBranches: [{ type: 'glob', pattern: 'feature/*' }],
          paths: ['src/**', '!**/*.md'],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
      sourceBranch: 'feature/test',
      changedFiles: ['src/app.ts'],
    };

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(true);
    expect(decision.checks.length).toBeGreaterThan(0);

    // Verify specific checks were recorded
    const checkTypes = decision.checks.map((c) => c.check);
    expect(checkTypes).toContain('event type');
    expect(checkTypes).toContain('action');
    expect(checkTypes).toContain('target branch');
    expect(checkTypes).toContain('source branch');
    expect(checkTypes).toContain('paths');
  });

  it('records failed checks', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [{ type: 'glob', pattern: 'main' }],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'develop', // Doesn't match 'main'
    };

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(false);

    const branchCheck = decision.checks.find((c) => c.check === 'branch');
    expect(branchCheck).toBeDefined();
    expect(branchCheck?.passed).toBe(false);
    expect(branchCheck?.value).toBe('develop');
  });

  it('includes correct matchedTrigger index', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: [],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
        } as LockPrTrigger,
        {
          _type: 'push',
          branches: [],
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const pushEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const decision = matchWorkflowTriggers(workflow, pushEvent);
    expect(decision.matched).toBe(true);
    // PR trigger is index 0, push trigger is index 1
    expect(decision.matchedTrigger).toBe(1);
  });
});

describe('matchAllWorkflows', () => {
  it('matches multiple workflows against event', () => {
    const workflows: LockWorkflow[] = [
      {
        name: 'ci',
        contentHash: '',
        compileSchemaVersion: 0,
        triggers: [
          {
            _type: 'pr',
            events: [],
            targetBranches: [],
            sourceBranches: [],
            paths: [],
          } as LockPrTrigger,
        ],
        jobs: [],
      },
      {
        name: 'deploy',
        contentHash: '',
        compileSchemaVersion: 0,
        triggers: [
          {
            _type: 'push',
            branches: [{ type: 'glob', pattern: 'main' }],
            paths: [],
          } as LockPushTrigger,
        ],
        jobs: [],
      },
    ];

    const prEvent: SimulatedEvent = {
      type: 'pull_request',
      payload: {},
      targetBranch: 'main',
    };

    const decisions = matchAllWorkflows(workflows, prEvent);
    expect(decisions.length).toBe(2);
    expect(decisions[0].workflowName).toBe('ci');
    expect(decisions[0].matched).toBe(true);
    expect(decisions[1].workflowName).toBe('deploy');
    expect(decisions[1].matched).toBe(false);
  });

  it('returns empty array for no workflows', () => {
    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
    };

    const decisions = matchAllWorkflows([], event);
    expect(decisions).toEqual([]);
  });
});

// Helper to create a workflow with a single trigger for concise tests
function wf(trigger: LockWorkflow['triggers'][number]): LockWorkflow {
  return { name: 'test', contentHash: '', compileSchemaVersion: 0, triggers: [trigger], jobs: [] };
}

describe('matchWorkflowTriggers - Tag triggers', () => {
  it('matches tag event with matching pattern', () => {
    const trigger: LockTagTrigger = {
      _type: 'tag',
      patterns: [{ type: 'glob', pattern: 'v*' }],
    };
    const event: SimulatedEvent = {
      type: 'tag',
      payload: {},
      targetBranch: 'v1.0.0',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-tag events', () => {
    const trigger: LockTagTrigger = { _type: 'tag', patterns: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('empty patterns matches all tags', () => {
    const trigger: LockTagTrigger = { _type: 'tag', patterns: [] };
    const event: SimulatedEvent = {
      type: 'tag',
      payload: {},
      targetBranch: 'anything',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects tag event with non-matching pattern', () => {
    const trigger: LockTagTrigger = {
      _type: 'tag',
      patterns: [{ type: 'glob', pattern: 'v*' }],
    };
    const event: SimulatedEvent = {
      type: 'tag',
      payload: {},
      targetBranch: 'release-1.0',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Comment triggers', () => {
  it('matches comment event', () => {
    const trigger: LockCommentTrigger = { _type: 'comment', actions: [] };
    const event: SimulatedEvent = {
      type: 'comment',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-comment events', () => {
    const trigger: LockCommentTrigger = { _type: 'comment', actions: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockCommentTrigger = { _type: 'comment', actions: ['created'] };
    const created: SimulatedEvent = {
      type: 'comment',
      action: 'created',
      payload: {},
      targetBranch: '',
    };
    const deleted: SimulatedEvent = {
      type: 'comment',
      action: 'deleted',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), created).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), deleted).matched).toBe(false);
  });

  it('filters by source: issue (no pull_request on payload.issue)', () => {
    const trigger: LockCommentTrigger = { _type: 'comment', actions: [], source: 'issue' };
    // Issue comment: no pull_request field on issue
    const issueComment: SimulatedEvent = {
      type: 'comment',
      payload: { issue: { id: 1 } },
      targetBranch: '',
    };
    // PR comment: issue has pull_request field
    const prComment: SimulatedEvent = {
      type: 'comment',
      payload: { issue: { id: 2, pull_request: { url: '...' } } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), issueComment).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), prComment).matched).toBe(false);
  });

  it('filters by source: pr (has pull_request on payload.issue)', () => {
    const trigger: LockCommentTrigger = { _type: 'comment', actions: [], source: 'pr' };
    const issueComment: SimulatedEvent = {
      type: 'comment',
      payload: { issue: { id: 1 } },
      targetBranch: '',
    };
    const prComment: SimulatedEvent = {
      type: 'comment',
      payload: { issue: { id: 2, pull_request: { url: '...' } } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), issueComment).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), prComment).matched).toBe(true);
  });

  it('matches bodyMatch glob pattern', () => {
    const trigger: LockCommentTrigger = {
      _type: 'comment',
      actions: [],
      bodyMatch: { pattern: '/deploy*', type: 'glob' },
    };
    const match: SimulatedEvent = {
      type: 'comment',
      payload: { comment: { body: '/deploy production' } },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'comment',
      payload: { comment: { body: 'just a comment' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('matches bodyMatch regex pattern', () => {
    const trigger: LockCommentTrigger = {
      _type: 'comment',
      actions: [],
      bodyMatch: { pattern: '^/deploy\\s+\\w+$', type: 'regex' },
    };
    const match: SimulatedEvent = {
      type: 'comment',
      payload: { comment: { body: '/deploy staging' } },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'comment',
      payload: { comment: { body: 'hello world' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Review triggers', () => {
  it('matches review event', () => {
    const trigger: LockReviewTrigger = { _type: 'review', actions: [], states: [] };
    const event: SimulatedEvent = {
      type: 'review',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-review events', () => {
    const trigger: LockReviewTrigger = { _type: 'review', actions: [], states: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockReviewTrigger = { _type: 'review', actions: ['submitted'], states: [] };
    const submitted: SimulatedEvent = {
      type: 'review',
      action: 'submitted',
      payload: {},
      targetBranch: '',
    };
    const dismissed: SimulatedEvent = {
      type: 'review',
      action: 'dismissed',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), submitted).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), dismissed).matched).toBe(false);
  });

  it('filters by state', () => {
    const trigger: LockReviewTrigger = {
      _type: 'review',
      actions: [],
      states: ['approved'],
    };
    const approved: SimulatedEvent = {
      type: 'review',
      payload: { review: { state: 'approved' } },
      targetBranch: '',
    };
    const changes: SimulatedEvent = {
      type: 'review',
      payload: { review: { state: 'changes_requested' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), approved).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), changes).matched).toBe(false);
  });

  it('empty actions and states match all', () => {
    const trigger: LockReviewTrigger = { _type: 'review', actions: [], states: [] };
    const event: SimulatedEvent = {
      type: 'review',
      action: 'submitted',
      payload: { review: { state: 'approved' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });
});

describe('matchWorkflowTriggers - Review comment triggers', () => {
  it('matches review_comment event', () => {
    const trigger: LockReviewCommentTrigger = { _type: 'review_comment', actions: [] };
    const event: SimulatedEvent = {
      type: 'review_comment',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-review_comment events', () => {
    const trigger: LockReviewCommentTrigger = { _type: 'review_comment', actions: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockReviewCommentTrigger = { _type: 'review_comment', actions: ['created'] };
    const created: SimulatedEvent = {
      type: 'review_comment',
      action: 'created',
      payload: {},
      targetBranch: '',
    };
    const edited: SimulatedEvent = {
      type: 'review_comment',
      action: 'edited',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), created).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), edited).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Release triggers', () => {
  it('matches release event', () => {
    const trigger: LockReleaseTrigger = { _type: 'release', actions: [] };
    const event: SimulatedEvent = {
      type: 'release',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-release events', () => {
    const trigger: LockReleaseTrigger = { _type: 'release', actions: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockReleaseTrigger = { _type: 'release', actions: ['published'] };
    const published: SimulatedEvent = {
      type: 'release',
      action: 'published',
      payload: {},
      targetBranch: '',
    };
    const unpublished: SimulatedEvent = {
      type: 'release',
      action: 'unpublished',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), published).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), unpublished).matched).toBe(false);
  });

  it('empty actions matches all', () => {
    const trigger: LockReleaseTrigger = { _type: 'release', actions: [] };
    const event: SimulatedEvent = {
      type: 'release',
      action: 'created',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });
});

describe('matchWorkflowTriggers - Dispatch triggers', () => {
  it('matches dispatch event', () => {
    const trigger: LockDispatchTrigger = { _type: 'dispatch', types: [] };
    const event: SimulatedEvent = {
      type: 'dispatch',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-dispatch events', () => {
    const trigger: LockDispatchTrigger = { _type: 'dispatch', types: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by event types (matches against event.action)', () => {
    const trigger: LockDispatchTrigger = { _type: 'dispatch', types: ['deploy', 'rollback'] };
    const deploy: SimulatedEvent = {
      type: 'dispatch',
      action: 'deploy',
      payload: {},
      targetBranch: '',
    };
    const test: SimulatedEvent = {
      type: 'dispatch',
      action: 'test',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), deploy).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), test).matched).toBe(false);
  });

  it('empty types matches all', () => {
    const trigger: LockDispatchTrigger = { _type: 'dispatch', types: [] };
    const event: SimulatedEvent = {
      type: 'dispatch',
      action: 'anything',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });
});

describe('matchWorkflowTriggers - Create triggers', () => {
  it('matches create event', () => {
    const trigger: LockCreateTrigger = { _type: 'create', refTypes: [], patterns: [] };
    const event: SimulatedEvent = {
      type: 'create',
      payload: { ref_type: 'branch', ref: 'feature/new' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-create events', () => {
    const trigger: LockCreateTrigger = { _type: 'create', refTypes: [], patterns: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by refType', () => {
    const trigger: LockCreateTrigger = { _type: 'create', refTypes: ['tag'], patterns: [] };
    const tagEvent: SimulatedEvent = {
      type: 'create',
      payload: { ref_type: 'tag', ref: 'v1.0' },
      targetBranch: '',
    };
    const branchEvent: SimulatedEvent = {
      type: 'create',
      payload: { ref_type: 'branch', ref: 'feature/new' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), tagEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), branchEvent).matched).toBe(false);
  });

  it('filters by ref pattern', () => {
    const trigger: LockCreateTrigger = {
      _type: 'create',
      refTypes: [],
      patterns: [{ type: 'glob', pattern: 'feature/*' }],
    };
    const match: SimulatedEvent = {
      type: 'create',
      payload: { ref_type: 'branch', ref: 'feature/new' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'create',
      payload: { ref_type: 'branch', ref: 'bugfix/old' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Delete triggers', () => {
  it('matches delete event', () => {
    const trigger: LockDeleteTrigger = { _type: 'delete', refTypes: [], patterns: [] };
    const event: SimulatedEvent = {
      type: 'delete',
      payload: { ref_type: 'branch', ref: 'feature/old' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-delete events', () => {
    const trigger: LockDeleteTrigger = { _type: 'delete', refTypes: [], patterns: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by refType', () => {
    const trigger: LockDeleteTrigger = { _type: 'delete', refTypes: ['branch'], patterns: [] };
    const branchEvent: SimulatedEvent = {
      type: 'delete',
      payload: { ref_type: 'branch', ref: 'feature/old' },
      targetBranch: '',
    };
    const tagEvent: SimulatedEvent = {
      type: 'delete',
      payload: { ref_type: 'tag', ref: 'v0.9' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), branchEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), tagEvent).matched).toBe(false);
  });

  it('filters by ref pattern', () => {
    const trigger: LockDeleteTrigger = {
      _type: 'delete',
      refTypes: [],
      patterns: [{ type: 'glob', pattern: 'release-*' }],
    };
    const match: SimulatedEvent = {
      type: 'delete',
      payload: { ref_type: 'branch', ref: 'release-1.0' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'delete',
      payload: { ref_type: 'branch', ref: 'feature/new' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Status triggers', () => {
  it('matches status event', () => {
    const trigger: LockStatusTrigger = { _type: 'status', contexts: [], states: [] };
    const event: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-status events', () => {
    const trigger: LockStatusTrigger = { _type: 'status', contexts: [], states: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by context via picomatch', () => {
    const trigger: LockStatusTrigger = {
      _type: 'status',
      contexts: ['ci/*'],
      states: [],
    };
    const match: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'success' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'status',
      payload: { context: 'deploy/staging', state: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('filters by state', () => {
    const trigger: LockStatusTrigger = {
      _type: 'status',
      contexts: [],
      states: ['success'],
    };
    const success: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'success' },
      targetBranch: '',
    };
    const failure: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'failure' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), success).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), failure).matched).toBe(false);
  });

  it('filters by context AND state together', () => {
    const trigger: LockStatusTrigger = {
      _type: 'status',
      contexts: ['ci/*'],
      states: ['success'],
    };
    const match: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'success' },
      targetBranch: '',
    };
    const wrongState: SimulatedEvent = {
      type: 'status',
      payload: { context: 'ci/test', state: 'failure' },
      targetBranch: '',
    };
    const wrongContext: SimulatedEvent = {
      type: 'status',
      payload: { context: 'deploy/staging', state: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), wrongState).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), wrongContext).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Workflow run triggers', () => {
  it('matches workflow_run event', () => {
    const trigger: LockWorkflowRunTrigger = {
      _type: 'workflow_run',
      actions: [],
      workflows: [],
      conclusions: [],
    };
    const event: SimulatedEvent = {
      type: 'workflow_run',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-workflow_run events', () => {
    const trigger: LockWorkflowRunTrigger = {
      _type: 'workflow_run',
      actions: [],
      workflows: [],
      conclusions: [],
    };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockWorkflowRunTrigger = {
      _type: 'workflow_run',
      actions: ['completed'],
      workflows: [],
      conclusions: [],
    };
    const completed: SimulatedEvent = {
      type: 'workflow_run',
      action: 'completed',
      payload: {},
      targetBranch: '',
    };
    const requested: SimulatedEvent = {
      type: 'workflow_run',
      action: 'requested',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), completed).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), requested).matched).toBe(false);
  });

  it('filters by workflow name', () => {
    const trigger: LockWorkflowRunTrigger = {
      _type: 'workflow_run',
      actions: [],
      workflows: ['CI', 'Build'],
      conclusions: [],
    };
    const match: SimulatedEvent = {
      type: 'workflow_run',
      payload: { workflow_run: { name: 'CI', conclusion: 'success' } },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'workflow_run',
      payload: { workflow_run: { name: 'Deploy', conclusion: 'success' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('filters by conclusion', () => {
    const trigger: LockWorkflowRunTrigger = {
      _type: 'workflow_run',
      actions: [],
      workflows: [],
      conclusions: ['success'],
    };
    const success: SimulatedEvent = {
      type: 'workflow_run',
      payload: { workflow_run: { name: 'CI', conclusion: 'success' } },
      targetBranch: '',
    };
    const failure: SimulatedEvent = {
      type: 'workflow_run',
      payload: { workflow_run: { name: 'CI', conclusion: 'failure' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), success).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), failure).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Fork triggers', () => {
  it('matches fork event unconditionally', () => {
    const trigger: LockForkTrigger = { _type: 'fork' };
    const event: SimulatedEvent = {
      type: 'fork',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-fork events', () => {
    const trigger: LockForkTrigger = { _type: 'fork' };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Star triggers', () => {
  it('matches star event', () => {
    const trigger: LockStarTrigger = { _type: 'star', actions: [] };
    const event: SimulatedEvent = {
      type: 'star',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-star events', () => {
    const trigger: LockStarTrigger = { _type: 'star', actions: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockStarTrigger = { _type: 'star', actions: ['created'] };
    const created: SimulatedEvent = {
      type: 'star',
      action: 'created',
      payload: {},
      targetBranch: '',
    };
    const deleted: SimulatedEvent = {
      type: 'star',
      action: 'deleted',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), created).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), deleted).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Watch triggers', () => {
  it('matches watch event', () => {
    const trigger: LockWatchTrigger = { _type: 'watch', actions: [] };
    const event: SimulatedEvent = {
      type: 'watch',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-watch events', () => {
    const trigger: LockWatchTrigger = { _type: 'watch', actions: [] };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by action', () => {
    const trigger: LockWatchTrigger = { _type: 'watch', actions: ['started'] };
    const started: SimulatedEvent = {
      type: 'watch',
      action: 'started',
      payload: {},
      targetBranch: '',
    };
    const other: SimulatedEvent = {
      type: 'watch',
      action: 'stopped',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), started).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), other).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Webhook triggers', () => {
  it('matches any event in events array', () => {
    const trigger: LockWebhookTrigger = {
      _type: 'webhook',
      events: ['deployment', 'deployment_status'],
      actions: [],
    };
    const deployment: SimulatedEvent = {
      type: 'deployment',
      payload: {},
      targetBranch: '',
    };
    const deploymentStatus: SimulatedEvent = {
      type: 'deployment_status',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), deployment).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), deploymentStatus).matched).toBe(true);
  });

  it('rejects events not in events array', () => {
    const trigger: LockWebhookTrigger = {
      _type: 'webhook',
      events: ['deployment'],
      actions: [],
    };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('optionally filters by action', () => {
    const trigger: LockWebhookTrigger = {
      _type: 'webhook',
      events: ['deployment'],
      actions: ['created'],
    };
    const created: SimulatedEvent = {
      type: 'deployment',
      action: 'created',
      payload: {},
      targetBranch: '',
    };
    const deleted: SimulatedEvent = {
      type: 'deployment',
      action: 'deleted',
      payload: {},
      targetBranch: '',
    };
    const noAction: SimulatedEvent = {
      type: 'deployment',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), created).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), deleted).matched).toBe(false);
    // No action on event but trigger has action filter -- should not match
    expect(matchWorkflowTriggers(wf(trigger), noAction).matched).toBe(false);
  });

  it('empty actions matches all actions', () => {
    const trigger: LockWebhookTrigger = {
      _type: 'webhook',
      events: ['deployment'],
      actions: [],
    };
    const withAction: SimulatedEvent = {
      type: 'deployment',
      action: 'anything',
      payload: {},
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), withAction).matched).toBe(true);
  });
});

describe('matchWorkflowTriggers - KiCI event triggers', () => {
  it('matches kici_event by event name', () => {
    const trigger: LockKiciEventTrigger = { _type: 'kici_event', eventName: 'deploy-complete' };
    const event: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: {} },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects kici_event with wrong name', () => {
    const trigger: LockKiciEventTrigger = { _type: 'kici_event', eventName: 'deploy-complete' };
    const event: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'build-started', payload: {} },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('rejects non-kici_event types', () => {
    const trigger: LockKiciEventTrigger = { _type: 'kici_event', eventName: 'deploy-complete' };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('matches kici_event with JSONPath match filter', () => {
    const trigger: LockKiciEventTrigger = {
      _type: 'kici_event',
      eventName: 'deploy-complete',
      match: { '$.env': 'prod' },
    };
    const match: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: { env: 'prod' } },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: { env: 'staging' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('matches kici_event with JSONPath not filter', () => {
    const trigger: LockKiciEventTrigger = {
      _type: 'kici_event',
      eventName: 'deploy-complete',
      not: { '$.env': 'staging' },
    };
    const pass: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: { env: 'prod' } },
      targetBranch: '',
    };
    const fail: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: { env: 'staging' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), pass).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), fail).matched).toBe(false);
  });

  it('matches kici_event with source filter', () => {
    const trigger: LockKiciEventTrigger = {
      _type: 'kici_event',
      eventName: 'deploy-complete',
      source: 'org/repo-a',
    };
    const match: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: {}, sourceRepo: 'org/repo-a' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy-complete', payload: {}, sourceRepo: 'org/repo-b' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('matches kici_event with combined match and not', () => {
    const trigger: LockKiciEventTrigger = {
      _type: 'kici_event',
      eventName: 'deploy',
      match: { '$.status': 'deployed' },
      not: { '$.env': 'dev' },
    };
    const pass: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy', payload: { status: 'deployed', env: 'prod' } },
      targetBranch: '',
    };
    const failNotFilter: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy', payload: { status: 'deployed', env: 'dev' } },
      targetBranch: '',
    };
    const failMatchFilter: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName: 'deploy', payload: { status: 'pending', env: 'prod' } },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), pass).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), failNotFilter).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), failMatchFilter).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Workflow complete triggers', () => {
  it('matches workflow_complete event', () => {
    const trigger: LockWorkflowCompleteTrigger = { _type: 'workflow_complete' };
    const event: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-workflow_complete events', () => {
    const trigger: LockWorkflowCompleteTrigger = { _type: 'workflow_complete' };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by workflow name', () => {
    const trigger: LockWorkflowCompleteTrigger = { _type: 'workflow_complete', name: 'CI' };
    const match: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'Deploy', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('filters by status', () => {
    const trigger: LockWorkflowCompleteTrigger = {
      _type: 'workflow_complete',
      status: ['success'],
    };
    const success: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success' },
      targetBranch: '',
    };
    const failed: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'failed' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), success).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), failed).matched).toBe(false);
  });

  it('filters by source', () => {
    const trigger: LockWorkflowCompleteTrigger = {
      _type: 'workflow_complete',
      source: 'org/backend',
    };
    const match: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success', sourceRepo: 'org/backend' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success', sourceRepo: 'org/frontend' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('combines name and status filters', () => {
    const trigger: LockWorkflowCompleteTrigger = {
      _type: 'workflow_complete',
      name: 'CI',
      status: ['success', 'failed'],
    };
    const match: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'success' },
      targetBranch: '',
    };
    const wrongName: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'Deploy', status: 'success' },
      targetBranch: '',
    };
    const wrongStatus: SimulatedEvent = {
      type: 'workflow_complete',
      payload: { workflowName: 'CI', status: 'cancelled' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), wrongName).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), wrongStatus).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Job complete triggers', () => {
  it('matches job_complete event', () => {
    const trigger: LockJobCompleteTrigger = { _type: 'job_complete' };
    const event: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects non-job_complete events', () => {
    const trigger: LockJobCompleteTrigger = { _type: 'job_complete' };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by workflow name', () => {
    const trigger: LockJobCompleteTrigger = { _type: 'job_complete', workflow: 'CI' };
    const match: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'Deploy', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('filters by job name', () => {
    const trigger: LockJobCompleteTrigger = { _type: 'job_complete', job: 'build' };
    const match: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'test', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('filters by status', () => {
    const trigger: LockJobCompleteTrigger = {
      _type: 'job_complete',
      status: ['success', 'failed'],
    };
    const success: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    const skipped: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'skipped' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), success).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), skipped).matched).toBe(false);
  });

  it('filters by source', () => {
    const trigger: LockJobCompleteTrigger = {
      _type: 'job_complete',
      source: 'org/backend',
    };
    const match: SimulatedEvent = {
      type: 'job_complete',
      payload: {
        workflowName: 'CI',
        jobName: 'build',
        status: 'success',
        sourceRepo: 'org/backend',
      },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'job_complete',
      payload: {
        workflowName: 'CI',
        jobName: 'build',
        status: 'success',
        sourceRepo: 'org/frontend',
      },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('combines workflow, job, and status filters', () => {
    const trigger: LockJobCompleteTrigger = {
      _type: 'job_complete',
      workflow: 'CI',
      job: 'build',
      status: ['success'],
    };
    const match: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'build', status: 'success' },
      targetBranch: '',
    };
    const wrongJob: SimulatedEvent = {
      type: 'job_complete',
      payload: { workflowName: 'CI', jobName: 'test', status: 'success' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), wrongJob).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Generic webhook triggers', () => {
  it('matches generic_webhook by source', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
    };
    const event: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects generic_webhook with wrong source', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
    };
    const event: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'other-service' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('rejects non-generic_webhook events', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
    };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by events array', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
      events: ['deploy', 'rollback'],
    };
    const deploy: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'deploy' },
      targetBranch: '',
    };
    const test: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'test' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), deploy).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), test).matched).toBe(false);
  });

  it('falls back to event.action for event type when no eventType in payload', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
      events: ['deploy'],
    };
    const event: SimulatedEvent = {
      type: 'generic_webhook',
      action: 'deploy',
      payload: { source: 'my-service' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('matches generic_webhook with JSONPath match filter', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
      match: { '$.env': 'prod' },
    };
    const match: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', env: 'prod' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', env: 'staging' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('matches generic_webhook with JSONPath not filter', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
      not: { '$.env': 'dev' },
    };
    const pass: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', env: 'prod' },
      targetBranch: '',
    };
    const fail: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', env: 'dev' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), pass).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), fail).matched).toBe(false);
  });

  it('combines source, events, match, and not filters', () => {
    const trigger: LockGenericWebhookTrigger = {
      _type: 'generic_webhook',
      source: 'my-service',
      events: ['deploy'],
      match: { '$.status': 'completed' },
      not: { '$.env': 'dev' },
    };
    const pass: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'deploy', status: 'completed', env: 'prod' },
      targetBranch: '',
    };
    const failSource: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'other', eventType: 'deploy', status: 'completed', env: 'prod' },
      targetBranch: '',
    };
    const failEvent: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'test', status: 'completed', env: 'prod' },
      targetBranch: '',
    };
    const failMatch: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'deploy', status: 'pending', env: 'prod' },
      targetBranch: '',
    };
    const failNot: SimulatedEvent = {
      type: 'generic_webhook',
      payload: { source: 'my-service', eventType: 'deploy', status: 'completed', env: 'dev' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), pass).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), failSource).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), failEvent).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), failMatch).matched).toBe(false);
    expect(matchWorkflowTriggers(wf(trigger), failNot).matched).toBe(false);
  });
});

describe('matchWorkflowTriggers - Edge cases', () => {
  it('empty branch patterns match all branches', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [], // Empty = match all
          paths: [],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'any-branch-name',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(true);
  });

  it('empty path patterns match all files', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: [], // Empty = match all
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      changedFiles: ['anything/at/all.txt'],
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(true);
  });

  it('no changed files with path filter results in no match', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: ['src/**'],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      // No changedFiles provided
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(false);
  });

  it('regex pattern with special characters', () => {
    const pattern: LockBranchPattern = {
      type: 'regex',
      pattern: '^release-\\d+$',
    };
    expect(matchBranchPattern(pattern, 'release-42')).toBe(true);
    expect(matchBranchPattern(pattern, 'release-')).toBe(false);
    expect(matchBranchPattern(pattern, 'release-abc')).toBe(false);
  });
});

describe('matchWorkflowTriggers - Schedule triggers', () => {
  it('matches schedule event with correct cron expression', () => {
    const trigger: LockScheduleTrigger = {
      _type: 'schedule',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };
    const event: SimulatedEvent = {
      type: 'schedule',
      payload: { cronExpression: '0 * * * *' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects schedule event with wrong cron expression', () => {
    const trigger: LockScheduleTrigger = {
      _type: 'schedule',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };
    const event: SimulatedEvent = {
      type: 'schedule',
      payload: { cronExpression: '0 0 * * *' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('rejects non-schedule events', () => {
    const trigger: LockScheduleTrigger = {
      _type: 'schedule',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('includes description in trigger config', () => {
    const trigger: LockScheduleTrigger = {
      _type: 'schedule',
      cronExpression: '0 0 * * *',
      timezone: 'America/New_York',
      description: 'Nightly build',
    };
    const event: SimulatedEvent = {
      type: 'schedule',
      payload: { cronExpression: '0 0 * * *' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });
});

describe('matchWorkflowTriggers - Lifecycle triggers', () => {
  it('matches lifecycle event with correct event type', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete'],
    };
    const event: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'workflow_complete' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('matches lifecycle event from events array', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete', 'job_failed'],
    };
    const event: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'job_failed' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('rejects lifecycle event with wrong event type', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete'],
    };
    const event: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'job_failed' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('rejects non-lifecycle events', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete'],
    };
    const event: SimulatedEvent = { type: 'push', payload: {}, targetBranch: 'main' };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(false);
  });

  it('filters by source when sources specified', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['job_complete'],
      sources: ['org/deploy-repo'],
    };
    const match: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'job_complete', sourceRepo: 'org/deploy-repo' },
      targetBranch: '',
    };
    const noMatch: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'job_complete', sourceRepo: 'org/other-repo' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), match).matched).toBe(true);
    expect(matchWorkflowTriggers(wf(trigger), noMatch).matched).toBe(false);
  });

  it('matches all sources when no sources filter', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete'],
    };
    const event: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'workflow_complete', sourceRepo: 'org/any-repo' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });

  it('matches all sources when sources array is empty', () => {
    const trigger: LockLifecycleTrigger = {
      _type: 'lifecycle',
      events: ['workflow_complete'],
      sources: [],
    };
    const event: SimulatedEvent = {
      type: 'lifecycle',
      payload: { lifecycleEvent: 'workflow_complete', sourceRepo: 'org/any-repo' },
      targetBranch: '',
    };
    expect(matchWorkflowTriggers(wf(trigger), event).matched).toBe(true);
  });
});

describe('matchRepoPatterns', () => {
  it('returns true when repos array is empty (no filter = match all)', () => {
    expect(matchRepoPatterns([], 'org/repo')).toBe(true);
  });

  it('matches glob pattern in repos', () => {
    expect(matchRepoPatterns([{ type: 'glob', pattern: 'myorg/*' }], 'myorg/api')).toBe(true);
  });

  it('rejects when glob pattern does not match', () => {
    expect(matchRepoPatterns([{ type: 'glob', pattern: 'myorg/*' }], 'other/repo')).toBe(false);
  });

  it('excludes repos matching !-prefixed patterns', () => {
    expect(
      matchRepoPatterns([{ type: 'glob', pattern: '!myorg/internal-*' }], 'myorg/internal-tools'),
    ).toBe(false);
  });

  it('!-prefixed exclusions take precedence over includes', () => {
    expect(
      matchRepoPatterns(
        [
          { type: 'glob', pattern: 'myorg/*' },
          { type: 'glob', pattern: '!myorg/secret-*' },
        ],
        'myorg/secret-repo',
      ),
    ).toBe(false);
  });

  it('matches when repos include and exclusion does not exclude', () => {
    expect(
      matchRepoPatterns(
        [
          { type: 'glob', pattern: 'myorg/*' },
          { type: 'glob', pattern: '!myorg/secret-*' },
        ],
        'myorg/api',
      ),
    ).toBe(true);
  });

  it('matches regex pattern in repos', () => {
    expect(
      matchRepoPatterns([{ type: 'regex', pattern: '^myorg/api-v\\d+$' }], 'myorg/api-v2'),
    ).toBe(true);
  });

  it('rejects when regex pattern does not match', () => {
    expect(matchRepoPatterns([{ type: 'regex', pattern: '^myorg/api-v\\d+$' }], 'myorg/web')).toBe(
      false,
    );
  });

  it('all-negation array with non-excluded repo matches (implicit match-all)', () => {
    expect(
      matchRepoPatterns([{ type: 'glob', pattern: '!myorg/secret-*' }], 'myorg/public-repo'),
    ).toBe(true);
  });

  it('all-negation array with excluded repo returns false', () => {
    expect(
      matchRepoPatterns([{ type: 'glob', pattern: '!myorg/secret-*' }], 'myorg/secret-repo'),
    ).toBe(false);
  });
});

describe('matchWorkflowTriggers - repo pattern filtering', () => {
  it('push trigger with repos matches only when sourceRepo matches and branch matches', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [{ type: 'glob', pattern: 'main' }],
          paths: [],
          repos: [{ type: 'glob', pattern: 'myorg/*' }],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const matchingEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      sourceRepo: 'myorg/api',
    };

    const nonMatchingRepoEvent: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      sourceRepo: 'other/repo',
    };

    expect(matchWorkflowTriggers(workflow, matchingEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, nonMatchingRepoEvent).matched).toBe(false);
  });

  it('push trigger with repos returns false when sourceRepo is missing from event', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: [],
          repos: [{ type: 'glob', pattern: 'myorg/*' }],
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      // sourceRepo intentionally omitted
    };

    const decision = matchWorkflowTriggers(workflow, event);
    expect(decision.matched).toBe(false);
    const repoCheck = decision.checks.find((c) => c.check === 'repo');
    expect(repoCheck).toBeDefined();
    expect(repoCheck?.passed).toBe(false);
    expect(repoCheck?.value).toBe('(missing)');
  });

  it('PR trigger with repos and !-prefixed exclusions evaluates repo patterns', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'pr',
          events: ['opened'],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
          repos: [
            { type: 'glob', pattern: 'myorg/*' },
            { type: 'glob', pattern: '!myorg/secret-*' },
          ],
        } as LockPrTrigger,
      ],
      jobs: [],
    };

    const matchingEvent: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
      sourceRepo: 'myorg/api',
    };

    const excludedEvent: SimulatedEvent = {
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
      sourceRepo: 'myorg/secret-keys',
    };

    expect(matchWorkflowTriggers(workflow, matchingEvent).matched).toBe(true);
    expect(matchWorkflowTriggers(workflow, excludedEvent).matched).toBe(false);
  });

  it('push trigger without repos field matches all repos', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'push',
          branches: [{ type: 'glob', pattern: 'main' }],
          paths: [],
          // no repos
        } as LockPushTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'push',
      payload: {},
      targetBranch: 'main',
      sourceRepo: 'any/repo',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(true);
  });
});

describe('action filter with missing event.action', () => {
  it('rejects comment event without action when trigger requires actions', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'comment',
          actions: ['created'],
          repos: undefined,
        } as unknown as LockCommentTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'comment',
      payload: {},
      targetBranch: '',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(false);
  });

  it('rejects release event without action when trigger requires actions', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'release',
          actions: ['published'],
        } as LockReleaseTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'release',
      payload: {},
      targetBranch: '',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(false);
  });

  it('rejects dispatch event without action when trigger requires types', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'dispatch',
          types: ['deploy'],
        } as LockDispatchTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'dispatch',
      payload: {},
      targetBranch: '',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(false);
  });

  it('still matches when trigger has empty actions array (match all)', () => {
    const workflow: LockWorkflow = {
      name: 'test',
      contentHash: '',
      compileSchemaVersion: 0,
      triggers: [
        {
          _type: 'release',
          actions: [],
        } as LockReleaseTrigger,
      ],
      jobs: [],
    };

    const event: SimulatedEvent = {
      type: 'release',
      payload: {},
      targetBranch: '',
    };

    expect(matchWorkflowTriggers(workflow, event).matched).toBe(true);
  });
});
