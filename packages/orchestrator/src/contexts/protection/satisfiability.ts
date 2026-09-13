/**
 * Registration-time satisfiability check for multi-context job bindings.
 *
 * When a job binds several contexts (`contexts: [...]`), every
 * context's protection gates must pass for the job to ever dispatch
 * (all-must-pass aggregation — see `aggregate.ts`). Some of those gates are
 * decidable statically: if two bound contexts restrict to disjoint fixed
 * branch sets, no run can ever satisfy both, so the binding is provably
 * unsatisfiable and should be rejected at registration rather than failing
 * silently at every future dispatch.
 *
 * This module intersects the statically-decidable set rules (branch, trigger
 * type, repository — only when every pattern is a literal, never a glob) plus
 * the `enabled` gate across the **resolved** bound contexts, and reports the
 * first provably-empty intersection. Bound names that resolve to no context
 * record are lenient — skipped, never rejected — matching the dispatch-time
 * behavior in `dispatch-matched-workflow.ts`. Any glob in a rule makes that rule
 * undecidable, so it is skipped here and left to the dispatch-time catch-all
 * (`evaluateMultiContextGates`).
 */
import { z } from 'zod';
import type { Context } from '@kici-dev/engine';

/** Which decidable rule made a binding unsatisfiable. */
export const UnsatisfiableRule = z.enum(['enabled', 'branch', 'trigger', 'repo']);
export type UnsatisfiableRule = z.infer<typeof UnsatisfiableRule>;

/** A provably-unsatisfiable multi-context binding, naming the rule + reason. */
export interface UnsatisfiableBinding {
  jobName: string;
  contexts: string[];
  rule: UnsatisfiableRule;
  message: string;
}

/** A glob metacharacter makes a branch/trigger/repo pattern undecidable here. */
function isFixedPattern(pattern: string): boolean {
  return !/[*?[\]{}!()@+|]/.test(pattern);
}

/**
 * Intersect the per-context allow-lists for one set rule. Returns:
 *  - `'ok'` when no context constrains the rule, or the intersection is
 *    non-empty;
 *  - `'undecidable'` when any constraining context uses a glob pattern;
 *  - `'empty'` when every constraining list is fixed and their intersection is
 *    empty (provably unsatisfiable).
 */
function intersectFixedRule(
  lists: ReadonlyArray<readonly string[]>,
): 'ok' | 'undecidable' | 'empty' {
  const constraining = lists.filter((l) => l.length > 0);
  if (constraining.length < 2) return 'ok';
  if (constraining.some((l) => l.some((p) => !isFixedPattern(p)))) return 'undecidable';
  let intersection = new Set(constraining[0]);
  for (const list of constraining.slice(1)) {
    const next = new Set(list);
    intersection = new Set([...intersection].filter((v) => next.has(v)));
    if (intersection.size === 0) return 'empty';
  }
  return intersection.size === 0 ? 'empty' : 'ok';
}

/**
 * Returns a precise problem when the bound contexts can NEVER be jointly
 * satisfied (a disabled context, or mutually-exclusive fixed restrictions
 * among the resolved contexts), else `null`. Missing (unresolved) names are
 * skipped — a bound name with no context record contributes no protection
 * rules and is lenient at dispatch, so it is not rejected here. Glob /
 * undecidable cases also return `null` and are caught at dispatch by
 * `evaluateMultiContextGates`.
 *
 * `envs[i]` is the resolved `Context` for `envNames[i]` (undefined when the
 * name has no context record). Only the statically-known (non-dynamic) bound
 * names should be passed — dynamic elements are unknown at registration and the
 * all-must-pass semantics make the static subset's exclusivity still sound.
 */
export function checkBindingSatisfiable(
  jobName: string,
  envs: ReadonlyArray<Context | undefined>,
  envNames: readonly string[],
): UnsatisfiableBinding | null {
  // Lenient missing-context handling — matches dispatch
  // (dispatch-matched-workflow.ts): a bound name with no configured record
  // contributes no protection rules and is skipped, NOT rejected. Only the
  // contexts that actually resolve participate in the satisfiability check.
  const present = envs.filter((e): e is Context => !!e);
  if (present.length === 0) return null;

  // Enabled: a disabled present context is a dispatch-time hard reject
  // (aggregate.ts evaluateMultiContextGates → env_disabled), so a binding that
  // includes one can never pass.
  const disabled = present.find((e) => !e.enabled);
  if (disabled) {
    return {
      jobName,
      contexts: [...envNames],
      rule: UnsatisfiableRule.enum.enabled,
      message: `job '${jobName}' binds disabled context '${disabled.name}'`,
    };
  }

  const rules: Array<{ rule: UnsatisfiableRule; lists: string[][]; label: string }> = [
    {
      rule: UnsatisfiableRule.enum.branch,
      lists: present.map((e) => e.branchRestrictions),
      label: 'branch restrictions',
    },
    {
      rule: UnsatisfiableRule.enum.trigger,
      lists: present.map((e) => e.triggerTypeFilters),
      label: 'trigger type filters',
    },
    {
      rule: UnsatisfiableRule.enum.repo,
      lists: present.map((e) => e.repoPatterns),
      label: 'repository patterns',
    },
  ];
  for (const { rule, lists, label } of rules) {
    if (intersectFixedRule(lists) === 'empty') {
      return {
        jobName,
        contexts: [...envNames],
        rule,
        message: `job '${jobName}' binds contexts [${envNames.join(', ')}] with mutually exclusive ${label} (no value satisfies all bound contexts)`,
      };
    }
  }
  return null;
}

/** Minimal lock-job shape needed to extract its static bound context names. */
interface SatisfiabilityLockJob {
  name?: unknown;
  contexts?: ReadonlyArray<{ value: unknown; dynamic: boolean }>;
}

/** Minimal lock-workflow shape needed to walk its jobs for satisfiability. */
interface SatisfiabilityLockWorkflow {
  jobs?: readonly unknown[];
}

/** Extract the statically-known (non-dynamic, string-valued) bound env names of a lock job. */
function staticBoundNames(job: SatisfiabilityLockJob): string[] {
  return (job.contexts ?? [])
    .filter((e) => !e.dynamic && typeof e.value === 'string')
    .map((e) => e.value as string);
}

/**
 * Walk every workflow's static jobs and reject the registration when a bound
 * context list is provably unsatisfiable (a disabled context, or
 * mutually-exclusive fixed branch/trigger/repo restrictions among the resolved
 * contexts — missing names are lenient, never rejected). Dynamic elements
 * are skipped (unresolvable at registration); the all-must-pass semantics keep
 * the static subset's exclusivity sound. Throws the first
 * `UnsatisfiableBinding.message` so the registration route / direct helper
 * surfaces it to the caller.
 */
export async function assertWorkflowsSatisfiable(
  workflows: ReadonlyArray<SatisfiabilityLockWorkflow>,
  resolveEnv: (name: string) => Promise<Context | null>,
): Promise<void> {
  const cache = new Map<string, Context | null>();
  const resolve = async (name: string): Promise<Context | null> => {
    if (!cache.has(name)) cache.set(name, await resolveEnv(name));
    return cache.get(name) ?? null;
  };
  for (const wf of workflows) {
    for (const job of (wf.jobs ?? []) as SatisfiabilityLockJob[]) {
      if (typeof job?.name !== 'string') continue;
      const names = staticBoundNames(job);
      if (names.length === 0) continue;
      const resolved = await Promise.all(names.map((n) => resolve(n)));
      const problem = checkBindingSatisfiable(
        job.name,
        resolved.map((e) => e ?? undefined),
        names,
      );
      if (problem) throw new Error(`unsatisfiable context binding: ${problem.message}`);
    }
  }
}
