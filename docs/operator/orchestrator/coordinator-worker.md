---
title: Coordinator/worker deployment
description: Deploy orchestrator workers for lightweight edge execution without PostgreSQL or S3
---

Workers are orchestrators in `worker` mode that connect to a coordinator via P2P WebSocket, receive routed jobs, execute them, and report results back. Workers need no PostgreSQL, no S3 credentials, and no Platform connection -- just the orchestrator binary, a scaler config, and a WebSocket connection to the coordinator.

## When to use workers

- **Edge execution** -- run agents on a Mac mini, Raspberry Pi, or cloud VM without deploying PostgreSQL alongside it
- **Multi-site deployment** -- execute jobs on machines in different locations, all coordinated centrally
- **Dedicated execution pools** -- isolate workloads by having different workers with different scaler configs (e.g., x64 containers vs. ARM64 bare-metal)

## Quick start

### 1. Create a worker join token on the coordinator

```bash
kici-admin peer create-token --role worker
```

This outputs a one-time join token (e.g., `kici_join_v1.xxx.yyy`).

### 2. Start the worker

```bash
KICI_CLUSTER_ROLE=worker \
KICI_CLUSTER_COORDINATOR_URL=ws://coordinator-host:4000/ws/peer \
KICI_CLUSTER_JOIN_TOKEN=kici_join_v1.xxx.yyy \
KICI_CLUSTER_INSTANCE_ID=mac-mini-1 \
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml \
node packages/orchestrator/dist/server.js
```

### 3. Verify connection

```bash
# On the coordinator:
curl -s http://coordinator-host:4000/cluster/health | jq .
# Should show connectedPeers: 1

# On the worker:
curl -s http://worker-host:4000/status | jq .
# Should show instanceId, role: "worker", coordinatorConnection: "connected"
```

## Required environment variables

| Variable                       | Required         | Description                                                                                         |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| `KICI_CLUSTER_ROLE`            | Yes              | Set to `worker`                                                                                     |
| `KICI_CLUSTER_COORDINATOR_URL` | Yes              | WebSocket URL of the coordinator's peer endpoint (e.g., `ws://coordinator:4000/ws/peer`)            |
| `KICI_CLUSTER_JOIN_TOKEN`      | First start only | One-time join token from the coordinator. After first connection, a persistent credential is issued |
| `KICI_CLUSTER_CREDENTIAL_FILE` | No               | Path to store the persistent credential (default: `~/.kici/peer-credential`)                        |
| `KICI_CLUSTER_INSTANCE_ID`     | No               | Human-readable instance ID (default: random UUID). Recommended for observability                    |
| `KICI_SCALER_CONFIG_PATH`      | Yes              | Path to the scaler config for local agents                                                          |
| `KICI_PORT`                    | No               | HTTP port for the worker's health/status endpoints (default: 4000)                                  |
| `KICI_LOG_LEVEL`               | No               | Log level (default: `info`)                                                                         |

## What workers do NOT need

Workers skip the following subsystems entirely:

| Not needed                                  | Why                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `KICI_DATABASE_URL`                         | No PostgreSQL -- workers use in-memory stores                                   |
| `KICI_PLATFORM_URL` / `KICI_PLATFORM_TOKEN` | Workers don't connect to Platform directly                                      |
| `KICI_SECRET_KEY`                           | No secrets store -- workers receive secrets in the job reroute payload          |
| Provider credentials (sources table)        | No provider credentials -- coordinator handles all webhook/check API operations |
| S3 credentials (`AWS_ACCESS_KEY_ID`, etc.)  | Workers' agents use pre-signed URLs from the coordinator                        |

## Scaler configuration

Workers use the same `scalers.yaml` format as coordinators. Configure the scaler to match the worker machine's capabilities:

```yaml
# /etc/kici/scalers.yaml (worker on a Mac mini)
version: 1
scalers:
  - name: mac-mini-containers
    type: container
    maxAgents: 4
    orchestratorUrl: ws://localhost:4000/ws
    labelSets:
      - labels: [self-hosted, macos, arm64]
        image: kici-agent:latest
```

The coordinator routes jobs to workers based on label matching. A job with `runs-on: [self-hosted, macos, arm64]` will be routed to a worker whose scaler advertises those labels.

## Monitoring

### HTTP endpoints

Workers expose the following endpoints:

| Endpoint          | Method | Description                                                   |
| ----------------- | ------ | ------------------------------------------------------------- |
| `/health`         | GET    | Basic health check (HTTP 200 if running)                      |
| `/ready`          | GET    | Readiness check (always HTTP 200; no coordinator check wired) |
| `/status`         | GET    | Instance info, recent job history, connection state           |
| `/drain`          | POST   | Initiate graceful drain                                       |
| `/cluster/health` | GET    | Cluster health including peer connection state                |

### `/status` response

```json
{
  "instanceId": "mac-mini-1",
  "role": "worker",
  "coordinatorConnection": "connected",
  "draining": false,
  "uptimeSeconds": 3600,
  "agents": {
    "total": 2,
    "active": 1,
    "idle": 1
  },
  "activeJobs": 1,
  "recentJobs": [
    {
      "jobId": "abc123",
      "jobName": "build",
      "workflowName": "ci",
      "status": "success",
      "startedAt": "2026-03-22T10:00:00Z",
      "completedAt": "2026-03-22T10:02:30Z",
      "durationMs": 150000
    }
  ]
}
```

### Loki log fields

Worker log lines emit structured JSON parsed into per-line Loki structured metadata. Grafana Alloy attaches the low-cardinality `service` and `instance` labels at ingest time:

| Field       | Example        | Source                               | Description                                                |
| ----------- | -------------- | ------------------------------------ | ---------------------------------------------------------- |
| `service`   | `orchestrator` | Loki label (Alloy)                   | Service name (same binary as the coordinator)              |
| `instance`  | `mac-mini-1`   | Loki label (Alloy, from instance ID) | Per-process disambiguator from the cluster instance ID env |
| `requestId` | UUID           | Structured metadata                  | Webhook trace ID (when present)                            |
| `runId`     | UUID           | Structured metadata                  | Execution run ID (when in run context)                     |
| `jobId`     | UUID           | Structured metadata                  | Job ID (when in job context)                               |

Filter for one worker's logs in LogQL: `{service="orchestrator", instance="mac-mini-1"}`. To page across every worker in a cluster, query by the workers' instance IDs (the coordinator/worker distinction is not a log label — it is inferred from the instance ID set per process).

## Drain and upgrade

Workers support two drain mechanisms:

### 1. SIGTERM (graceful shutdown)

```bash
kill -TERM <worker-pid>
# or: systemctl stop kici-worker
```

The worker stops accepting new jobs, waits for in-flight jobs to complete (up to 5-minute timeout), then disconnects from the coordinator and exits.

### 2. Drain command

```bash
kici admin drain-worker --url http://worker-host:4000
```

`kici admin drain-worker` wraps the worker's `/drain` endpoint; to call it directly:

```bash
curl -X POST http://worker-host:4000/drain
```

Enters drain mode: the worker stops accepting new jobs (rerouted jobs are NAKed) and in-flight jobs are allowed to finish. The process does not exit automatically -- use SIGTERM after draining to stop the worker.

### Upgrade procedure

Workers are stateless, so upgrading is straightforward:

1. **Drain the worker** -- use either of the two mechanisms above
2. **Replace the binary** -- deploy the new version
3. **Restart** -- the worker reconnects using its persisted credential (no new join token needed)

Coordinators and workers can be upgraded in any order as long as both support the same minimum protocol version. When a protocol version bump occurs (documented in release notes), upgrade all nodes to the new version.

## Troubleshooting

### Protocol version rejected

**Symptom:** Worker logs show "Unsupported protocol version" or close code 4005

**Fix:** Upgrade the worker binary to a version that supports the coordinator's minimum protocol version. Check release notes for protocol version changes.

### Coordinator unreachable

**Symptom:** Worker logs show repeated "Connection to coordinator failed" messages

**Checks:**

1. Verify `KICI_CLUSTER_COORDINATOR_URL` is correct and reachable
2. Check firewall rules allow WebSocket connections to the coordinator port
3. Verify the coordinator is running and healthy (`curl coordinator:4000/health`)
4. If using a reverse proxy, ensure WebSocket upgrade is supported

### NAK storms

**Symptom:** Coordinator logs show many "NAK from worker" messages, jobs not executing

**Causes:**

- Worker's agents are at max concurrency -- increase `maxAgents` in `scalers.yaml`
- Worker's labels don't match the jobs -- check `runs-on` labels vs scaler `labelSets`
- Worker's scaler is failing to spawn agents -- check worker logs for container/bare-metal errors

The coordinator applies NAK backoff automatically: after repeated NAKs from the same worker, it deprioritizes that worker temporarily.

### Worker not receiving jobs

**Symptom:** Worker is connected but no jobs are being routed to it

**Checks:**

1. Verify the worker appears in `/cluster/health` on the coordinator (connectedPeers > 0)
2. Verify the worker's scaler labels match the job labels
3. Verify the coordinator has no local agents that match first (local dispatch takes priority)
4. Check the coordinator's logs for routing decisions

## Deployment example: Docker Compose

```yaml
services:
  coordinator:
    image: kici-orchestrator:latest
    environment:
      MODE: platform
      KICI_DATABASE_URL: postgres://user:pass@db:5432/kici
      KICI_PLATFORM_URL: ws://platform:10142/ws
      KICI_PLATFORM_TOKEN: ${API_KEY}
      KICI_SECRET_KEY: ${SECRET_KEY}
      KICI_CLUSTER_ADDRESS: ws://coordinator:4000
    ports:
      - '4000:4000'

  worker:
    image: kici-orchestrator:latest
    environment:
      KICI_CLUSTER_ROLE: worker
      KICI_CLUSTER_COORDINATOR_URL: ws://coordinator:4000/ws/peer
      KICI_CLUSTER_JOIN_TOKEN: ${WORKER_JOIN_TOKEN}
      KICI_CLUSTER_INSTANCE_ID: worker-1
      KICI_SCALER_CONFIG_PATH: /config/scalers.yaml
    volumes:
      - ./scalers.yaml:/config/scalers.yaml:ro
      - /run/podman/podman.sock:/run/podman/podman.sock:rw
    ports:
      - '4001:4000'
```
