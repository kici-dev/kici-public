import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowExecutionResult, LocalJobResult } from './types.js';
import type { StepResult } from '../test-runner/job-executor.js';

// Mock logger for displayLocalSummary
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
vi.mock('@kici-dev/core', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

import {
  displayLocalSummary,
  formatLocalJsonResult,
  formatLocalJunitResult,
} from './output-streamer.js';

function makeStep(name: string, status: 'success' | 'failure' = 'success'): StepResult {
  return {
    name,
    status,
    durationMs: 100,
    ...(status === 'failure' && { error: new Error(`${name} failed`) }),
  };
}

function makeJob(
  name: string,
  status: LocalJobResult['status'] = 'success',
  opts?: { matrixValues?: Record<string, unknown>; steps?: StepResult[] },
): LocalJobResult {
  return {
    name,
    status,
    durationMs: 500,
    steps: opts?.steps ?? [makeStep('step-1')],
    matrixValues: opts?.matrixValues,
    ...(status === 'failure' && { error: new Error(`${name} failed`) }),
  };
}

function makeWorkflowResult(
  name: string,
  status: WorkflowExecutionResult['status'] = 'success',
  jobs: LocalJobResult[] = [makeJob('job-1')],
): WorkflowExecutionResult {
  return {
    name,
    status,
    durationMs: 1000,
    jobs,
  };
}

describe('displayLocalSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces tree-format summary for successful run', () => {
    const results = [makeWorkflowResult('my-ci')];

    displayLocalSummary(results);

    const output = mockLoggerInfo.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('=== EXECUTION SUMMARY ===');
    expect(output).toContain('SUCCESS');
    expect(output).toContain('my-ci');
    expect(output).toContain('job-1');
    expect(output).toContain('step-1');
    expect(output).toContain('Total duration:');
  });

  it('shows FAILED status when any workflow fails', () => {
    const results = [makeWorkflowResult('ci', 'failure', [makeJob('lint', 'failure')])];

    displayLocalSummary(results);

    const output = mockLoggerInfo.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('FAILED');
    expect(output).toContain('[fail]');
  });

  it('shows matrix values in job names', () => {
    const jobs = [
      makeJob('test', 'success', { matrixValues: { node: '18', os: 'ubuntu' } }),
      makeJob('test', 'success', { matrixValues: { node: '20', os: 'ubuntu' } }),
    ];
    const results = [makeWorkflowResult('ci', 'success', jobs)];

    displayLocalSummary(results);

    const output = mockLoggerInfo.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('18, ubuntu');
    expect(output).toContain('20, ubuntu');
  });

  it('shows skipped and cancelled job reasons', () => {
    const jobs = [
      makeJob('setup', 'failure'),
      makeJob('test', 'skipped'),
      makeJob('deploy', 'cancelled'),
    ];
    const results = [makeWorkflowResult('ci', 'failure', jobs)];

    displayLocalSummary(results);

    const output = mockLoggerInfo.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('[skip]');
    expect(output).toContain('[cancel]');
    expect(output).toContain('(cancelled)');
    expect(output).toContain('(skipped: dependency failed)');
  });
});

describe('formatLocalJsonResult', () => {
  it('produces valid JSON with expected structure', () => {
    const results = [makeWorkflowResult('ci', 'success', [makeJob('lint'), makeJob('test')])];

    const json = formatLocalJsonResult(results);
    const parsed = JSON.parse(json);

    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0].name).toBe('ci');
    expect(parsed.workflows[0].status).toBe('success');
    expect(parsed.workflows[0].jobs).toHaveLength(2);
    expect(parsed.summary.totalWorkflows).toBe(1);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(0);
  });

  it('includes matrix values when present', () => {
    const jobs = [makeJob('test', 'success', { matrixValues: { node: '18' } })];
    const results = [makeWorkflowResult('ci', 'success', jobs)];

    const json = formatLocalJsonResult(results);
    const parsed = JSON.parse(json);

    expect(parsed.workflows[0].jobs[0].matrixValues).toEqual({ node: '18' });
  });

  it('includes step timing and error info', () => {
    const steps = [makeStep('install', 'success'), makeStep('run-lint', 'failure')];
    const jobs = [makeJob('lint', 'failure', { steps })];
    const results = [makeWorkflowResult('ci', 'failure', jobs)];

    const json = formatLocalJsonResult(results);
    const parsed = JSON.parse(json);

    const jsonSteps = parsed.workflows[0].jobs[0].steps;
    expect(jsonSteps).toHaveLength(2);
    expect(jsonSteps[0].status).toBe('success');
    expect(jsonSteps[1].status).toBe('failure');
    expect(jsonSteps[1].error).toContain('failed');
  });

  it('omits matrixValues when empty', () => {
    const results = [makeWorkflowResult('ci')];

    const json = formatLocalJsonResult(results);
    const parsed = JSON.parse(json);

    expect(parsed.workflows[0].jobs[0]).not.toHaveProperty('matrixValues');
  });

  it('includes checkOutcome and driftSummary when present on a step', () => {
    const step: StepResult = {
      name: 'cfg',
      status: 'success',
      durationMs: 5,
      checkOutcome: 'dry-run',
      driftSummary: 'would rewrite config',
    };
    const jobs = [makeJob('deploy', 'success', { steps: [step] })];
    const results = [makeWorkflowResult('ci', 'success', jobs)];

    const parsed = JSON.parse(formatLocalJsonResult(results));
    const jsonStep = parsed.workflows[0].jobs[0].steps[0];
    expect(jsonStep.checkOutcome).toBe('dry-run');
    expect(jsonStep.driftSummary).toBe('would rewrite config');
  });

  it('omits check fields for a plain step', () => {
    const jobs = [makeJob('deploy', 'success', { steps: [makeStep('plain')] })];
    const parsed = JSON.parse(formatLocalJsonResult([makeWorkflowResult('ci', 'success', jobs)]));
    expect(parsed.workflows[0].jobs[0].steps[0]).not.toHaveProperty('checkOutcome');
  });
});

describe('formatLocalJunitResult', () => {
  it('produces valid JUnit XML', () => {
    const results = [makeWorkflowResult('ci', 'success', [makeJob('lint')])];

    const xml = formatLocalJunitResult(results);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites name="kici-local"');
    expect(xml).toContain('<testsuite name="ci"');
    expect(xml).toContain('<testcase name="lint"');
    expect(xml).toContain('</testsuites>');
  });

  it('includes failure element for failed jobs', () => {
    const jobs = [makeJob('lint', 'failure')];
    const results = [makeWorkflowResult('ci', 'failure', jobs)];

    const xml = formatLocalJunitResult(results);

    expect(xml).toContain('<failure');
    expect(xml).toContain('lint failed');
  });

  it('includes skipped element for skipped/cancelled jobs', () => {
    const jobs = [makeJob('deploy', 'skipped')];
    const results = [makeWorkflowResult('ci', 'failure', jobs)];

    const xml = formatLocalJunitResult(results);

    expect(xml).toContain('<skipped />');
  });

  it('shows matrix values in job name in JUnit output', () => {
    const jobs = [makeJob('test', 'success', { matrixValues: { node: '20' } })];
    const results = [makeWorkflowResult('ci', 'success', jobs)];

    const xml = formatLocalJunitResult(results);

    expect(xml).toContain('test (20)');
  });

  it('escapes XML special characters', () => {
    const jobs = [makeJob('lint & test <v1>', 'success')];
    const results = [makeWorkflowResult('build "ci"', 'success', jobs)];

    const xml = formatLocalJunitResult(results);

    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&quot;');
  });
});
