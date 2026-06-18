import { describe, it, expect } from 'vitest';
import { job, step, workflow, isDynamicJobFn, dynamicJob, dynamicGroup } from '@kici-dev/sdk';
import type { DynamicJobFn, Job } from '@kici-dev/sdk';
import { validateConfig } from './validator.js';

const dummyStep = step('run', async () => {});

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

    const result = validateConfig([w], 'test.ts');
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

    const result = validateConfig([w], 'test.ts');
    expect(result.valid).toBe(true);
  });

  it('resolves ifFailed needs to correct name', () => {
    const buildJob = job('build', {
      runsOn: 'linux',
      steps: [dummyStep],
    });

    const testJob = job('test', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [{ name: 'build', ifFailed: 'run' }],
    });

    const w = workflow('ci', {
      jobs: [buildJob, testJob],
    });

    const result = validateConfig([w], 'test.ts');
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
    const result = validateConfig([w], 'test.ts');
    expect(result.valid).toBe(true);
  });

  it('resolves NeedsGroupEntry objects to synthetic __group: nodes', () => {
    const testGenerator = dynamicJob('tests', (async () => []) as DynamicJobFn);

    const deployJob = job('deploy', {
      runsOn: 'linux',
      steps: [dummyStep],
      needs: [{ group: 'tests', ifFailed: 'run' }],
    });

    const w = workflow('ci', {
      jobs: [testGenerator, deployJob],
    });

    const result = validateConfig([w], 'test.ts');
    expect(result.valid).toBe(true);
  });
});
