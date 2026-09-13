// Hello World -- minimal push workflow
// Docs: https://kici.dev/docs/sdk-reference

import { workflow, job, step, push } from '@kici-dev/sdk';

export const helloWorldWorkflow = workflow('hello-world', {
  // Trigger: push() matches any push event
  // Options: branches, tags, paths, description (config-style; use !-prefix for exclusions)
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
