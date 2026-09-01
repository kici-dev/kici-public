---
title: Auto-scaler
description: KiCI orchestrator auto-scaler — dynamic agent provisioning across container, bare-metal, Firecracker, and event backends
---

The auto-scaler dynamically provisions agents in response to workload. It is configured via a `scalers.yaml` file (or files in a `scalers.d/` directory) that maps job labels to backend provisioning details. The orchestrator reloads it on `SIGHUP`.

## Quick start

1. Create a scaler config file:

```yaml
# /etc/kici/scalers.yaml
version: 1
globalMaxAgents: 10

scalers:
  - name: container-default
    type: container
    # runtime defaults to 'auto' -- detects Docker or Podman
    maxAgents: 10
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

2. Point the orchestrator at it:

```env
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml
```

For multi-file configurations, also set `KICI_SCALER_CONFIG_DIR=/etc/kici/scalers.d/`.

3. Restart the orchestrator. It now auto-provisions container agents when jobs arrive with `runsOn: ['linux', 'container']`.

## Which backend?

| Backend                                       | Provisions                                              | Choose it for                                                  |
| --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| [`container`](./auto-scaler/container.md)     | Docker / Podman containers                              | Linux CI on shared infrastructure — the common deployment.     |
| [`bare-metal`](./auto-scaler/bare-metal.md)   | Host child processes                                    | macOS, Windows, GPU, or specialized hardware workloads.        |
| [`firecracker`](./auto-scaler/firecracker.md) | KVM microVMs                                            | Untrusted / multi-tenant workloads needing hardware isolation. |
| [`event`](./event-scaler.md)                  | Cloud instances, through your own provisioning workflow | Cloud autoscaling without a built-in cloud SDK.                |

## Caps in a cluster

`maxAgents` means different things on a local backend and on the event backend, and the difference matters as soon as you run more than one orchestrator against [one shared database](./clustering.md).

| Cap                                                       | Counted            | Bounds                                            |
| --------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `maxAgents` on an [`event`](./event-scaler.md) scaler     | Across the cluster | The number of cloud instances that scaler runs    |
| `maxAgents` on `container` / `bare-metal` / `firecracker` | Per orchestrator   | The agents that one host runs                     |
| `globalMaxAgents`                                         | Per orchestrator   | The agents that one host runs, across its scalers |

A local backend runs its compute on the orchestrator's own machine, so its cap is a statement about that machine's CPU, memory, and disk. Counting it across the cluster would let one busy host take the whole budget and exhaust itself. Two orchestrators that each set `maxAgents: 10` on a container scaler therefore run up to 10 containers each, and 20 together.

An event scaler runs no local compute. It asks a provisioning workflow to boot a cloud instance, and any coordinator can ask. Its cap is a statement about the cloud bill, so it is counted and claimed cluster-wide, inside one database transaction. Two coordinators that each set `maxAgents: 10` on the same event scaler run 10 instances in total. See [Event scaler high availability](./event-scaler.md#high-availability).

## Reference

| Page                                                   | Covers                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Common configuration](./auto-scaler/common-config.md) | Fields shared across all backends: top-level schema, label sets, resource caps, warm pool, roles, mandatory/exclude labels, env forwarding, network policy, backpressure. |
| [Operations](./auto-scaler/operations.md)              | Running and observing: label matching, multi-scaler layout, deployment topology, `SIGHUP` reload, monitoring, troubleshooting, multi-backend examples.                    |
| [Container backend](./auto-scaler/container.md)        | Container-specific fields, runtime auto-detection, lifecycle, registry auth, the container-socket security warning.                                                       |
| [Bare-metal backend](./auto-scaler/bare-metal.md)      | Host child processes, cgroup enforcement, network access, remote macOS / Windows orchestrator setup.                                                                      |
| [Firecracker backend](./auto-scaler/firecracker.md)    | VM networking, jailer fields, rootfs, DB migration, the MMDS credential model, helper scripts.                                                                            |
| [Event backend](./event-scaler.md)                     | Cloud autoscaling driven by your own provisioning workflow: event fields, claim codes, cluster-wide caps, the teardown reaper.                                            |

## See also

- [Agent execution security](../security/agent-security.md) — how each backend confines customer workflow code; read this before exposing a scaler to untrusted workloads.
- [Firecracker host setup](firecracker/host-setup.md) — Firecracker host provisioning, networking, jailer, IP allocation, troubleshooting.
- [Configuration reference](configuration.md) — orchestrator environment variables including `KICI_SCALER_CONFIG_PATH` and `KICI_SCALER_CONFIG_DIR`.
- [Architecture overview](../../architecture/overview.md) — three-tier relay model and component responsibilities.
- [Agent configuration](../agent/configuration.md) — environment variables for agents connecting to the orchestrator.
- [Orchestrator getting started](getting-started.md) — deployment guide with Docker Compose examples.
