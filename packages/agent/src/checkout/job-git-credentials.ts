/**
 * Per-job git credential plumbing: the grant table, the helper socket git talks
 * to, and the relay to the orchestrator broker, wired as one object so this
 * logic is testable without standing up a job.
 *
 * Scope: the HOST path, which covers bare-metal jobs. A container job clones on
 * the host, but its steps run inside the container, which has no route to the
 * socket.
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
   * Attach the job's declared credential to an outgoing broker request:
   * `ctx.kici.git.github.getToken()` bypasses the credential helper, so without
   * this it would carry no ref and fall back to the source credential.
   */
  withRef(params: Record<string, unknown>): Record<string, unknown>;
  /** Release the socket. Idempotent. */
  close(): Promise<void>;
}

/** `owner/repo.git` (or `/owner/repo`) as git spells it -> `owner/repo`. */
function repositoryFromPath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '').replace(/\.git$/, '');
}

/** `sendApiRequest` is the same orchestrator relay `ctx.kici` uses: no new transport. */
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
   * A per-call name wins; otherwise the map's `default`; otherwise undefined,
   * meaning the source credential (all a read needs). An unknown name throws
   * rather than falling back: using a credential other than the one the author
   * named is the confusion the map exists to remove.
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

  /** Defaults to read-only. */
  const answer = async (query: HelperQuery): Promise<HelperAnswer> => {
    const repository = repositoryFromPath(query.path);
    if (repository === '') return null;

    const grant = grants.lookup(repository);
    const permissions = grant ? grant.permissions : { contents: 'read' };
    const credential = await ask(repository, permissions);
    // git has no credential helper for SSH (that stays on GIT_SSH_COMMAND), so
    // return null rather than hand git a key as a password.
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
      // `credential` (an SDK-side name for a map entry) is resolved HERE and
      // removed: the wire schema does not carry it, and a plain z.object would
      // strip it silently.
      //
      // An incoming `ref` is REFUSED: the SDK's public `getToken` has no `ref`,
      // so one arriving here was hand-built by code in the job's own process —
      // what the orchestrator-side declaration check rejects. Failing here names
      // the forgery at its site instead of as an opaque broker error, and mirrors
      // `refFor`, which also throws rather than falling back on an unknown name.
      const {
        credential,
        ref: incoming,
        ...rest
      } = params as {
        credential?: string;
        ref?: unknown;
      };
      if (incoming !== undefined) {
        throw new Error(
          "git credential refs are resolved from the job's lock by name; " +
            "pass 'credential', not 'ref'",
        );
      }
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
