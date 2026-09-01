/**
 * Provision GitHub Actions runners for a KiCI `event` scaler.
 *
 * Subscribes to the reserved `kici.scaler.scale-up` event and dispatches a
 * `kici-agent.yml` run in your runner repo. That run boots a one-shot KiCI agent
 * which exchanges the forwarded claim code for its own credentials, so the agent
 * token never travels in the dispatch inputs — a leaked dispatch payload grants
 * nothing, and the claim code is single-use.
 *
 * Copy this into your `.kici/workflows/` alongside `teardown.workflow.ts`.
 */
// #region provision
import {
  workflow,
  job,
  step,
  kiciEvent,
  SCALER_EVENT_NAMES,
  ScalerScaleUpPayload,
} from '@kici-dev/sdk';

/** Must match the `name:` of the `event` scaler in your `scalers.yaml`. */
const SCALER_NAME = 'github-actions';

/** The one-shot runner workflow in your runner repo, and the ref to dispatch. */
const GH_WORKFLOW = 'kici-agent.yml';
const GH_REF = 'main';

export default workflow('github-actions-autoscale-provision', {
  on: [kiciEvent({ name: SCALER_EVENT_NAMES.scaleUp, match: { '$.scalerName': SCALER_NAME } })],
  jobs: [
    job('provision', {
      runsOn: ['default'],
      // Binds the `github-actions` context, which carries both the dispatch
      // token and this integration's two settings. Load-bearing: the job option
      // is `context`, and an unrecognised key is DROPPED at compile time rather
      // than rejected — so a typo here fails at run time on an unresolved
      // secret, never at compile time.
      context: 'github-actions',
      steps: [
        step('dispatch', async (ctx) => {
          const p = ScalerScaleUpPayload.parse(ctx.rawPayload);

          // Your runner repo, as `owner/repo`. Set it once on the context:
          //   kici-admin variable set <orgId> github-actions \
          //     GITHUB_RUNNER_REPO --value myorg/ci-runners
          // or replace the fallback below in your own copy.
          const runnerRepo = ctx.env.GITHUB_RUNNER_REPO ?? 'myorg/ci-runners';

          // Optional. A release tag holding a `kici-admin agent package` tarball
          // the runner installs instead of the published npm agent. Leave it
          // unset unless you pin exact builds or your runners cannot reach npm.
          const agentBundleRelease = ctx.env.GITHUB_AGENT_BUNDLE_RELEASE;

          const inputs: Record<string, string> = {
            claim_code: p.claimCode,
            orchestrator_url: p.orchestratorUrl,
            agent_id: p.agentId,
            labels: p.labels.join(','),
          };
          if (agentBundleRelease) inputs.agent_bundle_release = agentBundleRelease;

          const token = await ctx.secrets.get('GITHUB_DISPATCH_TOKEN');
          const res = await fetch(
            `https://api.github.com/repos/${runnerRepo}/actions/workflows/${GH_WORKFLOW}/dispatches`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
              body: JSON.stringify({ ref: GH_REF, inputs }),
            },
          );
          // GitHub answers a successful dispatch with 204 and no body.
          if (!res.ok && res.status !== 204) {
            throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
          }
          ctx.log.info(`Dispatched ${GH_WORKFLOW} in ${runnerRepo} for agent ${p.agentId}`);
        }),
      ],
    }),
  ],
});
// #endregion
