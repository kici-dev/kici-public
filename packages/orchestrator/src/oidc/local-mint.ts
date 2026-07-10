/**
 * Local dev-signed OIDC mint (independent mode only).
 *
 * The Platform-connected orchestrator relays `oidc.token.request` to the hosted
 * Platform, which reads its own run/job rows and mints (`ws/oidc-token-relay.ts`
 * → `oidc.mint.request`). The offline local dev plane has no Platform, so this
 * module mints locally: it reads the orchestrator's OWN execution_runs/
 * execution_jobs rows and signs claims with the in-process `LocalDevSigner`,
 * issuer `kici-local`.
 *
 * Security: this path is registered ONLY when the orchestrator runs in
 * `independent` mode with a `LocalDevSigner` present, and app.ts registers the
 * Platform relay in preference (the local path is registered strictly in the
 * `else` branch), so a Platform-connected orchestrator can never reach the local
 * signer — it keeps minting via the Platform exactly as today. The agent never
 * asserts its own claims; every identity claim is read server-side from the
 * orchestrator's rows, and the job-ownership check is against dispatch state.
 */
import type { Kysely } from 'kysely';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
import {
  oidcTokenRequestParamsSchema,
  type OidcTokenResult,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import type { Database } from '../db/types.js';
import { buildIdTokenClaims, type IdTokenClaims } from './id-token-claims.js';
import { signCompactJws } from './jwt.js';
import { KICI_LOCAL_ISSUER, type LocalSigner } from './local-dev-signer.js';

/** ID-token lifetime (seconds). Matches the Platform's 10-minute cap. */
export const LOCAL_ID_TOKEN_TTL_SECONDS = 600;

/** The org anchor stamped into a local-plane token (the plane's default org). */
export const LOCAL_ORG_ID = '__default__';

export class LocalMintRunNotFoundError extends Error {}
export class LocalMintJobNotFoundError extends Error {}
export class LocalMintJobNotActiveError extends Error {}

export interface LocalMintDeps {
  db: Kysely<Database>;
  signer: LocalSigner;
  orchestratorId: string;
  /** Injectable clock (seconds). Defaults to wall-clock. */
  nowSeconds?: () => number;
}

export interface LocalMintInput {
  runId: string;
  jobId: string;
  audience: string;
}

export interface LocalMintResult {
  token: string;
  expiresIn: number;
  jti: string;
  claims: IdTokenClaims;
}

/**
 * Mint a short-lived dev-signed ES256 ID token for (run, job). Every identity
 * claim is read from the orchestrator's own run/job rows; the token is never
 * logged.
 */
export async function mintLocalIdToken(
  deps: LocalMintDeps,
  input: LocalMintInput,
): Promise<LocalMintResult> {
  const run = await deps.db
    .selectFrom('execution_runs')
    .select([
      'run_id',
      'repo_identifier',
      'ref',
      'sha',
      'workflow_name',
      'provider',
      'local_working_tree',
    ])
    .where('run_id', '=', input.runId)
    .executeTakeFirst();
  if (!run) throw new LocalMintRunNotFoundError(`run ${input.runId} not found`);

  const job = await deps.db
    .selectFrom('execution_jobs')
    .select(['run_id', 'job_id', 'status'])
    .where('run_id', '=', input.runId)
    .where('job_id', '=', input.jobId)
    .executeTakeFirst();
  if (!job)
    throw new LocalMintJobNotFoundError(`job ${input.jobId} not found for run ${input.runId}`);
  // A live agent mint requires a running (non-terminal) job — same invariant as
  // the Platform. The local plane never mints for a completed job.
  if (TERMINAL_JOB_STATES.has(job.status)) {
    throw new LocalMintJobNotActiveError(`job ${input.jobId} is ${job.status}`);
  }

  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const claims = buildIdTokenClaims(
    {
      run_id: run.run_id,
      org_id: LOCAL_ORG_ID,
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
      issuer: KICI_LOCAL_ISSUER,
      audience: input.audience,
      nowSeconds: now,
      ttlSeconds: LOCAL_ID_TOKEN_TTL_SECONDS,
    },
  );

  const token = await signCompactJws(
    deps.signer,
    { alg: 'ES256', kid: deps.signer.getKid(), typ: 'JWT' },
    claims as unknown as Record<string, unknown>,
  );
  return { token, expiresIn: LOCAL_ID_TOKEN_TTL_SECONDS, jti: claims.jti, claims };
}

/** Job-ownership resolver surface (the dispatcher's `resolveOwnedJob`). */
export interface LocalMintOwnershipResolver {
  resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
}

export class LocalMintRejectedError extends Error {}

export interface LocalOidcTokenHandlerDeps {
  dispatcher: LocalMintOwnershipResolver;
  mint: LocalMintDeps;
}

/**
 * Build the agent.api handler for `OIDC_TOKEN_REQUEST_METHOD` in independent
 * mode. Verifies the agent owns the named job (resolving its runId from the
 * dispatcher — never trusting an agent-asserted value), then mints locally. A
 * job the agent does not own is rejected without minting anything.
 */
export function createLocalOidcTokenHandler(
  deps: LocalOidcTokenHandlerDeps,
): (agentId: string, params: Record<string, unknown>) => Promise<OidcTokenResult> {
  return async (agentId, params) => {
    const { jobId, audience } = oidcTokenRequestParamsSchema.parse(params);
    const owned = deps.dispatcher.resolveOwnedJob(agentId, jobId);
    if (!owned) {
      throw new LocalMintRejectedError(`job ${jobId} not owned by agent ${agentId}`);
    }
    const result = await mintLocalIdToken(deps.mint, { runId: owned.runId, jobId, audience });
    return { token: result.token, expiresIn: result.expiresIn, jti: result.jti };
  };
}
