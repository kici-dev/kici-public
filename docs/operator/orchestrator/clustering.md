---
title: Multi-orchestrator clustering
description: Deploy orchestrators in a cluster for high availability, cross-architecture routing, and dedicated coordinator topologies
---

KiCI supports running multiple orchestrators in a cluster. Clustering enables high availability (HA) through redundancy, cross-architecture job routing (e.g., x64 + ARM64 agents), and dedicated coordinator topologies for large deployments.

Cluster components (Raft consensus, peer registry, health endpoints) are always initialized. A single-orchestrator deployment works unchanged -- Raft dormant mode self-elects as leader immediately with zero overhead. No extra configuration is needed for single-orch deployments.

## Overview

In a cluster, each orchestrator is a full-featured instance that can both receive webhooks and execute jobs. When a webhook arrives, the receiving orchestrator becomes the **run coordinator** for that webhook event. The coordinator matches triggers against the lock file, claims jobs it can dispatch to its own local agents, and reroutes remaining jobs to peers with matching capacity.

Key capabilities:

- **HA pair** -- two identical orchestrators behind the Platform round-robin for redundancy
- **Cross-architecture pools** -- x64 and ARM64 orchestrators with different scalers, same routing key
- **Dedicated coordinator** -- one orchestrator with no scalers (coordinator-only) handles webhook processing while others handle execution
- **Automatic peer discovery** -- in Platform/hybrid modes, the Platform matchmaker tells orchestrators about peers
- **Raft leader election** -- one orchestrator is elected leader for cluster-wide operations like orphan run recovery

## How many clusters?

Most orgs need **one cluster**. A single cluster spans architectures and
hardware shapes through multiple scalers -- x64 containers, ARM64 containers,
bare-metal, Firecracker, GPU pools -- and routes each job to a matching scaler
by its `runs-on` labels. To add capacity or a new agent type (an ARM64 pool, a
GPU pool), **add a scaler, not a cluster**: the x64 + ARM64 pool recipe below
runs one cluster across two architectures, and the
[auto-scaler overview](auto-scaler.md) covers the available backends.

High availability also lives **inside** one cluster: redundancy comes from
running multiple coordinators that share one PostgreSQL (the HA pair recipe
below), not from standing up more clusters.

Reserve a **separate cluster** for a genuine isolation boundary -- a distinct
team that needs its own dashboard write policy, environments, secrets, and
sources. A separate cluster is not the default for every environment, region,
or architecture.

Every additional cluster carries real setup cost: its own sources and webhook
registration, its own join-token bootstrap, its own (possibly divergent)
configuration, and a separate dashboard surface to operate. Prefer **fewer
clusters with more scalers** until an isolation boundary forces a split.

## Prerequisites

### Shared API key (coordinators only)

All **coordinator** orchestrators in a cluster authenticate to the Platform using the **same API key** (`KICI_PLATFORM_TOKEN`). This is by design -- a cluster is a single operator's deployment, and the API key is scoped to that operator's organization. Each coordinator connects independently to the Platform, but they all belong to the same org and share webhook sources, runs, and dashboard data.

**Workers do not need a Platform token.** Workers connect only to their coordinator via P2P WebSocket (`KICI_CLUSTER_COORDINATOR_URL`) and never talk to the Platform relay. They have no database, no S3 credentials, and no API key -- see [coordinator/worker deployment](coordinator-worker.md) for details.

Different operators (customers) must use separate API keys and organizations. Each API key is bound to a single organization on the Platform, so cross-tenant traffic is rejected at the relay before it reaches any orchestrator.

### Shared PostgreSQL (mandatory)

All orchestrators in a cluster **must** share the same PostgreSQL database. This is a hard requirement -- join tokens, peer credentials, Raft state, execution tracking, webhook secrets, cluster metadata, and the dispatch queue all live in this shared database.

The shared database ensures:

- **Join token consumption** is atomic across coordinators (DB transactions prevent races)
- **Peer credentials** are globally visible, so any coordinator can validate a reconnecting peer
- **Cluster identity** (`cluster_id` in `cluster_meta`) is consistent -- at startup, each coordinator validates it reads the same `cluster_id`, preventing accidental misconfiguration where separate clusters point at the same database. When S3 storage is configured, the validation also checks a `<prefix>/.kici-cluster-id` sentinel object so two clusters can safely share a physical bucket if they use distinct `KICI_STORAGE_PREFIX` values. See [cluster identity in multi-orchestrator design](../../architecture/clustering/multi-orchestrator.md#cluster-identity) for the full sentinel contract
- **Credential tracking** records which coordinator last validated each peer (`last_validated_by`), providing operational visibility into connection routing

**Do not** run separate PostgreSQL instances per orchestrator in a cluster. This will cause split-brain: each orchestrator would generate a different `cluster_id`, tokens consumed on one would not be visible to others, and peer credentials would be siloed.

### Peer authentication (join tokens)

Peer-to-peer WebSocket connections use an ECDH key exchange followed by join token or credential authentication. The first orchestrator (coordinator) starts normally. Additional peers join using a one-time join token that authenticates them and issues a persistent credential for subsequent connections.

### Network connectivity

Orchestrators need to reach each other via WebSocket for direct peer connections. Set `KICI_CLUSTER_ADDRESS` to a reachable `host:port` for each orchestrator. Without a reachable address, peers cannot establish direct connections.

In Platform/hybrid modes, orchestrators that cannot reach each other directly fall back to relay through the Platform tier.

## Configuration reference

Cluster configuration uses the `KICI_CLUSTER_*` environment variable prefix.

| Environment Variable                        | Default                   | Required               | Description                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_CLUSTER_JOIN_TOKEN`                   | --                        | First join only        | One-time join token for authenticating with the cluster. Used only on the first connection; a persistent credential is issued after successful authentication.                                                                                                                                                |
| `KICI_CLUSTER_CREDENTIAL_FILE`              | `~/.kici/peer-credential` | --                     | Path to store/load the persistent peer credential. After first join, the orchestrator uses this credential for all subsequent connections.                                                                                                                                                                    |
| `KICI_CLUSTER_INSTANCE_ID`                  | random UUID               | --                     | Unique identifier for this orchestrator instance. Auto-generated if not set.                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_ADDRESS`                      | --                        | When peers set         | This orchestrator's reachable address (e.g., `ws://10.0.0.1:4000`). Required when `KICI_CLUSTER_PEERS` is set.                                                                                                                                                                                                |
| `KICI_CLUSTER_PEERS`                        | --                        | Multi-orch independent | Comma-separated list of peer addresses (e.g., `ws://10.0.0.2:4000,ws://10.0.0.3:4000`). Only needed for multi-orchestrator independent mode (Platform/hybrid uses automatic peer discovery).                                                                                                                  |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS` | `5000`                    | --                     | Minimum Raft election timeout (ms).                                                                                                                                                                                                                                                                           |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS` | `10000`                   | --                     | Maximum Raft election timeout (ms).                                                                                                                                                                                                                                                                           |
| `KICI_CLUSTER_RAFT_HEARTBEAT_MS`            | `2000`                    | --                     | Raft leader heartbeat interval (ms).                                                                                                                                                                                                                                                                          |
| `KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS`   | `30000`                   | --                     | Peer inventory heartbeat interval (ms).                                                                                                                                                                                                                                                                       |
| `KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS`  | `60000`                   | --                     | Maximum delay between peer reconnect attempts (ms).                                                                                                                                                                                                                                                           |
| `KICI_CLUSTER_ROLE`                         | `coordinator`             | For workers            | Cluster role: `coordinator` (default, full orchestrator) or `worker` (delegated execution only). See [Coordinator/worker deployment](coordinator-worker.md).                                                                                                                                                  |
| `KICI_CLUSTER_COORDINATOR_URL`              | --                        | For workers            | WebSocket URL of the coordinator's peer endpoint (e.g., `ws://coordinator:4000/ws/peer`). Required when `KICI_CLUSTER_ROLE=worker`.                                                                                                                                                                           |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`        | `60000`                   | --                     | Timeout in ms after which a peer with no heartbeat is considered stale.                                                                                                                                                                                                                                       |
| `KICI_CLUSTER_AUTO_ROTATE_CREDENTIALS`      | `false`                   | --                     | When `true`, enables automatic rotation of peer credentials. Boolean.                                                                                                                                                                                                                                         |
| `KICI_CLUSTER_TRUSTED_PROXIES`              | --                        | Behind reverse proxy   | Comma-separated list of trusted proxy IPs or CIDR ranges (e.g., `10.0.0.0/8,172.16.0.0/12`). When set, the peer handler extracts the real client IP from `X-Forwarded-For` instead of using the socket IP. Required for correct rate limiting when orchestrators are behind a load balancer or reverse proxy. |

### Mode-specific requirements

- **Single-orchestrator (any mode):** No cluster env vars needed. Cluster components initialize in dormant mode automatically.
- **Multi-orchestrator Platform/hybrid mode:** The first orchestrator starts normally. Additional peers need a join token created by `kici-admin peer create-token`. The Platform matchmaker handles peer discovery automatically.
- **Multi-orchestrator independent mode:** `KICI_CLUSTER_JOIN_TOKEN` (for peers), `KICI_CLUSTER_ADDRESS`, and `KICI_CLUSTER_PEERS` are required because there is no Platform matchmaker for peer discovery.

## Peer authentication flow

Peer authentication uses ECDH (X25519) key exchange to establish an encrypted channel before any credentials are transmitted.

### First join (with token)

1. **Start the coordinator** -- the first orchestrator in the cluster starts normally with `KICI_SECRET_KEY` set
2. **Create a join token** on the coordinator:
   ```bash
   kici-admin peer create-token --role coordinator
   # or for a worker peer:
   kici-admin peer create-token --role worker
   ```
3. **Start the peer** with the join token:
   ```bash
   KICI_CLUSTER_JOIN_TOKEN=kici_join_v1.xxx.yyy
   ```
4. **ECDH handshake** -- the peer and coordinator exchange ephemeral X25519 public keys via `peer.hello` / `peer.hello.response` messages
5. **Encrypted auth** -- the peer sends the join token in an encrypted `peer.auth.request`. The coordinator validates the token and responds with an encrypted `peer.auth.response` containing a session credential
6. **Credential persistence** -- the peer saves the issued credential to `KICI_CLUSTER_CREDENTIAL_FILE` (default: `~/.kici/peer-credential`)
7. **Token consumed** -- the join token is marked as used and cannot be reused

### Subsequent connections (with credential)

After the first join, the orchestrator uses its persisted credential file for all subsequent connections. No join token is needed:

1. The orchestrator loads the credential from `KICI_CLUSTER_CREDENTIAL_FILE`
2. ECDH handshake establishes an encrypted channel
3. The orchestrator sends an HMAC proof of the credential (never the credential itself)
4. The coordinator verifies the HMAC proof using `timingSafeEqual`
5. Connection authenticated -- the peer resumes normal operation

### Security properties

- **No cleartext auth material** -- all authentication happens over the ECDH-encrypted channel
- **One-time tokens** -- join tokens are consumed after use
- **HMAC credential proof** -- credentials are never sent over the wire; only an HMAC proof is transmitted
- **Rate limiting** -- failed authentication attempts are rate-limited (5 attempts per IP within 60 seconds)
- **Post-auth encryption** -- all subsequent messages (heartbeats, reroutes, Raft) use the ECDH-derived session key

## Deployment recipes

### HA pair

Two identical orchestrators sharing the same PostgreSQL, scalers, and routing key. Provides redundancy: if one goes down, the other continues processing webhooks.

```
                 +---> Orchestrator A (coordinator)
  Platform ----+     |
  (round   |     |
   robin)  +-----+
                 |
                 +---> Orchestrator B (peer)
                       joins via token
```

**Step 1: Start Orchestrator A (coordinator):**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_ADDRESS=ws://orchestrator-a:4000
KICI_DATABASE_URL=postgres://user:pass@shared-db:5432/kici
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml
```

**Step 2: Create a join token on Orchestrator A:**

```bash
kici-admin peer create-token --role coordinator
```

**Step 3: Start Orchestrator B with the token:**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_JOIN_TOKEN=kici_join_v1.xxx.yyy
KICI_CLUSTER_ADDRESS=ws://orchestrator-b:4000
KICI_DATABASE_URL=postgres://user:pass@shared-db:5432/kici
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml
```

After the first successful connection, Orchestrator B saves its credential and no longer needs the join token. Subsequent restarts use the persisted credential automatically.

### x64 + ARM64 pool

Two orchestrators with different scalers targeting different architectures. Same routing key so both receive webhooks. Jobs are automatically routed to the orchestrator with agents matching the job's `runs-on` labels.

```
                 +---> Orchestrator A
  Platform ----+     |     scalers: x64 containers
  (round   |     |     agents: [self-hosted, linux, x64]
   robin)  +-----+
                 |
                 +---> Orchestrator B
                       scalers: ARM64 containers
                       agents: [self-hosted, linux, arm64]
```

**Orchestrator A (x64, coordinator):**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_ADDRESS=ws://orch-x64:4000
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers-x64.yaml
```

**Orchestrator B (ARM64, peer -- first start):**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_JOIN_TOKEN=<token-from-orch-a>
KICI_CLUSTER_ADDRESS=ws://orch-arm64:4000
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers-arm64.yaml
```

When a webhook arrives at Orchestrator A and the job requires `arm64` labels, the coordinator reroutes it to Orchestrator B (which has ARM64 agents). The coordinator still handles all check run reporting.

### Dedicated coordinator + workers

One orchestrator with no scalers acts as the coordinator: it processes webhooks, matches triggers, creates check runs, and reroutes all jobs to worker orchestrators. Workers have scalers and agents but delegate check run reporting to the coordinator.

```
                 +---> Coordinator (no scalers)
  Platform ----+     |     handles: webhook processing, check runs
  (round   |     |
   robin)  +-----+---> Worker A (x64 scalers)
                 |     handles: job execution only
                 |
                 +---> Worker B (ARM64 scalers)
                       handles: job execution only
```

**Coordinator:**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_ADDRESS=ws://coordinator:4000
# No KICI_SCALER_CONFIG_PATH -- this orchestrator has no agents
```

**Workers (first start):**

```bash
KICI_MODE=platform
KICI_SECRET_KEY=<64-char-hex-key>
KICI_CLUSTER_JOIN_TOKEN=<token-from-coordinator>
KICI_CLUSTER_ADDRESS=ws://worker-a:4000  # or worker-b
KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml
```

Create separate join tokens for each worker using `kici-admin peer create-token --role worker`.

In this topology, the coordinator always reroutes jobs since it has no local agents. Workers accept rerouted jobs and dispatch to their agents. The coordinator tracks job progress from workers and updates GitHub check runs.

## Storage configuration (SharedConfig)

### S3 recommendation for multi-orchestrator pools

Multi-orchestrator pools **strongly recommend shared S3 log storage** so any pool member can serve historical logs (the Platform's `leastLoaded()` router can pick any orch in the pool to handle a dashboard request). When a second orchestrator joins a pool, the Platform compares its `s3LogAccess` flag against the existing members and **logs a warning if they disagree**, but **does not reject the connection** -- this supports the coordinator/worker topology where the coordinator has S3 access and the workers do not (workers reroute jobs but do not serve logs directly).

The `s3LogAccess` flag is `true` whenever `storage.type=s3` is configured (the same S3 backend underpins both the cache storage and the log storage). When it is `false`, the orchestrator falls back to a filesystem `LogStorage` rooted at `${webhookPayloadDir ?? '/var/lib/kici/cache'}/logs` -- logs and webhook payloads are still stored, just on the local disk of the orch that ingested the run. Source-tarball / dep-tarball caching is disabled in this mode (every run recompiles).

Single-orchestrator deployments can use filesystem storage with no penalty -- the same orch ingests, executes, and serves logs.

The `s3LogAccess` field is sent in the `source.register` message (and in peer heartbeats), so the Platform records it per connection and surfaces it on the diagnostics page.

### SharedConfig storage migration

Storage settings can be supplied either via env vars on each orchestrator or via the SharedConfig system in the database. Both paths land in the same `storage.*` config field.

**Env vars and the SharedConfig fields they populate:**

| Env var                          | SharedConfig field         |
| -------------------------------- | -------------------------- |
| `KICI_STORAGE_TYPE`              | `storage.type`             |
| `KICI_STORAGE_BUCKET`            | `storage.bucket`           |
| `KICI_STORAGE_PREFIX`            | `storage.prefix`           |
| `KICI_STORAGE_REGION`            | `storage.region`           |
| `KICI_STORAGE_ENDPOINT`          | `storage.endpoint`         |
| `KICI_STORAGE_EXTERNAL_ENDPOINT` | `storage.externalEndpoint` |
| `KICI_STORAGE_UPLOAD_ENDPOINT`   | `storage.uploadEndpoint`   |
| `KICI_STORAGE_FORCE_PATH_STYLE`  | `storage.forcePathStyle`   |
| `KICI_STORAGE_LOG_BUCKET`        | `storage.logBucket`        |

**Migration path:**

1. Move storage settings from env vars to the SharedConfig in the database
2. Remove the env vars from your deployment
3. Restart the orchestrators

The orchestrator bridges env vars into `config.storage` at startup. Once migrated to SharedConfig, all orchestrators in the cluster share the same storage configuration automatically.

**Note:** `storage` is a restart-required field. Changes to storage config detected during hot-reload emit a warning but are not applied until the orchestrator is restarted.

## Cluster join tokens

Join tokens enable zero-knowledge cluster bootstrap. A new orchestrator can join an existing cluster with a single command -- no manual config copying required.

### Creating a join token

**Via CLI (recommended):**

```bash
kici-admin peer create-token --role coordinator
# or for a worker:
kici-admin peer create-token --role worker
```

**Via API:**

```bash
curl -X POST https://orchestrator:4000/api/v1/admin/join-tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "my-org",
    "routingKey": "github:12345",
    "role": "coordinator",
    "expiryMs": 3600000
  }'
```

Response:

```json
{
  "token": "kici_join_v1.eyJvcmdJZCI6Im15LW9yZyIsInJvdXRpbmdLZXkiOiJnaXRodWI6MTIzNDUiLCJleHBpcnkiOjE3MTY5MjAwMDB9.a1b2c3d4...",
  "expiresAt": "2026-03-20T08:00:00.000Z"
}
```

**Endpoint:** `POST /api/v1/admin/join-tokens`

| Field      | Type   | Required | Description                                    |
| ---------- | ------ | -------- | ---------------------------------------------- |
| orgId      | string | Yes      | Organization ID for the target pool            |
| routingKey | string | Yes      | Routing key (e.g., `github:12345`)             |
| role       | string | No       | Peer role: `coordinator` (default) or `worker` |
| expiryMs   | number | No       | Token validity duration in ms (default: 1h)    |

Requires `token.manage` RBAC permission.

### Using a join token

Set the token as an environment variable before starting the orchestrator:

```bash
KICI_CLUSTER_JOIN_TOKEN=kici_join_v1.xxx.yyy
```

The orchestrator authenticates with the token on its first connection. After successful authentication, a persistent credential is issued and saved to the credential file. The join token is consumed (one-time use) and no longer needed.

### Token security

- Tokens are **one-time use** -- consumed after successful join
- Token hashes (not plaintext) are stored in the database
- Auth material is transmitted over an ECDH-encrypted channel (never in cleartext)
- Tokens carry a role (`coordinator` or `worker`) enforced at join time

## Credential management

After the initial join, peers authenticate using persistent credentials stored in a local file.

### Credential file

The credential file is stored at `~/.kici/peer-credential` by default (configurable via `KICI_CLUSTER_CREDENTIAL_FILE`). It contains:

- Instance ID
- Credential hash
- Role (coordinator or worker)
- Coordinator URL
- Issued timestamp

The file is created with `0600` permissions (owner read/write only).

### Managing peers

**List active peers:**

```bash
kici-admin peer list
```

**Revoke a peer:**

```bash
kici-admin peer revoke --instance-id <id>
```

The revoked peer's credential is invalidated. The peer must re-join with a new token.

**Revoke all peers:**

```bash
kici-admin peer revoke-all --confirm
```

All peer credentials are invalidated. All peers must re-join with new tokens. Use this for emergency security responses.

### Re-joining after revocation

If a peer's credential is revoked:

1. Create a new join token: `kici-admin peer create-token --role coordinator`
2. Set the token on the revoked peer: `KICI_CLUSTER_JOIN_TOKEN=<new-token>`
3. Restart the peer
4. The peer authenticates with the new token and receives a new credential

## Monitoring

### Health endpoints

Three cluster HTTP endpoints are always mounted:

| Endpoint              | Description                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /cluster/health` | Overall cluster health: status (healthy/degraded/unhealthy), role, term, leader, peer count, agent count, active runs |
| `GET /cluster/peers`  | Per-peer details: instance ID, connection state, agent count, draining status, capabilities                           |
| `GET /cluster/runs`   | Active execution runs with job routing summary                                                                        |

**Health status logic:**

- **healthy** -- Raft leader exists AND all peers connected (or single-node with no peers)
- **degraded** -- Raft leader exists and majority of peers connected, but some peers disconnected
- **unhealthy** -- no Raft leader OR fewer than majority of nodes connected

Example health check:

```bash
curl -s http://orchestrator:4000/cluster/health | jq .
```

```json
{
  "status": "healthy",
  "instanceId": "orch-a-abc123",
  "role": "leader",
  "term": 3,
  "leaderId": "orch-a-abc123",
  "peerCount": 1,
  "connectedPeers": 1,
  "agentCount": 4,
  "activeRuns": 2
}
```

### Prometheus metrics

Cluster operations emit standard Prometheus metrics alongside existing orchestrator metrics. Relevant metrics include peer connection counts, job reroute totals, Raft election events, and orphan recovery counts.

## Webhook secret management

Webhook secrets live in the orchestrator's shared PostgreSQL database under `scoped_secrets` (the encrypted `PgSecretStore`), keyed by source ID. The `sources` table holds the source's metadata (routing key, provider config) and joins to the secret on `__source__/<sourceId>`. Use `kici-admin source` to manage them — never write to `scoped_secrets` directly.

### How secrets work

1. Operators register sources via the CLI: `kici-admin source add github --app-id <id> --webhook-secret <secret> --private-key-file <path>`. The CLI inserts a row into `sources` and writes the webhook secret into `scoped_secrets` via `PgSecretStore.setSecret()`.
2. The orchestrator sends `source.register` to the Platform on connect, advertising the routing key (e.g., `github:12345`). **The webhook secret is never sent over the wire** — the message carries only the routing key and provider type.
3. When a webhook arrives at the Platform, the Platform sends a `webhook.relay.start` / `webhook.relay.chunk` sequence to the orchestrator that owns the routing key. The orchestrator reads the secret from `PgSecretStore` and verifies the HMAC signature locally, then ACKs back to the Platform with the verification outcome.
4. The Platform tier never holds webhook secret material — verification is delegated to the orchestrator on every inbound delivery.

### Rotating a webhook secret

Each source carries exactly one active webhook secret. To rotate without dropping deliveries:

1. **Update the provider first** (e.g., GitHub App settings) to use the new secret. Provider-side rotation typically tolerates a brief window where in-flight deliveries still carry the old signature, but the new secret takes effect on the next delivery.
2. **Update the orchestrator-side secret:**
   ```bash
   kici-admin source update <routingKey> --webhook-secret <new-secret>
   ```
   This rewrites `scoped_secrets` in a single transaction. Inflight `webhook.relay` verifications may briefly fail during the swap; the provider will retry.
3. After the rotation settles, operate as normal. There is no second-row "two-secret" mode — the source carries one secret at a time.

For a coordinated zero-downtime rotation, drain webhook traffic at the load balancer for the few seconds between provider and orchestrator updates.

## Rate limiting behind reverse proxies

Peer authentication rate limiting tracks failed attempts by IP address. When orchestrators sit behind a reverse proxy or load balancer, all connections appear to come from the proxy's IP, which can cause legitimate peers to be rate-limited when a single bad actor triggers the limit.

Set `KICI_CLUSTER_TRUSTED_PROXIES` to the proxy's IP or CIDR range so the peer handler extracts the real client IP from the `X-Forwarded-For` header:

```bash
KICI_CLUSTER_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
```

Without this setting, rate limiting uses the socket IP (the proxy), which may incorrectly block all peers behind the same proxy.

## Troubleshooting

### Peer authentication failed

**Symptom:** Peer connections fail with "Invalid join token" or "Invalid credential" in logs.

**Checks:**

1. **Join token expired** -- tokens expire after 1 hour by default. Create a new one with `kici-admin peer create-token`
2. **Token already consumed** -- join tokens are one-time use. Create a new one for each peer
3. **Credential revoked** -- if the credential was revoked via `kici-admin peer revoke`, the peer needs a new join token
4. **Rate limited** -- after 5 failed auth attempts within 60 seconds, the IP is temporarily blocked. Wait and retry

### Peers not connecting

**Symptom:** `/cluster/peers` shows 0 connected peers despite multiple orchestrators running.

**Checks:**

1. Verify `KICI_CLUSTER_ADDRESS` is set and reachable from peer orchestrators
2. In independent mode, verify `KICI_CLUSTER_PEERS` lists all peer addresses
3. Check firewall rules allow WebSocket connections on the orchestrator port
4. In Platform mode, verify both orchestrators connect to the same Platform relay and register the same routing key

### Stale peers

**Symptom:** `/cluster/peers` shows peers as connected but their last heartbeat is old.

The peer heartbeat interval is 30 seconds by default. If heartbeats stop, the peer may have crashed or lost network connectivity. The peer will be marked as disconnected after the connection closes.

### Orphan runs

**Symptom:** Execution runs stuck in "running" state after an orchestrator crash.

The Raft leader runs periodic orphan recovery (every 60 seconds). It detects runs whose coordinator orchestrator is no longer connected and finalizes them. If no leader is elected, orphan recovery cannot run -- check `/cluster/health` to verify a leader exists.

### Job routing limits

Rerouted jobs carry a hop counter to prevent infinite routing loops. If a job exceeds the maximum hop count, it fails instead of being rerouted again.

| Limit        | Value | Description                                                         |
| ------------ | ----- | ------------------------------------------------------------------- |
| Maximum hops | 3     | Jobs rerouted more than 3 times are failed to prevent routing loops |
| ACK timeout  | 15s   | Time for a peer to acknowledge receipt of a rerouted job            |

### Jobs not rerouting

**Symptom:** Jobs fail with "No orchestrator in cluster has matching agents" even though a peer has agents.

**Checks:**

1. Verify the peer is connected (`/cluster/peers`)
2. Verify the peer's agents have matching labels (labels are shared via heartbeat)
3. Verify the peer's agents have available capacity (not at max concurrency)
4. Verify the peer is not draining

## See also

- [Multi-orchestrator architecture](../../architecture/clustering/multi-orchestrator.md) — coordinator/worker model, Raft consensus, peer communication, and the rerouting protocol behind this deployment guide.
- [Coordinator/worker architecture](../../architecture/clustering/coordinator-worker.md) — how the dedicated-coordinator topology splits webhook processing from job execution.
