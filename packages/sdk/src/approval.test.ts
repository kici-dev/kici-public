import { describe, it, expect } from 'vitest';
import { normalizeRequireApproval } from './approval.js';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';

describe('normalizeRequireApproval', () => {
  it('true → empty clause list', () => {
    expect(normalizeRequireApproval(true)).toEqual({ clauses: [] });
  });

  it('array → clause list', () => {
    expect(normalizeRequireApproval([{ team: 'x' }, { user: 'y' }])).toEqual({
      clauses: [{ team: 'x' }, { user: 'y' }],
    });
  });

  it('object form preserves reason and timeout', () => {
    expect(
      normalizeRequireApproval({ approvers: [{ team: 'leads' }], reason: 'deploy', timeout: 3600 }),
    ).toEqual({ clauses: [{ team: 'leads' }], reason: 'deploy', timeoutSeconds: 3600 });
  });
});

describe('requireApproval flows through the factories', () => {
  it('workflow() preserves requireApproval (guards the return-spread bug)', () => {
    const wf = workflow('w', { on: {}, jobs: [], requireApproval: [{ team: 'leads' }] });
    expect(wf.requireApproval).toEqual([{ team: 'leads' }]);
  });

  it('job() preserves requireApproval', () => {
    const j = job('deploy', { runsOn: 'ubuntu', run: async () => {}, requireApproval: true });
    expect(j.requireApproval).toBe(true);
  });

  it('step() preserves requireApproval', () => {
    const s = step({ run: async () => {}, requireApproval: [{ user: 'cto' }] });
    expect(s.requireApproval).toEqual([{ user: 'cto' }]);
  });
});
