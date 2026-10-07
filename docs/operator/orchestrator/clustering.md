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

**Workers do not need a Platform token.** Workers connect only to their coordinator via P2P WebSocket (`KICI_CLUSTER_COORDINATOR_URLS`) and never talk to the Platform relay. They have no database, no S3 credentials, and no API key -- see [coordinator/worker deployment](coordinator-worker.md) for details.

Different operators (customers) must use separate API keys and organizations. Each API key is bound to a single organization on the Platform, so cross-tenant traffic is rejected at the relay before it reaches any orchestrator.

### Shared PostgreSQL (mandatory)

All orchestrators in a cluster **must** share the same PostgreSQL database. This is a hard requirement -- join tokens, peer credentials, Raft state, execution tracking, webhook secrets, cluster metadata, and the dispatch queue all live in this shared database.

The shared database ensures:

- **Join token consumption** is atomic across coordinators (DB transactions prevent races)
- **Peer credentials** are globally visible, so any coordinator can validate a reconnecting peer
- **Cluster identity** (`cluster_id` in `cluster_meta`) is consistent -- at startup, each coordinator validates it reads the same `cluster_id`, preventing accidental misconfiguration where separate clusters point at the same database. When S3 storage is configured, the validation also checks a `<prefix>/.kici-cluster-id` sentinel object so two clusters can safely share a physical bucket if they use distinct `KICI_STORAGE_PREFIX` values. See [cluster identity in multi-orchestrator design](../../architecture/clustering/multi-orchestrator.md#cluster-identity) for the full sentinel contract
- **Credential tracking** records which coordinator last validated each peer (`last_validated_by`), providing operational visibility into connection routing

**Do not** run separate PostgreSQL instances per orchestrator in a cluster. This will cause split-brain: each orchestrator would generate a different `cluster_id`, tokens consumed on one would not be visible to others, and peer credentials would be siloed.

### Peer authentication

Peer-to-peer WebSocket connections use an ECDH key exchange, then authenticate with a join token or a credential. Authentication is mutual: both sides prove that they hold the same credential or join token, and the dialling side accepts nothing until the peer it dialled proves it. A coordinator without `KICI_CLUSTER_JOIN_TOKEN` issues its own credential the first time it connects to a peer. It writes to the shared database, which is the same authority `kici-admin peer create-token` uses. A worker has no database, so a worker joins with a one-time join token, and the coordinator that accepts the token issues the worker's credential. A coordinator can also join with a token. After the first join, every peer authenticates with its credential.

### Network connectivity

Orchestrators need to reach each other via WebSocket for direct peer connections. Set `KICI_CLUSTER_ADDRESS` to a reachable `host:port` for each orchestrator. Without a reachable address, peers cannot establish direct connections.

In Platform/hybrid modes, orchestrators that cannot reach each other directly fall back to relay through the Platform tier.

For the full outbound allowlist and inbound surface across all deployment modes, see [Network requirements](../network-requirements.md).

## Configuration reference

Cluster configuration uses the `KICI_CLUSTER_*` environment variable prefix.

| Environment Variable                        | Default                   | Required                       | Description                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_CLUSTER_JOIN_TOKEN`                   | --                        | Workers; a revoked coordinator | One-time join token. A worker needs one for its first connection. A coordinator needs one only to rejoin after an operator revoked its credential; without a token, a coordinator issues its own credential. After a successful join the peer uses its persisted credential.                                                                                                                            |
| `KICI_CLUSTER_CREDENTIAL_FILE`              | `~/.kici/peer-credential` | --                             | Path to store/load the persistent peer credential. After first join, the orchestrator uses this credential for all subsequent connections. Each orchestrator on a host needs its own file.                                                                                                                                                                                                              |
| `KICI_CLUSTER_INSTANCE_ID`                  | random UUID               | Recommended                    | Unique identifier for this orchestrator instance. Auto-generated if not set, which gives a restarted orchestrator a new id and orphans the rows its previous boot wrote — set a stable value on every orchestrator, see [recovery is scoped to the owning instance](#recovery-is-scoped-to-the-owning-instance). A coordinator retires the credential its previous run issued when it issues a new one. |
| `KICI_CLUSTER_ADDRESS`                      | --                        | When peers set                 | This orchestrator's reachable address (e.g., `ws://10.0.0.1:4000`). Required when `KICI_CLUSTER_PEERS` is set.                                                                                                                                                                                                                                                                                          |
| `KICI_CLUSTER_PEERS`                        | --                        | Multi-orch independent         | Comma-separated list of peer addresses (e.g., `ws://10.0.0.2:4000,ws://10.0.0.3:4000`). Only needed for multi-orchestrator independent mode (Platform/hybrid uses automatic peer discovery).                                                                                                                                                                                                            |
| `KICI_CLUSTER_PEER_DISCOVERY`               | `platform`                | --                             | Whether this coordinator dials the peers the Platform announces. `platform` dials them; an announced address becomes a peer only after mutual authentication with the announced instance ID. `static` dials only `KICI_CLUSTER_PEERS`. A coordinator with `static` and no `KICI_CLUSTER_PEERS` dials no peer, and other coordinators can still dial it.                                                 |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS` | `5000`                    | --                             | Minimum Raft election timeout (ms).                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS` | `10000`                   | --                             | Maximum Raft election timeout (ms).                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_RAFT_HEARTBEAT_MS`            | `2000`                    | --                             | Raft leader heartbeat interval (ms).                                                                                                                                                                                                                                                                                                                                                                    |
| `KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS`   | `30000`                   | --                             | Peer inventory heartbeat interval (ms).                                                                                                                                                                                                                                                                                                                                                                 |
| `KICI_CLUSTER_INSTANCE_HEARTBEAT_MS`        | `10000`                   | --                             | How often this orchestrator records its own liveness in the shared `cluster_instances` table (ms). Every recovery decision reads it, so raising it widens the window in which a crashed coordinator's jobs stay untouched. See [recovery is scoped to the owning instance](#recovery-is-scoped-to-the-owning-instance).                                                                                 |
| `KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS`  | `60000`                   | --                             | Maximum delay between peer reconnect attempts (ms).                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_ROLE`                         | `coordinator`             | For workers                    | Cluster role: `coordinator` (default, full orchestrator) or `worker` (delegated execution only). See [Coordinator/worker deployment](coordinator-worker.md).                                                                                                                                                                                                                                            |
| `KICI_CLUSTER_COORDINATOR_URLS`             | --                        | For workers                    | Comma-separated WebSocket URLs of the peer endpoint of every coordinator (e.g., `ws://coordinator:4000/ws/peer`). The worker connects to each one, so every coordinator can route work to it. Required when `KICI_CLUSTER_ROLE=worker`.                                                                                                                                                                 |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`        | `60000`                   | --                             | Timeout in ms after which a peer with no heartbeat is considered stale.                                                                                                                                                                                                                                                                                                                                 |
| `KICI_CLUSTER_ELECTION_GRACE_PERIOD_MS`     | `60000`                   | --                             | How long an orchestrator with no connected peers waits before it elects itself leader (ms). The wait keeps it from taking leadership while it is still discovering its peers.                                                                                                                                                                                                                           |
| `KICI_CLUSTER_SINGLE_NODE`                  | `false`                   | --                             | Set to `true` on a deployment that will never have peers. The orchestrator then skips the election grace period and elects itself leader at once.                                                                                                                                                                                                                                                       |
| `KICI_CLUSTER_TRUSTED_PROXIES`              | --                        | Behind reverse proxy           | Comma-separated list of trusted proxy IPs or CIDR ranges (e.g., `10.0.0.0/8,172.16.0.0/12`). When set, the peer handler extracts the real client IP from `X-Forwarded-For` instead of using the socket IP. Required for correct rate limiting when orchestrators are behind a load balancer or reverse proxy.                                                                                           |

### Mode-specific requirements

- **Single-orchestrator (any mode):** No cluster env vars needed. Cluster components initialize in dormant mode automatically.
- **Multi-orchestrator Platform/hybrid mode:** Coordinators need no join token: each issues its own credential. Workers need a join token from `kici-admin peer create-token --role worker`. The Platform matchmaker handles peer discovery automatically. To dial only the peers you list, set `KICI_CLUSTER_PEER_DISCOVERY=static` and `KICI_CLUSTER_PEERS`.
- **Multi-orchestrator independent mode:** `KICI_CLUSTER_ADDRESS` and `KICI_CLUSTER_PEERS` are required because there is no Platform matchmaker for peer discovery. Workers also need `KICI_CLUSTER_JOIN_TOKEN`.

## Peer authentication flow

Peer authentication uses an ECDH (X25519) key exchange, then mutual authentication. In `peer.hello` the accepting side lists the schemes it accepts (`mutual-v2`). The dialling side proves that it holds the shared key (its credential, or its join token on first join) with a proof that covers both ephemeral keys. The accepting side answers with its own proof. No credential and no join token crosses the wire.

### A coordinator's own credential

A coordinator without `KICI_CLUSTER_JOIN_TOKEN` authenticates with its credential file when the file names it. When it has no usable file the first time it connects to a peer, or a peer rejects its credential, it checks the shared database:

- No credential, an expired credential, or a credential file that is missing or does not match: the coordinator issues a new credential, stores its hash in the database, and writes the credential file.
- A credential that an operator revoked: the coordinator does not issue a new one. It logs `Peer credential for this coordinator was revoked; not issuing a new one` once. Its outbound peer connections close without authenticating, and other coordinators still connect to it. See [Re-joining after revocation](#re-joining-after-revocation). A revoke applies to one instance ID. A coordinator without a stable `KICI_CLUSTER_INSTANCE_ID` gets a new ID when it restarts, and the new ID issues its own credential. Set a stable instance ID on every coordinator so that a revoke holds across restarts.

A restart without a stable instance ID gives the orchestrator a new instance ID. When the credential file holds a credential that the previous run issued to itself, the coordinator revokes it, unless the previous instance still reads as live. A previous run that stopped cleanly is not live. A previous run that crashed stays live for the heartbeat grace window (120 seconds at the defaults, see [recovery is scoped to the owning instance](#recovery-is-scoped-to-the-owning-instance)). A coordinator that restarts inside that window keeps the previous credential active until it expires. A credential the previous run got from a join token stays active until it expires. A coordinator that never connects to a peer, such as a single orchestrator, issues nothing. A single-node orchestrator (`KICI_CLUSTER_SINGLE_NODE=true`) never issues a credential.

### First join (with token)

1. **Start the coordinator** -- the first orchestrator in the cluster starts with `KICI_SECRET_KEY` set; it issues its own credential when it first connects to a peer
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
4. **ECDH handshake** -- the peer and coordinator exchange ephemeral X25519 public keys via `peer.hello` / `peer.hello.response` messages. The coordinator's `peer.hello` lists `mutual-v2`
5. **Token proof** -- the peer sends the token's routing part and a proof that it holds the token, in an encrypted `peer.auth.request`. The token itself stays on the peer. The coordinator finds the token in its database, checks the proof, and takes the peer's role and routing key from the token it issued
6. **Coordinator proof** -- the coordinator answers with a session credential and its own proof, which covers that credential. The peer accepts the answer only when the proof verifies. Every later message uses a key that needs the token
7. **Credential persistence** -- the peer saves the issued credential to `KICI_CLUSTER_CREDENTIAL_FILE` (default: `~/.kici/peer-credential`)
8. **Token bound to the peer** -- the join token is marked consumed and recorded against the joining peer's instance ID. Until the token expires, the **same** peer instance may present it again to re-acquire a credential (self-healing rejoin after a transient outage); a _different_ instance cannot reuse it

### Subsequent connections (with credential)

After the first join, the orchestrator uses its persisted credential file for all subsequent connections. No join token is needed:

1. The orchestrator loads the credential from `KICI_CLUSTER_CREDENTIAL_FILE`
2. ECDH handshake establishes an encrypted channel
3. The orchestrator sends a proof of the credential that covers both ephemeral keys (never the credential itself)
4. The coordinator checks the proof against the credential hash in the shared database, and answers with its own proof
5. The orchestrator checks the coordinator's proof. Only then does it accept the connection and process messages from the coordinator

### Security properties

- **No auth material on the wire** -- a peer sends a proof, never its credential or join token
- **Mutual authentication** -- the dialling side accepts no message until the peer it dialled proves that it holds the same credential or join token
- **Bound to the connection** -- each proof covers both ephemeral keys, so a relay that runs its own key exchange with each side cannot reuse a proof
- **Instance-bound tokens** -- a join token is consumed on first use and bound to the joining peer's instance ID; only that same instance may re-present it (until expiry) to self-heal, so a returning peer recovers without a full cluster redeploy while a leaked token cannot be replayed by a different instance
- **Rate limiting** -- failed authentication attempts are rate-limited (5 attempts per IP within 60 seconds)
- **Post-auth encryption** -- all later messages (heartbeats, reroutes, Raft) use a key derived from the ECDH secret and the shared credential or token
- **Announced addresses are hints** -- a peer address the Platform announces becomes a peer only after mutual authentication with the announced instance ID. A dialled address that fails it is dropped and dialled again only when the Platform announces it again. Set `KICI_CLUSTER_PEER_DISCOVERY=static` to turn off dialling of announced addresses
- **A rejection does not delete a valid credential** -- a coordinator keeps its credential file when a peer rejects a credential that its own database holds as valid

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

After the first successful connection, Orchestrator B saves its credential and no longer needs the join token. Subsequent restarts use the persisted credential automatically. Orchestrator B is a coordinator, so it can also start without `KICI_CLUSTER_JOIN_TOKEN` and issue its own credential.

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

## Autoscaling in a cluster

Every orchestrator loads its own scaler config file and builds its own backends from it. Nothing distributes that file, so each one decides for itself what it can provision. After you edit the files, `kici-admin scaler reload` reloads them on the orchestrator `--url` names and on every orchestrator connected to it, and prints the outcome of each; see [Config reload](./auto-scaler/operations.md#config-reload). The state behind those decisions is split: some of it is shared through the cluster database, and the rest stays in the process that holds it.

### What is shared

These live in the shared orchestrator database, so any coordinator can read them:

| State                       | Why it is shared                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending provisioning claims | A claim code minted by one coordinator is redeemed by whichever coordinator the new agent reaches.                                                                                  |
| Spawn records               | They carry the scaler name, the labels, the taint labels, and the provisioning targets, so a coordinator with no config for that scaler can still adopt the agent and tear it down. |
| Ephemeral agent tokens      | The agent registers on whichever coordinator it reached.                                                                                                                            |
| Agent-to-job correlation    | Lifecycle events stay attached to the run when another coordinator takes the agent.                                                                                                 |
| Resource reservations       | Each row is stamped with the coordinator holding it.                                                                                                                                |
| Reaper windows              | They are [cluster settings](./cluster-settings.md), read fresh on each sweep.                                                                                                       |
| Precursor job results       | A build, init, or dynamic-eval result is written on the shared job row, so the coordinator that dispatched the job reads it back when another coordinator's agent ran it.           |
| Registration windows        | The run row names the coordinator that still has jobs to register for it, so no sibling finalizes the run early. See [runs that span coordinators](#runs-that-span-coordinators).   |

### What stays local

- **The scaler config file and its backends.** A coordinator with no `KICI_SCALER_CONFIG_PATH` builds no scaler at all, which is exactly what the dedicated-coordinator recipe above wants. One exception: if the cluster runs an [`event`](./event-scaler.md) scaler, give **every** coordinator behind the shared endpoint a config file, even an empty one — see [event scaler high availability](./event-scaler.md#high-availability) for why a coordinator without one cannot serve a provisioned agent.
- **The caps of a local backend.** `maxAgents` on a `container`, `bare-metal`, or `firecracker` scaler bounds that host, and so do `globalMaxAgents` and the CPU and memory totals. An `event` scaler is the exception: its `maxAgents` is counted across the cluster. See [caps in a cluster](./auto-scaler.md#caps-in-a-cluster).
- **The warm pool.** Each orchestrator keeps its own.
- **The absence clock behind the stranded-provision sweep.** It lives on the leader and restarts when leadership moves.

### Recovery is scoped to the owning instance

On boot, an orchestrator recovers only the rows it owns, plus the rows whose owning coordinator is no longer alive. It leaves every other row alone. This applies to two planes:

- **The scaler plane** — spawn records and resource reservations. Scoping stops an orchestrator counting a peer's reservations against its own caps and refusing spawns it has capacity for.
- **The dispatch plane** — in-flight jobs. Scoping stops a booting orchestrator starting recovery timers for jobs the other coordinators' agents are running. An unscoped boot marked those jobs `recovering` and, once the recovery window passed, failed them — while the agents ran them to completion.

**Set `KICI_CLUSTER_INSTANCE_ID` to a stable value on every orchestrator in a cluster.** An auto-generated id is new on every boot, so a restarted orchestrator does not recognise the rows its own previous boot wrote.

#### Coordinator liveness

Each orchestrator writes its own liveness into a shared `cluster_instances` table every `KICI_CLUSTER_INSTANCE_HEARTBEAT_MS` (10 seconds by default). A coordinator counts as alive while its heartbeat is inside a grace window of the larger of the agent recovery window and six heartbeat intervals — 120 seconds at the defaults. A currently-connected peer also counts as alive, as a corroborating signal.

The heartbeat is in the database rather than derived from peer connections because a booting orchestrator has not connected to any peer yet, and boot is exactly when recovery runs. It needs no peer connectivity, so it behaves the same in a Raft cluster, a plain multi-coordinator deployment, and a standalone one.

A clean shutdown removes the row, so a coordinator stopped on purpose is recognised as gone immediately rather than after the grace window.

### Runs that span coordinators

The dispatch queue is cluster-wide. An agent connected to any coordinator can claim a queued job, so the jobs of one run can execute on agents of several coordinators. Each agent reports to the coordinator it is connected to, which writes the job's status to the shared `execution_jobs` row. Between coordinators, the shared row is the report. No configuration is needed.

Three mechanisms keep such a run correct:

- **Precursor results travel on the job row.** A workflow's `__build__`, `__init__`, or dynamic-eval job produces a result the dispatching coordinator waits for before it dispatches the real jobs. When another coordinator's agent ran that job, the result is written to the shared row and the waiting coordinator reads it back within a few seconds. It does not wait out its build timeout.
- **Completion is decided from the shared rows.** A coordinator finalizes a run only when every job row of the run is terminal, not only the jobs its own agents reported. The run's status covers every job.
- **A registration window blocks early completion.** While a coordinator's dispatch pipeline still has jobs to register for a run (the post-build jobs, the jobs of a deferred init), the run row names that coordinator as the holder of a registration window. Every other coordinator defers finalizing the run while that holder is [alive](#coordinator-liveness). A build job that finishes on a sibling is therefore not read as "the run is complete".

A holder that dies mid-window reads as no window. The [stale-job detector](../stale-detection.md#runs-left-behind-after-every-job-finished) finishes any run whose every job is terminal but whose finalizer never ran.

#### Rows with no recorded owner

A dispatch row written before its orchestrator recorded owners — during a rolling upgrade, for instance — has no owner recorded. **An unrecorded owner reads as "unknown", never as "not mine".** Such a row is skipped by recovery rather than claimed, and the orchestrator logs how many rows it skipped and why.

Skipping is not the same as losing the job. A row whose dispatch genuinely went nowhere is still reaped by the stale-job detector, which measures how long a dispatch has gone unacknowledged from when it was handed to an agent. Once every orchestrator in the cluster has restarted onto a version that records owners, no new rows have an unrecorded owner.

**Event** spawn records survive a lost instance id: any coordinator can adopt one when the agent registers, and the leader's sweep tears down whatever stays unclaimed. Both paths match on `backend_type = 'event'`, so a `container`, `bare-metal`, or `firecracker` spawn record whose owning instance never comes back is adopted by nobody and swept by nobody. Resource reservations behave the same way: a reservation row whose owning instance never comes back is read by nobody, and nothing deletes it. Both kinds of orphan cost table space only. Neither consumes capacity, because each orchestrator counts only the rows it owns, and the cluster-wide event-scaler cap counts event spawn records instead. Setting a stable `KICI_CLUSTER_INSTANCE_ID` is what stops either from accumulating across orchestrator churn.

## Storage configuration (SharedConfig)

### S3 recommendation for multi-orchestrator pools

Multi-orchestrator pools **strongly recommend shared S3 log storage** so any pool member can serve historical logs (the Platform's `leastLoaded()` router can pick any orch in the pool to handle a dashboard request). When a second orchestrator joins a pool, the Platform compares its `s3LogAccess` flag against the existing members and **logs a warning if they disagree**, but **does not reject the connection** -- this supports the coordinator/worker topology where the coordinator has S3 access and the workers do not (workers reroute jobs but do not serve logs directly).

The `s3LogAccess` flag is `true` whenever `storage.type=s3` is configured (the same S3 backend underpins both the cache storage and the log storage). When it is `false`, the orchestrator falls back to a filesystem `LogStorage` rooted at `${webhookPayloadDir ?? '/var/lib/kici/cache'}/logs` -- logs and webhook payloads are still stored, just on the local disk of the orch that ingested the run. Source-tarball / dep-tarball caching is disabled in this mode (every run recompiles).

Single-orchestrator deployments can use filesystem storage with no penalty -- the same orch ingests, executes, and serves logs.

The `s3LogAccess` field is sent in the `source.register` message (and in peer heartbeats), so the Platform records it per connection and surfaces it on the infrastructure page.

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

Join tokens let a new orchestrator join an existing cluster with one command -- no manual config copying required.

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

The orchestrator authenticates with the token on its first connection. After successful authentication, a persistent credential is issued and saved to the credential file. The token is consumed and bound to this peer's instance ID; in normal operation the persisted credential is used from then on, so the token is no longer needed.

If a peer later loses its credential (a transient outage during a token rotation, or a deleted credential file), it falls back to the join token already in its environment. Because the token is reusable by the **same** instance until it expires, the coordinator accepts the reuse and issues a fresh credential — the peer self-heals and rejoins without operator action or a cluster redeploy. A token that has fully expired still requires a new one via `kici-admin peer create-token`.

### Token security

- `kici-admin join` keeps the join secret on the joining host. It sends a proof, and the cluster seals its configuration to a one-time key of that host, so the Platform relay cannot read the configuration.
- Peer token mode (`KICI_CLUSTER_JOIN_TOKEN`) binds a token to the first instance that uses it. That instance may present the unexpired token again to self-heal; another instance is refused.
- The bootstrap join (`kici-admin join`) can be repeated by anyone who holds the token until it expires. Keep tokens short-lived (the default is one hour) and treat a token like a password.
- A peer's role and routing key come from the token row the cluster issued, not from the token text.
- The database stores the SHA-256 of the token secret, never the secret. That hash still completes a `kici-admin join` until the token expires, so protect database read access and backups like the tokens themselves.
- In peer token mode, the token travels over the ECDH-encrypted peer channel.

## Credential management

After the initial join, peers authenticate using persistent credentials stored in a local file.

### Credential file

The credential file is stored at `~/.kici/peer-credential` by default (configurable via `KICI_CLUSTER_CREDENTIAL_FILE`). It contains:

- Instance ID
- Credential (a secret; peers store only its SHA-256 hash)
- Role (coordinator or worker)
- Issued timestamp

The file is created with `0600` permissions (owner read/write only).

Each orchestrator needs its own credential file: two orchestrators that share one path overwrite each other's credential. Keep the file on persistent storage (for a container, a volume). A coordinator that finds its file missing issues a replacement on its next peer connection.

### Managing peers

**List active peers:**

```bash
kici-admin peer list
```

`kici-admin peer list --json` prints the same records as JSON. `selfIssued` is `true` for a credential a coordinator issued to itself. `lastValidatedBy` names the coordinator that last accepted the peer's credential proof; a coordinator whose outbound connections authenticate shows another coordinator there.

**Revoke a peer:**

```bash
kici-admin peer revoke --instance-id <id>
```

The revoked peer's credential is invalidated. The peer must re-join with a new token. This applies to a coordinator with a stable `KICI_CLUSTER_INSTANCE_ID` too: it does not issue itself a new credential after a revoke.

**Revoke all peers:**

```bash
kici-admin peer revoke-all --confirm
```

All peer credentials are invalidated. All peers must re-join with new tokens. Use this for emergency security responses. This applies to a coordinator with a stable `KICI_CLUSTER_INSTANCE_ID` too: it does not issue itself a new credential after a revoke.

**Forget a peer that left the cluster:**

```bash
kici-admin peer forget <instance-id> [--yes] [--timeout <seconds>] [--json]
```

Each coordinator keeps its own live list of peers, and it keeps a peer that disconnects in that list. A coordinator that left for good therefore stays there as a disconnected coordinator. While it does, `kici-admin scaler orphans` lists every untracked VM as `unverified` and stops none of them. `peer forget` removes the peer from the list of the coordinator that `--url` names. That coordinator then sends the request to every connected sibling coordinator, and the command prints one result for each coordinator. `peer forget` and `kici-admin scaler reload` are the kici-admin commands that act on more than one orchestrator; every other command acts on the orchestrator `--url` names.

- A peer that is still connected is refused, with an error that names it, and nothing is fanned out.
- A peer that the coordinator can still treat as alive is refused too. The error names the window and says when the peer was last heard from. Such a peer can be behind a network partition rather than gone. Wait until the window has passed, then run the command again. Each sibling coordinator applies the same check and keeps a peer it heard from recently. Its result says why.
  - The window is never shorter than the reroute flap grace (`--reroute-flap-grace-ms`, 2 minutes by default). Every coordinator gives a disconnected peer this grace before it fails a job rerouted to that peer, or fails a job that only a coordinator with the new master key can open instead of requeueing it. If you forget the peer inside that grace, the coordinator treats it as gone at once.
  - If you lower the grace below the peer stale window (`KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`, 60 seconds by default), the window is the stale window.
  - A peer that adopted event-scaler provisions that are still running gets the grace that the [event-scaler backstop](./event-scaler.md#orchestrator-side-backstop) gives it before it tears down those provisions, on a coordinator that runs the backstop. That grace is `--reroute-flap-grace-ms`, but never less than twice the stale window (2 minutes at the defaults).
- When the peer is the last coordinator peer that a coordinator knows, forgetting it starts that coordinator's event-scaler backstop again (see the warning below). The command then shows that consequence and asks for confirmation. `--yes` gives the confirmation without a prompt. If you decline the prompt, the coordinator that `--url` names keeps the peer, nothing is fanned out, and the command exits 0. Without a terminal and without `--yes`, the command refuses, keeps the peer and exits 1. The coordinator itself refuses such a forget unless the request acknowledges it (`acknowledgeBackstop: true`), so an HTTP call cannot skip the confirmation. A forget that does not start a backstop needs no confirmation.
- An instance id that no coordinator knows is an error.
- A coordinator that keeps the peer, or does not answer within `--timeout` seconds (default 15), makes the command exit 1.
- It needs the `peer.manage` permission (owner, admin) and a token with no routing-key scope. Each call is recorded in the access log as `peer.forget`.

Forget is not revoke. `peer revoke` makes the coordinators refuse the peer's next connection. `peer forget` only removes a peer that already left from the live lists, and leaves its credential as it is. If the forgotten peer connects again, it is added again as usual.

:::danger
Forget a coordinator only after you confirm that it is gone for good. A coordinator that you cannot reach because of a network partition is not gone.

A coordinator counts the coordinator peers in its list to decide if it sees enough of the cluster to tear down event-scaler provisions. When you forget its last coordinator peer and `KICI_CLUSTER_PEERS` is not set, its [orchestrator-side backstop](./event-scaler.md#when-the-backstop-turns-itself-off) starts again. If the forgotten coordinator still runs behind a partition, the backstop tears down the instances that it runs.

Two checks make this harder to do by mistake. A coordinator heard from inside its window is never forgotten, and a forget that starts a backstop needs your confirmation. Neither check can tell a long partition from a coordinator that is gone. That decision stays with you.
:::

### Re-joining after revocation

If a peer's credential is revoked:

1. Create a new join token: `kici-admin peer create-token --role coordinator`
2. Set the token on the revoked peer: `KICI_CLUSTER_JOIN_TOKEN=<new-token>`
3. Restart the peer
4. The peer authenticates with the new token and receives a new credential
5. Remove `KICI_CLUSTER_JOIN_TOKEN` after the peer has joined. A coordinator without a token then manages its own credential again.

## Monitoring

### Health endpoints

Three cluster HTTP endpoints are always mounted:

| Endpoint              | Description                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /cluster/health` | Overall cluster health: status (healthy/degraded/unhealthy), role, term, leader, peer count, agent count, active runs |
| `GET /cluster/peers`  | Per-peer details: instance ID, connection state, agent count, draining status, capabilities, and `authScheme`         |
| `GET /cluster/runs`   | Active execution runs with job routing summary                                                                        |

`authScheme` reports the scheme each direction of a peer link authenticated with: `inbound` when the peer dialled this orchestrator, `outbound` when this orchestrator dialled the peer. A direction that is down reports `null`. A coordinator never dials a worker, so a worker link has `inbound` only.

```json
{
  "instanceId": "orch-b",
  "connected": true,
  "authScheme": { "inbound": "mutual-v2", "outbound": "mutual-v2" }
}
```

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

1. Operators register sources via the CLI: `kici-admin source add github --app-id <id> --webhook-secret <secret> --private-key @<path>`. The CLI inserts a row into `sources` and writes the webhook secret into `scoped_secrets` via `PgSecretStore.setSecret()`.
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

**Symptom:** Peer connections fail, and the connecting orchestrator logs `Peer auth rejected` with a reason such as `Invalid token`, `Unknown credential`, `Credential revoked`, or `Invalid proof`.

**Checks:**

1. **Join token expired** -- tokens expire after 1 hour by default. Create a new one with `kici-admin peer create-token`
2. **Token already consumed** -- a peer token binds to the first instance that uses it, and another instance is refused. Create a new one for each peer
3. **Credential revoked** -- if the credential was revoked via `kici-admin peer revoke`, the peer needs a new join token, including a coordinator
4. **Rate limited** -- after 5 failed auth attempts within 60 seconds, the IP is temporarily blocked. Wait and retry

### A peer does not support mutual authentication

**Symptom:** The dialling orchestrator logs `Peer does not support mutual authentication; upgrade every orchestrator in the cluster`, or the dialled orchestrator logs `Peer used an authentication scheme this release no longer accepts; upgrade every orchestrator in the cluster` and refuses with `Mutual peer authentication required`.

The cluster runs a mix of releases. Orchestrators with mutual peer authentication and older orchestrators do not connect to each other in either direction. An older orchestrator keeps its credential file and retries with backoff.

**Fix:** upgrade every coordinator and worker in the cluster to the same release. See [Upgrade and rollback](../upgrade-and-rollback.md).

### `No peer auth method` in the logs

**Symptom:** An orchestrator logs `No peer auth method: this instance has no credential file and no join token` once for each outbound peer connection, and those connections close.

**Checks:**

1. On a worker, set `KICI_CLUSTER_JOIN_TOKEN` to a token from `kici-admin peer create-token --role worker`.
2. On a coordinator, look for the revoked-credential error below, or `Could not issue this coordinator its peer credential`, which names the database or file error.
3. Make sure `KICI_CLUSTER_CREDENTIAL_FILE` is writable and no other orchestrator uses the same path.

### Coordinator credential revoked

**Symptom:** A coordinator logs `Peer credential for this coordinator was revoked; not issuing a new one`. Other coordinators connect to it. Its own connections to them close without authenticating, and it retries them with backoff.

An operator revoked its credential with `kici-admin peer revoke` or `kici-admin peer revoke-all`. Follow [Re-joining after revocation](#re-joining-after-revocation).

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

| Limit               | Default | `kici-admin org-settings reroute` flag | Description                                                                      |
| ------------------- | ------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Maximum hops        | 3       | `--max-hops`                           | Jobs rerouted more than this many times are failed to prevent loops              |
| ACK timeout         | 15s     | `--ack-timeout`                        | Time for a peer to acknowledge receipt of a rerouted job                         |
| Spawn window        | 90s     | `--window`                             | After a peer ACKs, how long to wait for progress before re-dispatching           |
| Spawn attempts      | 3       | `--spawn-max-attempts`                 | Agent spawns a worker attempts for one rerouted job before it gives the job back |
| Spawn retry backoff | 5s      | `--spawn-retry-backoff`                | Wait after a failed spawn before the worker's next attempt                       |

Each default is cluster-wide; set a per-org override with `kici-admin org-settings reroute set --org <id> --window <ms> --ack-timeout <ms> --max-hops <n> --spawn-max-attempts <n> --spawn-retry-backoff <ms>`, and clear it with `kici-admin org-settings reroute reset --org <id>`.

### Rerouted job stalls (spawn failure)

**Symptom:** a job rerouted to a peer never starts and the run sits `pending`.

A peer that accepts a reroute but then fails to spawn the agent (transient scaler error, image-pull failure, peer crash) does not strand the run. The coordinator arms a **spawn window** on every accepted reroute. When the window elapses with no progress, the coordinator first checks whether the job has actually started. A peer orchestrator shares this database and records the job's status in it directly. The coordinator reads that status, leaves a running job alone, and disarms the window. Only a job that never started is cancelled on the original peer. The coordinator then re-dispatches it to another peer or a local backend, and fails it only if no backend can run it.

A worker retries a failed agent spawn itself, up to the **spawn attempts** limit, and waits the **spawn retry backoff** between attempts. It reports each failure to the coordinator with a verdict:

- **Retrying.** The coordinator restarts the spawn window for one more attempt plus the backoff.
- **Last attempt failed.** The worker gives the job back. The coordinator re-dispatches it, or fails it, at once.
- **No verdict.** A worker on an older version reports failures without one. The coordinator keeps the window it armed at the reroute.

When the coordinator gives up on a job, it cancels the job on the worker. The worker removes the job from its queue, so the job cannot start there later.

Sizing guidance:

- Raise `--window` for peers with legitimately slow agent startup; lower it to recover faster on flaky backends. Keep it above the time one spawn needs.
- A worker that fails every attempt holds the job for up to attempts × (window + backoff) before the coordinator re-dispatches it. Keep that product inside what a run can wait.

### Jobs not rerouting

**Symptom:** Jobs fail with `No orchestrator in cluster handles labels: <labels>` even though a peer has agents.

**Checks:**

1. Verify the peer is connected (`/cluster/peers`)
2. Verify the peer's agents have matching labels (labels are shared via heartbeat)
3. Verify the peer's agents have available capacity (not at max concurrency)
4. Verify the peer is not draining

## See also

- [Multi-orchestrator architecture](../../architecture/clustering/multi-orchestrator.md) — coordinator/worker model, Raft consensus, peer communication, and the rerouting protocol behind this deployment guide.
- [Coordinator/worker architecture](../../architecture/clustering/coordinator-worker.md) — how the dedicated-coordinator topology splits webhook processing from job execution.
