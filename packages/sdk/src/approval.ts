/**
 * Workflow-author API for declaring a manual approval gate at step, job, or
 * workflow level. The author writes `requireApproval`; the compiler normalizes
 * it into the lock file's `approval` block, and the orchestrator turns it into
 * a held element at dispatch time.
 */

/** A single approver clause: any member of a team, or a specific user. */
export type ApproverClause = { team: string } | { user: string };

/**
 * Declarative approval requirement.
 *
 * - `true` — pause for ANY org member with the approval permission.
 * - `ApproverClause[]` — a flat AND list (all clauses must be satisfied).
 * - object form — clauses plus an optional human `reason` and a per-gate
 *   `timeout` (seconds) that overrides the org-default expiry.
 */
export type RequireApproval =
  | true
  | ApproverClause[]
  | { approvers: ApproverClause[]; reason?: string; timeout?: number };

/** The normalized shape written into the lock file. */
export interface NormalizedRequireApproval {
  clauses: ApproverClause[];
  reason?: string;
  timeoutSeconds?: number;
}

/** Normalize any `RequireApproval` form into `{ clauses, reason?, timeoutSeconds? }`. */
export function normalizeRequireApproval(r: RequireApproval): NormalizedRequireApproval {
  if (r === true) return { clauses: [] };
  if (Array.isArray(r)) return { clauses: r };
  return { clauses: r.approvers, reason: r.reason, timeoutSeconds: r.timeout };
}
