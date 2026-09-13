import { describe, expect, it } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_JOB_STATES,
  type TerminalJobStatus,
} from '../protocol/messages/execution-status.js';
import {
  CANONICAL_STATUSES,
  STATUS_FAILURE_CLASS,
  STATUS_PRECEDENCE,
  StatusFailureClass,
  isFailureStatus,
  toCanonicalStatus,
  worstStatus,
} from './presentation.js';

describe('canonical status union', () => {
  it('is the deduped union of the run and job enums', () => {
    expect([...CANONICAL_STATUSES].sort()).toEqual(
      [...new Set([...ExecutionRunStatus.options, ...ExecutionJobStatus.options])].sort(),
    );
  });

  it('has thirteen members', () => {
    expect(CANONICAL_STATUSES).toHaveLength(13);
  });
});

describe('precedence', () => {
  it('ranks every canonical status exactly once', () => {
    expect(STATUS_PRECEDENCE).toHaveLength(CANONICAL_STATUSES.length);
    expect(new Set(STATUS_PRECEDENCE).size).toBe(CANONICAL_STATUSES.length);
  });

  it('orders failure ahead of in-flight ahead of success', () => {
    expect(STATUS_PRECEDENCE[0]).toBe(ExecutionJobStatus.enum.failed);
    expect(STATUS_PRECEDENCE.indexOf(ExecutionJobStatus.enum.running)).toBeLessThan(
      STATUS_PRECEDENCE.indexOf(ExecutionJobStatus.enum.success),
    );
    expect(STATUS_PRECEDENCE.indexOf(ExecutionJobStatus.enum.success)).toBeLessThan(
      STATUS_PRECEDENCE.indexOf(ExecutionJobStatus.enum.skipped),
    );
  });
});

describe('worstStatus', () => {
  it('reports an all-recovering group as recovering, not queued', () => {
    expect(
      worstStatus([ExecutionJobStatus.enum.recovering, ExecutionJobStatus.enum.recovering]),
    ).toBe(ExecutionJobStatus.enum.recovering);
  });

  it('reports a band containing a cancelling child as cancelling, not success', () => {
    expect(worstStatus([ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.cancelling])).toBe(
      ExecutionJobStatus.enum.cancelling,
    );
  });

  it('reports an all-skipped group as skipped', () => {
    expect(worstStatus([ExecutionJobStatus.enum.skipped, ExecutionJobStatus.enum.skipped])).toBe(
      ExecutionJobStatus.enum.skipped,
    );
  });

  it('reports a mixed success-and-skipped group as success', () => {
    expect(worstStatus([ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped])).toBe(
      ExecutionJobStatus.enum.success,
    );
  });

  it('keeps fail-fast: a failed child outranks a still-running sibling', () => {
    expect(worstStatus([ExecutionJobStatus.enum.running, ExecutionJobStatus.enum.failed])).toBe(
      ExecutionJobStatus.enum.failed,
    );
  });

  it('resolves legacy aliases', () => {
    expect(worstStatus(['error', ExecutionJobStatus.enum.success])).toBe(
      ExecutionRunStatus.enum.failed,
    );
  });

  it('returns undefined for empty and all-unknown input', () => {
    expect(worstStatus([])).toBeUndefined();
    expect(worstStatus(['not_a_status', 'also_not'])).toBeUndefined();
  });
});

describe('toCanonicalStatus', () => {
  it('resolves a canonical status to itself', () => {
    expect(toCanonicalStatus(ExecutionJobStatus.enum.drift_dropped)).toBe(
      ExecutionJobStatus.enum.drift_dropped,
    );
  });

  it('resolves known legacy spellings', () => {
    expect(toCanonicalStatus('canceled')).toBe(ExecutionRunStatus.enum.cancelled);
    expect(toCanonicalStatus('in_progress')).toBe(ExecutionRunStatus.enum.running);
  });

  it('does not resolve inherited Object.prototype keys', () => {
    expect(toCanonicalStatus('constructor')).toBeUndefined();
    expect(toCanonicalStatus('toString')).toBeUndefined();
  });

  it('returns undefined for an unknown status', () => {
    expect(toCanonicalStatus('brand_new_status')).toBeUndefined();
  });
});

describe('failure classification', () => {
  it('classifies every canonical status', () => {
    expect(Object.keys(STATUS_FAILURE_CLASS)).toHaveLength(CANONICAL_STATUSES.length);
    for (const status of CANONICAL_STATUSES) {
      expect(StatusFailureClass.options).toContain(STATUS_FAILURE_CLASS[status]);
    }
  });

  it('treats failed, timed_out_stale and drift_dropped as failures', () => {
    expect(isFailureStatus(ExecutionJobStatus.enum.failed)).toBe(true);
    expect(isFailureStatus(ExecutionJobStatus.enum.timed_out_stale)).toBe(true);
    expect(isFailureStatus(ExecutionJobStatus.enum.drift_dropped)).toBe(true);
  });

  it('does not treat cancelled, skipped or success as failures', () => {
    expect(isFailureStatus(ExecutionJobStatus.enum.cancelled)).toBe(false);
    expect(isFailureStatus(ExecutionJobStatus.enum.skipped)).toBe(false);
    expect(isFailureStatus(ExecutionJobStatus.enum.success)).toBe(false);
  });

  it('does not treat an unknown status as a failure', () => {
    expect(isFailureStatus('brand_new_status')).toBe(false);
  });
});

describe('TerminalJobStatus', () => {
  it('is exactly TERMINAL_JOB_STATES, in both directions', () => {
    // The runtime set and the type must not drift. `satisfies` proves every
    // member of the type is in the set; the length check proves the set has no
    // member the type omits.
    const fromType = {
      [ExecutionJobStatus.enum.success]: true,
      [ExecutionJobStatus.enum.failed]: true,
      [ExecutionJobStatus.enum.cancelled]: true,
      [ExecutionJobStatus.enum.skipped]: true,
      [ExecutionJobStatus.enum.timed_out_stale]: true,
      [ExecutionJobStatus.enum.drift_dropped]: true,
      [ExecutionJobStatus.enum.unroutable]: true,
    } satisfies Record<TerminalJobStatus, true>;

    expect([...TERMINAL_JOB_STATES].sort()).toEqual(Object.keys(fromType).sort());
  });

  it('excludes every non-terminal status', () => {
    for (const status of [
      ExecutionJobStatus.enum.pending,
      ExecutionJobStatus.enum.queued,
      ExecutionJobStatus.enum.running,
      ExecutionJobStatus.enum.recovering,
      ExecutionJobStatus.enum.cancelling,
    ]) {
      expect(TERMINAL_JOB_STATES.has(status)).toBe(false);
    }
  });
});
