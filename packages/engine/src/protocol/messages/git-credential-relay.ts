/**
 * Agent → orchestrator relay for git credentials.
 *
 * The agent's credential helper calls this on every git network operation, so
 * a token is always minted seconds before use — which is what defeats the
 * one-hour GitHub App installation-token expiry for arbitrarily long jobs.
 *
 * Mirrors the browser-safe types in `provider/git-credential.ts`; this module
 * is the validating half and is the only one that imports Zod.
 */

import { z } from 'zod';

/** Method name on the agent private API registry. */
export const GIT_CREDENTIAL_REQUEST_METHOD = 'git.credential.request';

/**
 * A repository must be named explicitly — no wildcards, no "every repo in the
 * installation". A write grant is therefore always a specific repository
 * written down in the workflow source and reviewable in a diff.
 */
const repositorySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.includes('*') && !v.includes('?'), {
    message: 'repository must be explicit — wildcards are not accepted',
  });

/**
 * Requested permissions.
 *
 * Deliberate carve-out from the enums-over-hardcoded-strings rule: GitHub adds
 * permissions over time, and a closed enum would mean a permission GitHub
 * shipped yesterday needs an SDK release before anyone can use it. Known keys
 * are typed in the SDK for autocomplete; here they pass through verbatim for
 * the forge itself to accept or reject.
 */
const permissionsSchema = z.record(z.string().min(1), z.string().min(1));

/**
 * Exactly one of `<name>Secret` / `<name>Value` per pair.
 *
 * `*Secret` is a qualified `<context>:<secret-name>` reference — the same form
 * `packages/sdk/src/workflow.ts` validates with `isQualifiedSecretRef` — so the
 * context travels with the reference and nothing has to infer a scope.
 * `*Value` is material supplied at runtime.
 */
function sourced(name: string) {
  const qualified = z
    .string()
    .min(1)
    .refine(
      (v) => {
        const i = v.indexOf(':');
        return i > 0 && i < v.length - 1 && !v.slice(i + 1).includes(':');
      },
      { message: `${name}Secret must be a qualified <context>:<secret-name> reference` },
    )
    // The easy, silent mistake: pasting the credential instead of naming it.
    // Caught here as well as in the SDK, because the wire is not trusted.
    .refine(
      (v) => !v.startsWith('-----BEGIN') && !/^gh[pousr]_/.test(v) && !v.startsWith('github_pat_'),
      {
        message:
          `${name}Secret looks like the credential itself, not the name of a secret ` +
          `holding it. Use ${name}Value if you genuinely have runtime material.`,
      },
    );

  return z
    .object({
      [`${name}Secret`]: qualified.optional(),
      [`${name}Value`]: z.string().min(1).optional(),
    })
    .refine(
      (o) =>
        Boolean((o as Record<string, unknown>)[`${name}Secret`]) !==
        Boolean((o as Record<string, unknown>)[`${name}Value`]),
      { message: `exactly one of ${name}Secret or ${name}Value must be set` },
    );
}

export const gitCredentialRefSchema = z.union([
  z
    .object({ kind: z.literal('app') })
    .and(sourced('appId'))
    .and(sourced('installationId'))
    .and(sourced('privateKey')),
  z.object({ kind: z.literal('token'), user: z.string().optional() }).and(sourced('token')),
  z.object({ kind: z.literal('ssh') }).and(sourced('privateKey')),
]);

export const gitCredentialRequestParamsSchema = z.object({
  jobId: z.string().min(1),
  /**
   * Every repository the credential must cover, most-specific first.
   *
   * A list rather than one name because a GitHub App token is minted per
   * installation and can name several repositories at once — which is the
   * point of `getToken({ repositories })`. The credential helper, which is
   * asked about one URL at a time, sends a one-element list.
   */
  repositories: z.array(repositorySchema).min(1),
  ref: gitCredentialRefSchema.optional(),
  permissions: permissionsSchema.optional(),
});
export type GitCredentialRequestParams = z.infer<typeof gitCredentialRequestParamsSchema>;

export const gitCredentialGrantSchema = z.discriminatedUnion('scoped', [
  z.object({ scoped: z.literal(false) }),
  z.object({ scoped: z.literal(true), permissions: permissionsSchema }),
]);

export const gitCredentialResultSchema = z.object({
  kind: z.enum(['basic', 'ssh']),
  user: z.string().optional(),
  secret: z.string(),
  grant: gitCredentialGrantSchema,
  expiresAt: z.string().nullable(),
});
export type GitCredentialRelayResult = z.infer<typeof gitCredentialResultSchema>;
