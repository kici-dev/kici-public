---
title: 'Auto-scaler: bare-metal backend'
description: Bare-metal scaler backend — host child processes, cgroup enforcement, and remote macOS / Windows orchestrator setup
---

The bare-metal backend provisions agents as host child processes (`child_process.spawn`). Use it for workloads that cannot run in containers (GPU access, specialized hardware) or when container overhead is unacceptable. For fields shared across all backends, see [Common configuration](./common-config.md).

## Bare-metal-specific fields

**Label-set-level fields:**

- `binaryPath` — Filesystem path to the agent binary. The scaler spawns this
  process for each job. On Windows this is the `kici-agent.cmd` launcher that a
  Windows package or `npm install -g kici-admin` installs. See
  [Windows launchers](#windows-launchers).
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

Each agent runs as a host process. On Linux and macOS it is detached and leads its own process group, so the scaler can stop the whole tree. On Windows it starts without a console window. Environment variables are passed directly to the spawned process:

- `KICI_ORCHESTRATOR_URL` -- Orchestrator WebSocket URL
- `KICI_AGENT_ID` -- Pre-generated agent ID for correlation
- `KICI_LABELS` -- Comma-separated label set
- `KICI_SCALER_MANAGED=1` -- Scaler-managed flag
- `KICI_EXECUTION_MODE=bare-metal` -- Execution mode
- `KICI_PORT=0` -- Random port assignment
- `KICI_RUNTIME_IMAGE` -- (set only when the label set declares an `image`) Where the agent materializes the KiCI runtime from when it nests a job container. A label set with `binaryPath` alone leaves it unset, which is why a `container` job on such a pool runs on the image's own `node`
- `KICI_AGENT_TOKEN` -- (optional) Ephemeral auth token when auth is configured
- `KICI_BACKPRESSURE_MODE` -- (optional) Log backpressure mode from label set config
- Host variables forwarded through the [`KICI_AGENT_ENV_` prefix](./common-config.md#environment-variable-forwarding)
- Any additional `env` entries from the label set config, which win on a conflict

### Windows launchers

On Windows the agent binary is a batch file, `kici-agent.cmd`. Node.js does not start a batch file directly, so the scaler runs it through cmd.exe:

    cmd.exe /d /e:on /v:off /c call <binaryPath> <NUL

The scaler uses the cmd.exe that `COMSPEC` names on the orchestrator host. When `COMSPEC` names another program, it uses `C:\Windows\System32\cmd.exe`. A binary that is not a batch file, such as `node.exe`, runs directly.

cmd.exe reads some characters in a path as syntax. On a Windows orchestrator, a `.cmd` or `.bat` `binaryPath` that contains `"`, `%` or `^` stops the orchestrator from starting, and a reload fails. When the path contains no space, `&`, `|`, `<`, `>`, `(`, `)`, `,`, `;` and `=` are refused too. A path with a space is quoted, so `C:\Program Files (x86)\KiCI\kici-agent.cmd` is accepted.

## Agent lifecycle

All bare-metal agents are single-use: the agent process is spawned for one job, then stopped after the job completes or the agent disconnects.

- **Linux and macOS:** the scaler sends SIGTERM to the process group, waits 5 seconds, then sends SIGKILL.
- **Windows:** the scaler ends the whole process tree at once with `taskkill /T /F /PID <pid>`. The orchestrator cannot send a ctrl-C to a process on Windows, so there is no graceful step. When the tree has already exited, the scaler does nothing.

## Launch failures

Sometimes an agent never starts. Either the host refuses to start the agent process, or the process stops before it connects to the orchestrator. For example, a label-set `env` value can be longer than the operating system accepts (`E2BIG` on Linux), or the agent can stop at startup because a tool it needs is missing. In both cases the scaler does three things:

- **Reports it.** `kici-admin diagnose` shows the cause on the `scaler:<name>` row, and the waiting job's error names it. For an agent that stopped, the cause includes the last lines the agent wrote.
- **Defers the scaler.** The next spawn for that scaler waits `scaler-provision-backoff-base-ms`. Each further consecutive failure doubles the wait, up to `scaler-provision-backoff-max-ms`. An agent that registers clears it. These are the cluster settings described in [Retry backoff](../event-scaler.md#retry-backoff).
- **Frees the capacity.** Other scalers and other jobs are not held back.

An agent that connected and stops later is not a launch failure. A missing binary is caught earlier: the orchestrator checks that `binaryPath` exists when it starts.

## cgroup enforcement

By default, bare-metal resource `limits` are advisory — they drive the cap math (per-scaler / global / machine-pool budgets) but no cgroup is created. Set `enforceCgroups: true` on the scaler entry to wrap each agent in a transient `systemd-run --user --scope --slice=kici-scaler` with `CPUQuota=` / `MemoryMax=` derived from the resolved limits. This is Linux-only; on macOS and Windows the flag silently no-ops with a startup warning. The requests/limits model is described in [Common configuration → Resource limits](./common-config.md#resource-limits).

`enforceCgroups` governs process mode only. A container-mode agent (`image` only) takes its ceilings from the container runtime instead — memory, CPU and a process cap, exactly as the [container backend](./container.md) applies them.

## Network access

What isolates an agent depends on how its label set launches it.

- **Process mode** (`binaryPath`) has no network isolation. The agent runs as a child process with full host filesystem and network access. A `networkPolicy` on such a label set is not enforced, and a startup warning names it. Use this mode in trusted environments only.
- **Container mode** (`image` only — see [Container jobs](#container-jobs)) joins the agent container to the isolated `kici-agent-net` network and applies the same per-address nftables rules as the [container backend](./container.md): the RFC1918 and cloud-metadata drops, plus the label set's `networkPolicy`.

See [Agent execution security](../../security/agent-security.md) for the isolation trade-offs across backends.

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
        binaryPath: C:\kici\agent\kici-agent.cmd
```

For a non-Linux bare-metal pool, prefer declaring the structured `platform: { os, arch }` field. It is the canonical way to taint a Windows / macOS / ARM pool so unqualified Linux jobs are never routed to it, and it works even when the pool's plain labels use a non-canonical name. See [Automatic platform taint](./common-config.md) in the common config reference.

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
