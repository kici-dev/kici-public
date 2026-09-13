/**
 * Tests for HeldRunStore -- lifecycle management for held runs.
 *
 * Tests the full lifecycle: create -> approve, create -> reject, create -> expire.
 * Uses the shared mock Kysely builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApprovalDecision,
  HoldScope,
  HoldType,
  SECURITY_HOLD_JOB_IDS,
  TriggerSource,
  HeldRunStatus as WireHeldRunStatus,
} from '@kici-dev/engine';

import { HeldRunStore, HeldRunStatus, SecurityHoldReason } from './held-runs.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

describe('SecurityHoldReason', () => {
  it('enumerates the four security hold reasons', () => {
    expect(SecurityHoldReason.options).toEqual([
      'workflow_modification',
      'unknown_contributor',
      'fork_pr',
      'context_trust',
    ]);
    expect(SecurityHoldReason.enum.workflow_modification).toBe('workflow_modification');
  });
});

// ── Fixtures ──────────────────────────────────────────────────────

function makeHeldRunRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'hr-001',
    org_id: 'org-abc',
    run_id: 'run-001',
    job_id: 'job-001',
    context_id: 'env-001',
    hold_type: HoldType.enum.reviewer,
    status: 'pending',
    reason: 'Requires approval',
    approved_by: null,
    created_at: new Date('2026-03-08T12:00:00Z'),
    expires_at: new Date('2026-03-09T12:00:00Z'),
    resolved_at: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('HeldRunStore', () => {
  describe('create', () => {
    it('should insert a held run and return the created row', async () => {
      const row = makeHeldRunRow();
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new HeldRunStore(db);

      const result = await store.create('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        contextId: 'env-001',
        holdType: HoldType.enum.reviewer,
        reason: 'Requires approval',
        expiresAt: new Date('2026-03-09T12:00:00Z'),
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(row);
    });

    it('writes the pending-check flag false, not absent', async () => {
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.create('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        contextId: 'env-001',
        holdType: HoldType.enum.security,
        reason: 'Requires approval',
        expiresAt: new Date('2026-03-09T12:00:00Z'),
      });

      const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(values.posted_pending_check).toBe(false);
    });

    it('inserts through a supplied executor, not the store connection', async () => {
      // Same reasoning as the `createHold` case below: the non-approval holds
      // this writes carry a pending dispatch context written beside them, and a
      // row that outlives a rolled-back context is a hold nothing can resume.
      const storeDb = createMockDb({ insertedRow: makeHeldRunRow() });
      const trx = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(storeDb.db);

      await store.create(
        'org-abc',
        {
          runId: 'run-001',
          jobId: 'job-001',
          contextId: 'env-001',
          holdType: HoldType.enum.security,
          reason: 'Requires approval',
          expiresAt: new Date('2026-03-09T12:00:00Z'),
        },
        trx.db,
      );

      expect(trx.mocks.insertInto).toHaveBeenCalledWith('held_runs');
      expect(storeDb.mocks.insertInto).not.toHaveBeenCalled();
    });
  });

  describe('markPendingCheckPosted', () => {
    it('sets the flag true on one hold, scoped by org', async () => {
      // Org-scoped like every other write here: a shared orchestrator database
      // can hold two tenants, and this is the flag that decides whether a
      // terminal check reaches a commit.
      const { db, mocks } = createMockDb();
      const store = new HeldRunStore(db);

      await store.markPendingCheckPosted('org-abc', ['hr-001']);

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(mocks.updateSet).toHaveBeenCalledWith({ posted_pending_check: true });
      expect(mocks.updateWhere).toHaveBeenCalledWith('id', 'in', ['hr-001']);
      expect(mocks.updateWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
    });

    it('marks every hold in ONE statement, never one per hold', async () => {
      // A loop admits a partial mark: mark the reviewer hold, fail on the
      // security hold, and the security row keeps `posted_pending_check:
      // false`. The contention query then does not count it as an owner, so
      // approving the reviewer hold terminalizes the shared `KiCI Security`
      // check `success` while the trust hold still gates the job — a fabricated
      // PASSING check, reached without any process dying.
      const { db, mocks } = createMockDb();
      const store = new HeldRunStore(db);

      await store.markPendingCheckPosted('org-abc', ['hr-001', 'hr-002']);

      expect(mocks.updateTable).toHaveBeenCalledTimes(1);
      expect(mocks.updateExecute).toHaveBeenCalledTimes(1);
      expect(mocks.updateWhere).toHaveBeenCalledWith('id', 'in', ['hr-001', 'hr-002']);
    });

    it('issues no statement for an empty id list', async () => {
      const { db, mocks } = createMockDb();
      const store = new HeldRunStore(db);

      await store.markPendingCheckPosted('org-abc', []);

      expect(mocks.updateTable).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('should set status to approved and resolved_at', async () => {
      const approvedRow = makeHeldRunRow({
        status: 'approved',
        approved_by: 'user:alice',
        resolved_at: new Date(),
      });
      const { db, mocks } = createMockDb({ updatedRow: approvedRow });
      const store = new HeldRunStore(db);

      const result = await store.approve('org-abc', 'hr-001', 'user:alice');

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(approvedRow);
    });

    it('should throw when held run not found or not pending', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new HeldRunStore(db);

      await expect(store.approve('org-abc', 'hr-999', 'user:alice')).rejects.toThrow(
        /not found or not pending/,
      );
    });
  });

  describe('reject', () => {
    it('should set status to rejected and resolved_at', async () => {
      const rejectedRow = makeHeldRunRow({
        status: 'rejected',
        reason: 'Not ready',
        resolved_at: new Date(),
      });
      const { db, mocks } = createMockDb({ updatedRow: rejectedRow });
      const store = new HeldRunStore(db);

      const result = await store.reject('org-abc', 'hr-001', 'Not ready');

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rejectedRow);
    });

    it('should throw when held run not found or not pending', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new HeldRunStore(db);

      await expect(store.reject('org-abc', 'hr-999')).rejects.toThrow(/not found or not pending/);
    });
  });

  describe('listPending', () => {
    it('should return only pending held runs for the org', async () => {
      const rows = [
        makeHeldRunRow({ id: 'hr-001' }),
        makeHeldRunRow({ id: 'hr-002', run_id: 'run-002' }),
      ];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listPending('org-abc');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);
    });
  });

  describe('listAll', () => {
    it('should return all held runs for the org', async () => {
      const rows = [makeHeldRunRow(), makeHeldRunRow({ id: 'hr-002', status: 'approved' })];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listAll('org-abc');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);
    });
  });

  describe('create with queueType', () => {
    it('should insert a security hold with queue_type security', async () => {
      const row = makeHeldRunRow({ queue_type: 'security' });
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new HeldRunStore(db);

      const result = await store.create('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        contextId: 'env-001',
        holdType: HoldType.enum.security,
        reason: 'Unknown contributor',
        expiresAt: new Date('2026-03-09T12:00:00Z'),
        queueType: 'security',
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(row);
    });
  });

  describe('create with scope and triggerSource', () => {
    it('writes the pair the resume router discriminates on', async () => {
      // The org trust policy's PR-wide hold owns a whole workflow dispatch, not
      // a job. `routeRelease` reads this pair off the released row to send it to
      // `resumeWorkflow`; a row left on the `'job'` column default is routed to
      // `dispatchReadyJob`, which looks up a pending job context the hold never
      // wrote and returns without dispatching.
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.create('org-abc', {
        runId: 'run-001',
        jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
        contextId: null,
        holdType: HoldType.enum.security,
        reason: 'fork_pr',
        expiresAt: new Date('2026-03-09T12:00:00Z'),
        queueType: 'security',
        scope: HoldScope.enum.workflow,
        triggerSource: TriggerSource.enum.context,
      });

      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          hold_scope: HoldScope.enum.workflow,
          trigger_source: TriggerSource.enum.context,
        }),
      );
    });

    it('omits both columns when unset, leaving every legacy caller unchanged', async () => {
      // The control: both columns are NOT NULL with a default, so a caller that
      // does not pass them must not send an explicit value — which is what makes
      // the field additive rather than a change to what those callers write.
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.create('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        contextId: 'env-001',
        holdType: HoldType.enum.reviewer,
        reason: 'Requires approval',
        expiresAt: new Date('2026-03-09T12:00:00Z'),
      });

      const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(values).not.toHaveProperty('hold_scope');
      expect(values).not.toHaveProperty('trigger_source');
    });
  });

  describe('listByQueueType', () => {
    it('should return only held runs matching queue type', async () => {
      const rows = [
        makeHeldRunRow({ id: 'hr-001', queue_type: 'security' }),
        makeHeldRunRow({ id: 'hr-002', queue_type: 'security' }),
      ];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listByQueueType('org-abc', 'security');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);
    });

    it('should filter context holds separately from security holds', async () => {
      const rows = [makeHeldRunRow({ id: 'hr-003', queue_type: 'context' })];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listByQueueType('org-abc', 'context');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);
    });
  });

  describe('listPendingSecurityHoldsForPr', () => {
    it('joins execution_runs and scopes by org, security queue, pending, repo, and pr_number', async () => {
      const rows = [makeHeldRunRow({ id: 'hr-pr1', queue_type: 'security', run_id: 'run-pr1' })];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listPendingSecurityHoldsForPr('org-abc', 'owner/repo', 42);

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);

      // The scoping predicates are what isolate a /kici approve to one PR's holds.
      const whereCalls = mocks.selectWhere.mock.calls as Array<[string, string, unknown]>;
      const clause = (col: string) => whereCalls.find(([c]) => c === col);
      expect(clause('held_runs.org_id')).toEqual(['held_runs.org_id', '=', 'org-abc']);
      expect(clause('held_runs.queue_type')).toEqual(['held_runs.queue_type', '=', 'security']);
      expect(clause('held_runs.status')).toEqual(['held_runs.status', '=', 'pending']);
      expect(clause('execution_runs.repo_identifier')).toEqual([
        'execution_runs.repo_identifier',
        '=',
        'owner/repo',
      ]);
      expect(clause('execution_runs.pr_number')).toEqual(['execution_runs.pr_number', '=', 42]);
    });

    it('returns the (already-scoped) rows the query yields', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const store = new HeldRunStore(db);

      const result = await store.listPendingSecurityHoldsForPr('org-abc', 'owner/repo', 7);

      expect(result).toEqual([]);
    });
  });

  describe('approveByQueueType', () => {
    it('should approve when queue type matches', async () => {
      const approvedRow = makeHeldRunRow({
        status: 'approved',
        approved_by: 'user:alice',
        queue_type: 'security',
        resolved_at: new Date(),
      });
      const { db, mocks } = createMockDb({ updatedRow: approvedRow });
      const store = new HeldRunStore(db);

      const result = await store.approveByQueueType('org-abc', 'hr-001', 'user:alice', 'security');

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(approvedRow);
    });

    it('should throw when queue type does not match', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new HeldRunStore(db);

      await expect(
        store.approveByQueueType('org-abc', 'hr-001', 'user:alice', 'context'),
      ).rejects.toThrow(/queue type mismatch/);
    });
  });

  describe('getByRunAndJob', () => {
    it('should return held run for specific run+job', async () => {
      const row = makeHeldRunRow();
      const { db, mocks } = createMockDb({ selectFirstRow: row });
      const store = new HeldRunStore(db);

      const result = await store.getByRunAndJob('org-abc', 'run-001', 'job-001');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(row);
    });

    it('should return null when no held run exists', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new HeldRunStore(db);

      const result = await store.getByRunAndJob('org-abc', 'run-999', 'job-999');

      expect(result).toBeNull();
    });
  });

  describe('createHold', () => {
    it('should insert a generalized hold row with scope/trigger/requirement', async () => {
      const row = makeHeldRunRow({
        hold_scope: 'job',
        trigger_source: 'explicit',
        approval_requirement: { clauses: [{ team: 'leads' }], expiresAt: 'x', reason: 'r' },
      });
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new HeldRunStore(db);

      const result = await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: 'job',
        triggerSource: 'explicit',
        requirement: {
          clauses: [{ team: 'leads' }],
          expiresAt: '2026-03-09T12:00:00Z',
          reason: 'r',
        },
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(row);
    });

    it('writes the pending-check flag false, not absent', async () => {
      // `null` means "row predates the column", and the shape derivation still
      // answers for it. A new row that omitted the flag would inherit that
      // meaning and get the inference the flag exists to replace.
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: 'job',
        triggerSource: 'explicit',
        requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'r' },
      });

      const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(values.posted_pending_check).toBe(false);
    });

    it('inserts through a supplied executor, not the store connection', async () => {
      // Kysely has no ambient transaction: a `this.db` insert inside a
      // `db.transaction()` callback takes a different connection and commits
      // on its own. So a caller that writes the hold's resume path beside the
      // row — without which the hold can never be released — has to hand its
      // transaction in, and this asserts the row actually goes through it.
      const storeDb = createMockDb({ insertedRow: makeHeldRunRow() });
      const trx = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(storeDb.db);

      await store.createHold(
        'org-abc',
        {
          runId: 'run-001',
          jobId: 'job-001',
          scope: 'job',
          triggerSource: 'explicit',
          requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'r' },
        },
        trx.db,
      );

      expect(trx.mocks.insertInto).toHaveBeenCalledWith('held_runs');
      expect(storeDb.mocks.insertInto).not.toHaveBeenCalled();
    });

    it('persists a serialized drift payload when one is supplied', async () => {
      const payload = { summaryMarkdown: '## drift', drift: { want: 1 } };
      const row = makeHeldRunRow({ hold_scope: 'step', step_index: 2, payload });
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new HeldRunStore(db);

      const result = await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: 'step',
        stepIndex: 2,
        triggerSource: 'explicit',
        requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'drift gate' },
        payload,
      });

      const insertedValues = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(insertedValues.payload).toBe(JSON.stringify(payload));
      expect(result).toEqual(row);
    });

    it('omits the payload key entirely for a non-drift hold', async () => {
      const row = makeHeldRunRow({ hold_scope: 'job' });
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new HeldRunStore(db);

      await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: 'job',
        triggerSource: 'explicit',
        requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'r' },
      });

      const insertedValues = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect('payload' in insertedValues).toBe(false);
    });

    it('defaults a hold with no explicit type to the reviewer gate vocabulary', async () => {
      // The default has to stay inside the gate vocabulary: the dashboard
      // badge switches on `HoldType`, and anything outside it renders as a
      // gray raw string.
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: HoldScope.enum.job,
        triggerSource: TriggerSource.enum.context,
        requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'r' },
      });

      const insertedValues = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(insertedValues.hold_type).toBe(HoldType.enum.reviewer);
    });

    it('persists an explicit hold type verbatim', async () => {
      const { db, mocks } = createMockDb({ insertedRow: makeHeldRunRow() });
      const store = new HeldRunStore(db);

      await store.createHold('org-abc', {
        runId: 'run-001',
        jobId: 'job-001',
        scope: HoldScope.enum.workflow,
        triggerSource: TriggerSource.enum.context,
        holdType: HoldType.enum.security,
        requirement: { clauses: [], expiresAt: '2026-03-09T12:00:00Z', reason: 'r' },
      });

      const insertedValues = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(insertedValues.hold_type).toBe(HoldType.enum.security);
    });
  });

  describe('releaseDueWaitHolds', () => {
    /** The `where(column, op, value)` triples the sweep issued, in order. */
    function whereClauses(mocks: { updateWhere: { mock: { calls: unknown[][] } } }) {
      return mocks.updateWhere.mock.calls.map((call) => [call[0], call[1], call[2]]);
    }

    it('matches every persisted spelling of the timer hold type', async () => {
      // The sweep RESUMES an expired install-gate wait hold; `expireOverdue()`
      // would instead fail the run. A filter pinned to one spelling stops
      // matching rows the other writer produced, so the hold silently turns
      // into a failure.
      const { db, mocks } = createMockDb({ updatedRows: [] });
      const store = new HeldRunStore(db);

      await store.releaseDueWaitHolds();

      expect(whereClauses(mocks)).toContainEqual([
        'hold_type',
        'in',
        [HoldType.enum.timer, 'wait_timer'],
      ]);
    });

    it('does NOT filter on scope, so a job-scoped timer hold is released too', async () => {
      // This assertion used to be its inverse — it required
      // `hold_scope = 'workflow'`, on the theory that a job-scoped timer hold
      // "must keep flowing through the ordinary expiry path". That path does not
      // resume anything: the hold was created, never released, eventually
      // expired, and its job never dispatched. With the job registered nowhere,
      // a sibling job's success could complete the run without it.
      //
      // The scope now travels on the signal instead, and `routeRelease` sends a
      // workflow hold to the install-gate rebuild and a job hold to the job
      // re-dispatch path.
      const { db, mocks } = createMockDb({ updatedRows: [] });
      const store = new HeldRunStore(db);

      await store.releaseDueWaitHolds();

      const clauses = whereClauses(mocks);
      expect(clauses).not.toContainEqual(['hold_scope', '=', HoldScope.enum.workflow]);
      // The other filters are unchanged — this widened scope, nothing else.
      expect(clauses).toContainEqual(['status', '=', 'pending']);
      expect(clauses).toContainEqual(['hold_type', 'in', [HoldType.enum.timer, 'wait_timer']]);
    });

    it("carries a job-scoped row's own scope on the signal", async () => {
      // The router keys off this. A NULL-defaulted `workflow` here would
      // re-dispatch an entire workflow for a hold that gated one job.
      const row = makeHeldRunRow({
        id: 'hr-wait-job',
        hold_type: 'wait_timer',
        hold_scope: HoldScope.enum.job,
        step_index: null,
        trigger_source: TriggerSource.enum.context,
      });
      const { db } = createMockDb({ updatedRows: [row] });
      const store = new HeldRunStore(db);

      const signals = await store.releaseDueWaitHolds();

      expect(signals).toHaveLength(1);
      expect(signals[0].scope).toBe(HoldScope.enum.job);
    });

    it('returns a release signal per released row', async () => {
      const row = makeHeldRunRow({
        id: 'hr-wait',
        hold_type: 'wait_timer',
        hold_scope: HoldScope.enum.workflow,
        step_index: null,
        trigger_source: TriggerSource.enum.context,
      });
      const { db } = createMockDb({ updatedRows: [row] });
      const store = new HeldRunStore(db);

      const signals = await store.releaseDueWaitHolds();

      expect(signals).toEqual([
        {
          holdId: 'hr-wait',
          runId: 'run-001',
          jobId: 'job-001',
          scope: HoldScope.enum.workflow,
          stepIndex: null,
          triggerSource: TriggerSource.enum.context,
        },
      ]);
    });
  });

  describe('recordDecision', () => {
    it('should insert a held_run_approvals row', async () => {
      const approvalRow = {
        id: 'a-1',
        held_run_id: 'hr-001',
        approver_user_id: 'u-alice',
        decision: 'approve',
        clauses_satisfied: [{ team: 'leads' }],
        created_at: new Date(),
      };
      const { db, mocks } = createMockDb({ insertedRow: approvalRow });
      const store = new HeldRunStore(db);

      const result = await store.recordDecision('hr-001', {
        approverSub: 'u-alice',
        decision: 'approve',
        clausesSatisfied: [{ team: 'leads' }],
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('held_run_approvals');
      // The jsonb clauses_satisfied array MUST be JSON-serialized to a string —
      // the driver renders a raw JS array as a Postgres array literal, which a
      // jsonb column rejects ('invalid input syntax for type json').
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ clauses_satisfied: JSON.stringify([{ team: 'leads' }]) }),
      );
      expect(result).toEqual(approvalRow);
    });

    it('should insert null clauses_satisfied when none are provided', async () => {
      const approvalRow = {
        id: 'a-2',
        held_run_id: 'hr-002',
        approver_user_id: 'u-bob',
        decision: 'reject',
        clauses_satisfied: null,
        created_at: new Date(),
      };
      const { db, mocks } = createMockDb({ insertedRow: approvalRow });
      const store = new HeldRunStore(db);

      await store.recordDecision('hr-002', {
        approverSub: 'u-bob',
        decision: 'reject',
      });

      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ clauses_satisfied: null }),
      );
    });
  });

  describe('release', () => {
    it('should flip a job-scoped hold to approved and return a job release signal', async () => {
      const updatedRow = makeHeldRunRow({
        status: 'approved',
        hold_scope: 'job',
        step_index: null,
        resolved_at: new Date(),
      });
      const { db, mocks } = createMockDb({ updatedRow });
      const store = new HeldRunStore(db);

      const signal = await store.release('org-abc', 'hr-001');

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(signal).toEqual({
        holdId: 'hr-001',
        runId: 'run-001',
        jobId: 'job-001',
        scope: 'job',
        stepIndex: null,
        // The fixture row has no trigger_source → falls back to context.
        triggerSource: 'context',
      });
    });

    it('should return a step release signal for step-scoped holds', async () => {
      const updatedRow = makeHeldRunRow({
        status: 'approved',
        hold_scope: 'step',
        step_index: 3,
        resolved_at: new Date(),
      });
      const { db } = createMockDb({ updatedRow });
      const store = new HeldRunStore(db);

      const signal = await store.release('org-abc', 'hr-001');

      expect(signal.scope).toBe('step');
      expect(signal.stepIndex).toBe(3);
    });

    it('should throw when the hold is not pending', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new HeldRunStore(db);

      await expect(store.release('org-abc', 'hr-999')).rejects.toThrow(/not found or not pending/);
    });
  });

  describe('expireOverdue', () => {
    it('should update overdue pending runs to expired and return count', async () => {
      const { db, mocks } = createMockDb({
        updateResult: { numUpdatedRows: 3n },
      });
      const store = new HeldRunStore(db);

      const result = await store.expireOverdue();

      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(result).toBe(3);
    });

    it('should return 0 when no overdue runs', async () => {
      const { db } = createMockDb({
        updateResult: { numUpdatedRows: 0n },
      });
      const store = new HeldRunStore(db);

      const result = await store.expireOverdue();
      expect(result).toBe(0);
    });
  });

  describe('recordAndRelease (atomic record + approve)', () => {
    it('runs the decision INSERT and the approve UPDATE in one transaction and returns a ReleaseSignal', async () => {
      const approvedRow = makeHeldRunRow({
        status: 'approved',
        hold_scope: 'job',
        step_index: null,
        trigger_source: 'context',
        resolved_at: new Date('2026-03-08T12:05:00Z'),
      });
      // updatedRow drives the UPDATE...returningAll().executeTakeFirst() in flipToApproved.
      const { db, mocks } = createMockDb({
        insertedRow: { id: 'appr-1' },
        updatedRow: approvedRow,
      });
      const store = new HeldRunStore(db);

      const signal = await store.recordAndRelease('org-abc', 'hr-001', {
        approverSub: 'u-alice',
        decision: ApprovalDecision.enum.approve,
        clausesSatisfied: [{ team: 'leads' }],
      });

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.insertInto).toHaveBeenCalledWith('held_run_approvals');
      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(signal).toMatchObject({ holdId: 'hr-001', runId: 'run-001', scope: 'job' });
    });

    it('throws when the hold is not found / not pending (flip returns no row)', async () => {
      const { db } = createMockDb({ insertedRow: { id: 'appr-1' }, updatedRow: undefined });
      const store = new HeldRunStore(db);
      await expect(
        store.recordAndRelease('org-abc', 'hr-missing', {
          approverSub: 'u-alice',
          decision: ApprovalDecision.enum.approve,
        }),
      ).rejects.toThrow(/not found or not pending/);
    });
  });

  describe('recordAndReject (atomic record + reject)', () => {
    it('runs the decision INSERT and the reject UPDATE in one transaction and returns the rejected row', async () => {
      const rejectedRow = makeHeldRunRow({ status: 'rejected', reason: 'no go' });
      const { db, mocks } = createMockDb({
        insertedRow: { id: 'appr-2' },
        updatedRow: rejectedRow,
      });
      const store = new HeldRunStore(db);

      const row = await store.recordAndReject(
        'org-abc',
        'hr-001',
        { approverSub: 'u-bob', decision: ApprovalDecision.enum.reject },
        'no go',
      );

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.insertInto).toHaveBeenCalledWith('held_run_approvals');
      expect(mocks.updateTable).toHaveBeenCalledWith('held_runs');
      expect(row).toMatchObject({ status: 'rejected', reason: 'no go' });
    });

    it('throws when the hold is not found / not pending (flip returns no row)', async () => {
      const { db } = createMockDb({ insertedRow: { id: 'appr-2' }, updatedRow: undefined });
      const store = new HeldRunStore(db);
      await expect(
        store.recordAndReject('org-abc', 'hr-missing', {
          approverSub: 'u-bob',
          decision: ApprovalDecision.enum.reject,
        }),
      ).rejects.toThrow(/not found or not pending/);
    });
  });
});

describe('HeldRunStatus wire parity', () => {
  it('the engine vocabulary matches every persisted status', () => {
    // The engine enum is what the dashboard renders a labelled badge and a
    // queue tab for; `held_runs.status` is what this orchestrator actually
    // writes. Nothing else tied the two together: when `released` was added
    // here and not there, the Platform's strict wire enum failed the entire
    // relayed held-runs response — and because that message type is one the
    // Platform recognizes, the failure closed the orchestrator's WebSocket
    // rather than dropping a single row.
    //
    // Sorted comparison — declaration order is not part of the contract.
    expect([...WireHeldRunStatus.options].sort()).toEqual(Object.values(HeldRunStatus).sort());
  });
});
