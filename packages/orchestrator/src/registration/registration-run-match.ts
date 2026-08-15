import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Match `execution_runs` rows to the registrations that define their workflow.
 *
 * A registration always names the repository the workflow is DEFINED in. A run
 * names two repositories: `repo_identifier` is the one it acted on and whose
 * code its jobs checked out, and `workflow_repo_identifier` is the one that
 * defines the workflow — recorded only when the two differ, which is exactly an
 * organization-wide workflow dispatched against another repository.
 *
 * So the repository a registration must be matched on is
 * `workflow_repo_identifier ?? repo_identifier`. Matching on `repo_identifier`
 * alone is wrong in both directions at once: a global registration matches none
 * of its own runs, and a same-named registration in the acted-on repository
 * matches all of them.
 *
 * Both consumers — the "last triggered" enrichment and the delete path's
 * in-flight cancellation — share this one predicate deliberately. Fixing one
 * and not the other would leave the dashboard showing a global workflow as
 * triggered while deleting it still cancelled nothing.
 *
 * A NULL marker is evidence of a per-repository run only because every
 * recording site states which repository defines the workflow it is recording,
 * and the sites narrow that to NULL exactly when it is the repository the run
 * acted on. The predicate never infers the answer, and the recording sites do
 * not leave it to a default: `recordInitFailureRun`, `recordRunHeld` and
 * `recordGlobalEvalRoundFailureRun` take the defining repository as a required
 * argument, and `WorkflowDispatchContext` carries it as a required field, so a
 * dispatch path that does not state it does not compile. The one run-start
 * recorder that takes it as a trailing positional, `onExecutionStarted`, is
 * supplied by the global dispatch path — the only path where the two
 * repositories differ.
 */
export function runsDefinedByRepos(
  eb: ExpressionBuilder<Database, 'execution_runs'>,
  repoIdentifiers: readonly string[],
): ExpressionWrapper<Database, 'execution_runs', SqlBool> {
  const repos = [...repoIdentifiers];
  // An empty list matches nothing. Said explicitly because the alternative is
  // not an empty result but a Postgres syntax error: Kysely renders an empty
  // `in` as `in ()`. Both call sites happen to guard, but this is a shared
  // predicate and the next one may not.
  if (repos.length === 0) return eb.lit(false);
  return eb.or([
    eb('workflow_repo_identifier', 'in', repos),
    eb.and([eb('workflow_repo_identifier', 'is', null), eb('repo_identifier', 'in', repos)]),
  ]);
}

/**
 * The repository that defines the workflow a run executed — the read-side
 * counterpart of {@link runsDefinedByRepos}, applied to a row the query
 * returned. Selecting `workflow_repo_identifier` alongside `repo_identifier`
 * and folding here keeps the grouping key the same expression the predicate
 * filters on.
 */
export function definingRepoOfRun(row: {
  repo_identifier: string;
  workflow_repo_identifier: string | null;
}): string {
  return row.workflow_repo_identifier ?? row.repo_identifier;
}
