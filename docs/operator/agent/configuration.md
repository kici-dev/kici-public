---
title: 'Agent: configuration reference'
description: Environment variables, labels, container executor setup
---

> **See also:** [Environment variable reference](../env-reference.md) — shared env vars; agent-specific vars are listed below. Regenerate the generated table with `pnpm docs:env`. Unknown `KICI_*` env vars cause the agent to refuse to start (typo catcher); set `KICI_DEV=true` for warn-only behaviour during local development.

All agent configuration is provided via environment variables.

## Environment variables

These environment variables are specific to the agent. Variables shared across
KiCI services (log level, OpenTelemetry endpoint, heartbeat/concurrency timeouts)
and the rotated-file logger live in the [environment variable reference](../env-reference.md).

<!-- BEGIN GENERATED: agent-env (do not edit; run the doc generator) -->

| Env var                                    | Required | Default    | Type                                    | Aliases | Description |
| ------------------------------------------ | -------- | ---------- | --------------------------------------- | ------- | ----------- |
| `KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND`    | no       |            | string                                  |         |             |
| `KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON`     | no       | "always"   | enum:always\|on-failure                 |         |             |
| `KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS` | no       | 60000      | number                                  |         |             |
| `KICI_AGENT_COMMAND`                       | no       |            | string                                  |         |             |
| `KICI_AGENT_DRAIN_ON_RESET_FAILURE`        | no       | "false"    | string                                  |         |             |
| `KICI_AGENT_ID`                            | no       |            | string                                  |         |             |
| `KICI_AGENT_IS_ORCHESTRATOR_HOST`          | no       |            | string                                  |         |             |
| `KICI_AGENT_ORPHAN_CLEANUP`                | no       | "true"     | string                                  |         |             |
| `KICI_AGENT_PAYLOAD_DIR`                   | no       |            | string                                  |         |             |
| `KICI_AGENT_TOKEN`                         | no       |            | string                                  |         |             |
| `KICI_BACKPRESSURE_MODE`                   | no       | "pause"    | enum:pause\|drop                        |         |             |
| `KICI_CONTAINER_BUILD_CLI`                 | no       |            | enum:docker\|podman                     |         |             |
| `KICI_DEFAULT_STEP_TIMEOUT_MS`             | no       | 1800000    | number                                  |         |             |
| `KICI_DOCKER_KEEP_FAILED`                  | no       | "false"    | string                                  |         |             |
| `KICI_EXECUTION_MODE`                      | no       |            | enum:container\|bare-metal\|firecracker |         |             |
| `KICI_GITHUB_TOKEN`                        | no       |            | string                                  |         |             |
| `KICI_IN_PLACE`                            | no       | "false"    | string                                  |         |             |
| `KICI_JOB_IMAGE_AGENT`                     | no       |            | string                                  |         |             |
| `KICI_LABELS`                              | no       |            | string                                  |         |             |
| `KICI_MAX_LOG_SIZE_BYTES`                  | no       | 10485760   | number                                  |         |             |
| `KICI_ORCHESTRATOR_URL`                    | yes      |            | string                                  |         |             |
| `KICI_PORT`                                | no       | 8080       | number                                  |         |             |
| `KICI_PROPERTIES`                          | no       |            | string                                  |         |             |
| `KICI_ROLES`                               | no       |            | string                                  |         |             |
| `KICI_RUNTIME_IMAGE`                       | no       |            | string                                  |         |             |
| `KICI_RUNTIME_NODE_SOURCE`                 | no       |            | string                                  |         |             |
| `KICI_SANDBOX`                             | no       | "false"    | string                                  |         |             |
| `KICI_SANDBOX_HARDENED`                    | no       | "true"     | string                                  |         |             |
| `KICI_SANDBOX_MEMORY_BYTES`                | no       | 2147483648 | number                                  |         |             |
| `KICI_SANDBOX_NANO_CPUS`                   | no       | 2000000000 | number                                  |         |             |
| `KICI_SANDBOX_NETWORK`                     | no       | "isolated" | enum:isolated\|host                     |         |             |
| `KICI_SANDBOX_PIDS_LIMIT`                  | no       | 512        | number                                  |         |             |
| `KICI_SANDBOX_READONLY_ROOTFS`             | no       | "false"    | string                                  |         |             |
| `KICI_SANDBOX_USER`                        | no       |            | string                                  |         |             |
| `KICI_SCALER_CLAIM_CODE`                   | no       |            | string                                  |         |             |
| `KICI_SCALER_IDLE_TIMEOUT`                 | no       | 5000       | number                                  |         |             |
| `KICI_SCALER_MANAGED`                      | no       |            | string                                  |         |             |
| `KICI_SCALER_PENDING_DISPATCH_TIMEOUT`     | no       | 60000      | number                                  |         |             |
| `KICI_TRUSTED_ENV`                         | no       | "false"    | string                                  |         |             |

<!-- END GENERATED: agent-env -->

## Health and metrics endpoints

The agent exposes three HTTP endpoints on the configured `KICI_PORT`:

| Endpoint   | Purpose            | Response                                                                                                                                                                                                                                          |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`  | Liveness probe     | Always `200`. Body includes `agentId`, `activeJobs`, `connected` status, and the build identity (`version`, `buildCommit`, plus the SDK / shared / engine versions and bundle hashes) so operators can correlate deployed builds across services. |
| `/ready`   | Readiness probe    | `200` when connected to orchestrator, `503` when disconnected.                                                                                                                                                                                    |
| `/metrics` | Prometheus metrics | Prometheus text format with `kici_agent_` prefixed metrics.                                                                                                                                                                                       |

## Label-based routing

Labels allow the orchestrator to route jobs to specific agents. When a workflow specifies `runsOn: 'linux'`, the orchestrator dispatches the job only to agents that have the `linux` label.

```bash
# Agent with Linux and Docker capabilities
KICI_LABELS=linux,docker

# Agent with GPU support
KICI_LABELS=linux,gpu,cuda

# Agent with macOS for Apple-specific builds
KICI_LABELS=macos,arm64
```

Multiple agents can share labels. The orchestrator selects from available agents with matching labels.

## Agent roles

Roles control which types of special jobs an agent can handle. The two built-in roles are `builder` (dependency cache build jobs) and `init-runner` (dynamic init jobs). Roles manifest as reserved `kici:role:*` auto-labels used internally for routing.

```bash
# Accept all roles (default when KICI_ROLES is unset)
# Equivalent to KICI_ROLES=all
unset KICI_ROLES

# Only handle builder jobs (no init-runner)
KICI_ROLES=builder

# Both roles explicitly
KICI_ROLES=builder,init-runner

# Execution only — no special role jobs, only regular workflow jobs
KICI_ROLES=
```

The `kici:*` label prefix is reserved for internal use. User-provided labels in `KICI_LABELS` must not use this prefix.

## Concurrency

Each agent executes one job at a time. When a job is already running, the agent rejects additional dispatches, and the orchestrator routes them to another available agent or queues them.

## Execution profiles

Two agent-launch profiles change how a dispatched job is prepared. Both are set **only** by the operator at agent (or scaler) launch — neither is derivable from a dispatch payload or from workflow code, so a Platform-connected agent can never be pushed onto them.

| Variable           | Default | Effect                                                                                                                                                                                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_TRUSTED_ENV` | `false` | Trusted fleet-agent profile: step sandboxes receive the ambient host environment (minus the agent's own KiCI identity and operational secrets) instead of the system-variable allowlist. See [Agent security](../security/agent-security.md).                       |
| `KICI_IN_PLACE`    | `false` | In-place no-clone profile: when the dispatched source is a `file://` local source, the agent uses that source's real repository path as the job work directory and skips the git clone. Any other source is unaffected and still clones into a throwaway directory. |

`KICI_IN_PLACE` exists for running an operator's own already-built working tree directly — module-relative paths, installed dependencies, and build output are all present because nothing is copied. See [Local development plane](../orchestrator/local-dev-plane.md).

## Between-jobs lifecycle (reused agents)

A reused agent serves many jobs in turn on a shared host (the bare-metal / in-place profiles). After every job it runs a supervisor-owned cleanup phase, so one job's leftovers never reach the next. The phase, in order: reap the finished job's process tree, re-run declared cleanup out-of-band if the job process was hard-killed, delete the work directory, then run the optional operator reset command. All of it is a no-op on an ephemeral agent, which is discarded after one job.

| Variable                                   | Default   | Effect                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_ORPHAN_CLEANUP`                | `true`    | Reap a finished job's leaked process tree. The agent runs each job in its own process group and signals the whole group when the job ends, so a backgrounded daemon cannot survive into the next job. Set `false` to signal only the runner and leave a backgrounded process alive on purpose. |
| `KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND`    | _(unset)_ | A host-reset command run between jobs (for example, pruning a container cache). Unset disables it. It runs after the reap and work-directory deletion. Fail-open: a failure never fails the finished job and never crashes the agent.                                                          |
| `KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS` | `60000`   | Timeout for the reset command.                                                                                                                                                                                                                                                                 |
| `KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON`     | `always`  | When the reset command runs: `always`, or `on-failure` to run it only after a failed job.                                                                                                                                                                                                      |
| `KICI_AGENT_DRAIN_ON_RESET_FAILURE`        | `false`   | When `true`, the agent stops accepting new jobs after repeated consecutive reset failures, so a persistently dirty host stops taking work.                                                                                                                                                     |

Set a reset command when jobs on a shared host leave state the reap and work-directory deletion do not cover — a container image cache, a package cache, or a scratch mount. The `orphanCleanup` reap and the out-of-band cleanup re-run apply to the bare-metal / in-place profiles; the reset command runs for any backend but is meaningful only where jobs share a host. This phase is the primary cross-job cleanup; the agent's startup temp-directory sweep stays as a backstop.

## Co-located orchestrator guard

Set `KICI_AGENT_IS_ORCHESTRATOR_HOST=true` when the agent shares a host with the orchestrator. A workflow's `restartHost()` step is then refused locally (`refusing to reboot the orchestrator host`), so a fleet-wide reboot workflow cannot take the control plane down with it. Defaults to `false`; the orchestrator refuses the same request independently.

## Bring-up payload source

An ops agent holding the `kici:capability:ssh-transport` capability stages a self-contained agent plus vendored Node runtime onto a fresh box during [init-runner bring-up](../orchestrator/host-roster.md#payload-delivery). By default that payload comes from the orchestrator's own object storage. Two variables, read only by the agent performing the bring-up, override that:

| Variable                 | Effect                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_PAYLOAD_DIR` | Local directory holding version-keyed payloads (`<dir>/<version>/kici-agent-<platform>.tar.gz`) as produced by `kici-admin agent package`. When set, the payload is read from disk instead of pulled from object storage — the air-gapped path. |
| `KICI_AGENT_COMMAND`     | Golden-image escape hatch: a fixed command that starts the init-runner on a target that already ships `kici-agent` and a Node runtime at a known path. When set, payload staging is skipped entirely.                                           |

## Container job requirements

For workflows that specify `container` in their job configuration, the agent executes the job inside a disposable Docker or Podman container.

Requirements:

- A container runtime (Docker or Podman) must be installed and accessible on the agent host
- `KICI_RUNTIME_IMAGE` set to a `kici-agent` image, so the job's image needs neither Node nor git (see [The injected runtime](#the-injected-runtime) below)
- When the agent itself runs in a container, the runtime socket must be mounted into it:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Podman exposes its socket at a different path (`/run/podman/podman.sock` rootful, or `/run/user/<uid>/podman/podman.sock` rootless). Mount that path instead and point `DOCKER_HOST` at it; the agent talks to whichever socket that variable resolves to, falling back to `/var/run/docker.sock`.

The agent:

1. Creates a job container from the specified image (already-present images are used as-is; a missing image is pulled on demand first) with `/workspace` as a container-owned volume
2. Clones the repository on the host, then copies the tree into the container's `/workspace` volume — so the job's image needs no git, and clone credentials never enter it
3. Starts the workflow runner inside the container via a single exec — the dependency install and every step run inside the container
4. Removes the container (and its workspace volume) after job completion

Job containers are hardened by default: all Linux capabilities dropped, no-new-privileges, cgroup PID/memory/CPU caps, and a private tmpfs `/tmp`, tunable via the `KICI_SANDBOX_*` variables above. See [Agent security](../security/agent-security.md) for the full isolation model and the per-job `sandbox:` escape hatch.

Set `KICI_DOCKER_KEEP_FAILED=true` to preserve failed containers for debugging. The container name follows the pattern `kici-sandbox-{jobId}-{timestamp}`.

### What a job image must provide

| Requirement                                                                         | Applies to                                                                | Checked                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| glibc (`/lib64/ld-linux-x86-64.so.2` on x64, `/lib/ld-linux-aarch64.so.1` on arm64) | every container job                                                       | image preflight, before the container is created |
| `/bin/sh`                                                                           | every container job                                                       | image preflight, before the container is created |
| `git` on `PATH`                                                                     | only an image that runs the agent itself (a scaler's per-job-image spawn) | agent startup                                    |
| `bash` on `PATH`                                                                    | only an image that runs the agent itself                                  | agent startup                                    |

Node and npm are never required — both come from the injected runtime. The
preflight runs only when a runtime is injected; without one the image supplies
its own Node and the glibc requirement does not apply. The two startup checks
are not preflighted: the agent exits and the job waits for an agent that never
registers, so the message names the image as the thing that must supply them.

See [Container jobs](../../user/container-jobs.md) for the same table from the
workflow author's side.

### Building the job image from a Dockerfile

A job may point `container` at a Dockerfile in the repository instead of naming
an image. The agent clones, builds, and runs the job in the result.

That needs `docker` or `podman` on the agent host's **`PATH`** — a runtime
socket alone is not enough, because KiCI shells out to the CLI rather than
driving the build over the API. One build path means one set of Dockerfile
semantics: `.dockerignore` and BuildKit behave as they do on the author's own
machine, instead of depending on which agent picked the job up. A host without a
CLI fails the job with a message naming what to install.

The agent reports what it found at registration, as self-reported labels
alongside `kici:os:*` and `kici:arch:*`:

| Label                          | Meaning                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `kici:runtime:docker`          | a docker socket answered — the agent can run a job container |
| `kici:runtime:podman`          | a podman socket answered                                     |
| `kici:runtime:container-build` | a build CLI is on `PATH` — the agent can build a job image   |

The last one is separate on purpose: an agent given only a mounted runtime
socket can **run** a container but not **build** one, because the build shells
out to the CLI. The orchestrator routes a Dockerfile job only to an agent that
reports `kici:runtime:container-build`, so a pool without a CLI is skipped at
routing time rather than failing the job at build time.

You may also name any of these in a job's `runsOn` to steer work yourself.

`KICI_CONTAINER_BUILD_CLI` (`docker` | `podman`) picks which. Unset, the agent
prefers `docker` and falls back to `podman`. Set it explicitly on a host that has
both CLIs but whose container runtime is the other one. The build and the job
container must land on the same daemon; otherwise the sandbox starts on a daemon
that has never seen the image.

The built image is tagged `kici-build:<runId>-<jobName>`, labelled
`kici-managed=true`, and removed when the job finishes. The layer cache is what
makes the next build fast, and it is not a tag, so it survives.

The build runs on the host, outside the job container's hardened posture. The
orchestrator refuses one on an untrusted ref unless the organization opted in
(`kici-admin org-settings allow-untrusted-dockerfile-builds`).

### The injected runtime

A job may name any image, and that image is not required to ship Node. The agent
mounts its own Node build into the job container, read-only at `/opt/kici/node`,
and starts the workflow runner with it.

`KICI_RUNTIME_IMAGE` names where that build comes from: a `kici-agent` image,
which carries it at `/opt/kici`. The agent copies the build out of the image
into a named volume the first time it is needed on that host, then reuses the
volume. Point it at the image whose version matches this agent.

An agent an auto-scaler spawns gets this set for you, from the image the pool is
configured with. Set it yourself on an agent you start by hand.

Two consequences of leaving it unset:

- A `container` job runs on the image's own `node`. That works for an image
  that ships one, and fails for one that does not.
- The image preflight does not run, so a musl image such as `alpine` is not
  refused up front.

`KICI_RUNTIME_NODE_SOURCE` is the alternative for a host that provisions the
build out of band: a directory whose `bin/node` is the runtime, or the name of
a volume holding it. It takes precedence over `KICI_RUNTIME_IMAGE`, and nothing
is copied.

## Authentication

### Orchestrator connection (agent token)

The agent authenticates with the orchestrator using a pre-shared key (PSK) token. When the orchestrator has `KICI_AGENT_AUTH=token` (the default), the agent must provide a valid token via the `KICI_AGENT_TOKEN` environment variable.

**Obtaining a token:**

```bash
# On the orchestrator host (or via the admin CLI)
kici-admin agent register --labels linux,x64
# Save the displayed token -- it cannot be recovered
```

**Configuring the agent:**

```bash
KICI_AGENT_TOKEN=kat_<64 hex chars>
```

**Authentication flow:**

1. Agent connects to the orchestrator's WebSocket endpoint
2. Agent sends `auth.request` with the token before registration
3. Orchestrator validates the token against its SHA-256 hash database
4. On success, orchestrator responds with `auth.success` and the agent proceeds to send `agent.register`
5. On failure, the orchestrator responds with `auth.failure` and closes the connection

**Auth failure behavior:** If authentication fails, the agent logs an error and **permanently stops reconnection**. A bad token cannot self-heal, so retrying wastes resources. Fix the token and restart the agent.

**Scaler-managed agents:** Agents spawned by the orchestrator's auto-scaler receive automatically generated ephemeral tokens. No manual token configuration is needed for scaler-managed agents.

**Unauthenticated mode:** When the orchestrator is configured with `KICI_AGENT_AUTH=none`, agents connect without tokens. The `KICI_AGENT_TOKEN` variable is ignored. This is only safe on trusted networks.

### GitHub token

Set `KICI_GITHUB_TOKEN` for cloning private repositories. The token is passed via git's `http.extraHeader` configuration (not embedded in the URL) to prevent exposure in logs.

If the orchestrator provides a short-lived installation token in the job dispatch, it takes precedence over the agent-local token.

## Graceful shutdown signals

| Signal    | Behavior                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `SIGTERM` | Start graceful shutdown. Wait up to 10s for running jobs to complete, then force-kill child processes and exit.      |
| `SIGINT`  | Same as SIGTERM.                                                                                                     |
| `SIGUSR1` | Enter drain mode. Stop accepting new jobs. Once all active jobs complete, exit cleanly. Use for rolling deployments. |

### Drain mode for zero-downtime deployments

1. Send `SIGUSR1` to the running agent
2. Agent stops accepting new job dispatches
3. Currently running jobs continue to completion
4. Once all jobs finish, agent exits with code 0
5. Start the new agent version

```bash
# In a deployment script
kill -USR1 $(pidof node)
# Wait for exit, then start new version
```

## Reconnection behavior

If the WebSocket connection to the orchestrator drops, the agent automatically reconnects with exponential backoff:

- Initial delay: 1 second
- Multiplier: 1.5x per attempt
- Jitter: 0-50% randomness
- Maximum delay: 60 seconds

Messages generated during disconnection are buffered and flushed on reconnection: up to 10,000 log lines and up to 5,000 other events (job status, heartbeats). This preserves job status and log data even during brief network interruptions.

## Example configurations

### Minimal

```bash
KICI_ORCHESTRATOR_URL=ws://localhost:4000/ws
```

### Production

```bash
KICI_ORCHESTRATOR_URL=ws://orchestrator.internal:4000/ws
KICI_AGENT_ID=agent-prod-01
KICI_LABELS=linux,docker,x86_64
KICI_PORT=8080
KICI_LOG_LEVEL=info
KICI_GITHUB_TOKEN=ghp_xxxx
KICI_MAX_LOG_SIZE_BYTES=10485760
KICI_DEFAULT_STEP_TIMEOUT_MS=3600000
```

## See also

- [Agent Getting Started](getting-started.md) -- deployment guide with Docker and Kubernetes
- [Orchestrator Configuration](../orchestrator/configuration.md) -- environment variables for the orchestrator agents connect to
- [Job Execution Lifecycle](../../architecture/execution/job-execution.md) -- how the agent uses these configuration values during execution
- [Protocol Messages](../../architecture/protocol-messages.md) -- agent-to-orchestrator message schemas
