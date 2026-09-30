/**
 * The one changed-files resolver every dispatch path calls: same-source, the
 * no-lock-file organization-wide pass, cross-source repo mode, and rerun.
 *
 * `unavailable` means the orchestrator holds no authoritative list; whether the
 * agent can compute one is the range's question, answered by `resolveDiffRange`.
 */
import {
  DEFERRED_PATHS_SUMMARY_SUFFIX,
  UnavailablePathsTrace,
  diffRangeKindSchema,
  resolveDiffRange,
  type ChangedFilesStatus,
  type DiffRange,
  type LockWorkflow,
  type SimulatedEvent,
  type WebhookNormalizer,
  type WorkflowDecision,
} from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ProviderBundle } from '../provider-registry.js';
import { anyTriggerHasPathPatterns, extractDefaultBranch } from './processor.js';

const logger = createLogger({ prefix: 'pipeline:changed-files' });

export interface ResolvedChangedFiles {
  files: string[];
  status: ChangedFilesStatus;
  range: DiffRange;
}

/**
 * Resolve the files an event changed through a bundle's fetcher.
 *
 * - no workflow in `workflows` has a `paths` trigger → `skipped`;
 * - a deleted branch → `fetched` + `[]`, whichever provider delivered it;
 * - no fetcher, or a fetcher that throws → `unavailable`, never a failed delivery.
 */
export async function resolveEventChangedFiles(args: {
  bundle: Pick<ProviderBundle, 'changedFilesFetcher'>;
  credentials: unknown;
  repoIdentifier: string;
  eventName: string;
  payload: unknown;
  event: SimulatedEvent;
  /** Omitted: always resolve — a re-evaluation has no lock file to consult. */
  workflows?: readonly LockWorkflow[];
}): Promise<ResolvedChangedFiles> {
  const range = resolveDiffRange(args.event);
  if (args.workflows && !anyTriggerHasPathPatterns([...args.workflows])) {
    return { files: [], status: 'skipped', range };
  }
  if (range.kind === diffRangeKindSchema.enum.deleted) {
    return { files: [], status: 'fetched', range };
  }
  const fetcher = args.bundle.changedFilesFetcher;
  if (!fetcher) return { files: [], status: 'unavailable', range };
  try {
    const fetched = await fetcher.getChangedFiles(
      args.repoIdentifier,
      args.eventName,
      args.payload,
      args.credentials,
    );
    return { files: fetched.files, status: fetched.status, range };
  } catch (err) {
    logger.warn(
      'changed-files fetch failed — the path decision moves to the agent when a range exists',
      {
        repoIdentifier: args.repoIdentifier,
        eventName: args.eventName,
        range: range.kind,
        error: toErrorMessage(err),
      },
    );
    return { files: [], status: 'unavailable', range };
  }
}

/**
 * Stamp the repository's default branch on a normalized event, so the
 * new-branch range (`resolveDiffRange`) and the agent that receives this event
 * read the same value. `extractDefaultBranch` prefers the normalizer's hook,
 * which covers GitLab's `project.default_branch`.
 */
export function withDefaultBranch(
  event: SimulatedEvent,
  payload: unknown,
  normalizer: WebhookNormalizer,
): SimulatedEvent {
  if (event.defaultBranch || payload === null || typeof payload !== 'object') return event;
  const defaultBranch = extractDefaultBranch(payload as Record<string, unknown>, normalizer);
  return defaultBranch ? { ...event, defaultBranch } : event;
}

/** Copy a resolved list and its status onto the event the matcher reads. */
export function stampChangedFiles(
  event: SimulatedEvent,
  resolved: ResolvedChangedFiles,
): SimulatedEvent {
  return { ...event, changedFiles: resolved.files, changedFilesStatus: resolved.status };
}

/**
 * Downgrade a cross-source pull-request deferral to a conservative match.
 *
 * A cross-source job checks out the registration's commit, never the pull
 * request's head, so no agent can diff the pull request for it. A path
 * decision the orchestrator could not make therefore runs the workflow, as a
 * range-less push does, instead of handing the agent a diff of the wrong
 * commits. Push ranges diff explicit commits and keep their deferral.
 */
export function withoutCrossSourcePrDeferral(
  decision: WorkflowDecision,
  event: SimulatedEvent,
): WorkflowDecision {
  if (!decision.deferredPaths || resolveDiffRange(event).kind !== diffRangeKindSchema.enum.pr) {
    return decision;
  }
  const { deferredPaths: _decidedHere, ...rest } = decision;
  return {
    ...rest,
    summary: decision.summary.replace(DEFERRED_PATHS_SUMMARY_SUFFIX, ''),
    checks: decision.checks.map((check) =>
      check.check === 'paths' && check.value === UnavailablePathsTrace.DecidedOnAgent
        ? { ...check, value: UnavailablePathsTrace.Conservative }
        : check,
    ),
  };
}
