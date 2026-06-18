---
title: Auto-scaler
description: KiCI orchestrator auto-scaler — dynamic agent provisioning across container, bare-metal, and Firecracker backends
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

| Backend                                       | Provisions                 | Choose it for                                                  |
| --------------------------------------------- | -------------------------- | -------------------------------------------------------------- |
| [`container`](./auto-scaler/container.md)     | Docker / Podman containers | Linux CI on shared infrastructure — the common deployment.     |
| [`bare-metal`](./auto-scaler/bare-metal.md)   | Host child processes       | macOS, Windows, GPU, or specialized hardware workloads.        |
| [`firecracker`](./auto-scaler/firecracker.md) | KVM microVMs               | Untrusted / multi-tenant workloads needing hardware isolation. |

## Reference

| Page                                                   | Covers                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Common configuration](./auto-scaler/common-config.md) | Fields shared across all backends: top-level schema, label sets, resource caps, warm pool, roles, mandatory/exclude labels, env forwarding, network policy, backpressure. |
| [Operations](./auto-scaler/operations.md)              | Running and observing: label matching, multi-scaler layout, deployment topology, `SIGHUP` reload, monitoring, troubleshooting, multi-backend examples.                    |
| [Container backend](./auto-scaler/container.md)        | Container-specific fields, runtime auto-detection, lifecycle, registry auth, the container-socket security warning.                                                       |
| [Bare-metal backend](./auto-scaler/bare-metal.md)      | Host child processes, cgroup enforcement, network access, remote macOS / Windows orchestrator setup.                                                                      |
| [Firecracker backend](./auto-scaler/firecracker.md)    | VM networking, jailer fields, rootfs, DB migration, the MMDS credential model, helper scripts.                                                                            |

## See also

- [Agent execution security](../security/agent-security.md) — how each backend confines customer workflow code; read this before exposing a scaler to untrusted workloads.
- [Firecracker setup guide](firecracker-setup.md) — Firecracker host setup, rootfs building, networking, troubleshooting.
- [Configuration reference](configuration.md) — orchestrator environment variables including `KICI_SCALER_CONFIG_PATH` and `KICI_SCALER_CONFIG_DIR`.
- [Architecture overview](../../architecture/overview.md) — three-tier relay model and component responsibilities.
- [Agent configuration](../agent/configuration.md) — environment variables for agents connecting to the orchestrator.
- [Orchestrator getting started](getting-started.md) — deployment guide with Docker Compose examples.
