/**
 * Hold visibility and inline approve/reject for `kici run remote`. Each new
 * pending hold (a `when: 'always'` gate, or a `when: 'drift'` step gate with a
 * computed-drift payload) is printed and, in a TTY, prompted for inline through
 * the transport's hold access. In a non-TTY the run stays held until resolved
 * out of band.
 */

import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { HeldRunSummary } from '@kici-dev/engine';
import {
  resolveHeldRunContext,
  postApprove,
  postReject,
  type HeldRunContext,
} from './held-run-client.js';

/** Injected so the poll branch is unit-testable. */
export type ConfirmPrompt = (message: string) => Promise<boolean>;

export type HoldOutput = (line: string) => void;

export type HoldAction =
  { kind: 'prompt'; hold: HeldRunSummary } | { kind: 'notify'; hold: HeldRunSummary };

/** One action per new pending hold (TTY ⇒ prompt, else notify). Pure: the caller does the IO. */
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

function printHold(hold: HeldRunSummary, out: HoldOutput): void {
  const scope = hold.holdScope ?? 'job';
  const where =
    scope === 'step' && hold.stepIndex != null
      ? `step #${hold.stepIndex}${hold.jobId ? ` of job '${hold.jobId}'` : ''}`
      : hold.jobId
        ? `job '${hold.jobId}'`
        : scope;
  out(pc.yellow(`\n[kici] Run held for approval (${where}).`));
  if (hold.payload?.summaryMarkdown) {
    out(pc.dim('Computed drift — review before approving:'));
    for (const line of hold.payload.summaryMarkdown.split('\n')) {
      out(pc.dim(`    ${line}`));
    }
  }
}

/**
 * Prints each new hold and, in a TTY, prompts to approve/reject inline over the
 * shared held-run HTTP path. The held-run context is resolved lazily on first
 * need and reused across the tick's holds.
 */
export async function handleNewHolds(args: {
  holds: readonly HeldRunSummary[];
  seen: Set<string>;
  isTty: boolean;
  confirm: ConfirmPrompt;
  /**
   * `--approve-all` breakglass: each hold is auto-approved (run-scoped) instead
   * of prompted; approvals are marked `auto_approve` so the
   * orchestrator audits them distinctly; eligibility is enforced server-side.
   */
  approveAll?: boolean;
  /** Defaults to `logger.info` (stdout); quiet / `--json` callers pass a stderr sink. */
  output?: HoldOutput;
  /** Replaces the `kici approve` hint (a direct run names `kici-admin`). */
  answerHint?: (hold: HeldRunSummary) => string;
  /** Test override; defaults to the shared Platform held-run context. */
  resolveContext?: () => Promise<HeldRunContext | null>;
  /** Test override. */
  approve?: (ctx: HeldRunContext, heldRunId: string, autoApprove?: boolean) => Promise<boolean>;
  /** Test override. */
  reject?: (ctx: HeldRunContext, heldRunId: string, reason: string) => Promise<boolean>;
}): Promise<Set<string>> {
  const { actions, seen } = classifyNewHolds(args.holds, args.seen, args.isTty);
  if (actions.length === 0) return seen;

  const out = args.output ?? ((line: string) => logger.info(line));
  const resolveCtx = args.resolveContext ?? resolveHeldRunContext;
  const doApprove = args.approve ?? postApprove;
  const doReject = args.reject ?? postReject;
  let ctx: HeldRunContext | null = null;
  if (args.approveAll) {
    out(
      pc.yellow(
        '[kici] --approve-all: auto-approving every gate for this run (eligibility enforced).',
      ),
    );
  }

  const hint = (hold: HeldRunSummary): string | undefined =>
    args.answerHint ? `Run held; approve via \`${args.answerHint(hold)}\`.` : undefined;

  for (const action of actions) {
    printHold(action.hold, out);
    ctx = ctx ?? (await resolveCtx());
    if (!ctx) {
      // Names the hold: one job can carry two pending holds (an SDK
      // `requireApproval` plus a security-typed context gate).
      out(
        pc.dim(
          hint(action.hold) ??
            `Run held; approve via \`kici approve ${action.hold.runId} --hold ${action.hold.id}\`.`,
        ),
      );
      continue;
    }
    if (args.approveAll) {
      if (await doApprove(ctx, action.hold.id, true)) {
        out(pc.green('[kici] Auto-approved.'));
      }
      continue;
    }
    if (action.kind === 'notify') {
      out(
        pc.dim(
          hint(action.hold) ??
            `Run held; approve via the dashboard or \`kici approve ${action.hold.runId} --hold ${action.hold.id}\`.`,
        ),
      );
      continue;
    }
    const approved = await args.confirm('Approve this gate?');
    const ok = approved
      ? await doApprove(ctx, action.hold.id)
      : await doReject(ctx, action.hold.id, 'rejected via kici run');
    if (ok) {
      out(approved ? pc.green('[kici] Approved.') : pc.red('[kici] Rejected.'));
    }
  }
  return seen;
}
