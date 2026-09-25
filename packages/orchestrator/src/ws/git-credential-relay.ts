/**
 * `agent.api` handler for GIT_CREDENTIAL_REQUEST_METHOD.
 *
 * The agent's credential helper calls this on every git network operation, so
 * this path is hot and must stay cheap: validate, authorize, delegate.
 *
 * Authorization is five layers, every one of them resolved from server truth
 * rather than from the request:
 *
 *   1. job ownership — an agent may only request credentials for a job it was
 *      dispatched, resolved through the dispatcher;
 *   2. the repository fence, which applies to WRITE only: a read with the
 *      source credential may reach any repository inside the App installation's
 *      own selection (the forge enforces that selection when the mint names the
 *      repository), so cloning a sibling repo needs no credential in workflow
 *      code. A write must additionally stay inside the organisation that owns
 *      the job's source repository;
 *   3. the LOCK DECLARATION — a workflow-supplied `ref` must equal one of the
 *      entries in the job's `gitCredentials` map, which the orchestrator itself
 *      wrote from the lock at dispatch (`git/job-context.ts` names the two rows
 *      that carry it and why it reads them in that order). This is the only
 *      check a ref faces, and it is deliberately the whole of it: a ref that
 *      carries inline `*Value` material is admitted exactly when the lock
 *      declared that material, and refused otherwise;
 *   4. the named context's protection rules, run by
 *      `resolveJobQualifiedSecret` when the broker resolves a
 *      `<context>:<key>` reference;
 *   5. the trust tier — an untrusted contributor gets no workflow-supplied
 *      credential at all, mirroring the install-secrets strip.
 *
 * The step process is the same process as the IPC sender, so job code can forge
 * any request frame it likes. Layers 3 to 5 are what make that forgery
 * worthless: a forged `ref` names a credential the job's lock never declared,
 * and every check here reads what the orchestrator wrote rather than what the
 * agent claimed.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { gitCredentialRequestParamsSchema } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import type { TrustTier } from '@kici-dev/engine';
import type { GitCredentialBroker } from '../git/credential-broker.js';
import type { GitCredentialRef } from '@kici-dev/engine';
import { isUntrustedTier } from '../security/trust-tier.js';

const logger = createLogger({ prefix: 'git-credential-relay' });

/** Per-job facts the handler needs. Resolved from server truth, never from params. */
export interface JobCredentialContext {
  orgId: string;
  /**
   * The repository whose code the job checks out — the event's repository.
   * The write-credential organisation fence is anchored here.
   */
  sourceRepo: string;
  /**
   * The repository whose policy governs the job's credentials: the workflow
   * repository for a run whose workflow lives in another repository, otherwise
   * the source repository. A named context's repository restrictions read it.
   */
  policyRepo: string;
  /**
   * The `gitCredentials` map this job's lock entry declared, verbatim — a
   * request's ref must equal one of these entries. An empty map means the job
   * declared none, so every workflow-supplied ref is refused.
   */
  declaredCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The run's resolved contributor trust tier, or undefined when unresolved. */
  trustTier: TrustTier | undefined;
  /**
   * The branch a named context's branch restrictions read: the workflow's
   * registered branch for a run whose workflow lives in another repository,
   * otherwise the branch the run presents.
   */
  policyBranch: string;
  /** The event type that started the run, for a context's trigger-type filters. */
  triggerType: string;
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

/**
 * Deep-equality over a credential ref and a declared entry.
 *
 * Both are flat string maps by construction (`gitCredentialRefSchema` and
 * `LockJob.gitCredentials` agree on that), so a key-set plus per-key comparison
 * is the whole of it — no recursion, and no `JSON.stringify` whose answer would
 * depend on key order. The key COUNT is compared first so a strict subset of a
 * declared entry cannot pass by matching every key it chose to send.
 *
 * This one check covers the material form too. `<name>Value` is inline
 * credential material rather than a secret name, and a workflow may legitimately
 * declare one — `docs/user/patterns/git-credentials.md` documents it for a
 * credential that only exists at run time. Refusing every `*Value` outright
 * would break that; requiring it to equal the lock's own entry does not, and
 * gives up nothing: material the lock declares is already in the job's checkout,
 * so a job replaying it gains no capability, while a forger would have to know
 * the material before they could send it.
 */
function refMatchesDeclared(
  ref: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, string>>,
): boolean {
  const refKeys = Object.keys(ref);
  const declaredKeys = Object.keys(declared);
  if (refKeys.length !== declaredKeys.length) return false;
  return refKeys.every((k) => ref[k] === declared[k]);
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
    // already run by this point, so the narrowing is sound — TypeScript cannot
    // see through the encoding.
    const ref = params.ref as GitCredentialRef | undefined;

    // A request with NO ref asks for the source credential the orchestrator
    // already holds, which is bounded by the fence above and names no secret.
    // Only a workflow-supplied ref reaches the declaration and tier checks.
    if (ref) {
      if (isUntrustedTier(job.trustTier)) {
        logger.warn('Refused a workflow-supplied credential ref for an untrusted ref', {
          agentId,
          runId: owned.runId,
          jobId: params.jobId,
          trustTier: job.trustTier,
        });
        throw new Error(
          `Refusing a workflow-supplied git credential for a run whose contributor tier ` +
            `is '${job.trustTier}'. Only a trusted ref may use a declared credential.`,
        );
      }

      const declared = Object.values(job.declaredCredentials);
      if (!declared.some((entry) => refMatchesDeclared(ref, entry))) {
        logger.warn('Refused an undeclared git credential ref', {
          agentId,
          runId: owned.runId,
          jobId: params.jobId,
          declaredNames: Object.keys(job.declaredCredentials),
        });
        throw new Error(
          `credential ref not declared by this job's lock. Declare it in the job's ` +
            `gitCredentials map and name it with 'credential'. Declared: ` +
            `${Object.keys(job.declaredCredentials).join(', ') || '(none)'}`,
        );
      }
    }

    try {
      return await deps.broker.resolve({
        orgId: job.orgId,
        repositories: params.repositories,
        ...(ref ? { ref } : {}),
        ...(params.permissions ? { permissions: params.permissions } : {}),
        runId: owned.runId,
        jobId: params.jobId,
        gate: {
          dispatchCtx: {
            branch: job.policyBranch,
            triggerType: job.triggerType,
            repository: job.policyRepo,
            runId: owned.runId,
            jobId: params.jobId,
          },
          trustTier: job.trustTier,
        },
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
