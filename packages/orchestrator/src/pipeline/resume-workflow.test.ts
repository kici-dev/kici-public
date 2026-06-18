import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy dispatch giant so the round-trip test stays focused on the
// resume wiring (load context → rebuild → dispatch with gate skipped → delete).
const dispatchMatchedWorkflow = vi.fn().mockResolvedValue({ dispatchedJobCount: 1 });
vi.mock('./dispatch-matched-workflow.js', () => ({
  dispatchMatchedWorkflow: (...args: unknown[]) => dispatchMatchedWorkflow(...args),
}));

import { resumeWorkflow, rejectWorkflow } from './resume-workflow.js';
import {
  storePendingWorkflowContext,
  loadPendingWorkflowContext,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';
import type { ReleaseSignal } from '../environments/held-runs.js';
import { HoldScope, TriggerSource } from '@kici-dev/engine';

function makeInputs(): SerializableWorkflowDispatchInputs {
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
      payload: {},
    },
    payload: {},
    credentials: {},
    event: { type: 'push', targetBranch: 'main' },
    eventWithFiles: { type: 'push', targetBranch: 'main' },
    ref: 'sha',
    fullLockFile: { workflows: [], source: { file: '.kici/workflows/x.ts' } },
    workflow: { name: 'CI' },
    decision: { matched: true, workflowName: 'CI' },
    trustResolution: { tier: 'trusted' },
    lockFileSource: undefined,
    crossSource: false,
  } as unknown as SerializableWorkflowDispatchInputs;
}

const bundle = { normalizer: { provider: 'github' } };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(bundle) },
    executionTracker: {
      failRun: vi.fn().mockResolvedValue(undefined),
      cancelHeldRun: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any;
}

const signal: ReleaseSignal = {
  holdId: 'hold1',
  runId: 'run1',
  jobId: '__install__CI',
  scope: HoldScope.enum.workflow,
  stepIndex: null,
  triggerSource: TriggerSource.enum.environment,
};

describe('resumeWorkflow', () => {
  beforeEach(() => {
    clearPendingWorkflowContextsMap();
    dispatchMatchedWorkflow.mockClear();
  });

  it('rebuilds + re-dispatches with skipInstallProtectionGate and deletes the context', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps();
    await resumeWorkflow(signal, deps, undefined);

    expect(dispatchMatchedWorkflow).toHaveBeenCalledTimes(1);
    const [ctx, opts] = dispatchMatchedWorkflow.mock.calls[0];
    expect(ctx.deps).toBe(deps);
    expect(ctx.bundle).toBe(bundle);
    expect(ctx.runId).toBe('run1');
    expect(opts).toMatchObject({
      skipInstallProtectionGate: true,
      reuseHeldRunId: 'hold1',
      reuseRunId: 'run1',
    });
    // Context consumed after the resume dispatch is kicked off.
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('fails the run loudly when the pending context is lost', async () => {
    const deps = makeDeps();
    await resumeWorkflow(signal, deps, undefined);
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('pending context lost'),
      expect.objectContaining({ scope: 'run', category: 'install_secrets' }),
    );
  });

  it('fails the run when the provider bundle is unresolvable', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps({
      providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(undefined) },
    });
    await resumeWorkflow(signal, deps, undefined);
    expect(dispatchMatchedWorkflow).not.toHaveBeenCalled();
    expect(deps.executionTracker.failRun).toHaveBeenCalledWith(
      'run1',
      expect.stringContaining('provider bundle unresolvable'),
      expect.anything(),
    );
  });
});

describe('rejectWorkflow', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('cancels the held run and drops the pending context', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    const deps = makeDeps();
    await rejectWorkflow('run1', deps, undefined, 'install gate rejected');
    expect(deps.executionTracker.cancelHeldRun).toHaveBeenCalledWith(
      'run1',
      'install gate rejected',
    );
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });
});
