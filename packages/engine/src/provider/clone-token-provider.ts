/** Short-lived auth tokens for agent repo clones, one implementation per provider. */

import type { ProviderType } from './types.js';

/**
 * Structured auth material returned by `issueGitAuth()`. Mirrors the protocol's
 * `gitAuthSchema` without a Zod import, so provider modules stay browser-safe
 * on the barrel; dispatch messages are validated with the Zod version.
 */
export interface ProviderGitAuth {
  kind: 'basic' | 'ssh';
  /** Basic-auth username. Omit for SSH. */
  user?: string;
  /** Basic-auth password/PAT, or PEM-encoded SSH private key. */
  secret: string;
  /** SSH-only. `accept-new` (default) or `pinned`. */
  sshHostKeyPolicy?: 'accept-new' | 'pinned';
  /** SSH-only, required when `sshHostKeyPolicy === 'pinned'`. */
  sshKnownHostsPem?: string;
}

export interface CloneTokenProvider {
  readonly provider: ProviderType;

  /**
   * Create a short-lived token the agent uses to authenticate `git clone`.
   * Format and lifetime are provider-specific:
   * - GitHub: installation access token (1 hour)
   * - GitLab: project/group access token or OAuth token
   * - Bitbucket: app password or OAuth token
   *
   * @param credentials - e.g. GitHub App key + installation ID
   * @returns null for a public repo / no auth needed
   */
  createCloneToken(repoIdentifier: string, credentials: unknown): Promise<string | null>;

  /**
   * Issue structured clone auth for the dispatch's `sourceAuth` /
   * `workflowAuth`. When implemented, the orchestrator prefers it over
   * `createCloneToken`, as it carries the auth `kind` and username too.
   *
   * A Basic-auth-only provider (e.g. GitHub App install tokens) can omit it:
   * the orchestrator synthesizes `{ kind: 'basic', user: 'x-access-token',
   * secret: <token> }` from `createCloneToken`.
   *
   * @returns Structured auth, or null when the provider has no credential.
   */
  issueGitAuth?(repoIdentifier: string, credentials: unknown): Promise<ProviderGitAuth | null>;
}
