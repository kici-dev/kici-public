/**
 * Every claim a KiCI provenance ID token carries, in a stable order.
 *
 * The orchestrator's OIDC discovery document renders `claims_supported` from
 * this list, so a relying party configuring a trust policy reads the names the
 * tokens carry. The orchestrator binds the list to its `IdTokenClaims` type at compile time and
 * a drift test checks it against the claims its builder actually emits.
 */
export const ID_TOKEN_CLAIM_NAMES = [
  'iss',
  'sub',
  'aud',
  'iat',
  'nbf',
  'exp',
  'jti',
  'kici_run_id',
  'kici_job_id',
  'repository',
  'workflow_repository',
  'ref',
  'base_ref',
  'head_ref',
  'head_repository',
  'is_fork',
  'event_name',
  'trust_tier',
  'actor',
  'sha',
  'workflow_ref',
  'orchestrator_id',
  'org_id',
  'source_origin',
  'provider',
  'statement_hash',
  'attestation_origin',
] as const;

export type IdTokenClaimName = (typeof ID_TOKEN_CLAIM_NAMES)[number];
