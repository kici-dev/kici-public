import { describe, expect, it } from 'vitest';
import { createMockDb } from './mock-db.js';

/**
 * The harness guarantee, stated as a test.
 *
 * `createMockDb` used to return its configured rows verbatim, so a query that
 * dropped its tenant predicate looked identical to one that kept it. That case
 * is the one exercised below, deliberately: on the Platform every tenant query
 * carries an injected `org_id` predicate, and before this the mock could not
 * tell a correctly scoped query from one reading every tenant's rows.
 *
 * The orchestrator and the Platform own independent `createMockDb` builders that
 * owe the same guarantee, so this file is kept byte-identical between them and
 * `mock-db-mirror.test.ts` fails if it drifts.
 *
 * These tests pin the capability rather than any one caller: they run a scoped
 * query and its unscoped twin over the SAME fixture and assert the results
 * differ. If the mock ever stops applying `where`, both shapes return both rows
 * and these fail — which is exactly the regression that would silently weaken
 * every test built on this harness.
 */
const ROWS = [
  { id: 'a', org_id: 'org-1', name: 'mine', secret_column: 'do-not-project' },
  { id: 'b', org_id: 'org-2', name: 'theirs', secret_column: 'do-not-project' },
];

describe('createMockDb applies the query', () => {
  it('excludes another tenant’s row from an org-scoped select', async () => {
    const { db } = createMockDb({ selectRows: ROWS });

    const scoped = await db
      .selectFrom('runs')
      .selectAll()
      .where('runs.org_id', '=', 'org-1')
      .execute();

    expect(scoped).toEqual([ROWS[0]]);
  });

  it('returns BOTH rows when the org predicate is missing — the control', async () => {
    // The negative control. Without it, the assertion above could pass because
    // the mock returned an empty or truncated list for some unrelated reason.
    const { db } = createMockDb({ selectRows: ROWS });

    const unscoped = await db.selectFrom('runs').selectAll().execute();

    expect(unscoped).toEqual(ROWS);
  });

  it('keeps one query’s predicates out of the next query’s', async () => {
    const { db } = createMockDb({ selectRows: ROWS });

    await db.selectFrom('runs').selectAll().where('org_id', '=', 'org-1').execute();
    const second = await db.selectFrom('runs').selectAll().execute();

    expect(second).toEqual(ROWS);
  });

  it('narrows a row to the projected columns', async () => {
    const { db } = createMockDb({ selectRows: ROWS });

    const projected = await db
      .selectFrom('runs')
      .select(['runs.id as id', 'runs.name as name'])
      .where('org_id', '=', 'org-1')
      .execute();

    expect(projected).toEqual([{ id: 'a', name: 'mine' }]);
    expect(projected[0]).not.toHaveProperty('secret_column');
  });

  it('drops a configured executeTakeFirst row that the query excludes', async () => {
    const { db } = createMockDb({ selectFirstRow: ROWS[1] });

    const scoped = await db
      .selectFrom('runs')
      .selectAll()
      .where('org_id', '=', 'org-1')
      .executeTakeFirst();

    expect(scoped).toBeUndefined();
  });

  it('still records every clause on the shared spies', async () => {
    const { db, mocks } = createMockDb({ selectRows: ROWS });

    await db.selectFrom('runs').selectAll().where('org_id', '=', 'org-1').execute();

    expect(mocks.selectFrom).toHaveBeenCalledWith('runs');
    expect(mocks.selectWhere).toHaveBeenCalledWith('org_id', '=', 'org-1');
    expect(mocks.selectExecute).toHaveBeenCalled();
  });
});
