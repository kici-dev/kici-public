/**
 * Capture-time cross-check for a deferred provenance attestation.
 *
 * The invariant: **the orchestrator never signs a statement it has not checked
 * against its own run row.** A deferred capture is the one place a statement
 * arrives already DSSE-signed by the job, and the orchestrator later mints a
 * real, server-signed token that commits to it by hash. So whatever the job
 * says here becomes something the orchestrator vouches for.
 *
 * Before this check, the handler forwarded `subjectDigest`, `statementHash`,
 * `dsseEnvelope` and `publicKey` straight into `pending_attestations`. Nothing
 * decoded the payload, nothing compared `repository` / `ref` / `sha` /
 * `workflow_ref` / `runId` / `jobId` against the run row, and `statementHash`
 * was stored as sent rather than recomputed. A compromised job — a fork PR's
 * test script, or any code in the agent process — could therefore freeze a
 * statement claiming a release SHA it never built, and the orchestrator would
 * sign a token binding its own identity to it.
 *
 * Called from the `onProvenanceDefer` insert site rather than the WS handler:
 * that closure has no database handle, and the insert site covers every caller
 * of `onProvenanceDefer`, present and future.
 */
import { crossCheckBuildContext, checkSubjectDigest } from '@kici-dev/engine/provenance/verify';
import { computeStatementHash } from '@kici-dev/engine/provenance/statement-hash';
import {
  kiciProvenanceStatementSchema,
  type KiciProvenanceStatement,
} from '@kici-dev/engine/provenance/schema';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  DeferredAttestationRejectReason,
  incDeferredAttestationRejected,
} from '../metrics/prometheus.js';
import { buildIdTokenClaims } from '../oidc/id-token-claims.js';
import { DEFAULT_ORG_ID } from '../oidc/orchestrator-mint.js';
import { resolveOrgId } from '../pipeline/processor.js';

/** What the capture handler hands over, before anything is persisted. */
export interface DeferredCaptureRecord {
  runId: string;
  jobId: string;
  subjectDigest: string;
  statementHash: string;
  dsseEnvelope: unknown;
}

/**
 * Accepted, with the RECOMPUTED statement hash — never the agent-supplied one,
 * even when they agree. The later mint binds the token to this value.
 */
export type DeferredCaptureVerdict =
  | { ok: true; statementHash: string }
  | { ok: false; reason: DeferredAttestationRejectReason; detail: string };

/** Decode a DSSE envelope's base64 payload into the raw statement bytes. */
function decodePayload(envelope: unknown): Uint8Array | null {
  const payload = (envelope as { payload?: unknown } | null)?.payload;
  if (typeof payload !== 'string') return null;
  try {
    return new Uint8Array(Buffer.from(payload, 'base64'));
  } catch {
    return null;
  }
}

function reject(reason: DeferredAttestationRejectReason, detail: string): DeferredCaptureVerdict {
  incDeferredAttestationRejected(reason);
  return { ok: false, reason, detail };
}

/**
 * Check a deferred capture against the orchestrator's own rows, fail closed.
 *
 * A rejection is a DROP: the job stays green and has no attestation.
 * That is a degradation, whereas storing an unchecked statement re-introduces
 * the forgery primitive — every gate that lets one through is the hole again.
 * An agent too old to receive `provenanceContext` freezes the legacy statement
 * shape and is dropped for the same reason, with the mismatched field named so
 * the operator can see the upgrade is what fixes it.
 */
export async function checkDeferredCapture(deps: {
  db: Kysely<Database>;
  record: DeferredCaptureRecord;
  orchestratorId: string;
}): Promise<DeferredCaptureVerdict> {
  const { db, record } = deps;

  const statementBytes = decodePayload(record.dsseEnvelope);
  if (!statementBytes) {
    return reject(DeferredAttestationRejectReason.Unparseable, 'dsse payload is not base64');
  }

  let statement: KiciProvenanceStatement;
  try {
    statement = kiciProvenanceStatementSchema.parse(
      JSON.parse(Buffer.from(statementBytes).toString('utf8')),
    );
  } catch (err) {
    return reject(
      DeferredAttestationRejectReason.Unparseable,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Recompute rather than trust. The agent supplies `statementHash`, and the
  // later mint stamps it into a server-signed claim — so an agent-chosen value
  // would let the token commit to a statement the orchestrator never read.
  const statementHash = await computeStatementHash(statementBytes);
  if (statementHash !== record.statementHash) {
    return reject(
      DeferredAttestationRejectReason.StatementHashMismatch,
      `reported ${record.statementHash}, recomputed ${statementHash}`,
    );
  }

  const claims = await buildDeferredClaims(db, record, deps.orchestratorId);
  if (!claims) {
    return reject(
      DeferredAttestationRejectReason.RunNotFound,
      `run ${record.runId} / job ${record.jobId} not found`,
    );
  }

  if (!crossCheckBuildContext(statement, claims as unknown as Record<string, unknown>)) {
    return reject(
      DeferredAttestationRejectReason.BuildContextMismatch,
      describeMismatch(statement, claims),
    );
  }

  if (!checkSubjectDigest(statement, { alg: 'sha256', hex: record.subjectDigest })) {
    return reject(
      DeferredAttestationRejectReason.SubjectDigestMismatch,
      `subjectDigest ${record.subjectDigest} appears in no subject of the statement`,
    );
  }

  return { ok: true, statementHash };
}

/**
 * Build the claims a later mint for this (run, job) will carry, from the same
 * rows and the same derivation `mintOrchestratorIdToken` uses.
 *
 * The issuer, audience and clock are placeholders: `crossCheckBuildContext`
 * reads only `repository` / `ref` / `workflow_ref` / `sha` / `kici_run_id` /
 * `kici_job_id`, none of which depends on them.
 */
async function buildDeferredClaims(
  db: Kysely<Database>,
  record: DeferredCaptureRecord,
  orchestratorId: string,
): Promise<ReturnType<typeof buildIdTokenClaims> | null> {
  const run = await db
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
      'trigger_event',
      'subject_trigger_event',
      'head_ref',
      'head_repository',
      'is_fork',
      'trust_tier',
      'trigger_actor_username',
    ])
    .where('run_id', '=', record.runId)
    .executeTakeFirst();
  if (!run) return null;

  const job = await db
    .selectFrom('execution_jobs')
    .select(['run_id', 'job_id', 'status'])
    .where('run_id', '=', record.runId)
    .where('job_id', '=', record.jobId)
    .executeTakeFirst();
  if (!job) return null;

  const orgId = run.routing_key ? await resolveOrgId(db, run.routing_key) : DEFAULT_ORG_ID;

  return buildIdTokenClaims(
    { ...run, org_id: orgId },
    { run_id: job.run_id, job_id: job.job_id, orchestrator_id: orchestratorId, status: job.status },
    { issuer: '', audience: '', nowSeconds: 0, ttlSeconds: 0 },
  );
}

/** Name the first field that disagrees, so the warn log is actionable. */
function describeMismatch(
  statement: KiciProvenanceStatement,
  claims: ReturnType<typeof buildIdTokenClaims>,
): string {
  const bd = statement.predicate.buildDefinition;
  const wf = bd.externalParameters.workflow;
  const ip = bd.internalParameters ?? {};
  const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['repository', wf.repository, claims.repository ?? ''],
    ['ref', wf.ref, claims.ref ?? ''],
    ['workflow_ref', wf.path, claims.workflow_ref ?? ''],
    ['sha', ip.commit ?? '', claims.sha ?? ''],
    ['runId', ip.runId, claims.kici_run_id],
    ['jobId', ip.jobId, claims.kici_job_id],
  ];
  const bad = pairs.filter(([, statementValue, claimValue]) => statementValue !== claimValue);
  return bad
    .map(
      ([field, statementValue, claimValue]) =>
        `${field}: statement=${String(statementValue)} run=${String(claimValue)}`,
    )
    .join('; ');
}
