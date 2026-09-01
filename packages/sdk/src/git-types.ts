/**
 * Forge-typed git surface for workflow authors.
 *
 * The forge is a TYPE PARAMETER and nothing more. It is erased at runtime:
 * `kici.git.clone<'github'>()` against a Forgejo source compiles cleanly, the
 * requested permissions are ignored, and the result reports
 * `granted: { scoped: false }`. It buys autocomplete and a compile error on a
 * wrong-shaped permission object; it buys no safety. The runtime `granted`
 * value is the only source of truth about what a credential can do.
 */

/** Forges that can back a git credential. Mirrors the engine's `ForgeName`. */
export type ForgeName = 'github' | 'gitlab' | 'bitbucket' | 'generic';

/**
 * GitHub repository permissions.
 *
 * DELIBERATE CARVE-OUT from the enums-over-hardcoded-strings rule: the known
 * keys below are typed so editors autocomplete them, but an index signature
 * lets an unknown key through. GitHub adds permissions over time, and a closed
 * enum would mean a permission shipped yesterday needs an SDK release — and the
 * SDK is compat-protected and rides the single-version release train. Unknown
 * keys are passed to GitHub verbatim for it to accept or reject.
 */
export interface GitHubPermissions {
  contents?: 'read' | 'write';
  metadata?: 'read';
  workflows?: 'write';
  actions?: 'read' | 'write';
  pull_requests?: 'read' | 'write';
  issues?: 'read' | 'write';
  checks?: 'read' | 'write';
  statuses?: 'read' | 'write';
  deployments?: 'read' | 'write';
  packages?: 'read' | 'write';
  [permission: string]: string | undefined;
}

/**
 * Options for a write elevation, shaped by the forge.
 *
 * `WriteOptions<'generic'>` carries no permission fields at all: a static
 * credential has nothing to request, because an SSH key or PAT is read-write or
 * it is not.
 */
export type WriteOptions<F extends ForgeName = 'github'> = F extends 'github'
  ? { permissions: GitHubPermissions }
  : Record<never, never>;

/** What a credential turned out to be able to do. Never an echo of the request. */
export type GitGrant = { scoped: false } | { scoped: true; permissions: Record<string, string> };

/**
 * One half of a credential field pair. Exactly one form is set: a qualified
 * `<context>:<secret-name>` reference resolved from the secrets backend, or
 * material supplied at runtime.
 *
 * The field NAME is the discriminator, following the convention `workflow.ts`
 * already sets with `registries[].tokenSecret` and `isQualifiedSecretRef`.
 */
export type Sourced<Name extends string> =
  { [K in `${Name}Secret`]: string } | { [K in `${Name}Value`]: string };

/** Where credential material comes from, for each supported credential shape. */
export type GitCredentialRef =
  | ({ kind: 'app' } & Sourced<'appId'> & Sourced<'installationId'> & Sourced<'privateKey'>)
  | ({ kind: 'token'; user?: string } & Sourced<'token'>)
  | ({ kind: 'ssh' } & Sourced<'privateKey'>);

/** Named credentials for a job. `default` is used when a call names none. */
export type GitCredentialMap = Record<string, GitCredentialRef>;

/**
 * Resolve a call site's credential.
 *
 * Order: an explicit per-call value wins; otherwise `default` from the job map;
 * otherwise undefined, which means the source credential — all a read needs.
 *
 * An unknown name THROWS rather than falling back to `default`: silently using
 * a different credential than the author named is precisely the confusion this
 * map exists to remove.
 */
export function resolveCredential(
  perCall: string | GitCredentialRef | undefined,
  map: GitCredentialMap | undefined,
): GitCredentialRef | undefined {
  if (perCall && typeof perCall === 'object') return perCall;
  if (typeof perCall === 'string') {
    const found = map?.[perCall];
    if (!found) {
      throw new Error(
        `Unknown git credential '${perCall}'. Declare it in the job's ` +
          `gitCredentials map. Known: ${Object.keys(map ?? {}).join(', ') || '(none)'}`,
      );
    }
    return found;
  }
  return map?.default;
}

/**
 * Every credential field names a secret. Catch the easy, silent mistake of
 * pasting the credential itself — which would commit it to a git repository.
 */
export function assertSecretName(value: string, field: string, subject = 'git credential'): void {
  const looksLikeMaterial =
    value.startsWith('-----BEGIN') || /^gh[pousr]_/.test(value) || value.startsWith('github_pat_');
  if (looksLikeMaterial) {
    throw new Error(
      `${subject} '${field}' looks like the credential itself, not the name of ` +
        `a secret holding it. Store it with \`kici-admin secret set\` and name it here.`,
    );
  }
}

/**
 * Private-registry credentials for pulling a job's container image.
 *
 * Built from `Sourced<Name>` so "this field names a secret" has ONE spelling
 * across the SDK — the same one `gitCredentials` uses. `username` may be a
 * plain string (a registry username is not a secret); the token may not be.
 */
export type ContainerRegistryAuth = Sourced<'token'> & {
  /** Plain registry username. Mutually exclusive with `usernameSecret`. */
  username?: string;
  /**
   * Registry host these credentials belong to (e.g. `reg.internal:5000`).
   *
   * Optional with `container.image`, where it is derived from the image
   * reference. REQUIRED with `container.dockerfile`: the base image is named
   * inside the Dockerfile, so there is nothing to derive it from.
   */
  registry?: string;
} & Partial<Sourced<'username'>>;

/** A checked-out repository. The forge travels with the handle. */
export interface RepoHandle<F extends ForgeName = 'github'> {
  /** `owner/repo`. */
  identifier: string;
  /** Absolute path to the working tree. */
  path: string;
  ref?: string;
  sha?: string;
  /**
   * Run `fn` with write credentials for THIS repository.
   *
   * The grant is scoped to this repository and to the duration of `fn` — NOT to
   * the calling step. The agent runs one process per job and `parallel()` runs
   * its children inside it, so a concurrent sibling step can push to the same
   * repository while the grant is live. It cannot reach a different repository.
   *
   * Throws at entry — before any git runs — when the forge grants less than was
   * requested, naming the missing permission.
   */
  withWrite(opts: WriteOptions<F>, fn: () => Promise<void>): Promise<void>;
}

/** Result of an explicit token request. */
export interface GitTokenResult {
  token: string;
  expiresAt: string | null;
  granted: GitGrant;
}

/** Forge-specific minting. Only minted shapes appear here; static ones have nothing to mint. */
export interface GitHubApi {
  /**
   * Mint a token as a VALUE, for the forge API, the `gh` CLI, or a third-party
   * tool. Auto-masked in step logs; job-bound; throws outside a running step.
   *
   * For git operations prefer `handle.withWrite()`, which never puts a token in
   * the step environment. `gh` does not read git credential helpers, which is
   * why this exists.
   */
  getToken(opts: {
    repositories: string[];
    permissions: GitHubPermissions;
    /**
     * Name an entry in the job's `gitCredentials` map. Omit to use `default`;
     * omit both and the source credential applies.
     */
    credential?: string;
  }): Promise<GitTokenResult>;
}

export interface GitApi {
  github: GitHubApi;
}
