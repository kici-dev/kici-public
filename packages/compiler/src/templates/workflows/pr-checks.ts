// PR Checks -- workflow with rules, dependencies, and multiple jobs
// Docs: https://kici.dev/docs/sdk-reference
// Patterns: https://kici.dev/docs/workflow-patterns

import { workflow, job, step, pr, rule, skip, isEventType } from '@kici-dev/sdk';

export const prChecksWorkflow = workflow('pr-checks', {
  // Trigger: pr() matches pull request events
  // Options: target, paths, events (config-style)
  on: pr({ target: 'main', paths: ['src/**'] }),

  // Rules: evaluated before workflow runs
  // skip() = skip if true, rule() = run only if true
  rules: [
    skip('skip-draft-prs', async (ctx) => {
      // Raw provider fields live under `ctx.event.payload`; narrow first for typing.
      if (!isEventType(ctx.event, 'pull_request')) return false;
      return ctx.event.payload.pull_request.draft === true;
    }),

    rule('require-src-changes', async (ctx) => {
      return ctx.changedFiles.some((file) => file.startsWith('src/'));
    }),
  ],

  // Jobs: run in parallel unless connected via `needs`
  jobs: [
    job('lint', {
      runsOn: 'kici:os:linux',
      steps: [
        step('checkout', async ({ $ }) => {
          await $`echo "Checking out code..."`;
        }),
        step('run-linter', async ({ $ }) => {
          // Replace with your linter: eslint, biome, cargo clippy, etc.
          await $`echo "Running linter..."`;
        }),
      ],
    }),

    job('test', {
      runsOn: 'kici:os:linux',
      needs: ['lint'], // Waits for lint to pass
      steps: [
        step('checkout', async ({ $ }) => {
          await $`echo "Checking out code..."`;
        }),
        step('install-deps', async ({ $ }) => {
          // Replace with: npm ci, etc.
          await $`echo "Installing dependencies..."`;
        }),
        step('run-tests', async ({ $ }) => {
          // Replace with: npm test, vitest run, cargo test, etc.
          await $`echo "Running tests..."`;
        }),
      ],
    }),
  ],
});
