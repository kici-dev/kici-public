/**
 * Held run store -- lifecycle management for runs held by protection gates.
 *
 * Manages the lifecycle: pending -> approved/rejected/expired.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  type ApprovalRequirement,
  type ApproverClause,
  type StepApprovalPayload,
  ApprovalDecision,
  HoldScope,
  TriggerSource,
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

/** Data required to create a held run. */
export interface CreateHeldRunData {
  runId: string;
  jobId: string;
  environmentId: string;
  holdType: string;
  reason: string;
  expiresAt: Date;
  /** Queue type: 'environment' (default) or 'security'. */
  queueType?: 'environment' | 'security';
}

/**
 * Data required to create a generalized approval hold. Unlike the legacy
 * environment-only `create()`, this carries the hold scope, trigger source,
 * optional step index, and the normalized approval requirement.
 */
export interface CreateHoldData {
  runId: string;
  jobId: string;
  /** Granularity of the held element. */
  scope: HoldScope;
  /** Step index within the job for step-scoped holds; omit otherwise. */
  stepIndex?: number;
  /** What triggered the hold (environment policy vs SDK requireApproval). */
  triggerSource: TriggerSource;
  /** The normalized requirement the hold must satisfy. */
  requirement: ApprovalRequirement;
  /** Environment id, when the hold originates from an environment policy. */
  environmentId?: string | null;
  /** Queue type: 'environment' (default) or 'security'. */
  queueType?: 'environment' | 'security';
  /**
   * Held-run `hold_type` discriminator. Defaults to `'approval'` (reviewer
   * holds). The workflow install gate sets `'wait_timer'` / `'concurrency'` so
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
   * a real root job and resumes by re-dispatching it; `environment` covers the
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

  /** Create a new held run with pending status. */
  async create(orgId: string, data: CreateHeldRunData): Promise<HeldRun> {
    return this.db
      .insertInto('held_runs')
      .values({
        org_id: orgId,
        run_id: data.runId,
        job_id: data.jobId,
        environment_id: data.environmentId,
        hold_type: data.holdType,
        queue_type: data.queueType ?? 'environment',
        reason: data.reason,
        expires_at: data.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Create a generalized approval hold (workflow/job/step scope, explicit or
   * environment trigger) carrying a normalized `ApprovalRequirement`. Returns
   * the created row.
   */
  async createHold(orgId: string, data: CreateHoldData): Promise<HeldRun> {
    return this.db
      .insertInto('held_runs')
      .values({
        org_id: orgId,
        run_id: data.runId,
        job_id: data.jobId,
        environment_id: data.environmentId ?? null,
        hold_type: data.holdType ?? 'approval',
        queue_type: data.queueType ?? 'environment',
        reason: data.requirement.reason,
        expires_at: new Date(data.requirement.expiresAt),
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
      triggerSource: (row.trigger_source as TriggerSource) ?? TriggerSource.enum.environment,
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
    queueType: 'environment' | 'security',
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
   * Approve a pending held run, enforcing queue_type boundary.
   * Prevents environment approvals from approving security holds and vice versa.
   * Throws if not found, not pending, or queue_type mismatch.
   */
  async approveByQueueType(
    orgId: string,
    heldRunId: string,
    approvedBy: string,
    queueType: 'environment' | 'security',
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
   * Release overdue workflow `wait_timer` holds. The install-gate wait action
   * pauses the workflow as a held run; on timer expiry it must RESUME (not
   * fail like a reviewer-hold expiry). Flips each overdue pending
   * `hold_type='wait_timer'`, `hold_scope='workflow'` row to `released` and
   * returns a `ReleaseSignal` per row so the caller can resume the workflow.
   * Runs BEFORE `expireOverdue()` so these rows leave the pending pool before
   * the expire-and-fail sweep sees them.
   */
  async releaseDueWaitHolds(): Promise<ReleaseSignal[]> {
    const rows = await this.db
      .updateTable('held_runs')
      .set({ status: HeldRunStatus.Released, resolved_at: sql`now()` })
      .where('status', '=', HeldRunStatus.Pending)
      .where('hold_type', '=', 'wait_timer')
      .where('hold_scope', '=', HoldScope.enum.workflow)
      .where('expires_at', '<', sql<Date>`now()`)
      .returningAll()
      .execute();
    return rows.map((row) => ({
      holdId: row.id,
      runId: row.run_id,
      jobId: row.job_id,
      scope: (row.hold_scope as HoldScope) ?? HoldScope.enum.workflow,
      stepIndex: row.step_index,
      // Wait-timer install-gate holds are always environment-triggered.
      triggerSource: (row.trigger_source as TriggerSource) ?? TriggerSource.enum.environment,
    }));
  }

  /**
   * Release the oldest pending workflow `concurrency` hold for a group. Called
   * when a concurrency slot frees on run completion. Flips the oldest matching
   * pending row to `released` and returns its `ReleaseSignal`, or null when no
   * concurrency hold is queued for the group. `group` matches the held row's
   * `environment_id` (workflow-level install concurrency keys on the env id).
   */
  async releaseConcurrencyHold(orgId: string, group: string): Promise<ReleaseSignal | null> {
    const oldest = await this.db
      .selectFrom('held_runs')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', '=', HeldRunStatus.Pending)
      .where('hold_type', '=', 'concurrency')
      .where('hold_scope', '=', HoldScope.enum.workflow)
      .where('environment_id', '=', group)
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!oldest) return null;
    const row = await this.db
      .updateTable('held_runs')
      .set({ status: HeldRunStatus.Released, resolved_at: sql`now()` })
      .where('id', '=', oldest.id)
      .where('status', '=', HeldRunStatus.Pending)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    return {
      holdId: row.id,
      runId: row.run_id,
      jobId: row.job_id,
      scope: (row.hold_scope as HoldScope) ?? HoldScope.enum.workflow,
      stepIndex: row.step_index,
      // Concurrency install-gate holds are always environment-triggered.
      triggerSource: (row.trigger_source as TriggerSource) ?? TriggerSource.enum.environment,
    };
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
