/**
 * Tests for HeldRunStore -- lifecycle management for held runs.
 *
 * Tests the full lifecycle: create -> approve, create -> reject, create -> expire.
 * Uses the shared mock Kysely builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HeldRunStore } from './held-runs.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeHeldRunRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'hr-001',
    org_id: 'org-abc',
    run_id: 'run-001',
    job_id: 'job-001',
    environment_id: 'env-001',
    hold_type: 'approval',
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
        environmentId: 'env-001',
        holdType: 'approval',
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
        environmentId: 'env-001',
        holdType: 'security',
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

    it('should filter environment holds separately from security holds', async () => {
      const rows = [makeHeldRunRow({ id: 'hr-003', queue_type: 'environment' })];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new HeldRunStore(db);

      const result = await store.listByQueueType('org-abc', 'environment');

      expect(mocks.selectFrom).toHaveBeenCalledWith('held_runs');
      expect(result).toEqual(rows);
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
        store.approveByQueueType('org-abc', 'hr-001', 'user:alice', 'environment'),
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
        // The fixture row has no trigger_source → falls back to environment.
        triggerSource: 'environment',
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
});
