import { z } from 'zod';

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

const regexCache = new Map<string, RegExp>();

/** Compile (and cache) the `RegExp` for a regex matcher. */
export function compileRegexMatcher(m: { source: string; flags: string }): RegExp {
  const key = `${m.flags} ${m.source}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(m.source, m.flags);
    regexCache.set(key, re);
  }
  return re;
}

/** Whether a single label string satisfies the matcher. */
export function matcherMatches(m: LabelMatcher, label: string): boolean {
  return m.kind === 'exact' ? label === m.value : compileRegexMatcher(m).test(label);
}

/** Whether some label in the set satisfies the matcher. */
export function matcherSatisfiedBy(m: LabelMatcher, labels: ReadonlySet<string>): boolean {
  if (m.kind === 'exact') return labels.has(m.value);
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
  labels: ReadonlySet<string>,
  target: HostTargetSelector,
): boolean {
  return target.values.every(
    (v) =>
      v.include.every((m) => matcherSatisfiedBy(m, labels)) &&
      !v.exclude.some((m) => matcherSatisfiedBy(m, labels)),
  );
}

/** Split a matcher list into exact label strings and the remaining regex matchers. */
export function partitionMatchers(ms: readonly LabelMatcher[]): {
  exact: string[];
  regex: LabelMatcher[];
} {
  const exact: string[] = [];
  const regex: LabelMatcher[] = [];
  for (const m of ms) {
    if (m.kind === 'exact') {
      exact.push(m.value);
    } else if (m.kind === 'regex') {
      regex.push(m);
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
