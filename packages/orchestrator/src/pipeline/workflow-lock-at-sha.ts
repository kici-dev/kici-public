/**
 * Load a workflow repository's lock entries as they were at a recorded commit.
 *
 * An organization-wide run records the commit of the repository that defines
 * its workflow (`execution_runs.workflow_sha`). Two paths act on such a run
 * later, after that repository may have moved on: the re-run of a finished
 * global run, and the release of a held evaluation round. Both must run the
 * workflow version the run was created against, never the registration's
 * current one. This module is the one place that resolves it.
 */
import type { LockFile, LockWorkflow } from '@kici-dev/engine';
import type { ProviderRegistry } from '../provider-registry.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { depCacheKeyOf, type DepCacheKey } from '@kici-dev/shared';
import { hasRepoPatterns } from '../registration/extractor.js';

/**
 * Whether a lock entry is an organization-wide workflow: a trigger carries
 * `repos:`. The re-run and the held-round release both judge a workflow by its
 * entry at the recorded commit through this one rule, never by the current
 * registration.
 */
export function isOrganizationWideEntry(entry: LockWorkflow): boolean {
  return entry.triggers.some(hasRepoPatterns);
}

/**
 * The whole lock file of a registration's repository at `sha`, fetched through
 * the registration's bundle. Throws, naming the repository, when it cannot be
 * read.
 */
export async function loadWorkflowLockFileAtSha(args: {
  registration: WorkflowLockRegistration;
  sha: string;
  providerRegistry: Pick<ProviderRegistry, 'getByRoutingKey'>;
}): Promise<LockFile> {
  return fetchWorkflowLockFile(args.registration, args.sha, args.providerRegistry);
}

/** The registration fields that address a workflow repository's lock file. */
export type WorkflowLockRegistration = Pick<
  RegisteredWorkflow,
  | 'repoIdentifier'
  | 'workflowName'
  | 'routingKey'
  | 'providerContext'
  | 'commitSha'
  | 'lockEntry'
  | 'lockfileHash'
  | 'siblingsDigest'
>;

/** Lock entries at a commit, with the dependency-cache key of the lock file they come from. */
interface LockAtSha {
  entries: Map<string, LockWorkflow>;
  depCacheKey: DepCacheKey;
}

/** One workflow's lock entry at a commit, with the dependency-cache key of the lock file it comes from. */
export interface WorkflowLockEntryAtSha {
  lockEntry: LockWorkflow;
  depCacheKey: DepCacheKey;
}

/**
 * The lock entries of `registrations` at `sha`, keyed by workflow name.
 *
 * Every registration must belong to the same workflow repository. When each
 * registration is already at `sha`, its stored lock entry is that version and
 * nothing is fetched. Otherwise the lock file is fetched at `sha` through the
 * registration's own provider bundle, with the registration's provider context
 * — the same fetcher a per-repository re-run reads its own lock file with. A
 * workflow the lock file at `sha` does not define is absent from the result.
 *
 * Throws, naming the workflow repository, when the lock file cannot be read:
 * the caller refuses rather than falling back to any other version.
 */
export async function loadWorkflowLockEntriesAtSha(args: {
  registrations: readonly WorkflowLockRegistration[];
  sha: string;
  providerRegistry: Pick<ProviderRegistry, 'getByRoutingKey'>;
}): Promise<Map<string, LockWorkflow>> {
  return (await loadLockAtSha(args)).entries;
}

/**
 * {@link loadWorkflowLockEntriesAtSha} with the dependency-cache key of the lock
 * file the entries come from: the first registration's own key when every
 * registration is at `sha`, the fetched lock file's otherwise.
 */
async function loadLockAtSha(args: {
  registrations: readonly WorkflowLockRegistration[];
  sha: string;
  providerRegistry: Pick<ProviderRegistry, 'getByRoutingKey'>;
}): Promise<LockAtSha> {
  const { registrations, sha } = args;
  const first = registrations[0];
  if (!first) {
    throw new Error('no workflow registration was given to load a lock file for');
  }
  const repo = first.repoIdentifier;
  // fails-when: a registration from another repository is mixed into the set
  // breaks-if-wrong: several workflows of one repository must still load together
  if (registrations.some((reg) => reg.repoIdentifier !== repo)) {
    throw new Error(`workflow registrations of more than one repository were given for ${repo}`);
  }
  // fails-when: a registration already at the recorded commit triggers a fetch
  // breaks-if-wrong: a registration that moved past the recorded commit must fetch it
  if (registrations.every((reg) => reg.commitSha === sha)) {
    return {
      entries: new Map(registrations.map((reg) => [reg.workflowName, reg.lockEntry])),
      depCacheKey: { lockfileHash: first.lockfileHash, siblingsDigest: first.siblingsDigest },
    };
  }
  const lockFile = await fetchWorkflowLockFile(first, sha, args.providerRegistry);
  const names = new Set(registrations.map((reg) => reg.workflowName));
  const entries = new Map<string, LockWorkflow>();
  for (const workflow of lockFile.workflows) {
    if (names.has(workflow.name)) entries.set(workflow.name, workflow);
  }
  return { entries, depCacheKey: depCacheKeyOf(lockFile) };
}

/**
 * The lock entry of one registered workflow at `sha`, with the dependency-cache
 * key of the lock file it comes from. Throws, naming the workflow repository,
 * when the lock file at `sha` does not define it.
 */
export async function loadWorkflowLockEntryAtSha(args: {
  registration: WorkflowLockRegistration;
  sha: string;
  providerRegistry: Pick<ProviderRegistry, 'getByRoutingKey'>;
}): Promise<WorkflowLockEntryAtSha> {
  const { registration, sha } = args;
  const { entries, depCacheKey } = await loadLockAtSha({
    registrations: [registration],
    sha,
    providerRegistry: args.providerRegistry,
  });
  const entry = entries.get(registration.workflowName);
  // fails-when: the lock file at the recorded commit does not define the workflow
  if (!entry) {
    throw new Error(
      `workflow '${registration.workflowName}' is not defined in ` +
        `${registration.repoIdentifier}'s lock file at ${sha}`,
    );
  }
  return { lockEntry: entry, depCacheKey };
}

async function fetchWorkflowLockFile(
  registration: WorkflowLockRegistration,
  sha: string,
  providerRegistry: Pick<ProviderRegistry, 'getByRoutingKey'>,
): Promise<LockFile> {
  const repo = registration.repoIdentifier;
  const bundle = providerRegistry.getByRoutingKey(registration.routingKey);
  if (!bundle) {
    throw new Error(
      `the source ${registration.routingKey} of workflow repository ${repo} is no longer registered`,
    );
  }
  if (!bundle.lockFileFetcher) {
    throw new Error(`the provider of workflow repository ${repo} cannot fetch a lock file`);
  }
  const lockFile = await bundle.lockFileFetcher.fetchLockFile(
    repo,
    sha,
    registration.providerContext,
  );
  if (!lockFile) {
    throw new Error(
      `workflow repository ${repo} has no lock file at ${sha} (the commit may have been force-pushed away)`,
    );
  }
  return lockFile;
}
