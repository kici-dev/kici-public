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
import type { SourceOrigin } from '@kici-dev/engine';

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
  /** Authoritative origin: the customer's public org id (Platform-asserted). */
  org_id?: string;
  /** Source-origin brand: triggered vs run-remote (local working-tree overlay). */
  source_origin?: SourceOrigin;
  /** Informational source provider (github / gitlab / bitbucket / local). */
  provider?: string | null;
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

/**
 * Agent-local job context used to freeze a provenance statement for a deferred
 * attestation. When the Platform mint fails transiently there is no identity
 * token to read claims from, so the statement is built from facts the agent
 * already holds about the job it just ran. Only the identity token is deferred;
 * these attested facts are sealed (DSSE-signed) at build time.
 */
export interface LocalBuildContext {
  repository: string;
  ref: string;
  sha: string | null;
  workflowRef: string;
  runId: string;
  jobId: string;
  orgId?: string;
  sourceOrigin?: SourceOrigin;
  /**
   * Platform provenance issuer for the `builder.id`. The agent does not always
   * know it at build time (the orchestrator may be disconnected — that is why
   * the mint deferred), so it is best-effort; an empty string yields a
   * `/orchestrator/unknown` builder id. This field is not verification
   * load-bearing for a deferred bundle: the later token binds to the frozen
   * statement by hash, not by field-for-field cross-check.
   */
  issuer: string;
}

/**
 * Build a frozen SLSA v1.0 provenance statement from agent-local job context,
 * for a deferred attestation (no minted identity token yet). Marks
 * `attestationOrigin: 'deferred'` in the internal parameters. The caller
 * DSSE-signs the returned statement immediately and computes its statement hash
 * — the binding the later OIDC mint commits to (truth-contract property 2).
 */
export function buildLocalProvenanceStatement(input: {
  context: LocalBuildContext;
  subject: ProvenanceSubject;
  builderVersions: { 'kici-agent': string; 'kici-orchestrator': string };
  startedOn: string;
  finishedOn: string;
}): KiciProvenanceStatement {
  const c = input.context;
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: input.subject.name, digest: input.subject.digest }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KICI_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: { repository: c.repository, ref: c.ref, path: c.workflowRef },
        },
        internalParameters: {
          ...(c.sha ? { commit: c.sha } : {}),
          runId: c.runId,
          jobId: c.jobId,
          ...(c.orgId ? { orgId: c.orgId } : {}),
          ...(c.sourceOrigin ? { sourceOrigin: c.sourceOrigin } : {}),
          attestationOrigin: 'deferred',
        },
      },
      runDetails: {
        builder: {
          id: `${c.issuer}/orchestrator/unknown`,
          version: input.builderVersions,
        },
        metadata: {
          invocationId: c.runId,
          startedOn: input.startedOn,
          finishedOn: input.finishedOn,
        },
      },
    },
  };
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
          ...(c.provider ? { provider: c.provider } : {}),
        },
        internalParameters: {
          ...(c.sha ? { commit: c.sha } : {}),
          runId: c.kici_run_id,
          jobId: c.kici_job_id,
          ...(c.org_id ? { orgId: c.org_id } : {}),
          ...(c.source_origin ? { sourceOrigin: c.source_origin } : {}),
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
