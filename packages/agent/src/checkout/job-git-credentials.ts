/**
 * Per-job git credential plumbing.
 *
 * Owns the three things a job needs to authenticate git: the grant table, the
 * helper socket git talks to, and the relay to the orchestrator broker. Kept in
 * its own module so the job runner wires one object rather than three, and so
 * this logic is testable without standing up a job.
 *
 * Scope: this is the HOST path, which covers bare-metal jobs. A container job
 * clones and executes inside the container today and has no route to the
 * socket; that is fixed by the dual-mode container work, which moves the clone
 * to the host and injects `/opt/kici` read-only.
 */

import { GIT_CREDENTIAL_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import { GrantTable } from './grant-table.js';
import { elevateForWrite } from './write-elevation.js';
import {
  startCredentialHelperHost,
  type CredentialHelperHost,
  type HelperAnswer,
  type HelperQuery,
} from './credential-helper-host.js';
import type { GitGrantRequestIpc, GitGrantResponseIpc } from '../execution/sandbox/ipc-protocol.js';

/** What the broker returns over the agent API. */
interface BrokerResult {
  kind: 'basic' | 'ssh';
  user?: string;
  secret: string;
  grant: { scoped: false } | { scoped: true; permissions: Record<string, string> };
  expiresAt: string | null;
}

export interface JobGitCredentials {
  /** Path to pass as `credential.helper` on every clone this job makes. */
  helperPath: string;
  /** Handler for `git.grant.request` IPC from the sandbox runner. */
  onGitGrantRequest: (request: GitGrantRequestIpc) => Promise<GitGrantResponseIpc>;
  /**
   * Attach the job's declared credential to an outgoing broker request.
   *
   * `ctx.kici.git.github.getToken()` reaches the orchestrator directly rather
   * than through the credential helper, so without this it would carry no ref
   * and fall back to the source credential.
   */
  withRef(params: Record<string, unknown>): Record<string, unknown>;
  /** Release the socket. Safe to call more than once. */
  close(): Promise<void>;
}

/** `owner/repo.git` (or `/owner/repo`) as git spells it -> `owner/repo`. */
function repositoryFromPath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '').replace(/\.git$/, '');
}

/**
 * Stand up git credentials for one job.
 *
 * `sendApiRequest` is the agent's existing orchestrator relay — the same one
 * `ctx.kici` uses — so this adds no new transport.
 */
export async function startJobGitCredentials(args: {
  jobId: string;
  /**
   * Named credentials declared on the job (`gitCredentials`), carried through
   * the lock file in `jobConfig`. Values are SECRET NAMES; the orchestrator
   * resolves them. `default` applies when a call names none.
   */
  credentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Job-scoped directory for the socket and shim. */
  dir: string;
  sendApiRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}): Promise<JobGitCredentials> {
  const grants = new GrantTable();

  /**
   * Pick the credential a request should use.
   *
   * A per-call name wins; otherwise `default` from the job's declared map;
   * otherwise undefined, which means the source credential — all a read needs.
   * An unknown name throws rather than silently falling back, because using a
   * different credential than the author named is the confusion the map exists
   * to remove.
   */
  const refFor = (name?: string): Readonly<Record<string, string>> | undefined => {
    if (name === undefined) return args.credentials?.default;
    const found = args.credentials?.[name];
    if (!found) {
      throw new Error(
        `Unknown git credential '${name}'. Declare it in the job's gitCredentials ` +
          `map. Known: ${Object.keys(args.credentials ?? {}).join(', ') || '(none)'}`,
      );
    }
    return found;
  };

  const ask = async (
    repository: string,
    permissions: Readonly<Record<string, string>>,
    credentialName?: string,
  ): Promise<BrokerResult> => {
    const ref = refFor(credentialName);
    return (await args.sendApiRequest(GIT_CREDENTIAL_REQUEST_METHOD, {
      jobId: args.jobId,
      // git asks about one URL at a time, so the helper's list is always one
      // entry; `getToken` is the caller that sends several.
      repositories: [repository],
      permissions,
      ...(ref ? { ref } : {}),
    })) as BrokerResult;
  };

  /** Answer one credential query from git, defaulting to read-only. */
  const answer = async (query: HelperQuery): Promise<HelperAnswer> => {
    const repository = repositoryFromPath(query.path);
    if (repository === '') return null;

    const grant = grants.lookup(repository);
    const permissions = grant ? grant.permissions : { contents: 'read' };
    const credential = await ask(repository, permissions);
    // SSH never reaches the helper — git has no credential helper for SSH, so
    // that path stays on GIT_SSH_COMMAND. Returning null keeps git honest
    // rather than handing it a key as a password.
    if (!credential || credential.kind !== 'basic') return null;
    return { username: credential.user ?? 'x-access-token', password: credential.secret };
  };

  let host: CredentialHelperHost | undefined = await startCredentialHelperHost({
    dir: args.dir,
    answer,
  });

  const onGitGrantRequest = async (request: GitGrantRequestIpc): Promise<GitGrantResponseIpc> => {
    try {
      if (request.op === 'revoke') {
        if (request.grantId) grants.revoke(request.grantId);
        return { type: 'git.grant.response', requestId: request.requestId };
      }
      if (!request.repository) {
        throw new Error('git.grant.request: elevate requires a repository');
      }
      const { grantId, granted } = await elevateForWrite({
        repository: request.repository,
        permissions: request.permissions ?? { contents: 'write' },
        grants,
        request: async ({ repository, permissions }) => {
          const result = await ask(repository, permissions, request.credentialName);
          return { grant: result.grant, expiresAt: result.expiresAt };
        },
      });
      return { type: 'git.grant.response', requestId: request.requestId, grantId, granted };
    } catch (err) {
      return {
        type: 'git.grant.response',
        requestId: request.requestId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return {
    helperPath: host.helperPath,
    onGitGrantRequest,
    withRef: (params) => {
      // `credential` is an SDK-side convenience naming an entry in the job's
      // map. It is resolved HERE and removed: the wire schema does not carry it,
      // and a plain z.object would strip it silently rather than say so.
      const { credential, ...rest } = params as { credential?: string };
      const ref = refFor(typeof credential === 'string' ? credential : undefined);
      return ref ? { ...rest, ref } : rest;
    },
    close: async () => {
      const open = host;
      host = undefined;
      if (open) await open.close();
    },
  };
}
