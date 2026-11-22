import { describe, it, expect } from 'vitest';
import {
  describeHistoryGap,
  lockCheckoutFields,
  type LockCheckoutOptions,
  type OverlayGitRecord,
  overlayGitRecordSchema,
  parseLockCheckoutOptions,
} from './checkout.js';

describe('lockCheckoutFields', () => {
  it('emits nothing when checkout is unset', () =>
    expect(lockCheckoutFields(undefined)).toEqual({}));

  it('keeps a boolean exactly as today', () => {
    expect(lockCheckoutFields(false)).toEqual({ checkout: false });
    expect(lockCheckoutFields(true)).toEqual({ checkout: true });
  });

  it('puts the object form in checkoutOptions and never in checkout', () => {
    // fails-when: the object lands in the boolean `checkout` key an older agent reads with `=== false`
    expect(lockCheckoutFields({ fetchDepth: 0, fetchTags: true })).toEqual({
      checkoutOptions: { fetchDepth: 0, fetchTags: true },
    });
    expect(lockCheckoutFields({ fetchDepth: 20 })).toEqual({ checkoutOptions: { fetchDepth: 20 } });
  });

  it('emits nothing for an empty object (same as checkout: true omitted)', () =>
    expect(lockCheckoutFields({})).toEqual({}));
});

describe('parseLockCheckoutOptions', () => {
  it('accepts a valid shape', () =>
    expect(parseLockCheckoutOptions({ fetchDepth: 3, fetchTags: false })).toEqual({
      fetchDepth: 3,
      fetchTags: false,
    }));

  it.each([[{ fetchDepth: -1 }], [{ fetchDepth: 1.5 }], [{ fetchTags: 'yes' }], ['x'], [null]])(
    'returns undefined for %j',
    (v) => expect(parseLockCheckoutOptions(v)).toBeUndefined(),
  );

  it('strips an unknown key and keeps the known ones', () => {
    // fails-when: the schema is strict again and a future key voids fetchDepth
    expect(parseLockCheckoutOptions({ fetchDepth: 0, futureKey: 1 })).toEqual({ fetchDepth: 0 });
    // breaks-if-wrong: an invalid known value must still void the options
    expect(parseLockCheckoutOptions({ fetchDepth: -1, futureKey: 1 })).toBeUndefined();
  });

  it('returns undefined when absent', () =>
    expect(parseLockCheckoutOptions(undefined)).toBeUndefined());
});

describe('overlayGitRecordSchema', () => {
  it('accepts { fetchDepth: 1, allTags: false } and rejects a negative depth', () => {
    expect(overlayGitRecordSchema.safeParse({ fetchDepth: 1, allTags: false }).success).toBe(true);
    expect(overlayGitRecordSchema.safeParse({ fetchDepth: -1, allTags: false }).success).toBe(
      false,
    );
  });
});

const W = '[kici] This job asks for more history than this run shipped';

describe('describeHistoryGap', () => {
  it('fires when the job wants full history and the run shipped depth 1', () =>
    // The tags fetchDepth 0 implies are left out: --git-depth 0 ships every tag.
    expect(describeHistoryGap({ fetchDepth: 0 }, { fetchDepth: 1, allTags: false })).toBe(
      `${W} (fetchDepth 0 requested, depth 1 shipped). Re-run kici run remote with --git-depth 0.`,
    ));

  it('fires for a deeper finite request', () =>
    expect(describeHistoryGap({ fetchDepth: 20 }, { fetchDepth: 5, allTags: false })).toBe(
      `${W} (fetchDepth 20 requested, depth 5 shipped). Re-run kici run remote with --git-depth 20.`,
    ));

  it('fires for tags', () =>
    expect(describeHistoryGap({ fetchTags: true }, { fetchDepth: 1, allTags: false })).toBe(
      `${W} (all tags requested, not shipped). Re-run kici run remote with --git-tags.`,
    ));

  it('joins both gaps in one line', () =>
    // fails-when: a request short on depth and on tags names only one of its gaps
    expect(
      describeHistoryGap({ fetchDepth: 0, fetchTags: true }, { fetchDepth: 1, allTags: false }),
    ).toBe(
      `${W} (fetchDepth 0 requested, depth 1 shipped; all tags requested, not shipped). ` +
        'Re-run kici run remote with --git-depth 0 --git-tags.',
    ));

  it('treats fetchDepth 0 as a request for every tag unless fetchTags is false', () => {
    expect(describeHistoryGap({ fetchDepth: 0 }, { fetchDepth: 0, allTags: false })).toBe(
      `${W} (all tags requested, not shipped). Re-run kici run remote with --git-tags.`,
    );
    // breaks-if-wrong: fetchTags false opts a full-history job out of the tags gap
    expect(
      describeHistoryGap({ fetchDepth: 0, fetchTags: false }, { fetchDepth: 0, allTags: false }),
    ).toBeNull();
  });

  it.each<[LockCheckoutOptions | undefined, OverlayGitRecord]>([
    [{ fetchDepth: 1 }, { fetchDepth: 1, allTags: false }],
    [{ fetchDepth: 0 }, { fetchDepth: 0, allTags: true }],
    [{ fetchDepth: 3 }, { fetchDepth: 0, allTags: true }],
    [{ fetchTags: true }, { fetchDepth: 0, allTags: true }],
    [undefined, { fetchDepth: 1, allTags: false }],
  ])('stays silent when %j is satisfied by %j', (req, shipped) =>
    expect(describeHistoryGap(req, shipped)).toBeNull(),
  );

  it('stays silent with no shipped record (a CLI that ships the raw .git)', () =>
    expect(describeHistoryGap({ fetchDepth: 0 }, undefined)).toBeNull());
});
