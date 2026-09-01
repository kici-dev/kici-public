---
title: 'Event scaler backend'
description: 'Configure a type: event scaler that drives cloud autoscaling through a customer-authored provisioning workflow instead of a built-in cloud SDK'
---

The event scaler backend turns "cloud autoscaling" into "write a provisioning workflow in TypeScript". It does no local compute of its own. Instead, each scale-up emits a reserved `kici.scaler.scale-up` custom event, and each teardown emits a `kici.scaler.scale-down` event. Your own provisioning and teardown workflows consume those events through the [`kiciEvent()`](../../user/sdk/triggers.md) trigger and boot or delete an ephemeral cloud instance.

This keeps every cloud-specific API call in your workflow code. The orchestrator ships no cloud SDK, no provider credentials, and no per-cloud logic. The reference implementation targets Hetzner Cloud, but the same pattern fits any provider with a create/delete API.

For the workflow-authoring side, see [Autoscaling workflows](../../user/workflows/autoscaling-workflows.md). For the full event payloads, see the [event contract reference](./event-scaler-events.md). For the teardown-guarantee model, see the [teardown reaper runbook](./hetzner-autoscale-reaper.md).

## How it works

1. A job needs an agent that no live agent satisfies, so the scaler decides to scale up.
2. The scaler emits a `kici.scaler.scale-up` event to every workflow ref in `provisioningTargets`. The event carries a single-use `claimCode` and the `agentId` the new instance must register with.
3. Your provisioning workflow receives the event and boots a cloud instance. It passes the claim code to the agent in `KICI_SCALER_CLAIM_CODE`, together with the given `agentId`.
4. The agent exchanges the claim code for its own short-lived token over the connection it opens to the orchestrator. It then registers under that `agentId`.
5. The pending job runs on the new agent.
6. When the agent is idle, its job completes, or the orchestrator drains, the scaler emits a `kici.scaler.scale-down` event.
7. Your teardown workflow receives the event and deletes the instance registered under that `agentId`.

A workflow that must hold the token itself calls [`ctx.kici.scaler.claimAgentCredentials(claimCode)`](./event-scaler-events.md#claiming-agent-credentials) and delivers the token to the instance. Forwarding the claim code is the default, because the token then never transits the provisioning channel.

The ephemeral agent token is minted only when the claim code is redeemed. It never enters the persisted event log — only the `claimCode` does.

## Configuration

An event scaler entry sets `type: event` and lists the workflow refs the reserved events are delivered to. A minimal Hetzner entry:

```yaml
version: 1
scalers:
  - name: hetzner
    type: event
    maxAgents: 10
    # Workflow refs the scale-up / scale-down events are delivered to.
    # Your provisioning + teardown workflows live in these repos.
    provisioningTargets:
      - myorg/infra
    # Seconds a pending claim code stays valid (default 300).
    claimTtlSeconds: 300
    # Seconds the minted ephemeral agent token stays valid (default 600).
    agentTokenTtlSeconds: 600
    labelSets:
      - labels: [default]
```

### Event-scaler fields

- `provisioningTargets` — Workflow refs (e.g. `myorg/infra`) the scale-up and scale-down events are delivered to. **Required** and non-empty for a `type: event` scaler. The orchestrator rejects the config if it is missing or empty.
- `claimTtlSeconds` — Seconds a pending provisioning claim code stays valid before it expires. Default `300`.
- `agentTokenTtlSeconds` — Seconds the ephemeral agent token minted for a claimed provision stays valid. Default `600`.

### Shared fields

An event scaler also uses the fields shared by every backend — see [Common configuration](./auto-scaler/common-config.md):

- `name` — The scaler entry name. It appears as `scalerName` on every emitted event, so your workflow can match on it.
- `type` — Set to `event`.
- `maxAgents` — The population cap for this scaler.
- `labelSets` — The label sets this scaler provisions. Each set lists the exact `labels` a matching job needs. An event label set needs no `image` or `binaryPath` — the workflow chooses how to boot the instance.
- `mandatoryLabels` — Labels a job must declare in `runsOn` to allocate on this scaler, if any.

## High availability

An event scaler works across a [cluster of coordinators](./clustering.md) behind one shared endpoint. No second endpoint and no sticky routing are needed.

The reason is that every piece of scaler state the flow depends on lives in the shared orchestrator database: the pending claim code, the spawn record, the resource reservation, and the ephemeral agent token. A coordinator that did not emit the scale-up redeems the claim from the shared database, adopts the spawn record, and runs the job.

Point the scale-up at the shared endpoint. The instance dials the `orchestratorUrl` the scale-up carries, which is the scaler entry's own `orchestratorUrl` when it sets one, and `KICI_ORCHESTRATOR_URL` otherwise. It then reaches whichever coordinator the load balancer picks, and that coordinator can serve it.

### Every coordinator needs a scaler config file

A coordinator started with no `KICI_SCALER_CONFIG_PATH` builds no scaler manager. It cannot answer a credential claim at all, so an agent that lands on it fails to register and the instance you paid for never joins the cluster.

Give every coordinator behind the shared endpoint a scaler config file. The same file on all of them is the simplest choice. An empty one is enough for a coordinator you do not want to scale from:

```yaml
version: 1
scalers: []
```

### What differs from a single coordinator

- **`maxAgents` is counted across the whole cluster.** Two coordinators scaling the same event scaler share one population, so the cap is the number of cloud instances, not the number per coordinator. See [Auto-scaler](./auto-scaler.md#caps-in-a-cluster) for how this compares to the local backends.
- **Teardown may be emitted by a different coordinator than the scale-up.** Whichever coordinator holds the agent emits its `kici.scaler.scale-down`, and the [orchestrator-side backstop](#orchestrator-side-backstop) emits from the leader. Your teardown workflow must not assume one coordinator owns an instance for its whole life.
- **A teardown addresses the targets recorded at spawn time.** The scale-up writes the scaler's `provisioningTargets` into the spawn record, and whichever coordinator holds the agent delivers the teardown to those recorded targets — the one that spawned it as much as one that adopted it, which may not configure that scaler at all. Live config is the fallback for a record that named none. So editing `provisioningTargets` retargets new spawns, and provisions already running are torn down through the workflow refs they were spawned with.

## Metrics

The orchestrator exposes four counters and gauges for an event scaler, labeled by `scaler`:

- `kici_orch_scaler_scale_up_emitted_total{scaler}` — Cumulative scale-up events emitted.
- `kici_orch_scaler_scale_down_emitted_total{scaler,reason}` — Cumulative scale-down events emitted, labeled also by teardown `reason`.
- `kici_orch_scaler_external_provisioning_active{scaler}` — Current in-flight provisions (provisioning plus active). A value that stays non-zero with no matching agent registration points at a stuck provisioning workflow.
- `kici_orch_scaler_external_provision_timeout_total{scaler}` — Cumulative provisions torn down because the agent never registered in time.

`maxAgents` is counted across the whole cluster for an event scaler, so two more series cover that check:

- `kici_orch_scaler_spawn_refusals_total` — Cumulative spawn requests refused by a cap, the cluster-wide `maxAgents` included. A rising rate means the cap is doing its job; raise it, or let jobs queue.
- `kici_orch_scaler_cap_lock_failures_total{reason}` — Cumulative cap checks that failed, so the spawn was refused without the cap being evaluated. This is never a capacity signal. `reason="unreachable"` means the orchestrator database is stalled and event autoscaling is stopped until it recovers. `reason="contended"` means the database is healthy but several coordinators are scaling this scaler at once and one gave up waiting; the job is re-offered on the next dispatch pass. The `ScalerCapCheckUnreachable` rule in the [monitoring pack](../observability/monitoring-pack.md) alerts on the `unreachable` half only, because contention resolves itself on the next dispatch pass.

The reaper described under [Teardown](#teardown) adds two unlabeled gauges:

- `kici_orch_scaler_reap_unseen_provisions` — Provisions whose agent has been registered on no coordinator for at least the flap grace, being timed before teardown. An agent that reads as absent only briefly — its own reconnect, or a peer flap that empties a coordinator's advertised agent list — never reaches this gauge.
- `kici_orch_scaler_reap_blocked` — `1` while the reaper is standing down because this coordinator is connected to none of the coordinator peers it knows.

## When external provisioning fails

An event scaler hands provisioning to your workflow, which drives your provider. The orchestrator never sees the provider's error, so the only signal it has is generic: the scale-up went out, and no agent came back. That signal is enough, and it reads the same for a provider incident, an exhausted quota, and a broken boot script.

When a provision times out without registering, the orchestrator:

- **Names the cause on the waiting job.** The job settles as timed out with the provisioning failure as its reason — not with a message about its `runsOn` labels. A backend did match the job; it could not deliver an agent, and telling you to check your labels would send you to fix something that is already correct.
- **Counts it.** `kici_orch_scaler_external_provision_timeout_total{scaler}` goes up, and the `ExternalProvisioningFailing` rule in the [monitoring pack](../observability/monitoring-pack.md) fires about 25 minutes into a sustained failure. Its window is set against the backoff below, so widen it if you raise the ceiling past ~25 minutes.
- **Shows it to the operator.** `kici-admin diagnose scaler` lists the failure under the scaler, with the most recent cause.
- **Backs off before asking again.** See below.

### Retry backoff

Without a deferral, a scaler whose provider is down is asked for a new provision every spawn timeout. That continues for as long as the outage lasts — a dispatch loop against a provider that is already refusing work.

Consecutive failures therefore arm a growing deferral. The first failure defers the next request by the base delay; each further consecutive failure doubles it, up to a ceiling. Any successful registration clears the count, including an agent another coordinator adopted — that provision worked, whichever coordinator the agent reached.

The state is per scaler **name**, so one failing scaler never defers another. Two event scalers usually drive two different providers, and an outage at one says nothing about the other.

Each coordinator reports the provisions it asked for itself, so on a cluster every coordinator backs off — and answers `kici-admin diagnose scaler` — from its own experience rather than waiting for the leader. The leader also reports the provisions its reaper condemns, whoever asked for them. A provision that another coordinator adopted is not a failure, so nobody reports it. The coordinator that asked for it is never told that the agent arrived, so it checks the durable record of what became of the provision before it reports. That record outlives the provision itself, so a provision that was adopted and has since been torn down is still recognised as one that worked. A coordinator that has not yet asked for a provision from a failing scaler has nothing to go on and makes one attempt, then defers like the rest. Inside one coordinator, a dead provision is reported once, however many of that coordinator's own observers see it. The count is per coordinator, so two coordinators that both see the same dead provision each count it once.

Three cluster settings tune it. All three are read live, so a change needs no restart. The base and the ceiling size the next deferral the orchestrator arms — a deferral already running keeps its length:

| Setting                                     | Default  | What it does                                                                                                                      |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `scaler-provision-backoff-base-ms`          | `30000`  | Deferral after the first failure. Doubles per further consecutive failure.                                                        |
| `scaler-provision-backoff-max-ms`           | `900000` | Ceiling on the doubling.                                                                                                          |
| `scaler-provision-max-consecutive-failures` | `5`      | The failure count at which a refusal names repeated failure, and the orchestrator logs that provisioning is failing consistently. |

```bash
# Show the current values (null = the orchestrator's configured default)
kici-admin cluster-settings show

# Retune a live cluster
kici-admin cluster-settings set --scaler-provision-backoff-base-ms 60000
kici-admin cluster-settings set --scaler-provision-backoff-max-ms 1800000
kici-admin cluster-settings set --scaler-provision-max-consecutive-failures 3
```

Raise the ceiling for a provider whose outages are long, so a multi-hour incident costs a handful of dispatches. A ceiling past ~25 minutes spaces the timeouts out too far for the `ExternalProvisioningFailing` window, so that rule can go quiet during the outage. Widen the rule's window with the ceiling; the 30 minutes above is already past that point. Lower the base if your provisioning is fast and you want a transient failure retried sooner.

The matching environment variables — `KICI_SCALER_PROVISION_BACKOFF_BASE_MS`, `KICI_SCALER_PROVISION_BACKOFF_MAX_MS`, and `KICI_SCALER_PROVISION_MAX_CONSECUTIVE_FAILURES` — set the cluster-wide defaults a cleared setting falls back to.

## Teardown

Every provisioned instance must be deleted. Teardown has two halves: the five instance-side layers the reference Hetzner implementation adds, and the orchestrator-side backstop below. The scale-down workflow is the primary path, and a host-side reaper is the backstop that survives a crash. See the [teardown reaper runbook](./hetzner-autoscale-reaper.md) for the instance-side layers, the reaper CLI, and the recommended alert.

### Orchestrator-side backstop

The orchestrator runs its own sweep for provisions no agent ever claimed. It is leader-gated, so on a multi-coordinator cluster exactly one coordinator sweeps and a provision is never torn down twice. Once a minute the leader looks for two shapes and emits `kici.scaler.scale-down` for each:

- A provision whose agent never registered, past `KICI_SCALER_SPAWN_TIMEOUT_MS` (5 minutes by default). The reason is `spawn-timeout`, and it also increments `kici_orch_scaler_external_provision_timeout_total`. This is what covers a provisioning workflow that failed after the scale-up event — a cloud API error, a denied quota, a cancelled run — because the scale-up event is fire-and-forget and nothing else notices that the instance never appeared.
- A provision whose agent has stayed unseen on every coordinator in the cluster, either because the coordinator that adopted it is gone or because the agent has been absent for the stranded window (30 minutes by default). The reason is `heartbeat-timeout`.

Because every teardown deletes one of your instances, the sweep is deliberately slow to act:

- **An agent registered anywhere in the cluster is never swept**, so a long-running job is safe however long it runs.
- **Nothing is torn down on a single observation.** An agent reads as unseen while it reconnects, and for a short time after any coordinator reconnects, because a freshly connected coordinator has not yet reported which agents it holds. The sweep therefore measures how long the absence has _persisted_, and requires it to outlast the flap grace (`--reroute-flap-grace-ms`, 2 minutes by default) before any teardown fires. Seeing the agent again restarts that clock.
- **A coordinator that can reach none of the coordinator peers it knows does not sweep at all.** An isolated coordinator elects itself leader, and without this it would read every other coordinator as dead and tear down the whole fleet's provisions while the rest of the cluster was still running them. A **known peer** is one named in `KICI_CLUSTER_PEERS`, or one this coordinator has completed a handshake with at least once since it started. Platform-mode clusters set no such variable and learn every peer by handshake, so the second half is what arms the guard there.

#### When the backstop turns itself off

A network partition and a genuinely dead coordinator look identical from one side, and there is no safe way to guess: acting on the wrong guess deletes instances that are still running jobs. So the rule above is unconditional, and it has a consequence worth planning for.

**On a coordinator that knows peers, losing every connected one switches the whole backstop off until a peer returns.** That includes the `spawn-timeout` arm, the primary defence against a provision no workflow ever tore down. On a [two-coordinator HA pair](./clustering.md), a permanently dead peer therefore leaves the backstop off indefinitely, not for a few minutes.

**A blocked backstop also fills the cap.** Cluster-wide `maxAgents` counts spawn records, and a provision whose agent never registered keeps its record until the backstop tears it down. So while the backstop is off, those records accumulate against the cap: spawns start to be refused, and event autoscaling degrades toward a cluster-wide halt. `kici_orch_scaler_spawn_refusals_total` is the series that rises first.

`kici_orch_scaler_reap_blocked` reads `1` for exactly as long as this lasts. The `ScalerReapBlocked` rule in the [monitoring pack](../observability/monitoring-pack.md) alerts on it. On a cluster of three or more, a minority coordinator reads `1` while the majority still sweeps, so scope the alert to the leader.

##### First, tell a partition from a dead coordinator

**The alert firing on two coordinators at once is the signature of a partition**, not of a dead node. A dead coordinator raises the alert on the survivors only; it cannot raise one itself.

That test holds only if you know both coordinators are being scraped. The same fault that splits the peer link can split the metrics path, and then only one side's alert reaches you. **So if the other coordinator is also unreachable to your monitoring, read a single alert as a suspected partition** — the ambiguous case takes the safe reading, not the convenient one.

This matters more than the remedy you pick, because two of the three remedies below are unsafe while a partition is live:

:::danger
**Do not restart a coordinator, and do not add one, in response to this alert alone.**

A coordinator learns its peers by handshake and keeps no roster across restarts. One that restarts _during a partition_ therefore boots knowing no peers. It decides it is a single-coordinator deployment and starts sweeping. Do that on both sides, and each one tears down the instances the other is still running.

Adding a coordinator does the same damage by a different route. A new node that only one side can reach gives that side a connected peer again, so its sweep resumes — against the isolated side's live agents.

Both are correct fixes for a permanently dead peer. Both are the worst possible move during a partition. The alert alone does not tell you which you have.
:::

Confirm the peer is permanently gone before acting: check that its host is down rather than merely unreachable from here, and that the alert is firing on one side only.

##### Then, the ways out

In order of preference:

1. **Bring the dead peer back.** The only remedy that is safe in both situations, and the only one that needs no diagnosis first.
2. **Run three coordinators — as a standing change, never during a live partition.** A third coordinator that only one side can reach restores that side's connected count on its own, which re-arms its sweep against the isolated side's live agents. It tears them down about two minutes later, because a coordinator it cannot reach counts as a dead adopter, and that case needs only the flap grace rather than the stranded window. Add the third node while the cluster is healthy. Losing one then still leaves a peer connected, so the backstop keeps running.
3. **Remove the peer from the survivor — once you have confirmed it is permanently gone.** How depends on the mode, and a restart alone is not enough in independent mode:
   - **Platform mode** (the HA-pair recipe, joined by token): restart the survivor. It boots knowing no peers and is a single-coordinator deployment again.
   - **Independent mode** (`KICI_CLUSTER_PEERS` set): drop the dead peer from that variable _and then_ restart. A restart on its own leaves the peer named in config, and the guard counts it, so the coordinator stays blocked.

#### Watching the absence window

`kici_orch_scaler_reap_unseen_provisions` counts the provisions the leader is currently timing — their agent has been registered on no coordinator for at least the flap grace, and the stranded window has not yet elapsed. An agent that reads as absent only briefly never reaches the gauge.

The clock behind that number lives on the leader, and it restarts whenever leadership moves. A cluster that changes leader more often than `--scaler-reap-stranded-timeout-ms`, or whose peer link flaps faster than that, therefore never finishes timing a genuinely stranded provision — and it keeps billing. The `ScalerProvisionsStuckUnseen` rule in the [monitoring pack](../observability/monitoring-pack.md) alerts on the gauge staying non-zero for longer than the stranded window. Nothing else reports that state.

The orchestrator logs `starting absence clock` when it first sees a provision unregistered, and `absence clock cleared` when the agent comes back. Both carry the `agentId` and `scalerName`, so a firing alert resolves to specific provisions.

A teardown the sweep cannot deliver — a provision whose scaler names no `provisioningTargets` on any coordinator that holds it — leaves its record in place and is retried, rather than being dropped silently.

The same sweep deletes pending provisioning claim codes an hour after they expire. An expired code cannot be redeemed, so this is bookkeeping only.

It also deletes the durable record of what became of a provision. A record goes only after the provision's spawn record is gone and nothing can still ask about it — a day at least, and longer on a cluster that raises `KICI_SCALER_SPAWN_TIMEOUT_MS`.

The windows below are [cluster settings](./cluster-settings.md), read fresh on each pass, so `kici-admin cluster-settings set` retunes a running cluster with no restart:

```bash
kici-admin cluster-settings set --scaler-reap-interval-ms 30000
kici-admin cluster-settings set --scaler-reap-stranded-timeout-ms 3600000
kici-admin cluster-settings set --scaler-reap-reattempt-interval-ms 900000
kici-admin cluster-settings set --scaler-claim-retention-ms 600000
```

The flap grace the sweep waits out is not its own knob: it reads `--reroute-flap-grace-ms`, floored at twice the peer stale timeout (2 minutes at the defaults). Lowering that knob below the floor has no effect on the sweep, and `--scaler-reap-stranded-timeout-ms` is inert below the same floor, because no teardown fires until the flap grace has passed.

## GitHub Actions runners

An event scaler is not limited to a cloud VM. A provisioning workflow can dispatch a GitHub Actions run whose one-shot agent boots inside the runner. The agent self-claims its credentials from the `claimCode`, so the ephemeral agent token never transits the dispatch inputs. Teardown is largely automatic: a GitHub Actions run self-completes when its agent exits, so the run tears itself down. The scale-down workflow still fires for accounting, but no separate delete call is needed.

## Reference implementation and operator setup

KiCI ships a reference reaper CLI at `hack/hetzner/reap.ts`. It deletes managed instances older than a TTL and writes a Prometheus metric. It is documented in the [teardown reaper runbook](./hetzner-autoscale-reaper.md).

Two pieces are operator setup, not part of the orchestrator itself:

- **The host reaper timer.** A systemd timer that runs the reaper on a few-minute cadence is the crash-proof teardown backstop. Its unit lives in your own infrastructure repository, and deploying it is an operator step. See the runbook for the exact command the timer should run.
- **Cloud credentials.** Your provisioning and teardown workflows read a cloud API token from a scoped secret you configure. The orchestrator never holds it.
