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

    it('stays scoped to workflow holds so job-scoped timer holds are untouched', async () => {
      // A dispatch-gate timer hold is job-scoped and must keep flowing through
      // the ordinary expiry path, not this resume sweep.
      const { db, mocks } = createMockDb({ updatedRows: [] });
      const store = new HeldRunStore(db);

      await store.releaseDueWaitHolds();

      expect(whereClauses(mocks)).toContainEqual(['hold_scope', '=', HoldScope.enum.workflow]);
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
