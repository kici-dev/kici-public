---
title: 'Auto-scaler: operations'
description: Running and observing the auto-scaler — label matching, multi-scaler layout, config reload, monitoring, troubleshooting
---

This page covers how the auto-scaler behaves at runtime and how to operate it. For the YAML fields you set, see [Common configuration](./common-config.md) and the per-backend pages.

## Deployment topology

The orchestrator's own deployment mode (running on bare metal vs running inside a container) is **orthogonal** to which scaler backend it can use. There is no code-level check that detects whether the orchestrator is containerised, and nothing restricts the backend list based on it. What each backend needs is **host-level access to the resources it provisions**, regardless of how the orchestrator process is packaged.

So a containerised orchestrator (e.g., the customer-deployable `quay.io/kici-dev/kici-orchestrator` image under Podman or Docker) can drive any of the three local-compute backends — but only if its container is granted the access that backend requires. A default, unprivileged container does **not** have that access; you must pass it through explicitly. The [`event`](../event-scaler.md) backend runs no local compute, so it needs no host passthrough at all and is absent from the table below.

| Backend     | What it provisions   | What a containerised orchestrator must be granted                                                                                                                                                                                                                                                                                     |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container   | sibling containers   | The container runtime socket bind-mounted in (`/var/run/docker.sock` or the Podman socket), or a remote daemon via `host: tcp://…`. This is the common, supported deployment.                                                                                                                                                         |
| Bare-metal  | host child processes | The agent binary must be reachable on a mounted host path (e.g. `--volume /opt/kici:/opt/kici`), with `binaryPath` pointing at the mounted location. Spawned agents then inherit the container's namespaces — they do **not** land on the host unless the container shares the host PID/network namespaces.                           |
| Firecracker | KVM microVMs         | `--device /dev/kvm`, `--device /dev/net/tun`, a writable mount for `chrootBaseDir` (default `/srv/jailer`), and the capability to run `ip` / `chown` (either as root inside the container or via `requireSudo: true` with passwordless `sudo`). In practice this means `--privileged` or a carefully curated capability + device set. |

Practical guidance:

- **Container backend in a container** is the standard customer deployment and needs only the socket (or a remote `host`).
- **Bare-metal backend in a container** is unusual. Because child processes inherit the orchestrator container's filesystem and namespaces, "bare-metal" agents launched from inside a container are really container-local processes, not host processes — which defeats the usual reason to pick bare-metal (host hardware / GPU access). If you need agents on the host, run the orchestrator on the host.
- **Firecracker backend in a container** is technically possible but operationally fragile: nested KVM access, TAP device management, and jailer chroot all want host-level privileges. The supported and documented path is to run a Firecracker-backed orchestrator **on the bare-metal host** — see the [Firecracker host setup](../firecracker/host-setup.md), whose prerequisites assume the orchestrator process has direct `/dev/kvm` and networking access.

The bottom line: the answer is "yes, with the right passthrough," but only the container backend is a natural fit for a containerised orchestrator. For bare-metal and Firecracker, run the orchestrator on the host.

## Multi-scaler setup

For complex deployments, split scaler definitions across multiple files using the `scalers.d/` directory pattern (inspired by Linux daemon conventions like `conf.d/`).

### Directory structure

```
/etc/kici/
  scalers.yaml          # Main config (version, globalMaxAgents, defaults)
  scalers.d/
    container-linux.yaml # Container scaler for Linux agents
    gpu-machines.yaml    # Bare-metal scaler for GPU machines
```

### Main config

The main config provides version, global settings, and optionally its own scalers:

```yaml
# /etc/kici/scalers.yaml
version: 1
globalMaxAgents: 50
defaults:
  resources:
    memory: '2g'
    cpus: 2
```

### Additional scaler files

Files in `scalers.d/` contain only `scalers` arrays. They are loaded alphabetically and merged into the main config:

```yaml
# /etc/kici/scalers.d/container-linux.yaml
scalers:
  - name: container-linux
    type: container
    maxAgents: 20
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

```yaml
# /etc/kici/scalers.d/gpu-machines.yaml
scalers:
  - name: gpu-machines
    type: bare-metal
    maxAgents: 3
    labelSets:
      - labels: ['linux', 'gpu', 'cuda']
        binaryPath: '/opt/kici/kici-agent'
```

### Label-set overlap detection

At startup, the scaler validates that no label set appears in more than one scaler backend across all files. If an overlap is detected, the orchestrator rejects the configuration and exits.

```
Error: Label set [linux,container] overlaps between scalers "container-team-a" and "container-team-b"
```

Overlapping label sets within the same scaler are allowed (the first match is used). Only cross-scaler overlaps are rejected.

## Label matching

Labels use **subset matching semantics** -- a job's `runsOn` labels must all be present in the scaler's label set, but the scaler can have additional labels. This is consistent with peer routing in cluster mode. Label sets are normalized (sorted alphabetically, deduplicated, lowercased) before comparison. When multiple backends match, the one with the smallest label set wins (most specific match).

### Auto-injected labels

Every spawned agent ends up with a set of internal labels added automatically. Some are injected by the scaler backend via the `KICI_LABELS` environment variable when the agent is spawned; others are added by the agent itself at registration time based on its own environment. The final label set (as seen by the orchestrator after registration) includes:

- **`kici:os:<platform>`** -- Host OS (e.g., `kici:os:linux`). Added by the agent at registration from its own `os.platform()`. For matching purposes, the scaler uses the actual host platform for bare-metal entries and always uses `linux` for container and Firecracker entries.
- **`kici:arch:<arch>`** -- CPU architecture (e.g., `kici:arch:x64`, `kici:arch:arm64`). Added by the agent at registration from `os.arch()`.
- **`kici:agent:<backend-type>`** -- Backend type (e.g., `kici:agent:container`, `kici:agent:bare-metal`, `kici:agent:firecracker`). Injected by the scaler into `KICI_LABELS`.
- **`kici:scaler:<scaler-name>`** -- Scaler entry name (e.g., `kici:scaler:linux-containers`). Injected by the scaler into `KICI_LABELS`.
- **`kici:host:<hostname>`** -- Hostname of the machine running the agent (e.g., `kici:host:host-1`). Added by the agent at registration from `os.hostname()`. Useful for routing jobs to already-registered agents, but not usable as a scaling target (the scaler cannot predict the hostname of agents it has not yet spawned).
- **`kici:role:<role>`** -- One label per active role (e.g., `kici:role:builder`, `kici:role:init-runner`). Injected by the scaler into `KICI_LABELS`. By default (when `roles` is not set), all known role labels are injected. When `roles` is an empty array `[]`, no role labels are injected. When specific roles are listed, only those role labels are injected.

These labels use the reserved `kici:` prefix namespace. You do not need to include them in your `labelSets` configuration -- they are added automatically. However, you can reference them in job `runsOn` arrays to target specific backend types or scaler entries (e.g., `runsOn: ['linux', 'kici:agent:firecracker']`).

### Matching rules

- A job with `runsOn: ["linux", "container"]` matches a label set `["container", "linux"]` (order does not matter).
- A job with `runsOn: ["linux"]` matches `["linux", "container"]` (job labels are a subset of the scaler's labels).
- A job with `runsOn: ["linux", "container", "node20"]` does **NOT** match `["linux", "container"]` (job requires labels the scaler does not have).
- Labels are case-insensitive: `["Linux"]` matches `["linux"]` (normalization lowercases all labels).

### Examples

| Job `runsOn`                       | Scaler Label Set                    | Match? |
| ---------------------------------- | ----------------------------------- | ------ |
| `["linux", "container"]`           | `["container", "linux"]`            | Yes    |
| `["linux"]`                        | `["linux", "container"]`            | Yes    |
| `["linux", "container", "node20"]` | `["linux", "container"]`            | No     |
| `["linux", "container"]`           | `["linux", "container"]`            | Yes    |
| `["gpu", "cuda"]`                  | `["cuda", "gpu"]`                   | Yes    |
| `["macos"]`                        | `["macos", "darwin", "bare-metal"]` | Yes    |

### What happens when no match is found

If a job's labels do not match any scaler's label sets **and** no static agent with matching labels is connected, the job is queued locally as a fallback (with `queued-no-backend` status) while the cluster coordinator attempts peer rerouting. The queued job is registered on the run, so the run cannot finish without it.

If a peer accepts the job, the local fallback entry is cancelled and the peer runs it. Otherwise — no peer can handle the labels, or the deployment has no cluster peers at all — the job stays queued until an agent that satisfies its labels appears (a scaler pool sitting at zero can still scale up and drain it) or the queue window expires.

At expiry the verdict splits:

- A label set that **neither** a connected agent **nor** a scaler backend can serve settles the job [`unroutable`](../../../architecture/execution/state-machine.md). Its error message names the unsatisfied `runsOn` selectors, and the run **fails** — a job that could never be routed does not report success.
- Anything else — including a job whose agent spawn was attempted and recorded a provisioning error — settles `timed_out_stale`. A failed spawn proves the labels did route, so the provisioning error is the real cause to investigate.

## Config reload (SIGHUP)

Send `SIGHUP` to the orchestrator process to reload the scaler configuration without restart:

```bash
kill -HUP $(pidof node)
# or
kill -HUP $(cat /var/run/kici-orchestrator.pid)
```

### Reload process

The reload runs in four stages. It applies completely, or not at all:

1. **Plan** -- Compares the new config against the running backends: which scalers are new, unchanged, removed, or changed type.
2. **Validate** -- Checks label-set overlaps across scalers, rejects a scaler whose backend type changed, and asks each existing backend to validate its new label sets (for example, container checks that all label sets have `image` fields). Any error rejects the reload.
3. **Build** -- Constructs a backend for each newly added scaler. If a backend fails to construct, everything built so far is torn down and the reload is rejected.
4. **Commit** -- Applies the new configuration in one step.

On rejection the current configuration keeps serving, and the error is logged.

### What changes on reload

- Global max agents limit and the orchestrator-wide resource cap
- **Adding a scaler** -- a backend is constructed and starts serving its label sets, with no restart
- **Removing a scaler** -- the scaler stops accepting new work immediately (see [Removing a scaler](#removing-a-scaler))
- Per-scaler label sets and their properties (image, resources, env)
- Per-scaler `maxAgents` (population cap) and `maxConcurrentSpawns` (provisioning-rate throttle)
- Per-scaler `orchestratorUrl` (URL for spawned agents to connect back to)
- Per-scaler `roles` (which internal job types the scaler handles)
- Per-scaler `resourceCap`, `machinePool` and `mandatoryLabels`
- Newly declared machine pools
- Warm pool sizes and timeouts, including turning a warm pool off

### Removing a scaler

Deleting a scaler from the config retires it gracefully:

- it stops accepting new work as soon as the reload commits;
- its idle warm-pool agents are destroyed immediately;
- agents already running a job keep running until that job finishes;
- once its last agent is gone, the backend is torn down and the scaler disappears from `kici-admin diagnose`.

While it drains, its `scaler:<name>` row in `kici-admin diagnose` reports it as retiring with its remaining agent count. A reload never kills a running job.

### What does NOT change on reload

- **Backend types.** Changing a scaler's `type` (for example, container to bare-metal) is rejected with `scaler "<name>": backend type cannot change from container to bare-metal on reload; restart the orchestrator to apply`. Restart the orchestrator to apply a type change.
- **`KICI_AGENT_ENV_` process environment.** The orchestrator does not re-read its own environment. Restart it to pick up new values.
- **Running agents.** Config changes apply to new spawns.

## Monitoring

The scaler exposes Prometheus metrics with the `kici_orch_scaler_` prefix, available on the orchestrator's `/metrics` endpoint.

### Metrics reference

| Metric                                            | Type    | Labels                                | Description                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kici_orch_scaler_config_reloads_total`           | Counter | `result`                              | Config reload attempts (`attempted`, `success`, `failed`)                                                                                                                                                                                                                                                |
| `kici_orch_scaler_cpus_used`                      | Gauge   | `scaler`, `scalerType`, `machinePool` | Current CPU reservations summed by scaler / pool. `scaler="__global__"` is the orchestrator-wide total; pool rows reflect the ledger. `scalerType` is the backend type (`__global__`, `stateful`, `container`, `firecracker`, `bare-metal`)                                                              |
| `kici_orch_scaler_memory_bytes_used`              | Gauge   | `scaler`, `scalerType`, `machinePool` | Current memory reservations (bytes) summed by scaler / pool. Same label semantics as `kici_orch_scaler_cpus_used`                                                                                                                                                                                        |
| `kici_orch_scaler_spawn_refusals_total`           | Gauge   | _(none)_                              | Cumulative count of spawn requests refused by a cap (`maxAgents`, `resourceCap`, `globalResourceCap`, `machinePool`). For an `event` scaler `maxAgents` is counted across the whole cluster                                                                                                              |
| `kici_orch_scaler_cap_lock_failures_total`        | Counter | `reason`                              | Event-scaler cluster-wide cap checks that failed, refusing the spawn without evaluating the cap. `reason` is `contended` (the lock was still held when the wait budget expired — the database is healthy) or `unreachable` (the cap could not be evaluated at all). Not a capacity signal                |
| `kici_orch_scaler_spawn_failures_total`           | Counter | `backend`, `bound`                    | Spawn failures where the backend accepted the request but the agent never came up (missing binary, unpullable image, boot failure). `bound` is `true` for a job-bound spawn, `false` for a warm-pool spawn                                                                                               |
| `kici_orch_scaler_adoption_lookup_failures_total` | Counter | _(none)_                              | Spawn-record adoption lookups that failed with a store error, so a registering agent could not be classified as scaler-managed or static. A scaler-spawned agent is refused rather than mis-registered as static, so it reconnects; a rising rate points at the orchestrator database, not at the scaler |
| `kici_orch_scaler_redispatch_total`               | Counter | `trigger`                             | Pending at-capacity jobs re-offered to the scaler when capacity freed. `trigger` is `hook` (near-zero-latency capacity-freed callback) or `sweep` (leader-gated backstop). See [At-capacity queueing and re-dispatch](./common-config.md#at-capacity-queueing-and-re-dispatch)                           |
| `kici_orch_scaler_warm_pool_target`               | Gauge   | `scaler`, `labelSet`                  | Agents the warm pool keeps ready for that label set (`warmPool.size`)                                                                                                                                                                                                                                    |
| `kici_orch_scaler_warm_pool_ready`                | Gauge   | `scaler`, `labelSet`                  | Agents that can serve a job for that label set now — the same query the dispatcher makes                                                                                                                                                                                                                 |
| `kici_orch_scaler_warm_pool_in_flight`            | Gauge   | `scaler`, `labelSet`                  | Warm-pool spawns started but not yet registered. A gap between target and ready that these cover is filling, not failing                                                                                                                                                                                 |
| `kici_orch_scaler_warm_pool_spawns_total`         | Counter | `scaler`                              | Warm-pool spawns started                                                                                                                                                                                                                                                                                 |
| `kici_orch_scaler_warm_pool_reaped_total`         | Counter | `scaler`                              | Warm-pool agents destroyed as surplus: above the target and past `idleTimeoutSeconds`, or above a target a config reload lowered                                                                                                                                                                         |

### Suggested alert rules

```yaml
# Config reload failures
- alert: KiCIScalerConfigReloadFailed
  expr: increase(kici_orch_scaler_config_reloads_total{result="failed"}[1h]) > 0
  for: 0m
  labels:
    severity: warning
  annotations:
    summary: 'Scaler config reload failed'
```

## Troubleshooting

Backend-specific troubleshooting lives on each backend page: [Container](./container.md#troubleshooting), [Bare-metal](./bare-metal.md), [Firecracker](./firecracker.md).

### Label mismatch

**Symptom:** Jobs fail immediately with `no-backend` error.

**Cause:** Job `runsOn` labels are not a subset of any scaler label set.

**Solution:** Check your workflow's `runsOn` labels against the scaler config. Remember: all job labels must be present in the scaler's label set (subset matching). Labels are normalized (sorted, deduplicated, lowercased) before comparison.

```bash
# Check what label sets are configured
grep -A2 "labels:" /etc/kici/scalers.yaml
```

### Config reload rejected

**Symptom:** SIGHUP sent but config does not change. Error in logs: `Config reload failed, keeping current config`.

**Cause:** The new config has validation errors (label-set overlap, missing required fields, invalid values).

**Solution:** Check orchestrator logs for the specific validation errors. Fix the config and send SIGHUP again. The current config remains active during failed reloads.

### A removed scaler still appears in status

**Symptom:** A scaler deleted from the config still has a `scaler:<name>` row in `kici-admin diagnose`, marked retiring.

**Cause:** It still has agents running a job. A reload never kills running work, so the backend stays until its last agent finishes.

**Solution:** Wait for the running jobs to finish -- the scaler disappears on its own. To stop the work immediately, cancel the runs that use those agents, or drain the orchestrator with `kici admin drain-worker`.

### A scaled agent reconnects in a loop after an orchestrator restart

**Symptom:** After the orchestrator restarts, one agent connects and is disconnected again, first every few seconds and then about once a minute as its retry backoff grows. Orchestrator logs show `scaler: no spawn record for a scaler-managed agent; refusing registration`, and the agent sees the close reason `Scaler state unavailable`.

**Cause:** The agent was started by a scaler, but the orchestrator has no spawn record for it any more. Without that record the orchestrator cannot know which mandatory labels gate the agent. Registering it would let a job that does not ask for those labels run on it -- for example, a Linux job on a Windows host. The orchestrator refuses instead.

**Solution:** Usually the orchestrator ends the loop itself. A container backend removes every managed container when the orchestrator starts. A Firecracker agent is reclaimed on the refusal: the orchestrator kills the VM, releases its IP, and deletes its jailer directory. Both need the compute to be on the host that refused the agent. In a cluster behind a shared endpoint, the agent can reach an orchestrator that did not start it. That orchestrator holds none of the host state, so it reclaims nothing. The loop then ends on the first reconnect that reaches the orchestrator whose host holds the agent. A bare-metal agent that runs in a container is reclaimed the same way: the orchestrator removes the container by its agent label. A bare-metal agent that runs as a plain process stays. The backend keeps no on-disk record of that process, so nothing finds it after a restart -- stop it by hand. The agent receives no work while it loops, so jobs are unaffected -- a new agent is scaled up for them as normal.

## Example configurations

These examples combine multiple scaler backends. For single-backend examples, see the [Container](./container.md#examples), [Bare-metal](./bare-metal.md#example), and [Firecracker](./firecracker.md#configuration) pages.

### Mixed: container + bare-metal GPU

```yaml
# Container for standard workloads, bare-metal for GPU workloads
version: 1
globalMaxAgents: 25

defaults:
  resources:
    memory: '2g'
    cpus: 2

scalers:
  - name: container-standard
    type: container
    maxAgents: 20
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
      - labels: ['linux', 'container', 'node20']
        image: 'ghcr.io/myorg/kici-agent-node20:latest'
        resources:
          memory: '4g'
          cpus: 4

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

### Production: multi-scaler with warm pools

Using `scalers.d/` directory for team-managed configs:

```yaml
# /etc/kici/scalers.yaml
version: 1
globalMaxAgents: 100

defaults:
  resources:
    memory: '2g'
    cpus: 2
```

```yaml
# /etc/kici/scalers.d/container-standard.yaml
scalers:
  - name: container-standard
    type: container
    maxAgents: 40
    warmPool:
      enabled: true
      size: 5
      idleTimeoutSeconds: 300
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
      - labels: ['linux', 'container', 'node20']
        image: 'ghcr.io/myorg/kici-agent-node20:latest'
        resources:
          memory: '4g'
          cpus: 4
```

```yaml
# /etc/kici/scalers.d/container-heavy.yaml
scalers:
  - name: container-heavy
    type: container
    maxAgents: 10
    warmPool:
      enabled: true
      size: 2
      idleTimeoutSeconds: 600
    labelSets:
      - labels: ['linux', 'heavy']
        image: 'ghcr.io/myorg/kici-agent-heavy:latest'
        resources:
          memory: '8g'
          cpus: 8
        containerSocket: true # WARNING: See security section
```

```yaml
# /etc/kici/scalers.d/gpu-machines.yaml
scalers:
  - name: gpu-machines
    type: bare-metal
    maxAgents: 5
    labelSets:
      - labels: ['linux', 'gpu', 'cuda']
        binaryPath: '/opt/kici/kici-agent'
        resources:
          memory: '32g'
          cpus: 16
```
