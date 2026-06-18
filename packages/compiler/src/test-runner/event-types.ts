/**
 * Event type mapping system for webhook events.
 * Supports all 22 trigger types defined in the SDK:
 * 15 GitHub event types + 7 internal/generic types.
 */

import type { LockTrigger } from '../types.js';

export type EventType =
  | { type: 'pull_request'; action: string }
  | { type: 'push' }
  | { type: 'tag' }
  | { type: 'comment'; action: string }
  | { type: 'review'; action: string }
  | { type: 'review_comment'; action: string }
  | { type: 'release'; action: string }
  | { type: 'dispatch' }
  | { type: 'create'; refType?: string }
  | { type: 'delete'; refType?: string }
  | { type: 'status' }
  | { type: 'workflow_run'; action: string }
  | { type: 'fork' }
  | { type: 'star'; action: string }
  | { type: 'watch'; action: string }
  | { type: 'kici_event'; eventName: string }
  | { type: 'workflow_complete'; workflowName: string; status: string }
  | { type: 'job_complete'; workflowName: string; jobName: string; status: string }
  | { type: 'generic_webhook'; source?: string }
  | { type: 'schedule'; cronExpression?: string; timezone?: string }
  | { type: 'lifecycle'; lifecycleEvent: string };

/**
 * Parse CLI event argument to EventType.
 * Supports all trigger types and common action shortcuts.
 */
export function parseEventArg(arg: string): EventType {
  const normalized = arg.toLowerCase().trim();

  switch (normalized) {
    // --- PR events ---
    case 'pr:open':
    case 'pr:opened':
      return { type: 'pull_request', action: 'opened' };
    case 'pr:sync':
    case 'pr:synchronize':
      return { type: 'pull_request', action: 'synchronize' };
    case 'pr:close':
    case 'pr:closed':
      return { type: 'pull_request', action: 'closed' };
    case 'pr:reopen':
    case 'pr:reopened':
      return { type: 'pull_request', action: 'reopened' };

    // --- Push ---
    case 'push':
      return { type: 'push' };

    // --- Tag ---
    case 'tag':
      return { type: 'tag' };

    // --- Comment (issue_comment) ---
    case 'comment':
    case 'comment:created':
      return { type: 'comment', action: 'created' };
    case 'comment:edited':
      return { type: 'comment', action: 'edited' };
    case 'comment:deleted':
      return { type: 'comment', action: 'deleted' };

    // --- Review (pull_request_review) ---
    case 'review':
    case 'review:submitted':
      return { type: 'review', action: 'submitted' };
    case 'review:edited':
      return { type: 'review', action: 'edited' };
    case 'review:dismissed':
      return { type: 'review', action: 'dismissed' };

    // --- Review comment (pull_request_review_comment) ---
    case 'review_comment':
    case 'review_comment:created':
      return { type: 'review_comment', action: 'created' };
    case 'review_comment:edited':
      return { type: 'review_comment', action: 'edited' };
    case 'review_comment:deleted':
      return { type: 'review_comment', action: 'deleted' };

    // --- Release ---
    case 'release':
    case 'release:published':
      return { type: 'release', action: 'published' };
    case 'release:unpublished':
      return { type: 'release', action: 'unpublished' };
    case 'release:created':
      return { type: 'release', action: 'created' };
    case 'release:edited':
      return { type: 'release', action: 'edited' };
    case 'release:deleted':
      return { type: 'release', action: 'deleted' };
    case 'release:prereleased':
      return { type: 'release', action: 'prereleased' };
    case 'release:released':
      return { type: 'release', action: 'released' };

    // --- Dispatch (repository_dispatch) ---
    case 'dispatch':
      return { type: 'dispatch' };

    // --- Create ---
    case 'create':
      return { type: 'create' };
    case 'create:branch':
      return { type: 'create', refType: 'branch' };
    case 'create:tag':
      return { type: 'create', refType: 'tag' };

    // --- Delete ---
    case 'delete':
      return { type: 'delete' };
    case 'delete:branch':
      return { type: 'delete', refType: 'branch' };
    case 'delete:tag':
      return { type: 'delete', refType: 'tag' };

    // --- Status ---
    case 'status':
      return { type: 'status' };

    // --- Workflow run ---
    case 'workflow_run':
    case 'workflow_run:completed':
      return { type: 'workflow_run', action: 'completed' };
    case 'workflow_run:requested':
      return { type: 'workflow_run', action: 'requested' };
    case 'workflow_run:in_progress':
      return { type: 'workflow_run', action: 'in_progress' };

    // --- Fork ---
    case 'fork':
      return { type: 'fork' };

    // --- Star ---
    case 'star':
    case 'star:created':
      return { type: 'star', action: 'created' };
    case 'star:deleted':
      return { type: 'star', action: 'deleted' };

    // --- Watch ---
    case 'watch':
    case 'watch:started':
      return { type: 'watch', action: 'started' };

    // --- KiCI internal event ---
    case 'kici_event':
      return { type: 'kici_event', eventName: 'test-event' };

    // --- Workflow complete ---
    case 'workflow_complete':
      return { type: 'workflow_complete', workflowName: 'test', status: 'success' };
    case 'workflow_complete:success':
      return { type: 'workflow_complete', workflowName: 'test', status: 'success' };
    case 'workflow_complete:failed':
      return { type: 'workflow_complete', workflowName: 'test', status: 'failed' };
    case 'workflow_complete:cancelled':
      return { type: 'workflow_complete', workflowName: 'test', status: 'cancelled' };

    // --- Job complete ---
    case 'job_complete':
      return {
        type: 'job_complete',
        workflowName: 'test',
        jobName: 'test',
        status: 'success',
      };

    // --- Generic webhook ---
    case 'generic_webhook':
      return { type: 'generic_webhook' };

    // --- Schedule ---
    case 'schedule':
      return { type: 'schedule' };

    // --- Lifecycle ---
    case 'lifecycle':
      return { type: 'lifecycle', lifecycleEvent: 'workflow_complete' };

    default: {
      // Handle dynamic patterns with colon-separated parameters
      if (normalized.startsWith('kici_event:')) {
        const eventName = normalized.slice('kici_event:'.length);
        return { type: 'kici_event', eventName };
      }
      if (normalized.startsWith('workflow_complete:')) {
        const status = normalized.slice('workflow_complete:'.length);
        return { type: 'workflow_complete', workflowName: 'test', status };
      }
      if (normalized.startsWith('job_complete:')) {
        const status = normalized.slice('job_complete:'.length);
        return { type: 'job_complete', workflowName: 'test', jobName: 'test', status };
      }
      if (normalized.startsWith('generic_webhook:')) {
        const source = normalized.slice('generic_webhook:'.length);
        return { type: 'generic_webhook', source };
      }
      // webhook: is a shorthand alias for generic_webhook:
      if (normalized.startsWith('webhook:')) {
        const source = normalized.slice('webhook:'.length);
        return { type: 'generic_webhook', source };
      }
      if (normalized.startsWith('lifecycle:')) {
        const lifecycleEvent = normalized.slice('lifecycle:'.length);
        return { type: 'lifecycle', lifecycleEvent };
      }
      if (normalized.startsWith('schedule:')) {
        // schedule:<cron> is not typical but allow specifying a cron expression
        const cronExpression = normalized.slice('schedule:'.length);
        return { type: 'schedule', cronExpression };
      }

      throw new Error(
        `Unknown event name: ${arg}\n` +
          `Available events: pr:open, pr:sync, pr:close, pr:reopen, push, tag, ` +
          `comment, comment:created, comment:edited, comment:deleted, ` +
          `review, review:submitted, review:edited, review:dismissed, ` +
          `review_comment, review_comment:created, ` +
          `release, release:published, release:created, release:prereleased, ` +
          `dispatch, create, create:branch, create:tag, ` +
          `delete, delete:branch, delete:tag, ` +
          `status, workflow_run, workflow_run:completed, ` +
          `fork, star, star:created, watch, ` +
          `kici_event, kici_event:<name>, ` +
          `workflow_complete, workflow_complete:<status>, ` +
          `job_complete, generic_webhook, generic_webhook:<source>, ` +
          `webhook:<source>, schedule, lifecycle, lifecycle:<event>`,
      );
    }
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled trigger type: ${JSON.stringify(x)}`);
}

/**
 * Derive an event-arg string from a `LockTrigger` that `parseEventArg` can accept.
 * Inverse of `parseEventArg` for picker-driven flows: pick a trigger, feed the
 * derived event arg back through the standard pipeline.
 */
export function triggerToEventArg(trigger: LockTrigger): string {
  switch (trigger._type) {
    case 'pr': {
      const action = trigger.events[0] ?? 'opened';
      return `pr:${action}`;
    }
    case 'push':
      return 'push';
    case 'tag':
      return 'tag';
    case 'comment': {
      const action = trigger.actions[0] ?? 'created';
      return `comment:${action}`;
    }
    case 'review': {
      const action = trigger.actions[0] ?? 'submitted';
      return `review:${action}`;
    }
    case 'review_comment': {
      const action = trigger.actions[0] ?? 'created';
      return `review_comment:${action}`;
    }
    case 'release': {
      const action = trigger.actions[0] ?? 'published';
      return `release:${action}`;
    }
    case 'dispatch':
      return 'dispatch';
    case 'create': {
      const refType = trigger.refTypes[0];
      return refType ? `create:${refType}` : 'create';
    }
    case 'delete': {
      const refType = trigger.refTypes[0];
      return refType ? `delete:${refType}` : 'delete';
    }
    case 'status':
      return 'status';
    case 'workflow_run': {
      const action = trigger.actions[0] ?? 'completed';
      return `workflow_run:${action}`;
    }
    case 'fork':
      return 'fork';
    case 'star': {
      const action = trigger.actions[0] ?? 'created';
      return `star:${action}`;
    }
    case 'watch': {
      const action = trigger.actions[0] ?? 'started';
      return `watch:${action}`;
    }
    case 'webhook': {
      const event = trigger.events[0];
      return event ? `webhook:${event}` : 'generic_webhook';
    }
    case 'kici_event':
      return `kici_event:${trigger.eventName}`;
    case 'workflow_complete': {
      const status = trigger.status?.[0];
      return status ? `workflow_complete:${status}` : 'workflow_complete';
    }
    case 'job_complete': {
      const status = trigger.status?.[0];
      return status ? `job_complete:${status}` : 'job_complete';
    }
    case 'generic_webhook':
      return `webhook:${trigger.source}`;
    case 'schedule':
      return 'schedule';
    case 'lifecycle': {
      const event = trigger.events[0] ?? 'workflow_complete';
      return `lifecycle:${event}`;
    }
    default:
      return assertNever(trigger);
  }
}

function joinList(values: readonly string[], max = 3): string {
  if (values.length === 0) return '';
  if (values.length <= max) return values.join(',');
  return `${values.slice(0, max).join(',')}…`;
}

function patternSummary(patterns: readonly { pattern: string }[], max = 3): string {
  return joinList(
    patterns.map((p) => p.pattern),
    max,
  );
}

/**
 * One-line label for a `LockTrigger`, suitable for interactive picker rows.
 * Keeps output compact and human-readable.
 */
export function triggerSummary(trigger: LockTrigger): string {
  switch (trigger._type) {
    case 'pr': {
      const events = joinList(trigger.events);
      const targets = patternSummary(trigger.targetBranches);
      const suffix = targets ? ` on ${targets}` : '';
      return `pr(${events}${suffix})`;
    }
    case 'push': {
      const branches = patternSummary(trigger.branches);
      return branches ? `push(${branches})` : 'push';
    }
    case 'tag': {
      const patterns = patternSummary(trigger.patterns);
      return patterns ? `tag(${patterns})` : 'tag';
    }
    case 'comment': {
      const actions = joinList(trigger.actions);
      const src = trigger.source ? ` ${trigger.source}` : '';
      return `comment(${actions}${src})`;
    }
    case 'review':
      return `review(${joinList(trigger.actions)})`;
    case 'review_comment':
      return `review_comment(${joinList(trigger.actions)})`;
    case 'release':
      return `release(${joinList(trigger.actions)})`;
    case 'dispatch': {
      const types = joinList(trigger.types);
      return types ? `dispatch(${types})` : 'dispatch';
    }
    case 'create': {
      const refTypes = joinList(trigger.refTypes);
      return refTypes ? `create(${refTypes})` : 'create';
    }
    case 'delete': {
      const refTypes = joinList(trigger.refTypes);
      return refTypes ? `delete(${refTypes})` : 'delete';
    }
    case 'status':
      return `status(${joinList(trigger.states)})`;
    case 'workflow_run':
      return `workflow_run(${joinList(trigger.actions)})`;
    case 'fork':
      return 'fork';
    case 'star':
      return `star(${joinList(trigger.actions)})`;
    case 'watch':
      return `watch(${joinList(trigger.actions)})`;
    case 'webhook':
      return `webhook(${joinList(trigger.events)})`;
    case 'kici_event':
      return `kici_event(${trigger.eventName})`;
    case 'workflow_complete': {
      const name = trigger.name ? `${trigger.name}` : '*';
      const status = trigger.status?.length ? `, ${joinList(trigger.status)}` : '';
      return `workflow_complete(${name}${status})`;
    }
    case 'job_complete': {
      const workflow = trigger.workflow ?? '*';
      const job = trigger.job ? `.${trigger.job}` : '';
      const status = trigger.status?.length ? `, ${joinList(trigger.status)}` : '';
      return `job_complete(${workflow}${job}${status})`;
    }
    case 'generic_webhook':
      return `webhook(${trigger.source})`;
    case 'schedule':
      return `schedule('${trigger.cronExpression}')`;
    case 'lifecycle':
      return `lifecycle(${joinList(trigger.events)})`;
    default:
      return assertNever(trigger);
  }
}
