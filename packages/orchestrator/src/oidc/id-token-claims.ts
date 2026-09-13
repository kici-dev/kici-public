/**
 * OIDC ID-token claims for orchestrator-side minting — shared by the
 * production orchestrator-owned mint (`orchestrator-mint.ts`) and the local
 * dev-signed identity (`local-mint.ts`). Mirrors the Platform's claim shape so
 * every bundle carries the exact same claims the agent's statement builder +
 * the engine verifier expect — the cross-check between the in-toto statement
 * and the token claims is identical across all minters. The dev-signed path
 * differs only in the local sentinel issuer (`kici-local`) and the org anchor
 * (`__default__`, the plane's default org).
 */
import {
  AttestationOrigin,
  buildEventClaims,
  buildIdTokenSubject,
  SourceOrigin,
  type EventClaims,
} from '@kici-dev/engine';

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
  /** Normalized event that started the run (`push`, `pull_request:opened`, …). */
  trigger_event?: string | null;
  /**
   * The event the SUBJECT is derived from, when that is not `trigger_event`.
   * A re-run carries the original run's event here. NULL means "use
   * `trigger_event`". Read only by `buildIdTokenSubject`.
   */
  subject_trigger_event?: string | null;
  /** Pull-request HEAD branch. */
  head_ref?: string | null;
  /** `owner/repo` of the pull-request HEAD. */
  head_repository?: string | null;
  /** True for a fork pull request; NULL when the run resolved no answer. */
  is_fork?: boolean | null;
  /** Resolved trust tier for the triggering actor. */
  trust_tier?: string | null;
  /** Provider login of the triggering actor. */
  trigger_actor_username?: string | null;
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
  /**
   * Deferred-fulfilment marker: binds the frozen DSSE statement hash + the
   * mint-timing origin. Absent for a live (synchronous) mint. The local dev
   * plane never sets this; the orchestrator-owned mint sets it when re-minting
   * for a completed job bound to a frozen statement.
   */
  deferred?: { statementHash: string; origin: 'deferred' | 'offline-backfill' };
  /**
   * Restore the pre-split pull-request `sub` — the branch-shaped form that
   * collides with a push to the same base branch. An escape hatch for an
   * operator whose cloud trust policy breaks mid-migration, set by
   * `KICI_OIDC_LEGACY_PR_SUB`.
   *
   * @deprecated Removed at v1.0.0. Move the policy to `repo:<repo>:pull_request`.
   */
  legacyPullRequestSubject?: boolean;
}

/**
 * Extends {@link EventClaims}, so every token carries the event-context claims
 * a cloud trust policy needs to tell a fork pull request from a push.
 */
export interface IdTokenClaims extends EventClaims {
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
 * execution_runs/execution_jobs rows. A live (synchronous) mint leaves
 * `attestation_origin=live` and `statement_hash=null` (the statement is
 * cross-checked field-by-field); a deferred fulfilment stamps the frozen
 * statement hash + origin marker via `opts.deferred`.
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

  const sub = buildIdTokenSubject(run, {
    legacyPullRequestSubject: opts.legacyPullRequestSubject === true,
  });

  const sourceOrigin: SourceOrigin = run.local_working_tree
    ? SourceOrigin.enum['run-remote']
    : SourceOrigin.enum.triggered;

  return {
    ...buildEventClaims(run),
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
    statement_hash: opts.deferred?.statementHash ?? null,
    attestation_origin: opts.deferred?.origin
      ? AttestationOrigin.enum[opts.deferred.origin]
      : AttestationOrigin.enum.live,
  };
}
