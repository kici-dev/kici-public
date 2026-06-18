---
title: Coordinator/worker topology
description: Architecture of the coordinator/worker orchestrator topology for lightweight edge deployments
---

The coordinator/worker topology enables deploying orchestrator instances on standalone machines with zero infrastructure dependencies -- no PostgreSQL, no S3 credentials. Workers are the same orchestrator binary running in a different mode, connected to a coordinator via P2P WebSocket.

## Design principles

- **Same binary, different mode.** Workers and coordinators are the same `@kici-dev/orchestrator` package. `KICI_CLUSTER_ROLE=worker|coordinator` (default: `coordinator`) controls which subsystems initialize. No separate package, no separate binary.
- **Workers are stateless.** All persistent state lives on the coordinator (PG, secrets, config). Workers use in-memory stores and relay results back.
- **Workers need only WebSocket connectivity.** A worker needs to reach the coordinator's `/ws/peer` endpoint. No database, no Platform connection, no S3 credentials required.

## Subsystem skip table

When an orchestrator starts in worker mode, the following subsystems are skipped:

| Subsystem                                  | Coordinator | Worker      | Notes                                                                                    |
| ------------------------------------------ | ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| PostgreSQL connection                      | Yes         | **Skipped** | Workers have no `KICI_DATABASE_URL`                                                      |
| Outbound WebSocket to KiCI                 | Yes         | **Skipped** | Only the coordinator connects upstream; workers reach the rest of the cluster through it |
| Raft consensus                             | Yes         | **Skipped** | No leader election on workers                                                            |
| PG-backed job queue                        | Yes         | **Skipped** | Workers NAK if they can't dispatch immediately                                           |
| PG-backed execution tracker                | Yes         | **Skipped** | Workers use `InMemoryExecutionTracker`                                                   |
| PG-backed agent token store                | Yes         | **Skipped** | Workers use `StaticAgentTokenStore`                                                      |
| Webhook pipeline (dedup, trigger matching) | Yes         | **Skipped** | Coordinator handles all webhook processing                                               |
| Secrets store (PG/Vault)                   | Yes         | **Skipped** | Workers receive secrets via job reroute payload                                          |
| Config store (PG SharedConfig)             | Yes         | **Skipped** | Workers use local YAML/env config only                                                   |
| Workflow registration store                | Yes         | **Skipped** | Coordinator manages registrations                                                        |
| Agent registry                             | Yes         | Yes         | Workers manage their own local agents                                                    |
| Scaler manager                             | Yes         | Yes         | Workers spawn agents from local `scalers.yaml`                                           |
| Dispatcher                                 | Yes         | Yes         | Workers dispatch to local agents                                                         |
| P2P peer client                            | Optional    | Yes         | Workers connect to coordinator via P2P                                                   |
| P2P peer handler                           | Yes         | Optional    | Coordinator accepts incoming peer connections                                            |
| HTTP health endpoints                      | Yes         | Yes         | `/health`, `/ready`, `/cluster/health`                                                   |
| Worker status endpoint                     | No          | Yes         | `/status` with recent job history                                                        |
| Worker drain endpoint                      | No          | Yes         | `POST /drain` for graceful drain                                                         |

## Job flow

```
GitHub/webhook --> Platform relay --> Coordinator orchestrator
                                       |
                                       v
                                 Trigger matching
                                 (lock file eval)
                                       |
                          +------------+------------+
                          |                         |
                    Local agents?              Peer workers?
                          |                         |
                    Dispatch locally          job.reroute
                                                    |
                                        +-----------+-----------+
                                        |                       |
                                   Worker A                Worker B
                                   (accept)                (accept)
                                        |                       |
                                  Agent dispatch          Agent dispatch
                                        |                       |
                                  job.progress             job.progress
                                  (relay back)             (relay back)
                                        |                       |
                                        +-----------+-----------+
                                                    |
                                              Coordinator
                                         (check run update)
```

### NAK-based flow control

Workers do not have a local job queue. When a worker receives `job.reroute`:

1. If it can dispatch immediately (matching agent with capacity) --> **ACK** and execute
2. If it cannot handle the job (at capacity, no matching labels) --> **NAK** with reason

The coordinator tracks NAK count per peer with backoff. After repeated NAKs from the same peer, the coordinator deprioritizes that peer temporarily.

If a worker ACKs a job but the scaler then fails to provision an agent (Docker down, Firecracker exhausted), the worker fails the job and reports failure to the coordinator. No return-for-rerouting after ACK.

## Log relay

Workers relay log chunks to the coordinator in real-time:

```
Agent --> Worker (log.chunk) --> Coordinator (stepLogBuffer) --> Platform --> Dashboard
```

Log chunk relay is fire-and-forget (no ACK required). Some log loss is acceptable for real-time relay -- logs are buffered and flushed to storage by the coordinator.

## Cache relay

Workers relay cache operations through the coordinator:

### Cache download (agent needs source/deps)

Agents receive pre-signed S3 GET URLs in the `job.reroute` payload (`sourceTarUrl`, `depsUrl`). Direct S3 download, no credentials needed on the worker. Agents extract the raw `.kici/` directory from the tarball and import the workflow `.ts` via the shared TypeScript loader hook — no pre-bundled artifact.

### Cache upload (build job results)

```
Agent --> Worker (cache.upload.request) --> Coordinator (generate pre-signed PUT URL)
                                        <-- Worker (cache.upload.response with URL)
Agent --> S3 (direct upload via pre-signed URL)
```

The coordinator holds S3 credentials and generates pre-signed URLs. Workers and agents only need HTTP access to the S3 endpoint.

## Version compatibility

Version compatibility uses a two-layer approach: a protocol version integer as the baseline gate, and capability flags for per-feature negotiation.

### Protocol version (baseline gate)

Defined in `packages/engine/src/protocol/version.ts` as `PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION`. All three connection types enforce minimum-version semantics:

- **Platform-orchestrator:** Platform handler rejects connections with `protocolVersion < MIN_PROTOCOL_VERSION` (`WS_CLOSE_PROTOCOL_ERROR`)
- **Coordinator-worker:** Peer handler rejects connections with `protocolVersion < MIN_PROTOCOL_VERSION` (`WS_CLOSE_PROTOCOL_ERROR`)
- **Agent-orchestrator:** Agent handler rejects connections with `protocolVersion < MIN_PROTOCOL_VERSION` (`WS_CLOSE_PROTOCOL_ERROR`)

Future protocol versions are always accepted (minimum-version semantics, not exact-match). The protocol version is incremented on breaking changes to message schemas.

### Capability flags (per-feature negotiation)

Above the protocol version baseline, individual features are negotiated via capability flags:

- **Peer capabilities** (`peerCapabilitiesSchema`): exchanged in `peer.auth.response` and `peer.heartbeat`. Current flags: `s3LogAccess`, `logRoutingOverride`.
- **Platform/orchestrator capabilities** (`orchCapabilitiesSchema`, `platformCapabilitiesSchema`): exchanged in `auth.request` and `auth.success`.

Schemas use `.passthrough()` so newer peers sending unknown flags don't get stripped. Missing flags default to `false` (unsupported).

### Software version (diagnostic only)

Both sides send `softwareVersion` in the peer auth handshake for logging and debugging. It is not used for compatibility gating. Coordinators and workers can be upgraded in any order as long as both support the same minimum protocol version.

### CLI capability probe (REST)

The CLI runs over REST, not WebSocket, so it does not receive the WS-layer capability handshake. Instead, the orchestrator exposes a public `GET /api/v1/capabilities` endpoint that returns the same three version fields (`orchestratorVersion`, `protocolVersion`, `minProtocolVersion`). When the CLI detects a capability gap — e.g. an older orchestrator that returns 404 for the logs endpoint — it fetches this manifest on demand and formats an actionable error via `formatCapabilityGapError` (`packages/compiler/src/errors/capability-gap.ts`) showing the feature name, the CLI version, the orchestrator version, and upgrade guidance. The endpoint is unauthenticated, matching the security posture of `/health`, because the CLI must be able to read it even when its authenticated calls fail.

## Stale eviction

The coordinator auto-evicts stale workers after 2 missed heartbeats (default 60s at 30s interval). Configurable via `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`.

On eviction:

- Worker marked as disconnected in peer registry
- No further jobs routed to the evicted worker
- In-flight jobs on the evicted worker handled by orphan recovery (Raft leader detects runs whose coordinator/worker is gone)

## Worker identity

Workers use the same `KICI_CLUSTER_INSTANCE_ID` config as coordinators. Default: random UUID. Operators can set a human-readable ID (e.g., `mac-mini-1`).

All log lines include the orchestrator's identity in structured fields (`kici.instanceId`, `kici.role`). For worker-executed jobs, the worker's identity traces which machine ran a job in ELK.

## Dashboard visibility

Workers appear in the same peer list as coordinators in the diagnostics dashboard, with a role badge distinguishing "coordinator" (green) and "worker" (blue). No separate UI section for workers.

## Related documentation

- [Operator guide: coordinator/worker deployment](../../operator/orchestrator/coordinator-worker.md)
- [Operator guide: multi-orchestrator clustering](../../operator/orchestrator/clustering.md)
