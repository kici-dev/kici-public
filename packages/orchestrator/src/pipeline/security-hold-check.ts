/**
 * The `KiCI Security` check run a hold posts while it waits, and the single
 * place that terminalizes it when the hold ends.
 *
 * `postCheckStatus` writes ONE check run named `KiCI Security` per commit, and
 * it CREATES that run when it finds none. Two consequences drive everything
 * here:
 *
 * 1. **A hold that posted no pending check must never be terminalized.** Doing
 *    so fabricates a check on a commit that never had one, and a fabricated
 *    failing check on a pull request is worse than the leak it would close.
 *    {@link postedPendingSecurityCheck} is the discriminator, derived from the
 *    three sites that post the pending status.
 * 2. **The check is shared by every hold on the commit.** A matrix workflow
 *    whose five jobs are all held for security posts five times into one check
 *    run, and so do two workflows held on the same head sha. Terminalizing on
 *    the first hold to end would resolve a check that is still gating the other
 *    four — as `success`, on an approve, which lets branch protection go green
 *    while security holds remain. {@link settleSecurityHoldCheck} therefore
 *    posts only when no other pending hold on the same commit still owns the
 *    check; the last one out closes it.
 *
 * The commit coordinates come from `execution_runs`, which is the only source
 * that exists for a hold at every scope. They are the same four values the
 * pending post used: `repo_identifier` / `sha` / `routing_key` /
 * `provider_context` are written from `ctx.repoIdentifier`, `ctx.ref`,
 * `setup.info.routingKey` and `ctx.credentials` (`onExecutionStarted` and
 * `recordRunHeld`), and the pending posts read the same four off the same
 * context. `setup.info.routingKey` is the post-overlay key, and `ctx.bundle` is
 * the registration's bundle for a cross-source dispatch, so the poster resolved
 * from the stored routing key is the poster that wrote the pending status.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  CheckRunConclusion,
  HeldRunStatus,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  isSecurityHoldJobId,
  normalizePersistedHoldType,
  type CheckStatus,
  type CheckStatusPoster,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'security-hold-check' });

/** Resolve the check poster of the provider bundle a routing key is served by. */
export type ResolveCheckStatusPoster = (routingKey: string) => CheckStatusPoster | undefined;

/**
 * The `held_runs` columns this module reads. A full `HeldRun` row satisfies it,
 * so every caller passes the row it already loaded rather than a projection.
 */
export interface SecurityCheckHold {
  id: string;
  org_id: string;
  run_id: string;
  job_id: string;
  hold_scope: string;
  hold_type: string;
  approval_requirement: unknown;
  /**
   * Whether the pending post reached the provider. Required rather than
   * optional so a query that projects columns by name cannot omit it and fall
   * back to the shape derivation without the compiler saying so.
   */
  posted_pending_check: boolean | null;
}

/** How a hold ended, which decides the conclusion, title and summary. */
export enum HoldOutcome {
  /** Released to run — an approver satisfied it. */
  Approved = 'approved',
  /** Refused by an approver. */
  Rejected = 'rejected',
  /** Nobody answered inside the approval window. */
  Expired = 'expired',
}

/** Why {@link settleSecurityHoldCheck} did or did not write the check. */
export enum SecurityCheckSettlement {
  /** A terminal status was written. */
  Posted = 'posted',
  /** This hold posted no pending check, so it has none to terminalize. */
  NotOwned = 'not-owned',
  /** The caller already wrote this commit's check earlier in the same pass. */
  AlreadySettled = 'already-settled',
  /** Another pending hold on the same commit still owns the check. */
  Contended = 'contended',
  /** The hold's run row is gone, so the commit cannot be named. */
  NoCommit = 'no-commit',
  /** No provider bundle serves the run's routing key any more. */
  NoPoster = 'no-poster',
  /**
   * The settlement could not complete — the provider refused the write, or the
   * hold row did not carry the columns the ownership predicate reads.
   */
  Failed = 'failed',
}

export interface SettleSecurityCheckResult {
  outcome: SecurityCheckSettlement;
  /** Whether a terminal status actually reached the provider. */
  posted: boolean;
  /** `owner/repo@sha`, once the hold's commit resolved. */
  commit?: string;
}

/** The terminal conclusion each outcome concludes the check with. */
const HOLD_OUTCOME_CONCLUSION: Record<HoldOutcome, CheckStatus> = {
  [HoldOutcome.Approved]: CheckRunConclusion.enum.success,
  [HoldOutcome.Rejected]: CheckRunConclusion.enum.cancelled,
  [HoldOutcome.Expired]: CheckRunConclusion.enum.timed_out,
};

/** The check-run title each outcome carries. */
const HOLD_OUTCOME_TITLE: Record<HoldOutcome, string> = {
  [HoldOutcome.Approved]: 'Approved',
  [HoldOutcome.Rejected]: 'Rejected',
  [HoldOutcome.Expired]: 'Approval window elapsed',
};

/** What a contributor should do next after a hold ended without running. */
const PUSH_AGAIN = 'Push a new commit to have the pull request evaluated again.';

/**
 * Whether this hold put a pending `KiCI Security` check on its commit, and so
 * has one to terminalize when it ends.
 *
 * `posted_pending_check` is the answer whenever the row carries one: it is
 * written `true` only after the provider accepted the post, so it records what
 * HAPPENED. Everything below records what the code INTENDED, which is a
 * different question and answers the wrong way twice — a post the provider
 * refused, and a hold reached with no check poster in `ctx.bundle`, both leave
 * a shape that says "posted" and a commit that has nothing. Terminalizing then
 * CREATES the check run, so the mirror of the stuck-check leak is a fabricated
 * failing check on a pull request.
 *
 * The shape derivation stays for `null` — a row written before the column
 * existed, for which no fact was recorded and an inference is all there is.
 *
 * Three sites post that pending status, and the derivation is read off them
 * rather than off the queue type — which cannot make the distinction, because a
 * workflow install gate whose context protection rule is security-typed carries
 * `queue_type = 'security'` and posts nothing at all.
 *
 * | Hold | Written by | Posts pending? | Recognised here by |
 * |---|---|---|---|
 * | org trust policy's PR-wide hold | `holdRunForSecurityPolicy` | yes | `job_id` is a `SECURITY_HOLD_JOB_IDS` sentinel |
 * | workflow install gate | `holdWorkflowForInstallGate` | no | `job_id` is `installGateJobId(name)` |
 * | SDK workflow `requireApproval` | `holdJobForApproval` | yes | carries an `approval_requirement` |
 * | context reviewer hold | `holdJobForApproval` | yes | carries an `approval_requirement` |
 * | SDK job `requireApproval` | `holdJobForApproval` | yes | carries an `approval_requirement` |
 * | context security hold | the per-env gate | yes | job scope + `hold_type = security` |
 * | wait-timer / concurrency hold | the per-env gate | no | none of the above matches |
 * | step approval | `StepApprovalBridge.request` | no | step scope |
 *
 * `approval_requirement` is what `createHold` writes and `create` does not, so
 * it identifies exactly the rows `holdJobForApproval` wrote through the
 * approval path — the site whose post is guarded by `if (hold && …)`. The two
 * other `createHold` callers are excluded above it: the install gate by its job
 * id, the step bridge by its scope.
 */
export function postedPendingSecurityCheck(hold: SecurityCheckHold): boolean {
  // The recorded fact, wherever there is one.
  if (hold.posted_pending_check !== null && hold.posted_pending_check !== undefined) {
    return hold.posted_pending_check;
  }
  // The step-approval bridge opens its hold with no check poster in reach.
  if (hold.hold_scope === HoldScope.enum.step) return false;
  // The org trust policy's PR-wide hold.
  if (isSecurityHoldJobId(hold.job_id)) return true;
  // The workflow install gate, which posts nothing.
  if (hold.job_id.startsWith(INSTALL_JOB_ID_PREFIX)) return false;
  // Every hold `holdJobForApproval` wrote through its approval path.
  if (hold.approval_requirement != null) return true;
  // The per-env context gate's own security hold.
  return (
    hold.hold_scope === HoldScope.enum.job &&
    normalizePersistedHoldType(hold.hold_type) === HoldType.enum.security
  );
}

/**
 * The terminal summary for a hold that ended, in the one vocabulary both check
 * families use: `cancelled` for a rejection, `timed_out` for an elapsed window,
 * `success` for an approval.
 *
 * The subject follows the hold's scope on every outcome, because the same event
 * means different things at each: a workflow-scoped hold owns the whole run,
 * while a job-scoped one owns one job and says nothing about the run's other
 * jobs — including a step-approval hold that is still pending, which a run-wide
 * "no longer waiting for approval" would contradict.
 *
 * `actor` names whoever ended the hold, on an approve and on a reject alike.
 * Only an expiry has none: nobody answered, which is what expiry means. A
 * rejecter whose surface already writes its own attribution into `reason` (the
 * `/kici reject` handler builds "Rejected by alice via /kici reject") passes no
 * `actor`, so the sentence lands once rather than twice.
 *
 * **`actor` is a display name, and it is published verbatim on a public commit
 * check.** It must never be an opaque identity-provider subject id: a surface
 * that holds one — the dashboard / CLI / MCP applier, which decides by KiCI
 * user id — resolves it against the org's identity directory first and passes
 * nothing when that resolves to no single name. Omitting the attribution reads
 * as "an approver"; leaking the subject reads as `Approved by
 * 8f3a-…-uuid`, on a pull request anyone can open.
 *
 * `reason` is normalized to end in terminal punctuation — a rejecter's own
 * sentence carries none, and without one it runs straight into what follows.
 */
export function buildHoldEndedSummary(args: {
  outcome: HoldOutcome;
  scope: string;
  reason?: string | undefined;
  actor?: string | undefined;
  via?: string | undefined;
}): string {
  const workflowScoped = args.scope === HoldScope.enum.workflow;
  const via = args.via ? ` via ${args.via}` : '';
  switch (args.outcome) {
    case HoldOutcome.Approved: {
      const who = args.actor ?? 'an approver';
      const released = workflowScoped
        ? 'The hold was released, so this run is no longer waiting for approval.'
        : 'The hold was released, so the job it was holding can start.';
      return `Approved by ${who}${via}. ${released}`;
    }
    case HoldOutcome.Rejected: {
      const who = args.actor ? `Rejected by ${args.actor}${via}. ` : '';
      const detail = args.reason?.trim() ? `${asSentence(args.reason)} ` : '';
      const opening = workflowScoped
        ? 'This run was cancelled before any job started.'
        : 'A job in this run was cancelled before it started.';
      return `${opening} ${who}${detail}${PUSH_AGAIN}`;
    }
    case HoldOutcome.Expired: {
      const opening = workflowScoped
        ? 'The approval window for this run elapsed, so no job started.'
        : 'The approval window for a job in this run elapsed, so that job never started.';
      return `${opening} ${PUSH_AGAIN}`;
    }
  }
}

/** End a fragment with terminal punctuation so it cannot run into what follows. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Terminalize the `KiCI Security` check of a hold that just ended, choosing the
 * conclusion, title and summary from {@link HoldOutcome}.
 *
 * The single entry point for every surface that ends a hold — the `/kici`
 * comment handler, the dashboard / CLI / MCP applier, and the stale detector's
 * approval-window sweep — so those surfaces cannot render one event three ways.
 */
export async function settleSecurityCheckForOutcome(args: {
  db: Kysely<Database> | undefined;
  resolvePoster: ResolveCheckStatusPoster | undefined;
  hold: SecurityCheckHold;
  outcome: HoldOutcome;
  reason?: string | undefined;
  actor?: string | undefined;
  via?: string | undefined;
  excludeHoldIds?: readonly string[] | undefined;
  skipCommits?: ReadonlySet<string> | undefined;
}): Promise<SettleSecurityCheckResult> {
  return settleSecurityHoldCheck({
    db: args.db,
    resolvePoster: args.resolvePoster,
    hold: args.hold,
    skipCommits: args.skipCommits,
    status: HOLD_OUTCOME_CONCLUSION[args.outcome],
    title: HOLD_OUTCOME_TITLE[args.outcome],
    summary: buildHoldEndedSummary({
      outcome: args.outcome,
      scope: args.hold.hold_scope,
      reason: args.reason,
      actor: args.actor,
      via: args.via,
    }),
    excludeHoldIds: args.excludeHoldIds,
  });
}

/**
 * The dashboard / CLI / MCP applier's entry point into
 * {@link settleSecurityCheckForOutcome}.
 *
 * That applier decides by KiCI user id, so the only actor it holds is an opaque
 * identity-provider subject — and this summary is published verbatim on a public
 * commit check. `resolveDisplayName` maps the subject onto the account name the
 * org's identity directory links it to; when it names none, the attribution is
 * DROPPED rather than falling back to the subject. So an approve reads
 * "Approved by an approver" at worst, never "Approved by 8f3a-…-uuid".
 *
 * Separate from its caller so the resolve-or-drop step is a unit under test
 * rather than a line in the composition root.
 */
export async function settleSecurityCheckForDecision(args: {
  db: Kysely<Database> | undefined;
  resolvePoster: ResolveCheckStatusPoster | undefined;
  /** Subject id → the linked account name, or undefined for no single name. */
  resolveDisplayName: (actorSub: string) => string | undefined;
  hold: SecurityCheckHold;
  outcome: HoldOutcome;
  /** Omitted where the summary must match one another writer built without it. */
  actorSub?: string | undefined;
  reason?: string | undefined;
}): Promise<SettleSecurityCheckResult> {
  return settleSecurityCheckForOutcome({
    db: args.db,
    resolvePoster: args.resolvePoster,
    hold: args.hold,
    outcome: args.outcome,
    actor: args.actorSub === undefined ? undefined : args.resolveDisplayName(args.actorSub),
    reason: args.reason,
  });
}

/**
 * Terminalize the `KiCI Security` check of a hold that just ended, under a
 * caller-supplied status and copy.
 *
 * Used directly where one summary has to reach BOTH check families — a rejected
 * workflow-scoped hold reports the same sentence on `KiCI Security` and on the
 * `kici/…` runs of the same event, and that sameness is asserted rather than
 * assumed. Everything else goes through {@link settleSecurityCheckForOutcome}.
 *
 * Call it AFTER the hold's own row has left `pending` (every caller does: the
 * applier flips inside `recordAndReject` / `recordAndRelease`, the comment
 * handler inside `reject` / `approveByQueueType`) — and, on an approve, BEFORE
 * the resume, so a replayed dispatch that holds again overwrites this terminal
 * status with its own pending one rather than the other way round. The ending
 * hold's own id is excluded from the contention query regardless, so a sweep
 * that has not yet flipped its batch can name it in `excludeHoldIds`.
 *
 * Never throws: terminalizing a check run is a reporting courtesy on a path
 * whose real job is to terminalize the hold, and a provider error must not stop
 * that. The returned `posted` is what a caller binds its own suppression to —
 * it says a check was written, not merely that a delegate resolved.
 */
export async function settleSecurityHoldCheck(args: {
  db: Kysely<Database> | undefined;
  resolvePoster: ResolveCheckStatusPoster | undefined;
  hold: SecurityCheckHold;
  status: CheckStatus;
  title: string;
  summary: string;
  excludeHoldIds?: readonly string[] | undefined;
  /**
   * Commits this caller already wrote in the same pass. A sweep that ends
   * several holds on one commit shares one check run between them, and every
   * hold in it carries the same conclusion and summary — so the second write
   * would be a byte-identical provider round-trip.
   */
  skipCommits?: ReadonlySet<string> | undefined;
}): Promise<SettleSecurityCheckResult> {
  const { db, resolvePoster, hold } = args;
  try {
    if (!postedPendingSecurityCheck(hold)) {
      return { outcome: SecurityCheckSettlement.NotOwned, posted: false };
    }
    if (!resolvePoster) return { outcome: SecurityCheckSettlement.NoPoster, posted: false };

    // Every coordinate of the check run — repo, sha, routing key, credentials —
    // comes out of `execution_runs`, so a settle with no database in reach has
    // nothing to address a post to and stops here.
    if (!db) return { outcome: SecurityCheckSettlement.NoCommit, posted: false };
    const run = await loadHoldCommit(db, hold.run_id);
    if (!run) return { outcome: SecurityCheckSettlement.NoCommit, posted: false };
    const commit = `${run.repoIdentifier}@${run.sha}`;
    if (args.skipCommits?.has(commit)) {
      return { outcome: SecurityCheckSettlement.AlreadySettled, posted: false, commit };
    }

    // Every hold that shares this commit's check run lives in the same database
    // the commit was just read out of, so the contention query always has one to
    // run against — a database-less settle returned `NoCommit` above.
    const contender = await findPendingCheckOwner(db, {
      orgId: hold.org_id,
      repoIdentifier: run.repoIdentifier,
      sha: run.sha,
      excludeHoldIds: [hold.id, ...(args.excludeHoldIds ?? [])],
    });
    if (contender) {
      logger.info('Left the security check pending: another hold on the commit still owns it', {
        runId: hold.run_id,
        holdId: hold.id,
        contendingHoldId: contender,
      });
      return { outcome: SecurityCheckSettlement.Contended, posted: false, commit };
    }

    const poster = resolvePoster(run.routingKey);
    if (!poster) return { outcome: SecurityCheckSettlement.NoPoster, posted: false, commit };

    await poster.postCheckStatus(
      run.repoIdentifier,
      run.sha,
      args.status,
      args.title,
      args.summary,
      run.credentials,
    );
    return { outcome: SecurityCheckSettlement.Posted, posted: true, commit };
  } catch (err) {
    logger.warn('Failed to complete the security check run of an ended hold', {
      runId: hold.run_id,
      holdId: hold.id,
      error: toErrorMessage(err),
    });
    return { outcome: SecurityCheckSettlement.Failed, posted: false };
  }
}

/** The commit a hold's run acted on, and the credentials to report on it. */
interface HoldCommit {
  repoIdentifier: string;
  sha: string;
  routingKey: string;
  credentials: Record<string, unknown>;
}

async function loadHoldCommit(db: Kysely<Database>, runId: string): Promise<HoldCommit | null> {
  const row = await db
    .selectFrom('execution_runs')
    .select(['repo_identifier', 'sha', 'routing_key', 'provider_context'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!row?.repo_identifier || !row.sha || !row.routing_key) return null;
  return {
    repoIdentifier: row.repo_identifier,
    sha: row.sha,
    routingKey: row.routing_key,
    // jsonb comes back as a string on some drivers and an object on others —
    // the same read `execution-tracker` and `rerun` already do.
    credentials: (typeof row.provider_context === 'string'
      ? JSON.parse(row.provider_context)
      : (row.provider_context ?? {})) as Record<string, unknown>,
  };
}

/**
 * The id of another still-pending hold on the same commit that also posted the
 * shared `KiCI Security` check, or null when this hold is the last one out.
 *
 * Scoped by org as well as repo + sha: a shared orchestrator database can hold
 * two tenants whose repository identifiers collide.
 */
async function findPendingCheckOwner(
  db: Kysely<Database>,
  args: {
    orgId: string;
    repoIdentifier: string;
    sha: string;
    excludeHoldIds: readonly string[];
  },
): Promise<string | null> {
  const rows = await db
    .selectFrom('held_runs')
    .innerJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
    .select([
      'held_runs.id',
      'held_runs.org_id',
      'held_runs.run_id',
      'held_runs.job_id',
      'held_runs.hold_scope',
      'held_runs.hold_type',
      'held_runs.approval_requirement',
      'held_runs.posted_pending_check',
    ])
    .where('held_runs.org_id', '=', args.orgId)
    .where('held_runs.status', '=', HeldRunStatus.enum.pending)
    .where('execution_runs.repo_identifier', '=', args.repoIdentifier)
    .where('execution_runs.sha', '=', args.sha)
    .execute();
  const excluded = new Set(args.excludeHoldIds);
  for (const row of rows) {
    if (excluded.has(row.id)) continue;
    if (postedPendingSecurityCheck(row)) return row.id;
  }
  return null;
}
