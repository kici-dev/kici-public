/**
 * CheckStatusPoster interface for posting check statuses to git providers.
 *
 * Used by the CI security system to post approval/hold status checks
 * on PRs, enabling visibility into trust-tier gating decisions.
 */
import type { ProviderType } from './types.js';

/** Status values for a check run. */
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral';

/** Posts check statuses to a git hosting provider. */
export interface CheckStatusPoster {
  readonly provider: ProviderType;
  postCheckStatus(
    repoIdentifier: string,
    commitSha: string,
    status: CheckStatus,
    title: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
}
