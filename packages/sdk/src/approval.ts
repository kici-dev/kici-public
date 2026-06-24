/**
 * Workflow-author API for declaring a manual approval gate at step, job, or
 * workflow level. The author writes `approval`; the compiler normalizes it
 * into the lock file's `approval` block, and the orchestrator turns it into a
 * held element at dispatch time (for `when: 'always'`) or the agent turns it
 * into a mid-step drift gate (for `when: 'drift'`).
 */

/** A single approver clause: any member of a team, or a specific user. */
export type ApproverClause = { team: string } | { user: string };

/**
 * When the gate fires.
 *
 * - `always` (default) — gate BEFORE the element runs, with a static reason.
 *   Valid at step / job / workflow scope.
 * - `drift` — gate BETWEEN a step's `check` and `run`, only when `check`
 *   returns drift in apply mode. Step-scope only; requires a `check` facet.
 */
export type ApprovalWhen = 'always' | 'drift';

/**
 * Declarative approval requirement.
 *
 * - `true` — pause for ANY org member with the approval permission.
 * - `ApproverClause[]` — a flat AND list (all clauses must be satisfied).
 * - object form — clauses plus an optional `when`, a human `reason`, and a
 *   per-gate `timeout` (seconds) that overrides the org-default expiry.
 */
export type ApprovalConfig =
  | true
  | ApproverClause[]
  | { when?: ApprovalWhen; approvers?: ApproverClause[]; reason?: string; timeout?: number };

/** The normalized shape written into the lock file. */
export interface NormalizedApproval {
  clauses: ApproverClause[];
  reason?: string;
  timeoutSeconds?: number;
  when: ApprovalWhen;
}

/**
 * Normalize any `ApprovalConfig` form into
 * `{ clauses, reason?, timeoutSeconds?, when }`. `when` defaults to `'always'`.
 */
export function normalizeApproval(c: ApprovalConfig): NormalizedApproval {
  if (c === true) return { clauses: [], when: 'always' };
  if (Array.isArray(c)) return { clauses: c, when: 'always' };
  return {
    clauses: c.approvers ?? [],
    ...(c.reason !== undefined && { reason: c.reason }),
    ...(c.timeout !== undefined && { timeoutSeconds: c.timeout }),
    when: c.when ?? 'always',
  };
}
