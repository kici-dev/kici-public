---
title: 'Hetzner autoscale teardown and reaper'
description: 'The instance-side teardown-guarantee layers for the event scaler, the reference reaper CLI, and the host timer that survives a crash'
---

Every instance the [event scaler backend](./event-scaler.md) provisions must be deleted. A missed teardown leaves a paid cloud instance running forever. The reference Hetzner implementation guarantees teardown with five independent instance-side layers, so no single failure leaks an instance; the orchestrator adds a sixth of its own. This page is the operator runbook for that model, the reference reaper CLI, and the alert that tells you when the backstop had to act.

Every layer keys off the resource labels the provisioning workflow sets on each instance: `kici-managed`, `kici-agent-id`, `kici-scaler`, and (in the reference E2E suite) `kici-e2e-run`. See [Autoscaling workflows](../../user/workflows/autoscaling-workflows.md) for how the workflows set and read those labels.

## The five instance-side teardown layers

These five live with the instance and the harness around it. A sixth layer sits on the orchestrator: the leader-gated sweep that emits `kici.scaler.scale-down` for a provision no agent ever claimed, described under [orchestrator-side backstop](./event-scaler.md#orchestrator-side-backstop).

| Layer                              | What it does                                                                                                                                                                                                                         | Survives                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **L1 — Scale-down workflow**       | The `kici.scaler.scale-down` event triggers your teardown workflow, which deletes the instance labeled `kici-agent-id==<agentId>`. This is the primary path.                                                                         | Normal operation                       |
| **L2 — In-instance self-poweroff** | The cloud-init schedules a max-lifetime `systemd-run --on-active=<minutes>m /sbin/poweroff`, plus idle self-shutdown for an agent the orchestrator started for a job. An instance that never gets a scale-down still removes itself. | A missed scale-down event              |
| **L3 — Harness finalizer**         | The reference E2E suite runs an unconditional finalizer plus `SIGINT` / `SIGTERM` / uncaught-exception / unhandled-rejection handlers that delete leaked instances at the end of a run.                                              | A test-process crash                   |
| **L4 — Host reaper timer**         | A host systemd timer runs the reaper on a few-minute cadence, deleting every `kici-managed=hetzner-autoscale` instance older than a TTL. This is the real "no matter what" backstop.                                                 | `SIGKILL`, a crash, or a reboot        |
| **L5 — Pre-suite sweep**           | The reference E2E suite sweeps stragglers before a run starts, so a leak from a previous run cannot accumulate.                                                                                                                      | A leak that survived every prior layer |

L1, L2, and L4 are the operator-relevant guarantees for a production deployment. L3 and L5 are extra guards the reference E2E suite adds around its own runs.

A [warm-pool](./auto-scaler/common-config.md#warm-pool) agent has no idle self-shutdown. It waits for work until the orchestrator gives it a job or destroys it, so only the max-lifetime poweroff (L2) and the reaper TTL (L4) bound its life. Set `maxLifetimeMinutes` and `KICI_HETZNER_REAP_TTL_MIN` above the lifetime you want a ready agent to have. Below it, both layers delete healthy agents the pool still counts as ready, and the pool starts replacements.

L4 is the layer that keeps working when everything else is dead. The scale-down workflow needs the orchestrator alive, and the self-poweroff needs the instance to boot cleanly. The host reaper depends on neither — it runs on a schedule against the cloud API and deletes anything too old.

## The reaper CLI

KiCI ships the reference reaper at `hack/hetzner/reap.ts`. It lists instances by label, deletes the ones older than a TTL, and writes a Prometheus metric. It is idempotent and tolerates a "already gone" delete.

```bash
pnpm exec tsx hack/hetzner/reap.ts
```

### Environment variables

| Variable                            | Default                          | Purpose                                                                                                                                            |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_HETZNER_E2E_SCALER_API_TOKEN` | (required)                       | Hetzner Cloud API token scoped to the project the instances live in. The reaper exits with an error if it is unset.                                |
| `KICI_HETZNER_MANAGED_LABEL`        | `kici-managed=hetzner-autoscale` | The label that identifies managed instances. Only matching instances are deleted.                                                                  |
| `KICI_HETZNER_REAP_TTL_MIN`         | `30`                             | Delete managed instances older than this many minutes.                                                                                             |
| `KICI_HETZNER_SWEEP_WHOLE_PROJECT`  | (unset)                          | Set to `1` to delete every instance older than the TTL, not only labeled ones. Safe only in a dedicated throwaway project where nothing else runs. |
| `KICI_HETZNER_REAP_METRIC_FILE`     | (unset)                          | Path to write the Prometheus textfile metric. Set it to the node-exporter textfile-collector directory.                                            |

The default is label-scoped, so the reaper is safe even when a project holds other workloads. An instance whose creation timestamp cannot be parsed is left alone — the reaper never deletes something it cannot age.

## Deploying the host timer (operator step)

The L4 reaper timer is operator setup, not part of the orchestrator. Its systemd unit lives in your own infrastructure repository. For KiCI's own deployment, that repository is `cmaster11-devops`, and the timer is named `kici-hetzner-leak-sweep`.

Run the reaper on a **few-minute cadence** — a short interval bounds how long a leaked instance can survive after L1 through L3 all miss. Set `KICI_HETZNER_REAP_TTL_MIN` above the longest expected instance lifetime, so the reaper never deletes a healthy in-use agent. A **TTL of about 30 minutes** suits a suite whose jobs finish well inside that window; raise it if your agents run longer.

The command the timer should run:

```bash
KICI_HETZNER_E2E_SCALER_API_TOKEN=<project-token> \
KICI_HETZNER_MANAGED_LABEL=kici-managed=hetzner-autoscale \
KICI_HETZNER_REAP_TTL_MIN=30 \
KICI_HETZNER_REAP_METRIC_FILE=/var/lib/node-exporter/textfile/kici-hetzner-reaper.prom \
pnpm exec tsx hack/hetzner/reap.ts
```

## The reaper metric and the alert

When `KICI_HETZNER_REAP_METRIC_FILE` is set, the reaper writes a counter for node-exporter's textfile collector:

```
kici_hetzner_reaper_deleted_total <count>
```

A non-zero deletion count is the signal that **layers L1 through L3 leaked** and the L4 backstop had to clean up. In steady state the reaper deletes nothing, because the scale-down workflow already tore every instance down. So a non-zero rate is the exact condition to alert on.

Alert on a non-zero reaper-deletion rate — for example, `rate(kici_hetzner_reaper_deleted_total[1h]) > 0`. It fires only when the primary teardown paths failed, which is precisely when an operator needs to look. Pair it with the orchestrator's own [event-scaler metrics](./event-scaler.md#metrics): a rising `kici_orch_scaler_external_provision_timeout_total` alongside reaper deletions points at instances that never registered before the reaper collected them.
