/**
 * Route a released hold to the resume path its shape requires.
 *
 * Extracted so the callers — the approve/reject applier, the stale detector's
 * wait-timer sweep, and the `/kici approve|reject` comment handler — cannot
 * drift. The discrimination is scope AND trigger source: a workflow-scoped hold
 * raised by a policy resumes by rebuilding a workflow dispatch context, which
 * the workflow install gate and the org trust policy's PR-wide hold both store.
 * A workflow-scoped `explicit` hold has no such context, so it stays on the job
 * path — as does every job-scoped shape, which holds a real job and resumes by
 * re-dispatching it.
 *
 * A step-scoped hold that arrives with no step handler is DROPPED rather than
 * falling through to the job path. The step already ran up to its gate, so
 * re-dispatching its whole job would re-run the work before it.
 */
import { HoldScope, TriggerSource } from '@kici-dev/engine';
import type { ReleaseSignal } from '../contexts/held-runs.js';

/** The three resume paths a released hold can take. */
export interface ResumeHandlers {
  onStepRelease?: (signal: ReleaseSignal) => Promise<void>;
  onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  onJobRelease: (signal: ReleaseSignal) => Promise<void>;
}

export async function routeRelease(signal: ReleaseSignal, handlers: ResumeHandlers): Promise<void> {
  if (signal.scope === HoldScope.enum.step) {
    await handlers.onStepRelease?.(signal);
    return;
  }
  if (
    signal.scope === HoldScope.enum.workflow &&
    signal.triggerSource === TriggerSource.enum.context
  ) {
    await handlers.onWorkflowRelease?.(signal);
    return;
  }
  await handlers.onJobRelease(signal);
}
