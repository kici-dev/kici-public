---
title: 'Agent: getting started'
description: Deploy KiCI agents for job execution
---

The KiCI agent is the execution tier of the three-tier architecture. It connects to a customer orchestrator via WebSocket, receives job dispatches, clones repositories, and executes workflow steps.

## Architecture overview

```
GitHub Webhooks
      |
  [Platform Relay]  <-- webhook ingestion, dedup, forwarding
      |
  [Orchestrator] <-- trigger matching, job dispatch, agent management
      |
  [Agent(s)]    <-- repo clone, step execution, log streaming
```

Each agent:

- Connects to the orchestrator via WebSocket
- Registers with an ID, labels, and maximum concurrency
- Receives `job.dispatch` messages when matched by the orchestrator
- Clones the target repository
- Executes steps sequentially (bare-metal or inside Docker/Podman containers)
- Streams logs back to the orchestrator in real-time
- Reports job and step status transitions

## Prerequisites

- **Node.js 24+** (or use the Docker image)
- **git** (required for repository cloning)
- **Docker or Podman** (optional, required only for container-based jobs)
- Network access to the orchestrator WebSocket endpoint

## Running the agent

### Direct execution

```bash
export KICI_ORCHESTRATOR_URL=ws://your-orchestrator:4000/ws
export KICI_LABELS=linux,docker

node packages/agent/dist/server.js
```

### Docker

Build the image from the repository root:

```bash
docker build -f packages/agent/Dockerfile -t kici-agent .
```

Run the container:

```bash
docker run -d \
  --name kici-agent \
  -e KICI_ORCHESTRATOR_URL=ws://orchestrator:4000/ws \
  -e KICI_LABELS=linux,docker \
  -p 8080:8080 \
  kici-agent
```

### Docker Compose

Example with orchestrator and agent:

```yaml
services:
  orchestrator:
    image: kici-orchestrator
    ports:
      - '4000:4000'
    environment:
      KICI_MODE: independent
      KICI_DATABASE_URL: postgres://kici:secret@postgres:5432/kici
      KICI_SECRET_KEY: '${KICI_SECRET_KEY}'
      KICI_BOOTSTRAP_ADMIN_TOKEN: '${KICI_BOOTSTRAP_ADMIN_TOKEN}'

  agent:
    image: kici-agent
    environment:
      KICI_ORCHESTRATOR_URL: ws://orchestrator:4000/ws
      KICI_LABELS: linux,docker
    ports:
      - '8080:8080'
    # Mount Docker socket for container-based jobs
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

## Connection flow

1. Agent starts and loads configuration from environment variables
2. Agent connects to orchestrator via WebSocket at `KICI_ORCHESTRATOR_URL`
3. Agent sends `agent.register` with its ID and labels
4. Agent transitions to "registered" state and starts sending heartbeats
5. Orchestrator dispatches matching jobs based on agent labels
6. Agent executes jobs and reports status back via WebSocket
7. On disconnect, agent auto-reconnects with exponential backoff

## Health checks

The agent exposes three HTTP endpoints for monitoring:

| Endpoint       | Purpose            | Response                                  |
| -------------- | ------------------ | ----------------------------------------- |
| `GET /health`  | Liveness probe     | Always 200 with status info               |
| `GET /ready`   | Readiness probe    | 200 when connected, 503 when disconnected |
| `GET /metrics` | Prometheus metrics | All `kici_agent_*` metrics                |

Configure Kubernetes probes:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
```

## Monitoring

The agent exports Prometheus metrics with the `kici_agent_` prefix:

| Metric                              | Type      | Description                            |
| ----------------------------------- | --------- | -------------------------------------- |
| `kici_agent_jobs_total`             | Counter   | Total completed jobs (labels: status)  |
| `kici_agent_jobs_active`            | Gauge     | Currently running jobs                 |
| `kici_agent_steps_total`            | Counter   | Total completed steps (labels: status) |
| `kici_agent_step_duration_seconds`  | Histogram | Step execution duration                |
| `kici_agent_clone_duration_seconds` | Histogram | Git clone duration                     |
| `kici_agent_log_bytes_total`        | Counter   | Total log bytes streamed               |
| `kici_agent_connection_status`      | Gauge     | WebSocket connection (0/1)             |

## Graceful shutdown

The agent handles two shutdown signals:

- **SIGTERM / SIGINT**: Graceful shutdown with a 10-second grace period. Running jobs are allowed to complete. If jobs are still running after 10 seconds, child processes are force-killed.

- **SIGUSR1**: Drain mode. The agent stops accepting new jobs but continues running current ones. Once all active jobs complete, the agent shuts down cleanly. Use this for rolling deployments.

## See also

- [Configuration reference](configuration.md) -- all environment variables for the agent
- [Orchestrator getting started](../orchestrator/getting-started.md) -- deploy the orchestrator that agents connect to
- [Job execution lifecycle](../../architecture/execution/job-execution.md) -- how the agent executes jobs end-to-end
- [Reconnection and event buffering](../../architecture/clustering/reconnection.md) -- agent reconnection behavior and log buffering
