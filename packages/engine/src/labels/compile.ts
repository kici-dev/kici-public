import picomatch from 'picomatch';
import safeRegex from 'safe-regex';
import type { LabelMatcher } from '../labels-match.js';

/**
 * Reject a ReDoS-prone regex. `safe-regex` is a star-height heuristic — the
 * orchestrator is single-tenant, so a slipped-through pattern only stalls the
 * author's own orchestrator. Globs are linear by construction but pass through
 * here for uniformity.
 */
export function assertSafeRegex(source: string, flags: string, ctx: string): void {
  if (!safeRegex(new RegExp(source, flags))) {
    throw new Error(`${ctx}: regex /${source}/${flags} is ReDoS-prone — rejected`);
  }
}

/**
 * Convert one author selector element into a `LabelMatcher`.
 * - `RegExp` → regex matcher (source + flags captured verbatim).
 * - string that picomatch detects as a glob → regex via `picomatch.makeRe`.
 * - any other string → exact.
 * `ctx` is a human label (e.g. "job 'web' runsOn") used in ReDoS errors.
 */
export function toLabelMatcher(el: string | RegExp, ctx: string): LabelMatcher {
  if (el instanceof RegExp) {
    assertSafeRegex(el.source, el.flags, ctx);
    return { kind: 'regex', source: el.source, flags: el.flags };
  }
  if (picomatch.scan(el).isGlob) {
    const re = picomatch.makeRe(el);
    if (!(re instanceof RegExp)) {
      throw new Error(`${ctx}: glob '${el}' is not a valid pattern`);
    }
    assertSafeRegex(re.source, re.flags, ctx);
    return { kind: 'regex', source: re.source, flags: re.flags };
  }
  return { kind: 'exact', value: el };
}

export type SelectorEl = string | RegExp;
/** Single-agent selection policy when multiple agents match a `runsOn` selector. */
export type RunsOnPickInput = 'deterministic' | 'any';
export type RunsOnAuthorInput =
  | SelectorEl
  | readonly SelectorEl[]
  | {
      labels: SelectorEl | readonly SelectorEl[];
      exclude?: SelectorEl | readonly SelectorEl[];
      pick?: RunsOnPickInput;
    };
export type RunsOnAllAuthorInput =
  | string
  | RegExp
  | readonly SelectorEl[]
  | { include: readonly { all: readonly SelectorEl[] }[]; exclude?: readonly SelectorEl[] };

const asArray = <T>(v: T | readonly T[]): readonly T[] => (Array.isArray(v) ? v : [v as T]);

/** Normalize a `runsOn` author value into include + exclude matchers. */
export function normalizeRunsOnToMatchers(
  runsOn: RunsOnAuthorInput,
  ctx: string,
): { include: LabelMatcher[]; exclude: LabelMatcher[] } {
  if (typeof runsOn === 'string' || runsOn instanceof RegExp) {
    return { include: [toLabelMatcher(runsOn, ctx)], exclude: [] };
  }
  if (Array.isArray(runsOn)) {
    return { include: runsOn.map((e) => toLabelMatcher(e, ctx)), exclude: [] };
  }
  const sel = runsOn as {
    labels: SelectorEl | readonly SelectorEl[];
    exclude?: SelectorEl | readonly SelectorEl[];
  };
  const include = asArray(sel.labels).map((e) => toLabelMatcher(e, ctx));
  const exclude = sel.exclude ? asArray(sel.exclude).map((e) => toLabelMatcher(e, ctx)) : [];
  return { include, exclude };
}

/**
 * Resolve a `runsOn` author value's single-agent selection policy, defaulting to
 * `'deterministic'` for every form (string / array shorthand inherit the default
 * after normalization; the selector object's explicit `pick` wins).
 */
export function runsOnPickFromInput(runsOn: RunsOnAuthorInput): RunsOnPickInput {
  if (typeof runsOn === 'string' || runsOn instanceof RegExp || Array.isArray(runsOn)) {
    return 'deterministic';
  }
  return (runsOn as { pick?: RunsOnPickInput }).pick ?? 'deterministic';
}

/** Normalize a `runsOnAll` author value into include groups + exclude matchers. */
export function normalizeRunsOnAllToMatchers(
  input: RunsOnAllAuthorInput,
  ctx: string,
): { include: LabelMatcher[][]; exclude: LabelMatcher[] } {
  if (typeof input === 'string' || input instanceof RegExp) {
    return { include: [[toLabelMatcher(input, ctx)]], exclude: [] };
  }
  if (Array.isArray(input)) {
    const include: LabelMatcher[] = [];
    const exclude: LabelMatcher[] = [];
    for (const entry of input as readonly SelectorEl[]) {
      // Strip the `!` exclude prefix before glob detection so `!box-*` is an
      // exclude-glob and `!foo` an exclude-exact. RegExp entries are include-only.
      if (typeof entry === 'string' && entry.startsWith('!')) {
        exclude.push(toLabelMatcher(entry.slice(1), ctx));
      } else {
        include.push(toLabelMatcher(entry, ctx));
      }
    }
    return { include: include.length ? [include] : [], exclude };
  }
  const obj = input as {
    include: readonly { all: readonly SelectorEl[] }[];
    exclude?: readonly SelectorEl[];
  };
  return {
    include: obj.include.map((g) => g.all.map((e) => toLabelMatcher(e, ctx))),
    exclude: (obj.exclude ?? []).map((e) => toLabelMatcher(e, ctx)),
  };
}

/** Re-validate every regex matcher in a parsed lock selector (orchestrator lock-load). */
export function assertMatchersSafe(matchers: readonly LabelMatcher[], ctx: string): void {
  for (const m of matchers) {
    if (m.kind === 'regex') assertSafeRegex(m.source, m.flags, ctx);
  }
}
