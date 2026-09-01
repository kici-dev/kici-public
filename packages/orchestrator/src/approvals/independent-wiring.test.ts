/**
 * The independent-mode approval composition.
 *
 * Every defect this closes is a MISSING FIELD, not a wrong algorithm — so the
 * assertions read the produced object rather than exercising a pipeline. The
 * one behavioural claim worth driving is laziness: the release callbacks must
 * read `buildProcessingDeps` when they fire, never when they are built, because
 * `createApp` populates it after the mode hook runs and reading it early
 * throws.
 *
 * The last block is the seam: a factory nothing spreads is a factory that
 * changes nothing, and `standalone.ts` runs `guardStartup` at import time so no
 * test can construct it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchReadyJob: vi.fn(async () => {}),
  resumeWorkflow: vi.fn(async () => {}),
}));

vi.mock('../pipeline/processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline/processor.js')>()),
  dispatchReadyJob: mocks.dispatchReadyJob,
}));

vi.mock('../pipeline/resume-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline/resume-workflow.js')>()),
  resumeWorkflow: mocks.resumeWorkflow,
}));

import { ContextStore } from '../contexts/context-store.js';
import { HeldRunStore, type ReleaseSignal } from '../contexts/held-runs.js';
import {
  createIndependentApprovalExtras,
  type IndependentApprovalSubsystems,
} from './independent-wiring.js';

const SIGNAL: ReleaseSignal = {
  holdId: 'hold-1',
  runId: 'run-1',
  jobId: 'job-1',
} as unknown as ReleaseSignal;

function subsystems(
  partial: Partial<IndependentApprovalSubsystems> = {},
): IndependentApprovalSubsystems {
  return {
    db: { marker: 'db' } as never,
    dispatcher: { marker: 'dispatcher' } as never,
    executionTracker: { marker: 'tracker' } as never,
    coordinator: { marker: 'coordinator' } as never,
    invokeGateDeps: { marker: 'invoke-gate' } as never,
    buildProcessingDeps: () => ({ marker: 'deps' }) as never,
    ...partial,
  };
}

describe('createIndependentApprovalExtras', () => {
  it('produces the held-run store, so an independent orchestrator can raise a hold at all', () => {
    // Without it the fork switch's `hold` verdict writes no row, `/kici
    // approve` returns before it looks at anything, and an SDK
    // `requireApproval` job dispatches UNGATED.
    expect(createIndependentApprovalExtras(subsystems()).heldRunStore).toBeInstanceOf(HeldRunStore);
  });

  it('produces no step-approval bridge', () => {
    // Deliberate, not an omission: a step hold is answered only by the
    // Platform-relayed dashboard applier, so wiring the bridge here would let
    // an agent open a hold nothing could resolve short of expiry.
    expect(createIndependentApprovalExtras(subsystems())).not.toHaveProperty('stepApprovalBridge');
  });

  it('reads the processing-deps bag when a workflow release FIRES, not when it is wired', async () => {
    // `createApp` populates the bag after the mode hook returns, and reading it
    // early throws. A wiring-time read would take the whole boot down.
    const buildProcessingDeps = vi.fn(() => ({ marker: 'deps' }) as never);
    const extras = createIndependentApprovalExtras(subsystems({ buildProcessingDeps }));
    expect(buildProcessingDeps).not.toHaveBeenCalled();

    await extras.onWorkflowRelease(SIGNAL);
    expect(buildProcessingDeps).toHaveBeenCalledTimes(1);
    expect(mocks.resumeWorkflow).toHaveBeenCalledWith(SIGNAL, { marker: 'deps' }, { marker: 'db' });
  });

  it('re-reads the bag on every release, so a swapped subsystem is picked up', async () => {
    const buildProcessingDeps = vi.fn(() => ({ marker: 'deps' }) as never);
    const extras = createIndependentApprovalExtras(subsystems({ buildProcessingDeps }));
    await extras.onWorkflowRelease(SIGNAL);
    await extras.onWorkflowRelease(SIGNAL);
    expect(buildProcessingDeps).toHaveBeenCalledTimes(2);
  });

  it('re-dispatches the one held job on a job-scoped release, with the live subsystems', async () => {
    mocks.dispatchReadyJob.mockClear();
    const sub = subsystems();
    const extras = createIndependentApprovalExtras(sub);
    await extras.onJobRelease(SIGNAL);
    expect(mocks.dispatchReadyJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      sub.dispatcher,
      sub.executionTracker,
      sub.coordinator,
      sub.db,
      sub.invokeGateDeps,
      // Releasing a hold frees no slot, so the re-gate has to be armed here too.
      // It must mint its re-hold into the SAME store the stale detector sweeps;
      // a second instance would raise holds nothing ever releases.
      { matchContext: expect.any(Function), heldRunStore: extras.heldRunStore },
    );
  });

  it('resolves a concurrency group through the context store', async () => {
    const matchContext = vi
      .spyOn(ContextStore.prototype, 'matchContext')
      .mockResolvedValue({ concurrency_limit: 3 } as never);
    try {
      const resolved = await createIndependentApprovalExtras(subsystems()).matchContext(
        'org-1',
        'prod',
      );
      expect(matchContext).toHaveBeenCalledWith('org-1', 'prod');
      expect(resolved).toEqual({ concurrency_limit: 3 });
    } finally {
      matchContext.mockRestore();
    }
  });
});

describe('standalone.ts wiring seam', () => {
  const source = readFileSync(fileURLToPath(new URL('../standalone.ts', import.meta.url)), 'utf8');

  it('spreads the approval extras into appDepsExtras', () => {
    // A factory nothing spreads changes nothing, and this entry point cannot be
    // imported by a test (it runs `guardStartup` at module scope), so the seam
    // is asserted against the source. Both halves matter: the construction, and
    // the spread that puts it where `createApp` and the stale detector read it.
    expect(source).toMatch(/const approvals = createIndependentApprovalExtras\(sub\)/);
    const extras = source.slice(source.indexOf('appDepsExtras: {'));
    expect(extras.slice(0, extras.indexOf('\n        },'))).toContain('...approvals,');
  });
});
