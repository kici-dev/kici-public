import { describe, it, expect } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { handleRunState } from './dashboard-run-state-handler.js';
import type { DashboardRunStateRequest } from '@kici-dev/engine';

/**
 * Minimal fake of the two Kysely read chains `handleRunState` drives:
 *   selectFrom('execution_runs').select([...]).where('run_id','=',id).executeTakeFirst()
 *   selectFrom('execution_jobs').select([...]).where('run_id','=',id).execute()
 * The fake is table-keyed and records whether any write ran, so a test can
 * assert the handler never mutates (it is a read-only system reconciliation).
 */
function makeFakeDb(rows: {
  runs: Record<string, Record<string, unknown>>;
  jobs: Record<string, Array<Record<string, unknown>>>;
}): { db: Kysely<Database>; mutated: () => boolean } {
  let mutated = false;
  const chain = (table: string) => {
    let runId = '';
    const builder: Record<string, unknown> = {
      select: () => builder,
      where: (_col: string, _op: string, val: string) => {
        runId = val;
        return builder;
      },
      executeTakeFirst: async () => rows.runs[runId],
      execute: async () => (table === 'execution_jobs' ? (rows.jobs[runId] ?? []) : []),
    };
    return builder;
  };
  const db = {
    selectFrom: (table: string) => chain(table),
    insertInto: () => {
      mutated = true;
      throw new Error('handleRunState must not write');
    },
    updateTable: () => {
      mutated = true;
      throw new Error('handleRunState must not write');
    },
  } as unknown as Kysely<Database>;
  return { db, mutated: () => mutated };
}

const req = (runId: string): DashboardRunStateRequest => ({
  type: 'dashboard.run.state',
  requestId: 'r1',
  actor: { type: 'system', component: 'run-reconciler' },
  runId,
});

describe('handleRunState (dashboard.run.state system read)', () => {
  it('projects a known run into the StateReplayRun shape', async () => {
    const { db } = makeFakeDb({
      runs: {
        'run-1': {
          run_id: 'run-1',
          workflow_name: 'ci',
          status: 'success',
          routing_key: 'github:1',
          repo_identifier: 'owner/repo',
          sha: 'abc',
          ref: 'refs/heads/main',
          started_at: new Date(1_700_000_000_000),
          completed_at: new Date(1_700_000_005_000),
          duration_ms: 5000,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: null,
          triggered_by_agent_label: null,
          failure_reason: null,
          failure_class: null,
        },
      },
      jobs: { 'run-1': [{ job_id: 'j1', job_name: 'build', status: 'success' }] },
    });
    const resp = await handleRunState({ db }, req('run-1'));
    expect(resp.type).toBe('dashboard.run.state.response');
    expect(resp.run?.runId).toBe('run-1');
    expect(resp.run?.status).toBe('success');
    expect(resp.run?.routingKey).toBe('github:1');
    expect(resp.run?.jobCount).toBe(1);
    expect(resp.run?.startedAt).toBe(1_700_000_000_000);
    expect(resp.run?.completedAt).toBe(1_700_000_005_000);
    expect(resp.run?.jobs).toEqual([{ jobId: 'j1', jobName: 'build', status: 'success' }]);
  });

  it('returns run: null for an unknown run id', async () => {
    const { db } = makeFakeDb({ runs: {}, jobs: {} });
    const resp = await handleRunState({ db }, req('nope'));
    expect(resp.run).toBeNull();
  });

  it('never writes to the database (read-only reconciliation)', async () => {
    const { db, mutated } = makeFakeDb({
      runs: {
        'run-2': {
          run_id: 'run-2',
          workflow_name: 'ci',
          status: 'running',
          routing_key: null,
          repo_identifier: 'owner/repo',
          sha: 'def',
          ref: 'refs/heads/main',
          started_at: new Date(1_700_000_000_000),
          completed_at: null,
          duration_ms: null,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: null,
          triggered_by_agent_label: null,
          failure_reason: null,
          failure_class: null,
        },
      },
      jobs: {},
    });
    const resp = await handleRunState({ db }, req('run-2'));
    expect(resp.run?.status).toBe('running');
    expect(resp.run?.jobCount).toBe(0);
    expect(mutated()).toBe(false);
  });
});
