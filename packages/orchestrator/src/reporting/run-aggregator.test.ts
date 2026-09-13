import { describe, it, expect } from 'vitest';
import { visibleRoutingReason, aggregateRunDetail, buildRunDetailJobs } from './run-aggregator.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * A per-table select mock: `selectFrom(table)` returns a chain whose terminal
 * resolves the rows configured for that table, and each `selectFrom` call is
 * counted per table. Lets a test assert the aggregate queries every table
 * exactly once and returns a specific per-table shape (the shared createMockDb
 * returns one row set for every table, which cannot express distinct child
 * rows).
 */
function createPerTableSelectDb(config: {
  rows: Record<string, unknown[]>;
  firstRow: Record<string, unknown>;
}): { db: any; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const db = {
    selectFrom(table: string) {
      counts.set(table, (counts.get(table) ?? 0) + 1);
      const terminal: Record<string, any> = {
        execute: async () => config.rows[table] ?? [],
        executeTakeFirst: async () => config.firstRow[table],
      };
      terminal.select = () => terminal;
      terminal.where = () => terminal;
      terminal.orderBy = () => terminal;
      return terminal;
    },
  };
  return { db, counts };
}

describe('aggregateRunDetail', () => {
  it('returns null for an unknown run', async () => {
    const { db } = createMockDb({ selectFirstRow: undefined });
    expect(await aggregateRunDetail(db as never, 'nope')).toBeNull();
  });

  it('queries all five tables exactly once and nests the concurrent child reads identically', async () => {
    const started = new Date('2026-07-03T00:00:00.000Z');
    const { db, counts } = createPerTableSelectDb({
      firstRow: {
        execution_runs: {
          run_id: 'r9',
          workflow_name: 'ci',
          status: 'success',
          provider: 'github',
          repo_identifier: 'owner/repo',
          ref: 'refs/heads/main',
          sha: 'headsha',
          started_at: started,
          completed_at: null,
          duration_ms: 1200,
          trust_tier: 'trusted',
          contributor_username: 'alice',
          triggered_by: null,
          failure_reason: null,
          init_failure: null,
          provider_context: JSON.stringify({ baseSha: 'basesha' }),
          routing_key: 'rk-9',
        },
      },
      rows: {
        execution_jobs: [
          {
            job_id: 'j1',
            job_name: 'build',
            status: 'success',
            matrix_values: null,
            base_job_name: null,
            variant_kind: null,
            variant_label: null,
            agent_id: 'a1',
            started_at: started,
            completed_at: null,
            duration_ms: 100,
            error_message: null,
            runs_on_labels: null,
            environments: null,
            skipped_environments: null,
            env_warning: null,
            outputs: null,
            init_failure: null,
          },
        ],
        execution_steps: [
          {
            job_id: 'j1',
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
        run_secret_outputs: [{ job_id: 'j1', output_key: 'TOKEN' }],
        execution_job_needs: [{ job_name: 'build', upstream_name: 'lint', run_on: ['success'] }],
      },
    });

    const detail = await aggregateRunDetail(db as never, 'r9');

    // Each of the five tables is queried exactly once (run header + four
    // concurrent child reads).
    for (const table of [
      'execution_runs',
      'execution_jobs',
      'execution_steps',
      'run_secret_outputs',
      'execution_job_needs',
    ]) {
      expect(counts.get(table), `${table} queried once`).toBe(1);
    }

    // The concurrent child reads assemble the identical nested detail.
    expect(detail?.runId).toBe('r9');
    expect(detail?.baseSha).toBe('basesha');
    expect(detail?.jobs).toHaveLength(1);
    expect(detail?.jobs[0].jobId).toBe('j1');
    expect(detail?.jobs[0].secretOutputKeys).toEqual(['TOKEN']);
    expect(detail?.jobs[0].needs).toEqual([{ upstreamName: 'lint', runOn: ['success'] }]);
    expect(detail?.jobs[0].steps).toHaveLength(1);
    expect(detail?.jobs[0].steps[0].stepName).toBe('compile');
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
          variant_label: 'octocat/repo:deploy',
          job_kind: 'proxy',
          summoned_run_id: 'summoned-run-42',
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
    expect(jobs[0].jobKind).toBe('proxy');
    expect(jobs[0].summonedRunId).toBe('summoned-run-42');
    expect(jobs[0].variantLabel).toBe('octocat/repo:deploy');
  });
});

describe('visibleRoutingReason', () => {
  it('shows the reason while the job is still waiting to be routed', () => {
    expect(visibleRoutingReason('pending', 'no agent matches runsOn [gpu]')).toBe(
      'no agent matches runsOn [gpu]',
    );
    expect(visibleRoutingReason('queued', 'no agent matches runsOn [gpu]')).toBe(
      'no agent matches runsOn [gpu]',
    );
  });

  it('hides a stale reason on a job that has since left the queue', () => {
    // More than twenty call sites move a job out of pending/queued and most do
    // not know this column exists, so the guard has to live at the read
    // boundary — a finished job must never render as "waiting for an agent".
    for (const status of ['running', 'success', 'failed', 'cancelled', 'unroutable', 'skipped']) {
      expect(visibleRoutingReason(status, 'no agent matches runsOn [gpu]')).toBeNull();
    }
  });

  it('returns null when there is no reason at all', () => {
    expect(visibleRoutingReason('pending', null)).toBeNull();
  });
});
