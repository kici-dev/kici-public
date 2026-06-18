---
title: Deploying the KiCI orchestrator
description: Deploy the orchestrator with Docker or standalone Node.js
---

This guide walks through deploying the KiCI customer orchestrator. The orchestrator is the execution brain of the KiCI CI/CD system -- it receives webhook events, fetches lock files, performs trigger matching, and dispatches jobs to connected agents.

## Overview

The KiCI orchestrator runs in your infrastructure, giving you full control over your CI/CD execution environment. It:

- Receives webhook events (via Platform relay or direct GitHub webhook endpoint)
- Fetches `kici.lock.json` from repositories via the GitHub API
- Matches webhook payloads against workflow trigger configurations
- Dispatches matched jobs to connected agents via WebSocket
- Routes jobs to agents using label-based matching (e.g., `linux`, `docker`, `x64`)
- Reports execution events back to KiCI Platform for observability (in connected modes)

## Three deployment modes

The orchestrator supports three operating modes. Set the mode via the `KICI_MODE` environment variable (read at startup by `server.ts` / `standalone.ts`) or via `KICI_INSTANCE_MODE` / `instance.mode:` in a YAML config file (the resolver-based path documented in [configuration.md](configuration.md)). Both paths accept the same three values. **Mode is optional and defaults to `platform`** — but the orchestrator will refuse to boot if the credentials the chosen mode requires (see "Requirements" column below) aren't present.

```
Mode: platform (default)
  GitHub  -->  Platform Relay  --WS-->  Orchestrator  --WS-->  Agents
                                    (your infra)          (your infra)
  Webhooks arrive exclusively via the Platform WebSocket relay.
  Requires KICI_PLATFORM_URL and KICI_PLATFORM_TOKEN.

Mode: hybrid
  GitHub  -->  Platform Relay  --WS-->  Orchestrator  --WS-->  Agents
  GitHub  -->  (direct webhook) -->  |             (your infra)
  Webhooks arrive via both Platform relay AND direct HTTP endpoints.
  Deduplication prevents double-processing.
  Requires KICI_PLATFORM_URL and KICI_PLATFORM_TOKEN. Per-source webhook secrets
  for direct ingestion live in the orchestrator DB
  (kici-admin source add ... → orchestrator-side sources table rows).

Mode: independent
  GitHub  -->  Orchestrator  --WS-->  Agents
               (your infra)          (your infra)
  Webhooks arrive exclusively via direct HTTP endpoints.
  No Platform connection. Fully self-contained.
  Per-source webhook secrets live in the orchestrator DB.
```

### When to use which mode

| Mode          | Best For                                   | Platform Dashboard | Direct Webhooks | Requirements                          |
| ------------- | ------------------------------------------ | ------------------ | --------------- | ------------------------------------- |
| `platform`    | Standard deployment                        | Yes                | No              | Platform API key                      |
| `hybrid`      | Resilience, self-hosted webhook ingress    | Yes                | Yes             | Platform API key + per-source secrets |
| `independent` | Full independence, air-gapped environments | No                 | Yes             | Per-source secrets in DB              |

### Webhook secrets are per-source

There is **no global `WEBHOOK_SECRET` env var**. Every webhook source has its own secret, registered via `kici-admin source add github ...` (or `source add generic ...`) and stored encrypted in the orchestrator DB. Direct HTTP webhook ingestion flows through `POST /webhook/:orgId/generic/:sourceId`, and the orchestrator reads the secret for that source from its `scoped_secrets` table on demand via `PgSecretStore`. See [Registering a GitHub App](#registering-a-github-app) below for the per-source registration flow.

## Prerequisites

Before deploying, ensure you have:

- **Container runtime**: Docker or [Podman](https://podman.io/) installed
- **GitHub App**: A GitHub App with webhook permissions configured (App ID, private key, webhook secret). These are registered after startup via `kici-admin source add github` -- see [Registering a GitHub App](#registering-a-github-app) below.
- **Database**: PostgreSQL 18+
- **For platform/hybrid modes**: A KiCI Platform API key (`KICI_PLATFORM_TOKEN`) and relay URL (`KICI_PLATFORM_URL`). See [Creating an orchestrator API key](#creating-an-orchestrator-api-key) below.

## Creating an orchestrator API key

Orchestrator API keys authenticate the WebSocket connection between the orchestrator and the Platform relay. You create one in the dashboard (or it is issued to you) and configure it on the orchestrator as `KICI_PLATFORM_TOKEN`; the orchestrator presents it when it connects to the relay.

### Dashboard UI (recommended)

The preferred method is through the KiCI dashboard:

1. Navigate to your organization's **Settings** page
2. Select the **Orchestrator keys** tab
3. Click **Create orchestrator key**
4. Enter a name (e.g., `prod-orchestrator`) and optionally add routing patterns
5. Copy the generated key immediately -- it is shown only once

The dashboard also supports managing routing permissions (add/remove patterns) and revoking keys.

### Routing key permissions

Routing key patterns control which webhook sources the orchestrator is allowed to receive. Patterns use the format `provider:id` (e.g., `github:12345` for a specific GitHub App, or `github:*` for all GitHub Apps). If no routing patterns are specified, the orchestrator can receive webhooks from all sources in its organization.

### Key characteristics

- Orchestrator API keys have **no role or permission matrix** — they are simple bearer tokens scoped to an organization
- Keys can be optionally restricted to specific routing key patterns
- Keys are soft-revoked via `revoked_at` timestamp (not deleted)
- Key prefix (first 16 characters) is stored for identification in listings

## Quick start

### Platform mode (default)

The simplest deployment. Webhooks flow through the KiCI Platform relay.

```bash
docker run -d \
  --name kici-orchestrator \
  -p 4000:4000 \
  -e KICI_MODE=platform \
  -e KICI_PLATFORM_URL=wss://platform.kici.dev/ws \
  -e KICI_PLATFORM_TOKEN=your-api-key \
  -e KICI_DATABASE_URL=postgresql://kici:password@postgres:5432/kici \
  -e KICI_SECRET_KEY=your-64-char-hex-master-key \
  -e KICI_BOOTSTRAP_ADMIN_TOKEN=your-admin-token \
  kici-orchestrator:latest
```

After startup, register your GitHub App (see [Registering a GitHub App](#registering-a-github-app) below).

### Independent mode

No Platform dependency. Configure your GitHub App to send webhooks directly to the orchestrator.

```bash
docker run -d \
  --name kici-orchestrator \
  -p 4000:4000 \
  -e KICI_MODE=independent \
  -e KICI_DATABASE_URL=postgresql://kici:password@postgres:5432/kici \
  -e KICI_SECRET_KEY=your-64-char-hex-master-key \
  -e KICI_BOOTSTRAP_ADMIN_TOKEN=your-admin-token \
  kici-orchestrator:latest \
  node packages/orchestrator/dist/standalone.js
```

Note: Independent mode uses `standalone.js` as the entry point. Override the default CMD as shown. After startup, register your GitHub App (and any other webhook sources) with `kici-admin source add github` — webhook secrets are stored per-source in the orchestrator DB, not in env vars.

### Hybrid mode

Receives webhooks from both the Platform relay and direct per-source webhook endpoints.

This mode is also the right choice when you want to **bypass the Platform for webhook ingestion entirely while still keeping observability on the Platform dashboard**. Point your webhook provider directly at the orchestrator's `POST /webhook/<orgId>/generic/<sourceId>` endpoint (the source — and its per-source secret — is registered with `kici-admin source add ...` after startup) and omit the Platform relay delivery. The orchestrator still maintains its Platform WebSocket connection, so it forwards execution runs, job and step status, decision traces, and log chunks (`execution.status`, `job.status.forward`, `step.status.forward`, `execution.event`, `log.chunk`) — the dashboard continues to show every run end-to-end. Only the Platform-side `event_log` webhook delivery record is skipped for webhooks that never pass through the Platform; the orchestrator's own per-delivery dedup log and metrics still capture them.

```bash
docker run -d \
  --name kici-orchestrator \
  -p 4000:4000 \
  -e KICI_MODE=hybrid \
  -e KICI_PLATFORM_URL=wss://platform.kici.dev/ws \
  -e KICI_PLATFORM_TOKEN=your-api-key \
  -e KICI_DATABASE_URL=postgresql://kici:password@postgres:5432/kici \
  -e KICI_SECRET_KEY=your-64-char-hex-master-key \
  -e KICI_BOOTSTRAP_ADMIN_TOKEN=your-admin-token \
  kici-orchestrator:latest
```

## Docker Compose example

A production-ready setup with PostgreSQL:

```yaml
services:
  orchestrator:
    image: kici-orchestrator:latest
    ports:
      - '4000:4000'
    environment:
      KICI_MODE: platform
      KICI_PORT: 4000
      KICI_PLATFORM_URL: '${KICI_PLATFORM_URL}'
      KICI_PLATFORM_TOKEN: '${KICI_PLATFORM_TOKEN}'
      KICI_DATABASE_URL: postgresql://kici:${POSTGRES_PASSWORD}@postgres:5432/kici
      KICI_SECRET_KEY: '${KICI_SECRET_KEY}'
      KICI_BOOTSTRAP_ADMIN_TOKEN: '${KICI_BOOTSTRAP_ADMIN_TOKEN}'
      KICI_LOG_LEVEL: info
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:18.3-trixie
    environment:
      POSTGRES_DB: kici
      POSTGRES_USER: kici
      POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U kici -d kici']
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

For independent mode, override the command:

```yaml
orchestrator:
  # ... same as above, but:
  command: ['node', 'packages/orchestrator/dist/standalone.js']
  environment:
    KICI_MODE: independent
    KICI_DATABASE_URL: postgresql://kici:${POSTGRES_PASSWORD}@postgres:5432/kici
    KICI_SECRET_KEY: '${KICI_SECRET_KEY}'
    KICI_BOOTSTRAP_ADMIN_TOKEN: '${KICI_BOOTSTRAP_ADMIN_TOKEN}'
    # No KICI_PLATFORM_URL or KICI_PLATFORM_TOKEN needed.
    # Webhook secrets are per-source: register sources with `kici-admin source add ...`
    # after first startup; secrets are stored encrypted in the orchestrator DB.
```

## Registering a GitHub App

After the orchestrator is running, register your GitHub App as a webhook source using the `kici-admin` CLI:

```bash
kici-admin --url http://localhost:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN \
  source add github \
  --name my-org \
  --app-id 123456 \
  --private-key @/path/to/private-key.pem \
  --webhook-secret your-github-webhook-secret
```

This stores the GitHub App credentials in the orchestrator database (encrypted with `KICI_SECRET_KEY`). The orchestrator starts accepting webhooks from this app immediately -- no restart needed.

To list configured sources:

```bash
kici-admin --url http://localhost:4000 --token $KICI_BOOTSTRAP_ADMIN_TOKEN source list
```

For the full source management reference, see [kici-admin CLI reference](kici-admin-cli.md).

## Database

PostgreSQL is the only supported database backend. `KICI_DATABASE_URL` is always required.

```env
KICI_DATABASE_URL=postgresql://kici:password@postgres:5432/kici
```

PostgreSQL 18+ is recommended. The orchestrator uses a typed SQL query layer against the PostgreSQL dialect.

### Migrations

Database schema is managed by typed SQL migrations. Migrations are applied automatically on first startup. Migration files are in `packages/orchestrator/src/db/migrations/`.

## Agent connections

Agents connect to the orchestrator via WebSocket at the `/ws` endpoint:

```
ws://orchestrator-host:4000/ws
```

Agents must send an `agent.register` message within 10 seconds of connecting. The registration includes:

- `agentId`: Unique agent identifier
- `labels`: Array of capability labels (e.g., `["linux", "docker", "x64"]`)
- `maxConcurrency`: Maximum concurrent jobs this agent can handle (defaults to 1)
- `platform` / `arch`: Agent OS and architecture (optional, used for label-based routing)

The orchestrator dispatches jobs to agents whose labels match the job's `runs-on` requirements using label-based routing.

## Health check

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-02-08T12:00:00.000Z",
  "uptime": 42.5
}
```

## Webhook visibility

Every inbound webhook the orchestrator handles (relay or direct) is recorded in the orchestrator's `event_log` table with metadata + a pointer to the gzipped payload in object storage. The dashboard's **Settings → Event log** tab exposes this surface, joined with the Platform-side delivery record on `(org_id, delivery_id)`. Operators can also dogfood it via `kici-admin event-log list` / `event-log show <deliveryId>`. See [`docs/operator/observability/observability.md`](../observability/observability.md) and [`docs/user/dashboard/settings.md#event-log`](../../user/dashboard/settings.md#event-log).

## Prometheus metrics

```bash
curl http://localhost:4000/metrics
```

Returns Prometheus text format with `kici_*` prefixed metrics including:

- `kici_webhooks_received_total` -- Total webhooks received
- `kici_webhooks_processed_total` -- Total webhooks processed (with decision)
- `kici_trigger_match_duration_seconds` -- Trigger matching latency
- `kici_lockfile_cache_hits_total` / `kici_lockfile_cache_misses_total` -- Cache performance
- `kici_agents_active` -- Connected agent count
- `kici_dispatch_queue_depth` -- Pending jobs in dispatch queue
- `kici_jobs_dispatched_total` -- Total jobs dispatched to agents
- `kici_platform_connection_status` -- Platform relay connection state
- `kici_dedup_hits_total` -- Deduplicated webhook count

## Building the image

From the repository root:

```bash
docker build -t kici-orchestrator:latest -f packages/orchestrator/Dockerfile .
```

Or with Podman:

```bash
podman build -t kici-orchestrator:latest -f packages/orchestrator/Dockerfile .
```

The Dockerfile uses a multi-stage build: the first stage installs all dependencies and builds TypeScript, the second stage copies only production dependencies and compiled output.

## Container runtime requirements

When running the orchestrator in a container with the auto-scaler enabled (container backend), the container **must** be started with `NET_ADMIN` capability for agent network isolation:

```bash
# Docker
docker run --cap-add=NET_ADMIN kici-orchestrator:latest

# Podman
podman run --cap-add=NET_ADMIN kici-orchestrator:latest
```

The orchestrator image includes the `nftables` binary. If the `NET_ADMIN` capability is not granted, the orchestrator will **refuse to start** with a clear error message. This is intentional -- network isolation for agent containers is a security requirement, not optional.

> **Note:** `NET_ADMIN` grants permission to manage network firewall rules. It does **not** grant full root access. Use `--cap-add=NET_ADMIN` instead of `--privileged`.

### Docker Compose setup

Add the capability in your Compose file:

```yaml
services:
  orchestrator:
    image: kici-orchestrator:latest
    cap_add:
      - NET_ADMIN
    # ... other configuration
```

### Troubleshooting

If the orchestrator fails to start with `nftables operation denied -- missing NET_ADMIN capability`, add `--cap-add=NET_ADMIN` to your container run command or `cap_add: [NET_ADMIN]` in your Compose file.

If the error is `nftables binary not found`, you may be running a custom image that was not built from the official Dockerfile. Ensure the image includes `nftables` (`apk add --no-cache nftables` for Alpine-based images).

## Reverse proxy setup

The `KICI_BASE_PATH` environment variable configures a URL prefix for all routes. This is useful when running behind a reverse proxy at a subpath.

With `KICI_BASE_PATH=/orchestrator`:

- Health: `https://your-domain.example/orchestrator/health`
- Webhooks: `https://your-domain.example/orchestrator/webhook/<orgId>/generic/<sourceId>`
- Agent WS: `wss://your-domain.example/orchestrator/ws`
- Metrics: `https://your-domain.example/orchestrator/metrics`

### Caddy example

```caddyfile
your-domain.example {
    handle_path /orchestrator/* {
        reverse_proxy localhost:4000
    }
}
```

### One port for every source

The orchestrator binds a single HTTP listener at `KICI_PORT`. Every registered webhook source (GitHub Apps and generic) is served from that one listener, distinguished by URL path (`/webhook/<orgId>/github`, `/webhook/<orgId>/generic/<sourceId>`) rather than by port number. There is no per-source port option in `kici-admin source add` and no `port` column on the source row — if you need different public URLs / hostnames / TLS certs per source, terminate that mapping at your reverse proxy and have it forward to the orchestrator's single port. See [Multi-Provider Setup](configuration.md#multi-provider-setup) for the full discussion.

## See also

- [Configuration reference](configuration.md) -- full list of environment variables
- [Agent getting started](../agent/getting-started.md) -- deploy agents to execute jobs
- [Webhook delivery flow](../../architecture/webhooks/webhook-delivery.md) -- end-to-end trace from GitHub to agent
- [Reconnection and event buffering](../../architecture/clustering/reconnection.md) -- WebSocket resilience and backoff
- [Architecture overview](../../architecture/overview.md) -- three-tier model and package structure
