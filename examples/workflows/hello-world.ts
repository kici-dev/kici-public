import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Hello World workflow - minimal example
 *
 * Triggered on any push, runs a single job that echoes "Hello, World!"
 */
export default workflow('hello-world', {
  on: push(),
  jobs: [
    job('greet', {
      runsOn: 'kici:os:linux',
      steps: [
        step('say-hello', async ({ $ }) => {
          await $`echo "Hello, World!"`;
        }),
      ],
    }),
  ],
});
