import { describe, expect, it, vi } from 'vitest';
import type { LockWorkflow } from '@kici-dev/engine';
import {
  loadWorkflowLockEntriesAtSha,
  loadWorkflowLockEntryAtSha,
  type WorkflowLockRegistration,
} from './workflow-lock-at-sha.js';

const REPO = 'org/ci';
const PROVIDER_CONTEXT = { installationId: 7 };

function entry(name: string, marker: string): LockWorkflow {
  return { name, triggers: [], jobs: [], source: { file: marker } } as unknown as LockWorkflow;
}

function registration(
  name: string,
  commitSha: string | null,
  overrides: Partial<WorkflowLockRegistration> = {},
): WorkflowLockRegistration {
  return {
    repoIdentifier: REPO,
    workflowName: name,
    routingKey: 'github:ci',
    providerContext: PROVIDER_CONTEXT,
    commitSha,
    lockEntry: entry(name, `current-${name}`),
    lockfileHash: `current-lock-${name}`,
    siblingsDigest: null,
    ...overrides,
  };
}

function registryWith(lockFile: unknown) {
  const fetchLockFile = vi.fn().mockResolvedValue(lockFile);
  const getByRoutingKey = vi.fn().mockReturnValue({ lockFileFetcher: { fetchLockFile } });
  return { providerRegistry: { getByRoutingKey } as never, fetchLockFile, getByRoutingKey };
}

describe('loadWorkflowLockEntriesAtSha', () => {
  it('fetches the lock file at the recorded commit through the registration bundle', async () => {
    // fails-when: the lock is read at the registration's current commit instead of the recorded one
    const { providerRegistry, fetchLockFile, getByRoutingKey } = registryWith({
      workflows: [entry('a', 'a-at-s1'), entry('b', 'b-at-s1'), entry('other', 'x')],
    });

    const entries = await loadWorkflowLockEntriesAtSha({
      registrations: [registration('a', 's2'), registration('b', 's2')],
      sha: 's1',
      providerRegistry,
    });

    expect(getByRoutingKey).toHaveBeenCalledWith('github:ci');
    expect(fetchLockFile).toHaveBeenCalledWith(REPO, 's1', PROVIDER_CONTEXT);
    expect([...entries.keys()].sort()).toEqual(['a', 'b']);
    expect(entries.get('a')?.source).toEqual({ file: 'a-at-s1' });
  });

  it('uses the stored entries without fetching when every registration is at the commit', async () => {
    // breaks-if-wrong: a registration already at the recorded commit needs no network read
    const { providerRegistry, fetchLockFile } = registryWith(null);

    const entries = await loadWorkflowLockEntriesAtSha({
      registrations: [registration('a', 's1')],
      sha: 's1',
      providerRegistry,
    });

    expect(fetchLockFile).not.toHaveBeenCalled();
    expect(entries.get('a')?.source).toEqual({ file: 'current-a' });
  });

  it('leaves out a workflow the lock file at the commit does not define', async () => {
    const { providerRegistry } = registryWith({ workflows: [entry('a', 'a-at-s1')] });

    const entries = await loadWorkflowLockEntriesAtSha({
      registrations: [registration('a', 's2'), registration('added-later', 's2')],
      sha: 's1',
      providerRegistry,
    });

    expect([...entries.keys()]).toEqual(['a']);
  });

  it('refuses, naming the repository, when the commit has no lock file', async () => {
    // fails-when: a missing lock file falls back to the registration's current entry
    const { providerRegistry } = registryWith(null);

    await expect(
      loadWorkflowLockEntriesAtSha({
        registrations: [registration('a', 's2')],
        sha: 's1',
        providerRegistry,
      }),
    ).rejects.toThrow(/org\/ci has no lock file at s1/);
  });

  it('refuses when the registration source is no longer registered', async () => {
    const providerRegistry = { getByRoutingKey: vi.fn().mockReturnValue(undefined) } as never;

    await expect(
      loadWorkflowLockEntriesAtSha({
        registrations: [registration('a', 's2')],
        sha: 's1',
        providerRegistry,
      }),
    ).rejects.toThrow(/source github:ci of workflow repository org\/ci is no longer registered/);
  });

  it('refuses registrations from more than one repository', async () => {
    const { providerRegistry } = registryWith({ workflows: [] });

    await expect(
      loadWorkflowLockEntriesAtSha({
        registrations: [
          registration('a', 's2'),
          registration('b', 's2', { repoIdentifier: 'org/other' }),
        ],
        sha: 's1',
        providerRegistry,
      }),
    ).rejects.toThrow(/more than one repository/);
  });
});

describe('loadWorkflowLockEntryAtSha', () => {
  it('returns the dependency-cache key of the lock file fetched at the commit', async () => {
    // fails-when: the key of the registration's current lock file stands in for the recorded commit's
    const { providerRegistry } = registryWith({
      lockfileHash: 'lock-at-s1',
      siblingsDigest: 'siblings-at-s1',
      workflows: [entry('a', 'a-at-s1')],
    });

    const atSha = await loadWorkflowLockEntryAtSha({
      registration: registration('a', 's2'),
      sha: 's1',
      providerRegistry,
    });

    expect(atSha.lockEntry.source).toEqual({ file: 'a-at-s1' });
    expect(atSha.depCacheKey).toEqual({
      lockfileHash: 'lock-at-s1',
      siblingsDigest: 'siblings-at-s1',
    });
  });

  it("returns the registration's own key when it is at the commit", async () => {
    // breaks-if-wrong: a registration already at the recorded commit keeps its key without a fetch
    const { providerRegistry, fetchLockFile } = registryWith(null);

    const atSha = await loadWorkflowLockEntryAtSha({
      registration: registration('a', 's1'),
      sha: 's1',
      providerRegistry,
    });

    expect(fetchLockFile).not.toHaveBeenCalled();
    expect(atSha.depCacheKey).toEqual({ lockfileHash: 'current-lock-a', siblingsDigest: null });
  });

  it('refuses when the lock file at the commit does not define the workflow', async () => {
    const { providerRegistry } = registryWith({ workflows: [entry('other', 'x')] });

    await expect(
      loadWorkflowLockEntryAtSha({
        registration: registration('a', 's2'),
        sha: 's1',
        providerRegistry,
      }),
    ).rejects.toThrow(/workflow 'a' is not defined in org\/ci's lock file at s1/);
  });
});
