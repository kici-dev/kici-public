import { describe, it, expect } from 'vitest';
import type { Workflow } from '@kici-dev/sdk';
import {
  DynamicValueField,
  analyzeJobPurity,
  collectWorkflowPurityWarnings,
} from './purity-diagnostics.js';

describe('analyzeJobPurity', () => {
  it('flags an impure async context function with its reason', () => {
    const job = {
      name: 'build',
      runsOn: 'kici:os:linux',
      context: async (event: { targetBranch: string }) => event.targetBranch,
      steps: [],
    } as never;
    const warnings = analyzeJobPurity(job, 'ci', '.kici/workflows/ci.ts');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      workflowName: 'ci',
      sourceFile: '.kici/workflows/ci.ts',
      jobName: 'build',
      field: DynamicValueField.Context,
    });
    expect(warnings[0].reason).toContain('async');
  });

  it('produces no warning for a pure context function', () => {
    const job = {
      name: 'build',
      runsOn: 'kici:os:linux',
      context: (event: { targetBranch: string }) => event.targetBranch,
      steps: [],
    } as never;
    expect(analyzeJobPurity(job, 'ci')).toHaveLength(0);
  });

  it('flags impure env and concurrencyGroup functions', () => {
    const job = {
      name: 'deploy',
      runsOn: 'kici:os:linux',
      env: (event: { targetBranch: string }) => ({ B: process.env.X ?? event.targetBranch }),
      concurrencyGroup: (event: { targetBranch: string }) => require('x').g(event.targetBranch),
      steps: [],
    } as never;
    const fields = analyzeJobPurity(job, 'ci')
      .map((w) => w.field)
      .sort();
    expect(fields).toEqual([DynamicValueField.ConcurrencyGroup, DynamicValueField.Env].sort());
  });

  it('analyzes every element of a contexts array', () => {
    const job = {
      name: 'build',
      runsOn: 'kici:os:linux',
      contexts: [
        (event: { targetBranch: string }) => event.targetBranch, // pure
        async (event: { targetBranch: string }) => event.targetBranch, // impure
      ],
      steps: [],
    } as never;
    expect(analyzeJobPurity(job, 'ci')).toHaveLength(1);
  });
});

describe('collectWorkflowPurityWarnings', () => {
  it('collects warnings across all static jobs and skips dynamic job generators', () => {
    const workflow = {
      name: 'ci',
      on: [],
      jobs: [
        {
          name: 'build',
          runsOn: 'kici:os:linux',
          env: async (event: { targetBranch: string }) => event.targetBranch,
          steps: [],
        },
        () => [], // dynamic job generator — must be skipped, not crash
      ],
    } as unknown as Workflow;
    const warnings = collectWorkflowPurityWarnings([
      { workflow, source: { file: '.kici/workflows/ci.ts' } } as never,
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe(DynamicValueField.Env);
    expect(warnings[0].sourceFile).toBe('.kici/workflows/ci.ts');
  });
});
