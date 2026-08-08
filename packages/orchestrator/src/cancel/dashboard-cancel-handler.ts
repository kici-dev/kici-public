/**
 * The cancel handler behind the dashboard, the `kici runs cancel` CLI, and the
 * MCP `cancel_run` tool.
 *
 * It delegates to `cancelRunWithReason` so the customer-facing cancel follows
 * the same mechanics as the operator-facing one: an already-terminal run is a
 * no-op, only OPEN agent sockets are notified, queued dispatch rows are
 * cancelled, pending jobs are marked cancelled, and a run with no outstanding
 * agent work is driven terminal.
 *
 * `cancelledJobs` counts notified agents plus pending/queued job rows marked
 * cancelled, matching the operator route.
 */
import { cancelRunWithReason, type CancelRunDeps } from './cancel-run.js';

export function createDashboardCancelHandler(deps: CancelRunDeps) {
  return async (
    runId: string,
    cancelledBy: string | null,
    cancelledByAgentLabel: string | null,
    force?: boolean,
  ): Promise<{ cancelledJobs: number; alreadyTerminal: boolean }> => {
    const reason = cancelledBy ? `run cancelled by ${cancelledBy}` : 'run cancelled via dashboard';
    const result = await cancelRunWithReason(deps, runId, reason, {
      ...(force != null && { force }),
      ...(cancelledBy != null && { cancelledBy }),
      ...(cancelledByAgentLabel != null && { cancelledByAgentLabel }),
    });
    return {
      cancelledJobs: result.agentsNotified + result.pendingCancelled,
      alreadyTerminal: result.alreadyTerminal,
    };
  };
}
