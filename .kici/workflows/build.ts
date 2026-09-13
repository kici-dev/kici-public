import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('build', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('install-build-test', {
      runsOn: 'default',
      steps: [
        step('versions', async ({ $ }) => {
          await $`node --version`;
          await $`pnpm --version`;
        }),
        step('install', async ({ $ }) => {
          await $`pnpm install --frozen-lockfile`;
        }),
        step('typecheck', async ({ $ }) => {
          await $`pnpm typecheck`;
        }),
        step('build', async ({ $ }) => {
          await $`pnpm -r run build`;
        }),
        step('test', async ({ $ }) => {
          await $`pnpm -r run test --if-present`;
        }),
      ],
    }),
  ],
});
