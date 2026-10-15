/**
 * Dispatch shape of a pre-run global eval round, in its own module because the
 * job runner and the eval child both read it and the child must not import the
 * job runner.
 */

import type { GlobalEvalCandidate } from './global-eval-runner.js';

export interface GlobalEvalRoundJobConfig {
  globalEvalRound: true;
  candidates: GlobalEvalCandidate[];
  event: Record<string, unknown>;
  workflowRepoUrl: string;
  workflowRef?: string;
  workflowSha?: string;
  workflowRepoIdentifier?: string;
  roundTimeoutMs: number;
  candidateTimeoutMs: number;
}
