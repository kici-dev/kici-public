---
title: Execution isolation architecture
description: ''
---

Deep-dive on the agent-code isolation model: how KiCI separates customer workflow code from agent-internal resources.

## Problem

In earlier KiCI versions, the agent executed customer workflow steps **in-process** using `eval()` or dynamic import within the agent's own V8 isolate. This created critical security issues:

- **Environment access** -- Customer code could read `process.env`, exposing `KICI_ORCHESTRATOR_URL`, `KICI_DATABASE_URL`, `KICI_PLATFORM_TOKEN`, `WEBHOOK_SECRET`, and other agent credentials
- **Filesystem access** -- Customer code could read agent configuration files, TLS certificates, and other sensitive host files
- **Network access** -- Customer code could connect to internal services (orchestrator WebSocket, database, MMDS metadata endpoint)
- **Process interference** -- Customer code could call `process.exit()`, modify global state, or interfere with the agent's event loop

## Solution

The agent now delegates all customer code execution to an **ExecutionSandbox** -- a separate process (or container) that receives only explicitly allowed data.

### Core components

1. **ExecutionSandbox interface** (`types.ts`) -- Lifecycle contract: `setup -> executeJob -> teardown` with `abort` available at any time
2. **Workflow Runner** (`workflow-runner.ts`) -- Standalone Node.js entry point that runs inside the sandbox. Handles git clone, dependency install, compile, and step execution
3. **IPC Protocol** (`ipc-protocol.ts`) -- Typed message protocol between agent and runner
4. **Environment Sanitizer** (`env-sanitizer.ts`) -- Allowlist-based environment variable filtering

### Architecture diagram

```
Agent Process                         Sandbox (child process / container / VM)
+----------------------------+       +----------------------------------+
|                            |       |                                  |
|  JobRunner                 |       |  WorkflowRunner                  |
|    |                       |       |    |                             |
|    +-- detectExecutionMode |       |    +-- git clone                 |
|    |                       |       |    |                             |
|    +-- createSandbox()     |       |    +-- dep restore (tarball or  |
|    |     |                 |       |    |      inline npm ci)         |
|    |     +-- setup()       |       |    +-- register TS loader hook  |
|    |     |                 |  IPC  |    |                             |
|    |     +-- executeJob() -------->|    +-- import workflow .ts       |
|    |     |                 |       |    |                             |
|    |     |  onStepStatus <---------|    +-- evaluate rules            |
|    |     |  onLogLine    <---------|    |                             |
|    |     |                 |       |    +-- execute steps             |
|    |     +-- teardown()    |       |    |     |                       |
|    |                       |       |    |     +-- step.run(ctx)       |
|    +-- forward to          |       |    |     |   (native zx $)      |
|        orchestrator WS     |       |    |     +-- stream logs         |
|                            |       |    |                             |
+----------------------------+       +----------------------------------+
     Sanitized env only                    No KICI_*, KICI_DATABASE_URL,
     (allowlist + user env)               KICI_PLATFORM_TOKEN, WEBHOOK_SECRET
                                          Secrets via IPC, not env
```

## IPC protocol

The runner and agent communicate via a typed message protocol with two transport modes:

### Message types

**Runner to Agent (RunnerToAgentMessage):**

| Type                 | Fields                                                                        | Description                                   |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `ready`              | --                                                                            | Runner initialized, ready for execute command |
| `step.start`         | stepIndex, stepName, step_type?                                               | Step began executing                          |
| `step.complete`      | stepIndex, status, durationMs, error?, outputs?, step_type?, secretsAccessed? | Step finished                                 |
| `log.line`           | stepIndex, line                                                               | Single log line from step                     |
| `job.complete`       | status, stepResults[], error?, outputs?, secretOutputs?                       | All steps done, final results                 |
| `event.emit`         | requestId, eventName, payload, target?                                        | Request to emit a custom event from a step    |
| `concurrency.report` | group                                                                         | Report evaluated concurrency group key        |

**Agent to Runner (AgentToRunnerMessage):**

| Type                  | Fields                         | Description                                   |
| --------------------- | ------------------------------ | --------------------------------------------- |
| `execute`             | request: JobExecutionRequest   | Start job execution                           |
| `abort`               | force?                         | Cancel the running job (force skips hooks)    |
| `event.emit.response` | requestId, deliveryId?, error? | Confirm or reject a custom event emit request |
| `concurrency.ack`     | action, reason?                | Concurrency gate result (proceed/wait/cancel) |

### Dual transport mode

The protocol supports two transport mechanisms, selected at runner startup:

**Fork IPC** (bare-metal and Firecracker backends):

- Uses Node.js IPC channel via `child_process.fork()`
- Messages sent with `process.send()` and received via `process.on('message')`
- Binary-efficient, no serialization overhead
- The runner detects fork mode via `typeof process.send === 'function'`

**Stdio JSON-lines** (container backend):

- Uses stdin/stdout via `docker exec`
- Each message is a single JSON object terminated by a newline
- Agent sends execute request on stdin, runner writes messages on stdout
- `zx $.verbose=false` and `$.quiet=false` suppress command echoing while allowing output to flow to stdout/stderr for step output capture

### Lifecycle sequence

```
Agent                          Runner
  |                              |
  |-- fork/exec ---------------→|
  |                              |-- initialize
  |                              |-- detect IPC mode
  |←--- ready -------------------|
  |---- execute {request} -----→|
  |                              |-- restore .kici/ source (tarball)
  |                              |-- restore deps (tarball or npm ci)
  |                              |-- register TS loader hook
  |                              |-- import workflow .ts
  |                              |-- verify contentHash (drift guard)
  |                              |-- evaluate rules
  |                              |
  |                              |-- for each step:
  |←--- step.start --------------|
  |←--- log.line ----------------|  (many)
  |←--- log.line ----------------|
  |←--- step.complete ----------|
  |                              |
  |←--- job.complete ------------|
  |                              |-- exit(0)
```

### Abort sequence

```
Agent                          Runner
  |                              |
  |---- abort ----------------→|  (IPC message)
  |                              |-- attempt graceful shutdown
  |   ... 10s grace period ...   |
  |---- SIGTERM --------------→|  (if still running)
  |   ... 5s more ...            |
  |---- SIGKILL --------------→|  (force kill)
```

## Environment sanitization

Environment sanitization operates at two tiers:

1. **Orchestrator tier** -- The orchestrator sanitizes the environment when spawning agent processes (bare-metal and container backends). This prevents orchestrator secrets (KICI_DATABASE_URL, GITHUB_PRIVATE_KEY, S3 credentials) from reaching agents.
2. **Agent tier** -- The agent sanitizes the environment when spawning sandbox processes (customer code). This prevents agent credentials (KICI_ORCHESTRATOR_URL, KICI_AGENT_ID) from reaching customer code.

### Shared constants (single source of truth)

Environment allowlist constants are defined in `@kici-dev/engine` (`packages/engine/src/env/environment-allowlist.ts`) and imported by both the orchestrator and agent:

- **`ALLOWED_SYSTEM_VARS`** -- System variables safe to pass downstream (PATH, HOME, USER, etc.)
- **`AGENT_REQUIRED_KICI_VARS`** -- KICI variables the agent needs (set explicitly, not copied from process.env)
- **`KICI_AGENT_ENV_PREFIX`** -- The `KICI_AGENT_ENV_` prefix constant for operator-controlled forwarding

This eliminates duplication between tiers and prevents drift.

### Allowlist approach

The environment sanitizer uses an explicit **allowlist** -- only named system variables pass through. This is the inverse of a blocklist: adding new variables to the host will never accidentally leak them.

The allowlist (`ALLOWED_SYSTEM_VARS`) contains:

```typescript
export const ALLOWED_SYSTEM_VARS = [
  'PATH', // Command execution
  'HOME', // User home directory
  'USER', // Current user
  'SHELL', // User shell
  'LANG', // Locale
  'LC_ALL', // Locale override
  'TERM', // Terminal type
  'TMPDIR', // Temp directory
  'NODE_PATH', // Node module resolution
  'TZ', // Timezone
] as const;
```

### KICI_AGENT_ENV\_ prefix forwarding

Operators can set `KICI_AGENT_ENV_`-prefixed variables on the orchestrator host. The orchestrator strips the prefix and passes the variable to spawned agents:

```
KICI_AGENT_ENV_HTTP_PROXY=http://proxy:3128  ->  HTTP_PROXY=http://proxy:3128
KICI_AGENT_ENV_NO_PROXY=localhost            ->  NO_PROXY=localhost
```

All three backends honor this mechanism with identical precedence rules; only the transport differs. Bare-metal merges into the spawned process's `env` map, container assembles a flat env array Docker/Podman feeds the container, and Firecracker writes the merged map per-key into MMDS under `meta-data/kici-env/`. The Firecracker backend additionally enforces a per-VM 32 KiB byte budget (defends Firecracker's ~51 KiB MMDS data store cap) and rejects keys that aren't POSIX-safe identifiers; both filters fire warning logs and skip the offending var without aborting the spawn.

### Orchestrator-tier precedence (bare-metal backend)

The bare-metal backend constructs the agent's environment in four layers:

1. **System allowlist** (from orchestrator `process.env`) -- lowest precedence
2. **KICI_AGENT_ENV\_ forwarded** (prefix stripped from orchestrator `process.env`)
3. **Explicit KICI\_\* agent vars** (KICI_ORCHESTRATOR_URL, KICI_AGENT_ID, etc. -- set to known values)
4. **scalers.yaml `env:`** (label-set configuration) -- highest precedence

### Container-tier precedence

The container backend builds a flat environment array. Docker/Podman uses last-value-wins for duplicate keys:

1. **Explicit KICI\_\* agent vars** (KICI_ORCHESTRATOR_URL, etc.)
2. **KICI_AGENT_ENV\_ forwarded** (prefix stripped)
3. **scalers.yaml `env:`** -- last in array, highest precedence

### Firecracker-tier precedence

The Firecracker backend builds the merged env on the orchestrator and ships it to the VM via MMDS (system vars are kernel-provided inside the VM, not orchestrator-supplied):

1. **KICI_AGENT_ENV\_ forwarded** (prefix stripped from orchestrator `process.env`)
2. **scalers.yaml `env:`** (label-set configuration) -- highest precedence

The merged map is written to MMDS as a nested object under `meta-data/kici-env/<KEY>` (one MMDS key per env var, value stored verbatim). Inside the VM, the rootfs `/init` script lists the directory, `GET`s each value, and emits `export KEY='value'` lines into a sourceable temp file (POSIX single-quote escaping handles values with quotes). Two safety filters apply on the orchestrator side: keys must match `[A-Za-z_][A-Za-z0-9_]*` and the cumulative byte cost must stay under 32 KiB; otherwise the var is skipped with a `firecracker-backend` warning log.

### Agent-tier precedence (sandbox)

The agent's `buildSanitizedEnv()` constructs the sandbox environment using the 7-layer merge documented in [Environments architecture](../environments.md). The simplified view:

1. **System allowlist** (from agent `process.env`) -- lowest precedence
2. **User env** (from workflow config / orchestrator-provided) -- overrides system
3. **Job env** (from SDK env property) -- overrides user env

Secrets are NOT injected as environment variables. They flow through IPC and are accessed via `ctx.secrets.get()` and `ctx.secrets.has()`. Users can explicitly inject a secret into `process.env` by calling `ctx.secrets.expose('KEY')`, but this is opt-in.

This ensures:

- User vars can customize system defaults (e.g., custom PATH)
- Agent credentials are never included regardless of variable name
- Secrets never leak into environment variables unless explicitly exposed by user code

### What gets excluded

Any variable not in the allowlist is stripped, including:

- `KICI_ORCHESTRATOR_URL`, `KICI_AGENT_ID`, `KICI_LABELS` -- agent config
- `KICI_DATABASE_URL` -- database credentials
- `KICI_PLATFORM_TOKEN` -- Platform authentication
- `WEBHOOK_SECRET` -- webhook signature keys
- `AWS_*`, `DOCKER_*` -- infrastructure credentials (unless explicitly passed as user env)
- Any other variable present in the agent's environment

## Per-backend details

### Container backend (ContainerSandbox)

- Creates a disposable Docker/Podman container per job via `sleep infinity`
- Workflow runner bind-mounted read-only at `/opt/kici/workflow-runner.js`
- Workspace bind-mounted read-write at `/workspace`
- IPC via dockerode exec API with demultiplexed stdin/stdout streams
- Container labels (`kici-sandbox`, `kici-job-id`) for orphan cleanup
- Optional `keepFailed` flag preserves containers for debugging
- Uses `buildRequest()` from `fork-runner.ts` for consistent dispatch-to-request mapping

### Bare-metal backend (BareMetalSandbox)

- Forks workflow runner via `child_process.fork()` with IPC channel
- Environment sanitized via `buildSanitizedEnv()` -- only allowlisted vars
- Optional bubblewrap (bwrap) wrapping:
  - `child_process.spawn('bwrap', [...args, node, runner])` with stdio IPC fd
  - Read-only system mounts, writable workspace at `/workspace`
  - PID and IPC namespace isolation (`--unshare-pid`, `--unshare-ipc`)
  - Network isolation via `--unshare-net` (loopback only, no external connectivity)
  - Die-with-parent and new-session for lifecycle safety
- Without bwrap: credential isolation only (full filesystem/network access)
- stderr captured (last 20 lines) for crash diagnostics

### Firecracker backend (FirecrackerSandbox)

- Thin defense-in-depth wrapper around the same fork mechanism
- VM provides real isolation (separate kernel, rootfs, network)
- Sandbox adds environment sanitization inside the VM
- Prevents customer code from accessing MMDS metadata endpoint
- VM lifecycle (start/stop) managed by scaler backend, not the sandbox
- `setup()` is a no-op (VM already running when agent starts)
- `teardown()` kills child process only (VM shutdown is scaler's job)

## Key design decisions

### One process per job

Each job gets exactly one sandbox process (or container). The runner handles the entire lifecycle: clone, install, compile, execute all steps. This avoids:

- Per-step process creation overhead
- State loss between steps (working directory, installed dependencies)
- Complex IPC multiplexing

### StepContext reconstruction (not serialization)

The `StepContext` object (which provides `$` from zx, `log`, `env`, `inputs`, `workflow`, `job`, `matrix`) is **reconstructed natively** inside the runner process, not serialized across the IPC boundary. This is critical because:

- zx's `$` cannot be serialized (it holds process references)
- The runner creates a fresh zx instance with `initZx()` and `$.verbose=false`
- Logger, env, and inputs are constructed from the execution request data
- Customer code gets a fully functional `StepContext` with native zx shell execution

### zx runs natively in the sandbox

zx (the shell execution library) runs inside the sandbox process, not in the agent. This means:

- Shell commands execute with the sanitized environment
- zx's `$` has no access to agent credentials
- Command echoing is suppressed: `$.verbose=false` and `$.quiet=false`
- Command output goes through `log.line` IPC messages back to the agent

### Sandbox types are self-contained

The sandbox type hierarchy (`ExecutionSandbox`, `JobExecutionOptions`, `JobExecutionResult`, `SandboxStepResult`) is independent from the agent's older `StepResult` types. This ensures:

- Clean separation of concerns
- No accidental coupling between sandbox and agent internals
- The sandbox module can evolve independently

### Sandbox is the only execution path

The sandbox is the **only** execution path for customer workflow code. There is no in-process execution route, which eliminates the risk of running untrusted step bodies outside the isolation boundary.

## Network isolation

Network isolation prevents customer workflow code from accessing internal infrastructure (orchestrator, database, object storage, MMDS metadata). Each backend uses a different mechanism suited to its isolation model.

### Container backend

- Containers are attached to a dedicated bridge network (`kici-agent-net`, subnet 172.30.0.0/16)
- Per-container nftables rules using `ip saddr` matching block traffic to RFC1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and cloud metadata endpoints (169.254.0.0/16)
- Internet access is allowed via NAT masquerade through the bridge gateway
- Rules are applied per-container during spawn and cleaned up during destroy
- Per-label-set `networkPolicy.allowlist` adds CIDR exceptions to the RFC1918 block; `denyAll` blocks all non-allowlisted outbound traffic

### Firecracker backend

- Each VM has a dedicated TAP device attached to a shared bridge (`kici-br0`)
- Per-VM nftables rules keyed on the VM's source IP block RFC1918 and metadata traffic (the TAP is enslaved to the bridge, so forwarded traffic carries the bridge as its input interface — source IP is the per-VM match that holds on the routed path)
- Internet access is allowed via NAT masquerade through the bridge gateway
- MMDS metadata endpoint (169.254.169.254) is additionally protected via in-VM iptables and host-side MMDS clearing (see Register/Config ACK Protocol below)
- Per-label-set `networkPolicy.allowlist` adds CIDR exceptions; `denyAll` blocks all non-allowlisted outbound traffic

### Bare-metal backend

- When bubblewrap (bwrap) is enabled, `--unshare-net` creates a network namespace with only the loopback interface
- Customer workflow code has zero external network access (no internet, no local services)
- This is intentionally strict: bare-metal is for trusted environments only, and full isolation is simpler and more secure than selective nftables blocking
- Without bwrap: no network isolation (full host network access)

### Blocked traffic summary

| Target                                    | Reason                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 | Prevent access to local services (Postgres, orchestrator HTTP) |
| 169.254.0.0/16                            | Prevent SSRF-style attacks on cloud provider metadata services |
| Gateway exception                         | Allows internet access via NAT masquerade                      |

## Register/config ACK protocol

The registration handshake between agent and orchestrator delivers configuration securely and triggers MMDS clearing for Firecracker VMs.

### Handshake sequence

```
Agent                    Orchestrator
  |                           |
  |--- agent.register ------->|   (agentId, labels, maxConcurrency)
  |                           |   (register in AgentRegistry)
  |<--- register.ack ---------|   (config: agentId, labels, scalerManaged)
  |                           |
  |  (block MMDS if FC mode)  |
  |--- config.ack ----------->|
  |                           |   (clear MMDS if Firecracker backend)
  |                           |
  |  Ready for job dispatch   |
```

### Message details

**agent.register** (agent to orchestrator): The agent sends its labels, max concurrent job count, and optional agent ID.

**register.ack** (orchestrator to agent): The orchestrator confirms the registration and sends back the agent's confirmed configuration: agentId, labels, and scalerManaged flag.

**config.ack** (agent to orchestrator): The agent confirms it received and applied the register.ack config. For Firecracker/scaler-managed agents, this is sent after blocking MMDS access via iptables.

### MMDS clearing flow

For Firecracker VMs, the config.ack triggers MMDS data clearing:

1. Agent receives `register.ack` with confirmed config
2. Agent detects it is scaler-managed (via `KICI_SCALER_MANAGED` env var or `scalerManaged` flag)
3. Agent blocks MMDS: `iptables -A OUTPUT -d 169.254.169.254 -j DROP`
4. Agent sends `config.ack` to orchestrator
5. Orchestrator's `ScalerManager.onConfigAck()` identifies the Firecracker backend via `managedAgentIndex`
6. Orchestrator calls `FirecrackerScalerBackend.clearAgentMmds()` which uses the Firecracker API to clear MMDS data

This dual-sided protection (agent blocks + orchestrator clears) ensures customer workflow code cannot read orchestrator credentials from MMDS even if one side fails.

### Backward compatibility

The agent waits for a `register.ack` response from the orchestrator before transitioning to the `registered` state. If the orchestrator does not send `register.ack` (e.g., due to a bug or version mismatch), the agent remains in the `registering` state until the connection is closed and reconnection is attempted.
