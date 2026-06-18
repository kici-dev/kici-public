---
title: 'Auto-scaler: bare-metal backend'
description: Bare-metal scaler backend — host child processes, cgroup enforcement, and remote macOS / Windows orchestrator setup
---

The bare-metal backend provisions agents as host child processes (`child_process.spawn`). Use it for workloads that cannot run in containers (GPU access, specialized hardware) or when container overhead is unacceptable. For fields shared across all backends, see [Common configuration](./common-config.md).

## Bare-metal-specific fields

**Label-set-level field:**

- `binaryPath` — Filesystem path to the agent binary. Required on every bare-metal label set.

**Scaler-level field:**

- `enforceCgroups` — When `true`, wrap each agent in a transient `systemd-run --user --scope --slice=kici-scaler` with `CPUQuota=` / `MemoryMax=` derived from the resolved resource limits. Default: `false` (advisory limits only). Linux-only; on macOS / Windows the flag silently no-ops with a startup warning. See [cgroup enforcement](#cgroup-enforcement).

## Process management

Processes are spawned in detached process groups (`{ detached: true }`) to enable clean killing of entire process trees. Environment variables are passed directly to the spawned process:

- `KICI_ORCHESTRATOR_URL` -- Orchestrator WebSocket URL
- `KICI_AGENT_ID` -- Pre-generated agent ID for correlation
- `KICI_LABELS` -- Comma-separated label set
- `KICI_SCALER_MANAGED=1` -- Scaler-managed flag
- `KICI_EXECUTION_MODE=bare-metal` -- Execution mode
- `KICI_PORT=0` -- Random port assignment
- `KICI_AGENT_TOKEN` -- (optional) Ephemeral auth token when auth is configured
- `KICI_BACKPRESSURE_MODE` -- (optional) Log backpressure mode from label set config
- Any additional `env` entries from the label set config

## Agent lifecycle

All bare-metal agents are single-use: the agent process is spawned for one job, then killed after the job completes or the agent disconnects. Process group kill sequence: SIGTERM, wait 5s, SIGKILL.

## cgroup enforcement

By default, bare-metal resource `limits` are advisory — they drive the cap math (per-scaler / global / machine-pool budgets) but no cgroup is created. Set `enforceCgroups: true` on the scaler entry to wrap each agent in a transient `systemd-run --user --scope --slice=kici-scaler` with `CPUQuota=` / `MemoryMax=` derived from the resolved limits. This is Linux-only; on macOS and Windows the flag silently no-ops with a startup warning. The requests/limits model is described in [Common configuration → Resource limits](./common-config.md#resource-limits).

## Network access

The bare-metal backend has no network isolation. Agents run as child processes with full host filesystem and network access. If a label set has `networkPolicy` configured, a warning is logged at startup and the policy is not enforced. This mode is intended for trusted environments only — see [Agent execution security](../../security/agent-security.md) for the isolation trade-offs across backends.

## Remote orchestrator configuration (macOS / Windows)

When running a multi-orchestrator cluster, remote Mac or Windows machines need bare-metal scaler entries to advertise their capabilities to the cluster. Without scaler config, the remote orchestrator's heartbeats will show empty capabilities, and the cluster coordinator won't route jobs to it.

### How it works

1. The remote orchestrator connects to the Platform relay as a peer in the cluster.
2. On connection (and via periodic heartbeats), it advertises its scaler capacity -- including the label sets it can handle and available concurrency.
3. The cluster coordinator uses this advertised capacity to make informed routing decisions: when a job needs `runsOn: ['macos']`, it checks which peers have matching labels with available capacity.
4. If no peer handles the required labels, the coordinator returns a clear error: "No orchestrator in cluster handles labels: macos". If peers exist but are at capacity, it says: "Peers with matching labels exist but are at capacity".

### macOS example

```yaml
# scalers.yaml on the Mac orchestrator
version: 1
scalers:
  - name: macos-bare-metal
    type: bare-metal
    maxAgents: 2
    labelSets:
      - labels: [macos, darwin, bare-metal]
        binaryPath: /Users/youruser/kici/agent/kici-agent
```

### Windows example

```yaml
# scalers.yaml on the Windows orchestrator
version: 1
scalers:
  - name: windows-bare-metal
    type: bare-metal
    maxAgents: 2
    labelSets:
      - labels: [windows, bare-metal]
        binaryPath: C:\kici\agent\kici-agent.exe
```

### Key notes

- **Warm pool support**: Bare-metal scalers support warm pools just like container scalers. When `warmPool` is configured, idle agent processes are pre-spawned and consumed on demand. Without a warm pool, agents spawn on demand when a job arrives. The `maxAgents` field controls maximum concurrency (how many simultaneous jobs can run).

- **Intermittent availability**: Remote orchestrators (especially developer laptops) may be intermittently available. When the machine is off or disconnected, jobs requiring its labels will fail with a clear error message ("No orchestrator in cluster handles labels: ..."). This is expected behavior -- the cluster coordinator handles it gracefully.

- **Capability advertisement is automatic**: Once the scaler config is in place and the orchestrator is running, it automatically advertises its capabilities via heartbeats. No additional configuration is needed on the coordinator side.

- **Label matching**: Jobs use `runsOn` label sets (e.g., `runsOn: ['macos', 'arm64']`). The coordinator matches these against the `labelSets` in each scaler's config. All labels in the job's `runsOn` must be present in the scaler's label set for a match.

## Example

```yaml
version: 1
globalMaxAgents: 5

scalers:
  - name: gpu-machines
    type: bare-metal
    maxAgents: 3
    labelSets:
      - labels: ['linux', 'gpu', 'cuda']
        binaryPath: '/opt/kici/kici-agent'
        resources:
          memory: '16g'
          cpus: 8
```
