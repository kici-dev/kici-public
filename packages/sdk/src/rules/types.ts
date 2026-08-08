import type { $ as Shell } from 'zx';
import type { EventPayload } from '../events/event-payloads.js';
import type { FanoutPosition } from '../fanout-context.js';

// Re-export the typed discriminated union (replaces the old placeholder interface).
export type { EventPayload } from '../events/event-payloads.js';

/**
 * Context passed to rule check functions.
 * Provides access to event data, changed files, environment, and shell execution.
 */
export interface RuleContext {
  /** The triggering event payload */
  event: EventPayload;
  /**
   * Files changed in this event (PR diff / push diff). Available on push and
   * pull_request events (the agent computes the diff from the checkout — no
   * `paths:` trigger required). Accessing this throws
   * `ChangedFilesUnavailableError` when the diff is not available
   * (`changedFilesStatus !== 'fetched'`) — e.g. a schedule/tag/manual event.
   * Guard with `changedFilesStatus` first when a rule runs on such events:
   * `if (ctx.changedFilesStatus !== 'fetched') return true`.
   */
  changedFiles: string[];
  /** Availability of `changedFiles` (see `changedFiles`). */
  changedFilesStatus: import('@kici-dev/engine').ChangedFilesStatus;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Operator-supplied, validated + coerced workflow-dispatch inputs. Empty when none declared. */
  dispatchInputs: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Position of this child within its fan-out (a `runsOnAll` host or a matrix
   * combination); undefined on a non-fan-out job. Read by the run-once rule
   * helpers (`onlyOnFirstHost` / `onlyOnLastHost` / `onlyOnFanoutIndex`).
   */
  fanout?: FanoutPosition;
  /** zx shell executor for running commands */
  $: typeof Shell;
}

/**
 * Function type for rule check functions.
 * Can be sync or async - returns whether the rule passes.
 */
export type RuleCheckFn = (ctx: RuleContext) => Promise<boolean> | boolean;

/**
 * Rule definition returned by rule() factory.
 * Rules are labeled conditional checks that appear in the decision trace.
 */
export interface Rule {
  readonly _tag: 'Rule';
  readonly label: string;
  readonly check: RuleCheckFn;
}

/**
 * Result of evaluating a rule (for decision trace).
 * Records whether the rule passed and how long evaluation took.
 */
export interface RuleResult {
  label: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}
