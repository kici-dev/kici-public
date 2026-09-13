/**
 * The single builder for a `DynamicJobFn`'s context.
 *
 * A generator is evaluated twice — once pre-dispatch to produce the job list,
 * and once inside the sandbox to recover the step closures a `LockJob` cannot
 * carry. `extractStepsFromDynamicJob` throws when the target job is missing on
 * re-evaluation, so a generator whose two calls see different contexts is
 * unsound by construction. Every call site builds its context here so the two
 * cannot drift apart.
 */

import type { DynamicJobContext, RepoInfo } from '@kici-dev/sdk';
import type { EventPayload } from '@kici-dev/sdk';

/**
 * The source / workflow repo pair a global workflow's generator sees.
 *
 * `sourceRepo.path` is an absolute path into THIS evaluation's work directory:
 * it is NOT stable across the two evaluations (a different `workDir`, possibly
 * a different machine). Its *contents* are stable; the path is not. So read
 * through the path — never embed it in a generated job name, a job output, or
 * anything else the two evaluations are compared on.
 *
 * `RepoInfo.ref` and `.sha` are optional: an evaluation that has no checkout
 * metadata still supplies the pair. Never assume either is present.
 */
export interface GeneratorRepoPair {
  sourceRepo: RepoInfo;
  workflowRepo: RepoInfo;
}

/** Input for {@link buildGeneratorContext}. */
export interface GeneratorContextInput {
  workflowName: string;
  /**
   * The raw wire event. Untyped JSON that, per the unified event protocol,
   * always carries the normalized event envelope.
   */
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
 * Build the context handed to a `DynamicJobFn`.
 *
 * Optional members are spread conditionally rather than assigned `undefined`,
 * so an absent `needs` / repo pair leaves no key behind — a present-but-
 * undefined key reads as "declared" to a generator and serializes differently
 * between the two evaluations.
 */
export function buildGeneratorContext(input: GeneratorContextInput): DynamicJobContext {
  const { workflowName, event, env, repos, needs, $, log, kici } = input;
  return {
    $,
    ctx: {
      workflow: { name: workflowName },
      // Boundary cast: the wire `event` is untyped JSON that, per the unified
      // event protocol, always carries the normalized event envelope. This is
      // where it enters the DynamicJobFn's user context.
      event: event as EventPayload,
      ...(needs && { needs }),
    },
    log,
    env,
    kici,
    ...(repos && { sourceRepo: repos.sourceRepo, workflowRepo: repos.workflowRepo }),
  };
}
