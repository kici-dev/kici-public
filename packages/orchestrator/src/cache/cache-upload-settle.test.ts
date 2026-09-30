import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  CacheUploadSettleOutcome,
  InFlightCacheUploads,
  awaitCacheUploadSettle,
  createCacheUploadSettleTimeoutReader,
} from './cache-upload-settle.js';

describe('InFlightCacheUploads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('begin registers a publish and settle removes it; settling twice is harmless', () => {
    const uploads = new InFlightCacheUploads();
    const settle = uploads.begin('job-1');
    expect(uploads.has('job-1')).toBe(true);
    settle();
    settle();
    expect(uploads.has('job-1')).toBe(false);
    expect(uploads.size).toBe(0);
  });

  it('waitFor returns None when nothing is in flight', async () => {
    expect(await new InFlightCacheUploads().waitFor('job-1', 1_000)).toBe(
      CacheUploadSettleOutcome.None,
    );
  });

  it('waitFor returns Disabled for a zero timeout and starts no timer', async () => {
    const uploads = new InFlightCacheUploads();
    uploads.begin('job-1');
    expect(await uploads.waitFor('job-1', 0)).toBe(CacheUploadSettleOutcome.Disabled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for every publish registered for the job', async () => {
    // fails-when: waitFor races the publishes instead of waiting for all of
    // them — it would settle on the deps publish while the source one runs.
    const uploads = new InFlightCacheUploads();
    const settleDeps = uploads.begin('job-1');
    const settleSource = uploads.begin('job-1');
    let outcome: CacheUploadSettleOutcome | undefined;
    const waiting = uploads.waitFor('job-1', 10_000).then((o) => {
      outcome = o;
    });
    settleDeps();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();
    settleSource();
    await waiting;
    // breaks-if-wrong: settling resolves the wait and clears its timer.
    expect(outcome).toBe(CacheUploadSettleOutcome.Settled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out at the bound and keeps the record until its publish settles', async () => {
    const uploads = new InFlightCacheUploads();
    const settle = uploads.begin('job-1');
    let outcome: CacheUploadSettleOutcome | undefined;
    const waiting = uploads.waitFor('job-1', 50).then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(outcome).toBe(CacheUploadSettleOutcome.TimedOut);
    expect(uploads.has('job-1')).toBe(true);
    settle();
    expect(uploads.has('job-1')).toBe(false);
  });
});

describe('awaitCacheUploadSettle', () => {
  it('returns None without a settle dependency', async () => {
    expect(await awaitCacheUploadSettle(undefined, { jobId: 'job-1', orgId: 'org-a' })).toEqual({
      outcome: CacheUploadSettleOutcome.None,
    });
  });

  it('does not read the setting when nothing is in flight', async () => {
    // fails-when: every job's success pays a settings read.
    const timeoutMsFor = vi.fn().mockResolvedValue(10_000);
    const result = await awaitCacheUploadSettle(
      { uploads: new InFlightCacheUploads(), timeoutMsFor },
      { jobId: 'job-1', orgId: 'org-a' },
    );
    expect(result.outcome).toBe(CacheUploadSettleOutcome.None);
    expect(timeoutMsFor).not.toHaveBeenCalled();
  });

  it('reads the timeout for the job org and waits for the publish', async () => {
    const uploads = new InFlightCacheUploads();
    const settle = uploads.begin('job-1');
    const timeoutMsFor = vi.fn().mockResolvedValue(10_000);
    setTimeout(settle, 20);
    const result = await awaitCacheUploadSettle(
      { uploads, timeoutMsFor },
      { jobId: 'job-1', orgId: 'org-a' },
    );
    expect(timeoutMsFor).toHaveBeenCalledWith('org-a');
    expect(result.outcome).toBe(CacheUploadSettleOutcome.Settled);
    expect(result.timeoutMs).toBe(10_000);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('createCacheUploadSettleTimeoutReader', () => {
  function fakeDb(result: { row?: Record<string, unknown>; error?: Error }) {
    const executeTakeFirst = vi.fn(async () => {
      if (result.error) throw result.error;
      return result.row;
    });
    const where = vi.fn(() => ({ executeTakeFirst }));
    const select = vi.fn(() => ({ where }));
    const selectFrom = vi.fn(() => ({ select }));
    return { db: { selectFrom } as unknown as Kysely<Database>, selectFrom, select, where };
  }

  it('returns the org override (pg BIGINT string → number)', async () => {
    // fails-when: the reader ignores the org row and returns the fallback.
    const { db, select, where } = fakeDb({ row: { cache_upload_settle_timeout_ms: '2500' } });
    expect(await createCacheUploadSettleTimeoutReader(db, 10_000)('org-a')).toBe(2500);
    expect(select).toHaveBeenCalledWith('cache_upload_settle_timeout_ms');
    expect(where).toHaveBeenCalledWith('customer_id', '=', 'org-a');
  });

  it('0 is a real override, not "unset"', async () => {
    const { db } = fakeDb({ row: { cache_upload_settle_timeout_ms: '0' } });
    expect(await createCacheUploadSettleTimeoutReader(db, 10_000)('org-a')).toBe(0);
  });

  it('falls back on a NULL column or a missing row', async () => {
    // fails-when: NULL is read as 0, which would switch the wait off for every
    // org that never set the knob.
    const nullColumn = fakeDb({ row: { cache_upload_settle_timeout_ms: null } });
    expect(await createCacheUploadSettleTimeoutReader(nullColumn.db, 10_000)('org-a')).toBe(10_000);
    const noRow = fakeDb({});
    expect(await createCacheUploadSettleTimeoutReader(noRow.db, 10_000)('org-a')).toBe(10_000);
  });

  it('falls back without a query when the job has no org or there is no DB', async () => {
    const { db, selectFrom } = fakeDb({ row: { cache_upload_settle_timeout_ms: '1' } });
    expect(await createCacheUploadSettleTimeoutReader(db, 10_000)(undefined)).toBe(10_000);
    expect(selectFrom).not.toHaveBeenCalled();
    expect(await createCacheUploadSettleTimeoutReader(undefined, 10_000)('org-a')).toBe(10_000);
  });

  it('falls back when the query fails', async () => {
    // breaks-if-wrong: a DB error must not reject into the frame handler.
    const { db } = fakeDb({ error: new Error('connection reset') });
    expect(await createCacheUploadSettleTimeoutReader(db, 10_000)('org-a')).toBe(10_000);
  });
});
