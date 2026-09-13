/**
 * The single writer of the seven `KICI_*` ambient env keys a global workflow's
 * user code sees.
 *
 * It lives here rather than in `sandbox/workflow-runner.ts` because that module
 * calls `main()` at import time — it is the sandbox process entry point — so the
 * agent's own process cannot import it. The pre-dispatch global eval round runs
 * in the agent process and must set exactly the same keys the sandbox does.
 *
 * Why exactly the same keys: `extractAndNormalizeSteps` hands a `DynamicJobFn`
 * `process.env` as its `env`, and a generator is evaluated twice — once
 * pre-dispatch, once inside the sandbox to recover the step closures a `LockJob`
 * cannot carry. A generator that reads `process.env.KICI_SOURCE_REPO_PATH` and
 * gets a value on one call and `undefined` on the other has seen two different
 * worlds, which `extractStepsFromDynamicJob` turns into a hard determinism
 * failure. `buildGeneratorContext` keeps the two contexts' *shape* identical; it
 * cannot keep the ambient env identical, which is what this does.
 */

import type { RepoInfo } from '@kici-dev/sdk';

/** The source / workflow repo pair a global-workflow evaluation runs against. */
export interface GlobalWorkflowRepos {
  sourceRepo: RepoInfo;
  workflowRepo: RepoInfo;
}

/**
 * Derive an `owner/repo` identifier from a clone URL, stripping the trailing
 * `.git` and any `http(s)://host/` prefix.
 */
export function repoIdentifierFromUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '');
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
 * Inject the seven global-workflow env keys and return a restorer that puts
 * `process.env` back exactly as it was — each key reset to its prior value, or
 * deleted if it had none.
 *
 * **The restorer is mandatory for any caller in a long-lived process.** The
 * sandbox may ignore it: it runs one job per forked child, which exits. The
 * pre-dispatch global eval round may NOT: it runs in the agent process, which
 * serves many dispatches from one `JobRunner`. Leaving the keys set there is
 * this module's own hazard running backwards — a later NON-global
 * `DynamicJobFn` evaluation builds its generator context with
 * `env: process.env` still carrying `KICI_IS_GLOBAL_WORKFLOW=true` and a
 * `KICI_SOURCE_REPO_PATH` pointing at a deleted work directory, while that
 * job's own sandbox re-evaluation sees neither (`buildSanitizedEnv` scrubs the
 * whole `KICI_*` namespace on the trusted profile, and the default profile is
 * allowlist-only). That is the same two-worlds determinism failure, injected
 * into an unrelated job.
 *
 * `RepoInfo.ref` / `.sha` are optional, so an evaluation with no checkout
 * metadata writes an empty string rather than leaving the key unset — matching
 * how `KICI_WORKFLOW_REPO` already handles a missing identifier. Assigning
 * `undefined` to a `process.env` key would stringify to `"undefined"`, which is
 * worse than either.
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
