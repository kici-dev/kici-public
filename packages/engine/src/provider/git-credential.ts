/**
 * Git credential types shared by the orchestrator broker, the agent helper,
 * and the SDK surface.
 *
 * Browser-safe by construction: these types sit on the `provider/` barrel that
 * the dashboard transitively imports, so this module declares plain TypeScript
 * and imports no Zod. The validating mirror lives in
 * `protocol/messages/git-credential-relay.ts`.
 */

import type { ProviderType } from './types.js';

/**
 * A forge that can back a git credential. Derived from `ProviderType` rather
 * than declared alongside it so the two cannot drift. `'local'` is excluded —
 * it is an execution mode, not a forge.
 */
export type ForgeName = Exclude<ProviderType, 'local'>;

/**
 * One half of a credential field pair. Exactly one form is set: a qualified
 * `<context>:<secret-name>` reference resolved from the secrets backend, or
 * material supplied at runtime.
 *
 * The field NAME is the discriminator, so neither a reader nor the broker ever
 * has to guess whether a value is a key or a credential. This follows the
 * convention `packages/sdk/src/workflow.ts` already sets with
 * `registries[].tokenSecret` and `isQualifiedSecretRef`.
 */
export type Sourced<Name extends string> =
  { [K in `${Name}Secret`]: string } | { [K in `${Name}Value`]: string };

/** Where credential material comes from, for each supported credential shape. */
export type GitCredentialRef =
  | ({ kind: 'app' } & Sourced<'appId'> & Sourced<'installationId'> & Sourced<'privateKey'>)
  | ({ kind: 'token'; user?: string } & Sourced<'token'>)
  | ({ kind: 'ssh' } & Sourced<'privateKey'>);

/**
 * What a credential may actually do. Reported by the broker; never an echo of
 * what the caller requested.
 *
 * `scoped: false` means the credential could not be narrowed at all — every
 * static credential, where the key is read-write or it is not. `scoped: true`
 * carries the permission map the forge actually granted.
 */
export type GitCredentialGrant =
  { scoped: false } | { scoped: true; permissions: Readonly<Record<string, string>> };

/** A broker request: which repo, on whose behalf, with what asked for. */
export interface GitCredentialRequest {
  /** Repository identifier, e.g. `'kici-dev/kici-forge-app-token-tester'`. */
  repository: string;
  /** Omit for the source-scoped default credential. */
  ref?: GitCredentialRef;
  /**
   * Requested permissions. Meaningful only for a minted shape; ignored for a
   * static one, which reports `scoped: false`.
   */
  permissions?: Readonly<Record<string, string>>;
}

/** What the broker returns. `expiresAt` is null for a credential that does not expire. */
export interface GitCredentialResult {
  kind: 'basic' | 'ssh';
  user?: string;
  secret: string;
  grant: GitCredentialGrant;
  expiresAt: string | null;
}

/** True when the ref requires minting (and therefore per-operation refresh). */
export function isMintedRef(ref: GitCredentialRef): boolean {
  return ref.kind === 'app';
}
