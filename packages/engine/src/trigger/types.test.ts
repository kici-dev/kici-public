import { describe, it, expect } from 'vitest';
import { NeedsEntrySchema, NeedsGroupEntrySchema, SCHEMA_VERSION } from './types.js';
import type { LockDynamicJobFn, LockStep, LockJob, LockWorkflow } from './types.js';

describe('lock approval config', () => {
  it('SCHEMA_VERSION is 20', () => {
    expect(SCHEMA_VERSION).toBe(20);
  });

  it('LockStep/LockJob/LockWorkflow accept an approval block', () => {
    const step: LockStep = {
      name: 's',
      hasOutputs: false,
      approval: { clauses: [{ team: 'leads' }], reason: 'gate', timeoutSeconds: 3600 },
    };
    const jobApproval: LockJob['approval'] = { clauses: [] };
    const wfApproval: LockWorkflow['approval'] = { clauses: [{ user: 'cto' }] };
    expect(step.approval?.clauses).toHaveLength(1);
    expect(jobApproval?.clauses).toHaveLength(0);
    expect(wfApproval?.clauses[0]).toEqual({ user: 'cto' });
  });
});

describe('NeedsEntrySchema', () => {
  it('parses { name: "build", ifFailed: "skip" }', () => {
    const result = NeedsEntrySchema.parse({ name: 'build', ifFailed: 'skip' });
    expect(result.name).toBe('build');
    expect(result.ifFailed).toBe('skip');
  });

  it('parses { name: "build", ifFailed: "run" }', () => {
    const result = NeedsEntrySchema.parse({ name: 'build', ifFailed: 'run' });
    expect(result.name).toBe('build');
    expect(result.ifFailed).toBe('run');
  });

  it('defaults ifFailed to "skip" when omitted', () => {
    const result = NeedsEntrySchema.parse({ name: 'build' });
    expect(result.ifFailed).toBe('skip');
  });

  it('rejects invalid ifFailed value', () => {
    expect(() => NeedsEntrySchema.parse({ name: 'build', ifFailed: 'invalid' })).toThrow();
  });

  it('rejects missing name', () => {
    expect(() => NeedsEntrySchema.parse({ ifFailed: 'skip' })).toThrow();
  });
});

describe('NeedsGroupEntrySchema', () => {
  it('parses { group: "tests", ifFailed: "run" }', () => {
    const result = NeedsGroupEntrySchema.parse({ group: 'tests', ifFailed: 'run' });
    expect(result.group).toBe('tests');
    expect(result.ifFailed).toBe('run');
  });

  it('parses { group: "tests", ifFailed: "skip" }', () => {
    const result = NeedsGroupEntrySchema.parse({ group: 'tests', ifFailed: 'skip' });
    expect(result.group).toBe('tests');
    expect(result.ifFailed).toBe('skip');
  });

  it('defaults ifFailed to "skip" when omitted', () => {
    const result = NeedsGroupEntrySchema.parse({ group: 'tests' });
    expect(result.ifFailed).toBe('skip');
  });

  it('rejects invalid ifFailed value', () => {
    expect(() => NeedsGroupEntrySchema.parse({ group: 'tests', ifFailed: 'invalid' })).toThrow();
  });

  it('rejects missing group', () => {
    expect(() => NeedsGroupEntrySchema.parse({ ifFailed: 'skip' })).toThrow();
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
