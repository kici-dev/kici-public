/**
 * CloneTokenProvider interface.
 *
 * Creates short-lived authentication tokens for agent repo clone operations.
 * Each provider has its own auth model for generating temporary access.
 */

import type { ProviderType } from './types.js';

/**
 * Structured auth material returned by `issueGitAuth()`.
 *
 * Mirrors the shape of `gitAuthSchema` on the orchestrator-agent protocol —
 * declared here in a browser-safe form (no Zod import) so provider modules
 * can stay on the barrel export. The protocol module validates dispatch
 * messages using the Zod version.
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
   * Create a short-lived token for cloning a repo.
   *
   * The token is passed to the agent for git clone authentication.
   * Token format and lifetime are provider-specific:
   * - GitHub: installation access token (1 hour)
   * - GitLab: project/group access token or OAuth token
   * - Bitbucket: app password or OAuth token
   *
   * @param repoIdentifier - Provider-specific repo identifier
   * @param credentials - Provider-specific credentials (e.g., GitHub App key + installation ID)
   * @returns Token string for git clone auth, or null if public repo / no auth needed
   */
  createCloneToken(repoIdentifier: string, credentials: unknown): Promise<string | null>;

  /**
   * Issue structured clone auth for the dispatch protocol's `sourceAuth` /
   * `workflowAuth` fields. Optional — when a provider implements it, the
   * orchestrator prefers this over `createCloneToken` so it can carry the
   * auth `kind` (basic vs ssh) and username alongside the secret material.
   *
   * Providers that only support HTTPS Basic auth (e.g. GitHub App install
   * tokens) can safely omit this — the orchestrator synthesizes
   * `{ kind: 'basic', user: 'x-access-token', secret: <token> }` from
   * `createCloneToken`'s return value as a fallback.
   *
   * @returns Structured auth, or null when the provider has no credential.
   */
  issueGitAuth?(repoIdentifier: string, credentials: unknown): Promise<ProviderGitAuth | null>;
}
