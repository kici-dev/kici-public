import { describe, it, expect } from 'vitest';
import { job, step, workflow, isDynamicJobFn, dynamicJob, dynamicGroup } from '@kici-dev/sdk';
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
