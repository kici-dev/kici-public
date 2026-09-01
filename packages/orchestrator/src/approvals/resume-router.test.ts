import { describe, it, expect, vi } from 'vitest';
import { HoldScope, TriggerSource } from '@kici-dev/engine';
import { routeRelease } from './resume-router.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';

/** A released hold, job-scoped and context-triggered unless overridden. */
const signal = (over: Partial<ReleaseSignal> = {}): ReleaseSignal =>
  ({
    holdId: 'h1',
    runId: 'r1',
    jobId: 'build',
    stepIndex: null,
    scope: HoldScope.enum.job,
    triggerSource: TriggerSource.enum.context,
    ...over,
  }) as ReleaseSignal;

const handlers = () => ({
  onStepRelease: vi.fn().mockResolvedValue(undefined),
  onWorkflowRelease: vi.fn().mockResolvedValue(undefined),
  onJobRelease: vi.fn().mockResolvedValue(undefined),
});

describe('routeRelease', () => {
  it('sends a job-scoped context hold to the job path', async () => {
    // The wait-timer / concurrency case. Context-triggered but job-scoped, so it
    // resumes by re-dispatching the job — there is no workflow context to
    // rebuild, and routing it to the install-gate path would re-dispatch a whole
    // workflow.
    const h = handlers();
    await routeRelease(signal(), h);
    expect(h.onJobRelease).toHaveBeenCalledTimes(1);
    expect(h.onWorkflowRelease).not.toHaveBeenCalled();
    expect(h.onStepRelease).not.toHaveBeenCalled();
  });

  it('sends a workflow-scoped context hold to the install-gate path', async () => {
    const h = handlers();
    await routeRelease(signal({ scope: HoldScope.enum.workflow }), h);
    expect(h.onWorkflowRelease).toHaveBeenCalledTimes(1);
    expect(h.onJobRelease).not.toHaveBeenCalled();
  });

  it('sends a workflow-scoped EXPLICIT hold to the job path', async () => {
    // An explicit workflow-level requireApproval holds a real root job, so it has
    // a pending JOB context and no pending workflow context.
    const h = handlers();
    await routeRelease(
      signal({ scope: HoldScope.enum.workflow, triggerSource: TriggerSource.enum.explicit }),
      h,
    );
    expect(h.onJobRelease).toHaveBeenCalledTimes(1);
    expect(h.onWorkflowRelease).not.toHaveBeenCalled();
  });

  it('sends a step-scoped hold to the step bridge', async () => {
    const h = handlers();
    await routeRelease(signal({ scope: HoldScope.enum.step, stepIndex: 2 }), h);
    expect(h.onStepRelease).toHaveBeenCalledTimes(1);
    expect(h.onJobRelease).not.toHaveBeenCalled();
  });

  it('does not fall through to the job path when a step handler is absent', async () => {
    // A missing step bridge must drop the release, not silently re-dispatch the
    // whole job — the step already ran up to its gate.
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    await routeRelease(signal({ scope: HoldScope.enum.step }), { onJobRelease });
    expect(onJobRelease).not.toHaveBeenCalled();
  });
});
