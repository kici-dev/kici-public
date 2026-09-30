import { describe, it, expect, vi } from 'vitest';
import { EventLogSource, EventLogStatus } from '@kici-dev/engine';
import { withCrossSourceTally } from './cross-source-tally.js';
import { DEGRADED_CHANGED_FILES_REASON } from './degraded-reason.js';
import type { ProcessingDeps } from './processor.js';

describe('withCrossSourceTally', () => {
  it('folds the cross-source count and degraded reason into the row the same-source path writes', async () => {
    const record = vi.fn(async () => undefined);
    const deps = { eventLog: { record } } as unknown as ProcessingDeps;
    const wrapped = withCrossSourceTally(deps, {
      candidatesConsidered: 2,
      jobsDispatched: 3,
      degraded: true,
    });
    await wrapped.eventLog!.record({} as never, {} as never, {
      orgId: 'o',
      source: EventLogSource.enum.direct,
      status: EventLogStatus.enum.processed,
      matchedCount: 1,
    });
    expect(record).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ matchedCount: 4, errorMessage: DEGRADED_CHANGED_FILES_REASON }),
      undefined,
    );
  });

  // breaks-if-wrong: a same-source failure reason must not be overwritten
  it('keeps an errorMessage the same-source path already set', async () => {
    const record = vi.fn(async () => undefined);
    const wrapped = withCrossSourceTally({ eventLog: { record } } as unknown as ProcessingDeps, {
      candidatesConsidered: 1,
      jobsDispatched: 0,
      degraded: true,
    });
    await wrapped.eventLog!.record({} as never, {} as never, {
      orgId: 'o',
      source: EventLogSource.enum.direct,
      status: EventLogStatus.enum.failed,
      errorMessage: 'boom',
    });
    expect((record.mock.calls[0] as unknown[])[2]).toMatchObject({
      errorMessage: 'boom',
      matchedCount: 0,
    });
  });

  it('leaves deps untouched when there is no event log', () => {
    const deps = {} as ProcessingDeps;
    expect(
      withCrossSourceTally(deps, { candidatesConsidered: 1, jobsDispatched: 1, degraded: false }),
    ).toBe(deps);
  });
});
