import { describe, it, expect } from 'vitest';
import {
  BREAKING_FLOOR,
  NeedsEntrySchema,
  NeedsGroupEntrySchema,
  SCHEMA_VERSION,
  resolveWhenToRunOn,
} from './types.js';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '../protocol/messages/execution-status.js';
import { STATUS_FAILURE_CLASS, StatusFailureClass } from '../status/presentation.js';
import type { LockDynamicJobFn, LockStep, LockJob, LockWorkflow } from './types.js';

describe('lock schema version window', () => {
  it('floor never exceeds the current version', () => {
    expect(BREAKING_FLOOR).toBeLessThanOrEqual(SCHEMA_VERSION);
  });

  it('pins the current window (bump floor ONLY on a breaking schema change)', () => {
    expect(SCHEMA_VERSION).toBe(39);
    expect(BREAKING_FLOOR).toBe(30);
  });

  it('LockJob.invoke is additive — the floor stays below the version', () => {
    const gate: LockJob = {
      _type: 'static',
      name: 'repo-tests',
      steps: [],
      needs: [],
      invoke: { event: 'myorg.repo-tests', scope: 'source', optional: true },
    };
    expect(gate.invoke?.event).toBe('myorg.repo-tests');
    expect(gate.invoke?.scope).toBe('source');
    expect(gate.invoke?.optional).toBe(true);
    expect(BREAKING_FLOOR).toBeLessThan(SCHEMA_VERSION);

    // A bare invoke gate carries no `optional` (require-by-default).
    const required: LockJob = {
      _type: 'static',
      name: 'repo-tests',
      steps: [],
      needs: [],
      invoke: { event: 'myorg.repo-tests', scope: 'source' },
    };
    expect(required.invoke?.optional).toBeUndefined();
  });

  it('LockJob.sandbox is additive — the floor stays below the version', () => {
    // The per-job sandbox escape-hatch request is an additive optional field:
    // an older orchestrator ignores it, so the breaking floor is NOT bumped.
    const withSandbox: LockJob = {
      _type: 'static',
      name: 'build',
      steps: [],
      container: 'node:20',
      sandbox: { capabilities: ['NET_ADMIN'], network: 'host' },
    };
    expect(withSandbox.sandbox?.capabilities).toEqual(['NET_ADMIN']);
    expect(BREAKING_FLOOR).toBeLessThan(SCHEMA_VERSION);
  });
});

describe('lock approval config', () => {
  it('SCHEMA_VERSION is 39 (adds the container dockerfile build)', () => {
    expect(SCHEMA_VERSION).toBe(39);
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
  it('maps on-failure to failed + timed_out_stale + drift_dropped + unroutable', () => {
    expect(resolveWhenToRunOn('on-failure').sort()).toEqual(
      [
        ExecutionJobStatus.enum.failed,
        ExecutionJobStatus.enum.timed_out_stale,
        ExecutionJobStatus.enum.drift_dropped,
        ExecutionJobStatus.enum.unroutable,
      ].sort(),
    );
  });
  it('excludes cancelled, skipped and success from on-failure', () => {
    const set = resolveWhenToRunOn('on-failure');
    expect(set).not.toContain(ExecutionJobStatus.enum.cancelled);
    expect(set).not.toContain(ExecutionJobStatus.enum.skipped);
    expect(set).not.toContain(ExecutionJobStatus.enum.success);
  });
  it('is exactly the terminal statuses classified as failures', () => {
    // The expansion and the run roll-up must read one classification. This
    // pins the expansion to `STATUS_FAILURE_CLASS` rather than to a literal
    // list that a new failure status could silently miss.
    const expected = [...TERMINAL_JOB_STATES].filter(
      (s) =>
        STATUS_FAILURE_CLASS[s as keyof typeof STATUS_FAILURE_CLASS] ===
        StatusFailureClass.enum.failure,
    );
    expect([...resolveWhenToRunOn('on-failure')].sort()).toEqual(expected.sort());
  });
  it('maps on-skip to success + skipped', () => {
    expect(resolveWhenToRunOn('on-skip').sort()).toEqual(
      [ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped].sort(),
    );
  });
  it('maps always to every terminal status', () => {
    expect(resolveWhenToRunOn('always').sort()).toEqual([...TERMINAL_JOB_STATES].sort());
  });
  it('hands back a fresh array, so a caller cannot mutate the shared expansion', () => {
    // Two edges compiled from the same keyword must not alias one array: a
    // caller that sorts or pushes onto its result would otherwise reorder the
    // keyword's expansion for every other edge in the lock file.
    const first = resolveWhenToRunOn('on-failure');
    first.sort();
    first.push(ExecutionJobStatus.enum.cancelled);
    const second = resolveWhenToRunOn('on-failure');
    expect(second).not.toContain(ExecutionJobStatus.enum.cancelled);
    expect(second).toHaveLength(4);
  });
  it('copies a raw status-set rather than aliasing the caller-supplied array', () => {
    const raw = [ExecutionJobStatus.enum.skipped];
    const resolved = resolveWhenToRunOn(raw);
    resolved.push(ExecutionJobStatus.enum.failed);
    expect(raw).toEqual([ExecutionJobStatus.enum.skipped]);
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
