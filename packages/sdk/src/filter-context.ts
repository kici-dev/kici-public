import { $ } from 'zx';
import type { $ as Shell } from 'zx';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { EventPayload } from './events/event-payloads.js';
import type { RepoInfo } from './context.js';
import type { FilterContext } from './filter.js';
import { defineChangedFilesGetter, eventTypeOf } from './rules/changed-files.js';

/** Input for {@link createFilterContext}. */
export interface CreateFilterContextInput {
  /** The repo whose event triggered this evaluation. */
  sourceRepo: RepoInfo;
  /** The repo that registered the workflow. */
  workflowRepo: RepoInfo;
  event: EventPayload | Record<string, unknown>;
  changedFiles?: string[];
  /** Defaults to `'fetched'` — a caller that passes a real list needs no status. */
  changedFilesStatus?: ChangedFilesStatus;
  env?: Record<string, string | undefined>;
  /** zx shell handed to the filter. Defaults to the ambient `$`. */
  $?: typeof Shell;
}

/**
 * Build a `FilterContext` — the single construction site for the context a
 * workflow's `filter` predicate receives, mirroring {@link createRuleContext}.
 *
 * `changedFiles` is installed through the shared accessor, so it throws
 * `ChangedFilesUnavailableError` when the diff is unavailable instead of
 * reading as an empty list. That matters more here than in a rule: a `false`
 * verdict dispatches none of the workflow's own jobs, and on the
 * organization-wide path it produces no run at all — so a silently-empty diff
 * would suppress the workflow with nothing left to inspect.
 */
export function createFilterContext(input: CreateFilterContextInput): FilterContext {
  const status: ChangedFilesStatus = input.changedFilesStatus ?? 'fetched';

  const base: Omit<FilterContext, 'changedFiles'> = {
    sourceRepo: input.sourceRepo,
    workflowRepo: input.workflowRepo,
    event: input.event as EventPayload,
    changedFilesStatus: status,
    env: input.env ?? {},
    $: input.$ ?? $,
  };

  defineChangedFilesGetter(base, {
    files: input.changedFiles ?? [],
    status,
    eventType: eventTypeOf(input.event),
  });

  return base as FilterContext;
}
