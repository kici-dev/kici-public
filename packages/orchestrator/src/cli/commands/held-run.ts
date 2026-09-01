/**
 * Held-run commands for kici-admin.
 *
 * Subcommand namespace: `kici-admin held-run <list|approve|reject>`.
 *
 * The local answer to a held run, for an orchestrator that has no Platform.
 * Every other release surface is Platform-relayed — the dashboard approval
 * queue, `kici approve` / `kici reject`, and the developer MCP tools all reach
 * the applier over the control-plane connection — and the one surface that is
 * not, a `/kici approve` pull-request comment, releases the `security` queue
 * only. So on an independent orchestrator an approval-queue hold had no answer
 * at all and could only expire.
 *
 * These verbs are therefore the mirror image of `trust-policy set`: they work
 * only where no Platform is attached, and the route refuses with 409 wherever
 * one is. That refusal is surfaced verbatim rather than reworded here, so the
 * CLI cannot drift from what the server actually said.
 *
 * A hold is named the same way `kici approve` names one — `--job` / `--step` /
 * `--hold-type` / `--hold`, resolved by the shared `resolveHeldRunId` — so an
 * operator disambiguating a doubly-held job types the same flags on either
 * surface. That sharing is the point: a job gated by BOTH a reviewer hold and a
 * security hold writes two pending rows requiring two decisions, and a second
 * resolver would be free to disagree about which one `--job` means.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import {
  ApprovalDecision,
  HoldType,
  resolveHeldRunId,
  type HeldRunSummary,
} from '@kici-dev/engine';
import type { AdminApiClient } from '../api-client.js';

/** The list response the admin route returns. */
interface HeldRunListResponse {
  heldRuns: HeldRunSummary[];
}

/** One held-run row as the admin route reports it, with the clause list it adds. */
type AdminHeldRunSummary = HeldRunSummary & {
  /** Approver clauses the hold's requirement carries; `[]` when it names nobody. */
  clauses?: Array<{ team: string } | { user: string }>;
};

/** The decision response the admin route returns. */
interface DecisionResponse {
  status: string;
  remainingClauses?: number;
}

/** The filters both verbs accept, spelled exactly as `kici approve` spells them. */
interface HoldFilterOptions {
  job?: string;
  step?: string;
  hold?: string;
  holdType?: string;
}

/** Render one clause the way the SDK's `approvers` list writes it. */
function formatClause(clause: { team: string } | { user: string }): string {
  return 'team' in clause ? `{team}${clause.team}` : clause.user;
}

/**
 * Render the pending holds for a run.
 *
 * Per-entry rather than a count: "which hold do I answer, and who may answer
 * it" is the question this command exists to answer, and the hold id it prints
 * is the `--hold <id>` disambiguator the resolver hands back when nothing else
 * separates two holds.
 */
export function formatHeldRuns(res: { heldRuns: AdminHeldRunSummary[] }, format: string): string {
  if (format === 'json') return JSON.stringify(res, null, 2);
  if (res.heldRuns.length === 0) return 'No pending holds for this run.';

  return res.heldRuns
    .map((h) => {
      const scope =
        h.holdScope === 'step' && h.stepIndex != null
          ? `step ${h.stepIndex} of ${h.jobId}`
          : (h.jobId ?? '(unnamed hold)');
      const approvers = h.clauses?.length
        ? h.clauses.map(formatClause).join(' AND ')
        : 'anyone eligible';
      return [
        `${h.id}`,
        `  Element:   ${scope} (${h.holdScope ?? 'job'} scope)`,
        `  Type:      ${h.holdType ?? 'unknown'} / ${h.queueType ?? 'context'} queue`,
        `  Reason:    ${h.reason ?? '-'}`,
        `  Expires:   ${h.expiresAt ?? 'never'}`,
        `  Approvers: ${approvers}`,
      ].join('\n');
    })
    .join('\n\n');
}

/** Say what the applier did, in the vocabulary `ApplyDecisionResult.status` uses. */
export function formatDecision(res: DecisionResponse, decision: ApprovalDecision): string {
  if (res.status === 'pending') {
    const remaining = res.remainingClauses ?? 0;
    return `Approval recorded. The hold stays held: ${remaining} clause(s) remain unsatisfied.`;
  }
  if (res.status === 'released') {
    return 'Hold released. The held element has been re-dispatched.';
  }
  if (res.status === 'rejected') {
    return 'Hold rejected. The held element was cancelled.';
  }
  return `Decision '${decision}' applied: ${res.status}`;
}

/** Fetch the run's pending holds, resolve the one the filters name, or exit. */
async function resolveHold(
  getClient: () => AdminApiClient,
  opts: { customerId: string; runId: string } & HoldFilterOptions,
): Promise<string> {
  const listed = await getClient().get<HeldRunListResponse>(
    `/api/v1/admin/held-runs?customerId=${encodeURIComponent(opts.customerId)}` +
      `&runId=${encodeURIComponent(opts.runId)}`,
  );
  const resolution = resolveHeldRunId(listed.heldRuns ?? [], {
    ...(opts.job !== undefined && { job: opts.job }),
    ...(opts.step !== undefined && { step: opts.step }),
    ...(opts.hold !== undefined && { holdId: opts.hold }),
    ...(opts.holdType !== undefined && { holdType: opts.holdType }),
  });
  if (!resolution.ok) {
    console.error(`Error: ${resolution.error}`);
    process.exit(1);
  }
  return resolution.heldRunId;
}

/** Attach the four disambiguators, identically on both verbs. */
function addFilterOptions(cmd: Command): Command {
  return cmd
    .option('--job <name>', 'Match a hold by its job name')
    .option('--step <index>', 'Match a step-scoped hold by its step index')
    .option('--hold <id>', 'Match one hold by its own id (ignores every other filter)')
    .option('--hold-type <type>', `Narrow to holds of one type (${HoldType.options.join(' | ')})`);
}

export function registerHeldRunCommands(program: Command, getClient: () => AdminApiClient): void {
  const group = program
    .command('held-run')
    .description(
      'List and answer the runs this orchestrator is holding (independent orchestrators only ' +
        '— a Platform-attached orchestrator is answered from the dashboard)',
    );

  group
    .command('list')
    .description('Print the pending holds for a run, with the approvers each one requires')
    .requiredOption('--customer-id <id>', 'Org / customer id')
    .requiredOption('--run-id <id>', 'Run whose holds to list')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { customerId: string; runId: string; format: string }) => {
      try {
        const res = await getClient().get<{ heldRuns: AdminHeldRunSummary[] }>(
          `/api/v1/admin/held-runs?customerId=${encodeURIComponent(opts.customerId)}` +
            `&runId=${encodeURIComponent(opts.runId)}`,
        );
        console.log(formatHeldRuns(res, opts.format));
      } catch (err) {
        // Includes the route's 409 "answered through the KiCI Platform"
        // message, surfaced verbatim.
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  const approve = addFilterOptions(
    group
      .command('approve')
      .description(
        'Approve a held run, letting the held work RUN. It does not make the contributor ' +
          'trusted: an untrusted fork PR still resumes with the base-branch lock file, no ' +
          'install or registry secrets, and an isolated cache write scope',
      )
      .requiredOption('--customer-id <id>', 'Org / customer id')
      .requiredOption('--run-id <id>', 'Run whose hold to approve'),
  );
  approve.action(async (opts: { customerId: string; runId: string } & HoldFilterOptions) => {
    await postDecision(getClient, opts, ApprovalDecision.enum.approve);
  });

  const reject = addFilterOptions(
    group
      .command('reject')
      .description('Reject a held run, cancelling the element it was holding')
      .requiredOption('--customer-id <id>', 'Org / customer id')
      .requiredOption('--run-id <id>', 'Run whose hold to reject')
      .requiredOption('--reason <text>', 'Why the hold is being rejected'),
  );
  reject.action(
    async (opts: { customerId: string; runId: string; reason: string } & HoldFilterOptions) => {
      await postDecision(getClient, opts, ApprovalDecision.enum.reject, opts.reason);
    },
  );
}

/** Resolve the named hold and POST the decision, reporting what the applier did. */
async function postDecision(
  getClient: () => AdminApiClient,
  opts: { customerId: string; runId: string } & HoldFilterOptions,
  decision: ApprovalDecision,
  reason?: string,
): Promise<void> {
  try {
    const heldRunId = await resolveHold(getClient, opts);
    const res = await getClient().post<DecisionResponse>('/api/v1/admin/held-runs/decision', {
      customerId: opts.customerId,
      heldRunId,
      decision,
      ...(reason !== undefined && { reason }),
    });
    console.log(formatDecision(res, decision));
  } catch (err) {
    console.error(`Error: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}
