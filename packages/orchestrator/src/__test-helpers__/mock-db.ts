/**
 * Shared mock Kysely database builder for orchestrator tests.
 *
 * Provides a configurable `createMockDb()` that constructs a chainable
 * mock supporting the common query patterns used by the orchestrator:
 *
 * - selectFrom().selectAll().where()...execute() / executeTakeFirst()
 * - selectFrom().select().where()...execute() / executeTakeFirst() / executeTakeFirstOrThrow()
 * - insertInto().values().execute() / returning().executeTakeFirstOrThrow()
 * - insertInto().values().onConflict(cb).execute()
 * - insertInto().values().returningAll().executeTakeFirstOrThrow()
 * - updateTable().set().where()...execute() / executeTakeFirst()
 * - deleteFrom().where()...execute() / executeTakeFirst()
 * - transaction().execute(async (trx) => { ... })
 *
 * Each test can configure return values via options and access the
 * underlying vi.fn() mocks for assertions via the `mocks` property.
 */
import { vi } from 'vitest';

// ── Options ──────────────────────────────────────────────────────

export interface MockDbOptions {
  /** Rows returned by selectAll/select chains ending in .execute(). Default: [] */
  selectRows?: unknown[];

  /** Row returned by select chains ending in .executeTakeFirst(). Default: undefined */
  selectFirstRow?: unknown | undefined;

  /** Row returned by insert chains ending in .returningAll().executeTakeFirstOrThrow(). Default: { id: 'mock-id' } */
  insertedRow?: unknown;

  /** Row returned by insert chains ending in .returning().executeTakeFirstOrThrow(). Default: { id: 'mock-id' } */
  insertReturning?: unknown;

  /** Row returned by update chains ending in .returningAll().executeTakeFirstOrThrow() or executeTakeFirst(). Default: undefined */
  updatedRow?: unknown;

  /** Row returned by update chains ending in .returning(...).executeTakeFirst(). Default: undefined */
  updateReturning?: unknown;

  /** Result for update .execute() calls. Default: { numUpdatedRows: 0n } */
  updateResult?: { numUpdatedRows: bigint };

  /** Result for delete .executeTakeFirst() calls. Default: { numDeletedRows: 0n } */
  deleteResult?: { numDeletedRows: bigint };

  /** Result for count queries (fn.countAll). Default: { count: 0 } */
  countResult?: { count: number };

  /** Result for insert chains ending in .executeTakeFirst(). Default: undefined */
  insertResult?: { numInsertedOrUpdatedRows: bigint };
}

// ── Return type ──────────────────────────────────────────────────

export interface MockDb {
  db: any;
  mocks: MockDbMocks;
}

export interface MockDbMocks {
  // Select chain
  selectFrom: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  selectWhere: ReturnType<typeof vi.fn>;
  selectOrderBy: ReturnType<typeof vi.fn>;
  selectLimit: ReturnType<typeof vi.fn>;
  selectExecute: ReturnType<typeof vi.fn>;
  selectExecuteTakeFirst: ReturnType<typeof vi.fn>;
  selectExecuteTakeFirstOrThrow: ReturnType<typeof vi.fn>;
  selectForUpdate: ReturnType<typeof vi.fn>;
  selectSkipLocked: ReturnType<typeof vi.fn>;

  // Insert chain
  insertInto: ReturnType<typeof vi.fn>;
  insertValues: ReturnType<typeof vi.fn>;
  insertReturning: ReturnType<typeof vi.fn>;
  insertReturningAll: ReturnType<typeof vi.fn>;
  insertExecute: ReturnType<typeof vi.fn>;
  insertExecuteTakeFirstOrThrow: ReturnType<typeof vi.fn>;
  onConflict: ReturnType<typeof vi.fn>;

  // Update chain
  updateTable: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
  updateWhere: ReturnType<typeof vi.fn>;
  updateReturningAll: ReturnType<typeof vi.fn>;
  updateExecute: ReturnType<typeof vi.fn>;
  updateExecuteTakeFirst: ReturnType<typeof vi.fn>;
  updateExecuteTakeFirstOrThrow: ReturnType<typeof vi.fn>;

  // Delete chain
  deleteFrom: ReturnType<typeof vi.fn>;
  deleteWhere: ReturnType<typeof vi.fn>;
  deleteExecute: ReturnType<typeof vi.fn>;
  deleteExecuteTakeFirst: ReturnType<typeof vi.fn>;

  // Transaction
  transaction: ReturnType<typeof vi.fn>;
  transactionExecute: ReturnType<typeof vi.fn>;

  // fn.countAll
  countAll: ReturnType<typeof vi.fn>;
  countAs: ReturnType<typeof vi.fn>;
  countExecuteTakeFirst: ReturnType<typeof vi.fn>;
}

// ── Builder ──────────────────────────────────────────────────────

/**
 * Create a mock Kysely DB instance for orchestrator unit tests.
 *
 * All query chains are fully wired and return sensible defaults.
 * Override specific return values via the `options` parameter.
 *
 * @example
 * ```ts
 * const { db, mocks } = createMockDb({ selectRows: [row1, row2] });
 * const store = new SomeStore(db);
 * await store.list();
 * expect(mocks.selectFrom).toHaveBeenCalledWith('my_table');
 * ```
 */
export function createMockDb(options: MockDbOptions = {}): MockDb {
  const {
    selectRows = [],
    selectFirstRow = undefined,
    insertedRow = { id: 'mock-id' },
    insertReturning = { id: 'mock-id' },
    updatedRow = undefined,
    updateReturning = undefined,
    updateResult = { numUpdatedRows: 0n },
    deleteResult = { numDeletedRows: 0n },
    countResult = { count: 0 },
    insertResult = undefined,
  } = options;

  // ── Select chain ─────────────────────────────────────────────
  const selectExecute = vi.fn().mockResolvedValue(selectRows);
  const selectExecuteTakeFirst = vi.fn().mockResolvedValue(selectFirstRow);
  const selectExecuteTakeFirstOrThrow = vi
    .fn()
    .mockResolvedValue(selectFirstRow ?? selectRows[0] ?? {});

  // Self-referencing where/orderBy/limit chain
  const selectTerminal: Record<string, any> = {
    execute: selectExecute,
    executeTakeFirst: selectExecuteTakeFirst,
    executeTakeFirstOrThrow: selectExecuteTakeFirstOrThrow,
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
    returningAll: vi.fn(),
    forUpdate: vi.fn(),
    skipLocked: vi.fn(),
    distinct: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
  };
  selectTerminal.where = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.orderBy = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.limit = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.or = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.returningAll = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.forUpdate = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.skipLocked = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.distinct = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.innerJoin = vi.fn().mockReturnValue(selectTerminal);
  selectTerminal.leftJoin = vi.fn().mockReturnValue(selectTerminal);

  const selectAll = vi.fn().mockReturnValue(selectTerminal);
  const select = vi.fn().mockReturnValue(selectTerminal);

  // ── Count chain (fn.countAll) ────────────────────────────────
  const countExecuteTakeFirst = vi.fn().mockResolvedValue(countResult);
  const _countSelect = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      executeTakeFirst: countExecuteTakeFirst,
    }),
  });
  const countAs = vi.fn().mockReturnValue('count');
  const countAll = vi.fn().mockReturnValue({ as: countAs });

  const selectFromReturn: Record<string, any> = {
    selectAll,
    select: vi.fn().mockImplementation((...args: any[]) => {
      // When called with fn.countAll, return count chain
      // otherwise return selectTerminal
      select(...args);
      return selectTerminal;
    }),
    // Joins issued before .select() (e.g. attestations ⋈ execution_jobs) chain
    // back to the same object so a following .select() still reaches the
    // terminal. Mirrors selectTerminal's own join methods.
    innerJoin: vi.fn().mockImplementation(() => selectFromReturn),
    leftJoin: vi.fn().mockImplementation(() => selectFromReturn),
  };
  const selectFrom = vi.fn().mockReturnValue(selectFromReturn);

  // ── Insert chain ─────────────────────────────────────────────
  const insertExecute = vi.fn().mockResolvedValue(undefined);
  const insertExecuteTakeFirst = vi
    .fn()
    .mockResolvedValue(insertResult ?? { numInsertedOrUpdatedRows: 1n });
  const insertExecuteTakeFirstOrThrow = vi.fn().mockResolvedValue(insertReturning);

  const insertReturningExecuteTakeFirst = vi.fn().mockResolvedValue(insertReturning);
  const insertReturningFn = vi.fn().mockReturnValue({
    executeTakeFirstOrThrow: insertExecuteTakeFirstOrThrow,
    executeTakeFirst: insertReturningExecuteTakeFirst,
  });

  const insertReturningAll = vi.fn().mockReturnValue({
    executeTakeFirstOrThrow: vi.fn().mockResolvedValue(insertedRow),
  });

  // Shared terminal for conflict resolution chains (doUpdateSet/doNothing)
  const conflictTerminal = {
    execute: vi.fn().mockResolvedValue(undefined),
    executeTakeFirst: insertExecuteTakeFirst,
    where: vi.fn(),
  } as Record<string, any>;
  conflictTerminal.where = vi.fn().mockReturnValue(conflictTerminal);

  const onConflict = vi.fn().mockImplementation((cb: Function) => {
    if (typeof cb === 'function') {
      cb({
        column: vi.fn().mockReturnValue({
          doUpdateSet: vi.fn().mockReturnValue(conflictTerminal),
          doNothing: vi.fn().mockReturnValue({
            returning: insertReturningFn,
            executeTakeFirstOrThrow: insertExecuteTakeFirstOrThrow,
          }),
        }),
        columns: vi.fn().mockReturnValue({
          doUpdateSet: vi.fn().mockReturnValue(conflictTerminal),
          doNothing: vi.fn().mockReturnValue({
            returning: insertReturningFn,
            executeTakeFirstOrThrow: insertExecuteTakeFirstOrThrow,
          }),
        }),
      });
    }
    return {
      execute: vi.fn().mockResolvedValue(undefined),
      executeTakeFirst: insertExecuteTakeFirst,
      returning: insertReturningFn,
    };
  });

  const insertValues = vi.fn().mockReturnValue({
    execute: insertExecute,
    executeTakeFirst: insertExecuteTakeFirst,
    returning: insertReturningFn,
    returningAll: insertReturningAll,
    onConflict,
  });

  const insertInto = vi.fn().mockReturnValue({ values: insertValues });

  // ── Update chain ─────────────────────────────────────────────
  const updateExecute = vi.fn().mockResolvedValue(updateResult);
  const updateExecuteTakeFirst = vi.fn().mockResolvedValue(updateResult);
  const updateExecuteTakeFirstOrThrow = vi.fn().mockResolvedValue(updatedRow ?? updateResult);

  const updateReturningAll = vi.fn().mockReturnValue({
    executeTakeFirstOrThrow: updateExecuteTakeFirstOrThrow,
    executeTakeFirst: vi.fn().mockResolvedValue(updatedRow),
  });

  const updateReturningExecuteTakeFirst = vi.fn().mockResolvedValue(updateReturning);
  const updateReturningFn = vi.fn().mockReturnValue({
    executeTakeFirst: updateReturningExecuteTakeFirst,
    execute: vi.fn().mockResolvedValue(updateReturning === undefined ? [] : [updateReturning]),
  });

  const updateTerminal: Record<string, any> = {
    execute: updateExecute,
    executeTakeFirst: updateExecuteTakeFirst,
    returningAll: updateReturningAll,
    returning: updateReturningFn,
    where: vi.fn(),
  };
  updateTerminal.where = vi.fn().mockReturnValue(updateTerminal);

  const updateSet = vi.fn().mockReturnValue(updateTerminal);
  const updateTable = vi.fn().mockReturnValue({ set: updateSet });

  // ── Delete chain ─────────────────────────────────────────────
  const deleteExecute = vi.fn().mockResolvedValue([deleteResult]);
  const deleteExecuteTakeFirst = vi.fn().mockResolvedValue(deleteResult);

  const deleteTerminal: Record<string, any> = {
    execute: deleteExecute,
    executeTakeFirst: deleteExecuteTakeFirst,
    where: vi.fn(),
  };
  deleteTerminal.where = vi.fn().mockReturnValue(deleteTerminal);

  const deleteFrom = vi.fn().mockReturnValue({ where: deleteTerminal.where });

  // ── Transaction ──────────────────────────────────────────────
  // Transaction re-uses the db object as the trx argument. Kysely's
  // `transaction().execute(cb)` resolves to the callback's return value, so the
  // mock must forward it (consumers like HeldRunStore.recordAndRelease return
  // the value produced inside the transaction).
  let dbRef: any;
  const transactionExecute = vi.fn().mockImplementation(async (cb: Function) => {
    return cb(dbRef);
  });
  const transaction = vi.fn().mockReturnValue({ execute: transactionExecute });

  // ── Assemble DB ──────────────────────────────────────────────
  const db: any = {
    selectFrom,
    insertInto,
    updateTable,
    deleteFrom,
    transaction,
    fn: { countAll },
  };
  dbRef = db;

  // ── Mocks ────────────────────────────────────────────────────
  const mocks: MockDbMocks = {
    selectFrom,
    selectAll,
    select,
    selectWhere: selectTerminal.where,
    selectOrderBy: selectTerminal.orderBy,
    selectLimit: selectTerminal.limit,
    selectExecute,
    selectExecuteTakeFirst,
    selectExecuteTakeFirstOrThrow,
    selectForUpdate: selectTerminal.forUpdate,
    selectSkipLocked: selectTerminal.skipLocked,

    insertInto,
    insertValues,
    insertReturning: insertReturningFn,
    insertReturningAll,
    insertExecute,
    insertExecuteTakeFirstOrThrow,
    onConflict,

    updateTable,
    updateSet,
    updateWhere: updateTerminal.where,
    updateReturningAll,
    updateExecute,
    updateExecuteTakeFirst,
    updateExecuteTakeFirstOrThrow,

    deleteFrom,
    deleteWhere: deleteTerminal.where,
    deleteExecute,
    deleteExecuteTakeFirst,

    transaction,
    transactionExecute,

    countAll,
    countAs,
    countExecuteTakeFirst,
  };

  return { db, mocks };
}
