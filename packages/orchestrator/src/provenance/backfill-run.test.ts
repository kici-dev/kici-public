import { describe, expect, it, vi } from 'vitest';
import { backfillRunToPlatform } from './backfill-run.js';

describe('backfillRunToPlatform', () => {
  it('sends execution.status then a job.status.forward per job from local rows', async () => {
    const send = vi.fn();
    const loadRun = async () => ({
      run_id: 'r1',
      workflow_name: 'ci',
      status: 'success',
      repo_identifier: 'acme/app',
      provider: 'github',
      local_working_tree: false,
      sha: 'deadbeef',
      ref: 'main',
      job_count: 1,
      started_at: new Date(0),
      completed_at: new Date(1000),
      duration_ms: 1000,
    });
    const loadJobs = async () => [
      {
        run_id: 'r1',
        job_id: 'j1',
        job_name: 'build',
        status: 'success',
        started_at: new Date(0),
        completed_at: new Date(1000),
        agent_id: 'a1',
        orchestrator_id: 'o1',
      },
    ];

    await backfillRunToPlatform({ send, loadRun, loadJobs }, 'r1');

    const types = send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('execution.status');
    expect(types).toContain('job.status.forward');
    expect(types.indexOf('execution.status')).toBeLessThan(types.indexOf('job.status.forward'));

    const status = send.mock.calls[0][0] as Record<string, unknown>;
    expect(status).toMatchObject({ runId: 'r1', workflowName: 'ci', repoIdentifier: 'acme/app' });
  });

  it('throws when the run is not found locally', async () => {
    await expect(
      backfillRunToPlatform(
        { send: vi.fn(), loadRun: async () => null, loadJobs: async () => [] },
        'missing',
      ),
    ).rejects.toThrow(/not found in local execution_runs/);
  });
});
