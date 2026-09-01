/**
 * Held run store -- lifecycle management for runs held by protection gates.
 *
 * Manages the lifecycle: pending -> approved/rejected/expired.
 */
import { sql, Kysely, PostgresDialect, type Transaction } from 'kysely';
import { z } from 'zod';
import pg from 'pg';
import {
  type ApprovalRequirement,
  type ApproverClause,
  type StepApprovalPayload,
  ApprovalDecision,
  HoldScope,
  HoldType,
  TriggerSource,
  persistedHoldTypeSpellings,
} from '@kici-dev/engine';
import type { Database, HeldRun, HeldRunApproval } from '../db/types.js';

/** A Kysely root handle or an in-flight transaction — query builders accept either. */
type Executor = Kysely<Database> | Transaction<Database>;

/** Status values for held runs (held_runs table). */
export enum HeldRunStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Expired = 'expired',
  Released = 'released',
}

/**
 * Reason a run was held in the security queue. Persisted verbatim in
 * `held_runs.reason` and whose vocabulary `buildSecurityHoldSummary` switches
 * on.
 *
 * Each value names why a run sits in the queue. The enum stays whole because
 * compiling code still names all four: `buildSecurityHoldSummary` renders one
 * branch per value. Dropping a member breaks that, and breaks the parity test
 * that pins `SECURITY_HOLD_JOB_IDS`' three policy-reason keys to this enum's
 * options — the engine constant cannot import the enum, so that coupling lives
 * only in the orchestrator's test. Nothing validates `held_runs.reason` against
 * this enum, so a stored value is not rejected anywhere.
 *
 * - `fork_pr` — the org trust policy's fork switch held the run.
 * - `context_trust` — a context's minimum-trust gate held the run.
 * - `workflow_modification` — deprecated; no longer raised. Modifications to
 *   `.kici/` are surfaced on their own informational check and no longer feed
 *   a policy arm. Removed at v1.0.0.
 * - `unknown_contributor` — deprecated; no longer raised. The policy turns on
 *   whether the pull request came from a fork, not on who opened it. Removed
 *   at v1.0.0.
 */
export const SecurityHoldReason = z.enum([
  'workflow_modification',
  'unknown_contributor',
  'fork_pr',
  'context_trust',
]);
export type SecurityHoldReason = z.infer<typeof SecurityHoldReason>;

/** Data required to create a held run. */
export interface CreateHeldRunData {
  runId: string;
  jobId: string;
  /** Bound context id, or null for context-free holds (e.g. workflow_modification). */
  contextId: string | null;
  holdType: string;
  reason: string;
  expiresAt: Date;
  /** Queue type: 'context' (default) or 'security'. */
  queueType?: 'context' | 'security';
  /**
   * Granularity of the held element. Omit to leave the column at its `'job'`
   * default. The org trust policy's PR-wide hold passes `'workflow'`: it fires
   * before any job is materialized and resumes by rebuilding the whole workflow
   * dispatch, so `routeRelease` must send it to the workflow resume path.
   */
  scope?: HoldScope;
  /**
   * What triggered the hold. Omit to leave the column at its `'context'`
   * default. Written explicitly by the trust-policy hold so its release signal
   * carries the pair `routeRelease` discriminates on rather than relying on a
   * column default to supply half of it.
   */
  triggerSource?: TriggerSource;
}

/**
 * Data required to create a generalized approval hold. Unlike the legacy
 * context-only `create()`, this carries the hold scope, trigger source,
 * optional step index, and the normalized approval requirement.
 */
export interface CreateHoldData {
  runId: string;
  jobId: string;
  /** Granularity of the held element. */
  scope: HoldScope;
  /** Step index within the job for step-scoped holds; omit otherwise. */
  stepIndex?: number;
  /** What triggered the hold (context policy vs SDK requireApproval). */
  triggerSource: TriggerSource;
  /** The normalized requirement the hold must satisfy. */
  requirement: ApprovalRequirement;
  /** Context id, when the hold originates from a context policy. */
  contextId?: string | null;
  /** Queue type: 'context' (default) or 'security'. */
  queueType?: 'context' | 'security';
  /**
   * Held-run `hold_type` discriminator — an engine `HoldType` member. Defaults
   * to `reviewer`. The workflow install gate sets `timer` / `concurrency` so
   * the automated release sweeps can find their rows.
   */
  holdType?: string;
  /**
   * Drift payload `{ summaryMarkdown, drift }` captured for a `when: 'drift'`
   * step gate; persisted to `held_runs.payload` and surfaced in the dashboard
   * approval queue + the CLI. Omit for non-drift holds.
   */
  payload?: StepApprovalPayload;
}

/** A single decision to record against a hold. */
export interface RecordDecisionData {
  approverSub: string;
  decision: ApprovalDecision;
  /** Which requirement clauses this decision satisfied (for attribution). */
  clausesSatisfied?: ApproverClause[];
}

/**
 * The outcome of `release()` — describes how the held element must be resumed.
 * The store only writes the terminal DB state; the caller performs the actual
 * re-dispatch (job/workflow) or agent notification (step) using this signal.
 */
export interface ReleaseSignal {
  holdId: string;
  runId: string;
  jobId: string;
  scope: HoldScope;
  /** Set only for step-scoped holds. */
  stepIndex: number | null;
  /**
   * What kind of gate created the hold. `explicit` (SDK `requireApproval`) holds
   * a real root job and resumes by re-dispatching it; `context` covers the
   * workflow install-gate (wait-timer / concurrency / env approval) which resumes
   * by rebuilding the workflow dispatch context. The resume router keys off this
   * so a workflow-scoped explicit hold goes through the job re-dispatch path
   * rather than the install-gate path (which has no pending workflow context).
   */
  triggerSource: TriggerSource;
}

/** Options for listing held runs. */
export interface ListHeldRunsOptions {
  status?: string;
  limit?: number;
}

/** Manages held run lifecycle (pending -> approved/rejected/expired). */
export class HeldRunStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a new held run with pending status.
   *
   * `exec` is the executor the INSERT runs through, defaulting to the store's
   * own connection. A caller that writes something the row cannot exist without
   * — the job's pending dispatch context, without which the hold can never be
   * resumed — passes its enclosing transaction, so the two land or roll back
   * together. Handed in rather than taken from an ambient scope: Kysely has no
   * such scope, so a `this.db` insert inside a `db.transaction()` callback runs
   * on a different connection and commits on its own.
   */
  async create(orgId: string, data: CreateHeldRunData, exec: Executor = this.db): Promise<HeldRun> {
    return exec
      .insertInto('held_runs')
      .values({
        org_id: orgId,
        run_id: data.runId,
        job_id: data.jobId,
        context_id: data.contextId,
        hold_type: data.holdType,
        queue_type: data.queueType ?? 'context',
        reason: data.reason,
        expires_at: data.expiresAt,
        // Nothing has been posted yet — the pending check is posted after this
        // row lands, and `markPendingCheckPosted` records it only once the
        // provider has accepted it. Written explicitly so `null` keeps meaning
        // "row predates the column" and nothing else.
        posted_pending_check: false,
        // Both columns are NOT NULL with a default, so an omitted field leaves
        // the row exactly as every caller predating these fields wrote it.
        ...(data.scope !== undefined && { hold_scope: data.scope }),
        ...(data.triggerSource !== undefined && { trigger_source: data.triggerSource }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Create a generalized approval hold (workflow/job/step scope, explicit or
   * context trigger) carrying a normalized `ApprovalRequirement`. Returns
   * the created row.
   *
   * `exec` carries the same meaning it does on {@link create}.
   */
  async createHold(
    orgId: string,
    data: CreateHoldData,
    exec: Executor = this.db,
  ): Promise<HeldRun> {
    return exec
      .insertInto('held_runs')
      .values({
        org_id: orgId,
        run_id: data.runId,
        job_id: data.jobId,
        context_id: data.contextId ?? null,
        hold_type: data.holdType ?? HoldType.enum.reviewer,
        queue_type: data.queueType ?? 'context',
        reason: data.requirement.reason,
        expires_at: new Date(data.requirement.expiresAt),
        // Same as `create`: recorded true only by `markPendingCheckPosted`.
        posted_pending_check: false,
        hold_scope: data.scope,
        step_index: data.stepIndex ?? null,
        trigger_source: data.triggerSource,
        approval_requirement: data.requirement,
        // jsonb: serialize explicitly so the driver lands a JSON value rather
        // than a Postgres composite literal (same pattern as recordDecision).
        ...(data.payload !== undefined && { payload: JSON.stringify(data.payload) }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Record that the pending `KiCI Security` check reached the provider, for
   * every hold that gates it, so the settle that ends one knows it has a check
   * to terminalize.
   *
   * Written AFTER the post returns, never before. The two orders fail
   * differently and the failures are not equivalent: recording first and dying
   * before the post leaves a row claiming a check the commit does not have, and
   * the settle then CREATES one — a completed `KiCI Security` run appearing on a
   * commit nothing ever held. Recording second leaves the opposite residue, a
   * real pending check the settle declines to close, which is the same stuck
   * check the fire-and-forget post could already produce. A fabricated failing
   * check on a pull request is worse than a stuck one, so the write goes last.
   *
   * **One statement for all of them, not one per hold.** A commit's check run is
   * shared by every hold on it, and the settle asks the contention query which
   * of them still owns it. Marking them in a loop admits a PARTIAL mark: mark
   * the reviewer hold, fail on the security hold, and the security row keeps
   * `posted_pending_check: false` — so it is not counted as a contender, and
   * approving the reviewer hold terminalizes the shared check `success` while
   * the trust hold still gates the job. That is a fabricated PASSING check,
   * which is the worse direction, reached without any process dying: a
   * deadlock, a statement timeout or a lost connection between the two UPDATEs
   * is enough. A single `WHERE id IN (…)` either marks every hold or none.
   *
   * The residual window is therefore one statement issued immediately after the
   * provider call returns — narrow, and not only reachable by a process death,
   * which is why the caller logs its failure rather than treating it as
   * impossible.
   */
  async markPendingCheckPosted(orgId: string, heldRunIds: readonly string[]): Promise<void> {
    if (heldRunIds.length === 0) return;
    await this.db
      .updateTable('held_runs')
      .set({ posted_pending_check: true })
      .where('id', 'in', [...heldRunIds])
      .where('org_id', '=', orgId)
      .execute();
  }

  /** INSERT one decision row using the given executor (root or transaction). */
  private insertDecisionRow(
    exec: Executor,
    heldRunId: string,
    data: RecordDecisionData,
  ): Promise<HeldRunApproval> {
    // The driver renders a JS array as a Postgres array literal ('{...}'),
    // which a jsonb column rejects ('invalid input syntax for type json').
    // Serialize to a JSON string so the value lands as jsonb. Objects are
    // auto-stringified by the driver, but arrays are not — hence the explicit
    // JSON.stringify here, matching the jsonb-insert pattern in job-queue.ts.
    const clausesSatisfied =
      data.clausesSatisfied != null ? JSON.stringify(data.clausesSatisfied) : null;
    return exec
      .insertInto('held_run_approvals')
      .values({
        held_run_id: heldRunId,
        approver_user_id: data.approverSub,
        decision: data.decision,
        clauses_satisfied: clausesSatisfied,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Flip a pending hold to 'approved' using the given executor. Undefined if not pending. */
  private flipToApproved(
    exec: Executor,
    orgId: string,
    heldRunId: string,
  ): Promise<HeldRun | undefined> {
    return exec
      .updateTable('held_runs')
      .set({ status: HeldRunStatus.Approved, resolved_at: sql`now()` })
      .where('id', '=', heldRunId)
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .returningAll()
      .executeTakeFirst();
  }

  /** Flip a pending hold to 'rejected' using the given executor. Undefined if not pending. */
  private flipToRejected(
    exec: Executor,
    orgId: string,
    heldRunId: string,
    reason?: string,
  ): Promise<HeldRun | undefined> {
    const set: Record<string, unknown> = {
      status: HeldRunStatus.Rejected,
      resolved_at: sql`now()`,
    };
    if (reason !== undefined) {
      set.reason = reason;
    }
    return exec
      .updateTable('held_runs')
      .set(set)
      .where('id', '=', heldRunId)
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .returningAll()
      .executeTakeFirst();
  }

  /** Map a released held_runs row to the resume ReleaseSignal. */
  private toReleaseSignal(row: HeldRun): ReleaseSignal {
    return {
      holdId: row.id,
      runId: row.run_id,
      jobId: row.job_id,
      scope: (row.hold_scope as HoldScope) ?? HoldScope.enum.job,
      stepIndex: row.step_index,
      triggerSource: (row.trigger_source as TriggerSource) ?? TriggerSource.enum.context,
    };
  }

  /** Record one approve/reject decision against a hold. */
  async recordDecision(heldRunId: string, data: RecordDecisionData): Promise<HeldRunApproval> {
    return this.insertDecisionRow(this.db, heldRunId, data);
  }

  /**
   * Atomically record an approve decision and release the (now-satisfied) hold.
   * The INSERT into `held_run_approvals` and the `held_runs` → approved UPDATE
   * run in a single transaction, so a crash between them cannot strand the hold
   * `pending` with a recorded approve. Throws if the hold is not found or no
   * longer pending (the whole transaction rolls back).
   */
  async recordAndRelease(
    orgId: string,
    heldRunId: string,
    data: RecordDecisionData,
  ): Promise<ReleaseSignal> {
    return this.db.transaction().execute(async (tx) => {
      await this.insertDecisionRow(tx, heldRunId, data);
      const row = await this.flipToApproved(tx, orgId, heldRunId);
      if (!row) {
        throw new Error(`Held run '${heldRunId}' not found or not pending`);
      }
      return this.toReleaseSignal(row);
    });
  }

  /**
   * Atomically record a reject decision and reject the hold. The INSERT and the
   * `held_runs` → rejected UPDATE run in a single transaction, so a crash
   * between them cannot strand the hold `pending` with a recorded reject (which
   * would poison `evaluate()` forever). Throws if the hold is not found or no
   * longer pending (the whole transaction rolls back).
   */
  async recordAndReject(
    orgId: string,
    heldRunId: string,
    data: RecordDecisionData,
    reason?: string,
  ): Promise<HeldRun> {
    return this.db.transaction().execute(async (tx) => {
      await this.insertDecisionRow(tx, heldRunId, data);
      const row = await this.flipToRejected(tx, orgId, heldRunId, reason);
      if (!row) {
        throw new Error(`Held run '${heldRunId}' not found or not pending`);
      }
      return row;
    });
  }

  /** List the recorded decisions for a hold, oldest first. */
  async listDecisions(heldRunId: string): Promise<HeldRunApproval[]> {
    return this.db
      .selectFrom('held_run_approvals')
      .selectAll()
      .where('held_run_id', '=', heldRunId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Get a single held run by id (org-scoped). Returns null if absent. */
  async getById(orgId: string, heldRunId: string): Promise<HeldRun | null> {
    const row = await this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('id', '=', heldRunId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Release a hold whose approval requirement is satisfied. Flips the row to
   * 'approved' and returns a `ReleaseSignal` describing how the caller must
   * resume the element (re-dispatch for job/workflow, agent notification for
   * step). Throws if the hold is not found or not pending. Approver attribution
   * lives in `held_run_approvals`, not on the row.
   */
  async release(orgId: string, heldRunId: string): Promise<ReleaseSignal> {
    const row = await this.flipToApproved(this.db, orgId, heldRunId);
    if (!row) {
      throw new Error(`Held run '${heldRunId}' not found or not pending`);
    }
    return this.toReleaseSignal(row);
  }

  /** Approve a pending held run. Throws if not found or not pending. */
  async approve(orgId: string, heldRunId: string, approvedBy: string): Promise<HeldRun> {
    const row = await this.db
      .updateTable('held_runs')
      .set({
        status: HeldRunStatus.Approved,
        approved_by: approvedBy,
        resolved_at: sql`now()`,
      })
      .where('id', '=', heldRunId)
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Held run '${heldRunId}' not found or not pending`);
    }
    return row;
  }

  /** Reject a pending held run. Throws if not found or not pending. */
  async reject(orgId: string, heldRunId: string, reason?: string): Promise<HeldRun> {
    const row = await this.flipToRejected(this.db, orgId, heldRunId, reason);
    if (!row) {
      throw new Error(`Held run '${heldRunId}' not found or not pending`);
    }
    return row;
  }

  /** List pending held runs for an org, ordered by creation time. */
  async listPending(orgId: string): Promise<HeldRun[]> {
    return this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** List held runs for an org with optional filters. */
  async listAll(orgId: string, options?: ListHeldRunsOptions): Promise<HeldRun[]> {
    let query = this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc');

    if (options?.status) {
      query = query.where('status', '=', options.status);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }

    return query.execute();
  }

  /** List held runs for an org filtered by queue type with optional filters. */
  async listByQueueType(
    orgId: string,
    queueType: 'context' | 'security',
    options?: ListHeldRunsOptions,
  ): Promise<HeldRun[]> {
    let query = this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('queue_type', '=', queueType)
      .orderBy('created_at', 'desc');

    if (options?.status) {
      query = query.where('status', '=', options.status);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }

    return query.execute();
  }

  /**
   * List pending `security` holds whose run belongs to a specific PR (and repo).
   *
   * Joins `execution_runs` on `run_id` and filters by `repo_identifier` +
   * `pr_number` so `/kici approve|reject` only affects the commented PR's holds
   * rather than every pending security hold in the org. A run with a NULL
   * `pr_number` (non-PR run, or a legacy run predating the column) never matches
   * the equality predicate, so such holds are never released here — fail-closed.
   */
  async listPendingSecurityHoldsForPr(
    orgId: string,
    repoIdentifier: string,
    prNumber: number,
  ): Promise<HeldRun[]> {
    return this.db
      .selectFrom('held_runs')
      .innerJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
      .selectAll('held_runs')
      .where('held_runs.org_id', '=', orgId)
      .where('held_runs.queue_type', '=', 'security')
      .where('held_runs.status', '=', HeldRunStatus.Pending)
      .where('execution_runs.repo_identifier', '=', repoIdentifier)
      .where('execution_runs.pr_number', '=', prNumber)
      .orderBy('held_runs.created_at', 'desc')
      .execute();
  }

  /**
   * Approve a pending held run, enforcing queue_type boundary.
   * Prevents context approvals from approving security holds and vice versa.
   * Throws if not found, not pending, or queue_type mismatch.
   */
  async approveByQueueType(
    orgId: string,
    heldRunId: string,
    approvedBy: string,
    queueType: 'context' | 'security',
  ): Promise<HeldRun> {
    const row = await this.db
      .updateTable('held_runs')
      .set({
        status: HeldRunStatus.Approved,
        approved_by: approvedBy,
        resolved_at: sql`now()`,
      })
      .where('id', '=', heldRunId)
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .where('queue_type', '=', queueType)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Held run '${heldRunId}' not found, not pending, or queue type mismatch (expected '${queueType}')`,
      );
    }
    return row;
  }

  /** Get a held run by run ID and job ID. Returns null if not found. */
  async getByRunAndJob(orgId: string, runId: string, jobId: string): Promise<HeldRun | null> {
    const row = await this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * List pending holds past their `expires_at`. Called by the stale detector
   * BEFORE `expireOverdue()` so it can route each overdue hold by scope (step
   * holds notify the waiting agent; job/workflow holds fail the run).
   */
  async listOverdue(): Promise<HeldRun[]> {
    return this.db
      .selectFrom('held_runs')
      .selectAll()
      .where('status', '=', HeldRunStatus.Pending)
      .where('expires_at', '<', sql<Date>`now()`)
      .execute();
  }

  /**
   * Release overdue timer holds at ANY scope. A wait action pauses its element
   * as a held run; on timer expiry it must RESUME (not fail like a reviewer-hold
   * expiry). Flips each overdue pending timer row to `released` and returns a
   * `ReleaseSignal` per row, carrying the row's own scope so the caller can
   * route it — `routeRelease` sends a workflow-scoped one to the install-gate
   * rebuild and a job-scoped one to the job re-dispatch path.
   *
   * Runs BEFORE `expireOverdue()` so these rows leave the pending pool before
   * the expire-and-fail sweep sees them. That ordering is load-bearing, not
   * incidental: `expireOverdue` is not scope-filtered, so a released-but-not-yet-
   * resumed row would otherwise be expired out from under its resume.
   *
   * The filter matches every persisted spelling of the timer hold type, so a row
   * an un-upgraded orchestrator wrote as `wait_timer` still resumes rather than
   * falling through to the expire-and-fail sweep. It deliberately does NOT
   * filter on `hold_scope`: a job-scoped timer hold used to be excluded here,
   * which left it with no release path at all — created, never released,
   * eventually expired, its job never dispatched.
   */
  async releaseDueWaitHolds(): Promise<ReleaseSignal[]> {
    const rows = await this.db
      .updateTable('held_runs')
      .set({ status: HeldRunStatus.Released, resolved_at: sql`now()` })
      .where('status', '=', HeldRunStatus.Pending)
      .where('hold_type', 'in', persistedHoldTypeSpellings(HoldType.enum.timer))
      .where('expires_at', '<', sql<Date>`now()`)
      .returningAll()
      .execute();
    return rows.map((row) => ({
      holdId: row.id,
      runId: row.run_id,
      jobId: row.job_id,
      // `hold_scope` is NOT NULL DEFAULT 'job' (migration 034), so there is no
      // value to default. Defaulting a missing one to `workflow` would send a
      // job-scoped hold down the install-gate path, re-dispatching a whole
      // workflow instead of the one job that was held.
      scope: row.hold_scope as HoldScope,
      stepIndex: row.step_index,
      // A wait-timer hold is always context-triggered — it comes from a
      // context's `wait_timer_seconds`, never from an SDK `requireApproval`.
      triggerSource: (row.trigger_source as TriggerSource) ?? TriggerSource.enum.context,
    }));
  }

  /**
   * Every pending queued (concurrency) hold, with the org and concurrency group
   * it belongs to — the input to the periodic release sweep, which needs to know
   * WHICH groups have someone waiting before it looks up any limits.
   *
   * Returns the pair rather than full rows: the sweep only groups by it, and
   * `listQueuedHoldsForContext` fetches the rows it actually releases.
   */
  async listAllQueuedHolds(): Promise<
    Array<{ orgId: string | null; concurrencyGroup: string | null }>
  > {
    const rows = await this.db
      .selectFrom('held_runs')
      .innerJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
      .select(['held_runs.org_id as orgId', 'execution_runs.context as concurrencyGroup'])
      .where('held_runs.status', '=', HeldRunStatus.Pending)
      .where('held_runs.hold_type', 'in', persistedHoldTypeSpellings(HoldType.enum.concurrency))
      .execute();
    return rows;
  }

  /**
   * List the pending queued (concurrency) holds for one context's concurrency
   * group, oldest first.
   *
   * Joined to `execution_runs` and filtered by `customer_id` as well as
   * `context`: a context NAME is not unique across tenants, so without the org
   * predicate one org's completing job could release another org's queued hold.
   * Oldest-first is the release order — a queue that released newest-first would
   * starve whoever waited longest.
   */
  async listQueuedHoldsForContext(orgId: string, concurrencyGroup: string): Promise<HeldRun[]> {
    return this.db
      .selectFrom('held_runs')
      .innerJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
      .selectAll('held_runs')
      .where('held_runs.org_id', '=', orgId)
      .where('held_runs.status', '=', HeldRunStatus.Pending)
      .where('held_runs.hold_type', 'in', persistedHoldTypeSpellings(HoldType.enum.concurrency))
      .where('execution_runs.context', '=', concurrencyGroup)
      .where('execution_runs.customer_id', '=', orgId)
      .orderBy('held_runs.created_at', 'asc')
      .execute() as unknown as Promise<HeldRun[]>;
  }

  /**
   * Expire overdue pending runs. Called by the stale detector.
   * Sets status to 'expired' and resolved_at to now() for all
   * pending runs past their expires_at.
   * Returns the number of expired runs.
   */
  async expireOverdue(): Promise<number> {
    const result = await this.db
      .updateTable('held_runs')
      .set({
        status: HeldRunStatus.Expired,
        resolved_at: sql`now()`,
      })
      .where('status', '=', HeldRunStatus.Pending)
      .where('expires_at', '<', sql<Date>`now()`)
      .execute();

    // execute() returns an array for update; we use the first result's numUpdatedRows
    const updateResult = Array.isArray(result) ? result[0] : result;
    return Number(updateResult?.numUpdatedRows ?? 0n);
  }
}

/**
 * Build a HeldRunStore backed by its own connection pool to the given
 * orchestrator database URL. Mirrors `createPeerCredentialStoreFromUrl` /
 * `createJoinTokenManagerFromUrl`; consumed by E2E tests that exercise the
 * PR-scoped hold selection against the real deployed orchestrator DB.
 */
export function createHeldRunStoreFromUrl(
  databaseUrl: string,
  opts?: { maxConnections?: number },
): { store: HeldRunStore; dispose: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts?.maxConnections ?? 3 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    store: new HeldRunStore(db),
    dispose: async () => {
      await db.destroy();
    },
  };
}
