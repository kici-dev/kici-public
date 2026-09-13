import { describe, it, expect } from 'vitest';
import {
  dashboardRunSummarySchema,
  dashboardRunsListRequestSchema,
  dashboardRunsListResponseSchema,
} from './dashboard.js';

describe('dashboard.runs.list schema', () => {
  it('validates a request', () => {
    const r = dashboardRunsListRequestSchema.safeParse({
      type: 'dashboard.runs.list',
      requestId: 'req-1',
      actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      limit: 50,
    });
    expect(r.success).toBe(true);
  });

  it('validates a response with run summaries', () => {
    const r = dashboardRunsListResponseSchema.safeParse({
      type: 'dashboard.runs.list.response',
      requestId: 'req-1',
      runs: [
        {
          runId: 'run-1',
          routingKey: 'rk-1',
          repoIdentifier: 'org/repo',
          status: 'completed',
          createdAt: '2026-05-30T10:00:00.000Z',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('run summary carries the enriched customer-page fields', () => {
    const r = dashboardRunSummarySchema.safeParse({
      runId: 'r1',
      routingKey: 'github:1',
      status: 'success',
      workflowName: 'ci',
      repoIdentifier: 'o/r',
      createdAt: '2026-05-30T10:00:00.000Z',
      sha: 'abc1234',
      ref: 'main',
      triggerEvent: 'push',
      jobCount: 2,
      startedAt: '2026-05-30T10:00:00.000Z',
      completedAt: '2026-05-30T10:01:00.000Z',
      durationMs: 60000,
      hadCompileJob: true,
      compileJobId: 'job-c',
      source: { routingKey: 'github:1', name: 'o/r', subtype: 'github_app', provider: 'github' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a request with limit out of range', () => {
    const r = dashboardRunsListRequestSchema.safeParse({
      type: 'dashboard.runs.list',
      requestId: 'req-1',
      actor: { type: 'platform_operator', sub: 'op', reason: 'INC-1 looking now' },
      limit: 9999,
    });
    expect(r.success).toBe(false);
  });
});
