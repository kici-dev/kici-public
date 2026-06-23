---
title: 'Agent: configuration reference'
description: Environment variables, labels, Docker executor setup
---

> **See also:** [Environment variable reference](../env-reference.md) — shared env vars; agent-specific vars are listed below. Regenerate the generated table with `pnpm docs:env`. Unknown `KICI_*` env vars cause the agent to refuse to start (typo catcher); set `KICI_DEV=true` for warn-only behaviour during local development.

All agent configuration is provided via environment variables.

## Environment variables

These environment variables are specific to the agent. Variables shared across
KiCI services (log level, OpenTelemetry endpoint, heartbeat/concurrency timeouts)
and the rotated-file logger live in the [environment variable reference](../env-reference.md).

<!-- BEGIN GENERATED: agent-env (do not edit; run pnpm docs:env) -->

| Env var                                | Required | Default    | Type                                    | Aliases | Description |
| -------------------------------------- | -------- | ---------- | --------------------------------------- | ------- | ----------- |
| `KICI_AGENT_ID`                        | no       |            | string                                  |         |             |
| `KICI_AGENT_TOKEN`                     | no       |            | string                                  |         |             |
| `KICI_BACKPRESSURE_MODE`               | no       | "pause"    | enum:pause\|drop                        |         |             |
| `KICI_DEFAULT_STEP_TIMEOUT_MS`         | no       | 1800000    | number                                  |         |             |
| `KICI_DOCKER_KEEP_FAILED`              | no       | "false"    | string                                  |         |             |
| `KICI_EXECUTION_MODE`                  | no       |            | enum:container\|bare-metal\|firecracker |         |             |
| `KICI_GITHUB_TOKEN`                    | no       |            | string                                  |         |             |
| `KICI_LABELS`                          | no       |            | string                                  |         |             |
| `KICI_MAX_LOG_SIZE_BYTES`              | no       | 10485760   | number                                  |         |             |
| `KICI_ORCHESTRATOR_URL`                | yes      |            | string                                  |         |             |
| `KICI_PORT`                            | no       | 8080       | number                                  |         |             |
| `KICI_PROPERTIES`                      | no       |            | string                                  |         |             |
| `KICI_ROLES`                           | no       |            | string                                  |         |             |
| `KICI_SANDBOX`                         | no       | "false"    | string                                  |         |             |
| `KICI_SANDBOX_NETWORK`                 | no       | "isolated" | enum:isolated\|host                     |         |             |
| `KICI_SCALER_IDLE_TIMEOUT`             | no       | 5000       | number                                  |         |             |
| `KICI_SCALER_MANAGED`                  | no       |            | string                                  |         |             |
| `KICI_SCALER_PENDING_DISPATCH_TIMEOUT` | no       | 60000      | number                                  |         |             |

<!-- END GENERATED: agent-env -->

## Health and metrics endpoints

The agent exposes three HTTP endpoints on the configured `KICI_PORT`:

| Endpoint   | Purpose            | Response                                                                     |
| ---------- | ------------------ | ---------------------------------------------------------------------------- |
| `/health`  | Liveness probe     | Always `200`. Body includes `agentId`, `activeJobs`, and `connected` status. |
| `/ready`   | Readiness probe    | `200` when connected to orchestrator, `503` when disconnected.               |
| `/metrics` | Prometheus metrics | Prometheus text format with `kici_agent_` prefixed metrics.                  |

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

## Docker job requirements

For workflows that specify `container` in their job configuration, the agent executes steps inside Docker containers.

Requirements:

- Docker must be installed and accessible on the agent host
- The Docker socket must be mounted into the agent container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

The agent:

1. Pulls the specified container image
2. Creates a container with the cloned repo mounted at `/workspace`
3. Runs each step command inside the container via `docker exec`
4. Removes the container after job completion

Set `KICI_DOCKER_KEEP_FAILED=true` to preserve failed containers for debugging. The container name follows the pattern `kici-sandbox-{jobId}-{timestamp}`.

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

Messages generated during disconnection are buffered (up to 10,000 log lines) and flushed on reconnection. This preserves job status and log data even during brief network interruptions.

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
