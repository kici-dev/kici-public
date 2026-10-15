/**
 * LRU for completed Tier-2 global eval round results.
 *
 * **This cache only helps webhook redelivery and same-input re-deliveries.** Its
 * key pins the source commit and a digest of the whole round input, and every
 * real push carries a new source SHA, so two pushes get two rounds by design. It
 * is a duplicate-delivery guard, not a steady-state optimization: sizing it up
 * buys nothing, and a hit rate near zero on a healthy cluster is expected.
 *
 * Deliberately no TTL: a round verdict is a pure function of its inputs, and
 * {@link globalEvalRoundCacheKey} covers all of them, so an entry cannot go stale
 * within its key — the content-addressable argument of the lock-file and content
 * caches, without their branch-name escape hatch.
 */

import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { GlobalEvalRoundResult } from '@kici-dev/engine';

/**
 * NUL joins the key parts so no identifier containing the separator can forge a
 * neighbouring key. Written as an escape, never a raw byte: a literal control
 * character makes the whole file opaque to `grep -I` and `file(1)`.
 */
const KEY_SEPARATOR = '\u0000';

/**
 * Key one round over **every input its verdict depends on**.
 *
 * The SHAs alone would give wrong answers, not just missed hits.
 * `createFilterContext` and `buildGeneratorContext` both receive the whole event,
 * so a filter can branch on `event.type`, `targetBranch`, `changedFiles`, or
 * anything in the raw payload. A push to `main` at commit X and a pull-request
 * synchronize whose head is X share every SHA yet deserve different verdicts
 * (different events, changed files computed over different ranges); two branches
 * at one commit collide the same way. `workflowRoutingKey` is in the key for the
 * reason `groupCandidates` keeps it in the group key: it selects the provider
 * bundle that mints the clone credentials.
 *
 * `sourceRepoIdentifier` sits next to `sourceSha`. The event digest covers it
 * too, but keying it explicitly makes that structural: an event shape that
 * stopped carrying the source repo could otherwise collide two repos' rounds.
 *
 * The candidate list and the event enter as a SHA-256 digest of their JSON, so
 * the key stays bounded. The same code rebuilds both from the same delivery, so a
 * genuine redelivery reproduces the digest; anything else is a miss, which costs
 * a round rather than a wrong verdict.
 *
 * Returns `null` when the inputs cannot be serialized: a round is never keyed on
 * a partial input, which is how a cache starts answering questions it was not
 * asked.
 */
export function globalEvalRoundCacheKey(args: {
  workflowRepoIdentifier: string;
  workflowSha: string;
  workflowRoutingKey: string;
  sourceRepoIdentifier: string;
  sourceSha: string;
  /** The exact per-candidate payload the round job carries. */
  candidates: unknown;
  /** The exact event the round job carries. */
  event: unknown;
}): string | null {
  let digest: string;
  try {
    const json = JSON.stringify({ candidates: args.candidates, event: args.event });
    if (typeof json !== 'string') return null;
    digest = createHash('sha256').update(json).digest('hex');
  } catch {
    return null;
  }
  return [
    args.workflowRepoIdentifier,
    args.workflowSha,
    args.workflowRoutingKey,
    args.sourceRepoIdentifier,
    args.sourceSha,
    digest,
  ].join(KEY_SEPARATOR);
}

/**
 * A round that left ANY candidate undecided is not a result worth replaying.
 *
 * An agent-side budget breach reports `success` with the affected candidates
 * marked indeterminate — the whole round on a round-budget breach, one workflow
 * on a candidate-budget breach. Caching either turns one slow round into a
 * permanently replayed failure for the key: a webhook redelivery (exactly when an
 * operator retries) would be served the stored failure, and the round's own retry
 * sits behind this cache read, so it short-circuits too.
 *
 * Requiring EVERY candidate decided costs almost no hit rate (indeterminate is the
 * exceptional path) and guarantees nothing a redelivery replays was undecided.
 *
 * An empty candidate list is not cacheable either: for a non-empty group every
 * candidate is about to be recorded as "no verdict", the same failure by another
 * route.
 */
export function isCacheableRoundResult(result: GlobalEvalRoundResult): boolean {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  return candidates.length > 0 && candidates.every((c) => c?.indeterminate !== true);
}

export class GlobalEvalRoundCache {
  private readonly cache: LRUCache<string, GlobalEvalRoundResult>;
  private hits = 0;
  private misses = 0;

  constructor(options: { max: number }) {
    this.cache = new LRUCache<string, GlobalEvalRoundResult>({ max: options.max });
  }

  get(key: string): GlobalEvalRoundResult | undefined {
    const hit = this.cache.get(key);
    if (hit === undefined) this.misses++;
    else this.hits++;
    return hit;
  }

  set(key: string, value: GlobalEvalRoundResult): void {
    this.cache.set(key, value);
  }

  /** For metrics and debugging. */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}
