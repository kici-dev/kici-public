/**
 * Metering of the Tier-2 global eval round.
 *
 * The round decides which global workflows run at all, and it does so on an
 * agent — so without these counters an operator cannot tell a wave of
 * deliberate `filter` exclusions from a fleet-wide round failure, and cannot
 * tell a cache that is answering from one that is never even consulted.
 *
 * The instruments are mocked at the module boundary because the real ones are
 * lazily-bound OTel counters whose recorded values are not readable without a
 * MeterProvider — the assertion here is about what the round decided to record.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LockWorkflow } from '@kici-dev/engine';

const globalEvalCandidatesTotal = { add: vi.fn() };
const globalEvalVerdictsTotal = { add: vi.fn() };
const globalEvalCacheLookupsTotal = { add: vi.fn() };
const globalEvalRoundDurationSeconds = { record: vi.fn() };
const globalEvalJobsGenerated = { record: vi.fn() };

vi.mock('../metrics/prometheus.js', () => ({
  globalEvalCandidatesTotal,
  globalEvalVerdictsTotal,
  globalEvalCacheLookupsTotal,
  globalEvalRoundDurationSeconds,
  globalEvalJobsGenerated,
}));

const {
  runGlobalEvalRounds,
  recordUnrunCandidates,
  GlobalEvalVerdictOutcome,
  GlobalEvalRoundResultLabel,
  GlobalEvalCacheLookupResult,
} = await import('./global-eval-round.js');
const { GlobalEvalRoundCache } = await import('../cache/global-eval-round-cache.js');
const { PendingGlobalEvalTracker } = await import('../cache/pending-global-evals.js');

type RoundArgs = Parameters<typeof runGlobalEvalRounds>[0];

function candidate(name: string, id: string, hasFilter = true) {
  return {
    reg: {
      id,
      repoIdentifier: 'org/pipelines',
      workflowName: name,
      lockEntry: {
        name,
        triggers: [],
        jobs: [],
        source: { file: 'w.ts' },
      } as unknown as LockWorkflow,
      triggerTypes: ['push'],
      routingKey: 'github:1',
      providerContext: {},
      disabled: false,
      isGlobal: true,
      customerId: 'cust-1',
      commitSha: 'sha1',
      sourceFile: 'w.ts',
    },
    lockEntry: {
      name,
      triggers: [],
      jobs: [],
      hasFilter,
      source: { file: 'w.ts' },
    } as unknown as LockWorkflow,
  } as RoundArgs['candidates'][number];
}

/** A dispatcher that replies with a fixed round result on the next macrotask. */
function harness(reply: unknown) {
  const pendingGlobalEvals = new PendingGlobalEvalTracker();
  let seq = 0;
  return {
    pendingGlobalEvals,
    dispatcher: {
      dispatch: vi.fn(async () => {
        const jobId = `job-${++seq}`;
        setTimeout(() => pendingGlobalEvals.resolve(jobId, reply as never), 0);
        return { status: 'dispatched', jobId };
      }),
    },
  };
}

function roundArgs(
  candidates: RoundArgs['candidates'],
  h: ReturnType<typeof harness>,
  extra: Partial<RoundArgs['deps']> = {},
  event: unknown = { type: 'push', targetBranch: 'main' },
): RoundArgs {
  return {
    deps: {
      dispatcher: h.dispatcher,
      pendingGlobalEvals: h.pendingGlobalEvals,
      providerRegistry: { getByRoutingKey: () => undefined },
      ...extra,
    } as RoundArgs['deps'],
    info: {
      deliveryId: 'delivery-1',
      provider: 'github',
      routingKey: 'github:1',
    } as RoundArgs['info'],
    event: event as RoundArgs['event'],
    candidates,
    repoIdentifier: 'org/app',
    ref: 'source-sha',
    dispatchBundle: {
      repoUrlBuilder: { buildCloneUrl: (r: string) => `https://git.example.com/${r}.git` },
    } as unknown as RoundArgs['dispatchBundle'],
    dispatchCredentials: { token: 't' },
    config: {
      globalEvalRoundTimeoutMs: 1_000,
      globalEvalCandidateTimeoutMs: 500,
      globalEvalWaitTimeoutMs: 5_000,
    },
  };
}

/** Every label value a mocked instrument's calls carried under `key`. */
function labelValues(fn: ReturnType<typeof vi.fn>, key: string): string[] {
  return fn.mock.calls.map((call) => (call[1] as Record<string, string>)?.[key]);
}

describe('global eval round metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts the candidates entering a round', async () => {
    const h = harness({
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: true },
      ],
    });

    await runGlobalEvalRounds(roundArgs([candidate('a', 'reg-a'), candidate('b', 'reg-b')], h));

    expect(globalEvalCandidatesTotal.add).toHaveBeenCalledWith(2);
  });

  it('records nothing at all when there are no candidates', async () => {
    // The denominator must not gain a zero sample for a delivery that never
    // reached the round — that is what makes "candidates entered" readable.
    await runGlobalEvalRounds(roundArgs([], harness({ candidates: [] })));

    expect(globalEvalCandidatesTotal.add).not.toHaveBeenCalled();
    expect(globalEvalRoundDurationSeconds.record).not.toHaveBeenCalled();
  });

  it('separates a filter exclusion from a verdict nobody gave', async () => {
    const h = harness({
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: false },
        // 'c' is deliberately absent: an unreported candidate is indeterminate,
        // never a clean "does not apply".
      ],
    });

    await runGlobalEvalRounds(
      roundArgs([candidate('a', 'reg-a'), candidate('b', 'reg-b'), candidate('c', 'reg-c')], h),
    );

    expect(labelValues(globalEvalVerdictsTotal.add, 'outcome').sort()).toEqual([
      GlobalEvalVerdictOutcome.Filtered,
      GlobalEvalVerdictOutcome.Indeterminate,
      GlobalEvalVerdictOutcome.Run,
    ]);
  });

  it('records a settled round as a success with its generated job count', async () => {
    const h = harness({
      candidates: [{ workflowName: 'a', run: true, jobs: [{ name: 'gen-1' }, { name: 'gen-2' }] }],
    });

    await runGlobalEvalRounds(roundArgs([candidate('a', 'reg-a')], h));

    expect(labelValues(globalEvalRoundDurationSeconds.record, 'result')).toEqual([
      GlobalEvalRoundResultLabel.Success,
    ]);
    expect(globalEvalJobsGenerated.record).toHaveBeenCalledWith(2);
  });

  it('records a round that decided nothing as an error, with no job sample', async () => {
    const h = harness({
      candidates: [{ workflowName: 'a', run: false, indeterminate: true, reason: 'budget' }],
    });

    await runGlobalEvalRounds(roundArgs([candidate('a', 'reg-a')], h));

    // Two attempts, both errors — the retry ladder is part of what the duration
    // distribution has to show.
    expect(labelValues(globalEvalRoundDurationSeconds.record, 'result')).toEqual([
      GlobalEvalRoundResultLabel.Error,
      GlobalEvalRoundResultLabel.Error,
    ]);
    expect(globalEvalJobsGenerated.record).not.toHaveBeenCalled();
  });

  it('counts a cache miss and then a hit for the same input', async () => {
    const cache = new GlobalEvalRoundCache({ max: 8 });
    const reply = { candidates: [{ workflowName: 'a', run: true }] };

    await runGlobalEvalRounds(
      roundArgs([candidate('a', 'reg-a')], harness(reply), { globalEvalCache: cache }),
    );
    await runGlobalEvalRounds(
      roundArgs([candidate('a', 'reg-a')], harness(reply), { globalEvalCache: cache }),
    );

    expect(labelValues(globalEvalCacheLookupsTotal.add, 'result')).toEqual([
      GlobalEvalCacheLookupResult.Miss,
      GlobalEvalCacheLookupResult.Hit,
    ]);
  });

  it('counts an unserializable input as a third outcome, not as a miss', async () => {
    // A lookup that never reaches the cache is neither a hit nor a miss.
    // Counting only two outcomes would drop it from the denominator and make
    // the hit rate read higher than it is.
    const circular: Record<string, unknown> = { type: 'push', targetBranch: 'main' };
    circular.self = circular;
    const cache = new GlobalEvalRoundCache({ max: 8 });

    await runGlobalEvalRounds(
      roundArgs(
        [candidate('a', 'reg-a')],
        harness({ candidates: [{ workflowName: 'a', run: true }] }),
        { globalEvalCache: cache },
        circular,
      ),
    );

    expect(labelValues(globalEvalCacheLookupsTotal.add, 'result')).toEqual([
      GlobalEvalCacheLookupResult.Unkeyable,
    ]);
  });

  it('counts no lookup at all when no cache is configured', async () => {
    await runGlobalEvalRounds(
      roundArgs(
        [candidate('a', 'reg-a')],
        harness({ candidates: [{ workflowName: 'a', run: true }] }),
      ),
    );

    expect(globalEvalCacheLookupsTotal.add).not.toHaveBeenCalled();
  });
});

describe('candidates a round never ran for', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The fail-closed skip — no pending-eval tracker, so a round could never
   * settle — suppresses EVERY global workflow for a delivery. It returns before
   * `runGlobalEvalRounds` is reached, so nothing inside the round can meter it,
   * and it used to leave a single `logger.warn` as its whole record.
   */
  it('counts them as entered and as indeterminate', () => {
    recordUnrunCandidates(3);

    expect(globalEvalCandidatesTotal.add).toHaveBeenCalledWith(3);
    expect(globalEvalVerdictsTotal.add).toHaveBeenCalledWith(3, {
      outcome: GlobalEvalVerdictOutcome.Indeterminate,
    });
  });

  it('records nothing for an empty set', () => {
    recordUnrunCandidates(0);

    expect(globalEvalCandidatesTotal.add).not.toHaveBeenCalled();
    expect(globalEvalVerdictsTotal.add).not.toHaveBeenCalled();
  });

  it('keeps candidates equal to the sum of verdicts on a normal round', async () => {
    // The invariant the metric's own JSDoc now claims. Asserting it here is
    // what stops the doc from drifting back into the false "not derivable"
    // form: if a future path emits one without the other, this fails.
    const h = harness({
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: false },
      ],
    });

    await runGlobalEvalRounds(
      roundArgs([candidate('a', 'reg-a'), candidate('b', 'reg-b'), candidate('c', 'reg-c')], h),
    );

    const entered = globalEvalCandidatesTotal.add.mock.calls.reduce(
      (sum, call) => sum + (call[0] as number),
      0,
    );
    const verdicts = globalEvalVerdictsTotal.add.mock.calls.reduce(
      (sum, call) => sum + (call[0] as number),
      0,
    );
    expect(entered).toBe(3);
    expect(verdicts).toBe(entered);
  });
});
