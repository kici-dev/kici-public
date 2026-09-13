/**
 * Idempotent-step primitive: a check / prompt / apply runner that is
 * UI-agnostic and embeddable across the product.
 *
 * The pattern: every destructive operation on shared state (prod infra,
 * npm, git remotes, DNS, TF state, workflow step side effects) is wrapped
 * as an IdempotentStep whose check() returns a typed drift value or null.
 * Null means the system is already in the desired state — the runner
 * silently skips, optionally invoking whenInSync() to surface the
 * already-satisfied resource (e.g. an existing resource id). A non-null
 * drift means apply() would change state — the runner asks the caller's
 * confirm() before invoking apply(), unless yes or dryRun overrides are
 * set. apply() returns the typed result of the change for the caller.
 *
 * The runner has no UI dependency. CLI consumers pass an inquirer-backed
 * confirm; future SDK / agent consumers pass their own policy function.
 * See `.claude/rules/idempotency.md` for the full rule and adopters.
 */

export interface IdempotentStep<TDrift, TInSync = void, TApplied = void> {
  /** Human-readable name; appears in logs and the confirm prompt. */
  name: string;
  /** Read-only inspection. Returns drift value if apply() would change
   *  state, or null if the system is already in the desired state. */
  check: () => Promise<TDrift | null>;
  /** Multi-line description of what apply() would do, given drift. */
  summarize: (drift: TDrift) => string;
  /** Destructive action that brings the system into the desired state.
   *  Its return value is surfaced in StepResult.result on the 'applied'
   *  outcome. */
  apply: (drift: TDrift) => Promise<TApplied>;
  /** Optional: runs when check() returns null. Use this to fetch the
   *  already-satisfied resource (e.g. read the existing id when a
   *  create-if-missing was already done). Return value is surfaced in
   *  StepResult.result on the 'skipped' outcome. */
  whenInSync?: () => Promise<TInSync>;
}

export type ConfirmFn = (message: string) => Promise<boolean>;

export interface RunOptions {
  /** Pluggable confirm. Required unless `yes` or `dryRun` is set. */
  confirm?: ConfirmFn;
  /** Breakglass: skip prompts, apply on drift. The CALLER prints any
   *  loud "auto-confirm" banner before invoking the runner. */
  yes?: boolean;
  /** Report only; bypass confirm; never call apply(). */
  dryRun?: boolean;
  /** Sink for `name`-prefixed status lines. Defaults to console.log. */
  log?: (line: string) => void;
}

export type StepOutcome = 'skipped' | 'applied' | 'declined' | 'dry-run';

export type StepResult<TDrift, TInSync = void, TApplied = void> =
  | { outcome: 'skipped'; drift: null; result: TInSync }
  | { outcome: 'applied'; drift: TDrift; result: TApplied }
  | { outcome: 'declined'; drift: TDrift; result: undefined }
  | { outcome: 'dry-run'; drift: TDrift; result: undefined };

export async function runIdempotentStep<TDrift, TInSync = void, TApplied = void>(
  step: IdempotentStep<TDrift, TInSync, TApplied>,
  opts: RunOptions = {},
): Promise<StepResult<TDrift, TInSync, TApplied>> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const drift = await step.check();

  if (drift === null) {
    log(`✓ ${step.name} — in sync, skipping`);
    const inSyncResult = step.whenInSync ? await step.whenInSync() : (undefined as TInSync);
    return { outcome: 'skipped', drift: null, result: inSyncResult };
  }

  log(`! ${step.name} — drift detected:`);
  for (const line of step.summarize(drift).split('\n')) {
    log(`    ${line}`);
  }

  if (opts.dryRun) {
    log(`  (dry-run; would apply)`);
    return { outcome: 'dry-run', drift, result: undefined };
  }

  let approved: boolean;
  if (opts.yes) {
    approved = true;
  } else {
    if (!opts.confirm) {
      throw new Error(
        `runIdempotentStep(${step.name}): drift detected but no confirm callback ` +
          `provided and yes/dryRun not set. Pass opts.confirm, opts.yes, or opts.dryRun.`,
      );
    }
    approved = await opts.confirm(`Apply ${step.name}?`);
  }

  if (!approved) {
    log(`  declined; skipping`);
    return { outcome: 'declined', drift, result: undefined };
  }

  const appliedResult = await step.apply(drift);
  log(`✓ ${step.name} — applied`);
  return { outcome: 'applied', drift, result: appliedResult };
}
