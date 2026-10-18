import { describe, it, expect } from 'vitest';
import { job, parallel, push, step, workflow } from '@kici-dev/sdk';
import { generateLockFile } from '../lockfile/generator.js';
import { isLockParallelStep, isLockStaticJob, type LockWorkflow } from '../types.js';
import { workflowsToPreviewLock } from './preview-lock.js';

type StepNames = Array<string | { group: string; children: string[] }>;

function stepNames(lockWorkflow: LockWorkflow, jobName: string): StepNames {
  const lockJob = lockWorkflow.jobs.find((j) => isLockStaticJob(j) && j.name === jobName);
  if (!lockJob || !isLockStaticJob(lockJob)) throw new Error(`no static job ${jobName}`);
  return lockJob.steps.map((s) =>
    isLockParallelStep(s) ? { group: s.name, children: s.children.map((c) => c.name) } : s.name,
  );
}

const fn = async () => {};

function mixedWorkflow() {
  return workflow('ci', {
    on: push({ branches: ['master'] }),
    jobs: [
      job('mixed', {
        runsOn: 'linux',
        steps: [
          step('named', async () => {}),
          async () => {},
          step(async () => {}),
          parallel([step(async () => {}), step('lint', async () => {})]),
        ],
      }),
    ],
  });
}

describe('workflowsToPreviewLock step names', () => {
  it('names a run: shorthand step step-1', () => {
    const w = workflow('ci', {
      on: push(),
      jobs: [job('publish', { runsOn: 'linux', run: async () => {} })],
    });
    // fails-when: preview maps a function step to name '' (an empty '- ' bullet)
    expect(stepNames(workflowsToPreviewLock([w], '/repo')[0], 'publish')).toEqual(['step-1']);
  });

  it('names a mixed job the way the lock file does', () => {
    expect(stepNames(workflowsToPreviewLock([mixedWorkflow()], '/repo')[0], 'mixed')).toEqual([
      'named',
      'step-1',
      'step-2',
      { group: 'parallel-0', children: ['step-3', 'lint'] },
    ]);
  });

  it("keeps a named group's name", () => {
    const w = workflow('ci', {
      on: push(),
      jobs: [
        job('checks', {
          runsOn: 'linux',
          steps: [parallel([step('a', fn), step('b', fn)], { name: 'checks' })],
        }),
      ],
    });
    expect(stepNames(workflowsToPreviewLock([w], '/repo')[0], 'checks')).toEqual([
      { group: 'checks', children: ['a', 'b'] },
    ]);
  });

  it('counts a reused bare function per occurrence', () => {
    const w = workflow('ci', {
      on: push(),
      jobs: [job('twice', { runsOn: 'linux', steps: [fn, fn] })],
    });
    expect(stepNames(workflowsToPreviewLock([w], '/repo')[0], 'twice')).toEqual([
      'step-1',
      'step-2',
    ]);
  });

  it('restarts the counter per job', () => {
    const w = workflow('ci', {
      on: push(),
      jobs: [
        job('one', { runsOn: 'linux', run: async () => {} }),
        job('two', { runsOn: 'linux', run: async () => {} }),
      ],
    });
    const [lock] = workflowsToPreviewLock([w], '/repo');
    expect(stepNames(lock, 'one')).toEqual(['step-1']);
    expect(stepNames(lock, 'two')).toEqual(['step-1']);
  });

  it('rejects what kici compile rejects', () => {
    const w = workflow('ci', {
      on: push(),
      jobs: [job('empty', { runsOn: 'linux', steps: [parallel([])] })],
    });
    expect(() => workflowsToPreviewLock([w], '/repo')).toThrow(/empty parallel/i);
  });

  it('matches generateLockFile step for step', () => {
    const w = mixedWorkflow();
    const lockFile = generateLockFile([
      { workflow: w, source: { file: '/repo/.kici/workflows/ci.ts', exportName: 'default' } },
    ]);
    // Agreement axis only (both sides call transformSteps); the literal cases pin values.
    // breaks-if-wrong: named steps ('named', 'lint') keep their own names on both sides
    expect(stepNames(workflowsToPreviewLock([w], '/repo')[0], 'mixed')).toEqual(
      stepNames(lockFile.workflows[0], 'mixed'),
    );
  });
});
