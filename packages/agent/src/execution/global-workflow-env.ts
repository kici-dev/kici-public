/**
 * The single writer of the `KICI_*` ambient env keys a global workflow's user
 * code sees, shared by the sandbox and the pre-dispatch global eval round in
 * the agent process. It cannot live in `sandbox/workflow-runner.ts`: that
 * module calls `main()` at import time.
 *
 * Both sides must set exactly the same keys. A `DynamicJobFn` gets
 * `process.env` as its `env` and is evaluated twice (pre-dispatch, then in the
 * sandbox to recover the step closures a `LockJob` cannot carry); a value on
 * one call and `undefined` on the other is a hard determinism failure in
 * `extractStepsFromDynamicJob`. `buildGeneratorContext` keeps the contexts'
 * shape identical; this keeps the ambient env identical.
 */

import type { RepoInfo } from '@kici-dev/sdk';

/** The source / workflow repo pair a global-workflow evaluation runs against. */
export interface GlobalWorkflowRepos {
  sourceRepo: RepoInfo;
  workflowRepo: RepoInfo;
}

/** Every env key {@link applyGlobalWorkflowEnv} writes, in one place. */
export const GLOBAL_WORKFLOW_ENV_KEYS = [
  'KICI_IS_GLOBAL_WORKFLOW',
  'KICI_WORKFLOW_REPO_PATH',
  'KICI_SOURCE_REPO_PATH',
  'KICI_SOURCE_REPO',
  'KICI_SOURCE_BRANCH',
  'KICI_SOURCE_SHA',
  'KICI_WORKFLOW_REPO',
] as const;

/**
 * Inject the global-workflow env keys and return a restorer that resets each
 * key to its prior value, or deletes it if it had none.
 *
 * **The restorer is mandatory in a long-lived process.** The sandbox may skip
 * it (one job per forked child, which exits); the agent-process eval round may
 * not. Left set there, a later non-global `DynamicJobFn` sees
 * `KICI_IS_GLOBAL_WORKFLOW=true` and a `KICI_SOURCE_REPO_PATH` to a deleted
 * work directory while its sandbox re-evaluation sees neither
 * (`buildSanitizedEnv` drops `KICI_*` on both profiles): the same determinism
 * failure, in an unrelated job.
 *
 * A missing `RepoInfo.ref` / `.sha` writes an empty string, as
 * `KICI_WORKFLOW_REPO` does for a missing identifier; assigning `undefined`
 * would stringify to `"undefined"`.
 */
export function applyGlobalWorkflowEnv(repos: GlobalWorkflowRepos): () => void {
  const prior = GLOBAL_WORKFLOW_ENV_KEYS.map((key) => [key, process.env[key]] as const);

  process.env.KICI_IS_GLOBAL_WORKFLOW = 'true';
  process.env.KICI_WORKFLOW_REPO_PATH = repos.workflowRepo.path;
  process.env.KICI_SOURCE_REPO_PATH = repos.sourceRepo.path;
  process.env.KICI_SOURCE_REPO = repos.sourceRepo.identifier;
  process.env.KICI_SOURCE_BRANCH = repos.sourceRepo.ref ?? '';
  process.env.KICI_SOURCE_SHA = repos.sourceRepo.sha ?? '';
  process.env.KICI_WORKFLOW_REPO = repos.workflowRepo.identifier;

  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
