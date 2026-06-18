---
title: 'Auto-scaler: container backend'
description: Container (Docker / Podman) scaler backend — fields, runtime detection, lifecycle, and the container-socket security warning
---

The container backend provisions agents as ephemeral containers via the Docker-compatible runtime API (Docker or Podman). It supports both **Docker** and **Podman** as container runtimes. Podman implements the same Docker-compatible API, so both runtimes work without any additional configuration. For fields shared across all backends, see [Common configuration](./common-config.md).

## Container-specific fields

**Scaler-level fields:**

- `host` — Container runtime host, e.g. `tcp://192.168.1.10:2376`. Optional; defaults to auto-detecting the local socket.
- `socketPath` — Explicit socket path. Optional; overrides auto-detection.
- `runtime` — `docker`, `podman`, or `auto` (default). Forces a specific runtime.
- `extraHosts` — Extra `host:IP` mappings for spawned containers, e.g. `myhost.local:host-gateway`.
- `networkIsolation` — Enable nftables-based network isolation. Default: `true`.

**Label-set-level fields:**

- `image` — Container image to spawn. Required on every container label set.
- `imagePullPolicy` — `Always` (default), `IfNotPresent`, or `Never`.
- `volumes` — Bind-mount volumes, e.g. `/host/cache:/cache:ro`.
- `containerSocket` — Mount the container runtime socket into the agent. Default: `false`. See the [security warning](#container-socket-sharing--security-warning) before enabling.

## Runtime auto-detection

When the `runtime` field is set to `auto` (the default), the container backend probes for available container runtime sockets at startup:

1. **Docker socket** -- `/var/run/docker.sock`
2. **Rootful Podman socket** -- `/run/podman/podman.sock`
3. **Rootless Podman socket** -- `$XDG_RUNTIME_DIR/podman/podman.sock`

The first accessible socket wins. The detected runtime type is logged at startup:

```
Detected docker at /var/run/docker.sock
```

or

```
Detected podman at /run/podman/podman.sock
```

If no socket is found and no `host` is configured, startup fails with a clear error:

```
No container runtime found. Install Docker or Podman, or configure host.
```

## Overriding auto-detection

Use these fields to control runtime selection explicitly:

- **`runtime: docker|podman|auto`** -- Force a specific runtime. When set to `docker` or `podman`, only sockets for that runtime are probed. Default: `auto`.
- **`socketPath: /path/to/socket.sock`** -- Use a non-standard socket location. The runtime type is inferred from the path (paths containing "podman" are treated as Podman, otherwise Docker).
- **`host: tcp://192.168.1.10:2376`** -- Connect to a remote Docker or Podman daemon over TCP. No local socket detection is performed.

## Container lifecycle

1. **Image pull** -- The scaler ensures the image is available before creating the container. First spawn for a new image may be slow (30--60s for large images). Warm pools naturally pre-pull images.

2. **Container creation** -- The container is created with:
   - Environment variables: `KICI_ORCHESTRATOR_URL`, `KICI_AGENT_ID`, `KICI_LABELS`, `KICI_SCALER_MANAGED=1`, `KICI_EXECUTION_MODE=bare-metal`, optionally `KICI_AGENT_TOKEN` (when auth is configured) and `KICI_BACKPRESSURE_MODE`, plus any per-label-set `env` entries.
   - Container labels for management: `kici-managed=true`, `kici-scaler-name`, `kici-agent-id`, `kici-labels`. When the spawn is bound to a specific job (the normal on-demand path), the container also carries `kici-bound-job-id` and `kici-run-id`, so `podman ps --filter label=kici-run-id=<id>` maps a running container back to the run it serves. Warm-pool spawns are unbound and omit these two labels.
   - Resource limits from the label set or global defaults.
   - Optional container runtime socket bind mount.

3. **Start** -- The container starts and the agent inside connects to the orchestrator via WebSocket.

4. **Execution** -- The agent receives a single job, executes it, and reports status.

5. **Removal** -- After the job completes and the agent disconnects, the scaler stops and removes the container. `AutoRemove` is set to `false` so the scaler controls the full removal lifecycle.

## Resource limit enforcement

Container `limits` are translated into `HostConfig.Memory` (bytes) and `HostConfig.NanoCPUs` (cpus × 1e9) and are always enforced by the runtime. The requests/limits model and the three-layer cascade are described in [Common configuration → Resource limits](./common-config.md#resource-limits).

## Remote container host

By default, the container backend connects to the auto-detected local socket. To use a remote Docker or Podman daemon:

```yaml
scalers:
  - name: container-remote
    type: container
    maxAgents: 10
    host: 'tcp://192.168.1.10:2376'
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

## Registry authentication

The scaler leverages the host's Docker/Podman configuration for registry authentication. No registry credentials are stored in the scaler config. Ensure the container runtime has credentials configured for any private registries referenced in `image` fields (via `docker login` / `podman login` or `~/.docker/config.json` / `${XDG_RUNTIME_DIR}/containers/auth.json`).

## Container socket sharing — security warning

> **WARNING: Enabling `containerSocket` gives CI jobs FULL ROOT ACCESS to the host container runtime (Docker or Podman daemon). This means any workflow step can:**
>
> - **Access ALL files on the host system**
> - **Create, modify, or destroy ANY container on the host**
> - **Read secrets from other running containers**
>
> **Only enable for fully trusted workloads on isolated infrastructure. Never enable for public/untrusted repositories.**

For the full agent-isolation model and how each backend confines customer workflow code, see [Agent execution security](../../security/agent-security.md).

### What is container socket sharing?

When `containerSocket: true` is set on a label set, the scaler mounts whichever container runtime socket was auto-detected (or explicitly configured) into the spawned container at its native path:

- **Docker detected:** `/var/run/docker.sock:/var/run/docker.sock`
- **Podman (rootful) detected:** `/run/podman/podman.sock:/run/podman/podman.sock`
- **Podman (rootless) detected:** `$XDG_RUNTIME_DIR/podman/podman.sock:$XDG_RUNTIME_DIR/podman/podman.sock`
- **Explicit `socketPath`:** The configured path is used for both sides of the bind mount.

This gives the CI container access to the host's container runtime for workflows that need to build container images (e.g., `docker build` or `podman build` inside a CI step).

### Docker-expecting CI jobs with Podman

If CI jobs inside containers expect `/var/run/docker.sock` but Podman is the host runtime, the socket will be mounted at the Podman path, not the Docker path. To work around this:

- **Option A:** Set `socketPath: /var/run/docker.sock` on the scaler to override auto-detection (only works if Podman creates a socket at that path via a compatibility symlink).
- **Option B:** Set `DOCKER_HOST=unix:///run/podman/podman.sock` in the label set `env` so tools inside the container find the Podman socket.

### Why it is dangerous

Access to the container socket is **equivalent to unrestricted root access on the host machine**. A workflow step running inside the container can:

1. **Escape the container:** Run a privileged container that mounts the entire host filesystem.

2. **Attack other containers:** Inspect running containers, read their environment variables (which often contain secrets like API keys and database passwords), and modify their state.

3. **Mine cryptocurrency:** Spawn arbitrary containers for resource-intensive workloads on the host.

4. **Read-only mount does not help:** Mounting the socket as read-only (`:ro`) does **NOT** prevent these attacks. The container daemon does not distinguish between read and write operations on the socket.

### When socket sharing is acceptable

- **Trusted internal repositories only:** All contributors and all workflow code is written by trusted team members.
- **Isolated infrastructure:** The host running these agents has no access to production systems, databases, or sensitive secrets.
- **Never for public repositories:** A malicious pull request could exploit socket access to compromise the host.

### Alternatives to container socket sharing

| Alternative         | Description                                      | Trade-off                                         |
| ------------------- | ------------------------------------------------ | ------------------------------------------------- |
| **Rootless Docker** | Run Docker daemon without root privileges        | Some images may not work; reduced attack surface  |
| **Podman**          | Daemonless, rootless container engine            | Drop-in Docker replacement for most builds        |
| **Sysbox**          | OCI runtime that enables secure Docker-in-Docker | Adds runtime dependency; strong isolation         |
| **Kaniko**          | Build images without Docker daemon               | Build-only (no `docker run`); limited to building |
| **BuildKit**        | Advanced build toolkit with rootless support     | Build-only; requires separate setup               |

## Troubleshooting

### No container runtime found

**Symptom:** Orchestrator fails to start with `No container runtime found. Install Docker or Podman, or configure host.`

**Cause:** No Docker or Podman socket was found at any of the probed paths.

**Solution:** Install Docker or Podman, or configure `host` for a remote container runtime:

```yaml
scalers:
  - name: container-remote
    type: container
    host: 'tcp://192.168.1.10:2376'
    maxAgents: 10
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

### Wrong runtime detected

**Symptom:** Both Docker and Podman are installed. The auto-detection picks Docker, but you want Podman (or vice versa).

**Cause:** Auto-detection uses probe order (Docker first, then Podman). The first accessible socket wins.

**Solution:** Force the desired runtime:

```yaml
scalers:
  - name: podman-agents
    type: container
    runtime: podman # Force Podman detection
    maxAgents: 10
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

### Rootless Podman socket not found

**Symptom:** Podman is installed rootless, but the scaler fails to detect it.

**Cause:** The `podman.socket` user systemd service is not running, or `XDG_RUNTIME_DIR` is not set in the orchestrator's environment.

**Solution:**

```bash
# Enable and start the Podman socket service
systemctl --user enable --now podman.socket

# Verify socket exists
ls -l $XDG_RUNTIME_DIR/podman/podman.sock

# Ensure XDG_RUNTIME_DIR is set in orchestrator environment
echo $XDG_RUNTIME_DIR  # Should output something like /run/user/1000
```

Alternatively, use `socketPath` to point directly to the socket:

```yaml
scalers:
  - name: podman-agents
    type: container
    socketPath: /run/user/1000/podman/podman.sock
    maxAgents: 10
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

### Orphaned containers

**Symptom:** `docker ps` or `podman ps` shows old `kici-managed` containers after orchestrator restart.

**Cause:** Orchestrator crashed (SIGKILL) or was stopped before graceful shutdown completed.

**Solution:** The container backend automatically cleans up orphaned containers on startup. It queries for containers with the `kici-managed=true` label and removes them. Check orchestrator startup logs for `Cleaned up N orphaned containers`.

If manual cleanup is needed:

```bash
# Docker
docker ps -a --filter "label=kici-managed=true" --format "{{.ID}}" | xargs docker rm -f

# Podman
podman ps -a --filter "label=kici-managed=true" --format "{{.ID}}" | xargs podman rm -f
```

### Spawn timeouts

**Symptom:** Agent spawns take very long (>60s).

**Cause:** Container image pull on first use. Large images can take minutes to download.

**Solution:** Use warm pools to pre-pull images. Or use a local registry mirror to reduce pull times. The scaler does not time out during spawns -- it lets the container runtime handle the pull.

### Container socket permission errors

**Symptom:** Agent container fails to access the container runtime with `permission denied` errors.

**Cause:** `containerSocket: false` (default) or the container user does not have permission to access the socket.

**Solution:** Set `containerSocket: true` in the label set config. Ensure you understand the security implications (see [Container socket sharing — security warning](#container-socket-sharing--security-warning) above).

## Examples

### Simple: auto-detection (default)

```yaml
# Auto-detects Docker or Podman -- no runtime configuration needed
version: 1
globalMaxAgents: 10

scalers:
  - name: auto-agents
    type: container
    # runtime defaults to 'auto' -- detects Docker or Podman
    maxAgents: 10
    labelSets:
      - labels: [linux, container]
        image: kici/agent:latest
```

### Podman-specific configuration

```yaml
# Force Podman with explicit rootless socket
version: 1
globalMaxAgents: 5

scalers:
  - name: podman-agents
    type: container
    runtime: podman
    socketPath: /run/user/1000/podman/podman.sock
    maxAgents: 5
    labelSets:
      - labels: [linux, container]
        image: kici/agent:latest
```

### Single container scaler with two label sets

```yaml
version: 1
globalMaxAgents: 20

scalers:
  - name: container-linux
    type: container
    maxAgents: 20
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
        resources:
          memory: '2g'
          cpus: 2
      - labels: ['linux', 'node20']
        image: 'ghcr.io/myorg/kici-agent-node20:latest'
        resources:
          memory: '4g'
          cpus: 2
```
