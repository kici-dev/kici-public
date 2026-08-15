import { describe, it, expect, afterEach } from 'vitest';
import type { Job, Workflow, FilterContext, DynamicJobContext } from '@kici-dev/sdk';
import { runGlobalEvalRound, type GlobalEvalRoundArgs } from './global-eval-runner.js';
import { GLOBAL_WORKFLOW_ENV_KEYS } from './global-workflow-env.js';
import { buildEvalShell } from './job-runner.js';

// --- Fixtures -------------------------------------------------------------

const repos = {
  sourceRepo: { identifier: 'o/src', path: '/w/source', ref: 'main', sha: 'aaa' },
  workflowRepo: { identifier: 'o/wf', path: '/w/workflow', ref: 'main', sha: 'bbb' },
};

/**
 * A bare `job('name', { steps })` throws (`one of runsOn or runsOnAll is
 * required`), so every generated fixture job carries a `runsOn`.
 */
function makeJob(name: string): Job {
  return { _tag: 'Job', name, runsOn: 'ubuntu', steps: [] };
}

function makeWorkflow(overrides: Partial<Workflow> & { name: string }): Workflow {
  return { _tag: 'Workflow', jobs: [], ...overrides } as Workflow;
}

/**
 * Build the round args around a set of workflows, each keyed by the source file
 * it "lives in". The module loader seam replaces the real filesystem import, so
 * these tests exercise the round's own logic without a checkout.
 */
function argsFor(
  modules: Record<string, Workflow[]>,
  candidates: GlobalEvalRoundArgs['candidates'],
  overrides: Partial<GlobalEvalRoundArgs> = {},
): GlobalEvalRoundArgs {
  const loads: string[] = [];
  return {
    workflowDir: '/w/workflow',
    sourceDir: '/w/source',
    repos,
    candidates,
    event: { type: 'push', targetBranch: 'main' },
    changedFiles: [],
    changedFilesStatus: 'fetched',
    roundTimeoutMs: 120_000,
    candidateTimeoutMs: 20_000,
    loadModule: async (sourceFile) => {
      loads.push(sourceFile);
      const found = modules[sourceFile];
      if (!found) throw new Error(`no stub module for ${sourceFile}`);
      return { default: found, __loads: loads } as unknown as Record<string, unknown>;
    },
    ...overrides,
  };
}

// Imported, not re-spelled: a key added to the writer and missed here would
// leave the round's env-restore assertions silently incomplete.
const GLOBAL_ENV_KEYS: readonly string[] = GLOBAL_WORKFLOW_ENV_KEYS;

afterEach(() => {
  for (const key of GLOBAL_ENV_KEYS) delete process.env[key];
});

// --- Tests ----------------------------------------------------------------

describe('runGlobalEvalRound', () => {
  it('reports run:false for a candidate whose filter returns false', async () => {
    const wf = makeWorkflow({ name: 'a', filter: () => false });
    const result = await runGlobalEvalRound(
      argsFor({ 'a.ts': [wf] }, [{ workflowName: 'a', sourceFile: 'a.ts', hasFilter: true }]),
    );

    expect(result.candidates).toEqual([{ workflowName: 'a', run: false }]);
  });

  it('reports run:true with no jobs key for a static survivor', async () => {
    const wf = makeWorkflow({ name: 'a', filter: () => true, jobs: [makeJob('static')] });
    const result = await runGlobalEvalRound(
      argsFor({ 'a.ts': [wf] }, [{ workflowName: 'a', sourceFile: 'a.ts', hasFilter: true }]),
    );

    expect(result.candidates).toEqual([{ workflowName: 'a', run: true }]);
    expect('jobs' in result.candidates[0]).toBe(false);
  });

  it('returns generated jobs for a survivor with a DynamicJobFn', async () => {
    const wf = makeWorkflow({
      name: 'b',
      filter: () => true,
      jobs: [async () => [makeJob('ci-test'), makeJob('ci-build')]],
    });
    const result = await runGlobalEvalRound(
      argsFor({ 'b.ts': [wf] }, [{ workflowName: 'b', sourceFile: 'b.ts', hasFilter: true }]),
    );

    const [c] = result.candidates;
    expect(c.run).toBe(true);
    expect(c.jobs?.map((j) => j.name)).toEqual(['ci-test', 'ci-build']);
  });

  it('runs the generators of a filter-less workflow', async () => {
    // The correctness case the round exists for: a global workflow with a
    // generator and no filter is the shape that silently produced no jobs.
    const wf = makeWorkflow({ name: 'd', jobs: [async () => [makeJob('gen')]] });
    const result = await runGlobalEvalRound(
      argsFor({ 'd.ts': [wf] }, [{ workflowName: 'd', sourceFile: 'd.ts', hasFilter: false }]),
    );

    expect(result.candidates[0].run).toBe(true);
    expect(result.candidates[0].jobs?.map((j) => j.name)).toEqual(['gen']);
  });

  it('marks a throwing filter indeterminate without affecting its siblings', async () => {
    const throws = makeWorkflow({
      name: 'boom',
      filter: () => {
        throw new Error('filter exploded');
      },
    });
    const ok = makeWorkflow({
      name: 'b',
      filter: () => true,
      jobs: [async () => [makeJob('ci-test')]],
    });

    const result = await runGlobalEvalRound(
      argsFor({ 'boom.ts': [throws], 'b.ts': [ok] }, [
        { workflowName: 'boom', sourceFile: 'boom.ts', hasFilter: true },
        { workflowName: 'b', sourceFile: 'b.ts', hasFilter: true },
      ]),
    );

    expect(result.candidates[0]).toMatchObject({
      workflowName: 'boom',
      run: false,
      indeterminate: true,
      reason: 'filter exploded',
    });
    expect(result.candidates[1].run).toBe(true);
    expect(result.candidates[1].jobs?.map((j) => j.name)).toEqual(['ci-test']);
  });

  it('marks a throwing generator indeterminate without affecting its siblings', async () => {
    const throws = makeWorkflow({
      name: 'gen-boom',
      jobs: [
        async () => {
          throw new Error('generator exploded');
        },
      ],
    });
    const ok = makeWorkflow({ name: 'fine', jobs: [makeJob('static')] });

    const result = await runGlobalEvalRound(
      argsFor({ 'x.ts': [throws], 'y.ts': [ok] }, [
        { workflowName: 'gen-boom', sourceFile: 'x.ts', hasFilter: false },
        { workflowName: 'fine', sourceFile: 'y.ts', hasFilter: false },
      ]),
    );

    expect(result.candidates[0]).toMatchObject({ run: false, indeterminate: true });
    expect(result.candidates[0].reason).toContain('generator exploded');
    expect(result.candidates[1]).toEqual({ workflowName: 'fine', run: true });
  });

  it('marks a candidate whose module fails to load indeterminate', async () => {
    const ok = makeWorkflow({ name: 'fine', jobs: [makeJob('static')] });
    const result = await runGlobalEvalRound(
      argsFor({ 'y.ts': [ok] }, [
        { workflowName: 'missing', sourceFile: 'gone.ts', hasFilter: false },
        { workflowName: 'fine', sourceFile: 'y.ts', hasFilter: false },
      ]),
    );

    expect(result.candidates[0]).toMatchObject({ run: false, indeterminate: true });
    expect(result.candidates[1].run).toBe(true);
  });

  it('marks a candidate indeterminate when it exceeds the per-candidate budget', async () => {
    const slow = makeWorkflow({
      name: 'slow',
      filter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      },
    });

    const result = await runGlobalEvalRound(
      argsFor({ 's.ts': [slow] }, [{ workflowName: 'slow', sourceFile: 's.ts', hasFilter: true }], {
        candidateTimeoutMs: 10,
      }),
    );

    expect(result.candidates[0]).toMatchObject({ run: false, indeterminate: true });
    expect(result.candidates[0].reason).toMatch(/timeout/i);
  });

  it('reports the verdicts it established when the round budget is exhausted', async () => {
    const fast = makeWorkflow({ name: 'fast', filter: () => true });
    const slow = makeWorkflow({
      name: 'slow',
      filter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
      },
    });

    const result = await runGlobalEvalRound(
      argsFor(
        { 'f.ts': [fast], 's.ts': [slow] },
        [
          { workflowName: 'fast', sourceFile: 'f.ts', hasFilter: true },
          { workflowName: 'slow', sourceFile: 's.ts', hasFilter: true },
          { workflowName: 'never', sourceFile: 'f.ts', hasFilter: true },
        ],
        { roundTimeoutMs: 50, candidateTimeoutMs: 60_000 },
      ),
    );

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toEqual({ workflowName: 'fast', run: true });
    expect(result.candidates[1]).toMatchObject({ workflowName: 'slow', indeterminate: true });
    expect(result.candidates[2]).toMatchObject({ workflowName: 'never', indeterminate: true });
    expect(result.candidates[2].reason).toMatch(/global eval round/);
  });

  it('does not keep mutating its result after the round budget is exhausted', async () => {
    const slow = makeWorkflow({
      name: 'slow',
      filter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return true;
      },
    });

    const result = await runGlobalEvalRound(
      argsFor(
        { 's.ts': [slow] },
        [
          { workflowName: 'slow', sourceFile: 's.ts', hasFilter: true },
          { workflowName: 'slow2', sourceFile: 's.ts', hasFilter: true },
        ],
        { roundTimeoutMs: 10, candidateTimeoutMs: 60_000 },
      ),
    );

    expect(result.candidates).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // `withTimeout` races rather than cancels, so the loop kept running.
    expect(result.candidates).toHaveLength(2);
  });

  it('gives the filter a context whose sourceRepo points at the source checkout', async () => {
    const seen: string[] = [];
    const wf = makeWorkflow({
      name: 'rec',
      filter: (ctx: FilterContext) => {
        seen.push(ctx.sourceRepo.path);
        seen.push(ctx.workflowRepo.path);
        return true;
      },
    });

    await runGlobalEvalRound(
      argsFor({ 'r.ts': [wf] }, [{ workflowName: 'rec', sourceFile: 'r.ts', hasFilter: true }]),
    );

    expect(seen).toEqual(['/w/source', '/w/workflow']);
  });

  it('gives the generator the same repo pair the sandbox re-evaluation gets', async () => {
    let generatorCtx: DynamicJobContext | undefined;
    const wf = makeWorkflow({
      name: 'g',
      jobs: [
        async (ctx: DynamicJobContext) => {
          generatorCtx = ctx;
          return [makeJob('gen')];
        },
      ],
    });

    await runGlobalEvalRound(
      argsFor({ 'g.ts': [wf] }, [{ workflowName: 'g', sourceFile: 'g.ts', hasFilter: false }]),
    );

    expect(generatorCtx?.sourceRepo).toEqual(repos.sourceRepo);
    expect(generatorCtx?.workflowRepo).toEqual(repos.workflowRepo);
    expect(generatorCtx?.ctx.workflow.name).toBe('g');
  });

  it('sets the seven KICI_* env keys before evaluating a candidate', async () => {
    // The determinism trap: the generator's `env` IS process.env, and the sandbox
    // re-evaluation sets these keys. A round that skipped them would hand the
    // generator a different world on its two calls.
    let observed: Record<string, string | undefined> = {};
    const wf = makeWorkflow({
      name: 'env',
      filter: () => {
        observed = Object.fromEntries(GLOBAL_ENV_KEYS.map((k) => [k, process.env[k]]));
        return true;
      },
    });

    await runGlobalEvalRound(
      argsFor({ 'e.ts': [wf] }, [{ workflowName: 'env', sourceFile: 'e.ts', hasFilter: true }]),
    );

    expect(observed).toEqual({
      KICI_IS_GLOBAL_WORKFLOW: 'true',
      KICI_WORKFLOW_REPO_PATH: '/w/workflow',
      KICI_SOURCE_REPO_PATH: '/w/source',
      KICI_SOURCE_REPO: 'o/src',
      KICI_SOURCE_BRANCH: 'main',
      KICI_SOURCE_SHA: 'aaa',
      KICI_WORKFLOW_REPO: 'o/wf',
    });
  });

  it('restores process.env after the round, so a later non-global evaluation sees a clean world', async () => {
    // The agent process is long-lived and serves many dispatches from one
    // JobRunner. A leaked KICI_IS_GLOBAL_WORKFLOW / stale KICI_SOURCE_REPO_PATH
    // would reach the NEXT job's generator (whose `env` is process.env) while
    // that job's own sandbox re-evaluation sees neither — the same two-worlds
    // determinism failure, injected into an unrelated job.
    const wf = makeWorkflow({ name: 'a', filter: () => true });
    const before = GLOBAL_ENV_KEYS.map((k) => process.env[k]);

    await runGlobalEvalRound(
      argsFor({ 'a.ts': [wf] }, [{ workflowName: 'a', sourceFile: 'a.ts', hasFilter: true }]),
    );

    // Positive control: the keys were genuinely unset going in, so "all
    // undefined afterwards" cannot pass vacuously on a run that never set them.
    expect(before).toEqual(GLOBAL_ENV_KEYS.map(() => undefined));
    expect(GLOBAL_ENV_KEYS.map((k) => process.env[k])).toEqual(
      GLOBAL_ENV_KEYS.map(() => undefined),
    );
    for (const key of GLOBAL_ENV_KEYS) expect(key in process.env).toBe(false);
  });

  it('restores a pre-existing value rather than deleting the key', async () => {
    process.env.KICI_SOURCE_REPO = 'o/pre-existing';
    const wf = makeWorkflow({ name: 'a', filter: () => true });

    await runGlobalEvalRound(
      argsFor({ 'a.ts': [wf] }, [{ workflowName: 'a', sourceFile: 'a.ts', hasFilter: true }]),
    );

    expect(process.env.KICI_SOURCE_REPO).toBe('o/pre-existing');
  });

  it('restores process.env even when a candidate throws', async () => {
    const wf = makeWorkflow({
      name: 'boom',
      filter: () => {
        throw new Error('filter exploded');
      },
    });

    const result = await runGlobalEvalRound(
      argsFor({ 'b.ts': [wf] }, [{ workflowName: 'boom', sourceFile: 'b.ts', hasFilter: true }]),
    );

    expect(result.candidates[0].indeterminate).toBe(true);
    expect(process.env.KICI_IS_GLOBAL_WORKFLOW).toBeUndefined();
  });

  it('restores process.env even when the round budget is exhausted', async () => {
    const slow = makeWorkflow({
      name: 'slow',
      filter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      },
    });

    await runGlobalEvalRound(
      argsFor({ 's.ts': [slow] }, [{ workflowName: 'slow', sourceFile: 's.ts', hasFilter: true }], {
        roundTimeoutMs: 10,
        candidateTimeoutMs: 60_000,
      }),
    );

    expect(process.env.KICI_IS_GLOBAL_WORKFLOW).toBeUndefined();
    expect(process.env.KICI_SOURCE_REPO_PATH).toBeUndefined();
  });

  it('stops starting candidates once the round deadline has passed', async () => {
    // `withTimeout` races rather than cancels, so without a deadline check the
    // loop would keep launching every remaining candidate — each up to
    // candidateTimeoutMs — into a workdir the job already reported on and whose
    // cleanup already deleted it.
    const started: string[] = [];
    const make = (name: string) =>
      makeWorkflow({
        name,
        filter: async () => {
          started.push(name);
          await new Promise((resolve) => setTimeout(resolve, 80));
          return true;
        },
      });

    const result = await runGlobalEvalRound(
      argsFor(
        { '1.ts': [make('one')], '2.ts': [make('two')], '3.ts': [make('three')] },
        [
          { workflowName: 'one', sourceFile: '1.ts', hasFilter: true },
          { workflowName: 'two', sourceFile: '2.ts', hasFilter: true },
          { workflowName: 'three', sourceFile: '3.ts', hasFilter: true },
        ],
        { roundTimeoutMs: 30, candidateTimeoutMs: 60_000 },
      ),
    );

    // At most ONE candidate is in flight past the deadline: the first started
    // before it, and nothing else was launched afterwards.
    expect(started).toEqual(['one']);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.indeterminate)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(started).toEqual(['one']);
  });

  it('stops starting candidates once the caller aborts', async () => {
    const started: string[] = [];
    const controller = new AbortController();
    const make = (name: string) =>
      makeWorkflow({
        name,
        filter: async () => {
          started.push(name);
          controller.abort();
          return true;
        },
      });

    const result = await runGlobalEvalRound(
      argsFor(
        { '1.ts': [make('one')], '2.ts': [make('two')] },
        [
          { workflowName: 'one', sourceFile: '1.ts', hasFilter: true },
          { workflowName: 'two', sourceFile: '2.ts', hasFilter: true },
        ],
        { signal: controller.signal },
      ),
    );

    expect(started).toEqual(['one']);
    expect(result.candidates[0]).toEqual({ workflowName: 'one', run: true });
    expect(result.candidates[1]).toMatchObject({ workflowName: 'two', indeterminate: true });
    expect(result.candidates[1].reason).toMatch(/cancelled/);
  });

  it('lets a filter that SHELLS OUT read the KICI_* keys, matching the sandbox', async () => {
    // The composition the handler performs: `buildEvalShell` is created BEFORE
    // `runGlobalEvalRound` applies the seven keys. A `{ ...process.env }` spread
    // would snapshot at build time, so a subprocess would read nothing here
    // while the sandbox re-evaluation's ambient `$` — which resolves
    // `process.env` at spawn, after `setupGlobalWorkflowEnv` ran — reads the
    // value. Same two-worlds determinism failure as the cwd, one layer down.
    let viaSubprocess: string | undefined;
    let viaProcessEnv: string | undefined;
    const wf = makeWorkflow({
      name: 'shells-out',
      filter: async (ctx: FilterContext) => {
        viaProcessEnv = process.env.KICI_SOURCE_REPO_PATH;
        viaSubprocess = (await ctx.$`printenv KICI_SOURCE_REPO_PATH || true`).stdout.trim();
        return true;
      },
    });

    // Positive control: absent before the round, so a match afterwards cannot be
    // explained by ambient state left over from another test.
    expect(process.env.KICI_SOURCE_REPO_PATH).toBeUndefined();

    const shell = await buildEvalShell(process.cwd(), () => {});
    const result = await runGlobalEvalRound(
      argsFor(
        { 'w.ts': [wf] },
        [{ workflowName: 'shells-out', sourceFile: 'w.ts', hasFilter: true }],
        { $: shell },
      ),
    );

    expect(result.candidates[0]).toEqual({ workflowName: 'shells-out', run: true });
    // The in-process and subprocess views must AGREE — that agreement is the
    // property. A snapshot env passes the first assertion and fails the second.
    expect(viaProcessEnv).toBe('/w/source');
    expect(viaSubprocess).toBe('/w/source');
  });

  it('propagates the changedFiles throw as an indeterminate verdict, never a silent skip', async () => {
    // A filter reading ctx.changedFiles on a diff-less event must NOT see [] —
    // that would suppress the workflow with no run row anywhere to inspect.
    const wf = makeWorkflow({
      name: 'paths',
      filter: (ctx: FilterContext) => ctx.changedFiles.some((f) => f.startsWith('src/')),
    });

    const result = await runGlobalEvalRound(
      argsFor({ 'p.ts': [wf] }, [{ workflowName: 'paths', sourceFile: 'p.ts', hasFilter: true }], {
        event: { type: 'schedule' },
        changedFilesStatus: 'unavailable',
      }),
    );

    expect(result.candidates[0]).toMatchObject({ run: false, indeterminate: true });
    expect(result.candidates[0].reason).toMatch(/ctx\.changedFiles is not available/);
  });

  it('hands the filter the real diff when it is fetched', async () => {
    const wf = makeWorkflow({
      name: 'paths',
      filter: (ctx: FilterContext) => ctx.changedFiles.some((f) => f.startsWith('src/')),
    });

    const result = await runGlobalEvalRound(
      argsFor({ 'p.ts': [wf] }, [{ workflowName: 'paths', sourceFile: 'p.ts', hasFilter: true }], {
        changedFiles: ['docs/readme.md'],
      }),
    );

    expect(result.candidates[0]).toEqual({ workflowName: 'paths', run: false });
  });

  it('loads a shared source file once for every candidate in it', async () => {
    const a = makeWorkflow({ name: 'a', filter: () => true });
    const b = makeWorkflow({ name: 'b', filter: () => false });
    let loadCount = 0;

    const result = await runGlobalEvalRound(
      argsFor(
        {},
        [
          { workflowName: 'a', sourceFile: 'shared.ts', hasFilter: true },
          { workflowName: 'b', sourceFile: 'shared.ts', hasFilter: true },
        ],
        {
          loadModule: async () => {
            loadCount += 1;
            return { default: [a, b] } as unknown as Record<string, unknown>;
          },
        },
      ),
    );

    expect(loadCount).toBe(1);
    expect(result.candidates.map((c) => c.run)).toEqual([true, false]);
  });

  it('evaluates candidates sequentially — they share one working directory', async () => {
    const order: string[] = [];
    const make = (name: string, delayMs: number) =>
      makeWorkflow({
        name,
        filter: async () => {
          order.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          order.push(`end:${name}`);
          return true;
        },
      });

    await runGlobalEvalRound(
      argsFor({ '1.ts': [make('one', 30)], '2.ts': [make('two', 1)] }, [
        { workflowName: 'one', sourceFile: '1.ts', hasFilter: true },
        { workflowName: 'two', sourceFile: '2.ts', hasFilter: true },
      ]),
    );

    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('marks a candidate indeterminate when the lock claims a filter the module lacks', async () => {
    const wf = makeWorkflow({ name: 'stale', jobs: [makeJob('static')] });
    const result = await runGlobalEvalRound(
      argsFor({ 's.ts': [wf] }, [{ workflowName: 'stale', sourceFile: 's.ts', hasFilter: true }]),
    );

    expect(result.candidates[0]).toMatchObject({ run: false, indeterminate: true });
    expect(result.candidates[0].reason).toMatch(/lock file is out of date/i);
  });

  it('returns an empty candidate list for an empty round', async () => {
    const result = await runGlobalEvalRound(argsFor({}, []));
    expect(result.candidates).toEqual([]);
  });
});
