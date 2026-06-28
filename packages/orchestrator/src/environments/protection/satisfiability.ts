/**
 * Registration-time satisfiability check for multi-environment job bindings.
 *
 * When a job binds several environments (`environments: [...]`), every
 * environment's protection gates must pass for the job to ever dispatch
 * (all-must-pass aggregation — see `aggregate.ts`). Some of those gates are
 * decidable statically: if two bound environments restrict to disjoint fixed
 * branch sets, no run can ever satisfy both, so the binding is provably
 * unsatisfiable and should be rejected at registration rather than failing
 * silently at every future dispatch.
 *
 * This module intersects the statically-decidable set rules (branch, trigger
 * type, repository — only when every pattern is a literal, never a glob) plus
 * existence and enabled across the bound environments, and reports the first
 * provably-empty intersection. Any glob in a rule makes that rule undecidable,
 * so it is skipped here and left to the dispatch-time catch-all
 * (`evaluateMultiEnvGates`).
 */
import { z } from 'zod';
import type { Environment } from '@kici-dev/engine';

/** Which decidable rule made a binding unsatisfiable. */
export const UnsatisfiableRule = z.enum(['existence', 'enabled', 'branch', 'trigger', 'repo']);
export type UnsatisfiableRule = z.infer<typeof UnsatisfiableRule>;

/** A provably-unsatisfiable multi-environment binding, naming the rule + reason. */
export interface UnsatisfiableBinding {
  jobName: string;
  environments: string[];
  rule: UnsatisfiableRule;
  message: string;
}

/** A glob metacharacter makes a branch/trigger/repo pattern undecidable here. */
function isFixedPattern(pattern: string): boolean {
  return !/[*?[\]{}!()@+|]/.test(pattern);
}

/**
 * Intersect the per-environment allow-lists for one set rule. Returns:
 *  - `'ok'` when no environment constrains the rule, or the intersection is
 *    non-empty;
 *  - `'undecidable'` when any constraining environment uses a glob pattern;
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
 * Returns a precise problem when the bound environments can NEVER be jointly
 * satisfied (a provably-empty intersection on a decidable rule, a missing
 * environment, or a disabled one), else `null`. Glob / undecidable cases return
 * `null` and are caught at dispatch by `evaluateMultiEnvGates`.
 *
 * `envs[i]` is the resolved `Environment` for `envNames[i]` (undefined when the
 * name has no environment record). Only the statically-known (non-dynamic) bound
 * names should be passed — dynamic elements are unknown at registration and the
 * all-must-pass semantics make the static subset's exclusivity still sound.
 */
export function checkBindingSatisfiable(
  jobName: string,
  envs: ReadonlyArray<Environment | undefined>,
  envNames: readonly string[],
): UnsatisfiableBinding | null {
  // Existence: a bound name with no environment record can never pass.
  const missingIdx = envs.findIndex((e) => !e);
  if (missingIdx !== -1) {
    return {
      jobName,
      environments: [...envNames],
      rule: UnsatisfiableRule.enum.existence,
      message: `job '${jobName}' binds environment '${envNames[missingIdx]}' which does not exist`,
    };
  }
  const present = envs as Environment[];

  // Enabled: a disabled environment never passes.
  const disabled = present.find((e) => !e.enabled);
  if (disabled) {
    return {
      jobName,
      environments: [...envNames],
      rule: UnsatisfiableRule.enum.enabled,
      message: `job '${jobName}' binds disabled environment '${disabled.name}'`,
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
        environments: [...envNames],
        rule,
        message: `job '${jobName}' binds environments [${envNames.join(', ')}] with mutually exclusive ${label} (no value satisfies all bound environments)`,
      };
    }
  }
  return null;
}

/** Minimal lock-job shape needed to extract its static bound environment names. */
interface SatisfiabilityLockJob {
  name?: unknown;
  environments?: ReadonlyArray<{ value: unknown; dynamic: boolean }>;
}

/** Minimal lock-workflow shape needed to walk its jobs for satisfiability. */
interface SatisfiabilityLockWorkflow {
  jobs?: readonly unknown[];
}

/** Extract the statically-known (non-dynamic, string-valued) bound env names of a lock job. */
function staticBoundNames(job: SatisfiabilityLockJob): string[] {
  return (job.environments ?? [])
    .filter((e) => !e.dynamic && typeof e.value === 'string')
    .map((e) => e.value as string);
}

/**
 * Walk every workflow's static jobs and reject the registration when a bound
 * environment list is provably unsatisfiable (missing/disabled environment, or
 * mutually-exclusive fixed branch/trigger/repo restrictions). Dynamic elements
 * are skipped (unresolvable at registration); the all-must-pass semantics keep
 * the static subset's exclusivity sound. Throws the first
 * `UnsatisfiableBinding.message` so the registration route / direct helper
 * surfaces it to the caller.
 */
export async function assertWorkflowsSatisfiable(
  workflows: ReadonlyArray<SatisfiabilityLockWorkflow>,
  resolveEnv: (name: string) => Promise<Environment | null>,
): Promise<void> {
  const cache = new Map<string, Environment | null>();
  const resolve = async (name: string): Promise<Environment | null> => {
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
      if (problem) throw new Error(`unsatisfiable environment binding: ${problem.message}`);
    }
  }
}
