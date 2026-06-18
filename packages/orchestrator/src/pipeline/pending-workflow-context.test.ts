import { describe, it, expect, beforeEach } from 'vitest';
import {
  storePendingWorkflowContext,
  loadPendingWorkflowContext,
  deletePendingWorkflowContext,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';

function makeInputs(
  overrides: Partial<SerializableWorkflowDispatchInputs> = {},
): SerializableWorkflowDispatchInputs {
  return {
    runId: 'run1',
    resolvedOrgId: 'org1',
    repoIdentifier: 'a/b',
    info: {
      routingKey: 'github:1',
      deliveryId: 'd1',
      event: 'push',
      action: null,
      provider: 'github',
      payload: { ref: 'refs/heads/main' },
    },
    payload: { ref: 'refs/heads/main' },
    credentials: {},
    event: { type: 'push', targetBranch: 'main' },
    eventWithFiles: { type: 'push', targetBranch: 'main' },
    ref: 'sha',
    fullLockFile: { workflows: [], source: { file: '.kici/workflows/x.ts' } },
    workflow: { name: 'wf' },
    decision: { matched: true, workflowName: 'wf' },
    trustResolution: { tier: 'trusted' },
    lockFileSource: undefined,
    crossSource: false,
    ...overrides,
  } as unknown as SerializableWorkflowDispatchInputs;
}

describe('pending-workflow-context', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('stores and loads the serializable inputs by runId (memory path)', async () => {
    const inputs = makeInputs();
    await storePendingWorkflowContext(undefined, inputs);
    const got = await loadPendingWorkflowContext(undefined, 'run1');
    expect(got).toEqual(inputs);
  });

  it('returns null for an unknown runId', async () => {
    expect(await loadPendingWorkflowContext(undefined, 'nope')).toBeNull();
  });

  it('overwrites an existing entry for the same runId', async () => {
    await storePendingWorkflowContext(undefined, makeInputs({ ref: 'sha-1' }));
    await storePendingWorkflowContext(undefined, makeInputs({ ref: 'sha-2' }));
    const got = await loadPendingWorkflowContext(undefined, 'run1');
    expect(got?.ref).toBe('sha-2');
  });

  it('deletes the entry', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    await deletePendingWorkflowContext(undefined, 'run1');
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });
});
