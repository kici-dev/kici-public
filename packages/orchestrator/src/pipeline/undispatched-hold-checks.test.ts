import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckRunConclusion } from '@kici-dev/engine';
import { completeUndispatchedHoldChecks } from './undispatched-hold-checks.js';
import {
  storePendingWorkflowContext,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';

function makeContext(over: Record<string, unknown> = {}): SerializableWorkflowDispatchInputs {
  return {
    runId: 'run1',
    resolvedOrgId: 'org1',
    repoIdentifier: 'acme/app',
    ref: 'cafebabe',
    credentials: { installationId: 42 },
    info: { provider: 'github', routingKey: 'github:1' },
    workflow: { name: 'CI', jobs: [{ _type: 'static', name: 'build' }] },
    ...over,
  } as unknown as SerializableWorkflowDispatchInputs;
}

function makeReporter() {
  const completeUndispatchedCheckRuns = vi.fn().mockResolvedValue(undefined);
  return {
    completeUndispatchedCheckRuns,
    reporter: { completeUndispatchedCheckRuns } as unknown as CheckRunReporter,
  };
}

describe('completeUndispatchedHoldChecks', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('is a no-op when no reporter is wired', async () => {
    await storePendingWorkflowContext(undefined, makeContext());
    await expect(
      completeUndispatchedHoldChecks({
        db: undefined,
        checkRunReporter: undefined,
        runId: 'run1',
        conclusion: CheckRunConclusion.enum.cancelled,
        summary: 's',
      }),
    ).resolves.toBeUndefined();
  });

  it('prefers the effective routing key and provider the setup phase overlaid', async () => {
    // `setupDispatchContext` posts the queued checks under the overlaid values,
    // and the GitHub App credential lookup keys on the routing key — so reading
    // `info` alone would authenticate a cross-source dispatch against the wrong
    // app and resolve nothing.
    await storePendingWorkflowContext(
      undefined,
      makeContext({ effectiveProvider: 'github', effectiveRoutingKey: 'github:99' }),
    );
    const { completeUndispatchedCheckRuns, reporter } = makeReporter();

    await completeUndispatchedHoldChecks({
      db: undefined,
      checkRunReporter: reporter,
      runId: 'run1',
      conclusion: CheckRunConclusion.enum.timed_out,
      summary: 'expired',
    });

    expect(completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    expect(completeUndispatchedCheckRuns.mock.calls[0][0]).toMatchObject({
      provider: 'github',
      routingKey: 'github:99',
    });
  });

  it('falls back to the pre-overlay routing key when no effective one was stored', async () => {
    // The control for the case above: a per-repository dispatch overlays
    // nothing, so `info` is the right source and the fallback must be reached.
    await storePendingWorkflowContext(undefined, makeContext());
    const { completeUndispatchedCheckRuns, reporter } = makeReporter();

    await completeUndispatchedHoldChecks({
      db: undefined,
      checkRunReporter: reporter,
      runId: 'run1',
      conclusion: CheckRunConclusion.enum.timed_out,
      summary: 'expired',
    });

    expect(completeUndispatchedCheckRuns.mock.calls[0][0]).toMatchObject({
      routingKey: 'github:1',
    });
  });

  it('refuses a repo identifier that is not owner/repo rather than addressing a half-name', async () => {
    await storePendingWorkflowContext(undefined, makeContext({ repoIdentifier: 'app' }));
    const { completeUndispatchedCheckRuns, reporter } = makeReporter();

    await completeUndispatchedHoldChecks({
      db: undefined,
      checkRunReporter: reporter,
      runId: 'run1',
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'rejected',
    });

    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
  });
});
