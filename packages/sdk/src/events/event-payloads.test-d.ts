import { describe, it, expectTypeOf } from 'vitest';
import type { EventPayload, PullRequestEventPayload } from './event-payloads.js';
import type { Job, Workflow, DynamicJobContext } from '../types.js';

describe('EventPayload narrowing', () => {
  it('narrows to the per-type payload shape on event.type', () => {
    const handle = (event: EventPayload): void => {
      if (event.type === 'pull_request') {
        // The literal 'unknown' discriminant on UnknownEventPayload keeps this a
        // proper discriminated union, so event.type === 'pull_request' narrows
        // to exactly PullRequestEventPayload — not a fallback Record shape.
        expectTypeOf(event).toEqualTypeOf<PullRequestEventPayload>();
        expectTypeOf(event.payload.pull_request.number).toBeNumber();
      }
    };
    expectTypeOf(handle).toBeFunction();
  });

  it('exposes a literal-union discriminant (not string)', () => {
    // If UnknownEventPayload.type were `string`, this would collapse to `string`
    // and the assertion below would fail.
    expectTypeOf<EventPayload['type']>().toEqualTypeOf<
      | 'pull_request'
      | 'push'
      | 'tag'
      | 'comment'
      | 'review'
      | 'review_comment'
      | 'release'
      | 'dispatch'
      | 'create'
      | 'delete'
      | 'status'
      | 'workflow_run'
      | 'fork'
      | 'star'
      | 'watch'
      | 'webhook'
      | 'kici_event'
      | 'workflow_complete'
      | 'job_complete'
      | 'generic_webhook'
      | 'schedule'
      | 'lifecycle'
      | 'rerun'
      | 'manual_schedule'
      | 'unknown'
    >();
  });

  it('job dynamic functions accept EventPayload-param functions', () => {
    // The dynamic environment / env / concurrencyGroup fields accept a function
    // whose sole parameter is the EventPayload envelope.
    expectTypeOf<(event: EventPayload) => string>().toMatchTypeOf<
      NonNullable<Job['environment']>
    >();
    expectTypeOf<(event: EventPayload) => Record<string, string>>().toMatchTypeOf<
      NonNullable<Job['env']>
    >();
    expectTypeOf<(event: EventPayload) => string>().toMatchTypeOf<
      NonNullable<Job['concurrencyGroup']>
    >();
  });

  it('workflow concurrency.group ctx carries the EventPayload envelope', () => {
    // The group function receives `{ branch, event }` where event is the
    // normalized envelope — same shape every dynamic-function call site sees.
    expectTypeOf<Parameters<NonNullable<Workflow['concurrency']>['group']>[0]>().toEqualTypeOf<{
      branch: string;
      event: EventPayload;
    }>();
  });

  it('DynamicJobContext.ctx.event is the EventPayload envelope (optional)', () => {
    expectTypeOf<DynamicJobContext['ctx']['event']>().toEqualTypeOf<EventPayload | undefined>();
  });
});
