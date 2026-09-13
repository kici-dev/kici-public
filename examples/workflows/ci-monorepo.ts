import { workflow, job, step, rule, pr, push } from '@kici-dev/sdk';
import { readdir } from 'node:fs/promises';

/**
 * Monorepo CI - dynamic matrix, reused step, conditional deploy
 *
 * Discovers the workspace packages at runtime and fans out a test job per
 * package, then deploys only on a push to main. The `install` step is shared
 * across both jobs because each job runs on its own agent with a fresh clone,
 * so `deploy` must install dependencies too before it can run.
 */

const install = step('install', async ({ $ }) => {
  await $`pnpm install --frozen-lockfile`;
});

export default workflow('ci', {
  on: [pr(), push({ branches: 'main' })],
  jobs: [
    job('test', {
      runsOn: 'kici:os:linux',
      // discover packages at runtime — a real loop, not a hardcoded list
      matrix: async () => {
        const entries = await readdir('packages', { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      },
      steps: [
        install,
        step('test', async ({ $, matrix }) => {
          await $`pnpm --filter ${matrix!.value} test`;
        }),
      ],
    }),
    job('deploy', {
      runsOn: 'kici:os:linux',
      needs: ['test'],
      rules: [
        rule(
          'only on main',
          ({ event }) => event.type === 'push' && event.payload?.ref === 'refs/heads/main',
        ),
      ],
      steps: [
        install,
        step('deploy', async ({ $ }) => {
          await $`pnpm run deploy`;
        }),
      ],
    }),
  ],
});
