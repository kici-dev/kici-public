/**
 * Universal-git clone-token provider.
 *
 * Implements the `CloneTokenProvider` interface from `@kici-dev/engine` for
 * universal-git sources. Unlike GitHub — which mints a fresh installation
 * token via JWT — universal-git auth is entirely static: the customer stores
 * a long-lived PAT / Basic-auth password / SSH private key in the
 * orchestrator's secret store, and we resolve + return it verbatim at
 * dispatch time.
 *
 * The value returned here is the raw secret material:
 *   - `credentialType === 'pat' | 'basic'`: the PAT / password string
 *   - `credentialType === 'ssh'`: the PEM-encoded private key (the agent
 *     materializes it to a tempfile and wires `GIT_SSH_COMMAND` — see
 *     Phase 4 dispatch protocol + agent work)
 *
 * The token's "kind" (basic vs ssh) is NOT carried through this interface;
 * it is propagated via `QueuedJobInput.gitAuth` in Phase 4. For Phase 2 we
 * expose a richer `issueGitAuth()` method on this class that the dispatcher
 * can call directly once Phase 4 adds `sourceAuth`/`workflowAuth` to the
 * dispatch schema.
 */

import type { CloneTokenProvider, ProviderGitAuth } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import { resolveSourceCredential } from '../../secrets/source-credentials.js';
import type { SecretResolver } from '../../secrets/secret-resolver.js';
import type { UniversalGitConfig } from './config.js';

const logger = createLogger({ prefix: 'universal-git:clone-token' });

/**
 * Structured auth material the agent needs to clone a universal-git repo.
 *
 * Phase 4: serialized into the new `sourceAuth` / `workflowAuth` fields on
 * `jobDispatchSchema`. The shape matches `ProviderGitAuth` from
 * `@kici-dev/engine` with additional SSH fields pulled from the source
 * config (`sshHostKeyPolicy`, `sshKnownHostsPem`).
 */
export interface UniversalGitAuth extends ProviderGitAuth {
  kind: 'basic' | 'ssh';
}

/**
 * Universal-git implementation of CloneTokenProvider.
 *
 * Bound to a single source (orgId + sourceId + config). The orchestrator
 * constructs one per registered universal-git source.
 */
export class UniversalGitCloneTokenProvider implements CloneTokenProvider {
  readonly provider = 'generic' as const;

  constructor(
    private readonly params: {
      orgId: string;
      sourceId: string;
      config: UniversalGitConfig;
      secretResolver: SecretResolver;
    },
  ) {}

  /**
   * Create a clone token — the raw secret material (PAT / password / SSH key).
   *
   * The orchestrator dispatch pipeline currently threads this string into
   * `jobDispatch.token`, which the agent uses as HTTPS Basic-auth password
   * via `http.extraHeader`. SSH support requires the Phase 4 dispatch-schema
   * split (sourceAuth.kind = 'ssh') — which is where the agent gains the
   * ability to materialize the PEM key and wire `GIT_SSH_COMMAND`.
   *
   * @returns The resolved secret string, or `null` when the secret is
   * missing (source misconfigured — caller treats this as a clone failure).
   */
  async createCloneToken(_repoIdentifier: string, _credentials: unknown): Promise<string | null> {
    const auth = await this.issueGitAuth();
    return auth?.secret ?? null;
  }

  /**
   * Richer variant that returns the full `UniversalGitAuth` shape instead
   * of just the secret string. The Phase 4 dispatcher calls this via the
   * `CloneTokenProvider.issueGitAuth?` interface hook so the agent
   * receives the auth `kind` + `user` + SSH host-key policy alongside the
   * secret.
   *
   * The method signature matches `CloneTokenProvider.issueGitAuth?` but
   * universal-git ignores the inbound `repoIdentifier` / `credentials`
   * args — the secret lives under a per-source scope (`__source__/<id>`)
   * and is bound to the source at construction time, not to the inbound
   * webhook.
   */
  async issueGitAuth(
    _repoIdentifier?: string,
    _credentials?: unknown,
    opts?: { runId?: string; jobId?: string },
  ): Promise<UniversalGitAuth | null> {
    const result = await resolveSourceCredential(
      this.params.secretResolver,
      this.params.orgId,
      this.params.sourceId,
      this.params.config.credentialRef,
      opts,
    );
    if (!result.ok) {
      logger.warn('Universal-git clone credential missing', {
        orgId: this.params.orgId,
        sourceId: this.params.sourceId,
        reason: result.reason,
        message: result.message,
      });
      return null;
    }
    const kind: 'basic' | 'ssh' = this.params.config.credentialType === 'ssh' ? 'ssh' : 'basic';
    const auth: UniversalGitAuth = {
      kind,
      user: resolveBasicUser(this.params.config),
      secret: result.value,
    };
    if (kind === 'ssh') {
      auth.sshHostKeyPolicy = this.params.config.sshHostKeyPolicy;
      if (this.params.config.sshKnownHostsPem) {
        auth.sshKnownHostsPem = this.params.config.sshKnownHostsPem;
      }
    }
    return auth;
  }
}

/**
 * Pick the Basic-auth username for a universal-git source:
 *   1. Explicit `credentialUser` from the config.
 *   2. `x-access-token` when `credentialType === 'pat'` (GitHub/Forgejo convention).
 *   3. `git` when `credentialType === 'basic'` (fallback for Gitea/Gogs).
 *   4. Undefined for `ssh` (not used).
 */
function resolveBasicUser(config: UniversalGitConfig): string | undefined {
  if (config.credentialType === 'ssh') return undefined;
  if (config.credentialUser) return config.credentialUser;
  if (config.credentialType === 'pat') return 'x-access-token';
  return 'git';
}
