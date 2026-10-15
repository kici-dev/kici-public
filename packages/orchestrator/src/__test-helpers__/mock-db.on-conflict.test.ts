import { describe, expect, it } from 'vitest';
import { createMockDb } from './mock-db.js';

type ConflictBuilder = {
  column: (c: string) => { doUpdateSet: (s: unknown) => unknown; doNothing: () => unknown };
  columns: (c: string[]) => { doUpdateSet: (s: unknown) => unknown; doNothing: () => unknown };
};

describe('createMockDb ON CONFLICT spies', () => {
  it.each([
    ['column', (oc: ConflictBuilder) => oc.column('id').doNothing()],
    ['columns', (oc: ConflictBuilder) => oc.columns(['a', 'b']).doNothing()],
  ])('records the DO NOTHING arm on the shared doNothing spy (%s)', async (_shape, cb) => {
    const { db, mocks } = createMockDb();

    await db.insertInto('t').values({ id: 1 }).onConflict(cb).execute();

    expect(mocks.doNothing).toHaveBeenCalledTimes(1);
    expect(mocks.doUpdateSet).not.toHaveBeenCalled();
    expect(mocks.onConflictExecute).toHaveBeenCalledTimes(1);
  });

  it('records the DO UPDATE arm without touching doNothing', async () => {
    const { db, mocks } = createMockDb();

    await db
      .insertInto('t')
      .values({ id: 1 })
      .onConflict((oc: ConflictBuilder) => oc.column('id').doUpdateSet({ v: 2 }))
      .execute();

    expect(mocks.doUpdateSet).toHaveBeenCalledWith({ v: 2 });
    expect(mocks.doNothing).not.toHaveBeenCalled();
    expect(mocks.onConflictExecute).toHaveBeenCalledTimes(1);
  });

  it('lets a test make the upsert terminal reject', async () => {
    const { db, mocks } = createMockDb();
    mocks.onConflictExecute.mockRejectedValueOnce(new Error('db down'));

    await expect(
      db
        .insertInto('t')
        .values({ id: 1 })
        .onConflict((oc: ConflictBuilder) => oc.column('id').doNothing())
        .execute(),
    ).rejects.toThrow('db down');
  });
});
