/**
 * OIDC ID-token claims for the local dev-signed identity. Mirrors the Platform's
 * `oidc/id-token-claims.ts` so a dev-signed bundle carries the exact same claim
 * shape the agent's statement builder + the engine verifier already expect — the
 * cross-check between the in-toto statement and the token claims is identical to
 * the Platform-minted path. The only differences are the local sentinel issuer
 * (`kici-local`) and the org anchor (`__default__`, the plane's default org).
 */
import { AttestationOrigin, SourceOrigin } from '@kici-dev/engine';

/** The subset of an execution_runs row the claims need. */
export interface RunClaimSource {
  run_id: string;
  org_id: string;
  repo_identifier: string | null;
  ref: string | null;
  sha: string | null;
  workflow_name: string | null;
  provider: string | null;
  /** True when the run executed an uploaded local working tree (`kici run remote`). */
  local_working_tree: boolean;
}

/** The subset of an execution_jobs row the claims need. */
export interface JobClaimSource {
  run_id: string;
  job_id: string;
  orchestrator_id: string | null;
  status: string;
}

export interface BuildClaimsOpts {
  issuer: string;
  audience: string;
  nowSeconds: number;
  ttlSeconds: number;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  kici_run_id: string;
  kici_job_id: string;
  repository: string | null;
  ref: string | null;
  sha: string | null;
  workflow_ref: string | null;
  orchestrator_id: string | null;
  org_id: string;
  source_origin: SourceOrigin;
  provider: string | null;
  statement_hash: string | null;
  attestation_origin: AttestationOrigin;
}

/**
 * Build the OIDC ID-token claims for a build job from the orchestrator's own
 * execution_runs/execution_jobs rows. The local dev plane only ever mints for a
 * live (running) job, so `attestation_origin` is always `live` and
 * `statement_hash` is null (the statement is cross-checked field-by-field).
 */
export function buildIdTokenClaims(
  run: RunClaimSource,
  job: JobClaimSource,
  opts: BuildClaimsOpts,
): IdTokenClaims {
  const workflowRef = run.workflow_name
    ? run.sha
      ? `${run.workflow_name}@${run.sha}`
      : run.workflow_name
    : null;

  const sub = `repo:${run.repo_identifier ?? 'unknown'}:ref:${run.ref ?? 'unknown'}:workflow:${
    run.workflow_name ?? 'unknown'
  }`;

  const sourceOrigin: SourceOrigin = run.local_working_tree
    ? SourceOrigin.enum['run-remote']
    : SourceOrigin.enum.triggered;

  return {
    iss: opts.issuer,
    sub,
    aud: opts.audience,
    iat: opts.nowSeconds,
    nbf: opts.nowSeconds,
    exp: opts.nowSeconds + opts.ttlSeconds,
    jti: `${run.run_id}:${job.job_id}`,
    kici_run_id: run.run_id,
    kici_job_id: job.job_id,
    repository: run.repo_identifier,
    ref: run.ref,
    sha: run.sha,
    workflow_ref: workflowRef,
    orchestrator_id: job.orchestrator_id,
    org_id: run.org_id,
    source_origin: sourceOrigin,
    provider: run.provider,
    statement_hash: null,
    attestation_origin: AttestationOrigin.enum.live,
  };
}
