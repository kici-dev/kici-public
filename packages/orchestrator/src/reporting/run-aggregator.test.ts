import { describe, it, expect } from 'vitest';
import { aggregateRunDetail, buildRunDetailJobs } from './run-aggregator.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

describe('aggregateRunDetail', () => {
  it('returns null for an unknown run', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    expect(await aggregateRunDetail(db as never, 'nope')).toBeNull();
  });

  it('maps the run header and extracts baseSha from provider context', async () => {
    const started = new Date('2026-06-27T00:00:00.000Z');
    const { db } = createMockDb({
      selectFirstRow: {
        run_id: 'r1',
        workflow_name: 'ci',
        status: 'failed',
        provider: 'github',
        repo_identifier: 'owner/repo',
        ref: 'refs/heads/main',
        sha: 'headsha',
        started_at: started,
        completed_at: null,
        duration_ms: null,
        trust_tier: 'trusted',
        contributor_username: 'alice',
        triggered_by: null,
        failure_reason: 'boom',
        init_failure: null,
        provider_context: JSON.stringify({ baseSha: 'basesha' }),
        routing_key: 'rk-1',
      },
      selectRows: [],
    });
    const detail = await aggregateRunDetail(db as never, 'r1');
    expect(detail).not.toBeNull();
    expect(detail?.runId).toBe('r1');
    expect(detail?.workflowName).toBe('ci');
    expect(detail?.baseSha).toBe('basesha');
    expect(detail?.routingKey).toBe('rk-1');
    expect(detail?.startedAt).toEqual(started);
    expect(detail?.jobs).toEqual([]);
  });

  it('baseSha is null when provider context has none', async () => {
    const { db } = createMockDb({
      selectFirstRow: {
        run_id: 'r2',
        workflow_name: 'ci',
        status: 'success',
        provider: 'github',
        repo_identifier: 'owner/repo',
        ref: 'main',
        sha: 'x',
        started_at: null,
        completed_at: null,
        duration_ms: null,
        trust_tier: null,
        contributor_username: null,
        triggered_by: null,
        failure_reason: null,
        init_failure: null,
        provider_context: '{}',
        routing_key: null,
      },
      selectRows: [],
    });
    const detail = await aggregateRunDetail(db as never, 'r2');
    expect(detail?.baseSha).toBeNull();
  });
});

describe('buildRunDetailJobs', () => {
  it('nests steps + needs and emits epoch-ms timestamps', () => {
    const started = new Date('2026-06-27T01:00:00.000Z');
    const jobs = buildRunDetailJobs(
      [
        {
          job_id: 'j1',
          job_name: 'build',
          status: 'success',
          matrix_values: null,
          base_job_name: null,
          variant_kind: null,
          variant_label: null,
          started_at: started,
          completed_at: null,
          duration_ms: 100,
          agent_id: 'a1',
          error_message: null,
          runs_on_labels: null,
          environments: null,
          outputs: { url: { value: 'http://x' } },
          init_failure: null,
        },
      ],
      {
        stepsByJob: new Map([
          [
            'j1',
            [
              {
                step_index: 0,
                step_name: 'compile',
                status: 'success',
                started_at: started,
                completed_at: null,
                duration_ms: 50,
                exit_code: 0,
                error_message: null,
                step_type: 'step',
                secrets_accessed: null,
                check_outcome: null,
                drift_summary: null,
                concurrency_kind: null,
                group_id: null,
              },
            ],
          ],
        ]),
        secretKeysByJob: new Map([['j1', ['TOKEN']]]),
        needsByJob: new Map([['build', [{ upstreamName: 'lint', runOn: ['success'] }]]]),
      },
    );
    expect(jobs[0].startedAt).toBe(started.getTime());
    expect(jobs[0].secretOutputKeys).toEqual(['TOKEN']);
    expect(jobs[0].needs).toEqual([{ upstreamName: 'lint', runOn: ['success'] }]);
    expect(jobs[0].steps[0].stepName).toBe('compile');
  });
});
