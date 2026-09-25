/**
 * The registrations a held global evaluation round is released with.
 *
 * Approving a held round releases the round the approver looked at, so the
 * round, the candidate partition, and the dispatch after it all read the
 * workflow repository's lock file at the commit the hold recorded — never the
 * registrations' current entries, which may have moved on while the round
 * waited. Each current registration supplies the routing key and provider
 * context the fetch and the dispatch use; its lock entry, trigger types,
 * commit, branch and dependency-cache key are replaced by the held commit's.
 */
import { isLockDynamicJobFn, type LockWorkflow } from '@kici-dev/engine';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { depCacheKeyOf } from '@kici-dev/shared';
import { HELD_ROUND_WORKFLOWS_KEY } from '../reporting/execution-tracker.js';
import { eventTypeToTriggerType, type ProcessingDeps } from './processor.js';
import { isOrganizationWideEntry, loadWorkflowLockFileAtSha } from './workflow-lock-at-sha.js';

/** The held round's run row fields the release reads. */
export interface HeldRoundRow {
  customer_id: string;
  workflow_sha: string | null;
  workflow_branch: string | null;
  trigger_decision: string | null;
}

/**
 * The workflows the hold recorded the round as covering, or `undefined` for a
 * row held before the record existed.
 */
export function heldRoundWorkflowsOf(triggerDecision: string | null): string[] | undefined {
  if (!triggerDecision) return undefined;
  try {
    const recorded = (JSON.parse(triggerDecision) as Record<string, unknown>)[
      HELD_ROUND_WORKFLOWS_KEY
    ];
    return Array.isArray(recorded)
      ? recorded.filter((name): name is string => typeof name === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

/** The trigger types a lock entry subscribes to, as a registration records them. */
function triggerTypesOf(entry: LockWorkflow): string[] {
  return [...new Set(entry.triggers.map((trigger) => trigger._type))];
}

/**
 * Whether a row held before the covered set was recorded covered this
 * workflow: it carries a filter or a generator. A static-only workflow was held
 * on its own, not with the round.
 */
function coveredByRound(entry: LockWorkflow): boolean {
  return entry.hasFilter === true || entry.jobs.some(isLockDynamicJobFn);
}

/**
 * Why a covered workflow cannot be released, or `undefined` when it can.
 *
 * A workflow registered under several sources of the repository is releasable
 * when any one of its registrations is live and subscribed: the pass the round
 * was held from evaluates every live registration, so neither the first nor the
 * last one alone decides.
 */
function missingReason(
  name: string,
  all: readonly RegisteredWorkflow[],
  triggerType: string,
): string | undefined {
  const registrations = all.filter((candidate) => candidate.workflowName === name);
  if (registrations.length === 0) return `${name} (no longer registered)`;
  const enabled = registrations.filter((reg) => !reg.disabled);
  if (enabled.length === 0) return `${name} (disabled)`;
  if (!enabled.some((reg) => reg.triggerTypes.includes(triggerType))) {
    return `${name} (no longer subscribed)`;
  }
  return undefined;
}

/** Whether a lock entry at the held commit is an organization-wide workflow that runs on the event. */
function runsOnEvent(entry: LockWorkflow, triggerType: string): boolean {
  return isOrganizationWideEntry(entry) && triggerTypesOf(entry).includes(triggerType);
}

/**
 * The held commit's lock entries by workflow name. A lock file that names a
 * workflow twice keeps the last entry, the rule `loadLockAtSha` applies when a
 * re-run reads a lock file at its recorded commit and the one the registration
 * store's update of an existing row follows.
 */
function entriesByName(entries: readonly LockWorkflow[]): Map<string, LockWorkflow> {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

/** Why a recorded workflow is absent from the held commit's organization-wide entries, if it is. */
function absentAtHeldCommit(
  name: string,
  held: ReadonlyMap<string, LockWorkflow>,
  triggerType: string,
): string | undefined {
  const entry = held.get(name);
  if (!entry) return `${name} (not in the lock file at the held commit)`;
  if (!runsOnEvent(entry, triggerType)) {
    return `${name} (not an organization-wide workflow for this event at the held commit)`;
  }
  return undefined;
}

/**
 * The workflow repository's organization-wide registrations for the held
 * event, as they were at the held commit.
 *
 * Throws, naming the workflow repository and the workflows, when the release
 * cannot run what the approver approved: the repository registers nothing any
 * more, its lock file at the held commit cannot be read, a workflow the round
 * covered has no live, enabled registration that still subscribes to the event,
 * or the lock file at the held commit does not define it as an
 * organization-wide workflow for the event. The release then fails the held run
 * with that reason and dispatches nothing — never a partial round.
 *
 * Every live registration of a covered workflow is returned, one per source
 * that registers it, as the pass the round was held from evaluates them.
 *
 * The covered set is the one the hold recorded. A row held before that record
 * existed falls back to the held commit's round-shaped workflows, which cannot
 * see a workflow whose registration vanished at an unchanged commit.
 */
export async function registrationsAtHeldCommit(args: {
  row: HeldRoundRow;
  deps: Pick<ProcessingDeps, 'registrationIndex' | 'providerRegistry'>;
  workflowRepo: string;
  eventName: string;
}): Promise<RegisteredWorkflow[]> {
  const { row, deps, workflowRepo } = args;
  const triggerType = eventTypeToTriggerType(args.eventName);
  const all = deps.registrationIndex?.getAllByOrgAndRepo(row.customer_id, workflowRepo) ?? [];
  const live = all.filter((reg) => !reg.disabled);
  const recorded = heldRoundWorkflowsOf(row.trigger_decision);

  // fails-when: a covered workflow was disabled or deleted while its siblings stayed at the held commit
  // breaks-if-wrong: a workflow that was not in the recorded set never trips the check
  if (recorded) refuseMissing(recorded, all, triggerType, workflowRepo);
  if (live.length === 0) {
    throw new Error(`workflow repository ${workflowRepo} no longer registers any workflow`);
  }
  const subscribed = live.filter((reg) => reg.triggerTypes.includes(triggerType));
  const inRecord = (name: string): boolean => recorded === undefined || recorded.includes(name);

  const heldSha = row.workflow_sha;
  if (heldSha == null) {
    // The hold recorded no commit because the registrations recorded none, so
    // the round had nothing to pin. Registrations that still record none are the
    // same state; ones that have since recorded a commit cannot be traced back.
    if (live.some((reg) => reg.commitSha != null)) {
      throw new Error(
        `the held round recorded no commit of workflow repository ${workflowRepo}, and its ` +
          `registrations have moved to one since`,
      );
    }
    if (recorded) {
      refuseAbsent(
        recorded,
        entriesByName(live.map((reg) => reg.lockEntry)),
        triggerType,
        workflowRepo,
      );
    }
    return subscribed.filter(
      (reg) => runsOnEvent(reg.lockEntry, triggerType) && inRecord(reg.workflowName),
    );
  }

  // Registrations all at the held commit ARE its entries; otherwise the held
  // commit's lock file is read.
  const heldLock = live.every((reg) => reg.commitSha === heldSha)
    ? undefined
    : await loadWorkflowLockFileAtSha({
        registration: live[0],
        sha: heldSha,
        providerRegistry: deps.providerRegistry,
      });
  const held = entriesByName(heldLock ? heldLock.workflows : live.map((reg) => reg.lockEntry));
  // fails-when: a recorded workflow the held commit does not define is dropped and the round runs without it
  // breaks-if-wrong: a recorded workflow the held commit defines for this event is still released
  if (recorded) refuseAbsent(recorded, held, triggerType, workflowRepo);
  const heldGlobals = [...held.values()].filter(
    (entry) => runsOnEvent(entry, triggerType) && inRecord(entry.name),
  );
  if (!recorded) {
    refuseMissing(
      heldGlobals.filter(coveredByRound).map((entry) => entry.name),
      all,
      triggerType,
      workflowRepo,
    );
  }

  return heldGlobals.flatMap((entry) =>
    subscribed
      .filter((reg) => reg.workflowName === entry.name)
      .map((reg) => ({
        ...reg,
        lockEntry: entry,
        triggerTypes: triggerTypesOf(entry),
        commitSha: heldSha,
        // The branch the hold recorded, or none: a guessed branch would present
        // a branch-restricted context with a value nobody recorded.
        defaultBranch: row.workflow_branch,
        // The build job checks out the held commit, so the dependency cache is
        // keyed by that commit's lock file, never the registration's current one.
        // fails-when: a registration that moved past the held commit keeps its current key
        // breaks-if-wrong: a registration at the held commit keeps its own key, with no fetch
        ...(heldLock && depCacheKeyOf(heldLock)),
      })),
  );
}

/** Throw, naming each covered workflow that cannot be released and why. */
function refuseMissing(
  covered: readonly string[],
  all: readonly RegisteredWorkflow[],
  triggerType: string,
  workflowRepo: string,
): void {
  refuse(
    covered.map((name) => missingReason(name, all, triggerType)),
    workflowRepo,
  );
}

/** Throw, naming each recorded workflow the held commit's lock file does not run on the event. */
function refuseAbsent(
  recorded: readonly string[],
  held: ReadonlyMap<string, LockWorkflow>,
  triggerType: string,
  workflowRepo: string,
): void {
  refuse(
    recorded.map((name) => absentAtHeldCommit(name, held, triggerType)),
    workflowRepo,
  );
}

/** Throw when any covered workflow carries a reason it cannot be released. */
function refuse(reasons: ReadonlyArray<string | undefined>, workflowRepo: string): void {
  const missing = reasons.filter((reason): reason is string => reason !== undefined);
  if (missing.length > 0) {
    throw new Error(
      `workflow repository ${workflowRepo} can no longer run ${missing.join(', ')}, which ` +
        `the held round covered`,
    );
  }
}
