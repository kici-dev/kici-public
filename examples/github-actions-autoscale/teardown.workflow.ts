/**
 * Tear down GitHub Actions runners for a KiCI `event` scaler.
 *
 * A GitHub Actions run self-completes when its one-shot agent exits, so most
 * scale-downs need no action at all. This workflow cancels a run only when the
 * agent will never do useful work — it never started, or it went silent. That
 * distinction is the whole design: cancelling on a healthy exit races the run's
 * own finalisation and turns a success into a cancellation.
 *
 * Copy this into your `.kici/workflows/` alongside `provision.workflow.ts`.
 */
// #region teardown
import {
  workflow,
  job,
  step,
  kiciEvent,
  SCALER_EVENT_NAMES,
  ScaleDownReason,
  ScalerScaleDownPayload,
} from '@kici-dev/sdk';

/** Must match the `name:` of the `event` scaler in your `scalers.yaml`. */
const SCALER_NAME = 'github-actions';
const GH_WORKFLOW = 'kici-agent.yml';

/**
 * The only two reasons that mean the run will never do useful work:
 *
 *   spawn-timeout      no agent ever registered against the spawn
 *   heartbeat-timeout  the agent registered, then went silent
 *
 * Every other reason is left alone. `shutdown` in particular is what a HEALTHY
 * one-shot agent emits when it exits after finishing its job — cancelling on it
 * would kill a run that is already succeeding. An unrecognised reason falls
 * through to doing nothing, which is always the safe default here: the run
 * reaps itself.
 */
export const CANCELABLE: ScaleDownReason[] = ['spawn-timeout', 'heartbeat-timeout'];

export default workflow('github-actions-autoscale-teardown', {
  on: [kiciEvent({ name: SCALER_EVENT_NAMES.scaleDown, match: { '$.scalerName': SCALER_NAME } })],
  jobs: [
    job('teardown', {
      runsOn: ['default'],
      // Binds the `github-actions` context. Required for BOTH halves: the
      // dispatch token this job reads, and `GITHUB_RUNNER_REPO` below — context
      // variables resolve only from the contexts a job binds, so an unbound
      // teardown reads `undefined` for the repo.
      context: 'github-actions',
      steps: [
        step('cancel-stranded-run', async (ctx) => {
          const p = ScalerScaleDownPayload.parse(ctx.rawPayload);
          if (!CANCELABLE.includes(p.reason)) {
            ctx.log.info(`teardown reason=${p.reason} agent=${p.agentId} action=skip`);
            return;
          }

          const runnerRepo = ctx.env.GITHUB_RUNNER_REPO ?? 'myorg/ci-runners';
          const token = await ctx.secrets.get('GITHUB_DISPATCH_TOKEN');
          const headers = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          };

          // `kici-agent.yml` sets its `run-name` to `kici-agent {agent_id}`,
          // which is how a scale-down finds the run its agent belongs to. One
          // page bounds it for most pools: the run is at most one spawn-timeout
          // window old, so a pool creating fewer than 100 runs of this workflow
          // inside that window always finds it here. A busier pool needs
          // pagination. What decides is the age of the RUN — the list is newest
          // first — not how fast the teardown follows the scale-down.
          const listed = await fetch(
            `https://api.github.com/repos/${runnerRepo}/actions/workflows/${GH_WORKFLOW}/runs?per_page=100`,
            { headers },
          );
          if (!listed.ok) {
            throw new Error(`listing runs failed: ${listed.status} ${await listed.text()}`);
          }
          const body = (await listed.json()) as {
            workflow_runs: Array<{ id: number; name?: string; status: string }>;
          };
          const run = body.workflow_runs.find((r) => r.name === `kici-agent ${p.agentId}`);

          // Anything GitHub has not marked `completed` is still live — that
          // covers `queued` and `in_progress` plus the pre-start states
          // (`requested`, `waiting`, `pending`), which is exactly where a
          // spawn-timeout run sits. Listing the live states instead would
          // decline to cancel the case this workflow exists for.
          if (!run || run.status === 'completed') {
            ctx.log.info(
              `teardown reason=${p.reason} agent=${p.agentId} action=skip (no live run)`,
            );
            return;
          }

          const cancelled = await fetch(
            `https://api.github.com/repos/${runnerRepo}/actions/runs/${run.id}/cancel`,
            { method: 'POST', headers },
          );
          // 409 is GitHub refusing the cancel, most often because the run
          // finished between the list above and this call. A teardown the
          // orchestrator could not deliver is retried, so treating that as a
          // failure would fail the workflow forever over a run that is already
          // in the state the teardown wanted.
          if (cancelled.status === 409) {
            ctx.log.info(
              `teardown reason=${p.reason} agent=${p.agentId} action=skip ` +
                `(run ${run.id} not cancelable: 409, most often already completed)`,
            );
            return;
          }
          if (!cancelled.ok) {
            throw new Error(`cancel failed: ${cancelled.status} ${await cancelled.text()}`);
          }
          ctx.log.info(
            `teardown reason=${p.reason} agent=${p.agentId} action=cancel run=${run.id}`,
          );
        }),
      ],
    }),
  ],
});
// #endregion
