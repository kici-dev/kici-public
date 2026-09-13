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
 *
 * ## The select chain APPLIES the query (contract)
 *
 * A select chain does not return `selectRows` / `selectFirstRow` verbatim. It
 * evaluates the `.where(...)` predicates and the `.select([...])` projection the
 * code under test issued, so a test observes the query instead of restating it:
 * dropping a filter or a projected column changes what the test sees.
 *
 * - **Per query, not per test.** Every `db.selectFrom(...)` builds a fresh chain
 *   with its own predicate list, so two queries in one test cannot inherit each
 *   other's filters. The `mocks.select*` spies stay shared across the whole
 *   test, so existing clause assertions are unaffected.
 * - **Only the shapes the evaluator reads.** `.where(column, op, value)` is
 *   evaluated; an `eb` callback or a raw `sql` fragment is recorded and skipped.
 *   `.select()` is applied only when every argument is a plain column string, so
 *   an aggregate or `eb` projection leaves rows untouched.
 * - **A predicate on a column the fixture omits does not exclude the row.** To
 *   pin a filter, the fixture row must declare the column that filter reads.
 * - **`executeTakeFirstOrThrow` yields `{}`** when the configured row does not
 *   satisfy the query, rather than throwing as Kysely would.
 *
 * `mock-db-query.ts` holds the evaluator and states the same contract with its
 * reasoning; `mock-db-query.test.ts` tests it directly.
 */
import { type Mock, vi } from 'vitest';
import {
  type MockDbPredicate,
  type ProjectedColumn,
  filterRows,
  parseSelectArgs,
  parseWhereArgs,
  projectRow,
  projectRows,
  rowMatches,
} from './mock-db-query.js';

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

  /** Rows returned by update chains ending in .returningAll().execute(). Default: [] */
  updatedRows?: unknown[];

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
  /** The upsert's ON CONFLICT DO UPDATE SET payload — shared across both the
   *  column() and columns() shapes, so a test can assert what an existing row
   *  is actually updated with. */
  doUpdateSet: ReturnType<typeof vi.fn>;

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

/** Default row a `.returning(...)` / `.returningAll()` insert chain resolves to. */
const DEFAULT_INSERT_ROW = { id: 'mock-id' };

/**
 * Resolve the `insertReturning` option, honoring an explicit `undefined` (models
 * a RETURNING chain yielding zero rows — e.g. ON CONFLICT DO NOTHING skipped the
 * insert). A destructuring default would collapse explicit undefined back to the
 * default row, hiding the no-row case.
 */
function resolveInsertReturning(options: MockDbOptions): unknown {
  return 'insertReturning' in options ? options.insertReturning : DEFAULT_INSERT_ROW;
}

/**
 * A spy the chain both records on and CALLS.
 *
 * The bare `ReturnType<typeof vi.fn>` used across {@link MockDbMocks} widens to
 * `Mock<Constructable | Procedure>`, which TypeScript refuses to call — fine for
 * an interface that is only ever asserted against, not for one the chain invokes.
 */
type CallableSpy = Mock<(...args: any[]) => any>;

/** The shared select-chain spies every per-query chain records through. */
interface SelectChainSpies {
  selectAll: CallableSpy;
  select: CallableSpy;
  where: CallableSpy;
  orderBy: CallableSpy;
  limit: CallableSpy;
  offset: CallableSpy;
  forUpdate: CallableSpy;
  skipLocked: CallableSpy;
  execute: CallableSpy;
  executeTakeFirst: CallableSpy;
  executeTakeFirstOrThrow: CallableSpy;
}

/** Methods that only chain — they record on a shared spy and return the chain. */
const CHAINING_METHODS = [
  'orderBy',
  'limit',
  'offset',
  'forUpdate',
  'skipLocked',
] as const satisfies readonly (keyof SelectChainSpies)[];

/** Methods that chain but carry no shared spy of their own. */
const UNSPIED_CHAINING_METHODS = [
  'or',
  'returningAll',
  'distinct',
  'groupBy',
  'innerJoin',
  'leftJoin',
] as const;

/**
 * Build one `selectFrom(...)` query chain.
 *
 * Each call gets its own predicate list and projection, so two queries in the
 * same test cannot contaminate each other's filters — while every call still
 * records through the SHARED spies in `spies`, so `mocks.selectWhere` and
 * friends keep observing the whole test as they always have.
 *
 * The terminals delegate to the shared `execute` / `executeTakeFirst` /
 * `executeTakeFirstOrThrow` spies and then apply this chain's own WHERE and
 * SELECT to whatever came back. Delegating first is what keeps a test's
 * `mocks.selectExecute.mockResolvedValue(...)` override working — and makes the
 * override subject to the same filtering as the configured rows.
 */
function buildSelectChain(spies: SelectChainSpies): Record<string, any> {
  const predicates: MockDbPredicate[] = [];
  let projection: ProjectedColumn[] | undefined;
  const chain: Record<string, any> = {};

  // Every chain method is itself a `vi.fn()`, not a plain closure. A test may
  // walk the chain to assert per-query — `db.selectFrom.mock.results[0].value
  // .select` — and a plain function there fails with "is not a spy". Recording
  // on BOTH the per-chain spy and the shared one keeps that walk working while
  // `mocks.selectWhere` still observes the whole test.
  chain.where = vi.fn((...args: unknown[]) => {
    spies.where(...args);
    predicates.push(parseWhereArgs(args));
    return chain;
  });
  chain.select = vi.fn((...args: unknown[]) => {
    spies.select(...args);
    projection = parseSelectArgs(args);
    return chain;
  });
  chain.selectAll = vi.fn((...args: unknown[]) => {
    spies.selectAll(...args);
    projection = undefined;
    return chain;
  });
  for (const method of CHAINING_METHODS) {
    chain[method] = vi.fn((...args: unknown[]) => {
      spies[method](...args);
      return chain;
    });
  }
  for (const method of UNSPIED_CHAINING_METHODS) {
    chain[method] = vi.fn(() => chain);
  }

  const shape = <T>(row: T): T => (projection ? projectRow(row, projection) : row);

  chain.execute = async (...args: unknown[]) => {
    const rows = (await spies.execute(...args)) as unknown[] | undefined;
    if (!Array.isArray(rows)) return rows;
    const kept = filterRows(rows, predicates);
    return projection ? projectRows(kept, projection) : kept;
  };
  chain.executeTakeFirst = async (...args: unknown[]) => {
    const row = await spies.executeTakeFirst(...args);
    if (row === undefined || row === null) return row;
    return rowMatches(row, predicates) ? shape(row) : undefined;
  };
  chain.executeTakeFirstOrThrow = async (...args: unknown[]) => {
    const row = await spies.executeTakeFirstOrThrow(...args);
    if (row === undefined || row === null) return row;
    // A configured row the query excludes surfaces as the same empty object the
    // mock already returns when nothing is configured. Kysely itself would
    // throw `NoResultError`; the empty object keeps the failure inside the
    // assertions rather than turning it into control flow the code may catch.
    return rowMatches(row, predicates) ? shape(row) : {};
  };

  return chain;
}

/** The `createMockDb` options the update chain reads. */
interface UpdateChainOptions {
  updatedRow: unknown;
  updatedRows: unknown[];
  updateReturning: unknown;
  updateResult: { numUpdatedRows: bigint };
}

/**
 * Build the `updateTable().set().where()…` chain.
 *
 * Split out of `createMockDb` so the builder stays inside the function-length
 * cap; the returned handles are wired into the `mocks` bag unchanged.
 */
function buildUpdateChain(opts: UpdateChainOptions): Record<string, any> {
  const updateExecute = vi.fn().mockResolvedValue(opts.updateResult);
  const updateExecuteTakeFirst = vi.fn().mockResolvedValue(opts.updateResult);
  const updateExecuteTakeFirstOrThrow = vi
    .fn()
    .mockResolvedValue(opts.updatedRow ?? opts.updateResult);

  const updateReturningAll = vi.fn().mockReturnValue({
    executeTakeFirstOrThrow: updateExecuteTakeFirstOrThrow,
    executeTakeFirst: vi.fn().mockResolvedValue(opts.updatedRow),
    execute: vi.fn().mockResolvedValue(opts.updatedRows),
  });

  const updateReturningFn = vi.fn().mockReturnValue({
    executeTakeFirst: vi.fn().mockResolvedValue(opts.updateReturning),
    execute: vi
      .fn()
      .mockResolvedValue(opts.updateReturning === undefined ? [] : [opts.updateReturning]),
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

  return {
    updateTable,
    updateSet,
    updateTerminal,
    updateReturningAll,
    updateExecute,
    updateExecuteTakeFirst,
    updateExecuteTakeFirstOrThrow,
  };
}

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
    insertedRow = DEFAULT_INSERT_ROW,
    updatedRow = undefined,
    updatedRows = [],
    updateReturning = undefined,
    updateResult = { numUpdatedRows: 0n },
    deleteResult = { numDeletedRows: 0n },
    countResult = { count: 0 },
    insertResult = undefined,
  } = options;
  const insertReturning = resolveInsertReturning(options);

  // ── Select chain ─────────────────────────────────────────────
  // The shared spies below are the assertion surface AND the row source; each
  // `selectFrom(...)` builds its own chain over them (see `buildSelectChain`),
  // which is what lets one query's WHERE stay out of the next query's.
  const selectExecute = vi.fn().mockResolvedValue(selectRows);
  const selectExecuteTakeFirst = vi.fn().mockResolvedValue(selectFirstRow);
  const selectExecuteTakeFirstOrThrow = vi
    .fn()
    .mockResolvedValue(selectFirstRow ?? selectRows[0] ?? {});

  const selectChainSpies: SelectChainSpies = {
    selectAll: vi.fn(),
    select: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    forUpdate: vi.fn(),
    skipLocked: vi.fn(),
    execute: selectExecute,
    executeTakeFirst: selectExecuteTakeFirst,
    executeTakeFirstOrThrow: selectExecuteTakeFirstOrThrow,
  };
  const selectAll = selectChainSpies.selectAll;
  const select = selectChainSpies.select;

  // ── Count chain (fn.countAll) ────────────────────────────────
  // A `db.fn.countAll().as(alias)` argument is not a plain column name, so the
  // projection is left unmodelled and the aggregate row flows through the
  // ordinary `selectFirstRow` path.
  const countExecuteTakeFirst = vi.fn().mockResolvedValue(countResult);
  const countAs = vi.fn().mockReturnValue('count');
  const countAll = vi.fn().mockReturnValue({ as: countAs });

  const selectFrom = vi.fn().mockImplementation(() => buildSelectChain(selectChainSpies));

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
  // ONE shared doUpdateSet spy across both the column() and columns() shapes:
  // a fresh spy per call is unobservable, so nothing could assert what an
  // upsert writes on the conflict branch — which is the branch that runs
  // whenever the row already exists, i.e. almost always.
  const doUpdateSet = vi.fn();
  const conflictTerminal = {
    execute: vi.fn().mockResolvedValue(undefined),
    executeTakeFirst: insertExecuteTakeFirst,
    where: vi.fn(),
  } as Record<string, any>;
  conflictTerminal.where = vi.fn().mockReturnValue(conflictTerminal);
  doUpdateSet.mockReturnValue(conflictTerminal);

  const onConflict = vi.fn().mockImplementation((cb: Function) => {
    if (typeof cb === 'function') {
      cb({
        column: vi.fn().mockReturnValue({
          doUpdateSet,
          doNothing: vi.fn().mockReturnValue({
            returning: insertReturningFn,
            executeTakeFirstOrThrow: insertExecuteTakeFirstOrThrow,
          }),
        }),
        columns: vi.fn().mockReturnValue({
          doUpdateSet,
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
  const {
    updateTable,
    updateSet,
    updateTerminal,
    updateReturningAll,
    updateExecute,
    updateExecuteTakeFirst,
    updateExecuteTakeFirstOrThrow,
  } = buildUpdateChain({ updatedRow, updatedRows, updateReturning, updateResult });

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
    selectWhere: selectChainSpies.where,
    selectOrderBy: selectChainSpies.orderBy,
    selectLimit: selectChainSpies.limit,
    selectExecute,
    selectExecuteTakeFirst,
    selectExecuteTakeFirstOrThrow,
    selectForUpdate: selectChainSpies.forUpdate,
    selectSkipLocked: selectChainSpies.skipLocked,

    insertInto,
    insertValues,
    insertReturning: insertReturningFn,
    insertReturningAll,
    insertExecute,
    insertExecuteTakeFirstOrThrow,
    onConflict,
    doUpdateSet,

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
