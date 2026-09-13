import { describe, it, expectTypeOf } from 'vitest';
import { job } from './job.js';
import { step } from './step.js';
import { workflow } from './workflow.js';
import { dynamicGroup } from './dynamic-group.js';
import { isMatrixJobOutputs, isHostJobOutputs } from './context.js';
import type { StepContext, MatrixJobOutputs, HostJobOutputs } from './context.js';
import type { Job, JobOrFactory, OutputProxy } from './types.js';

// Task 1 — Job<TOutputs> inferred from the steps tuple (merged-steps inference).
describe('Job<TOutputs> — merged-steps inference', () => {
  it('infers a nested output map keyed by step name for a multi-step job', () => {
    const build = step('build', { run: async () => ({ version: '1.0' }) });
    const test_ = step('test', { run: async () => ({ passed: true }) });
    const j = job('ci', { runsOn: 'kici:os:linux', steps: [build, test_] });
    expectTypeOf(j.result.build.version).toEqualTypeOf<string>();
    expectTypeOf(j.result.test.passed).toEqualTypeOf<boolean>();
  });

  it('rejects reading an unknown output field of a declared step', () => {
    const build = step('build', { run: async () => ({ version: '1.0' }) });
    const j = job('ci', { runsOn: 'kici:os:linux', steps: [build] });
    // @ts-expect-error — `nope` is not an output of the `build` step
    void j.result.build.nope;
  });

  it('rejects reading an undeclared step name', () => {
    const build = step('build', { run: async () => ({ version: '1.0' }) });
    const j = job('ci', { runsOn: 'kici:os:linux', steps: [build] });
    // @ts-expect-error — there is no `other` step in this job
    void j.result.other;
  });

  it('infers a flat output shape for the run: shorthand', () => {
    const flat = job('flat', { runsOn: 'kici:os:linux', run: async () => ({ url: 'x' }) });
    expectTypeOf(flat.result.url).toEqualTypeOf<string>();
    // @ts-expect-error — the run shorthand is flat; there is no step nesting
    void flat.result.nope;
  });

  it('honours an explicit output-type override for a dynamically-shaped job', () => {
    const dyn = job<{ n: number }>('dyn', {
      runsOn: 'kici:os:linux',
      steps: [step(async () => ({}))],
    });
    expectTypeOf(dyn.result.n).toEqualTypeOf<number>();
  });

  it('omits id-less steps and falls back to the loose shape', () => {
    const j = job('idless', {
      runsOn: 'kici:os:linux',
      steps: [step(async () => ({ x: 1 }))],
    });
    // An id-less step contributes no typed key; the job stays loose so untyped
    // cross-job reads keep compiling (Record<string, unknown>).
    expectTypeOf(j.result.anything).toEqualTypeOf<unknown>();
  });

  it('keeps a typed job assignable to the bare Job type', () => {
    const build = step('build', { run: async () => ({ version: '1.0' }) });
    const j = job('ci', { runsOn: 'kici:os:linux', steps: [build] });
    const anyJob: Job = j;
    expectTypeOf(anyJob).toEqualTypeOf<Job>();
  });
});

// Void run-shorthand jobs must be assignable into workflow({ jobs: [...] }).
// Regression: Job.result lacked the void guard that Step.result has, so a
// run: shorthand returning nothing inferred Job<void>, whose result collapsed
// to `void` and was not assignable to OutputProxy<Record<string, unknown>>.
describe('Job<void> — void run-shorthand assignability', () => {
  it('makes a void run-shorthand job assignable to JobOrFactory (inline)', () => {
    // Inline form — the exact case from the bug report. The `void workflow(...)`
    // statement is the assertion: it must type-check.
    void workflow('wf', {
      jobs: [
        job('setup', {
          runsOn: 'kici:os:linux',
          run: async ({ $ }) => {
            await $`echo hi`;
          },
        }),
      ],
    });
    expectTypeOf<Job<void, 'setup'>>().toMatchTypeOf<JobOrFactory>();
  });

  it('makes a void run-shorthand job assignable to JobOrFactory (const-extracted)', () => {
    const setup = job('setup', {
      runsOn: 'kici:os:linux',
      run: async ({ $ }) => {
        await $`echo hi`;
      },
    });
    expectTypeOf(setup).toMatchTypeOf<JobOrFactory>();
    void workflow('wf', { jobs: [setup] });
  });

  it('resolves result to never for a void run-shorthand job', () => {
    const setup = job('setup', {
      runsOn: 'kici:os:linux',
      run: async () => {},
    });
    expectTypeOf(setup.result).toEqualTypeOf<never>();
  });

  it('leaves a value-returning run job untouched (regression guard)', () => {
    const flat = job('flat', { runsOn: 'kici:os:linux', run: async () => ({ url: 'x' }) });
    expectTypeOf(flat.result.url).toEqualTypeOf<string>();
    expectTypeOf(flat).toMatchTypeOf<JobOrFactory>();
  });
});

// Task 2 — typed ctx.needs threaded from reference-passing needs.
describe('typed ctx.needs from job references', () => {
  const build = step('build', { run: async () => ({ version: '1.0' }) });
  const test_ = step('test', { run: async () => ({ passed: true }) });
  const ci = job('ci', { runsOn: 'kici:os:linux', steps: [build, test_] });

  it('threads a referenced job’s inferred outputs into ctx.needs', () => {
    job('deploy', {
      runsOn: 'kici:os:linux',
      needs: [ci],
      run: async (ctx) => {
        expectTypeOf(ctx.needs.ci.result.build.version).toEqualTypeOf<string>();
        expectTypeOf(ctx.needs.ci.result.test.passed).toEqualTypeOf<boolean>();
      },
    });
  });

  it('rejects an undeclared need and an unknown field through a need', () => {
    job('deploy2', {
      runsOn: 'kici:os:linux',
      needs: [ci],
      run: async (ctx) => {
        // @ts-expect-error — `other` is not a declared need
        void ctx.needs.other;
        // @ts-expect-error — `nope` is not an output of the `build` step
        void ctx.needs.ci.result.build.nope;
      },
    });
  });

  it('keeps string-form needs loose', () => {
    job('loose', {
      runsOn: 'kici:os:linux',
      needs: ['ci'],
      run: async (ctx) => {
        expectTypeOf(ctx.needs.ci.result).toEqualTypeOf<OutputProxy<Record<string, unknown>>>();
      },
    });
  });

  it('falls back to the loose open map when a group need is mixed in (no regression)', () => {
    job('mixed', {
      runsOn: 'kici:os:linux',
      // A group ref cannot be keyed by a literal name; mixing it with a typed job
      // ref must NOT drop the group's key — the whole map stays loosely open so
      // both `ctx.needs.ci` and `ctx.needs.shards` remain accessible.
      needs: [ci, dynamicGroup('shards')],
      run: async (ctx) => {
        expectTypeOf(ctx.needs.ci).not.toBeNever();
        expectTypeOf(ctx.needs.shards).not.toBeNever();
      },
    });
  });
});

// Task 3 — envelope-generic jobOutputs for typed job references.
describe('envelope-generic jobOutputs for typed refs', () => {
  type CiOut = { readonly build: { version: string } };
  const build = step('build', { run: async () => ({ version: '1.0' }) });
  const ci = job('ci', { runsOn: 'kici:os:linux', steps: [build] });
  const ctx = null as unknown as StepContext;

  it('types a job-ref jobOutputs as the plain | matrix | host union of the inferred shape', () => {
    const out = ctx.jobOutputs(ci);
    expectTypeOf(out).toEqualTypeOf<CiOut | MatrixJobOutputs<CiOut> | HostJobOutputs<CiOut>>();
  });

  it('narrows to the typed matrix envelope via isMatrixJobOutputs', () => {
    const out = ctx.jobOutputs(ci);
    if (isMatrixJobOutputs(out)) {
      expectTypeOf(out.byMatrix).toEqualTypeOf<Record<string, CiOut>>();
      expectTypeOf(out.merged.build.version).toEqualTypeOf<string>();
    }
  });

  it('narrows to the typed host envelope via isHostJobOutputs', () => {
    const out = ctx.jobOutputs(ci);
    if (isHostJobOutputs(out)) {
      expectTypeOf(out.byHost).toEqualTypeOf<Record<string, CiOut>>();
    }
  });

  it('keeps a string-name ref on the loose union', () => {
    const out = ctx.jobOutputs({ name: 'ci' });
    expectTypeOf(out).toEqualTypeOf<Record<string, unknown> | MatrixJobOutputs | HostJobOutputs>();
  });
});
