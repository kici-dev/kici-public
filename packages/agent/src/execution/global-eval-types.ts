/**
 * Dispatch shape of a pre-run global eval round.
 *
 * Its own module because both the agent's job runner and the eval child read it,
 * and the child must not import the job runner.
 */

import type { GlobalEvalCandidate } from './global-eval-runner.js';

/**
 * `jobConfig` shape of a pre-run global eval round job.
 *
 * `roundTimeoutMs` / `candidateTimeoutMs` are optional so an older orchestrator
 * that does not send them still dispatches a runnable round; the agent falls
 * back to the defaults in `eval-context.ts`.
 */
export interface GlobalEvalRoundJobConfig {
  globalEvalRound: true;
  candidates: GlobalEvalCandidate[];
  event: Record<string, unknown>;
  workflowRepoUrl: string;
  workflowRef?: string;
  workflowSha?: string;
  workflowRepoIdentifier?: string;
  roundTimeoutMs?: number;
  candidateTimeoutMs?: number;
}
