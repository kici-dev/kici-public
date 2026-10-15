/**
 * The `KiCI Security` check run a hold posts while it waits, and the single
 * place that terminalizes it when the hold ends.
 *
 * `postCheckStatus` writes ONE `KiCI Security` check run per commit, CREATING it
 * when none exists. Hence:
 *
 * 1. **A hold that posted no pending check is never terminalized**: that would
 *    fabricate a (failing) check on a pull request that never had one.
 *    {@link postedPendingSecurityCheck} is the discriminator.
 * 2. **Every hold on the commit shares the check** (a matrix's held jobs, two
 *    workflows held on one head sha). Terminalizing on the first hold to end
 *    would resolve — as `success`, on an approve — a check still gating the
 *    others, letting branch protection go green while security holds remain.
 *    {@link settleSecurityHoldCheck} posts only when no other pending hold on
 *    the commit owns the check; the last one out closes it.
 *
 * The commit coordinates come from `execution_runs`, the only source for a hold
 * at every scope: `repo_identifier` / `sha` / `routing_key` /
 * `provider_context` are written (`onExecutionStarted`, `recordRunHeld`) from
 * the same `ctx.repoIdentifier`, `ctx.ref`, `setup.info.routingKey` and
 * `ctx.credentials` the pending posts read. `setup.info.routingKey` is the
 * post-overlay key and `ctx.bundle` is the registration's bundle for a
 * cross-source dispatch, so the poster resolved from the stored routing key is
 * the one that wrote the pending status.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  CheckRunConclusion,
  HeldRunStatus,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  isSecurityHoldJobId,
  type CheckStatus,
  type CheckStatusPoster,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'security-hold-check' });

/** Resolve the check poster of the provider bundle a routing key is served by. */
export type ResolveCheckStatusPoster = (routingKey: string) => CheckStatusPoster | undefined;

/** The `held_runs` columns this module reads; a full `HeldRun` row satisfies it. */
export interface SecurityCheckHold {
  id: string;
  org_id: string;
  run_id: string;
  job_id: string;
  hold_scope: string;
  hold_type: string;
  approval_requirement: unknown;
  /**
   * Whether the pending post reached the provider. Required, so a projecting
   * query cannot silently omit it and fall back to the shape derivation.
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

const HOLD_OUTCOME_CONCLUSION: Record<HoldOutcome, CheckStatus> = {
  [HoldOutcome.Approved]: CheckRunConclusion.enum.success,
  [HoldOutcome.Rejected]: CheckRunConclusion.enum.cancelled,
  [HoldOutcome.Expired]: CheckRunConclusion.enum.timed_out,
};

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
 * `posted_pending_check` wins whenever set: it is written `true` only after the
 * provider accepted the post, so it records what HAPPENED. The shape derivation
 * below records what the code INTENDED, and is wrong for a refused post and for
 * a hold with no check poster in `ctx.bundle` — terminalizing those CREATES a
 * fabricated failing check on a pull request. The derivation serves only
 * `null` (a row older than the column).
 *
 * Three sites post the pending status, and the derivation reads them, not the
 * queue type: an install gate with a security-typed context protection rule
 * carries `queue_type = 'security'` and posts nothing.
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
 * `approval_requirement` is written by `createHold` and not by `create`, so it
 * identifies exactly the rows `holdJobForApproval` wrote through the approval
 * path (whose post is guarded by `if (hold && …)`). The other `createHold`
 * callers are excluded before it: the install gate by job id, the step bridge
 * by scope.
 */
export function postedPendingSecurityCheck(hold: SecurityCheckHold): boolean {
  if (hold.posted_pending_check !== null && hold.posted_pending_check !== undefined) {
    return hold.posted_pending_check;
  }
  // The step-approval bridge has no check poster in reach.
  if (hold.hold_scope === HoldScope.enum.step) return false;
  if (isSecurityHoldJobId(hold.job_id)) return true;
  if (hold.job_id.startsWith(INSTALL_JOB_ID_PREFIX)) return false;
  if (hold.approval_requirement != null) return true;
  return hold.hold_scope === HoldScope.enum.job && hold.hold_type === HoldType.enum.security;
}

/**
 * The terminal summary for a hold that ended, in the one vocabulary both check
 * families use: `cancelled` for a rejection, `timed_out` for an elapsed window,
 * `success` for an approval.
 *
 * The subject follows the hold's scope: a workflow-scoped hold owns the whole
 * run, a job-scoped one owns one job and says nothing about the others (a
 * still-pending step-approval hold would contradict a run-wide "no longer
 * waiting for approval").
 *
 * `actor` names whoever ended the hold (none on expiry). A surface that already
 * writes its attribution into `reason` (`/kici reject`: "Rejected by alice via
 * /kici reject") passes no `actor`, so the sentence lands once.
 *
 * **`actor` is a display name, published verbatim on a public commit check.**
 * Never an opaque identity-provider subject id: a surface holding one (the
 * dashboard / CLI / MCP applier) resolves it against the org's identity
 * directory first and passes nothing when no single name results — "an
 * approver", never `Approved by 8f3a-…-uuid` on a public pull request.
 *
 * `reason` is normalized to end in terminal punctuation.
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

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Terminalize the `KiCI Security` check of an ended hold, with conclusion, title
 * and summary from {@link HoldOutcome}. The single entry point for every surface
 * that ends a hold (the `/kici` comment handler, the dashboard / CLI / MCP
 * applier, the stale detector's approval-window sweep), so they cannot render
 * one event three ways.
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
 * The applier holds only an opaque identity-provider subject, and the summary is
 * public. `resolveDisplayName` maps it to the org identity directory's linked
 * account name; when none, the attribution is DROPPED, never the subject. A
 * separate function so the resolve-or-drop step is unit-tested.
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
 * Used directly where one summary must reach BOTH check families (a rejected
 * workflow-scoped hold reports the same, asserted sentence on `KiCI Security`
 * and the event's `kici/…` runs); everything else goes through
 * {@link settleSecurityCheckForOutcome}.
 *
 * Call it AFTER the hold's row has left `pending` (the applier flips inside
 * `recordAndReject` / `recordAndRelease`, the comment handler inside `reject` /
 * `approveByQueueType`) and, on an approve, BEFORE the resume, so a replayed
 * dispatch that holds again overwrites this terminal status with its pending
 * one, not the reverse. The ending hold's id is always excluded from the
 * contention query; a sweep that has not flipped its batch yet names the rest
 * in `excludeHoldIds`.
 *
 * Never throws: a provider error must not stop the hold's terminalization.
 * Callers bind suppression to the returned `posted` (a check was written, not
 * merely a delegate resolved).
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
   * Commits this caller already wrote in the same pass: a sweep's holds on one
   * commit share one check run and identical copy, so a second write is a
   * byte-identical round-trip.
   */
  skipCommits?: ReadonlySet<string> | undefined;
}): Promise<SettleSecurityCheckResult> {
  const { db, resolvePoster, hold } = args;
  try {
    if (!postedPendingSecurityCheck(hold)) {
      return { outcome: SecurityCheckSettlement.NotOwned, posted: false };
    }
    if (!resolvePoster) return { outcome: SecurityCheckSettlement.NoPoster, posted: false };

    // Every check-run coordinate comes from `execution_runs`.
    if (!db) return { outcome: SecurityCheckSettlement.NoCommit, posted: false };
    const run = await loadHoldCommit(db, hold.run_id);
    if (!run) return { outcome: SecurityCheckSettlement.NoCommit, posted: false };
    const commit = `${run.repoIdentifier}@${run.sha}`;
    if (args.skipCommits?.has(commit)) {
      return { outcome: SecurityCheckSettlement.AlreadySettled, posted: false, commit };
    }

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
    // jsonb arrives as a string on some drivers, an object on others (the same
    // read `execution-tracker` and `rerun` do).
    credentials: (typeof row.provider_context === 'string'
      ? JSON.parse(row.provider_context)
      : (row.provider_context ?? {})) as Record<string, unknown>,
  };
}

/**
 * Another still-pending hold on the commit that also posted the shared check,
 * or null when this hold is the last one out. Scoped by org too: two tenants in
 * a shared orchestrator database can have colliding repository identifiers.
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
