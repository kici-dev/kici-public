---
title: 'Event scaler event contract'
description: 'Reference for the reserved kici.scaler.scale-up and kici.scaler.scale-down events, their payload fields, and the claim-credentials flow'
---

The [event scaler backend](./event-scaler.md) drives cloud autoscaling through two reserved custom events. This page is the wire contract for those events: their names, their payload fields, the teardown reasons, and how an agent claims its credentials. For the workflow-authoring side, see [Autoscaling workflows](../../user/workflows/autoscaling-workflows.md).

## Reserved event names

The event scaler emits exactly two events:

- `kici.scaler.scale-up` — Emitted when the scaler decides to provision an agent.
- `kici.scaler.scale-down` — Emitted when the scaler decides to tear an agent down.

Your workflows subscribe to these literal names through the [`kiciEvent()`](../../user/sdk/triggers.md) trigger.

## The `kici.` prefix is reserved

Both event names start with the reserved prefix `kici.`. This prefix is for KiCI system events only. A workflow step cannot emit an event whose name starts with `kici.` — the SDK rejects it client-side, and the orchestrator rejects it server-side. So a user step cannot forge a scale-up or scale-down event. The orchestrator's rate limiter also exempts these system events.

The prefix `__` is reserved on the same terms. It names the events the orchestrator mints for itself: `__schedule_fire`, `__workflow_complete`, `__job_complete` and `__workflows_failed_batch`. A run triggered by `__schedule_fire` is dispatched as a trusted ref. The other three are caused by runs, so each inherits the tier of the run (or runs) behind it. A step that could emit any of these names would grant itself the rate-limiter exemption, and with `__schedule_fire` the trusted ref on top of it.

## Scale-up payload

A `kici.scaler.scale-up` event carries everything a provisioning workflow needs to boot an instance and claim its credentials.

| Field             | Type              | Description                                                                                                                                                                                                                                                     |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scalerName`      | string            | Name of the scaler entry that emitted the event. Match on this to route the event to the right workflow.                                                                                                                                                        |
| `agentId`         | string            | The agent id the provisioned instance must register with. It correlates the spawn.                                                                                                                                                                              |
| `labels`          | string[]          | The full label set the provisioned agent registers with. It is the pending job's labels plus the scaler-assigned `kici:agent:`, `kici:scaler:`, and `kici:role:` labels. Write it into the agent's `KICI_LABELS`. The minted token authorizes exactly this set. |
| `mandatoryLabels` | string[]          | The mandatory (taint) labels the pool gates on, if any. Defaults to an empty array.                                                                                                                                                                             |
| `resources`       | object            | Resolved resource hints for the provision, such as `cpus` and `memBytes`. Defaults to an empty object.                                                                                                                                                          |
| `orchestratorUrl` | string            | The orchestrator WebSocket URL the provisioned agent connects back to.                                                                                                                                                                                          |
| `claimCode`       | string            | A single-use code the provisioned agent redeems for ephemeral agent credentials. A workflow can also redeem it directly.                                                                                                                                        |
| `jobId`           | string (optional) | The execution job the spawn is bound to. Absent for unbound or warm spawns.                                                                                                                                                                                     |
| `requestId`       | string            | Correlation id for this scale-up request.                                                                                                                                                                                                                       |

## Scale-down payload

A `kici.scaler.scale-down` event tells a teardown workflow which instance to delete.

| Field        | Type          | Description                                           |
| ------------ | ------------- | ----------------------------------------------------- |
| `scalerName` | string        | Name of the scaler entry that emitted the event.      |
| `agentId`    | string        | The agent id whose instance should be torn down.      |
| `reason`     | string (enum) | Why the teardown was requested. See the values below. |
| `requestId`  | string        | Correlation id for this scale-down request.           |

### Teardown reasons

The `reason` field is one of:

- `idle` — The agent sat idle past its timeout.
- `job-complete` — The bound job finished, so the agent is no longer needed.
- `heartbeat-timeout` — The agent stopped sending heartbeats.
- `spawn-timeout` — The agent never registered in time after the scale-up.
- `drain` — The orchestrator is draining this scaler.
- `shutdown` — The orchestrator is shutting down.

A teardown workflow can log or branch on the reason. The teardown action itself is the same for every reason: delete the instance registered under `agentId`.

`spawn-timeout` and `heartbeat-timeout` come from the orchestrator's own sweep for provisions no agent ever claimed. A `spawn-timeout` covers a provisioning workflow that failed after the scale-up — a cloud API error, a denied quota, a cancelled run — so the workflow should treat it as "delete whatever this scale-up created, if anything". See [orchestrator-side backstop](./event-scaler.md#orchestrator-side-backstop).

### Which coordinator emits a scale-down

On a [cluster of coordinators](./clustering.md), the coordinator that emits the `scale-down` is not always the one that emitted the matching `scale-up`. A provisioned agent reaches whichever coordinator the shared endpoint picks, and that coordinator then owns its teardown. The sweep for stranded provisions runs on the cluster leader, which is a third possibility.

Two consequences for a teardown workflow:

- **Route on `scalerName` and `agentId`, never on which orchestrator delivered the event.** The pair identifies the instance; the emitter does not.
- **Keep the workflow deletion idempotent.** Deleting an instance that is already gone must succeed, because a teardown the orchestrator could not deliver is retried.

The workflow refs a teardown is delivered to are the `provisioningTargets` recorded when the instance was spawned. Editing that list retargets new spawns and leaves running provisions addressed as they were spawned.

## Claiming agent credentials

The scale-up payload carries a `claimCode`, not a token. The recommended flow forwards that code to the instance and lets the **agent** claim its own token there.

The provisioning workflow writes the claim code into the agent's `KICI_SCALER_CLAIM_CODE` environment variable and boots the instance. The agent exchanges the code for a freshly minted ephemeral token over the orchestrator's `scaler.claim-credentials` RPC, then registers. The token is minted lazily — the orchestrator creates it only when the agent claims — and it never transits the provisioning channel. Its lifetime is bounded by the scaler's `agentTokenTtlSeconds`. See [Autoscaling workflows](../../user/workflows/autoscaling-workflows.md) for the reference cloud-init.

A workflow that must obtain the token directly can still call `claimAgentCredentials`:

```ts
const creds = await ctx.kici.scaler.claimAgentCredentials(payload.claimCode);
// creds = { agentToken, agentId, orchestratorUrl, labels }
```

The returned object holds:

- `agentToken` — The single-use ephemeral agent token the new instance registers with.
- `agentId` — The agent id the instance must register with.
- `orchestratorUrl` — The orchestrator WebSocket URL the instance connects back to.
- `labels` — The labels the token authorizes.

With this direct call the token becomes the workflow's responsibility to deliver to the instance secretly — write it into a root-only file, never a command line. Prefer forwarding the claim code so the token never leaves the orchestrator until the agent claims it.

Either way, **the token never enters the event log.** It is delivered only over the authenticated claim RPC. The persisted event log holds the `claimCode`, never the token, so the token stays out of any record a later reader could inspect.
