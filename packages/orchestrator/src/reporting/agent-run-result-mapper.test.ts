import { describe, it, expect } from 'vitest';
import { mapToAgentRunResult } from './agent-run-result-mapper.js';
import { agentRunResultSchema } from '@kici-dev/engine';
import type { CanonicalRunDetail } from './run-aggregator.js';

function fixtureDetail(overrides: Partial<CanonicalRunDetail> = {}): CanonicalRunDetail {
  return {
    runId: 'r1',
    workflowName: 'ci',
    status: 'failed',
    provider: 'github',
    repoIdentifier: 'owner/repo',
    ref: 'refs/heads/main',
    sha: 'abc',
    baseSha: null,
    startedAt: new Date('2026-06-27T00:00:00.000Z'),
    completedAt: null,
    durationMs: null,
    trustTier: 'trusted',
    contributorUsername: 'alice',
    triggeredBy: 'user:alice',
    failureReason: 'step failed',
    initFailure: null,
    routingKey: 'rk',
    jobs: [
      {
        jobId: 'j1',
        jobName: 'build',
        status: 'failed',
        matrixValues: null,
        baseJobName: null,
        variantKind: null,
        variantLabel: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        agentId: null,
        orchestratorId: null,
        errorMessage: 'boom',
        runsOnLabels: null,
        environments: null,
        outputs: { compile: { url: 'http://x' } },
        secretOutputKeys: ['TOKEN'],
        needs: [{ upstreamName: 'lint', runOn: ['success'] }],
        steps: [
          {
            stepIndex: 0,
            stepName: 'compile',
            status: 'failed',
            startedAt: null,
            completedAt: null,
            durationMs: null,
            exitCode: 1,
            errorMessage: 'nope',
            secretsAccessed: ['TOKEN'],
          },
        ],
      },
    ] as unknown as CanonicalRunDetail['jobs'],
    ...overrides,
  };
}

describe('mapToAgentRunResult', () => {
  it('gives each step its phase and an init step its initIndex', () => {
    const base = fixtureDetail().jobs[0].steps[0];
    const detail = fixtureDetail({
      jobs: [
        {
          ...fixtureDetail().jobs[0],
          steps: [
            { ...base, stepIndex: 1_000_000, stepName: 'init:0', stepType: 'init:0' },
            // The pre-0.21.0 recorder stored an init step untyped.
            { ...base, stepIndex: 1_000_001, stepName: 'init:1' },
            { ...base, stepIndex: 0, stepName: 'compile' },
          ],
        },
      ] as unknown as CanonicalRunDetail['jobs'],
    });
    const steps = mapToAgentRunResult(detail).jobs[0].steps;
    // fails-when: mapStep emits no classification
    expect(steps[0]).toMatchObject({ phase: 'init', initIndex: 0 });
    expect(steps[1]).toMatchObject({ phase: 'init', initIndex: 1, stepIndex: 1_000_001 });
    // breaks-if-wrong: the step name stays fenced as untrusted
    expect(steps[1].stepName).toEqual({ untrusted: true, value: 'init:1' });
    expect(steps[2]).toMatchObject({ phase: 'steps' });
    expect(steps[2]).not.toHaveProperty('initIndex');
  });

  it('produces a schema-valid result', () => {
    const out = mapToAgentRunResult(fixtureDetail());
    expect(agentRunResultSchema.safeParse(out).success).toBe(true);
  });

  it('wraps untrusted fields and leaves trusted ones plain', () => {
    const out = mapToAgentRunResult(fixtureDetail());
    expect(out.runId).toBe('r1');
    expect(out.sha).toBe('abc');
    expect(out.workflowName).toEqual({ untrusted: true, value: 'ci' });
    expect(out.jobs[0].jobName).toEqual({ untrusted: true, value: 'build' });
    expect(out.jobs[0].needs[0].ref).toEqual({ untrusted: true, value: 'lint' });
    expect(out.jobs[0].steps[0].stepName).toEqual({ untrusted: true, value: 'compile' });
  });

  it('flattens non-secret outputs into untrusted-wrapped values', () => {
    const out = mapToAgentRunResult(fixtureDetail());
    expect(out.jobs[0].outputs).toEqual({ 'compile.url': { untrusted: true, value: 'http://x' } });
  });

  it('derives failureCategory from signals (nonzero step exit)', () => {
    expect(mapToAgentRunResult(fixtureDetail()).failureCategory).toBe('step_failed');
  });

  it('derives timed_out from a timed-out job', () => {
    const detail = fixtureDetail({
      jobs: [
        { ...fixtureDetail().jobs[0], status: 'timed_out_stale', steps: [] },
      ] as unknown as CanonicalRunDetail['jobs'],
    });
    expect(mapToAgentRunResult(detail).failureCategory).toBe('timed_out');
  });

  it('never emits secret output VALUES, only key names', () => {
    const out = mapToAgentRunResult(fixtureDetail());
    expect(out.jobs[0].secretOutputKeys).toEqual(['TOKEN']);
    // The only TOKEN reference is the key-name array, never an outputs value.
    expect(JSON.stringify(out.jobs[0].outputs)).not.toContain('TOKEN');
  });

  it('converts step + run timestamps to ISO strings', () => {
    const out = mapToAgentRunResult(fixtureDetail());
    expect(out.startedAt).toBe('2026-06-27T00:00:00.000Z');
  });
});
