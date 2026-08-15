import { workflow, job, step, push } from '@kici-dev/sdk';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Org-wide CI, tier 2 — a TypeScript filter predicate.
 *
 * The predicate runs once per (event × workflow repo) on an evaluating agent
 * with the source repo checked out, so it can inspect the real tree via
 * `sourceRepo.path`. Here it runs the pipeline only for repos that ship BOTH a
 * Dockerfile and a `ci:build` script. Unlike the tier-1 `requires` filter, this
 * works with any provider that clones — the logic is arbitrary TypeScript.
 */
// #region filter
export default workflow('org-ci-build', {
  on: [push({ repos: ['myorg/*'], branches: ['main'] })],
  filter: async ({ sourceRepo }) => {
    const root = sourceRepo.path;
    if (!existsSync(join(root, 'Dockerfile'))) return false;
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return typeof pkg?.scripts?.['ci:build'] === 'string';
  },
  jobs: [
    job('build', {
      runsOn: 'kici:os:linux',
      steps: [
        step('ci-build', async ({ $ }) => {
          await $`pnpm run ci:build`;
        }),
      ],
    }),
  ],
});
// #endregion
