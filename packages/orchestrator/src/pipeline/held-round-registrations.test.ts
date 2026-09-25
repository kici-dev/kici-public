import { describe, expect, it, vi } from 'vitest';
import type { LockWorkflow } from '@kici-dev/engine';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { HELD_ROUND_WORKFLOWS_KEY } from '../reporting/execution-tracker.js';
import { registrationsAtHeldCommit } from './held-round-registrations.js';

const WORKFLOW_REPO = 'org/ci';

function globalEntry(marker: string): LockWorkflow {
  return {
    name: 'org-lint',
    source: { file: marker },
    triggers: [{ _type: 'push', repos: ['org/*'] }],
    jobs: [],
  } as unknown as LockWorkflow;
}

function registration(commitSha: string, over: Partial<RegisteredWorkflow> = {}) {
  return {
    id: 'reg-1',
    repoIdentifier: WORKFLOW_REPO,
    workflowName: 'org-lint',
    lockEntry: globalEntry(`entry-at-${commitSha}`),
    triggerTypes: ['push'],
    routingKey: 'github:ci',
    providerContext: { installationId: 7 },
    disabled: false,
    isGlobal: true,
    customerId: 'org-1',
    commitSha,
    defaultBranch: 'main',
    sourceFile: '.kici/workflows/org-lint.ts',
    lockfileHash: `lock-at-${commitSha}`,
    siblingsDigest: `siblings-at-${commitSha}`,
    ...over,
  } satisfies RegisteredWorkflow;
}

function depsWith(reg: RegisteredWorkflow, heldLock: unknown) {
  const fetchLockFile = vi.fn().mockResolvedValue(heldLock);
  return {
    fetchLockFile,
    deps: {
      registrationIndex: { getAllByOrgAndRepo: () => [reg] },
      providerRegistry: { getByRoutingKey: () => ({ lockFileFetcher: { fetchLockFile } }) },
    } as never,
  };
}

const HELD_ROW = {
  customer_id: 'org-1',
  workflow_sha: 'a1',
  workflow_branch: 'main',
  trigger_decision: null,
};

describe('registrationsAtHeldCommit dependency-cache key', () => {
  it('carries the key of the lock file at the held commit when the registration moved on', async () => {
    // fails-when: the released round keys the dependency cache with the registration's current
    //   lock file while its build job checks out the held commit
    const { deps, fetchLockFile } = depsWith(registration('b2'), {
      lockfileHash: 'lock-at-a1',
      siblingsDigest: 'siblings-at-a1',
      workflows: [globalEntry('entry-at-a1')],
    });

    const [reg] = await registrationsAtHeldCommit({
      row: HELD_ROW,
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    expect(fetchLockFile).toHaveBeenCalledWith(WORKFLOW_REPO, 'a1', { installationId: 7 });
    expect(reg.lockEntry.source).toEqual({ file: 'entry-at-a1' });
    expect(reg.lockfileHash).toBe('lock-at-a1');
    expect(reg.siblingsDigest).toBe('siblings-at-a1');
  });

  it('carries no key when the lock file at the held commit records none', async () => {
    // breaks-if-wrong: a moved-on registration's key must not stand in for a commit that had none
    const { deps } = depsWith(registration('b2'), { workflows: [globalEntry('entry-at-a1')] });

    const [reg] = await registrationsAtHeldCommit({
      row: HELD_ROW,
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    expect(reg.lockfileHash).toBeNull();
    expect(reg.siblingsDigest).toBeNull();
  });

  it("keeps the registration's own key when it is at the held commit", async () => {
    // breaks-if-wrong: a registration already at the held commit keeps its key without a fetch
    const { deps, fetchLockFile } = depsWith(registration('a1'), null);

    const [reg] = await registrationsAtHeldCommit({
      row: HELD_ROW,
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    expect(fetchLockFile).not.toHaveBeenCalled();
    expect(reg.lockfileHash).toBe('lock-at-a1');
    expect(reg.siblingsDigest).toBe('siblings-at-a1');
  });
});

/** A held row whose hold recorded `workflows` as the round's covered set. */
function heldRowCovering(workflows: string[]) {
  return {
    ...HELD_ROW,
    trigger_decision: JSON.stringify({ [HELD_ROUND_WORKFLOWS_KEY]: workflows }),
  };
}

function namedEntry(name: string, marker: string): LockWorkflow {
  return { ...globalEntry(marker), name } as LockWorkflow;
}

describe('registrationsAtHeldCommit covered workflows', () => {
  it('fails the release, naming a recorded workflow the held commit does not define', async () => {
    // fails-when: the recorded workflow absent from the held lock is dropped and the round runs without it
    const fetchLockFile = vi.fn().mockResolvedValue({ workflows: [globalEntry('entry-at-a1')] });
    const lateAdded = registration('b2', { id: 'reg-2', workflowName: 'org-audit' });
    const both = {
      registrationIndex: { getAllByOrgAndRepo: () => [registration('b2'), lateAdded] },
      providerRegistry: { getByRoutingKey: () => ({ lockFileFetcher: { fetchLockFile } }) },
    } as never;

    await expect(
      registrationsAtHeldCommit({
        row: heldRowCovering(['org-lint', 'org-audit']),
        deps: both,
        workflowRepo: WORKFLOW_REPO,
        eventName: 'push',
      }),
    ).rejects.toThrow(/org-audit \(not in the lock file at the held commit\)/);
  });

  it('releases a recorded workflow the held commit defines', async () => {
    // breaks-if-wrong: the recorded-set check must not refuse a workflow present at the held commit
    const { deps } = depsWith(registration('b2'), { workflows: [globalEntry('entry-at-a1')] });

    const regs = await registrationsAtHeldCommit({
      row: heldRowCovering(['org-lint']),
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    expect(regs.map((reg) => reg.lockEntry.source)).toEqual([{ file: 'entry-at-a1' }]);
  });

  it('takes the last entry of a workflow the held lock file names twice', async () => {
    // fails-when: both entries are released, so the round runs the workflow twice, or the first wins
    const { deps } = depsWith(registration('b2'), {
      workflows: [namedEntry('org-lint', 'first'), namedEntry('org-lint', 'last')],
    });

    const regs = await registrationsAtHeldCommit({
      row: heldRowCovering(['org-lint']),
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    expect(regs.map((reg) => reg.lockEntry.source)).toEqual([{ file: 'last' }]);
  });

  it('releases every live registration of a workflow registered under two sources', async () => {
    const disabled = registration('a1', {
      id: 'reg-old',
      routingKey: 'github:old',
      disabled: true,
    });
    const first = registration('a1', { id: 'reg-a', routingKey: 'github:a' });
    const second = registration('a1', { id: 'reg-b', routingKey: 'github:b' });
    const deps = {
      registrationIndex: { getAllByOrgAndRepo: () => [disabled, first, second] },
      providerRegistry: { getByRoutingKey: () => undefined },
    } as never;

    // fails-when: the first registration alone decides, so its disabled flag refuses the release
    const regs = await registrationsAtHeldCommit({
      row: heldRowCovering(['org-lint']),
      deps,
      workflowRepo: WORKFLOW_REPO,
      eventName: 'push',
    });

    // breaks-if-wrong: each live source is released, as the pass the round was held from ran them
    expect(regs.map((reg) => reg.routingKey)).toEqual(['github:a', 'github:b']);
  });
});
