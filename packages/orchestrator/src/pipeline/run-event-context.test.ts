/**
 * Tests for the run event-context resolver.
 *
 * The load-bearing case is `isFork` on a NON-PR event. Leaving it unresolved
 * would make every `is_fork = 'false'` cloud trust policy reject legitimate
 * pushes, and the customer's fix — accepting `'unresolved'` too — re-opens the
 * hole the claim exists to close.
 */
import { describe, expect, it } from 'vitest';
import { resolveRunEventContext } from './run-event-context.js';

describe('resolveRunEventContext', () => {
  it('resolves a fork pull request', () => {
    expect(
      resolveRunEventContext({
        type: 'pull_request',
        sourceBranch: 'patch-1',
        headRepo: 'attacker/app',
        isForkPR: true,
      }),
    ).toEqual({ headRef: 'patch-1', headRepository: 'attacker/app', isFork: true });
  });

  it('resolves a same-repo pull request', () => {
    expect(
      resolveRunEventContext({
        type: 'pull_request',
        sourceBranch: 'feature',
        headRepo: 'acme/app',
        isForkPR: false,
      }),
    ).toEqual({ headRef: 'feature', headRepository: 'acme/app', isFork: false });
  });

  it('resolves a non-PR event to isFork false, not unresolved', () => {
    for (const type of ['push', 'tag', 'schedule', 'workflow_run', 'release']) {
      expect(resolveRunEventContext({ type }).isFork, type).toBe(false);
    }
  });

  it('leaves isFork NULL only when a PR payload resolved no answer', () => {
    // A PR whose payload carried no head or base repository: the fork question
    // genuinely has no answer, so it must not be guessed in either direction.
    expect(resolveRunEventContext({ type: 'pull_request', sourceBranch: 'x' })).toEqual({
      headRef: 'x',
      headRepository: null,
      isFork: null,
    });
  });

  it('ignores an isForkPR the normalizer could not actually resolve', () => {
    // The shape a normalizer really emits for a deleted fork or a trimmed
    // payload: `isForkPR` is `head !== base`, which collapses to `false` when
    // there is no head repository to compare. Reading the flag alone would
    // publish `is_fork = 'false'` for a pull request nobody resolved.
    expect(
      resolveRunEventContext({ type: 'pull_request', sourceBranch: 'patch-1', isForkPR: false }),
    ).toEqual({ headRef: 'patch-1', headRepository: null, isFork: null });
  });

  it('covers the review events, which also carry a contributor-controlled head', () => {
    for (const type of ['review', 'review_comment']) {
      expect(
        resolveRunEventContext({ type, headRepo: 'attacker/app', isForkPR: true }).isFork,
        type,
      ).toBe(true);
    }
  });

  it('never falls back to the base repository for headRepository', () => {
    expect(resolveRunEventContext({ type: 'push' }).headRepository).toBeNull();
  });
});
