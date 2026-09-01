/**
 * Tests for the release wiring behind the local held-run decision surface.
 *
 * The defect class this factory exists to catch is a MISSING field, so the
 * assertions are about which fields the bag carries and what each one reaches —
 * not about an algorithm. Two of them are load-bearing:
 *
 * - No `onJobRelease` ⇒ NO bag at all, which leaves the decision route
 *   unmounted rather than mounted with a release that dispatches nothing.
 * - Both callbacks read the processing-deps bag at CALL time. A captured bag
 *   would resolve a check poster out of a provider registry that a source
 *   reload has since replaced.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcessingDeps } from '../pipeline/processor.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';
import type { HeldRun } from '../db/types.js';
import { buildHeldRunRelease, DEFAULT_LOCAL_REJECT_REASON } from './held-run-release-wiring.js';

const rejectWorkflow = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../pipeline/resume-workflow.js', () => ({ rejectWorkflow }));

const SIGNAL = { holdId: 'h', runId: 'r', jobId: 'j' } as ReleaseSignal;
const HOLD = { id: 'h', run_id: 'r' } as HeldRun;

/** A processing-deps bag whose provider registry answers for one routing key. */
function makeDeps(posterName: string): ProcessingDeps {
  return {
    db: { tag: 'db' },
    providerRegistry: {
      getByRoutingKey: (key: string) =>
        key === 'github:1' ? { checkStatusPoster: { name: posterName } } : undefined,
    },
  } as unknown as ProcessingDeps;
}

describe('buildHeldRunRelease', () => {
  it('produces no bag at all without a job-release callback', () => {
    expect(buildHeldRunRelease({ buildProcessingDeps: () => makeDeps('a') })).toBeUndefined();
  });

  it('passes the two mode-hook callbacks through untouched', async () => {
    const onJobRelease = vi.fn(async () => {});
    const onWorkflowRelease = vi.fn(async () => {});
    const bag = buildHeldRunRelease({
      onJobRelease,
      onWorkflowRelease,
      buildProcessingDeps: () => makeDeps('a'),
    })!;
    await bag.onJobRelease(SIGNAL);
    await bag.onWorkflowRelease!(SIGNAL);
    expect(onJobRelease).toHaveBeenCalledWith(SIGNAL);
    expect(onWorkflowRelease).toHaveBeenCalledWith(SIGNAL);
  });

  it('omits the workflow release when no mode hook supplied one', () => {
    const bag = buildHeldRunRelease({
      onJobRelease: vi.fn(async () => {}),
      buildProcessingDeps: () => makeDeps('a'),
    })!;
    expect(bag.onWorkflowRelease).toBeUndefined();
    // The reject arm is built here rather than supplied, so it is always present.
    expect(bag.onWorkflowReject).toBeDefined();
  });

  it('cancels a rejected workflow hold through the live bag, keeping the caller’s reason', async () => {
    rejectWorkflow.mockClear();
    const bag = buildHeldRunRelease({
      onJobRelease: vi.fn(async () => {}),
      buildProcessingDeps: () => makeDeps('a'),
    })!;
    await bag.onWorkflowReject!(HOLD, 'operator said no');
    expect(rejectWorkflow).toHaveBeenCalledTimes(1);
    const [hold, procDeps, db, reason] = rejectWorkflow.mock.calls[0] as unknown[];
    expect(hold).toBe(HOLD);
    expect(reason).toBe('operator said no');
    // The db handed to `rejectWorkflow` is the one ON the bag, not a second
    // handle: a mismatch is how a cancel writes to a different connection than
    // the dispatch it is undoing.
    expect(db).toBe((procDeps as ProcessingDeps).db);
  });

  it('falls back to a scope-neutral reason when the operator gave none', async () => {
    rejectWorkflow.mockClear();
    const bag = buildHeldRunRelease({
      onJobRelease: vi.fn(async () => {}),
      buildProcessingDeps: () => makeDeps('a'),
    })!;
    await bag.onWorkflowReject!(HOLD, undefined);
    expect(rejectWorkflow.mock.calls[0][3]).toBe(DEFAULT_LOCAL_REJECT_REASON);
  });

  it('resolves the check poster from the CURRENT registry, not one captured at build time', () => {
    let current = makeDeps('old-poster');
    const bag = buildHeldRunRelease({
      onJobRelease: vi.fn(async () => {}),
      buildProcessingDeps: () => current,
    })!;
    expect(bag.resolveCheckStatusPoster!('github:1')).toMatchObject({ name: 'old-poster' });
    // A source reload swaps the registry. A bag captured at build time would
    // keep answering `old-poster` here.
    current = makeDeps('new-poster');
    expect(bag.resolveCheckStatusPoster!('github:1')).toMatchObject({ name: 'new-poster' });
    expect(bag.resolveCheckStatusPoster!('github:missing')).toBeUndefined();
  });
});

describe('app.ts wiring seam', () => {
  const source = readFileSync(fileURLToPath(new URL('../app.ts', import.meta.url)), 'utf8');

  it('hands the bag to createAdminRoutes, built from the mode hook’s own callbacks', () => {
    // A factory nothing calls changes nothing. `createApp` is a composition
    // root no test instantiates, so this seam is asserted against the source —
    // the same shape `independent-wiring.test.ts` uses for `standalone.ts`.
    const call = source.slice(source.indexOf('createAdminRoutes({'));
    const body = call.slice(0, call.indexOf('\n      }),'));
    expect(body).toContain('heldRunRelease: buildHeldRunRelease({');
    // Both callbacks come off the deps bag the mode hooks populate through
    // `appDepsExtras`. A hand-rolled second pair here could diverge from the
    // ones the stale detector and the dashboard applier already use.
    expect(body).toContain('onJobRelease: deps.onJobRelease');
    expect(body).toContain('onWorkflowRelease: deps.onWorkflowRelease');
    expect(body).toContain('buildProcessingDeps,');
  });
});
