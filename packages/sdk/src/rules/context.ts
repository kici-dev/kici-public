import { $ } from 'zx';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { EventPayload } from '../events/event-payloads.js';
import type { FanoutPosition } from '../fanout-context.js';
import type { RepoInfo } from '../context.js';
import type { RuleContext } from './types.js';
import { defineChangedFilesGetter, eventTypeOf } from './changed-files.js';

export { ChangedFilesUnavailableError } from './changed-files.js';

/** Input for {@link createRuleContext}. */
export interface CreateRuleContextInput {
  event: EventPayload | Record<string, unknown>;
  changedFiles?: string[];
  /** Defaults to `'fetched'` — a caller that passes a real list needs no status. */
  changedFilesStatus?: ChangedFilesStatus;
  env?: Record<string, string | undefined>;
  dispatchInputs?: Readonly<Record<string, string | number | boolean | null>>;
  fanout?: FanoutPosition;
  /**
   * The repo whose event triggered this run. Supplied for a global workflow.
   *
   * `path` is an absolute path into the evaluating machine's work directory and
   * is NOT stable across evaluations — read the tree through it, never compare
   * it. `ref` / `sha` are optional on `RepoInfo`; do not assume either is set.
   */
  sourceRepo?: RepoInfo;
  /** The repo that registered the workflow. Identical to `sourceRepo` outside a global workflow. */
  workflowRepo?: RepoInfo;
}

/**
 * Build a RuleContext. `changedFiles` is exposed as a getter: it returns the
 * list when `changedFilesStatus === 'fetched'`, otherwise it throws
 * `ChangedFilesUnavailableError`. This is the single construction site for a
 * rule context across the agent, the compiler test-runner, and tests.
 */
export function createRuleContext(input: CreateRuleContextInput): RuleContext {
  const status: ChangedFilesStatus = input.changedFilesStatus ?? 'fetched';

  const base: Omit<RuleContext, 'changedFiles'> = {
    event: input.event as EventPayload,
    changedFilesStatus: status,
    env: input.env ?? {},
    dispatchInputs: input.dispatchInputs ?? {},
    ...(input.fanout && { fanout: input.fanout }),
    // Spread conditionally: a present-but-undefined `sourceRepo` reads as
    // "declared" to a rule that guards on the key rather than the value.
    ...(input.sourceRepo && { sourceRepo: input.sourceRepo }),
    ...(input.workflowRepo && { workflowRepo: input.workflowRepo }),
    $,
  };

  defineChangedFilesGetter(base, {
    files: input.changedFiles ?? [],
    status,
    eventType: eventTypeOf(input.event),
  });

  return base as RuleContext;
}
