---
title: 'Hetzner autoscale teardown and reaper'
description: 'The instance-side teardown-guarantee layers for the event scaler, the reference reaper, and the host timer that survives a crash'
---

Every instance the [event scaler backend](./event-scaler.md) provisions must be deleted. A missed teardown leaves a paid cloud instance running forever. The reference Hetzner implementation guarantees teardown with five independent instance-side layers, so no single failure leaks an instance; the orchestrator adds a sixth of its own. This page is the operator runbook for that model, the reference reaper, and the alerts that tell you when the backstop acted, failed, or stopped running.

Every layer keys off the resource labels the provisioning workflow sets on each instance: `kici-managed`, `kici-agent-id`, `kici-scaler`, and (in the reference E2E suite) `kici-e2e-run`. See [Autoscaling workflows](../../user/workflows/autoscaling-workflows.md) for how the workflows set and read those labels.

## The five instance-side teardown layers

These five live with the instance and the harness around it. A sixth layer sits on the orchestrator: the leader-gated sweep that emits `kici.scaler.scale-down` for a provision no agent ever claimed, described under [orchestrator-side backstop](./event-scaler.md#orchestrator-side-backstop).

| Layer                              | What it does                                                                                                                                                                                                                                                                                        | Survives                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **L1 — Scale-down workflow**       | The `kici.scaler.scale-down` event triggers your teardown workflow, which deletes the instance labeled `kici-agent-id==<agentId>`. This is the primary path.                                                                                                                                        | Normal operation                       |
| **L2 — In-instance self-poweroff** | The cloud-init schedules a max-lifetime `systemd-run --on-active=<minutes>m /sbin/poweroff`, plus idle self-shutdown for an agent the orchestrator started for a job. An instance that never gets a scale-down still powers itself off. Hetzner still bills a powered-off server, so L4 deletes it. | A missed scale-down event              |
| **L3 — Harness finalizer**         | The reference E2E suite runs an unconditional finalizer plus `SIGINT` / `SIGTERM` / uncaught-exception / unhandled-rejection handlers that delete leaked instances at the end of a run.                                                                                                             | A test-process crash                   |
| **L4 — Host reaper timer**         | A host systemd timer runs the reaper on a few-minute cadence, deleting every `kici-managed=hetzner-autoscale` instance older than a TTL. This is the real "no matter what" backstop.                                                                                                                | `SIGKILL`, a crash, or a reboot        |
| **L5 — Pre-suite sweep**           | The reference E2E suite sweeps stragglers before a run starts, so a leak from a previous run cannot accumulate.                                                                                                                                                                                     | A leak that survived every prior layer |

L1, L2, and L4 are the operator-relevant guarantees for a production deployment. L3 and L5 are extra guards the reference E2E suite adds around its own runs.

A [warm-pool](./auto-scaler/common-config.md#warm-pool) agent has no idle self-shutdown. It waits for work until the orchestrator gives it a job or destroys it, so only the max-lifetime poweroff (L2) and the reaper TTL (L4) bound its life. Set `maxLifetimeMinutes` and `KICI_HETZNER_REAP_TTL_MIN` above the lifetime you want a ready agent to have. Below it, L2 powers off and L4 deletes healthy agents the pool still counts as ready, and the pool starts replacements.

L4 is the layer that keeps working when everything else is dead. The scale-down workflow needs the orchestrator alive, and the self-poweroff needs the instance to boot cleanly. The host reaper depends on neither — it runs on a schedule against the cloud API and deletes anything too old.

## The reference reaper

The reference reaper is a public example: [`examples/hetzner-autoscale/`](https://github.com/kici-dev/kici-public/tree/main/examples/hetzner-autoscale). `reap.ts` lists instances by label, deletes the ones older than a TTL, and writes Prometheus metrics. `hetzner-client.ts` is the `fetch` wrapper it calls. It is idempotent: an instance that is already gone counts as deleted. A delete that fails does not stop the run: the reaper tries every expired instance, logs each failure, and exits with status 1 when any delete failed.

Copy both files into one directory on the host that runs the timer. Node.js 22.18 or later runs the TypeScript directly, so nothing needs installing:

```bash
HCLOUD_TOKEN=<project-token> node reap.ts
```

### Environment variables

| Variable                           | Default                          | Purpose                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HCLOUD_TOKEN`                     | (required)                       | Hetzner Cloud API token for the project the instances live in — the same variable the `hcloud` CLI reads. The reaper exits with an error if it is unset.                                |
| `HCLOUD_ENDPOINT`                  | `https://api.hetzner.cloud/v1`   | The Hetzner Cloud API base URL.                                                                                                                                                         |
| `KICI_HETZNER_MANAGED_LABEL`       | `kici-managed=hetzner-autoscale` | The label that identifies managed instances. Only matching instances are deleted.                                                                                                       |
| `KICI_HETZNER_REAP_TTL_MIN`        | `30`                             | Delete managed instances older than this many minutes.                                                                                                                                  |
| `KICI_HETZNER_SWEEP_WHOLE_PROJECT` | (unset)                          | Set to `1` to delete every instance older than the TTL, not only labeled ones. Safe only in a dedicated throwaway project where nothing else runs.                                      |
| `KICI_HETZNER_REAP_METRIC_FILE`    | (unset)                          | Path of the file the reaper writes its Prometheus gauges to. Put it in the node-exporter textfile-collector directory, and end its name in `.prom`: the collector reads no other files. |

The default is label-scoped, so the reaper is safe even when a project holds other workloads. An instance whose creation timestamp cannot be parsed is left alone — the reaper never deletes something it cannot age.

## Deploying the host timer (operator step)

The L4 reaper timer is operator setup, not part of the orchestrator. Its systemd unit lives in your own infrastructure repository; name the timer after the scaler it sweeps (for example `kici-hetzner-leak-sweep`).

Run the reaper on a **few-minute cadence** — a short interval bounds how long a leaked instance can survive after L1 through L3 all miss. Set `KICI_HETZNER_REAP_TTL_MIN` above the longest expected instance lifetime, so the reaper never deletes a healthy in-use agent. A **TTL of about 30 minutes** suits a suite whose jobs finish well inside that window; raise it if your agents run longer.

The command the timer should run, with the two files in `/opt/kici-hetzner-reaper/`:

```bash
HCLOUD_TOKEN=<project-token> \
KICI_HETZNER_MANAGED_LABEL=kici-managed=hetzner-autoscale \
KICI_HETZNER_REAP_TTL_MIN=30 \
KICI_HETZNER_REAP_METRIC_FILE=/var/lib/node-exporter/textfile/kici-hetzner-reaper.prom \
node /opt/kici-hetzner-reaper/reap.ts
```

The example's [README](https://github.com/kici-dev/kici-public/tree/main/examples/hetzner-autoscale) carries a systemd service and timer pair that runs this command every five minutes.

## The reaper metric and the alerts

When `KICI_HETZNER_REAP_METRIC_FILE` is set, the reaper writes two gauges for node-exporter's textfile collector, both about its most recent run:

```
kici_hetzner_reaper_last_run_deleted <count>
kici_hetzner_reaper_last_run_failed <count>
```

A non-zero deletion count is the signal that **layers L1 through L3 leaked** and the L4 backstop had to clean up. In steady state the reaper deletes nothing, because the scale-down workflow already tore every instance down. A non-zero failure count is worse: a leaked instance is still running, because the delete was refused (delete protection, for example) or errored.

Set these alerts:

| Alert                | Expression                                                                          | What it catches                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Leak cleaned up      | `max_over_time(kici_hetzner_reaper_last_run_deleted[1h]) > 0`                       | Layers L1 through L3 missed an instance and the reaper deleted it                                                                                |
| Leak not cleaned up  | `max_over_time(kici_hetzner_reaper_last_run_failed[1h]) > 0`                        | The reaper found an expired instance and could not delete it                                                                                     |
| Reaper not reporting | `time() - node_textfile_mtime_seconds{file=~".*/kici-hetzner-reaper\\.prom"} > 900` | No run has written the file in 15 minutes: the timer stopped, or every run fails before it lists anything (an invalid token, an unreachable API) |

The deletion and failure alerts use `max_over_time`, so they stay firing while the leaks continue. Each run overwrites both values, so do not alert on `rate()` of them: a steady leak writes the same count every run, and a rate over identical values is zero. The staleness alert needs its own expression, because a run that fails before it lists anything writes no file at all, and the last values stay in place. node-exporter labels `node_textfile_mtime_seconds` with the file's full path. Match the name you set in `KICI_HETZNER_REAP_METRIC_FILE`, and keep the 15 minutes above your timer interval.

Pair them with the orchestrator's own [event-scaler metrics](./event-scaler.md#metrics): a rising `kici_orch_scaler_external_provision_timeout_total` alongside reaper deletions points at instances that never registered before the reaper collected them.
