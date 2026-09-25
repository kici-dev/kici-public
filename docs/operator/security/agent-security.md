---
title: Agent execution security
description: The agent execution isolation model and per-backend sandbox configuration guidance
---

This document explains the security model for KiCI agent execution isolation and provides configuration guidance for each backend.

## Overview

KiCI agents execute customer workflow code in **isolated sandbox processes**, never in the agent's own V8 isolate. This means:

- Customer code cannot access agent-internal credentials (orchestrator URL, API keys, database connections)
- Customer code cannot interfere with the agent process itself
- The agent process only handles job orchestration, IPC, and log forwarding

The isolation boundary is enforced through the `ExecutionSandbox` interface, which all three backends implement: **container**, **bare-metal**, and **Firecracker**.

> **Note:** This document covers agent **execution** security (sandbox isolation for customer code). For orchestrator-agent **connection** security (WS authentication, agent registration trust), the orchestrator requires agent token authentication by default (`KICI_AGENT_AUTH=token`). Agents authenticate using `kat_*` bearer tokens stored as SHA-256 hashes in the orchestrator database. See [orchestrator configuration](../orchestrator/configuration.md#environment-variable-reference-orchestrator-specific) for setup details.

## Process identity per backend

The user identity that spawned processes run as depends on the scaler backend. This is critical for understanding the blast radius of a compromised workflow.

| Backend                | Orchestrator runs as                         | Spawned agent/workflow runs as                                                                                                                                                               | Privilege drop?                                                                                                                |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Container**          | Any user with container socket access        | Container image's default user (typically `root` inside the agent container). A job that declares its own image runs in a nested container with all capabilities dropped + no-new-privileges | Container runtime isolation; the cap-drop is applied to the nested job container, not the agent container that hosts the steps |
| **Bare-metal**         | Any user                                     | Process mode: **same user as orchestrator** (no privilege dropping). Container mode: the image's default user inside the agent container                                                     | Process mode: no. Container mode: container-runtime isolation plus a pid ceiling                                               |
| **Bare-metal + bwrap** | Any user                                     | **Same user as orchestrator**, but namespace-isolated (PID, IPC, filesystem, network)                                                                                                        | Partial — bwrap adds namespace isolation but does not change UID                                                               |
| **Firecracker**        | Must be root (TAP device, bridge management) | Jailer drops to configured `uid:gid` before exec'ing Firecracker; inside VM, agent runs as the rootfs image's default user                                                                   | Yes — jailer enforces privilege drop                                                                                           |

### Implications of running the orchestrator as root

- **Container backend:** Low risk. The container runtime provides process/filesystem/network isolation, and each **nested job container** additionally drops all Linux capabilities, sets no-new-privileges, and enforces pids/memory/CPU cgroup caps by default. The agent container that hosts the steps keeps the default capability set, because the steps themselves run in it — `apt-get`, `chown` and `sudo` would otherwise fail. The orchestrator user identity doesn't propagate into containers.
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
- The agent clones the repository on the host and copies the tree in, so clone credentials stay on the host
- Every workflow step runs inside the container. The job's own `.kici/` dependency install runs on the host only for an allowlisted npm or pnpm project, outside the checkout, with lifecycle scripts, hooks and git dependencies disabled. It contacts only the registries the operator allows (`KICI_HOST_INSTALL_REGISTRIES`); otherwise it runs inside the container too (see [Where `.kici/` dependencies install](../agent/configuration.md#where-kici-dependencies-install))
- The `__build__`, `__init__`, `__dynamic__` and `__globaleval__` jobs are not container jobs. An agent with the `builder` and `init-runner` roles, the default when `KICI_ROLES` is unset, runs them on its host. They install `.kici/` there with the project's own package manager, and all of them except `__build__` also import the workflow module there. Set `KICI_ROLES=` on the agents that run container jobs to keep that work on dedicated agents (see [Agent roles](../agent/configuration.md#agent-roles))
- Agent credentials never enter the container environment
- Container is torn down after each job

**Security properties:**

- Full filesystem isolation (container rootfs)
- Network isolation (container networking)
- Process isolation (container PID namespace)
- Environment isolation (sanitized env only, no KICI\_\* variables)

**Hardened by default.** Every per-job container is created with a secure-by-default posture (matching the bwrap backend's capability/privilege stance and exceeding it with cgroup caps):

| Protection           | Default                                           | Knob                                    |
| -------------------- | ------------------------------------------------- | --------------------------------------- |
| Linux capabilities   | all dropped (`CapDrop: ALL`, no add-back)         | per-job `sandbox:` escape hatch (below) |
| Privilege escalation | blocked (`no-new-privileges`)                     | —                                       |
| PID / fork-bomb DoS  | `KICI_SANDBOX_PIDS_LIMIT` (512)                   | raise the env value                     |
| Memory DoS           | `KICI_SANDBOX_MEMORY_BYTES` (2 GiB)               | raise the env value                     |
| CPU DoS              | `KICI_SANDBOX_NANO_CPUS` (2 CPUs)                 | raise the env value                     |
| Writable /tmp        | private tmpfs mounted at `/tmp`                   | —                                       |
| Read-only rootfs     | off (many images write outside `/workspace`)      | `KICI_SANDBOX_READONLY_ROOTFS=true`     |
| Container user       | image's configured user, never silently rewritten | `KICI_SANDBOX_USER=<uid[:gid]\|name>`   |

A job container joins the agent's own `kici-jobs` bridge network, where the agent applies the same nftables drops the scaler applies to agent containers: RFC1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and the cloud metadata range (169.254.0.0/16). The drops are keyed on the whole `kici-jobs` subnet. They land when the agent prepares that network, before it creates any job container, so a job image's own `ENTRYPOINT` never runs outside them. Outbound internet egress works, so package installs and registry access are unaffected by the defaults above.

The agent also rules what a job container reaches **on the agent's own host**, which is a separate filter. A packet addressed to one of the host's addresses arrives on the input hook and never crosses the forwarding path the drops above filter, so the two need separate rules. A job container reaches DNS on the bridge gateway and no other host service. It talks to its agent through the container runtime, not over the network, and it holds none of the agent's credentials. A service you run beside the agent, and that your workflow steps reached before, is no longer reachable from inside a job container. Move it off the agent host, or run those steps outside a `container:` job. The rules need `NET_ADMIN` and a working `nft`: without them the agent logs a warning at job start and the container falls back to the runtime's default bridge with **unfiltered** egress. A host that cannot install the drops does not get the bridge either — no job container joins a network whose filtering is missing. `KICI_SANDBOX_NETWORK_ISOLATION=false` turns the filtering off deliberately. Set `KICI_SANDBOX_NETWORK=host` to run each job container on the host network namespace instead. That bypasses the filtering by construction: asking for the host namespace is asking for the host's network. The agent then also binds the host's `/etc/hosts` (and `/etc/nsswitch.conf`) read-only into the container so a host-resolved-only registry name is reachable inside the job. A local `file://` clone source is always bound into the container read-only so the in-container clone can read it.

`KICI_SANDBOX_HARDENED=false` is a documented-temporary rollback affordance that reproduces the legacy unhardened posture across every job on that agent. It also takes the job container off the `kici-jobs` bridge, so the container keeps the runtime's default bridge and its egress is **unfiltered** — even with `KICI_SANDBOX_NETWORK_ISOLATION` left on. Prefer the per-job `sandbox:` escape hatch below when a specific workflow needs one dropped capability — it re-grants exactly that capability for exactly that job, leaving every other job fully hardened. Raise the resource caps for heavy builds rather than disabling hardening wholesale.

#### Per-job escape hatch (`sandbox:`)

A workflow job can request extra Linux capabilities or a different network posture for its container via the SDK `sandbox:` field:

```ts
job('build', {
  runsOn: 'kici:os:linux',
  container: 'node:20',
  sandbox: {
    capabilities: ['NET_ADMIN'], // added back on top of CapDrop: ALL
    network: 'host', // share the host network namespace
  },
  steps: [/* ... */],
});
```

The **orchestrator is the single enforcement point.** At dispatch it resolves each request against a per-org allow-list you control, so a workflow author can never escalate beyond what you approved:

- **`sandboxAllowedCapabilities`** — the capabilities a job may request. Empty by default, so **every** capability request is denied until you allow-list it.
- **`sandboxAllowHostNetwork`** — whether a job may request `network: 'host'`. `false` by default. (`network: 'none'` and the default bridge never need approval — they do not escalate.)

Manage both with the orchestrator admin CLI:

```bash
# Allow NET_ADMIN (and SYS_PTRACE) for jobs in this org:
kici-admin org-settings sandbox-allowlist set-capabilities NET_ADMIN,SYS_PTRACE --org <org>
# Permit host networking:
kici-admin org-settings sandbox-allowlist allow-host-network true --org <org>
# Inspect the current allow-list:
kici-admin org-settings sandbox-allowlist show --org <org>
# Clear it back to the safe deny-all default:
kici-admin org-settings sandbox-allowlist reset --org <org>
```

**Deny is loud and total.** A request for a capability (or host networking) that is not allow-listed **fails the run at dispatch** with a reason naming the offending capability and the knob that gates it — the job never runs, and a disallowed capability is never silently stripped. The agent applies only the grant the orchestrator resolved and never reads the allow-list itself. Grants are strictly additive: a job with no `sandbox:` request keeps the fully hardened default (all capabilities dropped). `privileged` mode and workflow-requested resource limits are deliberately not offered.

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

| Mechanism                | Container                                                                                                                                                                                                                                                                                                                                       | Bare-metal                                                                                                                                                         | Bare-metal + bwrap                                                              | Firecracker                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Process isolation**    | PID namespace (container)                                                                                                                                                                                                                                                                                                                       | None                                                                                                                                                               | PID namespace (bwrap)                                                           | VM PID namespace                                                                                                                                                                      |
| **Filesystem isolation** | Container rootfs                                                                                                                                                                                                                                                                                                                                | None                                                                                                                                                               | Read-only system mounts, writable workspace only                                | VM ext4 rootfs (full copy per job)                                                                                                                                                    |
| **Network isolation**    | `kici-jobs` bridge + nftables RFC1918 and metadata blocking, plus a host-access filter that leaves DNS on the bridge gateway as the only reachable host service (default: on; needs `NET_ADMIN`, otherwise warns and falls back to unfiltered egress). `KICI_SANDBOX_NETWORK=host` and a per-job `sandbox: { network: 'host' }` grant bypass it | None in process mode. In container mode the agent container joins the isolated agent network and gets the same per-address nftables rules as the container backend | Loopback only (`--unshare-net`)                                                 | Per-VM TAP with bridge port isolation (no VM-to-VM traffic) + per-VM nftables rules blocking RFC1918 and cloud metadata, ahead of the host baseline, plus the same host-access filter |
| **Resource limits**      | CPU (NanoCpus) + memory (cgroups) via `resources:` config, plus a 4096-process ceiling on the agent container                                                                                                                                                                                                                                   | Process mode: cgroups when `enforceCgroups` is on, otherwise advisory. Container mode: the same CPU, memory and process ceilings as the container backend          | None (use OS-level cgroups/ulimit)                                              | vCPU count + memory (MiB) per VM                                                                                                                                                      |
| **Credential isolation** | Environment allowlist (KICI\_\* excluded from the child) + the agent's own credentials removed from its environment after boot                                                                                                                                                                                                                  | Same, **but the child shares the agent's uid** unless `KICI_RUNNER_USER` is set — see the note below                                                               | Same; the namespace hides the agent's pid, and the uid still matches outside it | Environment allowlist + MMDS cleared after boot                                                                                                                                       |
| **Secret delivery**      | IPC (never in env)                                                                                                                                                                                                                                                                                                                              | IPC (never in env)                                                                                                                                                 | IPC (never in env)                                                              | IPC (never in env)                                                                                                                                                                    |
| **Process lifecycle**    | Container auto-remove                                                                                                                                                                                                                                                                                                                           | Detached process group; SIGTERM→SIGKILL                                                                                                                            | `--die-with-parent`, `--new-session`                                            | Jailer + VM teardown                                                                                                                                                                  |
| **Privilege dropping**   | Container runtime handles user context                                                                                                                                                                                                                                                                                                          | `KICI_RUNNER_USER=<uid[:gid]\|name>` (opt-in)                                                                                                                      | `KICI_RUNNER_USER` (opt-in); otherwise UID unchanged, namespace-isolated        | Jailer drops to configured `uid:gid`                                                                                                                                                  |

### The bare-metal credential boundary

On the default bare-metal backend the runner child is a plain `fork()`: it runs
as the agent's own user, and so does every step subprocess under it. The
environment allowlist keeps the agent's credentials out of the child's `env`.
A process running as the same uid can still read the agent process. That is why
the _Credential isolation_ row above names the uid rather than claiming a
boundary the posture does not have.

Two things narrow it:

- The agent **removes `KICI_AGENT_TOKEN`, `KICI_SCALER_CLAIM_CODE` and
  `KICI_GITHUB_TOKEN` from its own `process.env`** once it has read them, on
  every platform and every backend. That closes the easiest read
  (`/proc/<agent-pid>/environ`). It is defence in depth, not isolation: a
  same-uid `ptrace` or `/proc/<pid>/mem` read still reaches the values the
  running agent holds.
- **`KICI_RUNNER_USER`** gives the runner child a dedicated uid, which is the
  actual boundary. It is opt-in because it needs an operator-provisioned
  account; the agent logs one warning at start when neither it nor a namespace
  nor a container is in force.

`KICI_ORCHESTRATOR_URL` is deliberately not removed: it is a URL, not a
credential, and both the agent and the runner child read it.

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

   On Windows the allowlist additionally copies the system variables the OS
   itself needs to run a command: `PATHEXT` (without it the OS cannot resolve a
   bare command name such as `jq` to its `.exe`), `SystemRoot`, `windir`,
   `COMSPEC`, `TEMP`, `TMP`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`,
   `PROCESSOR_ARCHITECTURE`, and `NUMBER_OF_PROCESSORS`. None of them carry
   credentials -- the allowlist's job is to keep `KICI_*`, `DATABASE_URL`, and
   `PLATFORM_TOKEN` out, and these are none of those. They are copied on every
   platform where the host sets them; on Linux and macOS the host normally does
   not.

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

This is an explicit allowlist approach: adding new environment variables to the host agent will **not** leak them to customer code. The one deliberate exception is the trusted fleet-agent profile below, which an operator opts into per agent — and even then the agent's own KiCI identity secrets are always scrubbed.

### Trusted fleet-agent profile (`KICI_TRUSTED_ENV`)

Some workloads are the operator's **own** host-configuration or fleet jobs — a deploy agent that runs `sops`, `ssh`, `aws`, and `systemctl` against the host — and legitimately need the operator's ambient host environment (their sops age key, SSH agent socket, cloud credentials). For those, an agent can be launched with the **trusted execution profile**:

```bash
# On the trusted fleet agent (or the scaler label set that spawns it)
KICI_TRUSTED_ENV=true
```

When enabled, the step sandbox passes the **ambient host environment through** to workflow steps instead of restricting to the system-variable allowlist — **minus** the agent's own KiCI identity and operational secrets. Specifically, the whole `KICI_*` namespace (orchestrator URL, agent token, secret key, bootstrap admin token, scaler internals) plus a small non-`KICI_` infrastructure denylist (`DATABASE_URL`, `PLATFORM_TOKEN`, `WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY`) are **always** scrubbed. So "trusted" means _host env yes, the agent's KiCI identity no_ — a trusted step can use the operator's ambient credentials but still cannot impersonate the agent or exfiltrate its join token.

`KICI_TRUSTED_ENV` is **orthogonal** to `KICI_SANDBOX` (bubblewrap namespace isolation): the canonical fleet / host-configuration agent runs with bubblewrap off (full filesystem and network) **and** trusted-env on (full host env), launched as the operator. The two remain independent flags.

**Trust model.** A trusted-env agent runs workflow steps — including any third-party actions they pull — with the operator's full host environment (and, if launched as root, root). This is the Ansible-playbook trust model: you trust the workflows you route to a host-configuration agent. Enable it **per agent**, and route only trusted workflows there.

**The gate is agent-launch-only.** `KICI_TRUSTED_ENV` is read exclusively from the agent's own configuration (or the scaler label set that spawns it). It is **never** derivable from a dispatch payload, a workflow definition, or a trigger — a workflow cannot _request_ trusted-env; it can only be **routed** (by labels) to an agent the operator already configured as trusted. The scaler forwards and validates the trusted decision when it spawns the agent and logs it explicitly. A trigger or workflow can never elevate itself to the trusted profile.

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

### Isolation and containment options

| Variable                         | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_RUNNER_USER`               | unset   | Run the bare-metal runner child under a dedicated uid (`uid`, `uid:gid`, or a user name), instead of the agent's own. The job workdir is chowned to it before the child starts. An unresolvable value fails the job rather than silently falling back.                                                                                                                                                                                                                                                                                |
| `KICI_SANDBOX_NETWORK_ISOLATION` | `true`  | Apply the nftables filtering to nested job containers: RFC1918 and cloud-metadata drops on what they reach through the host, and a host-access filter that leaves DNS on the bridge gateway as the only reachable host service. Needs `NET_ADMIN` and `nft`; without them the agent warns and the container keeps unfiltered egress.                                                                                                                                                                                                  |
| `KICI_ALLOW_INSTALL_SCRIPTS`     | `false` | Re-enable package lifecycle scripts during the `.kici/` dependency install. Off by default on every package manager, because a `postinstall` in a committed `package.json` is customer code executed by whichever process runs the install. Enabling it also moves a container job's install from the agent host into the job container, so a container job's lifecycle scripts never run on the host. The `builder` and `init-runner` role jobs still install on the agent host, and run lifecycle scripts there once it is enabled. |
| `KICI_HOST_INSTALL_REGISTRIES`   | unset   | Comma-separated registry origins a container job's `.kici/` install on the agent host may contact, besides the public npm registry and the agent user's own `~/.npmrc` registries. The host install runs outside the job network's egress filter, so a registry a workflow or its `.kici/.npmrc` names qualifies only when its origin is listed here; otherwise the job container installs instead. See [Registries the host install may contact](../agent/configuration.md#registries-the-host-install-may-contact).                 |
| `KICI_RUNNER_DEBUG_STDIO`        | `false` | Echo the runner child's raw stdout and stderr onto the agent's own stderr. Off by default: for a scaler-spawned agent that stream is copied into the orchestrator's journal, where it is readable without the `runs:read` check that guards the run log and with no per-org scoping. The masked run log is the log.                                                                                                                                                                                                                   |

Each is read from agent config only, never from a dispatch payload or a
workflow, so a pull request cannot turn one on for itself.

## Container image requirements

The workflow runner and its TypeScript loader hook are bind-mounted read-only into the container at `/opt/kici/workflow-runner.js` and `/opt/kici/ts-loader-hook.js` -- neither needs to be baked into the image. The agent clones the repository on the host, and with an injected runtime (`KICI_RUNTIME_IMAGE` or `KICI_RUNTIME_NODE_SOURCE`) it also mounts its own Node build. The image then needs only glibc and `/bin/sh`. Without an injected runtime the image supplies its own `node`. See [What a job image must provide](../agent/configuration.md#what-a-job-image-must-provide) for the full table.

## Bubblewrap (Bare-Metal)

### Enabling bubblewrap

Bubblewrap isolation for bare-metal execution is opt-in via the `KICI_SANDBOX` environment variable:

```bash
KICI_SANDBOX=true
```

When set, the agent wraps every workflow runner fork in `bwrap` with the namespaces and mounts described below. Ensure `bwrap` is installed on the host (see system requirements). The default is `false` — the bare-metal sandbox runs workflow code as a plain forked Node.js process with only environment sanitization.

The orchestrator validates `bwrap` availability at **startup** when `KICI_AGENT_ENV_KICI_SANDBOX=true` is set: if the binary is missing the orchestrator exits with a clear error rather than failing every job at dispatch time. `bwrap` is **Linux only** — there is no equivalent on macOS or Windows, so the option is rejected on those platforms.

#### Network mode

`KICI_SANDBOX_NETWORK` controls the sandbox network namespace. It governs both backends: the bwrap network namespace when bwrap is enabled, and the container backend's job-container network:

| Value      | Behavior                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated` | Default. bwrap: `--unshare-net` — loopback only, no external connectivity. Strongest isolation; breaks workflows that need to reach package registries (npm, pip, cargo, etc.). The container backend keeps the runtime's default bridge (outbound egress works).                                                    |
| `host`     | Keep the host network namespace. Workflows can talk to the network. Use this when workflows need `npm install`, `git clone https://`, or other outbound traffic. On the container backend this also binds the host's `/etc/hosts` read-only so a host-resolved-only registry name resolves inside the job container. |

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

| Host Path                      | Container Path     | Mode            |
| ------------------------------ | ------------------ | --------------- |
| /usr                           | /usr               | read-only       |
| /lib                           | /lib               | read-only       |
| /lib64 (if exists)             | /lib64             | read-only       |
| /bin                           | /bin               | read-only       |
| /sbin                          | /sbin              | read-only       |
| /etc/resolv.conf               | /etc/resolv.conf   | read-only       |
| /etc/ssl                       | /etc/ssl           | read-only       |
| /etc/hosts (if exists)         | /etc/hosts         | read-only       |
| /etc/nsswitch.conf (if exists) | /etc/nsswitch.conf | read-only       |
| Node.js binary dir             | (same path)        | read-only       |
| Workspace                      | /workspace         | read-write      |
| (new)                          | /dev               | private         |
| (new)                          | /proc              | private         |
| (new)                          | /tmp               | private (tmpfs) |

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
