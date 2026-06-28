import { describe, it, expect } from 'vitest';
import {
  wrapUntrusted,
  AgentFailureCategory,
  agentRunResultSchema,
  agentStepLogsSchema,
} from './agent-run-result.js';

describe('Untrusted envelope', () => {
  it('wraps a value with the untrusted tag', () => {
    expect(wrapUntrusted('deploy')).toEqual({ untrusted: true, value: 'deploy' });
  });
});

describe('AgentFailureCategory', () => {
  it('enumerates the derived categories', () => {
    expect(AgentFailureCategory.options).toEqual([
      'init_failure',
      'timed_out',
      'step_failed',
      'cancelled',
      'infra',
      'unknown',
    ]);
  });
});

describe('agentRunResultSchema', () => {
  it('accepts a minimal run with untrusted-wrapped name fields', () => {
    const parsed = agentRunResultSchema.parse({
      runId: 'r_1',
      workflowName: wrapUntrusted('ci'),
      status: 'failed',
      provider: 'github',
      repoIdentifier: wrapUntrusted('owner/repo'),
      ref: wrapUntrusted('refs/heads/main'),
      sha: 'abc123',
      baseSha: null,
      startedAt: '2026-06-27T00:00:00.000Z',
      completedAt: null,
      durationMs: null,
      trustTier: 'trusted',
      contributorUsername: null,
      failureCategory: 'step_failed',
      failureReason: wrapUntrusted('boom'),
      triggeredBy: null,
      jobs: [],
    });
    expect(parsed.workflowName).toEqual({ untrusted: true, value: 'ci' });
    expect(parsed.failureCategory).toBe('step_failed');
  });

  it('rejects an untrusted field passed as a bare string', () => {
    const bad = { runId: 'r', workflowName: 'ci' } as unknown;
    expect(agentRunResultSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a full job with untrusted-wrapped step + need fields', () => {
    const parsed = agentRunResultSchema.parse({
      runId: 'r_2',
      workflowName: wrapUntrusted('ci'),
      status: 'success',
      provider: 'github',
      repoIdentifier: wrapUntrusted('owner/repo'),
      ref: wrapUntrusted('main'),
      sha: 'deadbeef',
      baseSha: 'cafe',
      startedAt: null,
      completedAt: null,
      durationMs: 10,
      trustTier: null,
      contributorUsername: wrapUntrusted('alice'),
      failureCategory: null,
      failureReason: null,
      triggeredBy: 'user:alice',
      jobs: [
        {
          jobId: 'j1',
          jobName: wrapUntrusted('build'),
          status: 'success',
          startedAt: null,
          completedAt: null,
          durationMs: null,
          agentId: null,
          errorMessage: null,
          initFailure: null,
          needs: [{ ref: wrapUntrusted('lint'), runOn: ['success'] }],
          outputs: { url: wrapUntrusted('http://x') },
          secretOutputKeys: ['TOKEN'],
          steps: [
            {
              stepIndex: 0,
              stepName: wrapUntrusted('compile'),
              status: 'success',
              exitCode: 0,
              durationMs: null,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              stepType: 'step',
              checkOutcome: null,
              secretsAccessed: ['TOKEN'],
            },
          ],
        },
      ],
    });
    expect(parsed.jobs[0].needs[0].ref).toEqual({ untrusted: true, value: 'lint' });
    expect(parsed.jobs[0].outputs?.url).toEqual({ untrusted: true, value: 'http://x' });
  });
});

describe('agentStepLogsSchema', () => {
  it('wraps every log line as untrusted', () => {
    const parsed = agentStepLogsSchema.parse({
      runId: 'r_1',
      jobId: 'j_1',
      stepIndex: 0,
      totalLines: 1,
      lines: [wrapUntrusted('line one')],
      nextCursor: null,
    });
    expect(parsed.lines[0]).toEqual({ untrusted: true, value: 'line one' });
  });
});
