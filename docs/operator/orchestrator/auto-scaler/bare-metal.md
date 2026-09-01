---
title: 'Auto-scaler: bare-metal backend'
description: Bare-metal scaler backend — host child processes, cgroup enforcement, and remote macOS / Windows orchestrator setup
---

The bare-metal backend provisions agents as host child processes (`child_process.spawn`). Use it for workloads that cannot run in containers (GPU access, specialized hardware) or when container overhead is unacceptable. For fields shared across all backends, see [Common configuration](./common-config.md).

## Bare-metal-specific fields

**Label-set-level fields:**

- `binaryPath` — Filesystem path to the agent binary. The scaler spawns this
  process for each job.
- `image` — A `kici-agent` container image. It has two uses, described in
  [Container jobs](#container-jobs) below.

Every bare-metal label set needs at least one of the two. A set with only
`binaryPath` spawns a host process, which is the classic bare-metal pool.

## Container jobs

A job may name its own container image with the `container` field. KiCI runs
such a job with its own Node build mounted read-only, so the image needs neither
Node nor git. A bare-metal agent is a plain host process and carries no such
build, so the label set's `image` is where it comes from:

- **`binaryPath` and `image`** — The pool spawns the agent process as usual.
  When that agent takes a `container` job, it starts the job's container and
  copies the Node build out of `image` into a named volume, which it then
  mounts into the job container. The copy runs once per agent image on that
  host and is reused afterwards.
- **`image` only** — The pool runs the job's own image _as_ the agent, with
  the same Node build mounted in. There is no host process. Use this for a pool
  that only ever runs container jobs. The agent runs inside the job's image here,
  so that image must also ship `git` and `bash`; the agent refuses to start
  without them.
- **`binaryPath` only** — No Node build is available to inject, so a
  `container` job runs on the image's own `node`. That works for an image
  that ships one, such as `node:24-slim`.

The host needs docker or podman for any of this. See
[Container jobs](../../../user/container-jobs.md) for the job-side contract.

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

For a non-Linux bare-metal pool, prefer declaring the structured `platform: { os, arch }` field — it is the canonical way to taint a Windows / macOS / ARM pool so unqualified Linux jobs are never routed to it, and it works even when the pool's plain labels use a non-canonical name. See [Automatic platform taint](./common-config.md) in the common config reference.

### Key notes

- **Warm pool support**: Bare-metal scalers accept a `warmPool` block and keep its agents ready like every other backend (see [Warm pool](./common-config.md#warm-pool)). Starting a bare-metal process takes seconds, so a warm pool saves little here — the default `size: 0` is the right choice for most bare-metal pools. The `maxAgents` field controls maximum concurrency (how many simultaneous jobs can run).

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
