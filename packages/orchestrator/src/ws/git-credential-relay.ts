/**
 * `agent.api` handler for GIT_CREDENTIAL_REQUEST_METHOD.
 *
 * The agent's credential helper calls this on every git network operation, so
 * this path is hot and must stay cheap: validate, authorize, delegate.
 *
 * Authorization has two layers. Job ownership comes first — an agent may only
 * request credentials for a job it was dispatched, resolved from server truth
 * via the dispatcher, never from the params. Then the repository fence, which
 * applies to WRITE only: a read with the source credential may reach any
 * repository inside the App installation's own selection (GitHub enforces that
 * selection when the mint names the repository), so cloning a sibling repo
 * needs no credential in workflow code. A write must additionally stay inside
 * the organisation that owns the job's source repository.
 *
 * A workflow-supplied credential needs no fence of its own: it names secrets
 * the job can already read with `ctx.secrets.get()`, so brokering it grants no
 * capability the workflow did not already have — the secret ACL is the
 * authorization.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { gitCredentialRequestParamsSchema } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import type { GitCredentialBroker } from '../git/credential-broker.js';
import type { GitCredentialRef } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'git-credential-relay' });

/** Per-job facts the handler needs. Resolved from server truth, never from params. */
export interface JobCredentialContext {
  orgId: string;
  /** The repository this job was dispatched for. */
  sourceRepo: string;
}

export interface GitCredentialHandlerDeps {
  broker: GitCredentialBroker;
  /** The dispatcher's job-ownership resolver — the same one the OIDC relay uses. */
  dispatcher: { resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined };
  jobContext: (runId: string, jobId: string) => Promise<JobCredentialContext | null>;
}

/** A request asks for write when any requested permission value is `write`. */
function requestsWrite(permissions: Readonly<Record<string, string>> | undefined): boolean {
  return Object.values(permissions ?? {}).some((v) => v === 'write');
}

/** `owner/repo` -> `owner`, compared case-insensitively as forges do. */
function sameOrg(a: string, b: string): boolean {
  const owner = (s: string) => s.slice(0, s.indexOf('/')).toLowerCase();
  return owner(a) === owner(b);
}

/** Strip anything token-shaped before an error crosses back to the workflow. */
function redact(message: string): string {
  return message
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED_KEY]')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, '[REDACTED]');
}

export function buildGitCredentialHandler(deps: GitCredentialHandlerDeps) {
  return async (agentId: string, rawParams: Record<string, unknown>): Promise<unknown> => {
    const params = gitCredentialRequestParamsSchema.parse(rawParams);

    const owned = deps.dispatcher.resolveOwnedJob(agentId, params.jobId);
    if (!owned) {
      throw new Error(`job ${params.jobId} not owned by agent ${agentId}`);
    }

    const job = await deps.jobContext(owned.runId, params.jobId);
    if (!job) {
      throw new Error(`Unknown job '${params.jobId}' for a git credential request`);
    }

    // EVERY repository must clear the fence, not just the first. A request that
    // names one in-org repository followed by an out-of-org one would otherwise
    // mint a token covering both.
    if (requestsWrite(params.permissions)) {
      const outside = params.repositories.filter((r) => !sameOrg(r, job.sourceRepo));
      if (outside.length > 0) {
        throw new Error(
          `Refusing a write credential for ${outside.map((r) => `'${r}'`).join(', ')}: ` +
            `outside the organisation of this job's source repository ` +
            `'${job.sourceRepo}'.`,
        );
      }
    }

    // The schema encodes "exactly one of <name>Secret / <name>Value" as two
    // optional fields plus a refinement, so its inferred type keeps both
    // optional while `GitCredentialRef` states the union. The refinement has
    // already run by this point, so the narrowing is sound — TypeScript simply
    // cannot see through the encoding.
    const ref = params.ref as GitCredentialRef | undefined;

    try {
      return await deps.broker.resolve({
        orgId: job.orgId,
        repositories: params.repositories,
        ...(ref ? { ref } : {}),
        ...(params.permissions ? { permissions: params.permissions } : {}),
        runId: owned.runId,
        jobId: params.jobId,
      });
    } catch (err) {
      // A broker error can carry forge output; never forward it verbatim.
      logger.warn('Git credential resolution failed', {
        agentId,
        jobId: params.jobId,
        repositories: params.repositories,
      });
      throw new Error(
        `Could not resolve a git credential for ` +
          `${params.repositories.map((r) => `'${r}'`).join(', ')}: ` +
          `${redact(toErrorMessage(err))}`,
      );
    }
  };
}
