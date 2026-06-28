import { describe, it, expect } from 'vitest';
import {
  NeedsEntrySchema,
  NeedsGroupEntrySchema,
  SCHEMA_VERSION,
  resolveWhenToRunOn,
} from './types.js';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '../protocol/messages/execution-status.js';
import type { LockDynamicJobFn, LockStep, LockJob, LockWorkflow } from './types.js';

describe('lock approval config', () => {
  it('SCHEMA_VERSION is 29 (parallel step groups)', () => {
    expect(SCHEMA_VERSION).toBe(29);
  });

  it('LockJob accepts includeUninitialized alongside runsOnAll', () => {
    const lockJob: LockJob = {
      _type: 'static',
      name: 'converge',
      runsOnAll: { include: [[{ kind: 'exact', value: 'kici:role:test' }]], exclude: [] },
      includeUninitialized: true,
      steps: [],
      needs: [],
    };
    expect(lockJob.includeUninitialized).toBe(true);
  });

  it('LockStep accepts a retry data subset (no retryIf)', () => {
    const step: LockStep = {
      name: 's',
      hasOutputs: false,
      retry: { maxAttempts: 3, delayMs: 1000, backoff: 'exponential', maxDelayMs: 30000 },
    };
    expect(step.retry?.maxAttempts).toBe(3);
    expect(step.retry?.backoff).toBe('exponential');
  });

  it('LockStep/LockJob/LockWorkflow accept an approval block', () => {
    const step: LockStep = {
      name: 's',
      hasOutputs: false,
      approval: {
        clauses: [{ team: 'leads' }],
        reason: 'gate',
        timeoutSeconds: 3600,
        when: 'always',
      },
    };
    const jobApproval: LockJob['approval'] = { clauses: [], when: 'always' };
    const wfApproval: LockWorkflow['approval'] = { clauses: [{ user: 'cto' }], when: 'always' };
    expect(step.approval?.clauses).toHaveLength(1);
    expect(jobApproval?.clauses).toHaveLength(0);
    expect(wfApproval?.clauses[0]).toEqual({ user: 'cto' });
  });
});

describe('resolveWhenToRunOn', () => {
  it('defaults to success-only', () => {
    expect(resolveWhenToRunOn(undefined)).toEqual([ExecutionJobStatus.enum.success]);
  });
  it('maps on-success to success-only', () => {
    expect(resolveWhenToRunOn('on-success')).toEqual([ExecutionJobStatus.enum.success]);
  });
  it('maps on-failure to failed + timed_out_stale', () => {
    expect(resolveWhenToRunOn('on-failure').sort()).toEqual(
      [ExecutionJobStatus.enum.failed, ExecutionJobStatus.enum.timed_out_stale].sort(),
    );
  });
  it('maps on-skip to success + skipped', () => {
    expect(resolveWhenToRunOn('on-skip').sort()).toEqual(
      [ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped].sort(),
    );
  });
  it('maps always to every terminal status', () => {
    expect(resolveWhenToRunOn('always').sort()).toEqual([...TERMINAL_JOB_STATES].sort());
  });
  it('passes a raw status-set through', () => {
    expect(resolveWhenToRunOn([ExecutionJobStatus.enum.skipped])).toEqual([
      ExecutionJobStatus.enum.skipped,
    ]);
  });
});

describe('NeedsEntrySchema', () => {
  it('parses { name: "build", runOn: ["success"] }', () => {
    const result = NeedsEntrySchema.parse({
      name: 'build',
      runOn: [ExecutionJobStatus.enum.success],
    });
    expect(result.name).toBe('build');
    expect(result.runOn).toEqual([ExecutionJobStatus.enum.success]);
  });

  it('parses a multi-status runOn set', () => {
    const result = NeedsEntrySchema.parse({
      name: 'build',
      runOn: [ExecutionJobStatus.enum.failed, ExecutionJobStatus.enum.timed_out_stale],
    });
    expect(result.runOn).toEqual([
      ExecutionJobStatus.enum.failed,
      ExecutionJobStatus.enum.timed_out_stale,
    ]);
  });

  it('defaults runOn to [success] when omitted', () => {
    const result = NeedsEntrySchema.parse({ name: 'build' });
    expect(result.runOn).toEqual([ExecutionJobStatus.enum.success]);
  });

  it('rejects an invalid runOn status', () => {
    expect(() => NeedsEntrySchema.parse({ name: 'build', runOn: ['nope'] })).toThrow();
  });

  it('rejects an empty runOn set', () => {
    expect(() => NeedsEntrySchema.parse({ name: 'build', runOn: [] })).toThrow();
  });

  it('rejects missing name', () => {
    expect(() => NeedsEntrySchema.parse({ runOn: [ExecutionJobStatus.enum.success] })).toThrow();
  });
});

describe('NeedsGroupEntrySchema', () => {
  it('parses { group: "tests", runOn: ["success", "skipped"] }', () => {
    const result = NeedsGroupEntrySchema.parse({
      group: 'tests',
      runOn: [ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped],
    });
    expect(result.group).toBe('tests');
    expect(result.runOn).toEqual([
      ExecutionJobStatus.enum.success,
      ExecutionJobStatus.enum.skipped,
    ]);
  });

  it('defaults runOn to [success] when omitted', () => {
    const result = NeedsGroupEntrySchema.parse({ group: 'tests' });
    expect(result.runOn).toEqual([ExecutionJobStatus.enum.success]);
  });

  it('rejects an invalid runOn status', () => {
    expect(() => NeedsGroupEntrySchema.parse({ group: 'tests', runOn: ['invalid'] })).toThrow();
  });

  it('rejects missing group', () => {
    expect(() =>
      NeedsGroupEntrySchema.parse({ runOn: [ExecutionJobStatus.enum.success] }),
    ).toThrow();
  });
});

describe('LockDynamicJobFn with group field', () => {
  it('type-checks with optional group field', () => {
    const withGroup: LockDynamicJobFn = {
      _type: 'dynamic',
      source: { file: 'test.ts', index: 0 },
      group: 'test-shards',
    };
    expect(withGroup.group).toBe('test-shards');
  });

  it('type-checks without group field', () => {
    const withoutGroup: LockDynamicJobFn = {
      _type: 'dynamic',
      source: { file: 'test.ts', index: 0 },
    };
    expect(withoutGroup.group).toBeUndefined();
  });
});
