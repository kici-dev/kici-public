/**
 * The approval subsystem an INDEPENDENT orchestrator runs on.
 *
 * `server.ts` composes this inline for the three Platform-attached modes. An
 * independent orchestrator has no Platform hook, so without this every hold
 * gate is inert: a fork PR the policy says to HOLD is dropped, an SDK
 * `requireApproval` job runs UNGATED (the dispatch site logs an error and
 * dispatches anyway), and the stale detector has no store to expire an overdue
 * hold, terminalize its `KiCI Security` check, or drop its pending context.
 *
 * Not in `standalone.ts`: that entry point runs `guardStartup` at import time,
 * so no test can construct its wiring. A factory's fields can be asserted —
 * the point, since each defect this closes is a missing field.
 *
 * Deliberately NO `stepApprovalBridge`: a step hold is answered by the
 * Platform-relayed dashboard applier, which has no independent-mode
 * equivalent, so an agent could open a hold nothing resolves short of expiry.
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
   * The live direct-ingress deps bag. Read lazily: `createApp` populates it
   * after the mode hook, so reading it at wiring time throws.
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
  // Reaches BOTH the dispatch pipeline (via `createApp`'s deps bag: where a
  // hold is raised and `/kici approve` releases one) and the stale detector
  // (via `orchestrator-core`), which expires a hold nobody answered.
  const heldRunStore = new HeldRunStore(sub.db);

  // Constructed unconditionally, unlike the pipeline's context store: it only
  // lets the stale detector's queued-concurrency sweep READ a group's limit,
  // which cannot create a hold and is inert without contexts.
  const contextStore = new ContextStore(sub.db);

  return {
    heldRunStore,

    // Resumes a workflow-scoped hold whose wait timer elapsed or whose concurrency
    // slot freed, through the SAME deps bag the holding dispatch used — a
    // hand-assembled second bag could silently diverge.
    onWorkflowRelease: (signal) => resumeWorkflow(signal, sub.buildProcessingDeps(), sub.db),

    // A JOB-scoped wait-timer hold has a pending job context, so it
    // re-dispatches the one job instead of replaying the whole dispatch.
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
          contextData: () => sub.buildProcessingDeps(),
        },
      );
    },

    matchContext: (orgId, name) =>
      contextStore.matchContext(orgId, name) as Promise<ReadyDispatchContextRow | null>,
  };
}
