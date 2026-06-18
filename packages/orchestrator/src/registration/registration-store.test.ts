/**
 * Tests for RegistrationStore -- DB CRUD for workflow registrations.
 *
 * Uses a mock Kysely instance following the established pattern from
 * event-store.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LockWorkflow } from '@kici-dev/engine';

// Mock @kici-dev/shared so we can assert against the logger from the
// self-heal block added in Plan 28.6.2-07 Task 2. Only createLogger is
// mocked — the store does not use anything else from @kici-dev/shared.
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { mockLogger };
});

vi.mock('@kici-dev/shared', () => ({
  createLogger: () => mockLogger,
}));

import { RegistrationStore } from './registration-store.js';

// -- Mock helpers ----

function makeLockWorkflow(name: string, triggerTypes: string[] = ['kici_event']): LockWorkflow {
  return {
    name,
    contentHash: 'sha256-test',
    compileSchemaVersion: 1,
    triggers: triggerTypes.map((t) => ({ _type: t, eventName: 'test' }) as any),
    jobs: [],
  };
}

function makeRegistrationRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'reg-001',
    repo_identifier: 'owner/repo',
    workflow_name: 'on-deploy',
    lock_entry: JSON.stringify(makeLockWorkflow('on-deploy')),
    trigger_types: ['kici_event'],
    routing_key: 'github:42',
    provider_context: JSON.stringify({}),
    disabled: false,
    commit_sha: null,
    source_file: '.kici/workflows/on-deploy.ts',
    created_at: new Date('2026-02-25T10:00:00Z'),
    updated_at: new Date('2026-02-25T10:00:00Z'),
    ...overrides,
  };
}

/**
 * Create a mock Kysely DB for RegistrationStore tests.
 *
 * The trx object supports selectFrom, updateTable, insertInto, and deleteFrom
 * chains to test the upsert-based replaceAll implementation.
 */
function createMockDb(
  options: {
    selectManyResult?: Record<string, unknown>[];
    selectOneResult?: Record<string, unknown> | null;
    updateResult?: Record<string, unknown> | null;
    /** Rows returned by the in-transaction SELECT (for replaceAll upsert logic). */
    trxSelectResult?: Record<string, unknown>[];
  } = {},
) {
  const selectManyResult = options.selectManyResult ?? [];
  const selectOneResult = 'selectOneResult' in options ? options.selectOneResult : null;
  const updateResult = 'updateResult' in options ? options.updateResult : null;
  const trxSelectResult = options.trxSelectResult ?? [];

  // Select chain (outside transaction)
  const selectExecute = vi.fn().mockResolvedValue(selectManyResult);
  const selectExecuteTakeFirst = vi.fn().mockResolvedValue(selectOneResult);
  const selectExecuteTakeFirstOrThrow = vi.fn().mockResolvedValue(selectOneResult);
  const selectWhere = vi.fn().mockImplementation(() => ({
    execute: selectExecute,
    executeTakeFirst: selectExecuteTakeFirst,
    executeTakeFirstOrThrow: selectExecuteTakeFirstOrThrow,
    where: selectWhere,
  }));
  const selectAll = vi.fn().mockReturnValue({
    execute: selectExecute,
    where: selectWhere,
  });
  const selectFrom = vi.fn().mockReturnValue({ selectAll });

  // Delete chain (outside transaction)
  const deleteExecute = vi.fn().mockResolvedValue({ numDeletedRows: 0n });
  const deleteExecuteTakeFirst = vi.fn().mockResolvedValue({ numDeletedRows: 0n });
  const deleteWhere = vi.fn().mockImplementation(() => ({
    execute: deleteExecute,
    executeTakeFirst: deleteExecuteTakeFirst,
    where: deleteWhere,
  }));
  const deleteFrom = vi.fn().mockReturnValue({ where: deleteWhere });

  // Insert chain (outside transaction)
  const insertExecute = vi.fn().mockResolvedValue([]);
  const insertValues = vi.fn().mockReturnValue({ execute: insertExecute });
  const insertInto = vi.fn().mockReturnValue({ values: insertValues });

  // Update chain (for bumpVersion): updateTable -> set -> where -> returningAll -> executeTakeFirstOrThrow
  // Also supports setDisabled: updateTable -> set -> where -> executeTakeFirst
  const updateExecuteTakeFirstOrThrow = vi
    .fn()
    .mockResolvedValue(updateResult ?? { id: 'default', version: 2, updated_at: new Date() });
  const updateExecuteTakeFirst = vi.fn().mockResolvedValue(updateResult ?? { numUpdatedRows: 0n });
  const updateReturningAll = vi.fn().mockReturnValue({
    executeTakeFirstOrThrow: updateExecuteTakeFirstOrThrow,
  });
  const updateWhere = vi.fn().mockReturnValue({
    returningAll: updateReturningAll,
    executeTakeFirst: updateExecuteTakeFirst,
  });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateTable = vi.fn().mockReturnValue({ set: updateSet });

  // Transaction mocks
  // trx.selectFrom chain
  const trxSelectExecute = vi.fn().mockResolvedValue(trxSelectResult);
  const trxSelectWhere = vi.fn().mockImplementation(() => ({
    execute: trxSelectExecute,
    where: trxSelectWhere,
  }));
  const trxSelectAll = vi.fn().mockReturnValue({
    execute: trxSelectExecute,
    where: trxSelectWhere,
  });
  const trxSelectFrom = vi.fn().mockReturnValue({ selectAll: trxSelectAll });

  // trx.updateTable chain
  const trxUpdateExecute = vi.fn().mockResolvedValue({ numUpdatedRows: 1n });
  const trxUpdateWhere = vi.fn().mockImplementation(() => ({
    execute: trxUpdateExecute,
    where: trxUpdateWhere,
  }));
  const trxUpdateSet = vi.fn().mockReturnValue({ where: trxUpdateWhere });
  const trxUpdateTable = vi.fn().mockReturnValue({ set: trxUpdateSet });

  // trx.deleteFrom chain
  const trxDeleteExecute = vi.fn().mockResolvedValue([]);
  const trxDeleteWhere = vi.fn().mockImplementation(() => ({
    execute: trxDeleteExecute,
    where: trxDeleteWhere,
  }));
  const trxDeleteFrom = vi.fn().mockReturnValue({ where: trxDeleteWhere });

  // trx.insertInto chain
  const trxInsertExecute = vi.fn().mockResolvedValue([]);
  const trxInsertValues = vi.fn().mockReturnValue({ execute: trxInsertExecute });
  const trxInsertInto = vi.fn().mockReturnValue({ values: trxInsertValues });

  const trx = {
    selectFrom: trxSelectFrom,
    updateTable: trxUpdateTable,
    deleteFrom: trxDeleteFrom,
    insertInto: trxInsertInto,
  } as any;

  const transactionExecute = vi.fn().mockImplementation(async (fn: (trx: any) => Promise<void>) => {
    await fn(trx);
  });
  const transaction = vi.fn().mockReturnValue({ execute: transactionExecute });

  const db = {
    selectFrom,
    deleteFrom,
    insertInto,
    updateTable,
    transaction,
  } as any;

  return {
    db,
    trx,
    mocks: {
      selectFrom,
      selectAll,
      selectWhere,
      selectExecute,
      selectExecuteTakeFirst,
      selectExecuteTakeFirstOrThrow,
      deleteFrom,
      deleteWhere,
      deleteExecute,
      deleteExecuteTakeFirst,
      insertInto,
      insertValues,
      insertExecute,
      updateTable,
      updateSet,
      updateWhere,
      updateReturningAll,
      updateExecuteTakeFirstOrThrow,
      updateExecuteTakeFirst,
      transaction,
      transactionExecute,
      trxSelectFrom,
      trxSelectAll,
      trxSelectWhere,
      trxSelectExecute,
      trxUpdateTable,
      trxUpdateSet,
      trxUpdateWhere,
      trxUpdateExecute,
      trxDeleteFrom,
      trxDeleteWhere,
      trxDeleteExecute,
      trxInsertInto,
      trxInsertValues,
      trxInsertExecute,
    },
  };
}

// -- Tests --

describe('RegistrationStore', () => {
  describe('replaceAll (upsert pattern)', () => {
    it('should preserve registration IDs for existing workflows', async () => {
      const existingRow = makeRegistrationRow({
        id: 'existing-uuid-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existingRow] });
      const store = new RegistrationStore(db);
      const workflows = [makeLockWorkflow('wf-1')];

      await store.replaceAll('owner/repo', workflows, 'github:42', {}, { customerId: 'cust-1' });

      // Should start a transaction
      expect(mocks.transaction).toHaveBeenCalled();

      // Should SELECT existing registrations inside the transaction
      expect(mocks.trxSelectFrom).toHaveBeenCalledWith('workflow_registrations');

      // Should UPDATE the existing row (not INSERT)
      expect(mocks.trxUpdateTable).toHaveBeenCalledWith('workflow_registrations');
      // The where clause should reference the existing ID
      expect(mocks.trxUpdateWhere).toHaveBeenCalledWith('id', '=', 'existing-uuid-1');

      // Should NOT insert (workflow already exists)
      expect(mocks.trxInsertInto).not.toHaveBeenCalled();
      // Should NOT delete (workflow still present)
      expect(mocks.trxDeleteFrom).not.toHaveBeenCalled();
    });

    it('should INSERT new workflows that have no existing row', async () => {
      // No existing rows
      const { db, mocks } = createMockDb({ trxSelectResult: [] });
      const store = new RegistrationStore(db);
      const workflows = [makeLockWorkflow('new-wf')];

      await store.replaceAll('owner/repo', workflows, 'github:42', {}, { customerId: 'cust-1' });

      // Should INSERT the new workflow
      expect(mocks.trxInsertInto).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.trxInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          repo_identifier: 'owner/repo',
          workflow_name: 'new-wf',
          routing_key: 'github:42',
        }),
      );

      // Should NOT update (no existing rows)
      expect(mocks.trxUpdateTable).not.toHaveBeenCalled();
    });

    it('should DELETE removed workflows only', async () => {
      const existingRow = makeRegistrationRow({
        id: 'existing-uuid-1',
        workflow_name: 'old-wf',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existingRow] });
      const store = new RegistrationStore(db);

      // Push a different workflow -- old-wf should be deleted
      const workflows = [makeLockWorkflow('new-wf')];
      await store.replaceAll('owner/repo', workflows, 'github:42', {}, { customerId: 'cust-1' });

      // Should DELETE old-wf
      expect(mocks.trxDeleteFrom).toHaveBeenCalledWith('workflow_registrations');
      // Check that the where clauses filter by the removed workflow names
      expect(mocks.trxDeleteWhere).toHaveBeenCalledWith('workflow_name', 'in', ['old-wf']);

      // Should INSERT new-wf
      expect(mocks.trxInsertInto).toHaveBeenCalledWith('workflow_registrations');
    });

    it('should NOT include disabled in the UPDATE set clause', async () => {
      const existingRow = makeRegistrationRow({
        id: 'existing-uuid-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        disabled: true, // manually disabled
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existingRow] });
      const store = new RegistrationStore(db);

      await store.replaceAll(
        'owner/repo',
        [makeLockWorkflow('wf-1')],
        'github:42',
        {},
        { customerId: 'cust-1' },
      );

      // The UPDATE set call should NOT contain 'disabled'
      const setArg = mocks.trxUpdateSet.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('disabled');
    });

    it('should delete all registrations when workflows array is empty and existing rows exist', async () => {
      const existing1 = makeRegistrationRow({
        id: 'uuid-1',
        workflow_name: 'wf-a',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const existing2 = makeRegistrationRow({
        id: 'uuid-2',
        workflow_name: 'wf-b',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existing1, existing2] });
      const store = new RegistrationStore(db);

      await store.replaceAll('owner/repo', [], 'github:42', {}, { customerId: 'cust-1' });

      // Should delete both workflows by name
      expect(mocks.trxDeleteFrom).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.trxDeleteWhere).toHaveBeenCalledWith('workflow_name', 'in', ['wf-a', 'wf-b']);

      // Should NOT insert or update
      expect(mocks.trxInsertInto).not.toHaveBeenCalled();
      expect(mocks.trxUpdateTable).not.toHaveBeenCalled();
    });

    it('should set no-op when workflows array is empty and no existing rows', async () => {
      const { db, mocks } = createMockDb({ trxSelectResult: [] });
      const store = new RegistrationStore(db);

      await store.replaceAll('owner/repo', [], 'github:42', {}, { customerId: 'cust-1' });

      // No insert, update, or delete needed
      expect(mocks.trxInsertInto).not.toHaveBeenCalled();
      expect(mocks.trxUpdateTable).not.toHaveBeenCalled();
      expect(mocks.trxDeleteFrom).not.toHaveBeenCalled();
    });

    it('should UPDATE lock_entry, trigger_types, provider_context, commit_sha, source_file, updated_at', async () => {
      const existingRow = makeRegistrationRow({
        id: 'existing-uuid-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existingRow] });
      const store = new RegistrationStore(db);
      const wf = makeLockWorkflow('wf-1', ['push', 'schedule']);

      await store.replaceAll(
        'owner/repo',
        [wf],
        'github:42',
        { installationId: 123 },
        {
          customerId: 'cust-1',
          commitSha: 'deadbeef',
        },
      );

      const setArg = mocks.trxUpdateSet.mock.calls[0][0];
      expect(setArg.lock_entry).toBe(JSON.stringify(wf));
      expect(setArg.trigger_types).toEqual(['push', 'schedule']);
      expect(setArg.provider_context).toBe(JSON.stringify({ installationId: 123 }));
      expect(setArg.commit_sha).toBe('deadbeef');
      expect(setArg.source_file).toBe('.kici/workflows/wf-1.ts');
      expect(setArg.updated_at).toBeInstanceOf(Date);
    });

    it('should serialize lock_entry as JSON string for new workflows', async () => {
      const { db, mocks } = createMockDb({ trxSelectResult: [] });
      const store = new RegistrationStore(db);
      const wf = makeLockWorkflow('wf-1');

      await store.replaceAll('owner/repo', [wf], 'github:42', {}, { customerId: 'cust-1' });

      const insertedRow = mocks.trxInsertValues.mock.calls[0][0];
      expect(typeof insertedRow.lock_entry).toBe('string');
      expect(JSON.parse(insertedRow.lock_entry)).toEqual(wf);
    });

    it('should extract unique trigger types from workflow triggers for new workflows', async () => {
      const { db, mocks } = createMockDb({ trxSelectResult: [] });
      const store = new RegistrationStore(db);
      const wf = makeLockWorkflow('wf-1', ['kici_event', 'schedule', 'kici_event']);

      await store.replaceAll('owner/repo', [wf], 'github:42', {}, { customerId: 'cust-1' });

      const insertedRow = mocks.trxInsertValues.mock.calls[0][0];
      const types = insertedRow.trigger_types as string[];
      expect(types).toHaveLength(2);
      expect(types).toContain('kici_event');
      expect(types).toContain('schedule');
    });

    it('should handle mix of existing, new, and removed workflows', async () => {
      const existingKept = makeRegistrationRow({
        id: 'uuid-kept',
        workflow_name: 'kept-wf',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const existingRemoved = makeRegistrationRow({
        id: 'uuid-removed',
        workflow_name: 'removed-wf',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
      });
      const { db, mocks } = createMockDb({
        trxSelectResult: [existingKept, existingRemoved],
      });
      const store = new RegistrationStore(db);

      // Keep 'kept-wf', add 'new-wf', remove 'removed-wf'
      const workflows = [makeLockWorkflow('kept-wf'), makeLockWorkflow('new-wf')];
      await store.replaceAll('owner/repo', workflows, 'github:42', {}, { customerId: 'cust-1' });

      // Should UPDATE kept-wf
      expect(mocks.trxUpdateTable).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.trxUpdateWhere).toHaveBeenCalledWith('id', '=', 'uuid-kept');

      // Should INSERT new-wf
      expect(mocks.trxInsertInto).toHaveBeenCalledWith('workflow_registrations');

      // Should DELETE removed-wf
      expect(mocks.trxDeleteFrom).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.trxDeleteWhere).toHaveBeenCalledWith('workflow_name', 'in', ['removed-wf']);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Plan 28.6.2-07 Task 2 — replaceAll self-heal for stale __default__
  // customer_id rows.
  //
  // Background: the 2026-04-12 staging failover-routing spike found 12
  // workflow_registrations rows stuck at customer_id='__default__' for
  // routing_key='github:2848097'. The rows were written before the
  // matching sources.customer_id was back-filled to 'kiciStg00001', and
  // there is no code path that re-stamps them after the fact. The
  // stale rows broke Plan 06's cross-provider lock-file fallback
  // because the registration index is keyed by `${customerId}|${repo}`.
  //
  // The self-heal detects this specific stale pattern inside the same
  // replaceAll transaction: if any existing row for (routing_key,
  // repo_identifier) has customer_id='__default__' AND the incoming
  // options.customerId is a real tenant, rewrite the stale rows AND
  // emit an INFO log marker. The heal does NOT fire when both existing
  // and incoming customerIds are '__default__' (preserves legacy
  // unresolved-source behavior and avoids journal noise).
  // ─────────────────────────────────────────────────────────────────
  describe('replaceAll self-heal (28.6.2-07)', () => {
    beforeEach(() => {
      mockLogger.info.mockClear();
      mockLogger.debug.mockClear();
      mockLogger.warn.mockClear();
      mockLogger.error.mockClear();
    });

    it('Test 1: no heal when existing rows already have the correct customerId', async () => {
      const existingRow = makeRegistrationRow({
        id: 'existing-uuid-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        customer_id: 'custA',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [existingRow] });
      const store = new RegistrationStore(db);
      const wf1 = makeLockWorkflow('wf-1');
      const wf2 = makeLockWorkflow('wf-2');

      await store.replaceAll('owner/repo', [wf1, wf2], 'github:42', {}, { customerId: 'custA' });

      // No self-heal log emitted.
      const healLogs = mockLogger.info.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('Registration self-heal'),
      );
      expect(healLogs.length).toBe(0);

      // The UPDATE call count equals the per-workflow upsert count (1 for wf-1).
      // Specifically, no pre-loop bulk UPDATE was issued: the only updateTable
      // calls match the per-row upsert with `id = ?` in the where clause.
      const wherePreIdCalls = mocks.trxUpdateWhere.mock.calls.filter(
        (call: unknown[]) => call[0] === 'id',
      );
      const whereCustomerIdCalls = mocks.trxUpdateWhere.mock.calls.filter(
        (call: unknown[]) => call[0] === 'customer_id',
      );
      expect(wherePreIdCalls.length).toBeGreaterThanOrEqual(1);
      expect(whereCustomerIdCalls.length).toBe(0);

      // Normal upsert: wf-1 updated, wf-2 inserted.
      expect(mocks.trxUpdateTable).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.trxInsertInto).toHaveBeenCalledWith('workflow_registrations');
    });

    it('Test 2: HEAL fires when existing rows are __default__ and incoming customerId is real', async () => {
      const stale1 = makeRegistrationRow({
        id: 'uuid-stale-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        customer_id: '__default__',
      });
      const stale2 = makeRegistrationRow({
        id: 'uuid-stale-2',
        workflow_name: 'wf-2',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        customer_id: '__default__',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [stale1, stale2] });
      const store = new RegistrationStore(db);

      await store.replaceAll(
        'owner/repo',
        [makeLockWorkflow('wf-1'), makeLockWorkflow('wf-2'), makeLockWorkflow('wf-3')],
        'github:42',
        {},
        { customerId: 'kiciStg00001' },
      );

      // The self-heal INFO log fires exactly once with the expected marker
      // message and structured context.
      const healLogs = mockLogger.info.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          call[0] === 'Registration self-heal: rewrote stale customer_id',
      );
      expect(healLogs.length).toBe(1);
      const healContext = healLogs[0][1] as Record<string, unknown>;
      expect(healContext.routingKey).toBe('github:42');
      expect(healContext.repoIdentifier).toBe('owner/repo');
      expect(healContext.oldCustomerId).toBe('__default__');
      expect(healContext.newCustomerId).toBe('kiciStg00001');
      expect(healContext.rowsHealed).toBe(2);

      // The heal UPDATE was issued inside the transaction. We can assert
      // this by looking for an updateTable+set call whose set payload
      // contains `customer_id: 'kiciStg00001'`.
      const setCalls = mocks.trxUpdateSet.mock.calls as unknown[][];
      const healSetCalls = setCalls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg.customer_id === 'kiciStg00001';
      });
      expect(healSetCalls.length).toBe(1);

      // The heal where clauses narrow to (routing_key, repo_identifier,
      // customer_id='__default__'). Check each filter was applied.
      const whereCalls = mocks.trxUpdateWhere.mock.calls as unknown[][];
      const routingKeyHeal = whereCalls.filter(
        (c) => c[0] === 'routing_key' && c[2] === 'github:42',
      );
      const repoHeal = whereCalls.filter(
        (c) => c[0] === 'repo_identifier' && c[2] === 'owner/repo',
      );
      const defaultHeal = whereCalls.filter(
        (c) => c[0] === 'customer_id' && c[2] === '__default__',
      );
      expect(routingKeyHeal.length).toBeGreaterThanOrEqual(1);
      expect(repoHeal.length).toBeGreaterThanOrEqual(1);
      expect(defaultHeal.length).toBe(1);

      // Only a single transaction was opened (heal runs in the same one).
      expect(mocks.transaction).toHaveBeenCalledTimes(1);

      // The subsequent upsert loop ran normally: wf-1 and wf-2 updated,
      // wf-3 inserted.
      expect(mocks.trxInsertInto).toHaveBeenCalledWith('workflow_registrations');
    });

    it('Test 3: no heal when both existing and incoming customerIds are __default__ (legacy preservation, no noisy log)', async () => {
      const legacyRow = makeRegistrationRow({
        id: 'uuid-legacy-1',
        workflow_name: 'wf-1',
        routing_key: 'generic:unconfigured',
        repo_identifier: 'owner/repo',
        customer_id: '__default__',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [legacyRow] });
      const store = new RegistrationStore(db);

      await store.replaceAll(
        'owner/repo',
        [makeLockWorkflow('wf-1')],
        'generic:unconfigured',
        {},
        { customerId: '__default__' },
      );

      // No heal UPDATE issued: we don't rewrite __default__ to __default__.
      const setCalls = mocks.trxUpdateSet.mock.calls as unknown[][];
      const healSetCalls = setCalls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg.customer_id !== undefined;
      });
      expect(healSetCalls.length).toBe(0);

      // No self-heal log (avoids per-push journal noise for unconfigured sources).
      const healLogs = mockLogger.info.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('Registration self-heal'),
      );
      expect(healLogs.length).toBe(0);

      // Normal upsert proceeds (wf-1 already exists → UPDATE, not INSERT).
      expect(mocks.trxUpdateTable).toHaveBeenCalledWith('workflow_registrations');
    });

    it('Test 4: concurrent replaceAll() under serializable — no double-heal, second call sees already-healed rows and does not re-heal or re-log', async () => {
      // Simulates the state after a prior transaction's heal has committed:
      // the second call's in-transaction SELECT returns rows already tagged
      // with the real tenant customer_id. Real serialization is enforced by
      // DB transaction isolation; this test only verifies the read-existing
      // → decide-to-heal logic correctly handles already-healed state.
      const alreadyHealed = makeRegistrationRow({
        id: 'uuid-healed-1',
        workflow_name: 'wf-1',
        routing_key: 'github:42',
        repo_identifier: 'owner/repo',
        customer_id: 'kiciStg00001',
      });
      const { db, mocks } = createMockDb({ trxSelectResult: [alreadyHealed] });
      const store = new RegistrationStore(db);

      // Run two concurrent replaceAll calls against the same store/mock.
      // Both see the already-healed row in the in-transaction SELECT, so
      // neither issues a heal UPDATE.
      await Promise.all([
        store.replaceAll(
          'owner/repo',
          [makeLockWorkflow('wf-1')],
          'github:42',
          {},
          { customerId: 'kiciStg00001' },
        ),
        store.replaceAll(
          'owner/repo',
          [makeLockWorkflow('wf-1')],
          'github:42',
          {},
          { customerId: 'kiciStg00001' },
        ),
      ]);

      // No self-heal logs at all across both concurrent calls.
      const healLogs = mockLogger.info.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('Registration self-heal'),
      );
      expect(healLogs.length).toBe(0);

      // No bulk UPDATE setting customer_id='kiciStg00001' was issued.
      const setCalls = mocks.trxUpdateSet.mock.calls as unknown[][];
      const healSetCalls = setCalls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg.customer_id !== undefined;
      });
      expect(healSetCalls.length).toBe(0);
    });
  });

  describe('replaceAll with commit SHA and source file', () => {
    it('should store commitSha and sourceFile when provided for new workflows', async () => {
      const { db, mocks } = createMockDb({ trxSelectResult: [] });
      const store = new RegistrationStore(db);
      const workflows = [makeLockWorkflow('wf-1')];

      await store.replaceAll(
        'owner/repo',
        workflows,
        'github:42',
        {},
        {
          customerId: 'cust-1',
          commitSha: 'abc123def',
          sourceFile: '.kici/workflows/wf-1.ts',
        },
      );

      const insertedRow = mocks.trxInsertValues.mock.calls[0][0];
      expect(insertedRow.commit_sha).toBe('abc123def');
      expect(insertedRow.source_file).toBe('.kici/workflows/wf-1.ts');
    });
  });

  describe('getAll', () => {
    it('should return all registrations with parsed lock_entry', async () => {
      const wf = makeLockWorkflow('on-deploy');
      const rows = [makeRegistrationRow({ lock_entry: JSON.stringify(wf) })];
      const { db } = createMockDb({ selectManyResult: rows });
      const store = new RegistrationStore(db);

      const result = await store.getAll();

      expect(result).toHaveLength(1);
      expect(result[0].workflow_name).toBe('on-deploy');
      expect(result[0].lock_entry).toEqual(wf);
      expect(typeof result[0].lock_entry).toBe('object');
    });

    it('should return empty array when no registrations exist', async () => {
      const { db } = createMockDb({ selectManyResult: [] });
      const store = new RegistrationStore(db);

      const result = await store.getAll();

      expect(result).toEqual([]);
    });
  });

  describe('getByRoutingKey', () => {
    it('should query with routing_key filter', async () => {
      const rows = [makeRegistrationRow()];
      const { db, mocks } = createMockDb({ selectManyResult: rows });
      const store = new RegistrationStore(db);

      const result = await store.getByRoutingKey('github:42');

      expect(result).toHaveLength(1);
      expect(mocks.selectFrom).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.selectWhere).toHaveBeenCalledWith('routing_key', '=', 'github:42');
    });
  });

  describe('getByRoutingKeyAndRepo', () => {
    it('should query with routing_key and repo_identifier filters', async () => {
      const rows = [makeRegistrationRow()];
      const { db, mocks } = createMockDb({ selectManyResult: rows });
      const store = new RegistrationStore(db);

      const result = await store.getByRoutingKeyAndRepo('github:42', 'owner/repo');

      expect(result).toHaveLength(1);
      // Two where calls: routing_key and repo_identifier
      expect(mocks.selectWhere).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteByRoutingKeyAndRepo', () => {
    it('should delete with routing_key and repo_identifier filters', async () => {
      const { db, mocks } = createMockDb();
      const store = new RegistrationStore(db);

      await store.deleteByRoutingKeyAndRepo('github:42', 'owner/repo');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('workflow_registrations');
    });
  });

  describe('getVersion', () => {
    it('should return the current version from registry_versions', async () => {
      const { db } = createMockDb({
        selectOneResult: { id: 'default', version: 5, updated_at: new Date() },
      });
      const store = new RegistrationStore(db);

      const version = await store.getVersion();

      expect(version).toBe(5);
    });
  });

  describe('bumpVersion', () => {
    it('should increment version and return new value', async () => {
      const { db, mocks } = createMockDb({
        updateResult: { id: 'default', version: 6, updated_at: new Date() },
      });
      const store = new RegistrationStore(db);

      const newVersion = await store.bumpVersion();

      expect(newVersion).toBe(6);
      expect(mocks.updateTable).toHaveBeenCalledWith('registry_versions');
      expect(mocks.updateWhere).toHaveBeenCalledWith('id', '=', 'default');
    });
  });

  describe('setDisabled', () => {
    it('should set disabled=true and return true when row exists', async () => {
      const { db, mocks } = createMockDb({
        updateResult: { numUpdatedRows: 1n },
      });
      mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 1n });
      const store = new RegistrationStore(db);

      const result = await store.setDisabled('reg-001', true);

      expect(result).toBe(true);
      expect(mocks.updateTable).toHaveBeenCalledWith('workflow_registrations');
      expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
    });

    it('should set disabled=false and return true when row exists', async () => {
      const { db, mocks } = createMockDb({
        updateResult: { numUpdatedRows: 1n },
      });
      mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 1n });
      const store = new RegistrationStore(db);

      const result = await store.setDisabled('reg-001', false);

      expect(result).toBe(true);
      expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ disabled: false }));
    });

    it('should return false when row does not exist', async () => {
      const { db, mocks } = createMockDb({
        updateResult: { numUpdatedRows: 0n },
      });
      mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });
      const store = new RegistrationStore(db);

      const result = await store.setDisabled('nonexistent', true);

      expect(result).toBe(false);
    });
  });

  describe('getAll returns new fields', () => {
    it('should return disabled, commitSha, sourceFile in parsed rows', async () => {
      const wf = makeLockWorkflow('on-deploy');
      const rows = [
        makeRegistrationRow({
          lock_entry: JSON.stringify(wf),
          disabled: false,
          commit_sha: 'abc123',
          source_file: '.kici/workflows/on-deploy.ts',
        }),
      ];
      const { db } = createMockDb({ selectManyResult: rows });
      const store = new RegistrationStore(db);

      const result = await store.getAll();

      expect(result).toHaveLength(1);
      expect(result[0].disabled).toBe(false);
      expect(result[0].commitSha).toBe('abc123');
      expect(result[0].sourceFile).toBe('.kici/workflows/on-deploy.ts');
    });
  });
});
