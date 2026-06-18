/**
 * SDK idempotency helpers for workflow authors.
 *
 * Workflows run unattended on agents — no operator at the prompt, no
 * dry-run flag to flip. The helpers in this file expose the same
 * check/apply discipline as the shared primitive but with a workflow
 * shape:
 *
 * - apply on drift unconditionally (no confirm, no dryRun).
 * - optional whenInSync() callback to surface the already-satisfied
 *   resource when check() reports no drift (e.g. fetch an existing
 *   resource id when a create-if-missing was already done).
 * - typed return values threaded through both branches via the
 *   discriminated IdempotentResult union.
 *
 * Two entry points:
 *
 * - `idempotent(options)` — generic helper callable from any step,
 *   hook, or bare async function. Returns the discriminated result.
 * - `idempotentStep(name, options)` — factory returning an SDK `Step`
 *   whose run function executes `idempotent(...)` and propagates ctx.log
 *   into the runner's status sink.
 */

import { runIdempotentStep } from '@kici-dev/core/idempotency';
import { step } from './step.js';
import type { Step } from './types.js';
import type { StepContext } from './context.js';

export interface IdempotentOptions<TDrift, TInSync = void, TApplied = void> {
  /** Optional name surfaced in status lines and error messages. */
  name?: string;
  /** Read-only inspection. Returns drift if apply() would change state,
   *  or null if the system is already in the desired state. */
  check: () => Promise<TDrift | null>;
  /** Brings the system to the desired state. Its return value is
   *  surfaced as `result` on the 'applied' outcome. */
  apply: (drift: TDrift) => Promise<TApplied>;
  /** Runs when check() returns null. Use to fetch the already-satisfied
   *  resource. Its return value is surfaced as `result` on the
   *  'skipped' outcome. */
  whenInSync?: () => Promise<TInSync>;
  /** Multi-line description of what apply() would do. Defaults to a
   *  JSON dump of the drift value. */
  summarize?: (drift: TDrift) => string;
  /** Sink for status lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The result of an SDK idempotent invocation. The runner always applies
 * on drift (no interactive confirm, no dryRun) so the only possible
 * outcomes are 'skipped' (check returned null) and 'applied' (check
 * returned drift; apply ran).
 */
export type IdempotentResult<TDrift, TInSync = void, TApplied = void> =
  | { outcome: 'skipped'; drift: null; result: TInSync }
  | { outcome: 'applied'; drift: TDrift; result: TApplied };

const DEFAULT_NAME = 'idempotent';

/**
 * Generic idempotent helper for use inside any step, hook, or bare
 * async function. Resolves to a discriminated result indicating whether
 * the system was already in sync or apply() ran.
 */
export async function idempotent<TDrift, TInSync = void, TApplied = void>(
  opts: IdempotentOptions<TDrift, TInSync, TApplied>,
): Promise<IdempotentResult<TDrift, TInSync, TApplied>> {
  const name = opts.name ?? DEFAULT_NAME;
  const summarize = opts.summarize ?? ((drift: TDrift) => JSON.stringify(drift, null, 2));
  const sharedResult = await runIdempotentStep<TDrift, TInSync, TApplied>(
    {
      name,
      check: opts.check,
      apply: opts.apply,
      summarize,
      whenInSync: opts.whenInSync,
    },
    {
      yes: true,
      log: opts.log,
    },
  );

  if (sharedResult.outcome === 'skipped') {
    return { outcome: 'skipped', drift: null, result: sharedResult.result };
  }
  if (sharedResult.outcome === 'applied') {
    return { outcome: 'applied', drift: sharedResult.drift, result: sharedResult.result };
  }
  throw new Error(`idempotent(${name}): unreachable outcome '${sharedResult.outcome}'`);
}

/**
 * Factory returning an SDK Step whose run function executes
 * `idempotent(...)`. Status lines are routed through `ctx.log.info`.
 * The step's typed return value is the IdempotentResult union.
 */
export function idempotentStep<TDrift, TInSync = void, TApplied = void>(
  name: string,
  opts: Omit<IdempotentOptions<TDrift, TInSync, TApplied>, 'name' | 'log'>,
): Step<IdempotentResult<TDrift, TInSync, TApplied>> {
  return step<IdempotentResult<TDrift, TInSync, TApplied>>(name, {
    run: async (ctx: StepContext) =>
      idempotent<TDrift, TInSync, TApplied>({
        name,
        check: opts.check,
        apply: opts.apply,
        whenInSync: opts.whenInSync,
        summarize: opts.summarize,
        log: (line) => ctx.log.info(line),
      }),
  });
}
