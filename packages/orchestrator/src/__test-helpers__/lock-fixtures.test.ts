import { describe, expect, it } from 'vitest';
import { lockFileFixture, lockWorkflow, staticJob } from './lock-fixtures.js';

describe('lock fixtures', () => {
  it('builds the default single-job CI workflow', () => {
    expect(lockFileFixture()).toEqual({
      schemaVersion: 1,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: 'test-hash',
      workflows: [
        {
          name: 'CI',
          triggers: [
            {
              _type: 'pr',
              events: ['opened', 'synchronize'],
              targetBranches: [],
              sourceBranches: [],
              paths: [],
            },
          ],
          jobs: [
            {
              _type: 'static',
              name: 'build',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              needs: [],
              steps: [{ name: 'Build', hasOutputs: false }],
            },
          ],
        },
      ],
    });
  });

  it('applies overrides without sharing state between calls', () => {
    const a = lockFileFixture({ contentHash: 'h1' });
    const b = lockFileFixture();
    (a.workflows[0]!.jobs as unknown[]).push(staticJob({ name: 'extra' }));
    (a.workflows[0]!.triggers[0] as unknown as { events: string[] }).events.push('closed');
    expect(b.workflows[0]!.jobs).toHaveLength(1);
    expect(b.workflows[0]!.triggers[0]).toMatchObject({ events: ['opened', 'synchronize'] });
    expect(a.contentHash).toBe('h1');
    expect(b.contentHash).toBe('test-hash');
  });

  it('builds a workflow from parts, keeping the defaults it was not given', () => {
    const wf = lockWorkflow({
      name: 'Deploy',
      jobs: [staticJob({ name: 'deploy', needs: ['build'] })],
    });
    expect(wf.name).toBe('Deploy');
    expect(wf.triggers).toEqual(lockWorkflow().triggers);
    expect(wf.jobs[0]).toEqual({ ...staticJob(), name: 'deploy', needs: ['build'] });
  });
});
