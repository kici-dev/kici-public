import type { $ as Shell } from 'zx';
import type { EventPayload } from '../events/event-payloads.js';
import type { FanoutPosition } from '../fanout-context.js';
import type { RepoInfo } from '../context.js';

export type { EventPayload } from '../events/event-payloads.js';

/** Context passed to rule check functions. */
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
  /**
   * The repo whose event triggered this run. Present for a global workflow and
   * for any evaluation that runs with a checkout; undefined otherwise.
   * Read through `.path`; never embed it in a job name (see FilterContext).
   */
  sourceRepo?: RepoInfo;
  /** The repo that registered the workflow. Identical to `sourceRepo` outside a global workflow. */
  workflowRepo?: RepoInfo;
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

/** A rule check, sync or async: returns whether the rule passes. */
export type RuleCheckFn = (ctx: RuleContext) => Promise<boolean> | boolean;

/** Rule returned by rule() factory: a labeled conditional check that appears in the decision trace. */
export interface Rule {
  readonly _tag: 'Rule';
  readonly label: string;
  readonly check: RuleCheckFn;
}

/** Result of evaluating a rule, recorded in the decision trace. */
export interface RuleResult {
  label: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}
