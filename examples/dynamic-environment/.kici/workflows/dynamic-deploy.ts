import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Dynamic environment + dynamic env vars from the triggering event.
 *
 * Demonstrates that `job.environment` and `job.env` accept callbacks that
 * receive the normalized event, so one job definition can deploy to different
 * targets without being duplicated. A push to `main` selects the `production`
 * environment and a `prod` deploy target; anything else falls back to staging.
 * The orchestrator resolves these callbacks at dispatch time, so the values are
 * fixed before the agent ever runs the step.
 */
export default workflow('dynamic-deploy', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('deploy', {
      // Environment name is computed per-event: `main` -> production, else staging.
      environment: (event) => (event.targetBranch === 'main' ? 'production' : 'staging'),
      // Env vars are computed the same way and injected into every step's shell.
      env: (event) => ({
        DEPLOY_TARGET: event.targetBranch === 'main' ? 'prod' : 'stg',
      }),
      runsOn: ['self-hosted'],
      steps: [
        step('deploy', async ({ $, env }) => {
          // DEPLOY_TARGET came from the job-level `env` callback above.
          await $`echo "Deploying to ${env.DEPLOY_TARGET}"`;
        }),
      ],
    }),
  ],
});
