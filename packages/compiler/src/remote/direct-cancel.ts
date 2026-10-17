/**
 * Cancel a run straight on an orchestrator, through its admin cancel route
 * (`POST /api/v1/admin/runs/:runId/cancel`).
 *
 * This is the route that cancels any run, webhook-triggered or not: the direct
 * `/api/v1/test/*` cancel only accepts runs `kici run remote` started. A local
 * plane's admin token and a `kici connect` token with the `run.cancel`
 * permission both work.
 */
import { normalizeOrchestratorUrl } from './target.js';

export interface DirectCancelResult {
  /** True when the run had already finished; nothing was cancelled. */
  alreadyTerminal: boolean;
  /** The run status the orchestrator reports after the cancel. */
  status?: string;
  cancelledJobs: number;
}

/** A failed cancel, carrying the orchestrator's own message. */
export class DirectCancelError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'DirectCancelError';
  }
}

export async function cancelRunDirect(
  orchestratorUrl: string,
  token: string,
  runId: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<DirectCancelResult> {
  const base = normalizeOrchestratorUrl(orchestratorUrl);
  const res = await (opts.fetchImpl ?? fetch)(
    `${base}/api/v1/admin/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: opts.force ?? false }),
    },
  );
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    status?: string;
    cancelledJobs?: number;
  };
  if (res.ok) {
    return { alreadyTerminal: false, status: body.status, cancelledJobs: body.cancelledJobs ?? 0 };
  }
  if (res.status === 409 && body.error === 'Run already in terminal state') {
    return { alreadyTerminal: true, status: body.status, cancelledJobs: 0 };
  }
  throw new DirectCancelError(
    `${base} refused to cancel run ${runId}: ${body.error ?? `HTTP ${res.status}`}`,
    res.status,
  );
}
