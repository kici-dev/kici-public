import { describe, it, expect } from 'vitest';
import { parseEventArg, triggerToEventArg, triggerSummary } from './event-types.js';
import { getDefaultFixture, listAvailableEvents } from '../fixtures/defaults/index.js';
import type { LockTrigger } from '../types.js';

describe('parseEventArg', () => {
  it('parses pr:open to pull_request opened', () => {
    const result = parseEventArg('pr:open');
    expect(result).toEqual({ type: 'pull_request', action: 'opened' });
  });

  it('parses pr:opened to pull_request opened', () => {
    const result = parseEventArg('pr:opened');
    expect(result).toEqual({ type: 'pull_request', action: 'opened' });
  });

  it('parses pr:sync to pull_request synchronize', () => {
    const result = parseEventArg('pr:sync');
    expect(result).toEqual({ type: 'pull_request', action: 'synchronize' });
  });

  it('parses push to push event', () => {
    const result = parseEventArg('push');
    expect(result).toEqual({ type: 'push' });
  });

  it('throws on unknown event with available options', () => {
    expect(() => parseEventArg('unknown')).toThrow(/Unknown event name: unknown/);
    expect(() => parseEventArg('unknown')).toThrow(/Available events:/);
  });

  it('normalizes case and whitespace', () => {
    const result = parseEventArg('  PR:OPEN  ');
    expect(result).toEqual({ type: 'pull_request', action: 'opened' });
  });

  // --- Tag ---
  it('parses tag', () => {
    expect(parseEventArg('tag')).toEqual({ type: 'tag' });
  });

  // --- Comment ---
  it('parses comment (default: created)', () => {
    expect(parseEventArg('comment')).toEqual({ type: 'comment', action: 'created' });
  });

  it('parses comment:created', () => {
    expect(parseEventArg('comment:created')).toEqual({ type: 'comment', action: 'created' });
  });

  it('parses comment:edited', () => {
    expect(parseEventArg('comment:edited')).toEqual({ type: 'comment', action: 'edited' });
  });

  it('parses comment:deleted', () => {
    expect(parseEventArg('comment:deleted')).toEqual({ type: 'comment', action: 'deleted' });
  });

  // --- Review ---
  it('parses review (default: submitted)', () => {
    expect(parseEventArg('review')).toEqual({ type: 'review', action: 'submitted' });
  });

  it('parses review:submitted', () => {
    expect(parseEventArg('review:submitted')).toEqual({ type: 'review', action: 'submitted' });
  });

  it('parses review:edited', () => {
    expect(parseEventArg('review:edited')).toEqual({ type: 'review', action: 'edited' });
  });

  it('parses review:dismissed', () => {
    expect(parseEventArg('review:dismissed')).toEqual({ type: 'review', action: 'dismissed' });
  });

  // --- Review comment ---
  it('parses review_comment (default: created)', () => {
    expect(parseEventArg('review_comment')).toEqual({
      type: 'review_comment',
      action: 'created',
    });
  });

  it('parses review_comment:created', () => {
    expect(parseEventArg('review_comment:created')).toEqual({
      type: 'review_comment',
      action: 'created',
    });
  });

  it('parses review_comment:edited', () => {
    expect(parseEventArg('review_comment:edited')).toEqual({
      type: 'review_comment',
      action: 'edited',
    });
  });

  it('parses review_comment:deleted', () => {
    expect(parseEventArg('review_comment:deleted')).toEqual({
      type: 'review_comment',
      action: 'deleted',
    });
  });

  // --- Release ---
  it('parses release (default: published)', () => {
    expect(parseEventArg('release')).toEqual({ type: 'release', action: 'published' });
  });

  it('parses release:published', () => {
    expect(parseEventArg('release:published')).toEqual({
      type: 'release',
      action: 'published',
    });
  });

  it('parses release:prereleased', () => {
    expect(parseEventArg('release:prereleased')).toEqual({
      type: 'release',
      action: 'prereleased',
    });
  });

  it('parses release:created', () => {
    expect(parseEventArg('release:created')).toEqual({ type: 'release', action: 'created' });
  });

  it('parses release:deleted', () => {
    expect(parseEventArg('release:deleted')).toEqual({ type: 'release', action: 'deleted' });
  });

  // --- Dispatch ---
  it('parses dispatch', () => {
    expect(parseEventArg('dispatch')).toEqual({ type: 'dispatch' });
  });

  // --- Create ---
  it('parses create', () => {
    expect(parseEventArg('create')).toEqual({ type: 'create' });
  });

  it('parses create:branch', () => {
    expect(parseEventArg('create:branch')).toEqual({ type: 'create', refType: 'branch' });
  });

  it('parses create:tag', () => {
    expect(parseEventArg('create:tag')).toEqual({ type: 'create', refType: 'tag' });
  });

  // --- Delete ---
  it('parses delete', () => {
    expect(parseEventArg('delete')).toEqual({ type: 'delete' });
  });

  it('parses delete:branch', () => {
    expect(parseEventArg('delete:branch')).toEqual({ type: 'delete', refType: 'branch' });
  });

  it('parses delete:tag', () => {
    expect(parseEventArg('delete:tag')).toEqual({ type: 'delete', refType: 'tag' });
  });

  // --- Status ---
  it('parses status', () => {
    expect(parseEventArg('status')).toEqual({ type: 'status' });
  });

  // --- Workflow run ---
  it('parses workflow_run (default: completed)', () => {
    expect(parseEventArg('workflow_run')).toEqual({
      type: 'workflow_run',
      action: 'completed',
    });
  });

  it('parses workflow_run:completed', () => {
    expect(parseEventArg('workflow_run:completed')).toEqual({
      type: 'workflow_run',
      action: 'completed',
    });
  });

  it('parses workflow_run:requested', () => {
    expect(parseEventArg('workflow_run:requested')).toEqual({
      type: 'workflow_run',
      action: 'requested',
    });
  });

  // --- Fork ---
  it('parses fork', () => {
    expect(parseEventArg('fork')).toEqual({ type: 'fork' });
  });

  // --- Star ---
  it('parses star (default: created)', () => {
    expect(parseEventArg('star')).toEqual({ type: 'star', action: 'created' });
  });

  it('parses star:created', () => {
    expect(parseEventArg('star:created')).toEqual({ type: 'star', action: 'created' });
  });

  it('parses star:deleted', () => {
    expect(parseEventArg('star:deleted')).toEqual({ type: 'star', action: 'deleted' });
  });

  // --- Watch ---
  it('parses watch (default: started)', () => {
    expect(parseEventArg('watch')).toEqual({ type: 'watch', action: 'started' });
  });

  it('parses watch:started', () => {
    expect(parseEventArg('watch:started')).toEqual({ type: 'watch', action: 'started' });
  });

  // --- KiCI event ---
  it('parses kici_event (default)', () => {
    expect(parseEventArg('kici_event')).toEqual({ type: 'kici_event', eventName: 'test-event' });
  });

  it('parses kici_event:deploy-complete', () => {
    expect(parseEventArg('kici_event:deploy-complete')).toEqual({
      type: 'kici_event',
      eventName: 'deploy-complete',
    });
  });

  it('parses kici_event:<name> with arbitrary name', () => {
    expect(parseEventArg('kici_event:build-finished')).toEqual({
      type: 'kici_event',
      eventName: 'build-finished',
    });
  });

  // --- Workflow complete ---
  it('parses workflow_complete (default)', () => {
    expect(parseEventArg('workflow_complete')).toEqual({
      type: 'workflow_complete',
      workflowName: 'test',
      status: 'success',
    });
  });

  it('parses workflow_complete:success', () => {
    expect(parseEventArg('workflow_complete:success')).toEqual({
      type: 'workflow_complete',
      workflowName: 'test',
      status: 'success',
    });
  });

  it('parses workflow_complete:failed', () => {
    expect(parseEventArg('workflow_complete:failed')).toEqual({
      type: 'workflow_complete',
      workflowName: 'test',
      status: 'failed',
    });
  });

  it('parses workflow_complete:cancelled', () => {
    expect(parseEventArg('workflow_complete:cancelled')).toEqual({
      type: 'workflow_complete',
      workflowName: 'test',
      status: 'cancelled',
    });
  });

  // --- Job complete ---
  it('parses job_complete (default)', () => {
    expect(parseEventArg('job_complete')).toEqual({
      type: 'job_complete',
      workflowName: 'test',
      jobName: 'test',
      status: 'success',
    });
  });

  it('parses job_complete:<status> with custom status', () => {
    expect(parseEventArg('job_complete:failed')).toEqual({
      type: 'job_complete',
      workflowName: 'test',
      jobName: 'test',
      status: 'failed',
    });
  });

  it('parses job_complete:<status> with cancelled status', () => {
    expect(parseEventArg('job_complete:cancelled')).toEqual({
      type: 'job_complete',
      workflowName: 'test',
      jobName: 'test',
      status: 'cancelled',
    });
  });

  // --- Generic webhook ---
  it('parses generic_webhook (default)', () => {
    expect(parseEventArg('generic_webhook')).toEqual({ type: 'generic_webhook' });
  });

  it('parses generic_webhook:my-service', () => {
    expect(parseEventArg('generic_webhook:my-service')).toEqual({
      type: 'generic_webhook',
      source: 'my-service',
    });
  });

  it('parses generic_webhook:<source> with arbitrary source', () => {
    expect(parseEventArg('generic_webhook:stripe')).toEqual({
      type: 'generic_webhook',
      source: 'stripe',
    });
  });

  // --- Schedule ---
  it('parses schedule (default)', () => {
    expect(parseEventArg('schedule')).toEqual({ type: 'schedule' });
  });

  it('parses schedule:<cron> with custom expression', () => {
    expect(parseEventArg('schedule:0 0 * * *')).toEqual({
      type: 'schedule',
      cronExpression: '0 0 * * *',
    });
  });

  // --- Lifecycle ---
  it('parses lifecycle (default: workflow_complete)', () => {
    expect(parseEventArg('lifecycle')).toEqual({
      type: 'lifecycle',
      lifecycleEvent: 'workflow_complete',
    });
  });

  it('parses lifecycle:workflow_complete', () => {
    expect(parseEventArg('lifecycle:workflow_complete')).toEqual({
      type: 'lifecycle',
      lifecycleEvent: 'workflow_complete',
    });
  });

  it('parses lifecycle:job_complete', () => {
    expect(parseEventArg('lifecycle:job_complete')).toEqual({
      type: 'lifecycle',
      lifecycleEvent: 'job_complete',
    });
  });

  it('parses lifecycle:job_failed', () => {
    expect(parseEventArg('lifecycle:job_failed')).toEqual({
      type: 'lifecycle',
      lifecycleEvent: 'job_failed',
    });
  });

  // --- webhook: alias for generic_webhook: ---
  it('parses webhook:stripe as generic_webhook with source', () => {
    expect(parseEventArg('webhook:stripe')).toEqual({
      type: 'generic_webhook',
      source: 'stripe',
    });
  });

  it('parses webhook:slack as generic_webhook with source', () => {
    expect(parseEventArg('webhook:slack')).toEqual({
      type: 'generic_webhook',
      source: 'slack',
    });
  });

  it('error message includes new event types', () => {
    expect(() => parseEventArg('unknown')).toThrow(/kici_event/);
    expect(() => parseEventArg('unknown')).toThrow(/workflow_complete/);
    expect(() => parseEventArg('unknown')).toThrow(/job_complete/);
    expect(() => parseEventArg('unknown')).toThrow(/generic_webhook/);
    expect(() => parseEventArg('unknown')).toThrow(/schedule/);
    expect(() => parseEventArg('unknown')).toThrow(/lifecycle/);
  });
});

describe('getDefaultFixture', () => {
  it('returns fixture for pr:open with action opened', () => {
    const fixture = getDefaultFixture('pr:open') as any;
    expect(fixture).toBeDefined();
    expect(fixture.action).toBe('opened');
    expect(fixture.pull_request).toBeDefined();
  });

  it('returns fixture for push', () => {
    const fixture = getDefaultFixture('push') as any;
    expect(fixture).toBeDefined();
    expect(fixture.ref).toBe('refs/heads/main');
    expect(fixture.repository).toBeDefined();
  });

  it('throws on unknown event with available options', () => {
    expect(() => getDefaultFixture('unknown')).toThrow(/Unknown event type: unknown/);
    expect(() => getDefaultFixture('unknown')).toThrow(/Available events:/);
  });

  it('handles event name aliases', () => {
    const fixture1 = getDefaultFixture('pr:open');
    const fixture2 = getDefaultFixture('pr:opened');
    expect(fixture1).toBe(fixture2);
  });
});

describe('listAvailableEvents', () => {
  it('returns array including pr:open and push', () => {
    const events = listAvailableEvents();
    expect(events).toContain('pr:open');
    expect(events).toContain('push');
    expect(Array.isArray(events)).toBe(true);
  });

  it('returns unique event names', () => {
    const events = listAvailableEvents();
    const uniqueEvents = [...new Set(events)];
    expect(events.length).toBe(uniqueEvents.length);
  });
});

describe('triggerToEventArg', () => {
  const cases: Array<{ name: string; trigger: LockTrigger; expected: string }> = [
    {
      name: 'pr',
      trigger: {
        _type: 'pr',
        events: ['opened', 'synchronize'],
        targetBranches: [{ type: 'glob', pattern: 'main' }],
        sourceBranches: [],
        paths: [],
      },
      expected: 'pr:opened',
    },
    {
      name: 'pr with no events uses opened default',
      trigger: {
        _type: 'pr',
        events: [],
        targetBranches: [],
        sourceBranches: [],
        paths: [],
      },
      expected: 'pr:opened',
    },
    {
      name: 'push',
      trigger: { _type: 'push', branches: [], paths: [] },
      expected: 'push',
    },
    {
      name: 'tag',
      trigger: { _type: 'tag', patterns: [] },
      expected: 'tag',
    },
    {
      name: 'comment',
      trigger: { _type: 'comment', actions: ['created'] },
      expected: 'comment:created',
    },
    {
      name: 'review',
      trigger: { _type: 'review', actions: ['submitted'], states: [] },
      expected: 'review:submitted',
    },
    {
      name: 'review_comment',
      trigger: { _type: 'review_comment', actions: ['created'] },
      expected: 'review_comment:created',
    },
    {
      name: 'release',
      trigger: { _type: 'release', actions: ['published'] },
      expected: 'release:published',
    },
    {
      name: 'dispatch',
      trigger: { _type: 'dispatch', types: ['deploy'] },
      expected: 'dispatch',
    },
    {
      name: 'create (no refTypes)',
      trigger: { _type: 'create', refTypes: [], patterns: [] },
      expected: 'create',
    },
    {
      name: 'create with refType branch',
      trigger: { _type: 'create', refTypes: ['branch'], patterns: [] },
      expected: 'create:branch',
    },
    {
      name: 'delete with refType tag',
      trigger: { _type: 'delete', refTypes: ['tag'], patterns: [] },
      expected: 'delete:tag',
    },
    {
      name: 'status',
      trigger: { _type: 'status', contexts: [], states: ['success'] },
      expected: 'status',
    },
    {
      name: 'workflow_run',
      trigger: {
        _type: 'workflow_run',
        actions: ['completed'],
        workflows: [],
        conclusions: [],
      },
      expected: 'workflow_run:completed',
    },
    {
      name: 'fork',
      trigger: { _type: 'fork' },
      expected: 'fork',
    },
    {
      name: 'star',
      trigger: { _type: 'star', actions: ['created'] },
      expected: 'star:created',
    },
    {
      name: 'watch',
      trigger: { _type: 'watch', actions: ['started'] },
      expected: 'watch:started',
    },
    {
      name: 'webhook (LockWebhookTrigger) with event',
      trigger: { _type: 'webhook', events: ['deployment'], actions: [] },
      expected: 'webhook:deployment',
    },
    {
      name: 'kici_event',
      trigger: { _type: 'kici_event', eventName: 'deploy-finished' },
      expected: 'kici_event:deploy-finished',
    },
    {
      name: 'workflow_complete without status',
      trigger: { _type: 'workflow_complete' },
      expected: 'workflow_complete',
    },
    {
      name: 'workflow_complete with status',
      trigger: { _type: 'workflow_complete', status: ['success'] },
      expected: 'workflow_complete:success',
    },
    {
      name: 'job_complete without status',
      trigger: { _type: 'job_complete', workflow: 'ci', job: 'test' },
      expected: 'job_complete',
    },
    {
      name: 'generic_webhook',
      trigger: { _type: 'generic_webhook', source: 'stripe' },
      expected: 'webhook:stripe',
    },
    {
      name: 'schedule',
      trigger: { _type: 'schedule', cronExpression: '0 2 * * *', timezone: 'UTC' },
      expected: 'schedule',
    },
    {
      name: 'lifecycle',
      trigger: { _type: 'lifecycle', events: ['workflow_complete'] },
      expected: 'lifecycle:workflow_complete',
    },
  ];

  for (const { name, trigger, expected } of cases) {
    it(`derives event arg for ${name}`, () => {
      expect(triggerToEventArg(trigger)).toBe(expected);
    });

    it(`round-trips ${name} through parseEventArg`, () => {
      expect(() => parseEventArg(triggerToEventArg(trigger))).not.toThrow();
    });
  }
});

describe('triggerSummary', () => {
  it('formats push with branches', () => {
    expect(
      triggerSummary({
        _type: 'push',
        branches: [{ type: 'glob', pattern: 'main' }],
        paths: [],
      }),
    ).toBe('push(main)');
  });

  it('formats push with no branches', () => {
    expect(triggerSummary({ _type: 'push', branches: [], paths: [] })).toBe('push');
  });

  it('formats pr with target branches', () => {
    expect(
      triggerSummary({
        _type: 'pr',
        events: ['opened'],
        targetBranches: [{ type: 'glob', pattern: 'main' }],
        sourceBranches: [],
        paths: [],
      }),
    ).toBe('pr(opened on main)');
  });

  it('formats dispatch without types', () => {
    expect(triggerSummary({ _type: 'dispatch', types: [] })).toBe('dispatch');
  });

  it('formats dispatch with types', () => {
    expect(triggerSummary({ _type: 'dispatch', types: ['deploy'] })).toBe('dispatch(deploy)');
  });

  it('formats schedule with cron', () => {
    expect(
      triggerSummary({
        _type: 'schedule',
        cronExpression: '0 2 * * *',
        timezone: 'UTC',
      }),
    ).toBe("schedule('0 2 * * *')");
  });

  it('formats lifecycle', () => {
    expect(triggerSummary({ _type: 'lifecycle', events: ['workflow_complete'] })).toBe(
      'lifecycle(workflow_complete)',
    );
  });

  it('formats generic_webhook with source', () => {
    expect(triggerSummary({ _type: 'generic_webhook', source: 'stripe' })).toBe('webhook(stripe)');
  });

  it('formats fork without arguments', () => {
    expect(triggerSummary({ _type: 'fork' })).toBe('fork');
  });

  it('formats kici_event', () => {
    expect(triggerSummary({ _type: 'kici_event', eventName: 'deploy' })).toBe('kici_event(deploy)');
  });

  it('truncates long lists', () => {
    expect(
      triggerSummary({
        _type: 'dispatch',
        types: ['a', 'b', 'c', 'd', 'e'],
      }),
    ).toBe('dispatch(a,b,c…)');
  });
});
