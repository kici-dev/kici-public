/**
 * Step-approval bridge — correlates a step-scoped `held_runs` row with the
 * agent blocking its step loop, so the resolution is relayed back to that agent
 * as `step.approval-resolved`.
 *
 * Flow:
 *   1. On `step.approval-request` the WS handler awaits `request()`, which
 *      creates a step-scoped hold (via the hold store's `createHold`).
 *   2. `applyDecision`'s `onStepRelease` calls `resolve(holdId, 'approved')`, a
 *      reject calls `resolve(holdId, 'rejected')`, or the stale detector calls
 *      `resolve(holdId, 'expired')`.
 *   3. The handler sends `step.approval-resolved` to the originating agent.
 *
 * On agent disconnect its pending waits reject, so the handler skips `ws.send`
 * and the hold is left for the stale detector / a manual decision.
 */
import {
  HoldScope,
  TriggerSource,
  approvalTimeoutSecondsSchema,
  type ApprovalRequirement,
} from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

import type { HeldRunStore } from '../contexts/held-runs.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'step-approval-bridge' });

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
   * The tenant org id the dashboard handler also reads held_runs with. A
   * function because a sourceless orchestrator resolves its org post-auth.
   */
  resolveOrgId: () => string;
  /** Resolve the authoritative approval expiry (seconds) for an org. */
  resolveExpirySeconds: (orgId: string) => Promise<number>;
  /** When unset, the `held_run.request` audit row is skipped. */
  accessLogWriter?: AccessLogWriter;
  /** Routing key recorded on the audit row. */
  routingKey?: string | null;
}

/**
 * Owns step-scoped held_runs rows and the holdId → waiting-agent resolver map:
 * the only place that opens a step hold or settles a step-scoped wait.
 */
export class StepApprovalBridge {
  private readonly pending = new Map<string, PendingStepApproval>();

  constructor(private readonly deps: StepApprovalBridgeDeps) {}

  /** Create a step-scoped hold; the promise settles via {@link resolve}. */
  async request(
    req: StepApprovalRequest,
  ): Promise<{ outcome: StepApprovalOutcome; reason?: string }> {
    if (
      req.timeoutSeconds !== undefined &&
      !approvalTimeoutSecondsSchema.safeParse(req.timeoutSeconds).success
    ) {
      return {
        outcome: 'rejected',
        reason: `approval timeout must be a positive integer number of seconds, got ${req.timeoutSeconds}`,
      };
    }
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

    // The agent requested the hold mid-step (no Keycloak user context), so the
    // actor is the dispatcher system component.
    runDetached(
      logger,
      'Access log write',
      () =>
        this.deps.accessLogWriter?.record({
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
        }),
      { runId: req.runId, heldRunId: hold.id },
    );

    return new Promise<{ outcome: StepApprovalOutcome; reason?: string }>((resolve, reject) => {
      this.pending.set(hold.id, { agentId: req.agentId, resolve, reject });
    });
  }

  /**
   * Called by the applier (`onStepRelease`) and the stale detector (`expired`).
   * A no-op when no agent waits on the hold (e.g. it already disconnected).
   */
  resolve(holdId: string, outcome: StepApprovalOutcome, reason?: string): boolean {
    const entry = this.pending.get(holdId);
    if (!entry) return false;
    this.pending.delete(holdId);
    entry.resolve({ outcome, ...(reason !== undefined && { reason }) });
    return true;
  }

  /**
   * Reject a disconnected agent's pending waits so the handler skips `ws.send`.
   * The held_runs rows stay for the stale detector to expire.
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
