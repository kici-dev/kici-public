---
title: Agent execution security
description: ''
---

This document explains the security model for KiCI agent execution isolation and provides configuration guidance for each backend.

## Overview

KiCI agents execute customer workflow code in **isolated sandbox processes**, never in the agent's own V8 isolate. This means:

- Customer code cannot access agent-internal credentials (orchestrator URL, API keys, database connections)
- Customer code cannot interfere with the agent process itself
- The agent process only handles job orchestration, IPC, and log forwarding

The isolation boundary is enforced through the `ExecutionSandbox` interface, which all three backends implement: **container**, **bare-metal**, and **Firecracker**.

> **Note:** This document covers agent **execution** security (sandbox isolation for customer code). For orchestrator-agent **connection** security (WS authentication, agent registration trust), the orchestrator requires agent token authentication by default (`KICI_AGENT_AUTH=token`). Agents authenticate using `kat_*` bearer tokens stored as SHA-256 hashes in the orchestrator database. See [Orchestrator Configuration](../../architecture/configuration.md#agent-authentication) for setup details.

## Process identity per backend

The user identity that spawned processes run as depends on the scaler backend. This is critical for understanding the blast radius of a compromised workflow.

| Backend                | Orchestrator runs as                         | Spawned agent/workflow runs as                                                                                             | Privilege drop?                                                  |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Container**          | Any user with container socket access        | Container image's default user (typically `root` inside container, isolated by namespaces)                                 | Container runtime handles isolation                              |
| **Bare-metal**         | Any user                                     | **Same user as orchestrator** (no privilege dropping)                                                                      | No — no setuid, no su, no sudo                                   |
| **Bare-metal + bwrap** | Any user                                     | **Same user as orchestrator**, but namespace-isolated (PID, IPC, filesystem, network)                                      | Partial — bwrap adds namespace isolation but does not change UID |
| **Firecracker**        | Must be root (TAP device, bridge management) | Jailer drops to configured `uid:gid` before exec'ing Firecracker; inside VM, agent runs as the rootfs image's default user | Yes — jailer enforces privilege drop                             |

### Implications of running the orchestrator as root

- **Container backend:** Low risk. The container runtime already provides process/filesystem/network isolation. The orchestrator user identity doesn't propagate into containers.
- **Bare-metal backend (no bwrap):** **High risk.** Spawned agent processes inherit root privileges. Customer workflow code runs as root with full host filesystem and network access. Only acceptable for fully trusted, internal-only workflows.
- **Bare-metal backend (with bwrap):** **Medium risk.** bwrap provides namespace isolation (PID, IPC, filesystem read-only mounts, network loopback-only), but the process UID is still root inside the namespace. A bwrap escape would give root on the host.
- **Firecracker backend:** **Expected.** Root is required for TAP device and bridge management. The jailer drops privileges to the configured `uid:gid` before running Firecracker, so the VM process itself does not run as root.

### Recommendations

- **Never run bare-metal scaler as root** for untrusted workloads. Use a dedicated service account with minimal privileges.
- **Always enable bwrap** for bare-metal if the orchestrator runs as any user with elevated privileges.
- **Firecracker requires root** — this is by design and safe due to jailer privilege dropping.
- **Container backend** is safe regardless of orchestrator user, since containers provide their own isolation boundary.

## Confined root agents

Some workloads need a **persistent agent that runs as root** — for example a deploy agent that installs packages, writes system service units, and restarts services on the host. An agent that can run arbitrary workflow steps as root is root by construction, so the right place to confine it is **which jobs may reach it**, not what it may do once it accepts a job.

KiCI confines a root agent with a **mandatory-label taint** (a Kubernetes-taint-style gate). A tainted agent only accepts a job when the job's `runsOn` explicitly demands every label in the taint. So an ordinary CI workflow can never accidentally land on a root host — only a job that deliberately asks for `kici:privileged:root` (and clears the environment-protection and approval gates in front of it) is dispatched there.

### Minting a confined root token

The taint is **token-bound**: it is the operator's grant, anchored to the token they mint, not something the agent self-declares. Create the token with `--privileged-root`:

```bash
kici-admin agent register --privileged-root
```

This authorizes the agent to advertise `kici:privileged:root` (so root-demanding jobs route to it) **and** taints it with the same label (so it refuses every job that does not demand root). Set the resulting token as `KICI_AGENT_TOKEN` on the root agent (installed with `kici-admin agent install --system`).

For arbitrary taints (GPU pools, tenant-pinned agents), use the general, repeatable form — each label is unioned into both the authorized labels and the taint:

```bash
kici-admin agent register --mandatory-label kici:pool:gpu --mandatory-label kici:tenant:acme
```

A bare `kici-admin agent install --system` root agent stays **un-tainted** and accepts every job its labels match — the taint is strictly opt-in, so the trusted single-tenant "one root agent runs everything" case is unchanged.

### Fail-closed uid verification

The `kici:privileged:root` selector must be honest: a root-demanding job must never land on a non-root agent. At registration the orchestrator verifies that an agent presenting `kici:privileged:root` is actually running as uid 0. If it is not — or if it does not report its uid at all — the registration is **refused** (the connection is closed and the rejection is logged), rather than silently demoting the agent.

This catches honest misconfiguration. It is **not** a defense against an agent that lies about its uid: such an agent already holds an operator-minted privileged token and is inside the trust boundary by construction. The real confinement of _which_ jobs may demand root lives one level up, at dispatch authorization — environment protection plus the approval chain gate every job that would run as root.

## Isolation model per backend

### Container backend (strongest for standard workloads)

The container backend provides the strongest practical isolation for most deployments.

**Architecture:**

- Agent runs on the host (or in its own container)
- Each job gets a disposable Docker/Podman container
- The entire job lifecycle (git clone, dependency install, compile, step execution) runs inside the container
- Agent credentials never enter the container environment
- Container is torn down after each job

**Security properties:**

- Full filesystem isolation (container rootfs)
- Network isolation (container networking)
- Process isolation (container PID namespace)
- Environment isolation (sanitized env only, no KICI\_\* variables)
- Resource limits via container runtime (CPU, memory, disk)

**When to use:** Most deployments. Recommended for untrusted or semi-trusted workloads where you need strong isolation without the overhead of microVMs.

### Bare-metal backend (trusted environments only)

The bare-metal backend provides process-level isolation with sanitized environment. It is suitable for **trusted environments only** where you control all workflow code.

**Architecture:**

- Agent runs on the host
- Workflow runner is forked as a child process using Node.js `child_process.fork()`
- The child process receives a sanitized environment (only allowlisted system variables + user-defined env + secrets)
- Optional bubblewrap (bwrap) adds PID/IPC/filesystem namespace isolation

**Security properties (without bwrap):**

- Environment isolation only (KICI\_\* and agent credentials excluded)
- No filesystem isolation (child process has full host access)
- No network isolation
- No resource limits (CPU/memory not enforced by KiCI — use OS-level cgroups or ulimit if needed)
- No PID/IPC namespace isolation

**Security properties (with bwrap):**

- Environment isolation (same as above)
- PID and IPC namespace isolation
- Network isolation via `--unshare-net` (loopback only, no external connectivity)
- Read-only system mounts (/usr, /lib, /bin, /etc/ssl)
- Writable workspace bind mount only
- Private /tmp, /dev, /proc
- Die-with-parent and new-session for process lifecycle safety

**When to use:** Development environments, internal CI where you trust all workflow authors, or when container overhead is unacceptable. Always enable bwrap for any environment with multiple users.

### Firecracker backend (strongest for untrusted workloads)

The Firecracker backend provides VM-level isolation combined with defense-in-depth child process isolation.

**Architecture:**

- Each job runs inside a dedicated Firecracker microVM (separate kernel, rootfs, network)
- Inside the VM, the agent forks the workflow runner with sanitized environment
- The sandbox prevents customer code from accessing MMDS metadata (orchestrator URL, agent config)
- VM lifecycle is managed by the Firecracker scaler backend

**Security properties:**

- Full VM isolation (separate kernel, memory, disk)
- Network isolation (VM-level networking with NAT)
- Environment isolation inside the VM (defense-in-depth)
- MMDS metadata not accessible to customer code
- Complete teardown after each job (fresh rootfs per VM)

**When to use:** Public CI services, running untrusted code from external contributors, maximum security requirements.

## Safety mechanisms comparison

| Mechanism                | Container                                                 | Bare-metal                               | Bare-metal + bwrap                               | Firecracker                                     |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| **Process isolation**    | PID namespace (container)                                 | None                                     | PID namespace (bwrap)                            | VM PID namespace                                |
| **Filesystem isolation** | Container rootfs                                          | None                                     | Read-only system mounts, writable workspace only | VM ext4 rootfs (full copy per job)              |
| **Network isolation**    | Bridge network + nftables RFC1918 blocking (default: on)  | None                                     | Loopback only (`--unshare-net`)                  | TAP device + nftables RFC1918 blocking          |
| **Resource limits**      | CPU (NanoCpus) + memory (cgroups) via `resources:` config | None (use OS-level cgroups/ulimit)       | None (use OS-level cgroups/ulimit)               | vCPU count + memory (MiB) per VM                |
| **Credential isolation** | Environment allowlist; KICI\_\* excluded                  | Environment allowlist; KICI\_\* excluded | Environment allowlist; KICI\_\* excluded         | Environment allowlist + MMDS cleared after boot |
| **Secret delivery**      | IPC (never in env)                                        | IPC (never in env)                       | IPC (never in env)                               | IPC (never in env)                              |
| **Process lifecycle**    | Container auto-remove                                     | Detached process group; SIGTERM→SIGKILL  | `--die-with-parent`, `--new-session`             | Jailer + VM teardown                            |
| **Privilege dropping**   | Container runtime handles user context                    | None                                     | None (UID unchanged, but namespace-isolated)     | Jailer drops to configured `uid:gid`            |

## Environment variables

### What enters the sandbox

The sandbox environment is constructed from a 7-layer merge (later overrides earlier):

1. **System allowlist** -- Only these host variables are copied:
   - `PATH` -- Required for command execution
   - `HOME` -- User home directory
   - `USER` -- Current user name
   - `SHELL` -- User's shell
   - `LANG` -- Locale setting
   - `LC_ALL` -- Locale override
   - `TERM` -- Terminal type
   - `TMPDIR` -- Temporary directory path
   - `NODE_PATH` -- Node.js module resolution
   - `TZ` -- Timezone

2. **Sandbox defaults** -- `FORCE_COLOR=1` and similar defaults to ensure correct tool behavior in non-TTY environments

3. **KICI\_\* system vars** -- Orchestrator-generated variables passed via `userEnv`

4. **Org-level environment vars** -- Variables from the environment configuration (pre-merged by the orchestrator)

5. **Source-level environment overrides** -- Per-source overrides merged into the environment vars by the orchestrator

6. **Job env** -- SDK-defined `env` field from the lock file, evaluated by the orchestrator

7. **setEnv() calls** -- Runtime calls from step code (applied at step execution time, not during env construction)

**Note:** Secrets are NOT injected into environment variables. They flow through IPC to `ctx.secrets` and are only exposed to the process environment when the workflow author explicitly calls `ctx.secrets.expose()`.

### What is excluded

The following categories are **never** passed to the sandbox:

- `KICI_*` -- All agent-internal variables (KICI_ORCHESTRATOR_URL, KICI_AGENT_ID, KICI_LABELS, etc.)
- `KICI_DATABASE_URL` -- Agent/orchestrator database connection strings
- `KICI_PLATFORM_TOKEN` -- Platform relay authentication tokens
- Any variable **not** in the system allowlist above

This is an explicit allowlist approach: adding new environment variables to the host agent will **not** leak them to customer code.

### KICI_AGENT_ENV\_ prefix forwarding

Operators can forward custom environment variables from the orchestrator to spawned agents using the `KICI_AGENT_ENV_` prefix. The orchestrator strips the prefix before passing the variable to the agent:

```bash
# On the orchestrator host
export KICI_AGENT_ENV_HTTP_PROXY=http://proxy:3128
export KICI_AGENT_ENV_NO_PROXY=localhost,.internal
export KICI_AGENT_ENV_CUSTOM_FLAG=enabled
```

The agent receives:

- `HTTP_PROXY=http://proxy:3128`
- `NO_PROXY=localhost,.internal`
- `CUSTOM_FLAG=enabled`

This mechanism is useful for passing proxy settings, custom flags, or other operator-controlled values to agents without modifying the scaler config file. Variables forwarded via `KICI_AGENT_ENV_` have lower precedence than `env:` entries in `scalers.yaml` -- if both define the same variable, the `scalers.yaml` value wins.

**Backend support:**

| Backend     | KICI_AGENT_ENV\_ support | Notes                                                                                                                                 |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bare-metal  | Yes                      | Prefix stripped, passed to process                                                                                                    |
| Container   | Yes                      | Prefix stripped, passed to container env                                                                                              |
| Firecracker | Yes                      | Prefix stripped, passed via MMDS (per-key under `meta-data/kici-env/`); per-VM ≤32 KiB total budget enforced on the orchestrator side |

### Per-backend environment variable sources

The following table shows which environment variable sources are passed to agents on each backend:

| Source                        | Bare-metal                              | Container                         | Firecracker                               |
| ----------------------------- | --------------------------------------- | --------------------------------- | ----------------------------------------- |
| System vars (PATH, HOME, ...) | Allowlist from orchestrator process.env | Not inherited (container has own) | Not inherited (VM has own)                |
| KICI\_\* agent vars           | Explicit values                         | Explicit values                   | Via MMDS + register.ack                   |
| KICI_AGENT_ENV\_ forwarded    | Yes (prefix stripped)                   | Yes (prefix stripped)             | Yes (prefix stripped, via MMDS, ≤32 KiB)  |
| scalers.yaml `env:`           | Yes (highest priority)                  | Yes (highest priority)            | Yes (highest priority, via MMDS, ≤32 KiB) |
| Orchestrator secrets          | Never passed                            | Never passed                      | Never passed                              |

### Bare-metal trust model

The bare-metal backend runs agent processes directly on the host. At startup, the orchestrator logs a warning when a bare-metal scaler is configured:

```
WARN: Bare-metal scaler "gpu-machines" configured. Bare-metal agents run as child processes
with full host filesystem and network access. This mode is intended for trusted environments only.
WARN: Consider enabling bubblewrap (bwrap) for process isolation. See docs/operator/agent-security.md
```

The bare-metal backend provides environment isolation (credentials are not leaked to agents) but **does not** provide filesystem or network isolation without bubblewrap. Only use bare-metal for environments where you trust all workflow code.

### Passing custom variables to workflows

To make custom environment variables available to workflow steps:

1. **Workflow-level env** -- Define in the workflow file (`.kici/workflows/*.ts`)
2. **Orchestrator-provided env** -- Set via job dispatch configuration
3. **KICI_AGENT_ENV\_ prefix** -- Set on the orchestrator host for operator-controlled variables
4. **Secrets** -- Pass via the secrets mechanism for sensitive values

## Container image requirements

When using the container backend, the container image must have:

- **Node.js** installed (v24 or later recommended)
- **git** installed (for repository cloning)
- Standard POSIX utilities (sh, mkdir, rm, etc.)

The workflow runner script is bind-mounted read-only into the container at `/opt/kici/workflow-runner.js` -- it does not need to be baked into the image.

Recommended base images:

- `node:24-alpine` -- Lightweight, includes Node.js and git
- `node:24-slim` -- Debian-based, smaller than full image

## Bubblewrap (Bare-Metal)

### Enabling bubblewrap

Bubblewrap isolation for bare-metal execution is opt-in via the `KICI_SANDBOX` environment variable:

```bash
KICI_SANDBOX=true
```

When set, the agent wraps every workflow runner fork in `bwrap` with the namespaces and mounts described below. Ensure `bwrap` is installed on the host (see system requirements). The default is `false` — the bare-metal sandbox runs workflow code as a plain forked Node.js process with only environment sanitization.

The orchestrator validates `bwrap` availability at **startup** when `KICI_AGENT_ENV_KICI_SANDBOX=true` is set: if the binary is missing the orchestrator exits with a clear error rather than failing every job at dispatch time. `bwrap` is **Linux only** — there is no equivalent on macOS or Windows, so the option is rejected on those platforms.

#### Network mode

`KICI_SANDBOX_NETWORK` controls the network namespace when bwrap is enabled:

| Value      | Behavior                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isolated` | Default. `bwrap --unshare-net` — loopback only, no external connectivity. Strongest isolation; breaks workflows that need to reach package registries (npm, pip, cargo, etc.). |
| `host`     | Keep the host network namespace. Workflows can talk to the network. Use this when workflows need `npm install`, `git clone https://`, or other outbound traffic.               |

```bash
# Strongest: PID/IPC/filesystem isolation AND no network
KICI_SANDBOX=true
KICI_SANDBOX_NETWORK=isolated   # default

# Host network: PID/IPC/filesystem isolation, network unrestricted
KICI_SANDBOX=true
KICI_SANDBOX_NETWORK=host
```

### System requirements

Install bubblewrap and (optionally) slirp4netns:

```bash
# Debian/Ubuntu
apt install bubblewrap

# Fedora/RHEL
dnf install bubblewrap

# Optional: for network namespace isolation (not currently enabled)
apt install slirp4netns
```

### What bubblewrap provides

- **PID namespace** (`--unshare-pid`) -- Workflow runner cannot see or signal other host processes
- **IPC namespace** (`--unshare-ipc`) -- Shared memory isolation between the runner and host
- **Filesystem isolation** -- System directories mounted read-only, only workspace is writable
- **Process lifecycle safety** -- `--die-with-parent` ensures child dies if agent crashes, `--new-session` prevents terminal signal propagation

### What bubblewrap does NOT provide

- **Resource limits** -- CPU/memory limits are not enforced by bwrap. Use cgroups or container runtime for resource control.

> **Note:** Network isolation via `--unshare-net` is now enabled by default when bwrap is active. Customer workflow code has no external network access (loopback only). This is intentionally strict -- bare-metal is for trusted environments.

### Filesystem mount details

| Host Path          | Container Path   | Mode            |
| ------------------ | ---------------- | --------------- |
| /usr               | /usr             | read-only       |
| /lib               | /lib             | read-only       |
| /lib64 (if exists) | /lib64           | read-only       |
| /bin               | /bin             | read-only       |
| /sbin              | /sbin            | read-only       |
| /etc/resolv.conf   | /etc/resolv.conf | read-only       |
| /etc/ssl           | /etc/ssl         | read-only       |
| Node.js binary dir | (same path)      | read-only       |
| Workspace          | /workspace       | read-write      |
| (new)              | /dev             | private         |
| (new)              | /proc            | private         |
| (new)              | /tmp             | private (tmpfs) |

## Execution mode selection

The agent selects the sandbox backend using this priority:

1. **Container config** in job dispatch -- If the job includes container configuration, uses ContainerSandbox
2. **KICI_EXECUTION_MODE** env var -- Explicit backend selection (`container`, `bare-metal`, `firecracker`)
3. **KICI_SCALER_MANAGED=1** detection -- Agents managed by the Firecracker scaler use FirecrackerSandbox
4. **Default** -- Falls back to BareMetalSandbox (sandbox=false)

Set `KICI_EXECUTION_MODE` in the agent's environment to override automatic detection:

```bash
# Force container mode
export KICI_EXECUTION_MODE=container

# Force bare-metal with bwrap (requires bubblewrap installed)
export KICI_EXECUTION_MODE=bare-metal

# Force Firecracker mode (only inside Firecracker VMs)
export KICI_EXECUTION_MODE=firecracker
```
