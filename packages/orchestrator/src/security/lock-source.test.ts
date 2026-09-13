/**
 * regression: an untrusted ref on a pull-request event must never have
 * its HEAD lock file evaluated by the orchestrator. Only
 * `tier === 'trusted'` (a ref that lives in the base repo, resolved
 * independently of the lock file by `resolveRefTrust`) qualifies for
 * HEAD-branch lock fetch; every other tier falls back to the base
 * branch's lock so the project's trusted maintainers control trigger
 * evaluation, environment claims, and contributor-controlled fields
 * downstream secret resolution depends on.
 *
 * Trust model (must hold):
 *   For a pull-request event from attacker model A7 (untrusted workflow
 *   contributor — a fork PR sender), the orchestrator's trigger
 *   evaluation runs against the base branch's lock file — NOT the
 *   contributor's HEAD branch lock. This bounds what an A7 attacker can
 *   claim about workflow triggers, jobs, `environment`, `env`, and
 *   `concurrencyGroup` fields, all of which feed downstream
 *   secret-resolution and protection-rule gates.
 *
 *   Removing this gate would let an A7 fork-PR sender publish a HEAD
 *   lock claiming `environment: 'prod'` and have the orchestrator
 *   resolve prod secrets at dispatch time before any human review.
 */
import { describe, it, expect } from 'vitest';
import type { TrustTier } from '@kici-dev/engine';
import { selectLockFileSource } from './lock-source.js';

describe('lock-file source selection — A7 untrusted contributor cannot inject HEAD lock', () => {
  it('returns "head" for non-PR events regardless of tier', () => {
    // Non-PR events (push, tag, schedule, etc.) come from someone with
    // direct write access to the repo; HEAD is correct.
    expect(selectLockFileSource(false, undefined)).toBe('head');
    expect(selectLockFileSource(false, 'unknown')).toBe('head');
    expect(selectLockFileSource(false, 'known')).toBe('head');
    expect(selectLockFileSource(false, 'trusted')).toBe('head');
  });

  it('returns "base" for a PR event when trust resolution has not yet run', () => {
    // An absent tier is the fail-closed input: any caller that reaches
    // lock-file selection without a resolved tier is gated against an
    // A7 attacker.
    expect(selectLockFileSource(true, undefined)).toBe('base');
  });

  it('returns "base" for a PR event from an unknown contributor (fork PR / drive-by)', () => {
    // Fork PRs always resolve to `unknown` per `resolveRefTrust`. Their
    // HEAD lock is attacker-controlled and must NOT be evaluated.
    expect(selectLockFileSource(true, 'unknown')).toBe('base');
  });

  it('returns "base" for a PR event carrying the legacy "known" tier', () => {
    // `known` is legacy vocabulary that nothing produces any more. A row
    // stored before the ref-based model must still read as untrusted.
    expect(selectLockFileSource(true, 'known')).toBe('base');
  });

  it('returns "head" only for a PR event on a trusted ref', () => {
    // `trusted` means the head ref lives in the base repo, which an A7
    // fork-PR sender cannot arrange. Only this tier earns HEAD-branch
    // lock fetch.
    expect(selectLockFileSource(true, 'trusted')).toBe('head');
  });

  it('treats every tier value exhaustively (compile-time invariant)', () => {
    // Documentation-as-code: enumerating every TrustTier value here
    // makes the compiler complain if a new tier is added without
    // explicitly considering its lock-file-source policy.
    const tiers: (TrustTier | undefined)[] = ['unknown', 'known', 'trusted', undefined];
    const results = tiers.map((t) => [t, selectLockFileSource(true, t)] as const);
    expect(results).toEqual([
      ['unknown', 'base'],
      ['known', 'base'],
      ['trusted', 'head'],
      [undefined, 'base'],
    ]);
  });
});
