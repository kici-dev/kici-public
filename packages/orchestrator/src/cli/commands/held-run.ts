/**
 * `kici-admin held-run <list|approve|reject>`: the local answer to a held run
 * on an orchestrator with no Platform. Every other release surface (dashboard
 * queue, `kici approve` / `kici reject`, developer MCP tools) is
 * Platform-relayed, and a `/kici approve` PR comment releases only the
 * `security` queue, so without these verbs an approval-queue hold could only
 * expire.
 *
 * The mirror image of `trust-policy set`: they work only where no Platform is
 * attached, and the route refuses with 409 elsewhere. That refusal is surfaced
 * verbatim so the CLI cannot drift from what the server said.
 *
 * By default a decision answers as the admin token, whose `service:` subject
 * satisfies no `{user}` or `{team}` clause. `--as <user-id>` answers as a
 * member of the approval directory (`kici-admin trust-policy directory-set`),
 * so a clause-bearing hold has an answer. An id the directory does not carry is
 * refused: an unvalidated subject would let a token satisfy any clause by
 * naming it.
 *
 * Holds are named with the same flags as `kici approve` (`--job` / `--step` /
 * `--hold-type` / `--hold`) through the shared `resolveHeldRunId`: a job gated
 * by BOTH a reviewer and a security hold has two pending rows, and a second
 * resolver could disagree about which one `--job` means.
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

interface HeldRunListResponse {
  heldRuns: HeldRunSummary[];
}

/** The admin route adds the clause list to each row. */
type AdminHeldRunSummary = HeldRunSummary & {
  /** Approver clauses the hold's requirement carries; `[]` when it names nobody. */
  clauses?: Array<{ team: string } | { user: string }>;
};

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

/**
 * Answer as a registered directory member. Without it the approver is the
 * token's `service:` identity, so a hold whose `approval_requirement` names a
 * person or team cannot be answered.
 */
interface ApproveAsOption {
  as?: string;
}

/** Attach `--as`, identically on both verbs. */
function addApproveAsOption(cmd: Command): Command {
  return cmd.option(
    '--as <user-id>',
    "Answer as this KiCI user id, so the decision satisfies the hold's {user} / {team} " +
      'clauses. Register the id first with `kici-admin trust-policy directory-set`',
  );
}

/** Render one clause the way the SDK's `approvers` list writes it. */
function formatClause(clause: { team: string } | { user: string }): string {
  return 'team' in clause ? `{team}${clause.team}` : clause.user;
}

/**
 * Per-entry rather than a count: the command answers "which hold, and who may
 * answer it", and the printed id is the `--hold <id>` disambiguator the
 * resolver hands back when nothing else separates two holds.
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
  opts: { org: string; runId: string } & HoldFilterOptions,
): Promise<string> {
  const listed = await getClient().get<HeldRunListResponse>(
    `/api/v1/admin/held-runs?customerId=${encodeURIComponent(opts.org)}` +
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
    .requiredOption('--org <id>', 'Org id')
    .requiredOption('--run-id <id>', 'Run whose holds to list')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (opts: { org: string; runId: string; format: string }) => {
      try {
        const res = await getClient().get<{ heldRuns: AdminHeldRunSummary[] }>(
          `/api/v1/admin/held-runs?customerId=${encodeURIComponent(opts.org)}` +
            `&runId=${encodeURIComponent(opts.runId)}`,
        );
        console.log(formatHeldRuns(res, opts.format));
      } catch (err) {
        // Surfaces the route's 409 "answered through the KiCI Platform" verbatim.
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  const approve = addApproveAsOption(
    addFilterOptions(
      group
        .command('approve')
        .description(
          'Approve a held run, letting the held work RUN. It does not make the contributor ' +
            'trusted: an untrusted fork PR still resumes with the base-branch lock file, no ' +
            'install or registry secrets, and an isolated cache write scope',
        )
        .requiredOption('--org <id>', 'Org id')
        .requiredOption('--run-id <id>', 'Run whose hold to approve'),
    ),
  );
  approve.action(
    async (opts: { org: string; runId: string } & HoldFilterOptions & ApproveAsOption) => {
      await postDecision(getClient, opts, ApprovalDecision.enum.approve);
    },
  );

  const reject = addApproveAsOption(
    addFilterOptions(
      group
        .command('reject')
        .description('Reject a held run, cancelling the element it was holding')
        .requiredOption('--org <id>', 'Org id')
        .requiredOption('--run-id <id>', 'Run whose hold to reject')
        .requiredOption('--reason <text>', 'Why the hold is being rejected'),
    ),
  );
  reject.action(
    async (
      opts: { org: string; runId: string; reason: string } & HoldFilterOptions & ApproveAsOption,
    ) => {
      await postDecision(getClient, opts, ApprovalDecision.enum.reject, opts.reason);
    },
  );
}

/** Resolve the named hold and POST the decision, reporting what the applier did. */
async function postDecision(
  getClient: () => AdminApiClient,
  opts: { org: string; runId: string } & HoldFilterOptions & ApproveAsOption,
  decision: ApprovalDecision,
  reason?: string,
): Promise<void> {
  try {
    const heldRunId = await resolveHold(getClient, opts);
    const res = await getClient().post<DecisionResponse>('/api/v1/admin/held-runs/decision', {
      customerId: opts.org,
      heldRunId,
      decision,
      ...(reason !== undefined && { reason }),
      ...(opts.as !== undefined && { asUserId: opts.as }),
    });
    console.log(formatDecision(res, decision));
  } catch (err) {
    console.error(`Error: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}
