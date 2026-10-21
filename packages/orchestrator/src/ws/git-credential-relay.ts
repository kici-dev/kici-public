/**
 * `agent.api` handler for GIT_CREDENTIAL_REQUEST_METHOD.
 *
 * The agent's credential helper calls this on every git network operation, so
 * this path is hot and must stay cheap: validate, authorize, delegate.
 *
 * Authorization is five layers, each resolved from server truth, never the request:
 *
 *   1. job ownership — an agent may only request credentials for a job it was
 *      dispatched, resolved through the dispatcher;
 *   2. the repository fence, which applies to WRITE only: a read with the
 *      source credential may reach any repository inside the App installation's
 *      own selection (the forge enforces that selection when the mint names the
 *      repository), so cloning a sibling repo needs no credential in workflow
 *      code. A write must additionally be the job's own checkout, or stay
 *      inside the organisation that owns the job's source repository;
 *   3. the LOCK DECLARATION — a workflow-supplied `ref` must equal an entry of the
 *      job's `gitCredentials` map, which the orchestrator wrote from the lock at
 *      dispatch (`git/job-context.ts` names the rows that carry it and their read
 *      order). This is deliberately the only check a ref faces: a ref carrying inline
 *      `*Value` material is admitted exactly when the lock declared that material;
 *   4. the named context's protection rules, run by
 *      `resolveJobQualifiedSecret` when the broker resolves a
 *      `<context>:<key>` reference;
 *   5. the trust tier — an untrusted contributor gets no workflow-supplied
 *      credential at all, mirroring the install-secrets strip.
 *
 * The step process is the IPC sender, so job code can forge any request frame.
 * Layers 3 to 5 make that forgery worthless: a forged `ref` names a credential the
 * lock never declared, and every check reads what the orchestrator wrote, not what the
 * agent claimed.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { gitCredentialRequestParamsSchema } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import type { TrustTier } from '@kici-dev/engine';
import { type GitCredentialBroker, GitCredentialRefusedError } from '../git/credential-broker.js';
import { JobSecretRefusalKind, JobSecretRefusedError } from '../secrets/job-secret-gate.js';
import { AgentApiRefusalError } from './agent-api-registry.js';
import type { GitCredentialRef } from '@kici-dev/engine';
import { isUntrustedTier } from '../security/trust-tier.js';

const logger = createLogger({ prefix: 'git-credential-relay' });

/** Per-job facts the handler needs. Resolved from server truth, never from params. */
export interface JobCredentialContext {
  orgId: string;
  /** The event's repository, which the job checks out; anchors the write-credential fence. */
  sourceRepo: string;
  /**
   * `owner/repo` of the clone URL the orchestrator wrote for this job's
   * checkout (`dispatch_queue.repo_url`), or undefined when that row is gone.
   * The write fence admits it by exact match: an SSH or `file://` clone URL
   * names the job's own repository in a form `sameOrg` cannot read.
   */
  checkoutRepo?: string;
  /**
   * The repository whose policy governs the job's credentials: the workflow
   * repository for a run whose workflow lives in another repository, otherwise
   * the source repository. A named context's repository restrictions read it.
   */
  policyRepo: string;
  /**
   * The lock entry's `gitCredentials` map, verbatim; a request's ref must equal one
   * entry. An empty map refuses every workflow-supplied ref.
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
 * Both are flat string maps (`gitCredentialRefSchema` and `LockJob.gitCredentials`
 * agree), so no recursion and no key-order-dependent `JSON.stringify`. The key COUNT is
 * compared first so a strict subset of a declared entry cannot pass.
 *
 * This covers the material form too: `<name>Value` is inline material a workflow may
 * legitimately declare (`docs/user/patterns/git-credentials.md`, for a credential that
 * only exists at run time), so refusing every `*Value` would break it. Requiring equality
 * gives up nothing: declared material is already in the job's checkout, and a forger
 * would have to know the material to send it.
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

/** Context that the refusal log line names. */
interface RefusalLogContext {
  agentId: string;
  jobId: string;
  runId?: string;
  orgId?: string;
  repositories: readonly string[];
}

/**
 * Log a refusal once, with its full reason, and build the error the job sees.
 * The job's message can be shorter than the logged reason (a protection
 * rule's text stays in the log); both are redacted.
 */
function refuse(
  ctx: RefusalLogContext,
  jobMessage: string,
  logReason: string = jobMessage,
): AgentApiRefusalError {
  logger.warn('Git credential refused', { ...ctx, reason: redact(logReason) });
  return new AgentApiRefusalError(redact(jobMessage));
}

const CONTEXT_REFUSAL_KINDS: ReadonlySet<JobSecretRefusalKind> = new Set([
  JobSecretRefusalKind.enum['missing-context'],
  JobSecretRefusalKind.enum['context-rejected'],
  JobSecretRefusalKind.enum['missing-secret'],
]);

/**
 * The job-visible message for a broker refusal, or null when the error is not
 * a refusal (a mint or store failure), which stays internal.
 *
 * The context-gate kinds share one message, naming the context and the run's
 * org: telling a missing context from a rule that rejects the run, or from a
 * missing key, would let a job probe another context's configuration. The
 * orchestrator log names which.
 */
function brokerRefusalMessage(err: unknown, repos: string, orgId: string): string | null {
  if (err instanceof GitCredentialRefusedError) {
    return `Refusing a git credential for ${repos}: ${err.message}`;
  }
  if (!(err instanceof JobSecretRefusedError)) return null;
  if (CONTEXT_REFUSAL_KINDS.has(err.kind)) {
    return (
      `Refusing a git credential for ${repos}: context '${err.context}' did not provide it ` +
      `for this run in org '${orgId}'. The context is missing in that org, its protection ` +
      `rules do not admit this run, or no secret bound to it carries the key; the ` +
      `orchestrator log names which.`
    );
  }
  return `Refusing a git credential for ${repos}: ${err.message}`;
}

export function buildGitCredentialHandler(deps: GitCredentialHandlerDeps) {
  return async (agentId: string, rawParams: Record<string, unknown>): Promise<unknown> => {
    const params = gitCredentialRequestParamsSchema.parse(rawParams);
    const logCtx: RefusalLogContext = {
      agentId,
      jobId: params.jobId,
      repositories: params.repositories,
    };

    const owned = deps.dispatcher.resolveOwnedJob(agentId, params.jobId);
    if (!owned) {
      throw refuse(logCtx, `job ${params.jobId} not owned by agent ${agentId}`);
    }
    logCtx.runId = owned.runId;

    const job = await deps.jobContext(owned.runId, params.jobId);
    if (!job) {
      throw refuse(logCtx, `Unknown job '${params.jobId}' for a git credential request`);
    }
    logCtx.orgId = job.orgId;

    // EVERY repository must clear the fence, not just the first, or an in-org name
    // followed by an out-of-org one mints a token covering both.
    if (requestsWrite(params.permissions)) {
      // The job's own checkout is admitted by exact match; every other
      // repository still has to share the source repository's organisation.
      const outside = params.repositories.filter(
        (r) => r !== job.checkoutRepo && !sameOrg(r, job.sourceRepo),
      );
      if (outside.length > 0) {
        throw refuse(
          logCtx,
          `Refusing a write credential for ${outside.map((r) => `'${r}'`).join(', ')}: ` +
            `outside the organisation of this job's source repository ` +
            `'${job.sourceRepo}'.`,
        );
      }
    }

    // The schema encodes "exactly one of <name>Secret / <name>Value" as two optional
    // fields plus a refinement, which has already run, so narrowing to the
    // `GitCredentialRef` union is sound; TypeScript cannot see through the encoding.
    const ref = params.ref as GitCredentialRef | undefined;

    // NO ref asks for the source credential the orchestrator holds, bounded by the fence
    // above. Only a workflow-supplied ref reaches the declaration and tier checks.
    if (ref) {
      if (isUntrustedTier(job.trustTier)) {
        throw refuse(
          logCtx,
          `Refusing a workflow-supplied git credential for a run whose contributor tier ` +
            `is '${job.trustTier}'. Only a trusted ref may use a declared credential.`,
        );
      }

      const declared = Object.values(job.declaredCredentials);
      if (!declared.some((entry) => refMatchesDeclared(ref, entry))) {
        throw refuse(
          logCtx,
          `credential ref not declared by this job's lock. Declare it in the job's ` +
            `gitCredentials map and name it with 'credential'. Declared: ` +
            `${Object.keys(job.declaredCredentials).join(', ') || '(none)'}`,
        );
      }
    }

    const repos = params.repositories.map((r) => `'${r}'`).join(', ');
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
      const refusal = brokerRefusalMessage(err, repos, job.orgId);
      if (refusal !== null) throw refuse(logCtx, refusal, toErrorMessage(err));
      // A broker error can carry forge output; never forward it verbatim.
      logger.warn('Git credential resolution failed', {
        agentId,
        jobId: params.jobId,
        repositories: params.repositories,
      });
      throw new Error(
        `Could not resolve a git credential for ${repos}: ${redact(toErrorMessage(err))}`,
      );
    }
  };
}
