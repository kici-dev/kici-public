/**
 * Availability-gated fleet agent auto-upgrade — the `agentVersionConverge()`
 * check-step.
 *
 * Run on an ops agent (one holding `kici:capability:ssh-transport`), it
 * converges a target fleet host onto the orchestrator's own version:
 *
 * - **check** compares the host's staged version with the orchestrator target;
 *   a difference is drift. If the target's self-contained payloads are
 *   UNAVAILABLE for the host's platform, the drift is `blocked`: the runner
 *   surfaces it (held + alarmed) and a version skew is never applied.
 * - **apply** (run) re-stages the target payload and restarts the host's agent
 *   from THIS ops agent over SSH — no self-update-handoff. It THROWS on a
 *   `blocked` drift, on top of the check and the orchestrator-side gate.
 *
 * The re-stage is external because the host's own agent cannot swap its running
 * binary underneath itself; the host reconnects on its own persistent
 * credential.
 *
 * For a controlled, health-gated roll, combine with the run-level check mode and
 * `approval: { when: 'drift' }`.
 */
import { step } from '../step.js';
import type { Step } from '../types.js';

/** Drift the convergence check reports; `blocked` is never applied. */
export interface AgentVersionDrift {
  /** True when the target payloads are unavailable — hold, never apply. */
  blocked: boolean;
  /** The host's current staged version (null when never staged). */
  from: string | null;
  /** The orchestrator target version to converge onto. */
  to: string;
}

export interface AgentVersionConvergeOptions {
  /** Step name surfaced in logs / the dashboard. Defaults to `agent-version-converge`. */
  name?: string;
}

/**
 * Build a check-step that converges `targetAgentId` onto the orchestrator's
 * version, availability-gated (a missing payload holds the host, never a skew).
 * MUST run on an agent holding `kici:capability:ssh-transport`.
 */
export function agentVersionConverge(
  targetAgentId: string,
  opts: AgentVersionConvergeOptions = {},
): Step<{ restaged: boolean }, string> {
  return step(opts.name ?? 'agent-version-converge', {
    check: async (ctx): Promise<AgentVersionDrift | null> => {
      const status = await ctx.kici.bootstrap.agentVersionStatus(targetAgentId);
      if (status.stagedVersion === status.targetVersion) return null; // in sync
      return {
        blocked: !status.available,
        from: status.stagedVersion,
        to: status.targetVersion,
      };
    },
    summarize: (drift: AgentVersionDrift) =>
      drift.blocked
        ? `blocked: payload for ${drift.to} unavailable — holding ${targetAgentId} at ${drift.from ?? '(none)'}`
        : `agent ${targetAgentId}: ${drift.from ?? '(none)'} → ${drift.to}`,
    run: async (ctx, drift: AgentVersionDrift) => {
      if (drift.blocked) {
        throw new Error(
          `refusing to converge ${targetAgentId} to ${drift.to}: payload unavailable (held to avoid a version skew)`,
        );
      }
      ctx.log.info(`Re-staging ${targetAgentId}: ${drift.from ?? '(none)'} → ${drift.to}`);
      return ctx.kici.bootstrap.restageAgent(targetAgentId);
    },
    whenInSync: async () => ({ restaged: false }),
  }) as Step<{ restaged: boolean }, string>;
}
