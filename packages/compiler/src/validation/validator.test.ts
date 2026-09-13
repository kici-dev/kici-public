import { describe, it, expect } from 'vitest';
import { job, step, workflow, push, isDynamicJobFn, dynamicJob, dynamicGroup } from '@kici-dev/sdk';
import type { DynamicJobFn, Job } from '@kici-dev/sdk';
import { validateConfig } from './validator.js';
import type { WorkflowWithSource } from '../types.js';

const dummyStep = step('run', async () => {});

function wrap(w: ReturnType<typeof workflow>, file = 'test.ts'): WorkflowWithSource {
  return { workflow: w, source: { file, exportName: 'default' } };
}

describe('validateConfig cross-domain DAG validation', () => {
  it('allows valid cross-domain: static deploy depends on dynamicGroup tests', () => {
    const testGenerator = dynamicJob('tests', (async () => [
      job('test-1', { runsOn: 'linux', steps: [dummyStep] }),
    ]) as DynamicJobFn);

    const deployJob = job('deploy', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [dynamicGroup('tests')],
    });

    const w = workflow('ci', {
      jobs: [testGenerator, deployJob],
    });

    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(true);
  });

  it('allows valid: static lint -> dynamicGroup(tests) -> static deploy', () => {
    const lintJob = job('lint', {
      runsOn: 'linux',
      steps: [dummyStep],
    });

    const testGenerator = dynamicJob('tests', (async () => [
      job('test-1', { runsOn: 'linux', steps: [dummyStep], needs: ['lint'] }),
    ]) as DynamicJobFn);

    const deployJob = job('deploy', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [dynamicGroup('tests')],
    });

    const w = workflow('ci', {
      jobs: [lintJob, testGenerator, deployJob],
    });

    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(true);
  });

  it('resolves when needs to correct name', () => {
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [dummyStep],
    });

    const testJob = job('test', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [{ name: 'build', when: 'always' }],
    });

    const w = workflow('ci', {
      jobs: [buildJob, testJob],
    });

    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(true);
  });

  it('resolves dynamicGroup refs to synthetic __group: nodes in DAG', () => {
    const testGenerator = dynamicJob('tests', (async () => []) as DynamicJobFn);

    const deployJob = job('deploy', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [dynamicGroup('tests')],
    });

    const w = workflow('ci', {
      jobs: [testGenerator, deployJob],
    });

    // Should not report missing dependency for __group:tests
    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(true);
  });

  it('resolves NeedsGroupEntry objects to synthetic __group: nodes', () => {
    const testGenerator = dynamicJob('tests', (async () => []) as DynamicJobFn);

    const deployJob = job('deploy', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [{ group: 'tests', when: 'always' }],
    });

    const w = workflow('ci', {
      jobs: [testGenerator, deployJob],
    });

    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(true);
  });
});

describe('validateConfig error locations', () => {
  it("E106 duplicate job points at the offending job's first step location", () => {
    const s = step('build', async () => {});
    const dup = workflow('ci', {
      jobs: [
        job('a', { runsOn: 'kici:os:linux', steps: [s] }),
        job('a', { runsOn: 'kici:os:linux', steps: [step('again', async () => {})] }),
      ],
    });
    const res = validateConfig([wrap(dup, '/repo/.kici/workflows/ci.ts')]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const err = res.errors.find((e) => e.code === 'E106');
    expect(err).toBeDefined();
    // Real file from the step's captured location (this test file), not a directory.
    expect(err!.location?.file).toContain('validator.test.ts');
    expect(err!.location?.line).toBeGreaterThan(1);
  });

  it("E101 missing dependency anchors to the depending job's step location", () => {
    const w = workflow('ci', {
      jobs: [
        job('a', { runsOn: 'kici:os:linux', needs: ['ghost'], steps: [step('x', async () => {})] }),
      ],
    });
    const res = validateConfig([wrap(w, '/repo/.kici/workflows/ci.ts')]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const err = res.errors.find((e) => e.code === 'E101');
    expect(err!.location?.file).toContain('validator.test.ts');
    expect(err!.location?.line).toBeGreaterThan(1);
  });

  it('E102 lists only true cycle members, comma-joined (jx<->jy, jz needs jx)', () => {
    // jx<->jy is the only cycle; jz merely depends on jx and must not appear.
    // Multi-char ids avoid colliding with the fixed error-message words.
    const w = workflow('ci', {
      jobs: [
        job('jx', { runsOn: 'kici:os:linux', needs: ['jy'], steps: [step('sx', async () => {})] }),
        job('jy', { runsOn: 'kici:os:linux', needs: ['jx'], steps: [step('sy', async () => {})] }),
        job('jz', { runsOn: 'kici:os:linux', needs: ['jx'], steps: [step('sz', async () => {})] }),
      ],
    });
    const res = validateConfig([wrap(w, '/repo/.kici/workflows/ci.ts')]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const err = res.errors.find((e) => e.code === 'E102');
    expect(err).toBeDefined();
    expect(err!.message).toContain('jx, jy');
    // jz depends on the cycle but is not part of it, and the message must not
    // imply an ordered dependency path.
    expect(err!.message).not.toContain('jz');
    expect(err!.message).not.toContain(' -> ');
  });

  it('E107 duplicate workflow falls back to the workflow source file with line 1 (workflow() captures no location)', () => {
    const a = workflow('dup', {
      jobs: [job('a', { runsOn: 'kici:os:linux', steps: [step('x', async () => {})] })],
    });
    const b = workflow('dup', {
      jobs: [job('b', { runsOn: 'kici:os:linux', steps: [step('y', async () => {})] })],
    });
    const res = validateConfig([
      wrap(a, '/repo/.kici/workflows/a.ts'),
      wrap(b, '/repo/.kici/workflows/b.ts'),
    ]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const err = res.errors.find((e) => e.code === 'E107');
    expect(err!.location).toEqual({ file: '/repo/.kici/workflows/b.ts', line: 1, column: 1 });
  });
});

describe('E124 approval on an organization-wide workflow', () => {
  const gate = { approvers: [] } as never;

  it('rejects a workflow-level approval when a trigger carries repos', () => {
    // The approval hold lives entirely in the per-repository dispatch path; the
    // global path never consults it. So the gate is silently ignored and the
    // author believes a human had to release a job that ran immediately.
    const w = workflow('org-deploy', {
      on: [push({ repos: ['myorg/*'] })],
      approval: gate,
      jobs: [job('deploy', { runsOn: 'kici:os:linux', steps: [dummyStep] })],
    });
    const res = validateConfig([wrap(w, '/repo/.kici/workflows/org.ts')]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const err = res.errors.find((e) => e.code === 'E124');
    expect(err!.message).toContain('org-deploy');
    expect(err!.suggestion).toContain('per-repository workflows only');
  });

  it('rejects a job-level approval on a global workflow, anchored to the job', () => {
    const w = workflow('org-deploy', {
      on: [push({ repos: ['myorg/*'] })],
      jobs: [
        job('safe', { runsOn: 'kici:os:linux', steps: [dummyStep] }),
        job('deploy', { runsOn: 'kici:os:linux', steps: [dummyStep], approval: gate }),
      ],
    });
    const res = validateConfig([wrap(w, '/repo/.kici/workflows/org.ts')]);
    expect(res.valid).toBe(false);
    if (res.valid) return;
    const errs = res.errors.filter((e) => e.code === 'E124');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('"deploy"');
    // Anchored to the job via its first step's captured call site, like every
    // other job-scoped error — which in a test is this file, not the wrapper's
    // synthetic workflow path.
    expect(errs[0].location?.file).toContain('validator.test.ts');
  });

  it('leaves a per-repository workflow alone', () => {
    // Positive control: the same gate on a workflow with no `repos:` is
    // enforced for real, so it must still compile.
    const w = workflow('deploy', {
      on: [push({ branches: ['main'] })],
      approval: gate,
      jobs: [job('deploy', { runsOn: 'kici:os:linux', steps: [dummyStep], approval: gate })],
    });
    expect(validateConfig([wrap(w, '/repo/.kici/workflows/ci.ts')]).valid).toBe(true);
  });

  it('leaves a global workflow with no approval alone', () => {
    const w = workflow('org-lint', {
      on: [push({ repos: ['myorg/*'] })],
      jobs: [job('lint', { runsOn: 'kici:os:linux', steps: [dummyStep] })],
    });
    expect(validateConfig([wrap(w, '/repo/.kici/workflows/org.ts')]).valid).toBe(true);
  });

  it('does not read an empty repos array as global', () => {
    // `repos: []` classifies nowhere else either — the lock generator omits the
    // field entirely — so it must not trip this check.
    const w = workflow('deploy', {
      on: [push({ repos: [] })],
      approval: gate,
      jobs: [job('deploy', { runsOn: 'kici:os:linux', steps: [dummyStep] })],
    });
    expect(validateConfig([wrap(w, '/repo/.kici/workflows/ci.ts')]).valid).toBe(true);
  });
});

describe('invoke-gate validation', () => {
  // Raw Job objects bypass the SDK factory guard so the validator's own
  // defense-in-depth checks (a generated job could carry these shapes) are
  // exercised directly.
  function rawJob(overrides: Partial<Job> & { name: string }): Job {
    return {
      _tag: 'Job',
      steps: [],
      result: {} as never,
      ...overrides,
    } as unknown as Job;
  }

  it('accepts a valid invoke gate with no steps and no runsOn', () => {
    const gate = rawJob({
      name: 'repo-tests',
      invoke: { _tag: 'InvokeSource', event: 'myorg.repo-tests', scope: 'source' } as any,
    });
    const w = workflow('ci', { jobs: [gate as any] });
    expect(validateConfig([wrap(w)]).valid).toBe(true);
  });

  it('rejects invoke combined with steps', () => {
    const bad = rawJob({
      name: 'bad',
      invoke: { _tag: 'InvokeSource', event: 'e', scope: 'source' } as any,
      steps: [dummyStep],
    });
    const w = workflow('ci', { jobs: [bad as any] });
    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => /mutually exclusive|cannot be combined/i.test(e.message)),
      ).toBe(true);
    }
  });

  it('rejects an empty invoke.event', () => {
    const bad = rawJob({
      name: 'bad',
      invoke: { _tag: 'InvokeSource', event: '', scope: 'source' } as any,
    });
    const w = workflow('ci', { jobs: [bad as any] });
    const result = validateConfig([wrap(w)]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /event/i.test(e.message))).toBe(true);
    }
  });
});
