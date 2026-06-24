/**
 * Step-approval bridge — correlates a step-scoped `held_runs` row with the
 * agent that is blocking the step loop, so the resolution (approve / reject /
 * expire) can be relayed back to that agent as a `step.approval-resolved`
 * message.
 *
 * Flow:
 *   1. The agent sends `step.approval-request`; the WS handler calls
 *      `request()`, which creates a step-scoped hold (via `createStepHold`) and
 *      returns a promise that the handler awaits.
 *   2. A human approves (the dashboard / CLI `applyDecision` calls
 *      `onStepRelease` → `resolve(holdId, 'approved')`), or the hold is rejected
 *      (`resolve(holdId, 'rejected')`), or the stale detector expires it
 *      (`resolve(holdId, 'expired')`).
 *   3. The pending promise settles; the WS handler sends `step.approval-resolved`
 *      to the originating agent.
 *
 * On agent disconnect the bridge rejects that agent's pending waits so the
 * handler's `ws.send` is skipped (the socket is gone) and the hold is left for
 * the stale detector / a manual decision.
 */
import { HoldScope, TriggerSource, type ApprovalRequirement } from '@kici-dev/engine';

import type { HeldRunStore } from '../environments/held-runs.js';
import type { AccessLogWriter } from '../audit/access-log.js';

/** Outcome relayed back to the waiting agent. */
export type StepApprovalOutcome = 'approved' | 'rejected' | 'expired';

/** A single in-flight step-approval wait. */
interface PendingStepApproval {
  agentId: string;
  resolve: (resolution: { outcome: StepApprovalOutcome; reason?: string }) => void;
  reject: (err: Error) => void;
}

/** Arguments to open a step-scoped approval hold. */
export interface StepApprovalRequest {
  agentId: string;
  runId: string;
  jobId: string;
  stepIndex: number;
  stepName: string;
  clauses: Array<{ team: string } | { user: string }>;
  reason: string;
  /** Per-gate timeout (seconds); falls back to the org default. */
  timeoutSeconds?: number;
  /** Computed drift payload for a `when: 'drift'` gate; persisted on the hold. */
  payload?: { summaryMarkdown: string; drift: unknown };
}

/** Dependencies injected into the bridge. */
export interface StepApprovalBridgeDeps {
  store: HeldRunStore;
  /**
   * Resolve the orchestrator's tenant org id (same value the dashboard handler
   * uses to read held_runs). A function because the org is resolved post-auth
   * for sourceless orchestrators.
   */
  resolveOrgId: () => string;
  /** Resolve the authoritative approval expiry (seconds) for an org. */
  resolveExpirySeconds: (orgId: string) => Promise<number>;
  /**
   * Access-log writer for the orchestrator audit stream. Optional -- if not
   * set, the step-hold creation audit row (`held_run.request`) is skipped.
   */
  accessLogWriter?: AccessLogWriter;
  /** Routing key recorded on the audit row. Optional. */
  routingKey?: string | null;
}

/**
 * Owns the step-scoped held_runs rows and the map from holdId → the waiting
 * agent's resolver. The only place that opens a step hold and the only place
 * that settles a step-scoped wait.
 */
export class StepApprovalBridge {
  private readonly pending = new Map<string, PendingStepApproval>();

  constructor(private readonly deps: StepApprovalBridgeDeps) {}

  /**
   * Create a step-scoped hold and return a promise that settles when the hold
   * is approved / rejected / expired (via {@link resolve}).
   */
  async request(
    req: StepApprovalRequest,
  ): Promise<{ outcome: StepApprovalOutcome; reason?: string }> {
    const orgId = this.deps.resolveOrgId();
    const expirySeconds = req.timeoutSeconds ?? (await this.deps.resolveExpirySeconds(orgId));
    const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();
    const requirement: ApprovalRequirement = {
      clauses: req.clauses,
      expiresAt,
      reason: req.reason,
    };

    const hold = await this.deps.store.createHold(orgId, {
      runId: req.runId,
      jobId: req.jobId,
      scope: HoldScope.enum.step,
      stepIndex: req.stepIndex,
      triggerSource: TriggerSource.enum.explicit,
      requirement,
      ...(req.payload !== undefined && { payload: req.payload }),
    });

    // Audit the step-hold creation. The agent requested the hold while
    // executing the step (no Keycloak user context), so the actor is the
    // dispatcher system component.
    void this.deps.accessLogWriter?.record({
      orgId,
      routingKey: this.deps.routingKey ?? null,
      actor: { type: 'system', component: 'dispatcher' },
      action: 'held_run.request',
      target: { type: 'held_run', id: hold.id },
      requestId: null,
      source: 'platform_proxy',
      outcome: 'allowed',
      meta: {
        runId: req.runId,
        jobId: req.jobId,
        holdScope: HoldScope.enum.step,
        stepIndex: req.stepIndex,
      },
    });

    return new Promise<{ outcome: StepApprovalOutcome; reason?: string }>((resolve, reject) => {
      this.pending.set(hold.id, { agentId: req.agentId, resolve, reject });
    });
  }

  /**
   * Settle a step-scoped wait. Called by the approve/reject applier
   * (`onStepRelease`) and by the stale detector (`expired`). A no-op when no
   * agent is waiting on the hold (e.g. the agent already disconnected).
   */
  resolve(holdId: string, outcome: StepApprovalOutcome, reason?: string): boolean {
    const entry = this.pending.get(holdId);
    if (!entry) return false;
    this.pending.delete(holdId);
    entry.resolve({ outcome, ...(reason !== undefined && { reason }) });
    return true;
  }

  /**
   * Reject every pending wait for a disconnected agent. The held_runs rows are
   * left as-is (the stale detector will expire them) — only the in-memory
   * resolver is dropped so the handler's relayed `ws.send` is skipped.
   */
  failAgent(agentId: string): void {
    for (const [holdId, entry] of this.pending) {
      if (entry.agentId === agentId) {
        this.pending.delete(holdId);
        entry.reject(new Error('agent disconnected'));
      }
    }
  }

  /** Number of in-flight step-approval waits (test/diagnostics). */
  size(): number {
    return this.pending.size;
  }
}
