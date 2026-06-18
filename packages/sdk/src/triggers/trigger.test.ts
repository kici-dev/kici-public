import { describe, it, expect } from 'vitest';
import {
  pr,
  push,
  toBranchPattern,
  DEFAULT_PR_EVENTS,
  tag,
  comment,
  review,
  reviewComment,
  release,
  dispatch,
  create,
  delete as del,
  status,
  workflowRun,
  fork,
  star,
  watch,
  webhook,
} from './index.js';

describe('toBranchPattern', () => {
  it('converts string to glob pattern', () => {
    const pattern = toBranchPattern('main');
    expect(pattern).toEqual({ type: 'glob', pattern: 'main' });
  });

  it('converts glob string to glob pattern', () => {
    const pattern = toBranchPattern('release/*');
    expect(pattern).toEqual({ type: 'glob', pattern: 'release/*' });
  });

  it('converts RegExp to regex pattern', () => {
    const pattern = toBranchPattern(/^release-\d+$/);
    expect(pattern).toEqual({ type: 'regex', pattern: '^release-\\d+$', flags: undefined });
  });

  it('converts RegExp with flags to regex pattern', () => {
    const pattern = toBranchPattern(/^feature-.+$/i);
    expect(pattern).toEqual({ type: 'regex', pattern: '^feature-.+$', flags: 'i' });
  });
});

describe('pr()', () => {
  it('creates config with default events', () => {
    const trigger = pr();
    expect(trigger._tag).toBe('PrTrigger');
    expect(trigger.events).toEqual(DEFAULT_PR_EVENTS);
  });

  it('creates config with empty target/source/paths by default', () => {
    const trigger = pr();
    expect(trigger.targetBranches).toEqual([]);
    expect(trigger.sourceBranches).toEqual([]);
    expect(trigger.paths).toEqual([]);
  });

  it('config with single target string', () => {
    const trigger = pr({ target: 'main' });
    expect(trigger.targetBranches).toEqual([{ type: 'glob', pattern: 'main' }]);
  });

  it('config with array target', () => {
    const trigger = pr({ target: ['main', 'develop'] });
    expect(trigger.targetBranches).toEqual([
      { type: 'glob', pattern: 'main' },
      { type: 'glob', pattern: 'develop' },
    ]);
  });

  it('config with mixed target types (string and regex)', () => {
    const trigger = pr({ target: ['main', /^release-\d+$/] });
    expect(trigger.targetBranches).toEqual([
      { type: 'glob', pattern: 'main' },
      { type: 'regex', pattern: '^release-\\d+$', flags: undefined },
    ]);
  });

  it('config with single target regex', () => {
    const trigger = pr({ target: /^release-\d+$/ });
    expect(trigger.targetBranches).toEqual([
      { type: 'regex', pattern: '^release-\\d+$', flags: undefined },
    ]);
  });

  it('config with source branches', () => {
    const trigger = pr({ source: 'feature/*' });
    expect(trigger.sourceBranches).toEqual([{ type: 'glob', pattern: 'feature/*' }]);
  });

  it('config with paths', () => {
    const trigger = pr({ paths: ['src/**'] });
    expect(trigger.paths).toEqual(['src/**']);
  });

  it('config with multiple paths', () => {
    const trigger = pr({ paths: ['src/**', 'lib/**'] });
    expect(trigger.paths).toEqual(['src/**', 'lib/**']);
  });

  it('config with !-prefixed paths for exclusion', () => {
    const trigger = pr({ paths: ['src/**', '!src/generated/**'] });
    expect(trigger.paths).toEqual(['src/**', '!src/generated/**']);
  });

  it('config with custom events replaces defaults', () => {
    const trigger = pr({ events: ['opened', 'labeled'] });
    expect(trigger.events).toEqual(['opened', 'labeled']);
  });

  it('config with description', () => {
    const trigger = pr({ description: 'PRs targeting main' });
    expect(trigger.description).toBe('PRs targeting main');
  });

  it('returns frozen config', () => {
    const trigger = pr({ target: 'main' });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.events)).toBe(true);
    expect(Object.isFrozen(trigger.targetBranches)).toBe(true);
    expect(Object.isFrozen(trigger.sourceBranches)).toBe(true);
    expect(Object.isFrozen(trigger.paths)).toBe(true);
  });

  it('full config with all options', () => {
    const trigger = pr({
      events: ['opened', 'synchronize'],
      target: 'main',
      source: 'feature/*',
      paths: ['src/**', 'lib/**', '!**/*.test.ts'],
      description: 'PR from feature to main with source changes',
    });

    expect(trigger._tag).toBe('PrTrigger');
    expect(trigger.targetBranches).toHaveLength(1);
    expect(trigger.sourceBranches).toHaveLength(1);
    expect(trigger.paths).toHaveLength(3);
    expect(trigger.events).toEqual(['opened', 'synchronize']);
    expect(trigger.description).toBe('PR from feature to main with source changes');
  });
});

describe('push()', () => {
  it('creates config with empty defaults', () => {
    const trigger = push();
    expect(trigger._tag).toBe('PushTrigger');
    expect(trigger.branches).toEqual([]);
    expect(trigger.tags).toEqual([]);
    expect(trigger.paths).toEqual([]);
  });

  it('config with single branch string', () => {
    const trigger = push({ branches: 'main' });
    expect(trigger.branches).toEqual([{ type: 'glob', pattern: 'main' }]);
  });

  it('config with multiple branches', () => {
    const trigger = push({ branches: ['main', 'develop'] });
    expect(trigger.branches).toEqual([
      { type: 'glob', pattern: 'main' },
      { type: 'glob', pattern: 'develop' },
    ]);
  });

  it('config with regex branch', () => {
    const trigger = push({ branches: /^release-\d+$/ });
    expect(trigger.branches).toEqual([
      { type: 'regex', pattern: '^release-\\d+$', flags: undefined },
    ]);
  });

  it('config with tags', () => {
    const trigger = push({ tags: ['v*'] });
    expect(trigger.tags).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with multiple tags', () => {
    const trigger = push({ tags: ['v*', /^release-\d+$/] });
    expect(trigger.tags).toEqual([
      { type: 'glob', pattern: 'v*' },
      { type: 'regex', pattern: '^release-\\d+$', flags: undefined },
    ]);
  });

  it('config with single tag string', () => {
    const trigger = push({ tags: 'v*' });
    expect(trigger.tags).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with paths including !-prefixed exclusions', () => {
    const trigger = push({ paths: ['src/**', '!**/*.test.ts'] });
    expect(trigger.paths).toEqual(['src/**', '!**/*.test.ts']);
  });

  it('config with description', () => {
    const trigger = push({ description: 'Pushes to main' });
    expect(trigger.description).toBe('Pushes to main');
  });

  it('returns frozen config', () => {
    const trigger = push({ branches: 'main' });
    expect(trigger._tag).toBe('PushTrigger');
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.branches)).toBe(true);
    expect(Object.isFrozen(trigger.tags)).toBe(true);
    expect(Object.isFrozen(trigger.paths)).toBe(true);
  });

  it('full config with all options', () => {
    const trigger = push({
      branches: ['main', 'develop'],
      tags: ['v*'],
      paths: ['src/**', '!**/*.test.ts'],
      description: 'Push to main or develop with source changes',
    });

    expect(trigger._tag).toBe('PushTrigger');
    expect(trigger.branches).toHaveLength(2);
    expect(trigger.tags).toHaveLength(1);
    expect(trigger.paths).toHaveLength(2);
    expect(trigger.description).toBe('Push to main or develop with source changes');
  });
});

describe('tag()', () => {
  it('creates config with empty defaults', () => {
    const trigger = tag();
    expect(trigger._tag).toBe('TagTrigger');
    expect(trigger.patterns).toEqual([]);
  });

  it('config with string patterns', () => {
    const trigger = tag({ patterns: ['v*'] });
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with single string pattern', () => {
    const trigger = tag({ patterns: 'v*' });
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with regex pattern', () => {
    const trigger = tag({ patterns: /^v\d+\.\d+\.\d+$/ });
    expect(trigger.patterns).toEqual([
      { type: 'regex', pattern: '^v\\d+\\.\\d+\\.\\d+$', flags: undefined },
    ]);
  });

  it('config with mixed patterns', () => {
    const trigger = tag({ patterns: ['v*', /^release-\d+$/] });
    expect(trigger.patterns).toHaveLength(2);
    expect(trigger.patterns[0]).toEqual({ type: 'glob', pattern: 'v*' });
    expect(trigger.patterns[1]).toEqual({
      type: 'regex',
      pattern: '^release-\\d+$',
      flags: undefined,
    });
  });

  it('config with description', () => {
    const trigger = tag({ description: 'Version tags' });
    expect(trigger.description).toBe('Version tags');
  });

  it('returns frozen config', () => {
    const trigger = tag({ patterns: ['v*'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.patterns)).toBe(true);
  });
});

describe('comment()', () => {
  it('creates config with empty defaults', () => {
    const trigger = comment();
    expect(trigger._tag).toBe('CommentTrigger');
    expect(trigger.actions).toEqual([]);
    expect(trigger.source).toBeUndefined();
    expect(trigger.bodyMatch).toBeUndefined();
  });

  it('config with actions', () => {
    const trigger = comment({ actions: ['created', 'edited'] });
    expect(trigger.actions).toEqual(['created', 'edited']);
  });

  it('config with source', () => {
    const trigger = comment({ source: 'pr' });
    expect(trigger.source).toBe('pr');
  });

  it('config with string bodyMatch (glob)', () => {
    const trigger = comment({ bodyMatch: '/deploy' });
    expect(trigger.bodyMatch).toEqual({ type: 'glob', pattern: '/deploy' });
  });

  it('config with RegExp bodyMatch (regex)', () => {
    const trigger = comment({ bodyMatch: /^\/deploy/i });
    expect(trigger.bodyMatch).toEqual({ type: 'regex', pattern: '^\\/deploy', flags: 'i' });
  });

  it('config with all options', () => {
    const trigger = comment({
      actions: ['created'],
      source: 'issue',
      bodyMatch: '/deploy',
      description: 'Deploy commands',
    });
    expect(trigger._tag).toBe('CommentTrigger');
    expect(trigger.actions).toEqual(['created']);
    expect(trigger.source).toBe('issue');
    expect(trigger.bodyMatch).toEqual({ type: 'glob', pattern: '/deploy' });
    expect(trigger.description).toBe('Deploy commands');
  });

  it('returns frozen config', () => {
    const trigger = comment({ actions: ['created'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('review()', () => {
  it('creates config with empty defaults', () => {
    const trigger = review();
    expect(trigger._tag).toBe('ReviewTrigger');
    expect(trigger.actions).toEqual([]);
    expect(trigger.states).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = review({ actions: ['submitted', 'dismissed'] });
    expect(trigger.actions).toEqual(['submitted', 'dismissed']);
  });

  it('config with states', () => {
    const trigger = review({ states: ['approved'] });
    expect(trigger.states).toEqual(['approved']);
  });

  it('config with actions and states', () => {
    const trigger = review({ actions: ['submitted'], states: ['approved', 'changes_requested'] });
    expect(trigger.actions).toEqual(['submitted']);
    expect(trigger.states).toEqual(['approved', 'changes_requested']);
  });

  it('config with description', () => {
    const trigger = review({ description: 'Approval reviews' });
    expect(trigger.description).toBe('Approval reviews');
  });

  it('returns frozen config', () => {
    const trigger = review({ actions: ['submitted'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
    expect(Object.isFrozen(trigger.states)).toBe(true);
  });
});

describe('reviewComment()', () => {
  it('creates config with empty defaults', () => {
    const trigger = reviewComment();
    expect(trigger._tag).toBe('ReviewCommentTrigger');
    expect(trigger.actions).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = reviewComment({ actions: ['created', 'edited'] });
    expect(trigger.actions).toEqual(['created', 'edited']);
  });

  it('config with description', () => {
    const trigger = reviewComment({ description: 'Review comments' });
    expect(trigger.description).toBe('Review comments');
  });

  it('returns frozen config', () => {
    const trigger = reviewComment({ actions: ['created'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('release()', () => {
  it('creates config with empty defaults', () => {
    const trigger = release();
    expect(trigger._tag).toBe('ReleaseTrigger');
    expect(trigger.actions).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = release({ actions: ['published'] });
    expect(trigger.actions).toEqual(['published']);
  });

  it('config with multiple actions', () => {
    const trigger = release({ actions: ['published', 'prereleased', 'released'] });
    expect(trigger.actions).toEqual(['published', 'prereleased', 'released']);
  });

  it('config with description', () => {
    const trigger = release({ description: 'Production releases' });
    expect(trigger.description).toBe('Production releases');
  });

  it('returns frozen config', () => {
    const trigger = release({ actions: ['published'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('dispatch()', () => {
  it('creates config with empty defaults', () => {
    const trigger = dispatch();
    expect(trigger._tag).toBe('DispatchTrigger');
    expect(trigger.types).toEqual([]);
  });

  it('config with types', () => {
    const trigger = dispatch({ types: ['deploy'] });
    expect(trigger.types).toEqual(['deploy']);
  });

  it('config with multiple types', () => {
    const trigger = dispatch({ types: ['deploy', 'rollback'] });
    expect(trigger.types).toEqual(['deploy', 'rollback']);
  });

  it('config with description', () => {
    const trigger = dispatch({ description: 'Deployment dispatches' });
    expect(trigger.description).toBe('Deployment dispatches');
  });

  it('returns frozen config', () => {
    const trigger = dispatch({ types: ['deploy'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.types)).toBe(true);
  });
});

describe('create()', () => {
  it('creates config with empty defaults', () => {
    const trigger = create();
    expect(trigger._tag).toBe('CreateTrigger');
    expect(trigger.refTypes).toEqual([]);
    expect(trigger.patterns).toEqual([]);
  });

  it('config with refTypes', () => {
    const trigger = create({ refTypes: ['tag'] });
    expect(trigger.refTypes).toEqual(['tag']);
  });

  it('config with patterns', () => {
    const trigger = create({ patterns: ['v*'] });
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with refTypes and patterns', () => {
    const trigger = create({ refTypes: ['tag'], patterns: ['v*'] });
    expect(trigger.refTypes).toEqual(['tag']);
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with branch refType and patterns', () => {
    const trigger = create({ refTypes: ['branch'], patterns: ['release/*'] });
    expect(trigger.refTypes).toEqual(['branch']);
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'release/*' }]);
  });

  it('config with description', () => {
    const trigger = create({ description: 'Tag creation' });
    expect(trigger.description).toBe('Tag creation');
  });

  it('returns frozen config', () => {
    const trigger = create({ refTypes: ['tag'], patterns: ['v*'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.refTypes)).toBe(true);
    expect(Object.isFrozen(trigger.patterns)).toBe(true);
  });
});

describe('delete()', () => {
  it('creates config with empty defaults', () => {
    const trigger = del();
    expect(trigger._tag).toBe('DeleteTrigger');
    expect(trigger.refTypes).toEqual([]);
    expect(trigger.patterns).toEqual([]);
  });

  it('config with refTypes and patterns', () => {
    const trigger = del({ refTypes: ['tag'], patterns: ['v*'] });
    expect(trigger.refTypes).toEqual(['tag']);
    expect(trigger.patterns).toEqual([{ type: 'glob', pattern: 'v*' }]);
  });

  it('config with description', () => {
    const trigger = del({ description: 'Branch deletion' });
    expect(trigger.description).toBe('Branch deletion');
  });

  it('returns frozen config', () => {
    const trigger = del({ refTypes: ['branch'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.refTypes)).toBe(true);
    expect(Object.isFrozen(trigger.patterns)).toBe(true);
  });
});

describe('status()', () => {
  it('creates config with empty defaults', () => {
    const trigger = status();
    expect(trigger._tag).toBe('StatusTrigger');
    expect(trigger.contexts).toEqual([]);
    expect(trigger.states).toEqual([]);
  });

  it('config with contexts', () => {
    const trigger = status({ contexts: ['ci/*'] });
    expect(trigger.contexts).toEqual(['ci/*']);
  });

  it('config with states', () => {
    const trigger = status({ states: ['success'] });
    expect(trigger.states).toEqual(['success']);
  });

  it('config with contexts and states', () => {
    const trigger = status({ contexts: ['ci/*'], states: ['success', 'failure'] });
    expect(trigger.contexts).toEqual(['ci/*']);
    expect(trigger.states).toEqual(['success', 'failure']);
  });

  it('config with description', () => {
    const trigger = status({ description: 'CI status checks' });
    expect(trigger.description).toBe('CI status checks');
  });

  it('returns frozen config', () => {
    const trigger = status({ contexts: ['ci/*'], states: ['success'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.contexts)).toBe(true);
    expect(Object.isFrozen(trigger.states)).toBe(true);
  });
});

describe('workflowRun()', () => {
  it('creates config with empty defaults', () => {
    const trigger = workflowRun();
    expect(trigger._tag).toBe('WorkflowRunTrigger');
    expect(trigger.actions).toEqual([]);
    expect(trigger.workflows).toEqual([]);
    expect(trigger.conclusions).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = workflowRun({ actions: ['completed'] });
    expect(trigger.actions).toEqual(['completed']);
  });

  it('config with workflows', () => {
    const trigger = workflowRun({ workflows: ['CI'] });
    expect(trigger.workflows).toEqual(['CI']);
  });

  it('config with conclusions', () => {
    const trigger = workflowRun({ conclusions: ['success'] });
    expect(trigger.conclusions).toEqual(['success']);
  });

  it('config with all options', () => {
    const trigger = workflowRun({
      actions: ['completed'],
      workflows: ['CI', 'Deploy'],
      conclusions: ['success'],
      description: 'After CI passes',
    });
    expect(trigger._tag).toBe('WorkflowRunTrigger');
    expect(trigger.actions).toEqual(['completed']);
    expect(trigger.workflows).toEqual(['CI', 'Deploy']);
    expect(trigger.conclusions).toEqual(['success']);
    expect(trigger.description).toBe('After CI passes');
  });

  it('returns frozen config', () => {
    const trigger = workflowRun({ workflows: ['CI'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
    expect(Object.isFrozen(trigger.workflows)).toBe(true);
    expect(Object.isFrozen(trigger.conclusions)).toBe(true);
  });
});

describe('fork()', () => {
  it('creates minimal config', () => {
    const trigger = fork();
    expect(trigger._tag).toBe('ForkTrigger');
    expect(trigger.description).toBeUndefined();
  });

  it('config with description', () => {
    const trigger = fork({ description: 'Track forks' });
    expect(trigger.description).toBe('Track forks');
  });

  it('returns frozen config', () => {
    const trigger = fork();
    expect(Object.isFrozen(trigger)).toBe(true);
  });
});

describe('star()', () => {
  it('creates config with empty defaults', () => {
    const trigger = star();
    expect(trigger._tag).toBe('StarTrigger');
    expect(trigger.actions).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = star({ actions: ['created'] });
    expect(trigger.actions).toEqual(['created']);
  });

  it('config with both actions', () => {
    const trigger = star({ actions: ['created', 'deleted'] });
    expect(trigger.actions).toEqual(['created', 'deleted']);
  });

  it('config with description', () => {
    const trigger = star({ description: 'Star notifications' });
    expect(trigger.description).toBe('Star notifications');
  });

  it('returns frozen config', () => {
    const trigger = star({ actions: ['created'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('watch()', () => {
  it('creates config with empty defaults', () => {
    const trigger = watch();
    expect(trigger._tag).toBe('WatchTrigger');
    expect(trigger.actions).toEqual([]);
  });

  it('config with actions', () => {
    const trigger = watch({ actions: ['started'] });
    expect(trigger.actions).toEqual(['started']);
  });

  it('config with description', () => {
    const trigger = watch({ description: 'Watch events' });
    expect(trigger.description).toBe('Watch events');
  });

  it('returns frozen config', () => {
    const trigger = watch({ actions: ['started'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('webhook()', () => {
  it('throws on empty events array', () => {
    expect(() => webhook({ events: [] })).toThrow('non-empty events array');
  });

  it('creates config with required events', () => {
    const trigger = webhook({ events: ['deployment'] });
    expect(trigger._tag).toBe('WebhookTrigger');
    expect(trigger.events).toEqual(['deployment']);
    expect(trigger.actions).toEqual([]);
  });

  it('config with multiple events', () => {
    const trigger = webhook({ events: ['deployment', 'deployment_status'] });
    expect(trigger.events).toEqual(['deployment', 'deployment_status']);
  });

  it('config with actions', () => {
    const trigger = webhook({ events: ['deployment'], actions: ['created'] });
    expect(trigger.actions).toEqual(['created']);
  });

  it('config with description', () => {
    const trigger = webhook({ events: ['deployment'], description: 'Deployment hooks' });
    expect(trigger.description).toBe('Deployment hooks');
  });

  it('returns frozen config', () => {
    const trigger = webhook({ events: ['deployment'], actions: ['created'] });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(trigger.events)).toBe(true);
    expect(Object.isFrozen(trigger.actions)).toBe(true);
  });
});

describe('repos with !-prefixed exclusions on all git-event triggers', () => {
  it('push with repos glob produces BranchPattern array', () => {
    const trigger = push({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('push with repos regex produces BranchPattern array', () => {
    const trigger = push({ repos: [/^myorg\/api-v\d+$/] });
    expect(trigger.repos).toEqual([
      { type: 'regex', pattern: '^myorg\\/api-v\\d+$', flags: undefined },
    ]);
  });

  it('push with repos including !-prefixed exclusion', () => {
    const trigger = push({
      repos: ['myorg/*', '!myorg/secret-*'],
    });
    expect(trigger.repos).toEqual([
      { type: 'glob', pattern: 'myorg/*' },
      { type: 'glob', pattern: '!myorg/secret-*' },
    ]);
  });

  it('push with no repos produces empty array', () => {
    const trigger = push();
    expect(trigger.repos).toEqual([]);
  });

  it('push repos are frozen', () => {
    const trigger = push({ repos: ['myorg/*', '!myorg/internal-*'] });
    expect(Object.isFrozen(trigger.repos)).toBe(true);
  });

  it('pr with repos produces BranchPattern array', () => {
    const trigger = pr({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('tag with repos', () => {
    const trigger = tag({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('comment with repos', () => {
    const trigger = comment({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('review with repos', () => {
    const trigger = review({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('reviewComment with repos', () => {
    const trigger = reviewComment({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('release with repos', () => {
    const trigger = release({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('dispatch with repos', () => {
    const trigger = dispatch({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('create with repos', () => {
    const trigger = create({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('del with repos', () => {
    const trigger = del({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('status with repos', () => {
    const trigger = status({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('workflowRun with repos', () => {
    const trigger = workflowRun({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('fork with repos', () => {
    const trigger = fork({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('star with repos', () => {
    const trigger = star({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('watch with repos', () => {
    const trigger = watch({ repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });

  it('webhook with repos', () => {
    const trigger = webhook({ events: ['deployment'], repos: ['myorg/*'] });
    expect(trigger.repos).toEqual([{ type: 'glob', pattern: 'myorg/*' }]);
  });
});

describe('description field on all triggers', () => {
  it('omitted when not provided', () => {
    expect('description' in tag()).toBe(false);
    expect('description' in comment()).toBe(false);
    expect('description' in review()).toBe(false);
    expect('description' in reviewComment()).toBe(false);
    expect('description' in release()).toBe(false);
    expect('description' in dispatch()).toBe(false);
    expect('description' in create()).toBe(false);
    expect('description' in del()).toBe(false);
    expect('description' in status()).toBe(false);
    expect('description' in workflowRun()).toBe(false);
    expect('description' in fork()).toBe(false);
    expect('description' in star()).toBe(false);
    expect('description' in watch()).toBe(false);
    expect('description' in webhook({ events: ['x'] })).toBe(false);
  });

  it('included when provided', () => {
    expect(tag({ description: 'a' }).description).toBe('a');
    expect(comment({ description: 'b' }).description).toBe('b');
    expect(review({ description: 'c' }).description).toBe('c');
    expect(reviewComment({ description: 'd' }).description).toBe('d');
    expect(release({ description: 'e' }).description).toBe('e');
    expect(dispatch({ description: 'f' }).description).toBe('f');
    expect(create({ description: 'g' }).description).toBe('g');
    expect(del({ description: 'h' }).description).toBe('h');
    expect(status({ description: 'i' }).description).toBe('i');
    expect(workflowRun({ description: 'j' }).description).toBe('j');
    expect(fork({ description: 'k' }).description).toBe('k');
    expect(star({ description: 'l' }).description).toBe('l');
    expect(watch({ description: 'm' }).description).toBe('m');
    expect(webhook({ events: ['x'], description: 'n' }).description).toBe('n');
  });
});
