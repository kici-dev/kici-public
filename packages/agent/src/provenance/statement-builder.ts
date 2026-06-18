/**
 * Build a SLSA v1.0 in-toto provenance statement from the server-truth identity
 * token claims plus the caller-supplied subject. The build context comes
 * entirely from the JWT claims (Platform-minted, unforgeable), so the
 * statement's identity equals the token's identity by construction.
 */
import {
  IN_TOTO_STATEMENT_TYPE,
  KICI_WORKFLOW_BUILD_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  type KiciProvenanceStatement,
} from '@kici-dev/engine/provenance/schema';

/** The KiCI identity-token claims the builder reads (Platform server-truth). */
export interface ProvenanceTokenClaims {
  iss: string;
  repository?: string | null;
  ref?: string | null;
  sha?: string | null;
  workflow_ref?: string | null;
  kici_run_id: string;
  kici_job_id: string;
  orchestrator_id?: string | null;
}

/** Caller-supplied artifact subject: a name plus a lowercase-hex digest map. */
export interface ProvenanceSubject {
  name: string;
  digest: Record<string, string>;
}

export interface BuildStatementInput {
  tokenClaims: ProvenanceTokenClaims;
  subject: ProvenanceSubject;
  builderVersions: { 'kici-agent': string; 'kici-orchestrator': string };
  /** ISO-8601 timestamp with offset. */
  startedOn: string;
  /** ISO-8601 timestamp with offset. */
  finishedOn: string;
}

/** Build a KiCI SLSA v1.0 provenance statement (validates against the P1.1 schema). */
export function buildProvenanceStatement(input: BuildStatementInput): KiciProvenanceStatement {
  const c = input.tokenClaims;
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: input.subject.name, digest: input.subject.digest }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KICI_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: {
            repository: c.repository ?? '',
            ref: c.ref ?? '',
            path: c.workflow_ref ?? '',
          },
        },
        internalParameters: {
          ...(c.sha ? { commit: c.sha } : {}),
          runId: c.kici_run_id,
          jobId: c.kici_job_id,
        },
      },
      runDetails: {
        builder: {
          id: `${c.iss}/orchestrator/${c.orchestrator_id ?? 'unknown'}`,
          version: input.builderVersions,
        },
        metadata: {
          invocationId: c.kici_run_id,
          startedOn: input.startedOn,
          finishedOn: input.finishedOn,
        },
      },
    },
  };
}
