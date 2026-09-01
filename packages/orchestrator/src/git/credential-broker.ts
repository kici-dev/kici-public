/**
 * Resolves a git credential reference to material plus the grant it actually
 * obtained.
 *
 * Two axes, deliberately orthogonal:
 *   - shape  — minted (a GitHub App token) or static (PAT / Basic / SSH)
 *   - origin — a source credential the orchestrator already holds, a secret
 *              resolved from the secrets backend, or a secret output inherited
 *              from an upstream job
 *
 * Origin is a reference, not a third backend: all of them feed the same two
 * shapes.
 *
 * The broker reports what it granted and never echoes the request. A static
 * credential is `{ scoped: false }` because an SSH key or PAT cannot be
 * narrowed after the fact, and recording a request as if it had been honoured
 * would be a lie in an audit log.
 *
 * Knows nothing about git, clones, or agents.
 */

import type { GitCredentialRef, GitCredentialResult, ProviderGitAuth } from '@kici-dev/engine';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import { mintInstallationToken, type MintedToken } from './installation-token.js';

/** Injected so tests need no network and so the mint seam stays explicit. */
type MintFn = (args: {
  appId: string;
  privateKey: string;
  installationId: string;
  repositories: readonly string[];
  permissions?: Readonly<Record<string, string>>;
}) => Promise<MintedToken>;

/**
 * Reads one secret output this job inherited from a `needs` upstream. Injected
 * rather than constructed so the broker needs no database in unit tests, and so
 * the decryption stays in the one place that already owns it.
 */
type SecretOutputFn = (runId: string, jobId: string, key: string) => Promise<string | null>;

/** The reserved context naming an inherited secret output rather than a store. */
const NEEDS_CONTEXT = 'needs';

export interface BrokerResolveArgs {
  orgId: string;
  repositories: readonly string[];
  /** Omit for the source credential the orchestrator already holds. */
  ref?: GitCredentialRef;
  permissions?: Readonly<Record<string, string>>;
  runId?: string;
  jobId?: string;
}

export class GitCredentialBroker {
  private readonly secretResolver: SecretResolverApi;
  private readonly sourceAuth: (repository: string) => Promise<ProviderGitAuth | null>;
  private readonly mint: MintFn;
  private readonly secretOutputs: SecretOutputFn | undefined;

  constructor(deps: {
    secretResolver: SecretResolverApi;
    /**
     * Yields the source credential for a repository — normally
     * `bundle.cloneTokenProvider.issueGitAuth(...)`. Injected rather than
     * constructed so there is one source-credential path, not two.
     */
    sourceAuth: (repository: string) => Promise<ProviderGitAuth | null>;
    mint?: MintFn;
    secretOutputs?: SecretOutputFn;
  }) {
    this.secretResolver = deps.secretResolver;
    this.sourceAuth = deps.sourceAuth;
    this.mint = deps.mint ?? mintInstallationToken;
    this.secretOutputs = deps.secretOutputs;
  }

  async resolve(args: BrokerResolveArgs): Promise<GitCredentialResult> {
    // No ref => the source credential the orchestrator already holds for this
    // job. Reuses the existing CloneTokenProvider rather than a second path.
    const ref = args.ref ?? (await this.sourceRef(args));

    switch (ref.kind) {
      case 'ssh': {
        const secret = await this.sourced(args, ref, 'privateKey');
        return { kind: 'ssh', secret, grant: { scoped: false }, expiresAt: null };
      }
      case 'token': {
        const secret = await this.sourced(args, ref, 'token');
        return {
          kind: 'basic',
          user: ref.user ?? 'x-access-token',
          secret,
          grant: { scoped: false },
          expiresAt: null,
        };
      }
      case 'app': {
        const [appId, installationId, privateKey] = await Promise.all([
          this.sourced(args, ref, 'appId'),
          this.sourced(args, ref, 'installationId'),
          this.sourced(args, ref, 'privateKey'),
        ]);
        const minted = await this.mint({
          appId,
          installationId,
          privateKey,
          repositories: args.repositories,
          ...(args.permissions ? { permissions: args.permissions } : {}),
        });
        return {
          kind: 'basic',
          user: 'x-access-token',
          secret: minted.token,
          grant: { scoped: true, permissions: minted.grantedPermissions },
          expiresAt: minted.expiresAt,
        };
      }
    }
  }

  /**
   * The source credential, as a ref. Delegates to the dispatch bundle's
   * existing `CloneTokenProvider` — the same object that already mints the
   * clone token today — so there is exactly one source-credential path, not two.
   *
   * It arrives as material the orchestrator already holds, so it uses the
   * `*Value` form: there is no secret-store entry to name.
   */
  private async sourceRef(args: BrokerResolveArgs): Promise<GitCredentialRef> {
    // The source credential belongs to the SOURCE, not to any one repository,
    // so the first entry is as good as any for looking it up.
    const primary = args.repositories[0]!;
    const auth = await this.sourceAuth(primary);
    if (!auth) {
      throw new Error(
        `No source credential is configured for '${primary}'. ` +
          `Supply an explicit credential for this repository.`,
      );
    }
    return auth.kind === 'ssh'
      ? { kind: 'ssh', privateKeyValue: auth.secret }
      : { kind: 'token', tokenValue: auth.secret, ...(auth.user ? { user: auth.user } : {}) };
  }

  /**
   * Read one `<name>Secret` / `<name>Value` pair.
   *
   * `*Value` is material — return it verbatim. `*Secret` is a qualified
   * `<context>:<secret-name>` reference, so the CONTEXT comes from the
   * reference itself rather than being inferred, matching
   * `isQualifiedSecretRef` in `packages/sdk/src/workflow.ts`.
   */
  private async sourced(
    args: BrokerResolveArgs,
    ref: GitCredentialRef,
    name: string,
  ): Promise<string> {
    const bag = ref as unknown as Record<string, string | undefined>;
    const material = bag[`${name}Value`];
    if (typeof material === 'string') return material;

    const qualified = bag[`${name}Secret`];
    if (!qualified) {
      throw new Error(`git credential is missing '${name}Secret' (or '${name}Value')`);
    }
    const idx = qualified.indexOf(':');
    if (idx <= 0 || idx >= qualified.length - 1) {
      throw new Error(
        `git credential '${name}Secret' must be a qualified <context>:<secret-name> ` +
          `reference (got: ${qualified})`,
      );
    }
    return this.resolveQualified(args, qualified.slice(0, idx), qualified.slice(idx + 1));
  }

  /** Route a qualified reference to the store that owns it. */
  private async resolveQualified(
    args: BrokerResolveArgs,
    context: string,
    key: string,
  ): Promise<string> {
    if (context === NEEDS_CONTEXT) return this.resolveInherited(args, key);

    const value = await this.secretResolver.resolveNamed(args.orgId, context, key, {
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.jobId ? { jobId: args.jobId } : {}),
    });
    if (value === null) {
      throw new Error(`Git credential secret not found: context=${context} key=${key}`);
    }
    return value;
  }

  /**
   * Resolve a secret output this job inherited from a `needs` upstream.
   *
   * Reads the existing run-scoped store rather than adding a second one: the
   * value was written by `ctx.setSecretOutput`, is encrypted at rest, and is
   * deleted when the run completes.
   */
  private async resolveInherited(args: BrokerResolveArgs, key: string): Promise<string> {
    if (!this.secretOutputs || !args.runId || !args.jobId) {
      throw new Error(
        `Cannot resolve 'needs:${key}' — inherited secret outputs are only available ` +
          `to a running job.`,
      );
    }
    const inherited = await this.secretOutputs(args.runId, args.jobId, key);
    if (inherited === null) {
      throw new Error(
        `No secret output '${key}' was inherited by this job. Check that the ` +
          `producing job calls ctx.setSecretOutput('${key}', …) and is listed in \`needs\`.`,
      );
    }
    return inherited;
  }
}
