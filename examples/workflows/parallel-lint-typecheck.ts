import { workflow, job, step, parallel, push } from '@kici-dev/sdk';

/**
 * Parallel steps within a job
 *
 * Wraps independent checks in `parallel([...])` so they run concurrently behind
 * a join barrier — each child surfaces as its own observable dashboard step
 * (own logs, status, timing), and the job's wall-clock is the slowest child,
 * not the sum. `failFast: true` (the default) cancels in-flight siblings the
 * moment one child fails, so a fast lint failure stops a slow typecheck instead
 * of waiting it out.
 */
export default workflow('parallel-checks', {
  on: push(),
  jobs: [
    job('checks', {
      runsOn: 'kici:os:linux',
      steps: [
        step('checkout', async ({ $ }) => {
          await $`echo "fetched sources"`;
        }),
        // The three checks have no ordering between them, so they run together.
        // `slow` sleeps long enough that a sequential run would be visibly
        // slower — proof the group overlaps rather than serializes.
        parallel(
          [
            step('lint', async ({ $ }) => {
              await $`echo "linting"`;
            }),
            step('typecheck', async ({ $ }) => {
              await $`echo "type-checking"`;
            }),
            step('slow', async ({ $ }) => {
              await $`sleep 3 && echo "slow check done"`;
            }),
          ],
          { failFast: true, name: 'checks' },
        ),
      ],
    }),
  ],
});
