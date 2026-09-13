import { z } from 'zod';
import { type CanonicalLabel, canonicalizeLabel } from './labels-canonical.js';
import { stripStatefulRegexFlags } from './regex-flags.js';

/**
 * A single label selector element after compilation. Globs are converted to
 * regex at compile time, so the lock file only ever carries `exact` or `regex`.
 * This module is browser-safe (pure `RegExp`, zod only) and lives in the engine
 * barrel; glob conversion and the ReDoS gate live in the Node-only
 * `@kici-dev/engine/labels/compile` subpath.
 */
export const LabelMatcher = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string() }),
  z.object({ kind: z.literal('regex'), source: z.string(), flags: z.string() }),
]);
export type LabelMatcher = z.infer<typeof LabelMatcher>;

/**
 * A {@link LabelMatcher} that has been through {@link canonicalizeMatcher}: an
 * `exact` value folded to canonical form, a `regex` compiled case-insensitively.
 *
 * Branded for the same reason `CanonicalLabel` is — so a matcher read straight
 * off a lock file cannot be compared against a canonical label set by accident.
 */
declare const CANONICAL_MATCHER: unique symbol;
export type CanonicalMatcher = LabelMatcher & { readonly [CANONICAL_MATCHER]: true };

const regexCache = new Map<string, RegExp>();

/**
 * Compile (and cache) the `RegExp` for a regex matcher.
 *
 * `g` and `y` are stripped before compiling and before building the memo key.
 * They are worse than useless here: `matcherSatisfiedBy` below loops `.test()`
 * over a label *set*, so one successful match would leave `lastIndex` pointing
 * into the middle of the next label. Stripping at the reader also tolerates a
 * lock file written by a compiler that predates the producer-side strip.
 */
export function compileRegexMatcher(m: { source: string; flags: string }): RegExp {
  const flags = stripStatefulRegexFlags(m.flags);
  const key = `${flags} ${m.source}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(m.source, flags);
    regexCache.set(key, re);
  }
  return re;
}

/** Whether a single label string satisfies the matcher. */
export function matcherMatches(m: LabelMatcher, label: string): boolean {
  return m.kind === 'exact' ? label === m.value : compileRegexMatcher(m).test(label);
}

/**
 * Fold a matcher into the canonical matching domain.
 *
 * `exact` values lowercase directly. A regex source CANNOT be lowercased
 * without corrupting the pattern (character classes, escapes, anchors), so the
 * `i` flag carries the fold instead. This is the ONLY place `i` is added:
 * `compileRegexMatcher` must stay flag-faithful because `matchHostPattern`
 * uses it to match agent IDs, which are not labels.
 */
export function canonicalizeMatcher(m: LabelMatcher): CanonicalMatcher {
  let folded: LabelMatcher;
  if (m.kind === 'exact') {
    folded = { kind: 'exact', value: canonicalizeLabel(m.value) };
  } else {
    const flags = stripStatefulRegexFlags(m.flags);
    folded = { kind: 'regex', source: m.source, flags: flags.includes('i') ? flags : `${flags}i` };
  }
  return folded as CanonicalMatcher;
}

/** Whether some label in the canonical set satisfies the canonical matcher. */
export function matcherSatisfiedBy(
  m: CanonicalMatcher,
  labels: ReadonlySet<CanonicalLabel>,
): boolean {
  if (m.kind === 'exact') return labels.has(m.value as CanonicalLabel);
  const re = compileRegexMatcher(m);
  for (const label of labels) if (re.test(label)) return true;
  return false;
}

export const HostTargetValue = z.object({
  include: z.array(LabelMatcher),
  exclude: z.array(LabelMatcher),
});
export type HostTargetValue = z.infer<typeof HostTargetValue>;

/**
 * A runtime host narrowing (`kici run --target`): each repeated value is an AND
 * set; values AND-combine. Narrow-only — applied as a post-filter over the
 * runsOnAll-matched roster. `allowEmpty` selects the zero-host outcome: skip
 * (true) vs fail (false).
 */
export const HostTargetSelector = z.object({
  values: z.array(HostTargetValue).min(1),
  allowEmpty: z.boolean(),
});
export type HostTargetSelector = z.infer<typeof HostTargetSelector>;

/**
 * True iff the host's labels satisfy EVERY target value: all of a value's
 * include matchers match and none of its exclude matchers match.
 */
export function hostSatisfiesTarget(
  labels: ReadonlySet<CanonicalLabel>,
  target: HostTargetSelector,
): boolean {
  return target.values.every(
    (v) =>
      v.include.every((m) => matcherSatisfiedBy(canonicalizeMatcher(m), labels)) &&
      !v.exclude.some((m) => matcherSatisfiedBy(canonicalizeMatcher(m), labels)),
  );
}

/** Split a matcher list into canonical exact labels and canonical regex matchers. */
export function partitionMatchers(ms: readonly LabelMatcher[]): {
  exact: CanonicalLabel[];
  regex: CanonicalMatcher[];
} {
  const exact: CanonicalLabel[] = [];
  const regex: CanonicalMatcher[] = [];
  for (const m of ms) {
    if (m.kind === 'exact') {
      exact.push(canonicalizeLabel(m.value));
    } else if (m.kind === 'regex') {
      regex.push(canonicalizeMatcher(m));
    } else {
      // A plain string (e.g. a pre-v20 lock's string-array runsOn) has no
      // `kind`. Never silently treat it as "match-any" — fail loudly so a
      // stale lock cannot mis-route jobs to an arbitrary scaler.
      throw new Error(
        `partitionMatchers: invalid label matcher ${JSON.stringify(m)} — expected ` +
          `{ kind: 'exact', value } or { kind: 'regex', source, flags }. The lock ` +
          `file is likely stale or compiled by an older engine — recompile with \`kici compile\`.`,
      );
    }
  }
  return { exact, regex };
}
