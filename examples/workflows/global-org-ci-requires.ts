import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Org-wide CI, tier 1 — declarative content filter.
 *
 * One workflow repo defines this; it fires on a push to `main` of ANY repo in
 * the org (`repos: ['myorg/*']`), but only for repos whose root `package.json`
 * declares a `ci:test` script. Repos without it are dropped by the orchestrator
 * before any agent is dispatched — no compute is spent on a repo that opted out.
 */
// #region requires
export default workflow('org-ci-test', {
  on: [
    push({
      repos: ['myorg/*'],
      branches: ['main'],
      requires: [{ file: 'package.json', exists: ["$.scripts['ci:test']"] }],
    }),
  ],
  jobs: [
    job('test', {
      runsOn: 'kici:os:linux',
      steps: [
        step('ci-test', async ({ $ }) => {
          await $`pnpm run ci:test`;
        }),
      ],
    }),
  ],
});
// #endregion
