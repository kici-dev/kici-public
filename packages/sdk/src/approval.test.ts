import { describe, it, expect } from 'vitest';
import { normalizeApproval } from './approval.js';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';

describe('normalizeApproval', () => {
  it('true → empty clause list, when defaults to always', () => {
    expect(normalizeApproval(true)).toEqual({ clauses: [], when: 'always' });
  });

  it('array → clause list, when defaults to always', () => {
    expect(normalizeApproval([{ team: 'x' }, { user: 'y' }])).toEqual({
      clauses: [{ team: 'x' }, { user: 'y' }],
      when: 'always',
    });
  });

  it('object form preserves approvers, reason, timeout and defaults when to always', () => {
    expect(
      normalizeApproval({ approvers: [{ team: 'leads' }], reason: 'deploy', timeout: 3600 }),
    ).toEqual({
      clauses: [{ team: 'leads' }],
      reason: 'deploy',
      timeoutSeconds: 3600,
      when: 'always',
    });
  });

  it('object form carries when:drift through normalization', () => {
    expect(
      normalizeApproval({ when: 'drift', approvers: [{ user: 'u1' }], reason: 'r', timeout: 60 }),
    ).toEqual({ clauses: [{ user: 'u1' }], reason: 'r', timeoutSeconds: 60, when: 'drift' });
  });

  it('object form with no approvers yields an empty clause list', () => {
    expect(normalizeApproval({ when: 'drift' })).toEqual({ clauses: [], when: 'drift' });
  });
});

describe('approval flows through the factories', () => {
  it('workflow() preserves approval (guards the return-spread bug)', () => {
    const wf = workflow('w', { on: {}, jobs: [], approval: [{ team: 'leads' }] });
    expect(wf.approval).toEqual([{ team: 'leads' }]);
  });

  it('job() preserves approval', () => {
    const j = job('deploy', { runsOn: 'ubuntu', run: async () => {}, approval: true });
    expect(j.approval).toBe(true);
  });

  it('step() preserves approval', () => {
    const s = step({ run: async () => {}, approval: [{ user: 'cto' }] });
    expect(s.approval).toEqual([{ user: 'cto' }]);
  });

  it('step() allows approval when:drift alongside a check facet', () => {
    const s = step('deploy', {
      check: async () => ({ want: 1 }),
      summarize: () => 'drift',
      run: async () => {},
      approval: { when: 'drift' },
    });
    expect(s.approval).toEqual({ when: 'drift' });
  });

  it('step() rejects approval when:drift without a check facet', () => {
    expect(() => step({ run: async () => {}, approval: { when: 'drift' } })).toThrow(
      /approval.when "drift" requires a check facet/,
    );
  });
});
