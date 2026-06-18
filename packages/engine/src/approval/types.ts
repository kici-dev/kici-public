/**
 * Shared approval requirement + clause types.
 *
 * One normalized `ApprovalRequirement` is produced by both approval triggers —
 * a mandatory environment policy and an explicit SDK `requireApproval` — and is
 * consumed identically by the orchestrator gate, the resolver, the held-run
 * store, and the agent step round-trip. Pure Zod (no node built-ins), so this
 * module is safe in the browser-facing engine barrel.
 */
import { z } from 'zod';

/**
 * A single approver clause. `{ team }` is satisfied by any member of the named
 * team; `{ user }` by that specific user. A flat AND list of clauses must all
 * be satisfied to release a held element.
 */
export const approverClauseSchema = z.union([
  z.object({ team: z.string().min(1) }).strict(),
  z.object({ user: z.string().min(1) }).strict(),
]);
export type ApproverClause = z.infer<typeof approverClauseSchema>;

/** Granularity of a held element. */
export const HoldScope = z.enum(['workflow', 'job', 'step']);
export type HoldScope = z.infer<typeof HoldScope>;

/** What triggered the hold: an environment policy (mandatory) or SDK code (explicit). */
export const TriggerSource = z.enum(['environment', 'explicit']);
export type TriggerSource = z.infer<typeof TriggerSource>;

/**
 * The normalized requirement attached to a held element. `clauses` is a flat
 * AND list; an empty list means "any approval-capable org member". `expiresAt`
 * is an ISO timestamp; on expiry the element is rejected.
 */
export const approvalRequirementSchema = z.object({
  clauses: z.array(approverClauseSchema),
  expiresAt: z.string(),
  reason: z.string(),
});
export type ApprovalRequirement = z.infer<typeof approvalRequirementSchema>;

/** An individual approve/reject decision recorded against a held element. */
export const ApprovalDecision = z.enum(['approve', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
