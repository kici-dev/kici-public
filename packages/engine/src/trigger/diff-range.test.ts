import { describe, it, expect } from 'vitest';
import {
  diffRangeKindSchema,
  isDeferrableRange,
  resolveDiffRange,
  type DiffRange,
} from './diff-range.js';

const Kind = diffRangeKindSchema.enum;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

function push(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'push', targetBranch: 'feature', payload, ...extra };
}

describe('resolveDiffRange', () => {
  it('two real SHAs → two-dot', () => {
    expect(resolveDiffRange(push({ before: SHA_A, after: SHA_B }))).toEqual({
      kind: Kind['two-dot'],
      base: SHA_A,
      head: SHA_B,
    });
  });

  it('zero before + default branch that is not the pushed branch → new-branch', () => {
    const r = resolveDiffRange(push({ before: ZERO, after: SHA_B }, { defaultBranch: 'main' }));
    expect(r).toEqual({ kind: Kind['new-branch'], defaultBranch: 'main', head: SHA_B });
  });

  it('new-branch falls back to payload.repository.default_branch', () => {
    const r = resolveDiffRange(
      push({ before: ZERO, after: SHA_B, repository: { default_branch: 'main' } }),
    );
    expect(r.kind).toBe(Kind['new-branch']);
  });

  it('zero before + default branch equal to the pushed branch → none', () => {
    const r = resolveDiffRange(
      push({ before: ZERO, after: SHA_B }, { defaultBranch: 'feature', targetBranch: 'feature' }),
    );
    expect(r.kind).toBe(Kind.none);
  });

  it('zero before + no known default branch → none', () => {
    expect(resolveDiffRange(push({ before: ZERO, after: SHA_B })).kind).toBe(Kind.none);
  });

  it('zero after → deleted', () => {
    expect(resolveDiffRange(push({ before: SHA_A, after: ZERO })).kind).toBe(Kind.deleted);
  });

  it('missing before or after → none (a range-less push has no diff anywhere)', () => {
    expect(resolveDiffRange(push({ after: SHA_B })).kind).toBe(Kind.none);
    expect(resolveDiffRange(push({ before: SHA_A })).kind).toBe(Kind.none);
    expect(resolveDiffRange(push({})).kind).toBe(Kind.none);
  });

  it('pull_request with a base branch → pr', () => {
    const r = resolveDiffRange({ type: 'pull_request', baseBranch: 'main', payload: {} });
    expect(r).toEqual({ kind: Kind.pr, base: 'main' });
  });

  it('pull_request falls back to targetBranch, and with neither → none', () => {
    expect(resolveDiffRange({ type: 'pull_request', targetBranch: 'dev', payload: {} })).toEqual({
      kind: Kind.pr,
      base: 'dev',
    });
    expect(resolveDiffRange({ type: 'pull_request', payload: {} }).kind).toBe(Kind.none);
  });

  it('any other event → none', () => {
    for (const type of ['tag', 'schedule', 'generic_webhook', 'comment']) {
      expect(resolveDiffRange({ type, payload: { before: SHA_A, after: SHA_B } }).kind).toBe(
        Kind.none,
      );
    }
  });
});

describe('isDeferrableRange', () => {
  it('is true exactly for two-dot, new-branch and pr', () => {
    const cases: [DiffRange, boolean][] = [
      [{ kind: Kind['two-dot'], base: SHA_A, head: SHA_B }, true],
      [{ kind: Kind['new-branch'], defaultBranch: 'main', head: SHA_B }, true],
      [{ kind: Kind.pr, base: 'main' }, true],
      [{ kind: Kind.deleted }, false],
      [{ kind: Kind.none }, false],
    ];
    for (const [range, expected] of cases) expect(isDeferrableRange(range)).toBe(expected);
  });
});
