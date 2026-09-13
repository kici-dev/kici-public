/**
 * The canonical build context the orchestrator sends with a job, so the agent
 * can freeze a provenance statement that says what a live mint would have said.
 *
 * A deferred attestation is signed BEFORE its identity token exists, so the
 * agent used to build the frozen statement from facts it held locally — and
 * those are not the facts the mint reads:
 *
 *   - the job's checkout `ref` is the PR HEAD branch, while the token's `ref`
 *     claim is `execution_runs.ref`, the BASE branch;
 *   - `request.workflowRef` is the git ref used to CLONE a global workflow's
 *     repository, while the token's `workflow_ref` claim is
 *     `<workflow_name>@<sha>`. Those two are never equal;
 *   - `provenanceIssuer` is declared and read but written by no dispatch path,
 *     so every frozen statement recorded `builder.id` as `/orchestrator/unknown`.
 *
 * So a field-by-field cross-check would have failed on every legitimate
 * deferred attestation — which is exactly why the verifier's deferred branch
 * was written as a hash equality instead. Sending the mint's own view of the
 * run makes the cross-check meaningful, and only then can it be switched on.
 */
import type { Kysely } from 'kysely';
import { SourceOrigin, type ProvenanceContext } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { resolveOrgId } from '../pipeline/processor.js';
import { DEFAULT_ORG_ID } from '../oidc/orchestrator-mint.js';

/**
 * Load the provenance context for a (run, job) from the same rows and the same
 * derivations `buildIdTokenClaims` uses.
 *
 * Returns undefined only when the run row is absent. In particular this does
 * NOT gate on a configured provenance issuer: the cross-check reads
 * `repository` / `ref` / `sha` / `workflowRef` / `runId` / `jobId`, none of
 * which depends on who signs the token. Only the statement's `builder.id`
 * needs an issuer, and an unset one reproduces the `/orchestrator/unknown`
 * builder the local guess has always recorded.
 *
 * Gating on the issuer here dropped the context for every orchestrator still
 * on the deprecated Platform-relay mint, so its agent fell back to the local
 * guess — `repository: 'unknown/unknown'` for a `file://` clone, and a bare
 * workflow name where the claim is `<name>@<sha>` — and the capture check
 * then refused every one of its deferred attestations.
 */
export async function loadProvenanceContext(
  db: Kysely<Database>,
  runId: string,
  jobId: string,
  opts: { issuer: string | undefined; orchestratorId: string },
): Promise<ProvenanceContext | undefined> {
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
    ])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!run) return undefined;

  const orgId = run.routing_key ? await resolveOrgId(db, run.routing_key) : DEFAULT_ORG_ID;

  return {
    repository: run.repo_identifier,
    ref: run.ref,
    sha: run.sha,
    // The token's `workflow_ref` claim, NOT the clone ref of a global
    // workflow's repository. `crossCheckBuildContext` compares the statement's
    // `workflow.path` against this value.
    workflowRef: workflowRefClaim(run.workflow_name, run.sha),
    runId: run.run_id,
    jobId,
    orgId,
    sourceOrigin: run.local_working_tree
      ? SourceOrigin.enum['run-remote']
      : SourceOrigin.enum.triggered,
    provider: run.provider,
    // Empty when orchestrator-owned signing is off. Not verification
    // load-bearing: `crossCheckBuildContext` never reads `builder.id`.
    issuer: opts.issuer ?? '',
    orchestratorId: opts.orchestratorId,
  };
}

/** `<workflow_name>@<sha>`, exactly as `buildIdTokenClaims` derives it. */
function workflowRefClaim(workflowName: string | null, sha: string | null): string | null {
  if (!workflowName) return null;
  return sha ? `${workflowName}@${sha}` : workflowName;
}
