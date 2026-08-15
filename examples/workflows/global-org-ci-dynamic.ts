import { workflow, job, step, push } from '@kici-dev/sdk';
import type { DynamicJobFn } from '@kici-dev/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Org-wide CI, tier 3 — generate the job set from source-repo state.
 *
 * Reads the source repo's `package.json` (via `sourceRepo.path`) and emits one
 * job per `ci:*` script it finds — so each repo runs exactly the CI it declares,
 * defined once, centrally. This is the pattern YAML can only approximate with a
 * bounded matrix; here it is real programmatic job generation in TypeScript.
 */
// #region dynamic
const perScript: DynamicJobFn = async ({ sourceRepo }) => {
  const root = sourceRepo?.path ?? '.';
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const ciScripts = Object.keys(pkg.scripts ?? {}).filter((s) => s.startsWith('ci:'));
  return ciScripts.map((name) =>
    job(name.replace(':', '-'), {
      runsOn: 'kici:os:linux',
      steps: [
        step('run', async ({ $ }) => {
          await $`pnpm run ${name}`;
        }),
      ],
    }),
  );
};

export default workflow('org-ci-matrix', {
  on: [push({ repos: ['myorg/*'], branches: ['main'] })],
  jobs: [perScript],
});
// #endregion
