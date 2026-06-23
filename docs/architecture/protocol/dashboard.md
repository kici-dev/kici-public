---
title: Dashboard, metrics & wire format
description: Dashboard REST-over-WS, run / concurrency events, agent and orchestrator metrics, peer-to-peer, wire format and validation
---

This page documents the WebSocket messages that flow on the agent↔orchestrator and orchestrator↔orchestrator (peer-to-peer) channels, plus the wire format invariants every tier obeys.

## Concurrency protocol messages

These messages enable job-level concurrency control. When an agent discovers a job belongs to a concurrency group (from the workflow definition), it reports to the orchestrator, which decides the action.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### job.concurrency.report

**Direction:** Agent -> Orchestrator

Agent reports that a job belongs to a concurrency group, requesting permission to proceed.

| Field     | Type                       | Required | Description            |
| --------- | -------------------------- | -------- | ---------------------- |
| type      | `"job.concurrency.report"` | Yes      | Message discriminator  |
| messageId | string                     | Yes      | Unique message ID      |
| runId     | string                     | Yes      | Execution run ID       |
| jobId     | string                     | Yes      | Job ID within the run  |
| group     | string                     | Yes      | Concurrency group name |

### job.concurrency.ack

**Direction:** Orchestrator -> Agent

Orchestrator acknowledges concurrency report with action to take.

| Field     | Type                    | Required | Description                                                                |
| --------- | ----------------------- | -------- | -------------------------------------------------------------------------- |
| type      | `"job.concurrency.ack"` | Yes      | Message discriminator                                                      |
| requestId | string                  | Yes      | Correlation ID from the report                                             |
| action    | enum                    | Yes      | One of: `proceed`, `wait`, `cancel`                                        |
| reason    | string                  | No       | Human-readable reason for the action                                       |
| runId     | string                  | No       | Run identifier echoed back on unsolicited slot-release wake-ups (see note) |
| jobId     | string                  | No       | Job identifier echoed back on unsolicited slot-release wake-ups (see note) |

The orchestrator sends `job.concurrency.ack` in two situations: (1) as a direct response to a `job.concurrency.report` — `requestId` correlates to the report and `action` is `proceed`, `wait`, or `cancel`; and (2) as an unsolicited follow-up after the agent received `wait`. When a slot in the concurrency group is released (by completion, cancellation, or superseding), the orchestrator picks the FIFO-next queued waiter and sends `{ action: 'proceed' }` to the agent still parked on its second `waitForConcurrencyAck` call. `runId` and `jobId` are present in this case so the agent can sanity-check the wake-up matches its job.

## Agent metrics push messages

These messages support periodic metrics push from agents to the orchestrator. The orchestrator aggregates agent metrics and exposes them via its Prometheus scrape endpoint.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### agent.metrics

**Direction:** Agent -> Orchestrator

Periodic metrics push from agent to orchestrator. Each metric includes its type, value, labels, and optional histogram buckets.

| Field     | Type              | Required | Description                   |
| --------- | ----------------- | -------- | ----------------------------- |
| type      | `"agent.metrics"` | Yes      | Message discriminator         |
| messageId | string            | Yes      | Unique message ID             |
| agentId   | string            | Yes      | Agent identifier              |
| metrics   | MetricEntry[]     | Yes      | Array of metric data points   |
| timestamp | number            | Yes      | Unix timestamp (milliseconds) |

Each MetricEntry:

| Field   | Type                              | Required | Description                                              |
| ------- | --------------------------------- | -------- | -------------------------------------------------------- |
| name    | string                            | Yes      | Metric name                                              |
| type    | enum                              | Yes      | One of: `counter`, `histogram`, `gauge`, `upDownCounter` |
| value   | number                            | No       | Metric value (for counters and gauges)                   |
| labels  | Record<string, string>            | No       | Metric labels                                            |
| buckets | `[{ le: number, count: number }]` | No       | Histogram bucket boundaries and counts                   |
| count   | number                            | No       | Histogram observation count                              |
| sum     | number                            | No       | Histogram observation sum                                |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentMetricsSchema`

## Agent authentication messages

Authentication messages for the agent <-> orchestrator WebSocket connection.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### auth.request (agent)

Auth request sent by agent to orchestrator when connecting.

| Field           | Type             | Required | Description                         |
| --------------- | ---------------- | -------- | ----------------------------------- |
| type            | `"auth.request"` | Yes      | Message discriminator               |
| token           | string           | Yes      | Authentication token                |
| protocolVersion | number           | Yes      | Protocol version (positive integer) |

### auth.success (agent)

Auth success response sent by orchestrator to agent.

| Field        | Type             | Required | Description            |
| ------------ | ---------------- | -------- | ---------------------- |
| type         | `"auth.success"` | Yes      | Message discriminator  |
| connectionId | string           | Yes      | Assigned connection ID |

### auth.failure (agent)

Auth failure response sent by orchestrator to agent.

| Field  | Type             | Required | Description                   |
| ------ | ---------------- | -------- | ----------------------------- |
| type   | `"auth.failure"` | Yes      | Message discriminator         |
| reason | string           | Yes      | Human-readable failure reason |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentAuthFailureSchema`

## Agent private API messages

Generic request-response envelope for typed API calls over the agent WebSocket. New methods are registered in `AgentApiRegistry` on the orchestrator side — no protocol schema changes are needed per method.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentApiRequestSchema`, `agentApiResponseSchema`

### agent.api.request

API request sent by agent to orchestrator (e.g., `infrastructure.list`).

| Field     | Type                    | Required | Description                                              |
| --------- | ----------------------- | -------- | -------------------------------------------------------- |
| type      | `"agent.api.request"`   | Yes      | Message discriminator                                    |
| requestId | string                  | Yes      | UUID for correlating the response                        |
| method    | string                  | Yes      | Dot-namespaced method name (e.g., `infrastructure.list`) |
| params    | Record<string, unknown> | No       | Method-specific parameters (defaults to `{}`)            |

### agent.api.response

API response sent by orchestrator to agent.

| Field     | Type                   | Required | Description                              |
| --------- | ---------------------- | -------- | ---------------------------------------- |
| type      | `"agent.api.response"` | Yes      | Message discriminator                    |
| requestId | string                 | Yes      | Matches the original request's requestId |
| result    | unknown                | No       | Method result (present on success)       |
| error     | string                 | No       | Error description (present on failure)   |

## Join messages

Join messages enable zero-knowledge cluster bootstrap. A new orchestrator sends a `join.request` with a join token, and an existing orchestrator responds with an AES-256-GCM encrypted config bundle. The Platform relay sees only the token's cleartext routing part and opaque ciphertext -- zero knowledge of customer configuration.

> Authoritative source: `packages/engine/src/protocol/messages/join.ts`

### New orchestrator -> existing orchestrator (via Platform relay or direct peer)

#### join.request

Sent by a new orchestrator to request cluster config from an existing orchestrator.

| Field     | Type             | Required | Description                                                                                          |
| --------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| type      | `"join.request"` | Yes      | Message discriminator                                                                                |
| messageId | string           | No       | Correlation ID for Platform relay routing (injected by Platform to match response to correct joiner) |
| token     | string           | Yes      | Full join token: `kici_join_v1.<base64url_routing>.<secret_hex>`                                     |

### Existing orchestrator -> new orchestrator (via Platform relay or direct peer)

#### join.response

Response from an existing orchestrator with an encrypted config bundle or error.

| Field           | Type              | Required | Description                                                     |
| --------------- | ----------------- | -------- | --------------------------------------------------------------- |
| type            | `"join.response"` | Yes      | Message discriminator                                           |
| messageId       | string            | No       | Correlation ID echoed from join.request for relay routing       |
| success         | boolean           | Yes      | Whether the join was successful                                 |
| encryptedBundle | string            | No       | Base64-encoded AES-256-GCM encrypted config bundle (on success) |
| error           | string            | No       | Error message (on failure)                                      |

The Browser ↔ Platform protocol (browser-side WebSocket auth, log subscriptions, status fan-out) is documented in the internal docs.

## Orchestrator <-> Orchestrator messages (peer-to-peer)

This layer carries cluster coordination messages between orchestrator instances via direct WebSocket connections on `/ws/peer`. These messages **never transit the Platform tier** -- see [Communication Topology](../clustering/multi-orchestrator.md#communication-topology).

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts`

### Authentication

Peer authentication uses a 4-message ECDH handshake. The initiator (connecting orchestrator) sends `peer.hello`, the responder (receiving orchestrator) replies with `peer.hello.response`, then the initiator sends an encrypted `peer.auth.request`, and the responder replies with an encrypted `peer.auth.response`. All auth material is transmitted over the ECDH-encrypted channel.

#### peer.hello

Sent by the initiator (connecting orchestrator) to start the ECDH handshake. Provides the initiator's ephemeral ECDH public key and a nonce.

| Field              | Type           | Required | Description                                                |
| ------------------ | -------------- | -------- | ---------------------------------------------------------- |
| type               | `"peer.hello"` | Yes      | Message discriminator                                      |
| ephemeralPublicKey | string         | Yes      | Initiator's ephemeral X25519 public key (base64, DER SPKI) |
| nonce              | string         | Yes      | Base64-encoded 32-byte random nonce (HKDF salt)            |

#### peer.hello.response

Sent by the responder (receiving orchestrator) in response to `peer.hello`. Provides the responder's ephemeral ECDH public key. After this exchange, both sides derive a shared session key.

| Field              | Type                    | Required | Description                                                |
| ------------------ | ----------------------- | -------- | ---------------------------------------------------------- |
| type               | `"peer.hello.response"` | Yes      | Message discriminator                                      |
| ephemeralPublicKey | string                  | Yes      | Responder's ephemeral X25519 public key (base64, DER SPKI) |

#### peer.auth.request

Sent by the connecting orchestrator after the ECDH handshake. **Encrypted** with the shared session key. Contains either a join token (first connection) or an HMAC credential proof (subsequent connections). The receiving orchestrator must respond within 15 seconds or the connection is closed.

| Field           | Type                  | Required    | Description                                                        |
| --------------- | --------------------- | ----------- | ------------------------------------------------------------------ |
| type            | `"peer.auth.request"` | Yes         | Message discriminator                                              |
| instanceId      | string                | Yes         | Sender's cluster instance ID                                       |
| protocolVersion | number                | Yes         | Protocol version                                                   |
| token           | string                | Conditional | Join token (first connection only)                                 |
| proof           | string                | Conditional | HMAC proof of credential ownership (subsequent connections)        |
| softwareVersion | string                | No          | Software version of the connecting peer (for version compat check) |
| role            | enum                  | No          | Role of the connecting peer: `coordinator` or `worker`             |

One of `token` or `proof` must be present.

#### peer.auth.response

Response to a peer authentication request. **Encrypted** with the shared session key.

| Field             | Type                    | Required | Description                                                        |
| ----------------- | ----------------------- | -------- | ------------------------------------------------------------------ |
| type              | `"peer.auth.response"`  | Yes      | Message discriminator                                              |
| accepted          | boolean                 | Yes      | Whether authentication succeeded                                   |
| instanceId        | string                  | No       | Responder's cluster instance ID                                    |
| sessionCredential | string                  | No       | Issued credential for future connections (first join)              |
| role              | string                  | No       | Confirmed role of the peer                                         |
| reason            | string                  | No       | Rejection reason (if not accepted)                                 |
| softwareVersion   | string                  | No       | Software version of the coordinator (for version compat check)     |
| agents            | PeerAgentSummary[]      | No       | Responder's connected agent inventory (present when accepted=true) |
| scalerCapacity    | ScalerCapacitySummary[] | No       | Responder's scaler capacity (present when accepted=true)           |
| capabilities      | PeerCapabilities        | No       | Responder's feature capabilities (present when accepted=true)      |

### Inventory & consensus

#### peer.heartbeat

Sent every 30 seconds by each peer. Carries agent inventory, scaler capacity, and Raft consensus state. This is the primary mechanism for routing decisions — the coordinator uses peer heartbeats to determine which peers can handle a job's label requirements.

| Field             | Type                    | Required | Description                                               |
| ----------------- | ----------------------- | -------- | --------------------------------------------------------- |
| type              | `"peer.heartbeat"`      | Yes      | Message discriminator                                     |
| instanceId        | string                  | Yes      | Sender's cluster instance ID                              |
| term              | number                  | Yes      | Current Raft term                                         |
| leaderId          | string or null          | Yes      | Known Raft leader's instance ID                           |
| draining          | boolean                 | Yes      | Whether the sender is gracefully shutting down            |
| agents            | PeerAgentSummary[]      | Yes      | Connected agent inventory                                 |
| capabilities      | PeerCapabilities        | Yes      | Feature flags (S3 log access, log routing override)       |
| scalerCapacity    | ScalerCapacitySummary[] | No       | On-demand backend capacity for routing decisions          |
| configVersion     | number                  | No       | Shared config version for sync detection                  |
| registryVersion   | number                  | No       | Registry version for cross-orchestrator registration sync |
| timestamp         | number                  | Yes      | Unix timestamp (milliseconds)                             |
| hostname          | string                  | No       | Machine hostname (`os.hostname()`)                        |
| osRelease         | string                  | No       | OS kernel release (`os.release()`)                        |
| totalMemoryMb     | number                  | No       | Total system memory in MiB                                |
| memoryUsedMb      | number                  | No       | Used memory in MiB                                        |
| memoryAvailableMb | number                  | No       | Available memory in MiB                                   |
| cpuCount          | number                  | No       | Number of logical CPUs                                    |
| uptimeSeconds     | number                  | No       | System uptime in seconds                                  |
| nodeVersion       | string                  | No       | Node.js version                                           |
| runningAsUser     | string or null          | No       | Username of the OS user running the orchestrator          |
| runningAsUid      | number or null          | No       | UID of the OS user running the orchestrator               |
| version           | string                  | No       | Orchestrator version (e.g., `"0.0.1"`)                    |

PeerAgentSummary:

| Field          | Type     | Required | Description                         |
| -------------- | -------- | -------- | ----------------------------------- |
| agentId        | string   | Yes      | Agent identifier                    |
| labels         | string[] | Yes      | Capability labels                   |
| activeJobs     | number   | Yes      | Currently running jobs              |
| maxConcurrency | number   | Yes      | Maximum concurrent jobs             |
| platform       | string   | Yes      | OS platform (e.g., linux)           |
| arch           | string   | Yes      | CPU architecture (e.g., x64, arm64) |

PeerCapabilities:

| Field              | Type    | Required | Description                                                 |
| ------------------ | ------- | -------- | ----------------------------------------------------------- |
| s3LogAccess        | boolean | Yes      | Whether this peer has direct S3 log access                  |
| logRoutingOverride | enum    | No       | One of: `direct`, `coordinator` (overrides default routing) |

ScalerCapacitySummary:

| Field       | Type       | Required | Description                                           |
| ----------- | ---------- | -------- | ----------------------------------------------------- |
| name        | string     | No       | Scaler backend name (e.g., `stg-worker-bare-metal`)   |
| type        | string     | No       | Scaler backend type (e.g., `bare-metal`, `container`) |
| labelSets   | string[][] | Yes      | Label sets this backend provisions                    |
| maxAgents   | number     | Yes      | Maximum agents for this backend                       |
| activeCount | number     | Yes      | Current active agent count                            |

#### raft.vote.request

Raft leader election vote request. Sent by candidates during elections.

| Field        | Type                  | Required | Description                        |
| ------------ | --------------------- | -------- | ---------------------------------- |
| type         | `"raft.vote.request"` | Yes      | Message discriminator              |
| term         | number                | Yes      | Candidate's current term           |
| candidateId  | string                | Yes      | Candidate's instance ID            |
| lastLogIndex | number                | Yes      | Candidate's last log index         |
| lastLogTerm  | number                | Yes      | Term of candidate's last log entry |

#### raft.vote.response

Response to a Raft vote request.

| Field       | Type                   | Required | Description                  |
| ----------- | ---------------------- | -------- | ---------------------------- |
| type        | `"raft.vote.response"` | Yes      | Message discriminator        |
| term        | number                 | Yes      | Voter's current term         |
| voteGranted | boolean                | Yes      | Whether the vote was granted |
| voterId     | string                 | Yes      | Voter's instance ID          |

#### raft.append.entries

Raft leader heartbeat (no log entries — KiCI uses Raft for leader election only, not log replication).

| Field    | Type                    | Required | Description           |
| -------- | ----------------------- | -------- | --------------------- |
| type     | `"raft.append.entries"` | Yes      | Message discriminator |
| term     | number                  | Yes      | Leader's current term |
| leaderId | string                  | Yes      | Leader's instance ID  |

### Job rerouting

#### job.reroute

Sent by the coordinator to a peer when no local agent can handle a job. Contains the full resolved job configuration so the peer can dispatch without re-resolving.

| Field                      | Type                    | Required | Description                                                                                                                                                                             |
| -------------------------- | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type                       | `"job.reroute"`         | Yes      | Message discriminator                                                                                                                                                                   |
| messageId                  | string                  | Yes      | Unique message ID for ACK correlation                                                                                                                                                   |
| jobId                      | string                  | Yes      | Pre-allocated job ID. The sending coordinator allocates it before reroute so its `execution_runs` / `execution_jobs` rows reference the same id the receiving peer will dispatch under. |
| runId                      | string                  | Yes      | Execution run identifier                                                                                                                                                                |
| deliveryId                 | string                  | Yes      | Original webhook delivery ID                                                                                                                                                            |
| routingKey                 | string                  | Yes      | Provider routing key                                                                                                                                                                    |
| event, action              | string, string or null  | Yes      | Webhook event type and action                                                                                                                                                           |
| payload                    | Record<string, unknown> | Yes      | Full webhook payload                                                                                                                                                                    |
| jobName                    | string                  | Yes      | Job to execute                                                                                                                                                                          |
| workflowName               | string                  | Yes      | Workflow containing the job                                                                                                                                                             |
| runsOnLabels               | string[][]              | Yes      | Label sets the job requires                                                                                                                                                             |
| excludeLabels              | string[]                | No       | Labels that the dispatched agent must NOT have                                                                                                                                          |
| triedConnections           | string[]                | Yes      | Instance IDs already tried (loop prevention)                                                                                                                                            |
| maxHops                    | number                  | Yes      | Maximum allowed hops (default: 3)                                                                                                                                                       |
| coordinatorId              | string                  | Yes      | Instance ID of the run coordinator                                                                                                                                                      |
| jobConfig                  | Record<string, unknown> | No       | Resolved job config (steps, rules, matrix, etc.)                                                                                                                                        |
| repoUrl                    | string                  | No       | Repository clone URL                                                                                                                                                                    |
| ref                        | string                  | No       | Git ref (branch name)                                                                                                                                                                   |
| sha                        | string                  | No       | Commit SHA                                                                                                                                                                              |
| provider                   | string                  | No       | Provider type (e.g., `github`)                                                                                                                                                          |
| providerContext            | Record<string, unknown> | No       | Provider-specific context (e.g., `installationId`)                                                                                                                                      |
| sourceTarUrl               | string                  | No       | Pre-signed `.kici/` source tarball download URL (cache hit)                                                                                                                             |
| sourceTarHash              | string                  | No       | Workflow `contentHash` (used for drift verification, not tarball)                                                                                                                       |
| depsUrl                    | string                  | No       | Pre-signed dependency tarball URL (cache hit)                                                                                                                                           |
| depsHash                   | string                  | No       | SHA-256 of the dependency tarball bytes                                                                                                                                                 |
| cloneToken                 | string                  | No       | Pre-resolved clone token for workers without provider credentials                                                                                                                       |
| encryptedSecrets           | string                  | No       | Encrypted secrets envelope (AES-256-GCM with session key)                                                                                                                               |
| encryptedNamespacedSecrets | string                  | No       | Encrypted namespaced secrets envelope                                                                                                                                                   |
| requestId                  | string                  | No       | Trace ID for distributed tracing                                                                                                                                                        |
| traceId                    | string                  | No       | Additional trace context                                                                                                                                                                |

#### job.reroute.ack

Acknowledgment of a reroute request. The coordinator tries the next peer if rejected.

| Field     | Type                | Required | Description                                |
| --------- | ------------------- | -------- | ------------------------------------------ |
| type      | `"job.reroute.ack"` | Yes      | Message discriminator                      |
| messageId | string              | Yes      | ID of the `job.reroute` being acknowledged |
| accepted  | boolean             | Yes      | Whether the peer accepted the job          |
| reason    | string              | No       | Rejection reason (if not accepted)         |

### Progress & cancel

#### job.progress

Sent by the worker orchestrator back to the coordinator as the agent reports job-level and step-level state changes. The coordinator uses this to drive its run-level state machine, update GitHub check runs, and track per-step progress.

The `kind` discriminator decides which `ExecutionTracker` call the receiver makes:

- `kind: "job"` → `onJobStatus(runId, jobId, state, ...)` — drives run transitions (running → success/failed/...). `stepIndex`/`stepName` are unused for this kind.
- `kind: "step"` → `onStepStatus(runId, jobId, stepIndex, stepName, state, ...)` — persists `execution_steps` rows.

| Field     | Type                    | Required | Description                                                                                                                  |
| --------- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| type      | `"job.progress"`        | Yes      | Message discriminator                                                                                                        |
| kind      | `"job"` \| `"step"`     | Yes      | Whether this update is a job-level or step-level transition                                                                  |
| runId     | string                  | Yes      | Execution run identifier                                                                                                     |
| jobId     | string                  | Yes      | Job identifier (matches the pre-allocated `jobId` from `job.reroute`)                                                        |
| jobName   | string                  | Yes      | Human-readable job name                                                                                                      |
| stepIndex | number                  | Yes      | Zero-based step index (used only when `kind="step"`)                                                                         |
| stepName  | string                  | Yes      | Human-readable step name (used only when `kind="step"`)                                                                      |
| state     | enum                    | Yes      | Full `ExecutionJobStatus` for `kind="job"`; the step-state subset (`running`/`success`/`failed`/`skipped`) for `kind="step"` |
| timestamp | number                  | Yes      | Unix timestamp (milliseconds)                                                                                                |
| data      | Record<string, unknown> | No       | Optional state-specific data                                                                                                 |

#### job.progress.ack

Sent by the coordinator back to the worker once it has applied a **terminal** job-level `job.progress` (`kind: "job"`) to its run/job rows. The worker uses it to prune the matching record from its durable terminal-status outbox, so a status that has been durably observed by the coordinator is delivered exactly once. `(runId, jobId)` is the dedup key; `state` is carried for debuggability.

| Field | Type                 | Required | Description                                              |
| ----- | -------------------- | -------- | -------------------------------------------------------- |
| type  | `"job.progress.ack"` | Yes      | Message discriminator                                    |
| runId | string               | Yes      | Execution run identifier                                 |
| jobId | string               | Yes      | Job identifier (matches the acknowledged `job.progress`) |
| state | enum                 | Yes      | The applied `ExecutionJobStatus`                         |

#### peer.job.cancel

Sent by the coordinator to a worker to cancel a rerouted job. Used for fail-fast propagation and user-initiated cancellation.

| Field  | Type                | Required | Description                                                   |
| ------ | ------------------- | -------- | ------------------------------------------------------------- |
| type   | `"peer.job.cancel"` | Yes      | Message discriminator                                         |
| runId  | string              | Yes      | Execution run identifier                                      |
| jobId  | string              | No       | Specific job to cancel (omit for all jobs in run)             |
| reason | string              | Yes      | Human-readable cancellation reason                            |
| force  | boolean             | No       | When true, force-cancel immediately without waiting for hooks |

### Graceful shutdown

#### peer.leaving

Graceful shutdown announcement. Peers remove the sender from their registry immediately upon receiving this message.

| Field      | Type             | Required | Description                                 |
| ---------- | ---------------- | -------- | ------------------------------------------- |
| type       | `"peer.leaving"` | Yes      | Message discriminator                       |
| instanceId | string           | Yes      | Instance ID of the leaving peer             |
| term       | number           | Yes      | Current Raft term for leader identification |

### Log and cache relay (coordinator-worker topology)

#### peer.log.chunk

Log chunk relay from worker to coordinator. Batched log lines from agent execution, forwarded when the worker does not have direct S3 log access.

| Field     | Type               | Required | Description               |
| --------- | ------------------ | -------- | ------------------------- |
| type      | `"peer.log.chunk"` | Yes      | Message discriminator     |
| runId     | string             | Yes      | Execution run ID          |
| jobId     | string             | Yes      | Job ID within the run     |
| stepIndex | number             | Yes      | Zero-based step index     |
| lines     | LogLineEntry[]     | Yes      | Array of log line entries |

Each LogLineEntry:

| Field     | Type   | Required | Description                                     |
| --------- | ------ | -------- | ----------------------------------------------- |
| text      | string | Yes      | Log line text                                   |
| timestamp | number | Yes      | Unix timestamp (milliseconds)                   |
| stream    | enum   | No       | One of: `stdout`, `stderr` (defaults to stdout) |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerLogChunkSchema`

#### peer.cache.upload.request

Cache upload request from worker to coordinator. Worker agent needs an upload URL for cache storage.

| Field     | Type                          | Required | Description                   |
| --------- | ----------------------------- | -------- | ----------------------------- |
| type      | `"peer.cache.upload.request"` | Yes      | Message discriminator         |
| messageId | string                        | Yes      | Unique message ID             |
| runId     | string                        | Yes      | Execution run ID              |
| jobId     | string                        | Yes      | Job ID within the run         |
| cacheType | enum                          | Yes      | One of: `bundle`, `deps`      |
| hash      | string                        | Yes      | Content hash for cache keying |
| sizeBytes | number                        | Yes      | Size of the artifact in bytes |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerCacheUploadRequestSchema`

#### peer.cache.upload.response

Cache upload response from coordinator to worker. Pre-signed upload URL for the worker to upload directly to object storage.

| Field     | Type                           | Required | Description                         |
| --------- | ------------------------------ | -------- | ----------------------------------- |
| type      | `"peer.cache.upload.response"` | Yes      | Message discriminator               |
| messageId | string                         | Yes      | Unique message ID                   |
| runId     | string                         | Yes      | Execution run ID                    |
| jobId     | string                         | Yes      | Job ID within the run               |
| uploadUrl | string                         | Yes      | Pre-signed URL for direct S3 upload |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerCacheUploadResponseSchema`

### Config reload (per-instance targeting)

#### peer.config.reload

Config reload request forwarded from one orchestrator to a specific peer when an operator calls `POST /admin/config/reload` with a `target` parameter. The receiving peer executes a local reload and replies with `peer.config.reload.response`.

| Field     | Type                   | Required | Description                                      |
| --------- | ---------------------- | -------- | ------------------------------------------------ |
| type      | `"peer.config.reload"` | Yes      | Message discriminator                            |
| messageId | string                 | Yes      | Unique message ID                                |
| drain     | boolean                | No       | Whether to drain in-flight work before reloading |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerConfigReloadSchema`

#### peer.config.reload.response

Response from the target peer carrying the reload result fields.

| Field           | Type                            | Required | Description                                         |
| --------------- | ------------------------------- | -------- | --------------------------------------------------- |
| type            | `"peer.config.reload.response"` | Yes      | Message discriminator                               |
| messageId       | string                          | Yes      | Unique message ID                                   |
| success         | boolean                         | Yes      | Whether the reload succeeded                        |
| version         | number                          | No       | New config version after reload                     |
| errors          | string[]                        | No       | Error messages if reload failed                     |
| restartRequired | string[]                        | No       | Config fields that require a restart to take effect |
| fieldsChanged   | string[]                        | No       | Config fields that were changed                     |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerConfigReloadResponseSchema`

### Agent-token revoke fan-out

#### peer.agent-token.revoke

Broadcast to every peer when an agent token is revoked so each peer can close its own in-flight agent WS connections authenticated by that token. The originating peer kicks its local connections first (via the admin revoke route), then fans this message out over the encrypted peer mesh.

| Field            | Type                        | Required | Description                                                        |
| ---------------- | --------------------------- | -------- | ------------------------------------------------------------------ |
| type             | `"peer.agent-token.revoke"` | Yes      | Message discriminator                                              |
| tokenId          | string                      | Yes      | The `agent_tokens.id` whose in-flight agent WS must be kicked      |
| senderInstanceId | string                      | Yes      | Originating peer's instance ID (for cross-cluster log correlation) |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerAgentTokenRevokeSchema`

### Scaler provisioning events

#### scaler.event

Forwarded by a worker to the coordinator that owns the run when the worker's scaler emits a provisioning event correlated to a queued job (e.g. a failed agent spawn). Workers have no database, so they cannot persist provisioning failures themselves — the coordinator's `ExecutionTracker` writes the event to the provisioning log and the dispatch queue's last-error column.

| Field       | Type             | Required | Description                                                     |
| ----------- | ---------------- | -------- | --------------------------------------------------------------- |
| type        | `"scaler.event"` | Yes      | Message discriminator                                           |
| runId       | string           | Yes      | Execution run ID                                                |
| jobId       | string           | Yes      | Job ID within the run                                           |
| agentId     | string           | Yes      | The scaler-managed agent ID the event is about                  |
| eventType   | enum             | Yes      | Scaler event type (a `ScalerEventType` enum member)             |
| detail      | string           | Yes      | Human-readable detail, including any captured spawn stderr tail |
| timestampMs | number           | Yes      | Event timestamp in epoch milliseconds                           |

> Authoritative source: `packages/engine/src/protocol/messages/peer.ts` -- `peerScalerEventSchema`

> See [Multi-Orchestrator Architecture](../clustering/multi-orchestrator.md) for rerouting protocol, loop prevention, and failure modes.

## Test-relay control messages

These messages implement the Platform-first `kici run remote` flow. The CLI does not connect to the orchestrator directly: it authenticates to the Platform, which proxies each control message to the customer's orchestrator over the dashboard-direction WebSocket and relays the response back to the CLI. Every request carries an `actor` principal (so the orchestrator can authorize the operation) and a `requestId` (so the Platform can correlate the matching response).

> Authoritative source: `packages/engine/src/protocol/messages/dashboard.ts`

The control plane is five request/response pairs. Requests travel Platform -> Orchestrator (members of `dashboardPlatformToOrchSchema`); responses travel Orchestrator -> Platform (members of `dashboardOrchToPlatformSchema`). On every response the optional `error` string carries a failure reason when the operation could not be served.

### Platform -> Orchestrator

#### test.relay.uploads.init

Request a presigned URL for uploading the working-tree overlay tarball.

| Field          | Type                        | Required | Description                                |
| -------------- | --------------------------- | -------- | ------------------------------------------ |
| type           | `"test.relay.uploads.init"` | Yes      | Message discriminator                      |
| requestId      | string                      | Yes      | Correlation ID for the response            |
| actor          | ActorPrincipal              | Yes      | Authenticated principal initiating the run |
| routingKey     | string                      | Yes      | Provider routing key                       |
| sha            | string                      | No       | Content hash of the overlay being uploaded |
| fileCount      | number                      | No       | Number of files in the overlay             |
| compressedSize | number                      | No       | Compressed overlay size in bytes           |

#### test.relay.trigger

Trigger a remote test run using a fixture payload (mirrors the orchestrator's `TestTriggerInput`).

| Field               | Type                   | Required | Description                                                         |
| ------------------- | ---------------------- | -------- | ------------------------------------------------------------------- |
| type                | `"test.relay.trigger"` | Yes      | Message discriminator                                               |
| requestId           | string                 | Yes      | Correlation ID for the response                                     |
| actor               | ActorPrincipal         | Yes      | Authenticated principal initiating the run                          |
| routingKey          | string                 | Yes      | Provider routing key                                                |
| fixtureId           | string                 | Yes      | Fixture identifier                                                  |
| event               | TestEvent              | Yes      | Simulated event (type, action, branch, payload)                     |
| workflowName        | string                 | No       | Specific workflow to test (all if omitted)                          |
| uploadId            | string                 | No       | Upload ID returned by `test.relay.uploads.init.response`            |
| cliPublicKey        | string                 | No       | CLI ephemeral X25519 public key used to encrypt the overlay tarball |
| inlineLockFile      | string                 | No       | Lock file sent inline instead of via upload                         |
| fullRepo            | boolean                | No       | Whether the upload is the full working tree (not an overlay)        |
| secrets             | Record<string, string> | No       | Plaintext secrets for the run                                       |
| encryptedSecrets    | string                 | No       | Encrypted secrets blob                                              |
| encryptedSecretsKey | string                 | No       | Key wrapping the encrypted secrets blob                             |

TestEvent: `{ type: string, action?: string, targetBranch: string, sourceBranch?: string, payload: Record<string, unknown>, changedFiles?: string[] }`

#### test.relay.run.status

Request a snapshot of a run's status.

| Field     | Type                      | Required | Description                     |
| --------- | ------------------------- | -------- | ------------------------------- |
| type      | `"test.relay.run.status"` | Yes      | Message discriminator           |
| requestId | string                    | Yes      | Correlation ID for the response |
| actor     | ActorPrincipal            | Yes      | Authenticated principal         |
| runId     | string                    | Yes      | Execution run ID                |

#### test.relay.run.logs

Request the next chunk of a run's logs from a cursor.

| Field     | Type                    | Required | Description                     |
| --------- | ----------------------- | -------- | ------------------------------- |
| type      | `"test.relay.run.logs"` | Yes      | Message discriminator           |
| requestId | string                  | Yes      | Correlation ID for the response |
| actor     | ActorPrincipal          | Yes      | Authenticated principal         |
| runId     | string                  | Yes      | Execution run ID                |
| cursor    | number                  | Yes      | Log cursor to read from         |

#### test.relay.cancel

Request cancellation of a run.

| Field     | Type                  | Required | Description                           |
| --------- | --------------------- | -------- | ------------------------------------- |
| type      | `"test.relay.cancel"` | Yes      | Message discriminator                 |
| requestId | string                | Yes      | Correlation ID for the response       |
| actor     | ActorPrincipal        | Yes      | Authenticated principal               |
| runId     | string                | No       | Run ID to cancel                      |
| branch    | string                | No       | Cancel the active run for this branch |

### Orchestrator -> Platform

#### test.relay.uploads.init.response

Presigned upload URL plus the ephemeral encryption key the CLI uses to encrypt the overlay.

| Field     | Type                                 | Required | Description                                       |
| --------- | ------------------------------------ | -------- | ------------------------------------------------- |
| type      | `"test.relay.uploads.init.response"` | Yes      | Message discriminator                             |
| requestId | string                               | Yes      | ID of the request being responded to              |
| uploadId  | string                               | No       | Upload record ID                                  |
| signedUrl | string                               | No       | Presigned PUT URL for the overlay tarball         |
| publicKey | string                               | No       | Orchestrator public key for overlay encryption    |
| expiresIn | number                               | No       | URL validity window in seconds                    |
| error     | string                               | No       | Failure reason (when the URL could not be minted) |

#### test.relay.trigger.response

Acknowledge a triggered run.

| Field     | Type                            | Required | Description                          |
| --------- | ------------------------------- | -------- | ------------------------------------ |
| type      | `"test.relay.trigger.response"` | Yes      | Message discriminator                |
| requestId | string                          | Yes      | ID of the request being responded to |
| runId     | string                          | No       | Execution run ID                     |
| status    | enum                            | No       | One of: `accepted`, `rejected`       |
| reason    | string                          | No       | Rejection reason (if rejected)       |
| jobIds    | string[]                        | No       | IDs of the jobs created for the run  |
| error     | string                          | No       | Failure reason                       |

#### test.relay.run.status.response

A run-status snapshot.

| Field     | Type                               | Required | Description                                                            |
| --------- | ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| type      | `"test.relay.run.status.response"` | Yes      | Message discriminator                                                  |
| requestId | string                             | Yes      | ID of the request being responded to                                   |
| runId     | string                             | No       | Execution run ID                                                       |
| status    | string                             | No       | Run status                                                             |
| jobs      | array                              | No       | Per-job status: `{ jobId, jobName, status, exitCode?, errorMessage? }` |
| done      | boolean                            | No       | Whether the run has reached a terminal state                           |
| error     | string                             | No       | Failure reason                                                         |

#### test.relay.run.logs.response

The next log chunk plus a monotonic cursor.

| Field      | Type                             | Required | Description                                       |
| ---------- | -------------------------------- | -------- | ------------------------------------------------- |
| type       | `"test.relay.run.logs.response"` | Yes      | Message discriminator                             |
| requestId  | string                           | Yes      | ID of the request being responded to              |
| lines      | string[]                         | No       | Log output lines                                  |
| nextCursor | number                           | No       | Cursor for the next `test.relay.run.logs` request |
| done       | boolean                          | No       | Whether the log stream is exhausted               |
| error      | string                           | No       | Failure reason                                    |

#### test.relay.cancel.response

Acknowledge a cancellation.

| Field     | Type                           | Required | Description                          |
| --------- | ------------------------------ | -------- | ------------------------------------ |
| type      | `"test.relay.cancel.response"` | Yes      | Message discriminator                |
| requestId | string                         | Yes      | ID of the request being responded to |
| cancelled | boolean                        | No       | Whether the run was cancelled        |
| error     | string                         | No       | Failure reason                       |

## WebSocket close codes

KiCI defines custom close codes in the 4000-4999 range (reserved for application use by RFC 6455) alongside standard codes.

| Code | Constant                         | Meaning                                                                                                                                                                              | Sent By |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1001 | `WS_CLOSE_GOING_AWAY`            | Server shutdown or browser navigating away                                                                                                                                           | Server  |
| 4001 | `WS_CLOSE_UNAUTHORIZED`          | Client failed authentication                                                                                                                                                         | Server  |
| 4002 | `WS_CLOSE_AUTH_TIMEOUT`          | Auth timeout expired                                                                                                                                                                 | Server  |
| 4003 | `WS_CLOSE_INVALID_MESSAGE`       | Invalid or unparseable message received                                                                                                                                              | Server  |
| 4004 | `WS_CLOSE_HEARTBEAT_TIMEOUT`     | Heartbeat timed out (180 seconds)                                                                                                                                                    | Server  |
| 4005 | `WS_CLOSE_PROTOCOL_ERROR`        | Protocol-level error                                                                                                                                                                 | Server  |
| 4006 | `WS_CLOSE_INTERNAL_ERROR`        | Unexpected internal server error                                                                                                                                                     | Server  |
| 4010 | `WS_CLOSE_AGENT_AUTH_FAILED`     | Agent token authentication failed                                                                                                                                                    | Server  |
| 4011 | `WS_CLOSE_CLUSTER_NAME_CONFLICT` | Reserved constant; no Platform code path emits this today. Platform accepts N connected orchestrators per `(org_id, cluster_name)` and the dashboard listing dedupes by cluster name | —       |
| 4020 | `WS_CLOSE_PLAN_LIMIT`            | Organization has reached its plan limit                                                                                                                                              | Server  |
| 4030 | `WS_CLOSE_RUN_NOT_FOUND`         | Requested run was not found                                                                                                                                                          | Server  |
| 4031 | `WS_CLOSE_DISPATCH_ACK_TIMEOUT`  | A dispatched job went unacknowledged past its deadline; the orchestrator requeues the job and disconnects the unresponsive agent                                                     | Server  |

> Authoritative source: `packages/engine/src/ws/close-codes.ts`

## Validation

All protocol messages are validated at runtime using Zod discriminated unions. Each WebSocket layer has direction-specific schemas that prevent parsing messages from the wrong direction.

**Orchestrator-Agent layer:**

- Incoming (Orchestrator receives): `agentToOrchestratorMessageSchema` -- parses `agent.register`, `agent.status`, `job.status`, `job.reject`, `job.ack`, `log.chunk`, `step.status`, `job.heartbeat`, `agent.log`, `job.concurrency.report`, `config.ack`, `cache.upload.request`, `cache.upload.complete`, `cache.user.restore.request`, `cache.user.save.request`, `cache.user.save.complete`, `provenance.upload.request`, `provenance.upload.complete`, `event.emit`, `agent.api.request`, `agent.metrics`, `auth.request`, `fleet.bundle.chunk`, `fleet.bundle.error`, `step.approval-request`
- Outgoing (Orchestrator sends): `orchestratorToAgentMessageSchema` -- validates `job.dispatch`, `job.cancel`, `register.ack`, `job.concurrency.ack`, `cache.upload.response`, `cache.user.restore.response`, `cache.user.save.response`, `provenance.upload.response`, `event.emit.response`, `agent.api.response`, `auth.success`, `auth.failure`, `fleet.logs.request`, `step.approval-resolved`

**Peer-to-peer layer:**

- Bidirectional: `peerToPeerMessageSchema` / `peerFromPeerMessageSchema` -- parses `peer.hello`, `peer.hello.response`, `peer.auth.request`, `peer.auth.response`, `peer.heartbeat`, `job.reroute`, `job.reroute.ack`, `job.progress`, `peer.job.cancel`, `raft.vote.request`, `raft.vote.response`, `raft.append.entries`, `peer.log.chunk`, `peer.cache.upload.request`, `peer.cache.upload.response`, `peer.config.reload`, `peer.config.reload.response`, `peer.leaving`, `peer.agent-token.revoke`, `scaler.event`

The upstream layers (orchestrator↔KiCI and browser↔KiCI) have their own discriminated unions.

**Usage example:**

```typescript
import { agentToOrchestratorMessageSchema } from '@kici-dev/engine';

// Parse and validate an incoming message
const message = agentToOrchestratorMessageSchema.parse(JSON.parse(rawData));

// TypeScript narrows the type based on the 'type' discriminator
switch (message.type) {
  case 'agent.register':
    handleRegister(message.agentId, message.labels);
    break;
  case 'job.status':
    handleStatus(message.runId, message.jobId, message.status);
    break;
}
```

## Request tracing model

KiCI propagates a `requestId` (UUIDv4) through the entire webhook processing pipeline for end-to-end observability. The trace ID enables correlating all log lines, database operations, and protocol messages belonging to a single webhook event.

### requestId lifecycle

1. **Origin:** Generated at webhook ingestion -- either by KiCI (for WS-relayed webhooks) or by the orchestrator's direct HTTP endpoint (for independent/hybrid mode)
2. **Pipeline propagation:** Carried through AsyncLocalStorage (ALS) during synchronous webhook processing: `webhook.relay` -> `processWebhook` -> trigger matching -> execution start -> job dispatch
3. **Queue persistence:** When no agent is immediately available, the `requestId` is persisted in the `dispatch_queue` PostgreSQL table alongside the job payload
4. **Queue restoration:** When a queued job is drained (agent becomes available), the `requestId` is read from the database and restored into a new ALS scope via `requestContext.run()`
5. **Agent dispatch:** Included in the `job.dispatch` message so the agent can log it during execution
6. **Completion callbacks:** Stored in the `ExecutionTracker`'s in-memory `RunState` at execution start, then passed back to `onExecutionComplete` and `onStepStatusForward` callbacks. The callback handlers in `server.ts` and `standalone.ts` restore ALS context via `requestContext.run()` so that check run updates and upstream forwarding are logged with the correct trace ID.

### app.service field

The `app.service` field identifies which KiCI tier produced a log line (values: `platform`, `orchestrator`, `agent`). Set process-wide at startup via `setServiceName()` from `@kici-dev/shared`. This field is independent of container naming and works in all deployment models (containerized, bare-metal, Firecracker). For forwarded agent logs flowing through orchestrator stdout, the `service` field is preserved from the agent's original JSON output.

## See also
