/**
 * Derive a coarse, trusted run-failure classification from existing signals.
 *
 * Pure derivation — no heuristics, no flaky/regression detection (that's a
 * deferred phase). KiCI computes this from data it already records, so the
 * resulting category is a trusted field on the agent run-result.
 */
import { AgentFailureCategory, ExecutionRunStatus } from '@kici-dev/engine';

export interface FailureSignals {
  /** `execution_runs.status`. */
  runStatus: string;
  /** A run- or job-scoped init failure was recorded. */
  hasInitFailure: boolean;
  /** The init-failure category (`InitFailureCategory`), if any. */
  initFailureCategory: string | null;
  /** Any job ended in `timed_out_stale` (or a workflow/job timeout fired). */
  timedOut: boolean;
  /** Any step recorded a non-zero exit code. */
  anyStepNonZeroExit: boolean;
}

/** Init-failure categories that mean "infrastructure", not "the workflow failed". */
const INFRA_INIT_CATEGORIES = new Set<string>(['no_agent']);

/** Run statuses that represent a terminal failure (vs success / in-flight). */
const TERMINAL_FAIL_STATUSES = new Set<string>([
  ExecutionRunStatus.enum.failed,
  ExecutionRunStatus.enum.cancelled,
]);

/**
 * Returns the failure category, or null for a non-failed run (success, or still
 * in flight). Precedence: init failure → timeout → cancelled → step exit →
 * unknown.
 */
export function deriveFailureCategory(s: FailureSignals): AgentFailureCategory | null {
  if (!TERMINAL_FAIL_STATUSES.has(s.runStatus)) return null;

  if (s.hasInitFailure) {
    return INFRA_INIT_CATEGORIES.has(s.initFailureCategory ?? '')
      ? AgentFailureCategory.enum.infra
      : AgentFailureCategory.enum.init_failure;
  }
  if (s.timedOut) return AgentFailureCategory.enum.timed_out;
  if (s.runStatus === ExecutionRunStatus.enum.cancelled) return AgentFailureCategory.enum.cancelled;
  if (s.anyStepNonZeroExit) return AgentFailureCategory.enum.step_failed;
  return AgentFailureCategory.enum.unknown;
}
