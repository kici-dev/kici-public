---
title: 'Autoscaling workflows'
description: 'Write TypeScript provisioning and teardown workflows that boot and delete ephemeral cloud agents in response to the event scaler'
---

The [event scaler backend](../../operator/orchestrator/event-scaler.md) turns cloud autoscaling into ordinary workflow authoring. When the orchestrator needs a new agent, the event scaler emits a `kici.scaler.scale-up` event. When an agent is no longer needed, it emits a `kici.scaler.scale-down` event. You write two workflows: one that boots a cloud instance on scale-up, and one that deletes it on scale-down.

No cloud SDK ships inside KiCI. Your workflow calls the cloud provider's API directly. The examples below target Hetzner Cloud, but the same shape fits any provider with a create/delete API.

This page assumes you know the [`kiciEvent()`](../sdk/triggers.md) trigger and [custom events](../events.md). For the full event payloads, see the [event contract reference](../../operator/orchestrator/event-scaler-events.md).

The SDK exports the two event names and their payload schemas, so you subscribe with the same constant the scaler emits and parse the payload instead of casting it. Import `SCALER_EVENT_NAMES`, `ScalerScaleUpPayload`, `ScalerScaleDownPayload` and `ScaleDownReason` from `@kici-dev/sdk` — see [validation and events](../sdk/validation-events.md#event-scaler-events).

## The provisioning workflow

The provisioning workflow subscribes to `kici.scaler.scale-up` and matches on the scaler name. It reads the payload from `ctx.rawPayload`, forwards the single-use claim code into a cloud instance, and boots that instance. The agent claims its own token in-instance and registers with the given `agentId`.

```ts
import {
  workflow,
  job,
  kiciEvent,
  buildAgentCloudInit,
  SCALER_EVENT_NAMES,
  ScalerScaleUpPayload,
} from '@kici-dev/sdk';

const SCALER_NAME = 'hetzner';

export default workflow('hetzner-autoscale-provision', {
  on: [kiciEvent({ name: SCALER_EVENT_NAMES.scaleUp, match: { '$.scalerName': SCALER_NAME } })],
  jobs: [
    job('provision', {
      runsOn: ['default'],
      // Bind the context that holds the credential this job reads. A job
      // resolves only the secrets of the contexts it binds.
      context: 'hetzner-autoscale',
      run: async (ctx) => {
        const payload = ScalerScaleUpPayload.parse(ctx.rawPayload);

        // Forward the single-use claim code into cloud-init. The agent claims
        // its own token in-instance, so the token never transits provisioning.
        const userData = buildAgentCloudInit(
          {
            claimCode: payload.claimCode,
            agentId: payload.agentId,
            orchestratorUrl: payload.orchestratorUrl,
            labels: payload.labels,
          },
          {
            maxLifetimeMinutes: 30,
            deliveryMode: 'container',
          },
        );

        const token = await ctx.secrets.get('HETZNER_API_TOKEN');
        const res = await fetch('https://api.hetzner.cloud/v1/servers', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `kici-agent-${payload.agentId}`,
            server_type: 'cpx12',
            image: 'debian-12',
            user_data: userData,
            // Every teardown layer keys off these labels.
            labels: {
              'kici-managed': 'hetzner-autoscale',
              'kici-agent-id': payload.agentId,
              'kici-scaler': SCALER_NAME,
            },
          }),
        });
        if (!res.ok) throw new Error(`Hetzner create failed: ${res.status}`);
        ctx.log.info(`Provisioned instance for agent ${payload.agentId}`);
      },
    }),
  ],
});
```

Read the [event contract reference](../../operator/orchestrator/event-scaler-events.md) for every payload field. The `agentId` correlates the spawn, so the instance must register with exactly that id.

### The bound context gates the scale-up

A provisioning workflow is an [event-triggered run](../events.md#what-an-event-triggered-run-resolves), so it obeys every protection rule on the [context](../contexts.md#protection-rules) it binds. That is what makes the cloud credential resolve, and it also means an approval hold stops the scale-up.

Read the chain, because the symptom sits far from the cause:

1. The scaler emits `kici.scaler.scale-up` and reserves a claim for the new agent.
2. The provisioning workflow matches, and its context holds the run for approval.
3. No instance boots, so no agent registers against the claim.
4. The event-provision reaper reaps the stranded claim once it expires.
5. The queued jobs wait, and you see agents that never appear.

Nothing in that chain reports "waiting for an approval" at the fleet level. Check the [approval queue](../dashboard/contexts-and-secrets.md#approval-queue): it lists the held run, names the context that holds it, and gives the reason. The run-detail page shows the same hold under its approval block, and `kici runs show <run-id>` prints it from the terminal.

A provisioning workflow also needs an agent labelled `kici:role:builder` to pack its source before its own job runs. Keep at least one builder-role agent outside the pool the scaler provisions, so a scale-up never waits on the fleet it is scaling.

A [branch restriction](../contexts.md#branch-restrictions) rejects the run outright. The orchestrator mints a scaler event itself, with no run behind it, so a scale-up carries no branch for a pattern to match.

Bind provisioning and teardown workflows to a context that carries the cloud credential and **no** approval hold, no wait timer, no branch restriction, and no `minimumTrust` gate. Gate a human-triggered deploy workflow instead. Keep the credential in that ungated context narrow: the scaler's own token, scoped to create and delete instances, and nothing else.

## The cloud-init that starts the agent

`buildAgentCloudInit(creds, options)` renders the `#cloud-config` that boots the KiCI agent. In the claim-code form it writes the single-use claim code — never a token — into a root-only env file (`0600`, owned by root). The agent exchanges that code for its own token inside the instance, so the token never transits cloud-init, the instance metadata, or any other provisioning channel. The env file holds:

- `KICI_ORCHESTRATOR_URL` — from `creds.orchestratorUrl`.
- `KICI_SCALER_CLAIM_CODE` — from `creds.claimCode`. The agent exchanges it for its own token in-instance.
- `KICI_AGENT_ID` — from `creds.agentId`.
- `KICI_LABELS` — from `creds.labels`, comma-joined.
- `KICI_SCALER_MANAGED=1` — marks the agent as scaler-managed, so it self-drains on idle and shutdown.

The `0600` env file still protects the non-secret env from other users on the instance. The claim code it carries is single-use and short-lived, so even that value is spent the moment the agent claims its token.

`maxLifetimeMinutes` is the one required option. It adds a max-lifetime self-poweroff (teardown layer L2): an instance that never receives a scale-down still removes itself after a hard cap. `deliveryMode` selects how the agent binary arrives — `'container'` runs the published agent image, `'payload'` fetches it from the orchestrator.

### Customization axes

Pass any of these options to shape the boot:

- `packages` — extra apt/yum packages, merged into the cloud-init `packages:` list.
- `writeFiles` — extra `write_files` entries (path, content, permissions, owner). The reserved env-file path is rejected, so a custom file cannot overwrite the credentials.
- `runcmdBefore` / `runcmdAfter` — shell lines that run before or after the agent starts.
- `agentEnv` — extra variables appended to the agent env file. Keys must be valid env names, and a value with a newline is rejected.
- `baseCloudConfig` — a raw cloud-config document to merge everything into (users, ssh keys, apt mirrors, mounts, bootcmd). The builder unions its `packages`, `runcmd`, and `write_files` with yours.

## The teardown workflow

The teardown workflow subscribes to `kici.scaler.scale-down` and deletes the instance registered under the scaled-down `agentId`. It finds the instance by the `kici-agent-id` label that the provisioning workflow set.

```ts
import {
  workflow,
  job,
  kiciEvent,
  SCALER_EVENT_NAMES,
  ScalerScaleDownPayload,
} from '@kici-dev/sdk';

const SCALER_NAME = 'hetzner';

export default workflow('hetzner-autoscale-teardown', {
  on: [kiciEvent({ name: SCALER_EVENT_NAMES.scaleDown, match: { '$.scalerName': SCALER_NAME } })],
  jobs: [
    job('teardown', {
      runsOn: ['default'],
      context: 'hetzner-autoscale',
      run: async (ctx) => {
        const payload = ScalerScaleDownPayload.parse(ctx.rawPayload);
        const token = await ctx.secrets.get('HETZNER_API_TOKEN');

        const list = await fetch(
          `https://api.hetzner.cloud/v1/servers?label_selector=kici-agent-id==${payload.agentId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const { servers } = (await list.json()) as { servers: Array<{ id: number }> };
        if (servers.length === 0) {
          ctx.log.info(`No instance found for agent ${payload.agentId}; nothing to tear down`);
          return;
        }
        for (const server of servers) {
          await fetch(`https://api.hetzner.cloud/v1/servers/${server.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          ctx.log.info(`Deleted instance ${server.id} for agent ${payload.agentId}`);
        }
      },
    }),
  ],
});
```

Keep the teardown idempotent. "None found" logs and succeeds, and a delete that returns "already gone" is not an error. A scale-down can arrive after the instance already removed itself through the self-poweroff backstop.

## Guaranteed teardown

The scale-down workflow is the primary teardown path, but it is not the only one. The reference Hetzner implementation guarantees teardown with five independent layers, keyed off the resource labels every instance carries. The host-side reaper is the backstop that survives a crash or reboot. See the [teardown reaper runbook](../../operator/orchestrator/hetzner-autoscale-reaper.md) for the full model and the recommended alert.

## Running on other clouds (AWS / GCP / Azure)

The architecture is cloud-agnostic. Nothing inside KiCI is provider-specific. Only two things change per cloud: the API calls in your provision and teardown workflows, and the host-side reaper (teardown layer L4). You still subscribe to the same `kici.scaler.scale-up` / `kici.scaler.scale-down` events, and the agent still self-claims from the forwarded claim code the same way on every cloud, through the same `buildAgentCloudInit` call.

The five teardown layers map to each cloud's own idiom:

| Layer                              | Hetzner                    | AWS                         | Azure                               | GCP                      |
| ---------------------------------- | -------------------------- | --------------------------- | ----------------------------------- | ------------------------ |
| **L1 — Scale-down workflow**       | same event-driven workflow | same                        | same                                | same                     |
| **L2 — In-instance self-poweroff** | same cloud-init            | same cloud-init             | same cloud-init                     | same cloud-init          |
| **L3 — Harness finalizer**         | same                       | same                        | same                                | same                     |
| **L4 — Out-of-band reaper**        | host systemd timer         | tag-scoped scheduled Lambda | auto-shutdown or scheduled Function | scheduled Cloud Function |
| **L5 — Pre-suite sweep**           | same                       | same                        | same                                | same                     |

Only L4 has a real per-cloud shape, because it runs outside your instances and outside KiCI. Everything else is identical across providers.

### AWS provision workflow shape

The provision workflow keeps the same structure. It swaps the cloud call for the AWS EC2 SDK, and encodes the cloud-init as base64 because AWS `UserData` expects base64 (Azure `customData` wants base64 too). Read the AWS credentials from `ctx.secrets` and tag every instance so each teardown layer can find it.

```ts
import {
  workflow,
  job,
  kiciEvent,
  buildAgentCloudInit,
  SCALER_EVENT_NAMES,
  ScalerScaleUpPayload,
} from '@kici-dev/sdk';
import { EC2Client, RunInstancesCommand, ResourceType } from '@aws-sdk/client-ec2';

const SCALER_NAME = 'aws';

export default workflow('aws-autoscale-provision', {
  on: [kiciEvent({ name: SCALER_EVENT_NAMES.scaleUp, match: { '$.scalerName': SCALER_NAME } })],
  jobs: [
    job('provision', {
      runsOn: ['default'],
      context: 'aws-autoscale',
      run: async (ctx) => {
        const payload = ScalerScaleUpPayload.parse(ctx.rawPayload);

        // Forward the claim code; the agent self-claims its token in-instance.
        // AWS UserData expects base64. Azure customData does too.
        const userData = buildAgentCloudInit(
          {
            claimCode: payload.claimCode,
            agentId: payload.agentId,
            orchestratorUrl: payload.orchestratorUrl,
            labels: payload.labels,
          },
          {
            maxLifetimeMinutes: 30,
            deliveryMode: 'container',
            userDataEncoding: 'base64',
          },
        );

        const client = new EC2Client({
          region: 'us-east-1',
          credentials: {
            accessKeyId: await ctx.secrets.get('AWS_ACCESS_KEY_ID'),
            secretAccessKey: await ctx.secrets.get('AWS_SECRET_ACCESS_KEY'),
          },
        });

        await client.send(
          new RunInstancesCommand({
            ImageId: 'ami-00000000000000000', // customer-supplied AMI with docker
            InstanceType: 't3.micro',
            MinCount: 1,
            MaxCount: 1,
            UserData: userData,
            // Every teardown layer keys off these tags.
            TagSpecifications: [
              {
                ResourceType: ResourceType.instance,
                Tags: [
                  { Key: 'kici-managed', Value: 'aws-autoscale' },
                  { Key: 'kici-agent-id', Value: payload.agentId },
                  { Key: 'kici-scaler', Value: SCALER_NAME },
                ],
              },
            ],
          }),
        );
        ctx.log.info(`Provisioned EC2 instance for agent ${payload.agentId}`);
      },
    }),
  ],
});
```

The teardown workflow mirrors this: it runs `DescribeInstances` filtered by the `kici-agent-id` tag, then `TerminateInstances` on the matches. "None found" logs and succeeds.

The AWS reference lives at `e2e/fixtures/aws-autoscale/`. It is compiled and typechecked against the AWS EC2 SDK, but it is not run against real AWS — unlike the Hetzner reference, which has a real-cloud E2E. Adapt the AMI, instance type, subnet, and IAM instance profile for your account.

## GitHub Actions runners

A provisioning workflow does not have to boot a cloud VM. Instead of a create/delete API, it can dispatch a GitHub Actions run that boots a one-shot agent. The agent self-claims from the forwarded claim code, registers with the orchestrator, runs exactly one job, and exits.

The scaler entry names the repo that holds the provisioning and teardown workflows, exactly as any other event backend does:

```yaml
scalers:
  - name: github-actions
    type: event
    maxAgents: 20
    provisioningTargets:
      - myorg/infra
    labelSets:
      - labels: [github-actions]
```

On `kici.scaler.scale-up`, the provisioning workflow dispatches a `kici-agent.yml` workflow run in a GitHub repo. It passes the claim code, orchestrator URL, agent id, and labels as dispatch inputs. The token never appears in those inputs — only the single-use claim code, which the agent exchanges for its own token in-instance.

The `kici-agent.yml` run starts the agent on the runner itself with `KICI_SCALER_CLAIM_CODE` set. `KICI_SCALER_MANAGED=1` and a zero idle timeout make the agent register, run one job, and exit. The GitHub Actions run then completes on its own. By default the run installs the published agent from npm; set `agent_bundle_release` to a release tag holding a `kici-admin agent package` tarball to pin an exact build or to serve runners that cannot reach npm.

Teardown is largely automatic. A GitHub Actions run self-completes when its agent exits. So the `kici.scaler.scale-down` workflow only cancels a run GitHub has not yet marked finished, and only for reasons where the agent will never do useful work (`spawn-timeout`, `heartbeat-timeout`).

Every other reason leaves the run alone to reap itself. That includes the reason a healthy one-shot agent produces when it exits after its job — cancelling there would turn a succeeding run into a cancelled one.

Both workflows read a `GITHUB_DISPATCH_TOKEN` [scoped secret](../secrets.md) with `actions: write` permission on the target repo — provisioning to dispatch a run, teardown to cancel one. Bind the context that holds it on the job (`context: 'github-actions'`) — a job reads only the secrets of the contexts it binds. The runner workflow is at [`examples/github-actions-autoscale/`](https://github.com/kici-dev/kici-public/tree/main/examples/github-actions-autoscale), ready to copy into your runner repo’s `.github/workflows/`.

Both workflows read `GITHUB_RUNNER_REPO` as an org-level context variable on the same `github-actions` context that holds the secret — `kici-admin variable set <orgId> github-actions GITHUB_RUNNER_REPO --value myorg/ci-runners`. The provisioning workflow reads one more, the optional `GITHUB_AGENT_BUNDLE_RELEASE`. Copy [`provision.workflow.ts`](https://github.com/kici-dev/kici-public/blob/main/examples/github-actions-autoscale/provision.workflow.ts) and [`teardown.workflow.ts`](https://github.com/kici-dev/kici-public/blob/main/examples/github-actions-autoscale/teardown.workflow.ts) into your `.kici/workflows/`.
