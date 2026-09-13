/**
 * Event-type bucketing for trigger matching. Walking every workflow per
 * webhook is O(all-workflows) even though most reject on the event-type guard.
 * We index workflows by the SimulatedEvent.type(s) they can match once per
 * lockfile (memoized on the workflows-array identity) and, on the hot dispatch
 * path, evaluate only the candidates for the incoming event type.
 *
 * Pure module — no node:* imports — so the engine barrel stays browser-safe.
 */
import type { LockWorkflow, SimulatedEvent } from './types.js';
import type { WorkflowDecision } from './decision-trace.js';
import type { TriggerEventType } from './trigger-event-type.js';
import { matchWorkflowTriggers } from './matcher.js';

/**
 * Static inverse of the `event.type !== X` guards in matcher.ts. Every trigger
 * `_type` maps to the set of SimulatedEvent.type values whose guard it passes.
 *
 * Two triggers are multi-type:
 *  - `webhook` is NOT in this map — its event types are per-instance
 *    (`trigger.events`), resolved in prepareEventBuckets.
 *  - `workflows_failed_batch` matches TWO event types: a failed
 *    `workflow_complete` (accumulation input) and the synthetic
 *    `workflows_failed_batch` (dispatch), so it maps to both.
 *
 * Guarded against drift by event-buckets.test.ts (the equivalence + guard
 * tests would fail if a guard changed without this map).
 */
export const TRIGGER_TYPE_TO_EVENT_TYPES: Record<string, readonly TriggerEventType[]> = {
  pr: ['pull_request'],
  push: ['push'],
  tag: ['tag'],
  comment: ['comment'],
  review: ['review'],
  review_comment: ['review_comment'],
  release: ['release'],
  dispatch: ['dispatch'],
  create: ['create'],
  delete: ['delete'],
  status: ['status'],
  workflow_run: ['workflow_run'],
  fork: ['fork'],
  star: ['star'],
  watch: ['watch'],
  kici_event: ['kici_event'],
  workflow_complete: ['workflow_complete'],
  workflows_failed_batch: ['workflow_complete', 'workflows_failed_batch'],
  job_complete: ['job_complete'],
  generic_webhook: ['generic_webhook'],
  schedule: ['schedule'],
  lifecycle: ['lifecycle'],
};

const WEBHOOK_TRIGGER_TYPE = 'webhook';

const bucketMemo = new WeakMap<readonly LockWorkflow[], Map<string, LockWorkflow[]>>();

/**
 * Index workflows by every SimulatedEvent.type any of their triggers can match.
 * Memoized on the workflows-array identity: LockFileCache returns the same
 * LockFile (hence the same workflows array) on a cache hit, so buckets are
 * built once per cached lockfile and GC'd with it.
 */
export function prepareEventBuckets(
  workflows: readonly LockWorkflow[],
): Map<string, LockWorkflow[]> {
  const cached = bucketMemo.get(workflows);
  if (cached) return cached;

  const buckets = new Map<string, LockWorkflow[]>();
  const add = (eventType: string, w: LockWorkflow, seen: Set<string>): void => {
    if (seen.has(eventType)) return;
    seen.add(eventType);
    let arr = buckets.get(eventType);
    if (!arr) {
      arr = [];
      buckets.set(eventType, arr);
    }
    arr.push(w);
  };

  for (const w of workflows) {
    const seen = new Set<string>();
    for (const trigger of w.triggers) {
      if (trigger == null) continue;
      if (trigger._type === WEBHOOK_TRIGGER_TYPE) {
        for (const evt of (trigger as { events: readonly string[] }).events) {
          add(evt, w, seen);
        }
        continue;
      }
      const eventTypes = TRIGGER_TYPE_TO_EVENT_TYPES[trigger._type];
      if (eventTypes) {
        for (const evt of eventTypes) add(evt, w, seen);
      }
    }
  }

  bucketMemo.set(workflows, buckets);
  return buckets;
}

/**
 * Match only the workflows subscribed to the incoming event type. Returns
 * candidate decisions (a superset of matched); callers filter `.matched`.
 * The candidate set is a superset of every workflow matchAllWorkflows would
 * mark matched — a workflow matches only if some trigger's guard passes for
 * event.type, which means that trigger indexed the workflow under event.type —
 * so the matched result is identical.
 */
export function matchWorkflowsForEvent(
  workflows: readonly LockWorkflow[],
  event: SimulatedEvent,
): WorkflowDecision[] {
  const candidates = prepareEventBuckets(workflows).get(event.type) ?? [];
  return candidates.map((w) => matchWorkflowTriggers(w, event));
}
