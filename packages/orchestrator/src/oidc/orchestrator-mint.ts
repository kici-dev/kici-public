/**
 * Orchestrator-owned OIDC identity mint (production).
 *
 * Production sibling of `local-mint.ts`: the orchestrator mints the short-lived
 * ES256 ID token for a build job LOCALLY from its own execution_runs/
 * execution_jobs rows, signed with its own long-lived signing key (`Signer`),
 * issued under its own real issuer. Zero hosted-Platform dependency.
 *
 * Anti-forgery is identical to the Platform-minted path and the local dev plane:
 * every identity claim (run/job/repo/ref/sha/org) is read SERVER-SIDE from the
 * orchestrator's own rows — never from the agent's wire input — and job ownership
 * is resolved from dispatch state, never agent-asserted. The token is never
 * logged.
 */
import type { Kysely } from 'kysely';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
import {
  oidcTokenRequestParamsSchema,
  type OidcTokenResult,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import type { Database } from '../db/types.js';
import { resolveOrgId } from '../pipeline/processor.js';
import { buildIdTokenClaims, type IdTokenClaims } from './id-token-claims.js';
import { signCompactJws } from './jwt.js';
import type { Signer } from './signer.js';

/** The org anchor stamped when a run has no routing key (sourceless / local plane). */
export const DEFAULT_ORG_ID = '__default__';

/** ID-token lifetime (seconds). Matches the Platform's 10-minute cap. */
export const ORCHESTRATOR_ID_TOKEN_TTL_SECONDS = 600;

export class OrchestratorMintRunNotFoundError extends Error {}
export class OrchestratorMintJobNotFoundError extends Error {}
export class OrchestratorMintJobNotActiveError extends Error {}

export interface OrchestratorMintDeps {
  db: Kysely<Database>;
  signer: Signer;
  /** The orchestrator's own provenance issuer identity (real URL). */
  issuer: string;
  orchestratorId: string;
  ttlSeconds?: number;
  /** Injectable clock (seconds). Defaults to wall-clock. */
  nowSeconds?: () => number;
}

export interface OrchestratorMintInput {
  runId: string;
  jobId: string;
  audience: string;
  /**
   * Deferred-fulfilment mint: knowingly targets a completed (terminal) job and
   * binds the frozen statement hash + origin so the terminal-job check is
   * relaxed and the mint-timing marker is stamped. The live agent path never
   * sets this.
   */
  deferred?: { statementHash: string; origin: 'deferred' | 'offline-backfill' };
}

export interface OrchestratorMintResult {
  token: string;
  expiresIn: number;
  jti: string;
  claims: IdTokenClaims;
}

/**
 * Mint a short-lived ES256 ID token for (run, job) from the orchestrator's own
 * rows, signed with the orchestrator's signing key.
 */
export async function mintOrchestratorIdToken(
  deps: OrchestratorMintDeps,
  input: OrchestratorMintInput,
): Promise<OrchestratorMintResult> {
  const run = await deps.db
    .selectFrom('execution_runs')
    .select([
      'run_id',
      'routing_key',
      'repo_identifier',
      'ref',
      'sha',
      'workflow_name',
      'provider',
      'local_working_tree',
    ])
    .where('run_id', '=', input.runId)
    .executeTakeFirst();
  if (!run) throw new OrchestratorMintRunNotFoundError(`run ${input.runId} not found`);

  const job = await deps.db
    .selectFrom('execution_jobs')
    .select(['run_id', 'job_id', 'status'])
    .where('run_id', '=', input.runId)
    .where('job_id', '=', input.jobId)
    .executeTakeFirst();
  if (!job) {
    throw new OrchestratorMintJobNotFoundError(
      `job ${input.jobId} not found for run ${input.runId}`,
    );
  }

  // Org anchor is server-truth: resolve the run's routing key to its source's
  // customer_id (sources / generic / remote), falling back to __default__ for a
  // sourceless run — never an agent-asserted value.
  const orgId = run.routing_key ? await resolveOrgId(deps.db, run.routing_key) : DEFAULT_ORG_ID;
  // Live agent mints require a running (non-terminal) job. A deferred fulfilment
  // knowingly mints for a completed job — the temporal gap is disclosed via the
  // attestation_origin marker, not hidden — so the terminal check is relaxed
  // only for the explicitly-flagged deferred case.
  if (!input.deferred && TERMINAL_JOB_STATES.has(job.status)) {
    throw new OrchestratorMintJobNotActiveError(`job ${input.jobId} is ${job.status}`);
  }

  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const ttlSeconds = deps.ttlSeconds ?? ORCHESTRATOR_ID_TOKEN_TTL_SECONDS;
  const claims = buildIdTokenClaims(
    {
      run_id: run.run_id,
      org_id: orgId,
      repo_identifier: run.repo_identifier,
      ref: run.ref,
      sha: run.sha,
      workflow_name: run.workflow_name,
      provider: run.provider,
      local_working_tree: run.local_working_tree,
    },
    {
      run_id: job.run_id,
      job_id: job.job_id,
      orchestrator_id: deps.orchestratorId,
      status: job.status,
    },
    {
      issuer: deps.issuer,
      audience: input.audience,
      nowSeconds: now,
      ttlSeconds,
      ...(input.deferred ? { deferred: input.deferred } : {}),
    },
  );

  const token = await signCompactJws(
    deps.signer,
    { alg: 'ES256', kid: await deps.signer.getKid(), typ: 'JWT' },
    claims as unknown as Record<string, unknown>,
  );
  return { token, expiresIn: ttlSeconds, jti: claims.jti, claims };
}

/** Job-ownership resolver surface (the dispatcher's `resolveOwnedJob`). */
export interface OrchestratorMintOwnershipResolver {
  resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
}

export class OrchestratorMintRejectedError extends Error {}
/** unavailable: the signing key is not yet resolvable (leader election / cold start). */
export class OrchestratorMintSignerUnavailableError extends Error {}

export interface OrchestratorOidcTokenHandlerDeps {
  dispatcher: OrchestratorMintOwnershipResolver;
  /**
   * Lazily resolve the orchestrator's signing key. Resolved on first token
   * request (not at boot) so it is unaffected by the Raft leader-election race —
   * by the time an agent requests a token the cluster has a leader and the key
   * exists. May return null while the key is still being reconciled.
   */
  resolveSigner: () => Promise<Signer | null>;
  /** Mint deps except the signer (supplied lazily via `resolveSigner`). */
  mint: Omit<OrchestratorMintDeps, 'signer'>;
}

/**
 * Build the agent.api handler for `OIDC_TOKEN_REQUEST_METHOD` when the
 * orchestrator owns its signing key. Verifies the agent owns the named job
 * (resolving its runId from the dispatcher — never an agent-asserted value),
 * resolves the signing key lazily, then mints locally. A job the agent does not
 * own is rejected without minting; an unresolved signer defers (never crashes).
 */
export function createOrchestratorOidcTokenHandler(
  deps: OrchestratorOidcTokenHandlerDeps,
): (agentId: string, params: Record<string, unknown>) => Promise<OidcTokenResult> {
  return async (agentId, params) => {
    const { jobId, audience } = oidcTokenRequestParamsSchema.parse(params);
    const owned = deps.dispatcher.resolveOwnedJob(agentId, jobId);
    if (!owned) {
      throw new OrchestratorMintRejectedError(`job ${jobId} not owned by agent ${agentId}`);
    }
    const signer = await deps.resolveSigner();
    if (!signer) {
      // Signing configured but the key is not ready yet — defer the mint (the
      // agent freezes + DSSE-signs the statement; the retrier fulfils later).
      return { deferred: true, code: 'unavailable' };
    }
    const result = await mintOrchestratorIdToken(
      { ...deps.mint, signer },
      { runId: owned.runId, jobId, audience },
    );
    return { token: result.token, expiresIn: result.expiresIn, jti: result.jti };
  };
}
