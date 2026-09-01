import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';

/**
 * The shared-pipeline adapter is recorded rather than executed: these tests own
 * the composition root's wiring (is the adapter reached, with which context and
 * which deps bag), while the adapter's own behavior is covered beside it in
 * `pipeline/internal-event-pipeline.test.ts`.
 */
const adapter = vi.hoisted(() => ({
  calls: [] as Array<{ decision: unknown; lockFile: unknown; ctx: any; deps: unknown }>,
}));

vi.mock('./pipeline/internal-event-pipeline.js', () => ({
  dispatchInternalEventViaPipeline: async (
    decision: unknown,
    lockFile: unknown,
    ctx: any,
    deps: unknown,
  ) => {
    adapter.calls.push({ decision, lockFile, ctx, deps });
    return { runId: 'run-1', repo: ctx.repoIdentifier, workflow: 'notify' };
  },
}));

import {
  upstreamBaseNamesFromNeeds,
  buildMatrixOutputsEnvelope,
  buildHostOutputsEnvelope,
  buildUpstreamOutputsByBase,
  buildUpstreamStatusesByBase,
  buildOnEventMatched,
  buildSummonCallback,
  gatherInvokeResults,
  mergeUpstreamOutputs,
} from './orchestrator-core.js';
import { SummonRefusedError } from './pipeline/invoke-gate.js';
import type { Database } from './db/types.js';

describe('upstreamBaseNamesFromNeeds', () => {
  it('returns [] for undefined / non-array', () => {
    expect(upstreamBaseNamesFromNeeds(undefined)).toEqual([]);
    expect(upstreamBaseNamesFromNeeds(null)).toEqual([]);
    expect(upstreamBaseNamesFromNeeds('test')).toEqual([]);
  });

  it('passes through string needs', () => {
    expect(upstreamBaseNamesFromNeeds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('extracts the name from NeedsEntry objects (fixes the string-assumption bug)', () => {
    expect(upstreamBaseNamesFromNeeds([{ name: 'test', runOn: ['failed'] }])).toEqual(['test']);
  });

  it('skips NeedsGroupEntry objects (resolved by the scheduler)', () => {
    expect(upstreamBaseNamesFromNeeds([{ group: 'deploys', runOn: ['success'] }])).toEqual([]);
  });

  it('handles a mix of strings and objects', () => {
    expect(
      upstreamBaseNamesFromNeeds(['lint', { name: 'test', runOn: ['failed'] }, { group: 'g' }]),
    ).toEqual(['lint', 'test']);
  });
});

describe('buildMatrixOutputsEnvelope', () => {
  it('keys byMatrix by the suffix and merges last-write-wins in name order', () => {
    const env = buildMatrixOutputsEnvelope('test', [
      { job_name: 'test (b)', parsed: { v: '2', only_b: 'yes' } },
      { job_name: 'test (a)', parsed: { v: '1' } },
    ]);
    expect(env.byMatrix).toEqual({ a: { v: '1' }, b: { v: '2', only_b: 'yes' } });
    // name order is a, b -> b wins on `v`.
    expect(env.merged).toEqual({ v: '2', only_b: 'yes' });
  });

  it('keeps a child whose matrix value is literally __proto__', () => {
    // `byMatrix[suffix] = …` would run the inherited setter and drop the child.
    const env = buildMatrixOutputsEnvelope('test', [
      { job_name: 'test (__proto__)', parsed: { v: '1' } },
      { job_name: 'test (linux)', parsed: { v: '2' } },
    ]);
    expect(Object.keys(env.byMatrix).sort()).toEqual(['__proto__', 'linux']);
    expect(env.byMatrix['__proto__']).toEqual({ v: '1' });
  });
});

describe('buildHostOutputsEnvelope', () => {
  it('keys byHost, records succeeded/failed hosts, and arrays outputs across hosts', () => {
    const env = buildHostOutputsEnvelope([
      { host: 'web-02', status: 'failed', parsed: { v: '2' } },
      { host: 'web-01', status: 'success', parsed: { v: '1' } },
    ]);
    expect(env.byHost).toEqual({ 'web-01': { v: '1' }, 'web-02': { v: '2' } });
    expect(env.summary.succeededHosts).toEqual(['web-01']);
    expect(env.summary.failedHosts).toEqual(['web-02']);
    // host order (web-01, web-02) -> array view, never a collapsing scalar.
    expect(env.summary.outputs).toEqual({ v: ['1', '2'] });
  });
});

describe('buildUpstreamOutputsByBase', () => {
  it('builds the byHost envelope for a runsOnAll upstream', () => {
    const out = buildUpstreamOutputsByBase(
      ['patch'],
      [
        {
          job_name: 'patch (web-01)',
          outputs: JSON.stringify({ v: '1' }),
          matrix_values: null,
          variant_kind: 'host',
          variant_label: 'web-01',
          status: 'success',
        },
        {
          job_name: 'patch (web-02)',
          outputs: JSON.stringify({ v: '2' }),
          matrix_values: null,
          variant_kind: 'host',
          variant_label: 'web-02',
          status: 'failed',
        },
      ],
    );
    expect(out).toEqual({
      patch: {
        byHost: { 'web-01': { v: '1' }, 'web-02': { v: '2' } },
        summary: {
          succeededHosts: ['web-01'],
          failedHosts: ['web-02'],
          outputs: { v: ['1', '2'] },
        },
      },
    });
  });

  it('builds the byMatrix/merged envelope for a fanned upstream', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [
        {
          job_name: 'test (a)',
          outputs: JSON.stringify({ v: '1' }),
          matrix_values: '{"variant":"a"}',
        },
        {
          job_name: 'test (b)',
          outputs: JSON.stringify({ v: '2' }),
          matrix_values: '{"variant":"b"}',
        },
      ],
    );
    expect(out).toEqual({
      test: { byMatrix: { a: { v: '1' }, b: { v: '2' } }, merged: { v: '2' } },
    });
  });

  it('keeps the flat shape for a non-fanned upstream', () => {
    const out = buildUpstreamOutputsByBase('build'.length ? ['build'] : [], [
      { job_name: 'build', outputs: JSON.stringify({ artifact: 'x' }), matrix_values: null },
    ]);
    expect(out).toEqual({ build: { artifact: 'x' } });
  });

  it('returns undefined when no upstream produced outputs', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [{ job_name: 'test', outputs: null, matrix_values: null }],
    );
    expect(out).toBeUndefined();
  });

  it('does not over-match a different base via prefix', () => {
    const out = buildUpstreamOutputsByBase(
      ['test'],
      [
        { job_name: 'test (a)', outputs: JSON.stringify({ v: '1' }), matrix_values: '{"x":"a"}' },
        { job_name: 'tests (a)', outputs: JSON.stringify({ v: 'X' }), matrix_values: '{"x":"a"}' },
      ],
    );
    expect(out).toEqual({ test: { byMatrix: { a: { v: '1' } }, merged: { v: '1' } } });
  });
});

describe('buildUpstreamStatusesByBase', () => {
  it('keys each upstream row by job_name', () => {
    const out = buildUpstreamStatusesByBase([
      { job_name: 'build', status: 'success' },
      { job_name: 'probe', status: 'failed' },
    ]);
    expect(out).toEqual({ build: 'success', probe: 'failed' });
  });

  it('records per-child statuses for a fanned-out upstream', () => {
    const out = buildUpstreamStatusesByBase([
      { job_name: 'test (a)', status: 'success' },
      { job_name: 'test (b)', status: 'skipped' },
    ]);
    expect(out).toEqual({ 'test (a)': 'success', 'test (b)': 'skipped' });
  });

  it('skips rows with no status and returns undefined when none have one', () => {
    expect(buildUpstreamStatusesByBase([{ job_name: 'x', status: null }])).toBeUndefined();
  });
});

/**
 * Fluent Kysely stub for `mergeUpstreamOutputs` / `gatherInvokeResults`. Returns
 * seeded rows per table; both `execution_jobs` queries hit the same table, so it
 * discriminates the proxy-children query (which filters `job_kind`) from the
 * upstream-outputs query by inspecting the recorded where-clauses.
 */
function stubDb(seed: {
  /** Rows returned by the `job_kind = Gate` seed query (each is a gate's own row). */
  gates?: Array<{ job_name: string | null }>;
  proxies?: Array<{
    base_job_name: string | null;
    summoned_run_id: string | null;
    status: string | null;
    outputs: string | null;
  }>;
  runs?: Array<{ run_id: string; repo_identifier: string; workflow_name: string }>;
  upstreamJobs?: Array<{
    job_id: string;
    job_name: string;
    outputs: unknown;
    matrix_values: unknown;
    variant_kind?: string | null;
    variant_label?: string | null;
    status?: string | null;
  }>;
}): Kysely<Database> {
  const makeChain = (table: string) => {
    const whereArgs: unknown[][] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      selectAll: () => chain,
      where: (...args: unknown[]) => {
        whereArgs.push(args);
        return chain;
      },
      orderBy: () => chain,
      execute: async () => {
        if (table === 'execution_jobs') {
          const kindArg = whereArgs.find((a) => a[0] === 'job_kind');
          if (kindArg?.[2] === 'gate') return seed.gates ?? [];
          if (kindArg?.[2] === 'proxy') return seed.proxies ?? [];
          return seed.upstreamJobs ?? [];
        }
        if (table === 'execution_runs') return seed.runs ?? [];
        return []; // run_secret_outputs — none in these tests
      },
    };
    return chain;
  };
  return { selectFrom: (t: string) => makeChain(t) } as unknown as Kysely<Database>;
}

describe('gatherInvokeResults (moved into orchestrator-core)', () => {
  it('maps a gate’s proxy children to InvokeResult[] keyed by gate name', async () => {
    const db = stubDb({
      proxies: [
        {
          base_job_name: 'repo-tests',
          summoned_run_id: 'r1',
          status: 'success',
          outputs: JSON.stringify({ coverage: '92' }),
        },
      ],
      runs: [{ run_id: 'r1', repo_identifier: 'myorg/backend', workflow_name: 'unit' }],
    });
    const res = await gatherInvokeResults(db, 'gate-run', ['repo-tests']);
    expect(res['repo-tests'][0]).toMatchObject({
      repo: 'myorg/backend',
      workflow: 'unit',
      runId: 'r1',
      status: 'success',
    });
    expect(res['repo-tests'][0].outputs.coverage).toBe('92');
  });

  it('yields an empty InvokeResult[] for a gate that summoned zero subscribers', async () => {
    // An optional gate whose source repos all opted out has a `job_kind = Gate`
    // row but no proxy children. `.result` must stay an (empty) array, not fall
    // through to the plain single-job outputs shape.
    const db = stubDb({ gates: [{ job_name: 'repo-tests' }], proxies: [] });
    const res = await gatherInvokeResults(db, 'gate-run', ['repo-tests']);
    expect(res['repo-tests']).toEqual([]);
    expect(Array.isArray(res['repo-tests'])).toBe(true);
  });

  it('does not seed a regular (non-gate) upstream job', async () => {
    // Only a Gate row seeds a key; a declared need that is a regular job keeps
    // resolving through the normal outputs path (no invoke key at all).
    const db = stubDb({ gates: [], proxies: [] });
    const res = await gatherInvokeResults(db, 'run', ['not-a-gate']);
    expect(res).toEqual({});
  });
});

describe('mergeUpstreamOutputs invoke gate', () => {
  it('builds upstreamInvokeResults for a gate upstream declared in needs', async () => {
    const db = stubDb({
      proxies: [
        {
          base_job_name: 'repo-tests',
          summoned_run_id: 'r1',
          status: 'success',
          outputs: JSON.stringify({ coverage: '92' }),
        },
        {
          base_job_name: 'repo-tests',
          summoned_run_id: 'r2',
          status: 'failed',
          outputs: null,
        },
      ],
      runs: [
        { run_id: 'r1', repo_identifier: 'myorg/backend', workflow_name: 'unit' },
        { run_id: 'r2', repo_identifier: 'myorg/backend', workflow_name: 'lint' },
      ],
      // The gate row + its proxy children as they appear to the upstream-outputs
      // query; the gate itself produces no outputs.
      upstreamJobs: [{ job_id: 'g', job_name: 'repo-tests', outputs: null, matrix_values: null }],
    });
    const { upstreamInvokeResults, upstreamJobOutputs } = await mergeUpstreamOutputs(
      db,
      'gate-run',
      'deploy',
      ['repo-tests'],
      undefined,
      'a'.repeat(64),
    );
    expect(upstreamInvokeResults).toBeDefined();
    expect(upstreamInvokeResults!['repo-tests'].map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(upstreamInvokeResults!['repo-tests'].map((r) => r.status)).toEqual([
      'success',
      'failed',
    ]);
    expect(upstreamInvokeResults!['repo-tests'][0].outputs.coverage).toBe('92');
    // The gate itself contributes no plain outputs.
    expect(upstreamJobOutputs?.['repo-tests']).toBeUndefined();
  });

  it('returns undefined upstreamInvokeResults when no need names a gate', async () => {
    const db = stubDb({
      upstreamJobs: [
        { job_id: 'b', job_name: 'build', outputs: JSON.stringify({ v: 1 }), matrix_values: null },
      ],
    });
    const { upstreamInvokeResults } = await mergeUpstreamOutputs(
      db,
      'run',
      'deploy',
      ['build'],
      undefined,
      'a'.repeat(64),
    );
    expect(upstreamInvokeResults).toBeUndefined();
  });
});

/**
 * Both internal-event entry points dispatch through the SHARED pipeline
 * adapter, so a `kiciEvent()` subscriber, a cron fire and an invoke-gate summon
 * all resolve their bound contexts, scoped secrets and protection rules exactly
 * as a webhook-triggered run does.
 */
describe('internal-event dispatch entry points', () => {
  beforeEach(() => {
    adapter.calls.length = 0;
  });

  const dispatcherRef = { current: {} as never };
  const bundle = { repoUrlBuilder: { buildCloneUrl: (r: string) => `https://git/${r}.git` } };
  const providerRegistryRef = {
    current: { getByRoutingKey: () => bundle } as never,
  };
  const lockFile = { workflows: [{ name: 'notify' }] };
  const decision = { workflowName: 'notify' };

  /** A ProcessingDeps factory whose identity the assertions can recognize. */
  const depsFactory = () => ({ marker: 'live-deps' }) as never;

  it('dispatches a matched internal event through the shared pipeline', async () => {
    const onEventMatched = buildOnEventMatched(dispatcherRef, providerRegistryRef, {
      current: depsFactory,
    });

    await onEventMatched(
      { id: 'evt-1', eventName: 'kici.scaler.scale-up', payload: {} },
      lockFile,
      [decision],
      {
        routingKey: 'github:1',
        repoIdentifier: 'acme/infra',
        providerContext: { installationId: 77 },
      },
    );

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].decision).toBe(decision);
    expect(adapter.calls[0].lockFile).toBe(lockFile);
    expect(adapter.calls[0].ctx.event.eventName).toBe('kici.scaler.scale-up');
    // The provider bundle reaches the adapter. Without it every job dispatches
    // with an empty repo URL AND the run is classified as a local-working-tree
    // dispatch, so the workflow source can never be materialized.
    expect(adapter.calls[0].ctx.bundle).toBe(bundle);
    expect(adapter.calls[0].ctx.providerContext).toEqual({ installationId: 77 });
    // The factory is invoked per dispatch, so the bag is always the live one.
    expect(adapter.calls[0].deps).toEqual({ marker: 'live-deps' });
  });

  /**
   * The dispatch loop wraps each decision in try/catch, so an unpopulated ref
   * that returned early would swallow EVERY internally triggered run behind a
   * debug line — a cron schedule that silently never fires. Throwing is what
   * makes the mis-wiring visible.
   */
  it('fails loudly when no ProcessingDeps factory is wired', async () => {
    const onEventMatched = buildOnEventMatched(dispatcherRef, providerRegistryRef, {
      current: null,
    });

    await expect(
      onEventMatched({ id: 'evt-1', eventName: 'x', payload: {} }, lockFile, [decision]),
    ).rejects.toThrow(/ProcessingDeps/);
    expect(adapter.calls).toHaveLength(0);
  });

  const eventRouter = {
    matchKiciEventSubscribers: () => [
      {
        reg: {
          routingKey: 'github:1',
          repoIdentifier: 'acme/infra',
          providerContext: { installationId: 99 },
        },
        lockFile,
        decisions: [decision],
      },
    ],
  } as never;

  it('summons a source-repo subscriber through the same shared pipeline', async () => {
    const summon = buildSummonCallback(dispatcherRef, providerRegistryRef, eventRouter, {
      current: depsFactory,
    });

    const spawned = await summon({
      event: 'acme.deploy.requested',
      payload: { env: 'stg' },
      sourceRepo: 'acme/infra',
      chainDepth: 3,
      summonedByRunId: 'gate-run',
    });

    expect(adapter.calls).toHaveLength(1);
    // The summoner's depth reaches the adapter so the chain-depth circuit
    // breaker still bounds recursion.
    expect(adapter.calls[0].ctx.chainDepth).toBe(3);
    // Same two fields the summon path used to lose silently.
    expect(adapter.calls[0].ctx.bundle).toBe(bundle);
    expect(adapter.calls[0].ctx.providerContext).toEqual({ installationId: 99 });
    expect(spawned).toEqual([{ runId: 'run-1', repo: 'acme/infra', workflow: 'notify' }]);
  });

  /**
   * The composition root's own stop on the reservation. `runInvokeGate` refuses
   * a reserved gate name first, but this callback is injected — it does not
   * inherit that check — and it is what actually reaches the dispatch adapter.
   * A `kici.`-named gate would forge a scaler event; a `__`-named one would
   * summon a run the trust classifier could read as orchestrator-minted.
   *
   * It THROWS rather than returning `[]`: a gate carrying `optional: true`
   * reads zero summoned runs as a green skip, so a refusal returned as an empty
   * array would report success for work that was declined — which is what would
   * happen if the two reservation checks were ever reordered.
   */
  it.each([['__schedule_fire'], ['kici.scaler.scale-up']])(
    'refuses to summon for the reserved event name %s',
    async (event) => {
      const summon = buildSummonCallback(dispatcherRef, providerRegistryRef, eventRouter, {
        current: depsFactory,
      });

      await expect(
        summon({
          event,
          sourceRepo: 'acme/infra',
          chainDepth: 0,
          summonedByRunId: 'gate-run',
        }),
      ).rejects.toThrow(SummonRefusedError);

      expect(adapter.calls).toHaveLength(0);
    },
  );

  it('returns an empty array — not a throw — when the event matches no subscriber', async () => {
    // The control for the pair above: an empty result is still a real outcome,
    // and a gate may legitimately declare it `optional`. Only a REFUSAL throws.
    const noSubscribers = { matchKiciEventSubscribers: () => [] } as never;
    const summon = buildSummonCallback(dispatcherRef, providerRegistryRef, noSubscribers, {
      current: depsFactory,
    });

    const spawned = await summon({
      event: 'acme.nobody.subscribes',
      sourceRepo: 'acme/infra',
      chainDepth: 0,
      summonedByRunId: 'gate-run',
    });

    expect(spawned).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });

  it('fails loudly when the summon path has no ProcessingDeps factory wired', async () => {
    const summon = buildSummonCallback(dispatcherRef, providerRegistryRef, eventRouter, {
      current: null,
    });

    await expect(
      summon({
        event: 'acme.deploy.requested',
        sourceRepo: 'acme/infra',
        chainDepth: 0,
        summonedByRunId: 'gate-run',
      }),
    ).rejects.toThrow(/ProcessingDeps/);
    expect(adapter.calls).toHaveLength(0);
  });
});
