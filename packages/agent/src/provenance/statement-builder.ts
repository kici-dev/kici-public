/**
 * SLSA v1.0 in-toto provenance statements. The live builder takes its build
 * context entirely from the identity token's JWT claims (minted server-side by
 * the orchestrator, unforgeable), so the statement's identity equals the
 * token's by construction.
 */
import {
  IN_TOTO_STATEMENT_TYPE,
  KICI_WORKFLOW_BUILD_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  type KiciProvenanceStatement,
} from '@kici-dev/engine/provenance/schema';
import type { SourceOrigin } from '@kici-dev/engine';

/** The KiCI identity-token claims the builder reads (minter server-truth). */
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
 * Agent-local job context for freezing a deferred attestation's statement: with
 * the mint deferred there is no identity token, so the statement uses facts the
 * agent holds about the job it ran. Only the token is deferred; these facts are
 * sealed (DSSE-signed) at build time.
 */
export interface LocalBuildContext {
  repository: string;
  ref: string;
  sha: string | null;
  /**
   * The token's `workflow_ref` claim (`<name>@<sha>`) when the orchestrator
   * supplied one. NOT a global workflow's clone ref: the two are never equal,
   * so a cross-check comparing them fails.
   */
  workflowRef: string;
  runId: string;
  jobId: string;
  orgId?: string;
  sourceOrigin?: SourceOrigin;
  /** Informational source provider, mirroring the live builder's `provider`. */
  provider?: string;
  /** The orchestrator's provenance issuer, for the `builder.id`. */
  issuer: string;
  /**
   * The orchestrator instance id, for the `builder.id`. Absent when the
   * orchestrator sent no provenance context, which yields the honest
   * `/orchestrator/unknown`.
   */
  orchestratorId?: string;
}

/**
 * Frozen statement for a deferred attestation (no minted token yet), marked
 * `attestationOrigin: 'deferred'`. The caller DSSE-signs it immediately and
 * computes its statement hash, one of the two bindings the later OIDC mint
 * commits to. Emits the same fields as `buildProvenanceStatement`, so a
 * statement frozen from an orchestrator-supplied context matches a live mint
 * field for field, which lets the orchestrator cross-check it against its run
 * row before signing anything that commits to it.
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
          // Emitted here exactly as the live builder emits it, so a deferred
          // statement and a live one differ only in `attestationOrigin`.
          ...(c.provider ? { provider: c.provider } : {}),
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
          id: `${c.issuer}/orchestrator/${c.orchestratorId ?? 'unknown'}`,
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

/** Validates against `kiciProvenanceStatementSchema`. */
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
