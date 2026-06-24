/**
 * Hold-visibility + inline approve/reject for `kici run remote`.
 *
 * While a run is being watched, the orchestrator may pause it on an approval
 * gate (a `when: 'always'` step/job/workflow gate, or a `when: 'drift'` step
 * gate that carries a computed-drift payload). The poll loop calls
 * `handleNewHolds` each tick with the run's pending holds. For each hold not
 * seen before it prints the payload (if any) and, in a TTY, prompts the
 * operator to approve/reject inline — reusing the same Platform held-run HTTP
 * path as `kici approve` / `kici reject`. In a non-TTY it prints guidance and
 * keeps polling (the run stays held until resolved out-of-band).
 */

import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { HeldRunSummary } from './held-run-resolve.js';
import {
  resolveHeldRunContext,
  postApprove,
  postReject,
  type HeldRunContext,
} from './held-run-client.js';

/** A yes/no prompt; injected so the poll branch is unit-testable. */
export type ConfirmPrompt = (message: string) => Promise<boolean>;

/** What to do with a newly-observed hold. Pure — no IO. */
export type HoldAction =
  | { kind: 'prompt'; hold: HeldRunSummary }
  | { kind: 'notify'; hold: HeldRunSummary };

/**
 * Classify the holds observed this tick against the set already seen. Returns
 * one action per genuinely-new pending hold (TTY ⇒ prompt, non-TTY ⇒ notify),
 * and the updated seen-set. Pure: the caller performs the IO.
 */
export function classifyNewHolds(
  holds: readonly HeldRunSummary[],
  seen: Set<string>,
  isTty: boolean,
): { actions: HoldAction[]; seen: Set<string> } {
  const next = new Set(seen);
  const actions: HoldAction[] = [];
  for (const hold of holds) {
    if (hold.status !== 'pending') continue;
    if (next.has(hold.id)) continue;
    next.add(hold.id);
    actions.push({ kind: isTty ? 'prompt' : 'notify', hold });
  }
  return { actions, seen: next };
}

/** Print a hold's identity + its drift payload (when present) to stdout. */
function printHold(hold: HeldRunSummary): void {
  const scope = hold.holdScope ?? 'job';
  const where =
    scope === 'step' && hold.stepIndex != null
      ? `step #${hold.stepIndex}${hold.jobId ? ` of job '${hold.jobId}'` : ''}`
      : hold.jobId
        ? `job '${hold.jobId}'`
        : scope;
  logger.info(pc.yellow(`\n[kici] Run held for approval (${where}).`));
  if (hold.payload?.summaryMarkdown) {
    logger.info(pc.dim('Computed drift — review before approving:'));
    for (const line of hold.payload.summaryMarkdown.split('\n')) {
      logger.info(pc.dim(`    ${line}`));
    }
  }
}

/**
 * Process the new holds observed this tick: print each, and in a TTY prompt the
 * operator to approve/reject inline (posting the decision via the shared
 * held-run HTTP path). Returns the updated seen-set. A resolved context is
 * resolved lazily on first need and cached for the run.
 */
export async function handleNewHolds(args: {
  holds: readonly HeldRunSummary[];
  seen: Set<string>;
  isTty: boolean;
  confirm: ConfirmPrompt;
  /**
   * `--approve-all` breakglass: auto-approve each hold (run-scoped) instead of
   * prompting, marking the approval as `auto_approve` so the orchestrator
   * audits it distinctly. Eligibility is still enforced server-side.
   */
  approveAll?: boolean;
  /** Override for tests; defaults to the shared Platform held-run context. */
  resolveContext?: () => Promise<HeldRunContext | null>;
  /** Override for tests. */
  approve?: (ctx: HeldRunContext, heldRunId: string, autoApprove?: boolean) => Promise<boolean>;
  reject?: (ctx: HeldRunContext, heldRunId: string, reason: string) => Promise<boolean>;
}): Promise<Set<string>> {
  const { actions, seen } = classifyNewHolds(args.holds, args.seen, args.isTty);
  if (actions.length === 0) return seen;

  const resolveCtx = args.resolveContext ?? resolveHeldRunContext;
  const doApprove = args.approve ?? postApprove;
  const doReject = args.reject ?? postReject;
  let ctx: HeldRunContext | null = null;
  if (args.approveAll) {
    logger.info(
      pc.yellow(
        '[kici] --approve-all: auto-approving every gate for this run (eligibility enforced).',
      ),
    );
  }

  for (const action of actions) {
    printHold(action.hold);
    ctx = ctx ?? (await resolveCtx());
    if (!ctx) {
      logger.info(pc.dim(`Run held; approve via \`kici approve ${action.hold.runId}\`.`));
      continue;
    }
    if (args.approveAll) {
      // Breakglass: auto-approve (run-scoped); eligibility enforced server-side.
      if (await doApprove(ctx, action.hold.id, true)) {
        logger.info(pc.green('[kici] Auto-approved.'));
      }
      continue;
    }
    if (action.kind === 'notify') {
      logger.info(
        pc.dim(`Run held; approve via the dashboard or \`kici approve ${action.hold.runId}\`.`),
      );
      continue;
    }
    const approved = await args.confirm('Approve this gate?');
    const ok = approved
      ? await doApprove(ctx, action.hold.id)
      : await doReject(ctx, action.hold.id, 'rejected via kici run');
    if (ok) {
      logger.info(approved ? pc.green('[kici] Approved.') : pc.red('[kici] Rejected.'));
    }
  }
  return seen;
}
