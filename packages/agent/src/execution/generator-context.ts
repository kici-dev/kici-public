/**
 * The single builder for a `DynamicJobFn`'s context. A generator is evaluated
 * twice — pre-dispatch for the job list, and in the sandbox to recover the step
 * closures a `LockJob` cannot carry — and `extractStepsFromDynamicJob` throws
 * when the job is missing on re-evaluation, so every call site builds here to
 * keep the contexts identical.
 */

import type { DynamicJobContext, RepoInfo } from '@kici-dev/sdk';
import type { EventPayload } from '@kici-dev/sdk';

/**
 * The source / workflow repo pair a global workflow's generator sees.
 *
 * `sourceRepo.path` points into THIS evaluation's work directory and differs
 * between the two evaluations (another `workDir`, maybe another machine); only
 * its contents are stable. Read through it, never embed it in a job name, job
 * output, or anything else the evaluations are compared on.
 *
 * `RepoInfo.ref` and `.sha` may be absent (no checkout metadata).
 */
export interface GeneratorRepoPair {
  sourceRepo: RepoInfo;
  workflowRepo: RepoInfo;
}

export interface GeneratorContextInput {
  workflowName: string;
  /** Raw wire JSON; per the unified event protocol, always the normalized event envelope. */
  event: Record<string, unknown>;
  env: Record<string, string | undefined>;
  /** Present for a global workflow; omitted entirely otherwise. */
  repos?: GeneratorRepoPair;
  /** Frozen upstream outputs for a result-aware generator. */
  needs?: NonNullable<DynamicJobContext['ctx']['needs']>;
  $: DynamicJobContext['$'];
  log: DynamicJobContext['log'];
  kici: DynamicJobContext['kici'];
}

/**
 * Optional members are spread conditionally, never assigned `undefined`: a
 * present-but-undefined key reads as "declared" to a generator and serializes
 * differently between the two evaluations.
 */
export function buildGeneratorContext(input: GeneratorContextInput): DynamicJobContext {
  const { workflowName, event, env, repos, needs, $, log, kici } = input;
  return {
    $,
    ctx: {
      workflow: { name: workflowName },
      // Boundary cast into the user context (see GeneratorContextInput.event).
      event: event as EventPayload,
      ...(needs && { needs }),
    },
    log,
    env,
    kici,
    ...(repos && { sourceRepo: repos.sourceRepo, workflowRepo: repos.workflowRepo }),
  };
}
