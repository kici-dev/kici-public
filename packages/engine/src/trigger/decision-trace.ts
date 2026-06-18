/**
 * Decision trace recording for debugging trigger matching.
 * Records every check performed during trigger evaluation.
 */

/**
 * Individual trace entry for a single check.
 */
export interface TraceEntry {
  /** What was checked (e.g., "branch pattern", "path filter", "event type") */
  check: string;
  /** The pattern/condition that was evaluated */
  pattern: string;
  /** The value being tested against */
  value: string;
  /** Whether the check passed */
  passed: boolean;
  /** Optional explanation */
  reason?: string;
}

/**
 * Decision trace for a workflow's trigger evaluation.
 */
export interface WorkflowDecision {
  workflowName: string;
  matched: boolean;
  /** Which trigger matched (if any) */
  matchedTrigger?: number;
  /** All checks performed */
  checks: TraceEntry[];
  /** Summary reason */
  summary: string;
}

/**
 * Create a new trace entry.
 */
export function createTraceEntry(
  check: string,
  pattern: string,
  value: string,
  passed: boolean,
  reason?: string,
): TraceEntry {
  return { check, pattern, value, passed, reason };
}

/**
 * Create a workflow decision record.
 */
export function createWorkflowDecision(
  workflowName: string,
  matched: boolean,
  checks: TraceEntry[],
  matchedTrigger?: number,
  summary?: string,
): WorkflowDecision {
  return {
    workflowName,
    matched,
    matchedTrigger,
    checks,
    summary: summary ?? (matched ? 'Trigger conditions met' : 'No matching trigger'),
  };
}
