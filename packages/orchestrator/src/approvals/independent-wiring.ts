/**
 * The approval subsystem an INDEPENDENT orchestrator runs on.
 *
 * `server.ts` composes this inline for the three Platform-attached modes. An
 * independent orchestrator has no Platform and therefore none of that hook, so
 * every gate that raises a hold was inert there: a fork PR the org policy said
 * to HOLD was dropped instead of held, an SDK `requireApproval` job ran
 * UNGATED (the dispatch site logged an error and dispatched anyway), and the
 * stale detector had no store through which to expire an overdue hold,
 * terminalize its `KiCI Security` check, or drop the pending dispatch context
 * it would have replayed.
 *
 * It lives here rather than inside `standalone.ts` because that module is an
 * entry point: it runs `guardStartup` at import time, so nothing can construct
 * its wiring in a test. A factory can be constructed, and the fields it
 * produces can be asserted — which is the whole point, since every defect this
 * closes was a missing field rather than a wrong algorithm.
 *
 * What it deliberately does NOT produce is a `stepApprovalBridge`. A
 * step-scoped hold is opened by the agent WS `onStepApproval` seam and answered
 * by the dashboard applier, which is Platform-relayed and has no
 * independent-mode equivalent — so wiring the bridge would let an agent open a
 * hold nothing could resolve short of expiry.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { ContextStore } from '../contexts/context-store.js';
import { HeldRunStore, type ReleaseSignal } from '../contexts/held-runs.js';
import {
  dispatchReadyJob,
  type ProcessingDeps,
  type ReadyDispatchContextRow,
} from '../pipeline/processor.js';
import { resumeWorkflow } from '../pipeline/resume-workflow.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { RunCoordinator } from '../cluster/coordinator.js';
import type { InvokeGateDeps } from '../pipeline/invoke-gate.js';

/** The subsystem fields the composition reads. A subset of `OrchestratorSubsystems`. */
export interface IndependentApprovalSubsystems {
  db: Kysely<Database>;
  dispatcher: Dispatcher;
  executionTracker?: ExecutionTracker | undefined;
  coordinator?: RunCoordinator | undefined;
  invokeGateDeps?: InvokeGateDeps | undefined;
  /**
   * The live direct-ingress deps bag. Read lazily inside the release callbacks:
   * it is populated by `createApp`, which runs after the mode hook, and reading
   * it at wiring time throws.
   */
  buildProcessingDeps: () => ProcessingDeps;
}

/** What the independent mode hook merges into `appDepsExtras`. */
export interface IndependentApprovalExtras {
  heldRunStore: HeldRunStore;
  onWorkflowRelease: (signal: ReleaseSignal) => Promise<void>;
  onJobRelease: (signal: ReleaseSignal) => Promise<void>;
  matchContext: (orgId: string, name: string) => Promise<ReadyDispatchContextRow | null>;
}

export function createIndependentApprovalExtras(
  sub: IndependentApprovalSubsystems,
): IndependentApprovalExtras {
  // Reaches BOTH the dispatch pipeline (through `createApp`'s deps bag, which
  // is where a hold is raised and where `/kici approve` releases one) and the
  // stale detector (through `orchestrator-core`, which reads it off these
  // extras) — the second is what expires a hold nobody answered.
  const heldRunStore = new HeldRunStore(sub.db);

  // Stateless over the database handle. Constructed unconditionally, unlike the
  // context store the dispatch pipeline gets: this one only lets the stale
  // detector's queued-concurrency sweep READ a group's configured limit, which
  // cannot create a hold and is inert on a deployment that has no contexts.
  const contextStore = new ContextStore(sub.db);

  return {
    heldRunStore,

    // Resume a workflow-scoped hold whose wait timer elapsed or whose
    // concurrency slot freed, through the SAME deps bag the dispatch that
    // created the hold used — a second, hand-assembled bag could diverge from
    // it silently.
    onWorkflowRelease: (signal) => resumeWorkflow(signal, sub.buildProcessingDeps(), sub.db),

    // A JOB-scoped wait-timer hold has a pending job context rather than a
    // pending workflow context, so it resumes by re-dispatching the one job it
    // held instead of replaying the whole dispatch.
    onJobRelease: async (signal) => {
      await dispatchReadyJob(
        signal.runId,
        signal.jobId,
        sub.dispatcher,
        sub.executionTracker,
        sub.coordinator,
        sub.db,
        sub.invokeGateDeps,
        // Releasing the hold does not reserve the slot, so the group's
        // concurrency limit is re-checked before the job dispatches.
        {
          matchContext: (o, n) => contextStore.matchContext(o, n),
          heldRunStore,
          // Read lazily: `createApp` builds the deps bag after the mode hook runs.
          accessLogWriter: sub.buildProcessingDeps().accessLogWriter,
        },
      );
    },

    matchContext: (orgId, name) =>
      contextStore.matchContext(orgId, name) as Promise<ReadyDispatchContextRow | null>,
  };
}
