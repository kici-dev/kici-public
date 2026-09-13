/**
 * Event-type bucketing tests. The core guarantee is a PARITY invariant: the
 * matched set produced by the candidates-only matchWorkflowsForEvent must be
 * byte-identical to the matched subset of matchAllWorkflows for every event
 * type — a bucketing bug that dropped a subscribed workflow would surface here.
 */
import { describe, it, expect } from 'vitest';
import type { LockWorkflow, SimulatedEvent, LockTrigger } from './types.js';
import { matchAllWorkflows, matchTrigger } from './matcher.js';
import { TRIGGER_EVENT_TYPES } from './trigger-event-type.js';
import {
  TRIGGER_TYPE_TO_EVENT_TYPES,
  prepareEventBuckets,
  matchWorkflowsForEvent,
} from './event-buckets.js';

function wf(name: string, triggers: LockTrigger[]): LockWorkflow {
  return { name, contentHash: '', compileSchemaVersion: 0, triggers, jobs: [] };
}

/** A representative corpus covering single-type, webhook multi-type, and the
 *  dual-phase workflows_failed_batch trigger. */
const CORPUS: LockWorkflow[] = [
  wf('push-wf', [{ _type: 'push', branches: [], paths: [] }]),
  wf('pr-wf', [{ _type: 'pr', events: [], targetBranches: [], sourceBranches: [], paths: [] }]),
  wf('tag-wf', [{ _type: 'tag', patterns: [] }]),
  wf('release-wf', [{ _type: 'release', actions: [] }]),
  wf('schedule-wf', [{ _type: 'schedule', cronExpression: '* * * * *' }]),
  wf('webhook-multi', [{ _type: 'webhook', events: ['push', 'release'], actions: [] }]),
  wf('failed-batch-wf', [{ _type: 'workflows_failed_batch', accumulateFor: 1000 }]),
  wf('wf-complete-wf', [{ _type: 'workflow_complete' }]),
  // A workflow with two triggers of different event types.
  wf('multi-trigger', [
    { _type: 'push', branches: [], paths: [] },
    { _type: 'tag', patterns: [] },
  ]),
  wf('no-triggers', []),
];

/** One representative event per event type; fields chosen so the corresponding
 *  corpus trigger actually matches (proves the candidate set is a superset). */
const EVENTS: SimulatedEvent[] = [
  { type: 'push', targetBranch: 'main', payload: {} },
  { type: 'pull_request', action: 'opened', targetBranch: 'main', payload: {} },
  { type: 'tag', payload: {} },
  { type: 'release', action: 'published', payload: {} },
  { type: 'schedule', payload: { cronExpression: '* * * * *' } },
  // Failed workflow_complete: accumulation input for workflows_failed_batch AND
  // a match for a plain workflow_complete trigger.
  { type: 'workflow_complete', payload: { status: 'failed' } },
  // Non-failed workflow_complete: matches workflow_complete but NOT failed-batch.
  { type: 'workflow_complete', payload: { status: 'success' } },
  { type: 'workflows_failed_batch', payload: {} },
  // Event types with no matching workflow in the corpus (must be empty on both sides).
  { type: 'comment', payload: {} },
  { type: 'rerun', payload: {} },
];

describe('matchWorkflowsForEvent parity with matchAllWorkflows', () => {
  it('produces the identical matched set for every representative event', () => {
    for (const event of EVENTS) {
      const viaAll = matchAllWorkflows(CORPUS, event)
        .filter((d) => d.matched)
        .map((d) => d.workflowName)
        .sort();
      const viaBucket = matchWorkflowsForEvent(CORPUS, event)
        .filter((d) => d.matched)
        .map((d) => d.workflowName)
        .sort();
      expect(viaBucket, `event ${event.type} / ${JSON.stringify(event.payload)}`).toEqual(viaAll);
    }
  });

  it('produces the identical matched set across ALL known event types', () => {
    for (const type of TRIGGER_EVENT_TYPES) {
      const event = { type, payload: {} } as unknown as SimulatedEvent;
      const viaAll = matchAllWorkflows(CORPUS, event)
        .filter((d) => d.matched)
        .map((d) => d.workflowName)
        .sort();
      const viaBucket = matchWorkflowsForEvent(CORPUS, event)
        .filter((d) => d.matched)
        .map((d) => d.workflowName)
        .sort();
      expect(viaBucket, `event ${type}`).toEqual(viaAll);
    }
  });

  it('dispatches the failed-batch workflow on a failed workflow_complete (regression: dual-phase trigger)', () => {
    const failed: SimulatedEvent = { type: 'workflow_complete', payload: { status: 'failed' } };
    const matched = matchWorkflowsForEvent(CORPUS, failed)
      .filter((d) => d.matched)
      .map((d) => d.workflowName);
    expect(matched).toContain('failed-batch-wf');
    expect(matched).toContain('wf-complete-wf');
  });

  it('dispatches the failed-batch workflow on the synthetic batch event', () => {
    const batch: SimulatedEvent = { type: 'workflows_failed_batch', payload: {} };
    const matched = matchWorkflowsForEvent(CORPUS, batch)
      .filter((d) => d.matched)
      .map((d) => d.workflowName);
    expect(matched).toEqual(['failed-batch-wf']);
  });
});

describe('prepareEventBuckets', () => {
  it('memoizes on the workflows-array identity', () => {
    const ws: LockWorkflow[] = [wf('a', [{ _type: 'push', branches: [], paths: [] }])];
    expect(prepareEventBuckets(ws)).toBe(prepareEventBuckets(ws));
    expect(prepareEventBuckets([...ws])).not.toBe(prepareEventBuckets(ws));
  });

  it('indexes a webhook trigger under each of its event types', () => {
    const buckets = prepareEventBuckets(CORPUS);
    expect(buckets.get('push')?.map((w) => w.name)).toContain('webhook-multi');
    expect(buckets.get('release')?.map((w) => w.name)).toContain('webhook-multi');
    expect(buckets.get('pull_request')?.map((w) => w.name)).not.toContain('webhook-multi');
  });

  it('indexes a workflows_failed_batch trigger under BOTH workflow_complete and workflows_failed_batch', () => {
    const buckets = prepareEventBuckets(CORPUS);
    expect(buckets.get('workflow_complete')?.map((w) => w.name)).toContain('failed-batch-wf');
    expect(buckets.get('workflows_failed_batch')?.map((w) => w.name)).toContain('failed-batch-wf');
  });

  it('does not duplicate a workflow in a bucket when two triggers map to the same event type', () => {
    const ws = [
      wf('dup', [
        { _type: 'push', branches: [], paths: [] },
        { _type: 'webhook', events: ['push'], actions: [] },
      ]),
    ];
    expect(prepareEventBuckets(ws).get('push')).toHaveLength(1);
  });

  it('never buckets a workflow with no triggers', () => {
    const buckets = prepareEventBuckets(CORPUS);
    for (const arr of buckets.values()) {
      expect(arr.map((w) => w.name)).not.toContain('no-triggers');
    }
  });
});

describe('TRIGGER_TYPE_TO_EVENT_TYPES drift guard', () => {
  it('every mapped trigger type is rejected by matchTrigger for an event type NOT in its mapped set', () => {
    for (const [triggerType, eventTypes] of Object.entries(TRIGGER_TYPE_TO_EVENT_TYPES)) {
      const foreign = TRIGGER_EVENT_TYPES.find((t) => !eventTypes.includes(t));
      expect(foreign, `no foreign event type for ${triggerType}`).toBeDefined();
      const event = { type: foreign, payload: {} } as unknown as SimulatedEvent;
      const trigger = { _type: triggerType } as unknown as LockTrigger;
      expect(matchTrigger(trigger, event, []), `${triggerType} vs ${foreign}`).toBe(false);
    }
  });

  it('maps every non-webhook trigger _type present in the matcher switch', () => {
    // These are the trigger _types with an event.type guard (webhook excluded —
    // it is dynamic). If the matcher grows a new trigger type, this list and the
    // map must both be updated.
    const expected = [
      'pr',
      'push',
      'tag',
      'comment',
      'review',
      'review_comment',
      'release',
      'dispatch',
      'create',
      'delete',
      'status',
      'workflow_run',
      'fork',
      'star',
      'watch',
      'kici_event',
      'workflow_complete',
      'workflows_failed_batch',
      'job_complete',
      'generic_webhook',
      'schedule',
      'lifecycle',
    ];
    expect(Object.keys(TRIGGER_TYPE_TO_EVENT_TYPES).sort()).toEqual([...expected].sort());
  });
});
