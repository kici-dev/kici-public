---
title: 'Auto-scaler: operations'
description: Running and observing the auto-scaler — label matching, multi-scaler layout, config reload, monitoring, troubleshooting
---

This page covers how the auto-scaler behaves at runtime and how to operate it. For the YAML fields you set, see [Common configuration](./common-config.md) and the per-backend pages.

## Deployment topology

The orchestrator's own deployment mode (running on bare metal vs running inside a container) is **orthogonal** to which scaler backend it can use. There is no code-level check that detects whether the orchestrator is containerised, and nothing restricts the backend list based on it. What each backend needs is **host-level access to the resources it provisions**, regardless of how the orchestrator process is packaged.

So a containerised orchestrator (e.g., the customer-deployable `quay.io/kici-dev/kici-orchestrator` image under Podman or Docker) can drive any of the three backends — but only if its container is granted the access that backend requires. A default, unprivileged container does **not** have that access; you must pass it through explicitly.

| Backend     | What it provisions   | What a containerised orchestrator must be granted                                                                                                                                                                                                                                                                                     |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container   | sibling containers   | The container runtime socket bind-mounted in (`/var/run/docker.sock` or the Podman socket), or a remote daemon via `host: tcp://…`. This is the common, supported deployment.                                                                                                                                                         |
| Bare-metal  | host child processes | The agent binary must be reachable on a mounted host path (e.g. `--volume /opt/kici:/opt/kici`), with `binaryPath` pointing at the mounted location. Spawned agents then inherit the container's namespaces — they do **not** land on the host unless the container shares the host PID/network namespaces.                           |
| Firecracker | KVM microVMs         | `--device /dev/kvm`, `--device /dev/net/tun`, a writable mount for `chrootBaseDir` (default `/srv/jailer`), and the capability to run `ip` / `chown` (either as root inside the container or via `requireSudo: true` with passwordless `sudo`). In practice this means `--privileged` or a carefully curated capability + device set. |

Practical guidance:

- **Container backend in a container** is the standard customer deployment and needs only the socket (or a remote `host`).
- **Bare-metal backend in a container** is unusual. Because child processes inherit the orchestrator container's filesystem and namespaces, "bare-metal" agents launched from inside a container are really container-local processes, not host processes — which defeats the usual reason to pick bare-metal (host hardware / GPU access). If you need agents on the host, run the orchestrator on the host.
- **Firecracker backend in a container** is technically possible but operationally fragile: nested KVM access, TAP device management, and jailer chroot all want host-level privileges. The supported and documented path is to run a Firecracker-backed orchestrator **on the bare-metal host** — see the [Firecracker setup guide](../firecracker-setup.md), whose prerequisites assume the orchestrator process has direct `/dev/kvm` and networking access.

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

If a job's labels do not match any scaler's label sets **and** no static agent with matching labels is connected, the job is queued locally as a fallback (with `queued-no-backend` status) while the cluster coordinator attempts peer rerouting. If no peer in the cluster can handle the labels either, the job ultimately fails with a `no-backend` error. In single-orchestrator deployments (no cluster peers), the queued fallback job will remain pending until it times out.

## Config reload (SIGHUP)

Send `SIGHUP` to the orchestrator process to reload the scaler configuration without restart:

```bash
kill -HUP $(pidof node)
# or
kill -HUP $(cat /var/run/kici-orchestrator.pid)
```

### Reload process

The reload follows a three-stage validation process:

1. **Load** -- Re-reads the YAML config file (and `scalers.d/` directory if configured).
2. **Validate overlaps** -- Checks for label-set overlaps across scalers. If any overlap is found, the reload is rejected.
3. **Validate backends** -- Each backend validates its new label sets (e.g., container checks that all label sets have `image` fields). If any backend rejects, the reload is rejected.

Only after all three stages pass is the new configuration applied. On failure, the current configuration is kept and an error is logged.

### What changes on reload

- Global max agents limit
- Per-scaler label sets and their properties (image, resources, env)
- Per-scaler `orchestratorUrl` (URL for spawned agents to connect back to)
- Per-scaler `roles` (which internal job types the scaler handles)
- Warm pool sizes and timeouts

### What does NOT change on reload

- Backend types (cannot change a container scaler to bare-metal)
- Active agents (running agents are not affected; changes apply to new spawns)

## Monitoring

The scaler exposes Prometheus metrics with the `kici_orch_scaler_` prefix, available on the orchestrator's `/metrics` endpoint.

### Metrics reference

| Metric                                  | Type    | Labels                  | Description                                                                                                                                                                                                |
| --------------------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kici_orch_scaler_config_reloads_total` | Counter | `result`                | Config reload attempts (`attempted`, `success`, `failed`)                                                                                                                                                  |
| `kici_orch_scaler_cpus_used`            | Gauge   | `scaler`, `machinePool` | Current CPU reservations summed by scaler / pool. `scaler="__global__"` is the orchestrator-wide total; pool rows reflect the ledger                                                                       |
| `kici_orch_scaler_memory_bytes_used`    | Gauge   | `scaler`, `machinePool` | Current memory reservations (bytes) summed by scaler / pool. Same label semantics as `kici_orch_scaler_cpus_used`                                                                                          |
| `kici_orch_scaler_spawn_refusals_total` | Gauge   | _(none)_                | Cumulative count of spawn requests refused due to resource caps (`maxAgents`, `resourceCap`, `globalResourceCap`, `machinePool`)                                                                           |
| `kici_orch_scaler_spawn_failures_total` | Counter | `backend`, `bound`      | Spawn failures where the backend accepted the request but the agent never came up (missing binary, unpullable image, boot failure). `bound` is `true` for a job-bound spawn, `false` for a warm-pool spawn |

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
