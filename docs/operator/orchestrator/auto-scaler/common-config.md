---
title: 'Auto-scaler: common configuration'
description: Shared scaler.yaml fields that apply across all auto-scaler backend types
---

The fields on this page apply to every scaler backend. Backend-specific fields are documented on each backend's own page: [Container](./container.md), [Bare-metal](./bare-metal.md), [Firecracker](./firecracker.md).

## Top-level schema

The scaler configuration is a YAML file validated using Zod schemas at startup. The configuration source of truth is `packages/orchestrator/src/scaler/config.ts`.

```yaml
version: 1 # Required. Config format version (must be 1).
globalMaxAgents: 50 # Optional. Global cap across all backends. Default: 50.
globalResourceCap: # Optional. Whole-orchestrator CPU/memory cap (sum across all scalers).
  maxCpu: 16 # Optional. Total CPUs the orchestrator may reserve at once.
  maxMemory: '64g' # Optional. Total memory the orchestrator may reserve at once.
machinePools: # Optional. Named machine-wide pools shared across orchestrator instances on the same host.
  - name: shared-host # Pool name (referenced by scalers below via machinePool: shared-host).
    cap:
      maxCpu: 32
      maxMemory: '128g'
defaults: # Optional. Global defaults for all label sets.
  resources:
    memory: '2g' # Optional. Default memory limit (e.g., "512m", "2g").
    cpus: 2 # Optional. Default CPU limit in fractional cores.
scalers: # Required. Array of scaler backend definitions.
  - ...
firecracker: # Optional. Global Firecracker network configuration (shared across all Firecracker scalers).
  cidr: '10.0.0.0/24' # Optional. CIDR range for VM IP allocation. Default: '10.0.0.0/24'.
  bridgeName: 'kici-br0' # Optional. Host bridge interface name. Default: 'kici-br0'.
  gateway: '10.0.0.1' # Optional. Gateway IP address (assigned to bridge). Default: '10.0.0.1'.
  netmask: '255.255.255.0' # Optional. Subnet mask for guest networking. Default: '255.255.255.0'.
  table: 'kici' # Optional. nftables table name for this host bridge (disjoint per bridge). Default: 'kici'.
```

The `firecracker:` top-level key configures Firecracker VM networking and is documented on the [Firecracker backend](./firecracker.md) page.

## Scaler entry (shared fields)

Each entry in the `scalers` array configures one backend:

```yaml
scalers:
  - name: container-linux # Required. Unique human-readable name.
    type: container # Required. Backend type: "container", "bare-metal", or "firecracker".
    maxAgents: 20 # Required. Per-backend max concurrent agents.
    labelSets: # Required. At least one label-set mapping.
      - ...
    orchestratorUrl: 'ws://...' # Optional. URL for spawned agents to connect back to.
    warmPool: # Optional. Warm pool configuration.
      enabled: false # Enable warm pool for this scaler. Default: false.
      size: 0 # Number of idle agents to maintain. Default: 0.
      idleTimeoutSeconds: 300 # Seconds before idle agent is destroyed. Default: 300 (5 min).
    mandatoryLabels: # Optional. Labels a job MUST declare in runsOn to land on this scaler. Default: [].
      - gpu
    roles: # Optional. Agent roles this scaler handles. See "Agent roles" below.
      - builder
    resourceCap: # Optional. Per-scaler CPU/memory cap (stacks with maxAgents).
      maxCpu: 8
      maxMemory: '32g'
    machinePool: shared-host # Optional. Reference to a top-level machinePools entry. See "Resource caps & machine pools".
```

Container-, bare-metal-, and Firecracker-only scaler fields are documented on their respective backend pages. The `type` field selects the backend: `container`, `bare-metal`, or `firecracker`.

## Label sets

Each label set maps a set of labels to agent provisioning details. Labels with the `kici:` prefix are reserved for internal use and cannot be used in scaler label sets.

```yaml
labelSets:
  - labels: ['linux', 'container'] # Required. Label set (min 1 label, no 'kici:' prefix).
    resources: # Optional. Override global defaults.
      memory: '4g'
      cpus: 4
    env: # Optional. Additional env vars for spawned agents.
      MY_VAR: 'value'
    networkPolicy: # Optional. Network isolation policy for this label set.
      allowlist: # Optional. CIDR ranges allowed as exceptions to RFC1918 block.
        - '10.0.5.0/24'
      denyAll: false # Optional. Block ALL outbound traffic except allowlisted. Default: false.
    backpressureMode: pause # Optional. Controls agent log streaming backpressure ('pause' or 'drop').
```

The provisioning field that tells the backend _what_ to spawn is type-specific: `image` for [container](./container.md#container-specific-fields), `binaryPath` for [bare-metal](./bare-metal.md#bare-metal-specific-fields), `rootfsPath` for [Firecracker](./firecracker.md#firecracker-specific-fields). Each backend page documents its own label-set fields.

## Resource limits

Per-job resource limits use a Kubernetes-style `requests` / `limits` split. `requests` are what the scaler bills against the per-scaler / global / machine-pool caps when deciding whether a spawn fits; `limits` are what the kernel enforces on the running agent (cgroup `memory.max`, CPU quota).

The scaler accepts three input shapes and normalises them all to the same `{ requests, limits }` pair:

- **Flat shorthand** (back-compat with legacy configs). `resources: { memory: '2g', cpus: 2 }` is treated as both the request and the limit.
- **Request only.** `resources: { requests: { memory: '2g' } }` mirrors to `limits: { memory: '2g' }`.
- **Limit only.** `resources: { limits: { memory: '4g' } }` mirrors to `requests: { memory: '4g' }`.
- **Both.** `resources: { requests: { memory: '2g' }, limits: { memory: '4g' } }` is taken as-is.

Resource limits cascade through three layers — most specific wins:

1. Per-job `resources` (set in the SDK via `defineJob({ resources: ... })`).
2. Per-label-set `resources` in `scalers.yaml`.
3. Top-level `defaults.resources` in `scalers.yaml`.

```yaml
defaults:
  resources:
    requests:
      memory: '1g' # bill against caps
      cpus: 1
    limits:
      memory: '2g' # kernel enforcement
      cpus: 2

scalers:
  - name: container-heavy
    type: container
    maxAgents: 5
    labelSets:
      - labels: ['linux', 'heavy']
        image: 'ghcr.io/myorg/kici-agent:latest'
        # Flat shorthand below is equivalent to
        # resources: { requests: {memory: '8g', cpus: 4}, limits: {memory: '8g', cpus: 4} }
        resources:
          memory: '8g'
          cpus: 4
```

Memory values use container-style suffixes: `k` (kilobytes), `m` (megabytes), `g` (gigabytes). Case-insensitive.

See each backend page for how `limits` are enforced: [Container](./container.md), [Bare-metal](./bare-metal.md#cgroup-enforcement), [Firecracker](./firecracker.md).

## Resource caps & machine pools

In addition to the agent-count cap (`maxAgents` per-scaler, `globalMaxAgents` whole-orchestrator), the auto-scaler enforces three optional CPU+memory caps. They stack: a spawn must pass every cap that applies to it.

| Cap                 | Scope                                                      | Use it for                                                                                                              |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `resourceCap`       | One scaler entry                                           | Stop a single label set from monopolising the host (e.g. cap GPU scaler at `maxCpu: 8`).                                |
| `globalResourceCap` | Whole orchestrator process                                 | Cap the orchestrator's total resource budget across all scalers.                                                        |
| `machinePools`      | Multiple orchestrators / scalers on the same physical host | Coordinate caps across processes via a file-backed ledger. Two scalers referencing the same pool name share one budget. |

### How a spawn is admitted

When a job arrives, the scaler resolves the **request** (cpus, memBytes) by walking the cascade (job → label-set → scaler default → 0/0). It then atomically checks every cap that applies:

1. Per-scaler `maxAgents` and `resourceCap` (in-memory).
2. `globalResourceCap` (in-memory, summed across all scalers in this orchestrator).
3. `machinePool` cap (if the scaler references one) — checked under a file lock against the on-disk ledger so other orchestrators / scalers using the same pool are accounted for.

If every cap has room, the scaler reserves the request, records it in each affected counter (and writes a row to the on-disk ledger when a pool is involved), then spawns the agent. On agent destroy / failure / scaler shutdown the reservations are released. A reaper sweeps the on-disk ledger every 30 s, releasing rows whose owning process is gone (cross-boot rows are unconditionally stale).

### Machine-pool ledger

```yaml
machinePools:
  - name: shared-host
    cap:
      maxCpu: 32
      maxMemory: '128g'

scalers:
  - name: container-default
    type: container
    machinePool: shared-host # this scaler reserves into the shared-host pool
    ...
  - name: bare-metal-builders
    type: bare-metal
    machinePool: shared-host # so does this one — they share the 32 CPU / 128 GiB budget
    ...
```

The ledger lives at `${KICI_MACHINE_LEDGER_DIR}/<pool-name>.json`. When `KICI_MACHINE_LEDGER_DIR` is unset, the directory is resolved by trying, in order, the first writable of: `/var/lib/kici/scaler-ledger`, then `${XDG_STATE_HOME:-~/.local/state}/kici/scaler-ledger`, then `${TMPDIR}/kici-scaler-ledger` (last resort, e.g. CI sandboxes). Set `KICI_MACHINE_LEDGER_DIR` to override.

Cross-orchestrator coordination is mandatory for staging+test setups that run two orchestrator processes against the same host — without a shared pool, both can each spawn up to their own caps and OOM the host. Reference the same pool name in both orchestrator config files and the ledger keeps them honest.

## Warm pool

Warm pools maintain a configurable number of pre-spawned idle agents, reducing cold-start latency for on-demand jobs.

### How it works

1. When a warm pool is enabled for a label set, the pool is configured with the target `size` but agents are not pre-spawned at startup. The pool fills on demand as agents are consumed and replenished.
2. When a job arrives with matching labels, the scaler consumes an idle agent from the warm pool instead of spawning a new one.
3. After consuming an agent, the warm pool triggers replenishment asynchronously (on the next microtask), spawning new agents to restore the pool to its configured `size`.
4. Idle agents that exceed `idleTimeoutSeconds` are destroyed to free resources.

### Configuration

```yaml
scalers:
  - name: container-default
    type: container
    maxAgents: 20
    warmPool:
      enabled: true
      size: 5 # Keep 5 idle agents ready
      idleTimeoutSeconds: 300 # Destroy idle agents after 5 minutes
    labelSets:
      - labels: ['linux', 'container']
        image: 'ghcr.io/myorg/kici-agent:latest'
```

### Capacity interaction

Warm pool agents count toward both the per-scaler `maxAgents` and the `globalMaxAgents` cap. Ensure warm pool sizes leave room for on-demand spawns:

```
maxAgents = 20, warmPool.size = 5
=> 15 slots available for on-demand spawns
```

If the global cap is reached due to warm pool agents, on-demand jobs will be queued until capacity frees up.

## Agent roles

The `roles` field on a scaler entry controls which internal job types the scaler handles, in addition to regular execution jobs. This is set at the scaler-entry level (not per-label-set).

### Behavior

| `roles` value                | Handles execution jobs | Handles build jobs | Handles init jobs |
| ---------------------------- | ---------------------- | ------------------ | ----------------- |
| Not set (undefined)          | Yes                    | Yes                | Yes               |
| `['all']`                    | Yes                    | Yes                | Yes               |
| `[]` (empty array)           | Yes                    | No                 | No                |
| `['builder']`                | Yes                    | Yes                | No                |
| `['init-runner']`            | Yes                    | No                 | Yes               |
| `['builder', 'init-runner']` | Yes                    | Yes                | Yes               |

### Example

```yaml
scalers:
  - name: build-agents
    type: container
    maxAgents: 2
    roles: [builder] # Handles build + execution jobs
    labelSets:
      - labels: [linux, container]
        image: kici-agent:latest

  - name: exec-only
    type: bare-metal
    maxAgents: 4
    roles: [] # Execution jobs only, no build/init
    labelSets:
      - labels: [linux, bare-metal]
        binaryPath: /opt/kici/kici-agent
```

When `roles` is not set, the scaler handles all job types.

## Mandatory & exclude labels

`mandatoryLabels` on a scaler entry behaves like a Kubernetes taint: a job is only allowed on the scaler if its `runsOn` includes every label declared in `mandatoryLabels`. Without the gate, label matching is subset-based — a job with `runsOn: ['linux']` would happily land on any scaler whose label set is a superset of `['linux']`. With `mandatoryLabels: ['gpu']`, only jobs that explicitly opt in via `runsOn: [..., 'gpu']` are considered.

Use this to protect specialised pools — GPU boxes, expensive Firecracker pools, macOS hosts, hardware with limited capacity — from generic jobs that were never meant to land there.

**Example: a GPU pool only accessible to jobs that ask for `gpu`:**

```yaml
scalers:
  - name: gpu-pool
    type: container
    maxAgents: 4
    mandatoryLabels: [gpu]
    labelSets:
      - labels: [linux, gpu]
        image: ghcr.io/me/agent-gpu:latest
        resources: { memory: '64g', cpus: 16 }
```

A workflow with `runsOn: ['linux']` cannot land on `gpu-pool` — the gate requires `gpu` in `runsOn`. A workflow with `runsOn: ['linux', 'gpu']` satisfies the gate and is dispatched.

**Validation invariants:**

- Every label in `mandatoryLabels` MUST appear (case-insensitive) in the `labels` array of every entry in `labelSets`. Otherwise jobs could route through a labelSet missing the gate label and bypass the gate. Config validation rejects this at load time.
- Labels with the `kici:` prefix are reserved for auto-injected system labels (`kici:role:*`, `kici:os:*`, `kici:arch:*`, `kici:agent:*`, `kici:scaler:*`) and cannot be used in `mandatoryLabels` — same rule as `labelSets[].labels`.
- The default is `[]` (no gate).

**Cross-peer routing:** `mandatoryLabels` is advertised over the peer heartbeat protocol, so cluster-mode reroute decisions apply the same gate. A coordinator will not reroute a job to a peer whose only matching scaler is gated by a label the job does not declare.

`mandatoryLabels` and `excludeLabels` are two orthogonal mechanisms that control which scaler a job lands on. Both filter at the scaler-matcher level; the dispatcher applies them together.

| Mechanism                           | Declared on  | Direction                                                                                               | Use it for                                                                                                                                |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mandatoryLabels` (operator opt-in) | Scaler entry | The **scaler** demands the label: a job is rejected unless its `runsOn` includes every mandatory label. | Protect a specialised scaler (GPU pool, expensive Firecracker pool, macOS host) from generic jobs that did not explicitly ask for it.     |
| `excludeLabels` (job opt-out)       | Job `runsOn` | The **job** vetoes a scaler: any scaler whose label set contains an excluded label is skipped.          | Steer a job away from a class of agents (e.g. opt out of a `spot` instance pool, or avoid a label set the workflow author knows is slow). |

The two stack: a scaler is only considered when **both** the scaler's `mandatoryLabels` are satisfied **and** none of the scaler's labels appear in the job's `excludeLabels`. The same combined rule applies to cross-peer reroute decisions.

Worked example — a scaler with `mandatoryLabels: ['gpu']` and a label set `['linux', 'gpu', 'spot']`:

- `runsOn: ['linux']` → blocked. Mandatory `gpu` not in `runsOn`.
- `runsOn: ['linux', 'gpu']` → matches.
- `runsOn: { labels: ['linux', 'gpu'], exclude: ['spot'] }` → blocked. Mandatory satisfied, but the job opts out of `spot`.
- `runsOn: ['linux', 'gpu', 'spot']` → matches. Mandatory satisfied; no veto declared.

## Environment variable forwarding

In addition to the static `env:` field in label-set configuration, operators can forward environment variables from the orchestrator host to spawned agents using the `KICI_AGENT_ENV_` prefix. Variables with this prefix are forwarded with the prefix stripped.

**Precedence:** Static `env:` entries in `scalers.yaml` have **higher priority** than `KICI_AGENT_ENV_` forwarded variables. If both define the same variable, the `scalers.yaml` value wins.

**Example: Using both mechanisms together**

```yaml
# scalers.yaml
scalers:
  - name: linux-builder
    type: bare-metal
    maxAgents: 5
    labelSets:
      - labels: [linux]
        binaryPath: /opt/kici/kici-agent
        env:
          NODE_ENV: production # Static config (overrides KICI_AGENT_ENV_ on conflict)
```

```bash
# On orchestrator host (dynamic/runtime)
export KICI_AGENT_ENV_HTTP_PROXY=http://proxy:3128
export KICI_AGENT_ENV_NO_PROXY=localhost,.internal
```

The spawned agent receives:

- `NODE_ENV=production` (from scalers.yaml `env:`)
- `HTTP_PROXY=http://proxy:3128` (forwarded from KICI_AGENT_ENV\_)
- `NO_PROXY=localhost,.internal` (forwarded from KICI_AGENT_ENV\_)

This is useful for runtime configuration like proxy settings that may change without restarting the orchestrator (SIGHUP reload does not re-read process environment -- restart required for new `KICI_AGENT_ENV_` values).

**Backend support:** All three backends (bare-metal, container, Firecracker) support `KICI_AGENT_ENV_` forwarding with the same prefix-stripping and yaml-wins precedence. The Firecracker backend transports the merged env via MMDS (per-key under `meta-data/kici-env/`) and enforces a per-VM 32 KiB total budget on the orchestrator side; vars exceeding the budget or carrying non-POSIX-safe key names are skipped with a `firecracker-backend` warning log (visible in `<deployment-slug>-orchestrator-*-*.log`).

## Network policy

Each label set can configure a `networkPolicy` that controls outbound network access for customer workflow code. By default, container and Firecracker backends block traffic to RFC1918 private address ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and cloud metadata endpoints (169.254.0.0/16) while allowing internet access.

### Configuration

```yaml
labelSets:
  - labels: [default]
    image: kici-agent:latest
    networkPolicy:
      allowlist:
        - 10.0.5.0/24 # Allow specific internal subnet
      denyAll: false # When true, blocks all traffic except allowlisted
```

### Fields

| Field       | Type     | Default | Description                                          |
| ----------- | -------- | ------- | ---------------------------------------------------- |
| `allowlist` | string[] | `[]`    | CIDR ranges to allow (exceptions to RFC1918 block)   |
| `denyAll`   | boolean  | `false` | Block all outbound traffic except allowlisted ranges |

### Per-backend behavior

| Backend     | Mechanism                         | Internet Access | Notes                                                       |
| ----------- | --------------------------------- | --------------- | ----------------------------------------------------------- |
| Container   | Per-container nftables (IP saddr) | Yes (via NAT)   | Rules applied per-container using source IP matching        |
| Firecracker | Per-VM nftables (IP saddr)        | Yes (via NAT)   | Rules applied per VM using source IP matching during spawn  |
| Bare-metal  | None (not supported)              | Yes             | Agents run as child processes with full host network access |

The container backend applies per-container nftables rules using the container's IP address on the isolated `kici-agent-net` network. Each container gets its own set of rules (RFC1918 block + allowlist + optional denyAll) that are created during spawn and cleaned up during destroy.

The Firecracker backend applies per-VM nftables rules matching on the TAP device name. Rules are created after TAP device setup and cleaned up before TAP device deletion during destroy.

The bare-metal backend has no network isolation. Agents run as child processes with full host filesystem and network access. If a label set has `networkPolicy` configured, a warning is logged at startup. This mode is intended for trusted environments only.

Per-backend mechanism details are on each backend page: [Container](./container.md), [Bare-metal](./bare-metal.md), [Firecracker](./firecracker.md).

## Log streaming backpressure

The `backpressureMode` controls how the agent handles log output when the WebSocket send buffer fills up (slow network, burst of log output from the child process).

### Configuration

Set `backpressureMode` in the label set YAML configuration, or use the `KICI_BACKPRESSURE_MODE` environment variable (set it in the label set's `env` block or as a process environment variable):

```env
KICI_BACKPRESSURE_MODE=pause
```

### Modes

| Mode    | Default | Behavior                                                                                             | Best for                                                                   |
| ------- | ------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pause` | Yes     | Pauses child process stdout when WS buffer exceeds 1 MB. Resumes on drain. Guarantees complete logs. | Most workloads -- complete log output is more important than speed         |
| `drop`  | No      | Drops log lines when WS buffer is full. Inserts `[N lines dropped due to backpressure]` markers.     | Extremely verbose workloads where speed matters more than log completeness |

**Safety timeout (pause mode):** If stdout remains paused for more than 30 seconds, the agent temporarily switches to drop mode to prevent deadlocks. This can happen if the WebSocket connection is completely stalled.
