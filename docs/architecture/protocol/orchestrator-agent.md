---
title: Orchestrator ↔ Agent messages
description: Job dispatch, cancel, registration, log streaming, job and step status, heartbeats, cache upload, event emit, execution status forwarding
---

This layer carries job dispatch commands and execution status reports between customer-deployed orchestrators and agents.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

## Error fields never carry raw exception text

Nine orchestrator-to-agent fields describe a failure in free text: `error` on `event.emit.response`, `agent.api.response`, `artifacts.upload.response` and `artifacts.download.response`, and `reason` on `step.approval-resolved`, `artifacts.upload.complete.ack`, `auth.failure`, `job.cancel` and `job.concurrency.ack`.

None of them ever carries the text of an orchestrator exception. The rule is the same in every family:

- A failure the workflow author can act on — an unknown job context, a rejected upload name, an approver's decline note, an expired approval window — rides the orchestrator's own return value with fixed, author-facing wording. It stays specific enough to fix the workflow without operator log access.
- An internal failure is recorded in the orchestrator's own logs with the full exception, and the agent receives a safe fixed string that classifies the failure without naming any infrastructure.

The reason is the trust boundary: the agent executes customer workflow code, and whatever these fields carry is readable by that code and persisted into the author's step logs. Raw exception text there would disclose database and storage endpoints, constraint names and internal identifiers to anyone who can write a workflow.

A new orchestrator-to-agent failure field inherits this rule; it does not need its own entry here.

## Job dispatch and lifecycle messages

These messages carry job dispatch and cancellation, agent registration, and the status, log and heartbeat reports an agent sends back while it executes.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Orchestrator -> Agent

#### job.dispatch

Dispatches a job to an agent for execution. Contains everything the agent needs to clone, configure, and run the job.

| Field              | Type                                    | Required | Description                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type               | `"job.dispatch"`                        | Yes      | Message discriminator                                                                                                                                                                                                                                                                                  |
| messageId          | string                                  | Yes      | Unique message ID                                                                                                                                                                                                                                                                                      |
| runId              | string                                  | Yes      | Execution run ID                                                                                                                                                                                                                                                                                       |
| jobId              | string                                  | Yes      | Job ID within the run                                                                                                                                                                                                                                                                                  |
| repoUrl            | string                                  | Yes      | Git repository URL                                                                                                                                                                                                                                                                                     |
| ref                | string                                  | Yes      | Git ref to checkout (branch name or SHA)                                                                                                                                                                                                                                                               |
| sha                | string                                  | Yes      | Commit SHA                                                                                                                                                                                                                                                                                             |
| lockFileUrl        | string                                  | Yes      | URL to fetch the lock file                                                                                                                                                                                                                                                                             |
| jobConfig          | Record<string, unknown>                 | Yes      | Job configuration from the lock file (`LockJob` or `LockDynamicJobFn`)                                                                                                                                                                                                                                 |
| timestamp          | number                                  | Yes      | Unix timestamp (milliseconds)                                                                                                                                                                                                                                                                          |
| token              | string                                  | No       | Short-lived GitHub installation token for private repo clone                                                                                                                                                                                                                                           |
| secrets            | Record<string, string>                  | No       | Orchestrator-provided secrets to merge into step environment                                                                                                                                                                                                                                           |
| namespacedSecrets  | Record<string, Record<string, string>>  | No       | Namespaced secrets by context name: `{ 'context-name': { KEY: 'value' } }`                                                                                                                                                                                                                             |
| maxLogSizeBytes    | number                                  | No       | Max log size per step in bytes (agent defaults to 10MB)                                                                                                                                                                                                                                                |
| sourceTarUrl       | string                                  | No       | Pre-signed URL to the `.kici/` source tarball (skips agent-side clone). Agent extracts into the work directory and imports the workflow `.ts` via the shared TypeScript loader hook.                                                                                                                   |
| sourceTarHash      | string                                  | No       | Workflow `contentHash` (NOT the tarball-bytes hash). The agent re-computes this hash against the extracted source to detect drift against the lock file; the tarball bytes themselves are trusted via the orchestrator-signed S3 GET URL.                                                              |
| depsUrl            | string                                  | No       | Pre-signed URL to the `node_modules` tarball (skips npm install)                                                                                                                                                                                                                                       |
| depsHash           | string                                  | No       | SHA-256 hash of the dependency tarball bytes, used for streaming integrity verification on download                                                                                                                                                                                                    |
| requestId          | string                                  | No       | Trace ID (UUIDv4) from the originating webhook event                                                                                                                                                                                                                                                   |
| runPublicKey       | string                                  | No       | Base64-encoded X25519 public key for encrypting secret outputs                                                                                                                                                                                                                                         |
| upstreamJobOutputs | Record<string, Record<string, unknown>> | No       | Outputs from upstream dependency jobs, keyed by job name                                                                                                                                                                                                                                               |
| sourceAuth         | GitAuth                                 | No       | Structured clone auth for the source repo. Preferred over `token`; when both are set they must agree (`sourceAuth.kind === 'basic'` and `sourceAuth.secret === token`) or the dispatch is rejected.                                                                                                    |
| workflowAuth       | GitAuth                                 | No       | Structured clone auth for the **workflow** repo in a global-workflow dispatch where the workflow is authored on a different source than the source repo. Absent for same-provider global workflows (agent reuses `sourceAuth` for both clones).                                                        |
| npmRegistries      | NpmRegistry[]                           | No       | Private npm registries the agent should authenticate against before `npm install`. Each entry's `token` is the resolved value (the orchestrator already looked it up via the per-environment secret resolver and protection-rule gates have already passed). Untrusted contributors get an empty list. |
| installEnvSecrets  | Record<string, string>                  | No       | Extra resolved secrets to project as env vars on the install subprocess. Keyed by the bare secret name (the qualified `env:` prefix is stripped at resolution time). For use with a customer-committed `.kici/.npmrc` containing `${VAR}` placeholders.                                                |

NpmRegistry:

| Field      | Type    | Required | Description                                                       |
| ---------- | ------- | -------- | ----------------------------------------------------------------- |
| url        | string  | Yes      | Registry URL                                                      |
| scope      | string  | No       | npm scope this registry serves (e.g., `@my-org`)                  |
| alwaysAuth | boolean | Yes      | Send credentials on every request (not just authenticated routes) |
| token      | string  | Yes      | Resolved auth token for the registry                              |

GitAuth:

| Field            | Type   | Required    | Description                                                                                                         |
| ---------------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| kind             | enum   | Yes         | One of: `basic` (HTTPS Basic auth, PAT/password) or `ssh` (SSH private key)                                         |
| user             | string | No          | Basic-auth username (omit for SSH; defaults filled in by the provider, e.g. `x-access-token` for GitHub-style PATs) |
| secret           | string | Yes         | Basic-auth password/PAT, or PEM-encoded SSH private key                                                             |
| sshHostKeyPolicy | enum   | No          | SSH-only. `accept-new` trusts first-seen host keys; `pinned` requires `sshKnownHostsPem`                            |
| sshKnownHostsPem | string | Conditional | SSH-only, required when `sshHostKeyPolicy === 'pinned'`. OpenSSH `known_hosts` content                              |

**requestId persistence through the dispatch queue:** When a job is dispatched immediately (agent available), `requestId` is read from the current AsyncLocalStorage context. When a job is queued (no agent available) and later drained, the `requestId` is persisted in the `dispatch_queue` database table and restored when the job is dequeued. This ensures the `job.dispatch` message always carries the original webhook's trace ID, enabling end-to-end traceability even for delayed dispatches.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobDispatchSchema`

#### job.cancel

Cancels a running or queued job on the agent.

| Field     | Type           | Required | Description                                                   |
| --------- | -------------- | -------- | ------------------------------------------------------------- |
| type      | `"job.cancel"` | Yes      | Message discriminator                                         |
| messageId | string         | Yes      | Unique message ID                                             |
| runId     | string         | Yes      | Execution run ID                                              |
| jobId     | string         | Yes      | Job ID to cancel                                              |
| reason    | string         | Yes      | Human-readable cancellation reason                            |
| force     | boolean        | No       | When true, force-cancel immediately without waiting for hooks |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobCancelSchema`

#### register.ack

Acknowledges agent registration and sends confirmed config back to the agent. The agent transitions to `registered` state only after receiving this message (with a 10s fallback for backward compatibility with older orchestrators).

| Field           | Type             | Required | Description                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type            | `"register.ack"` | Yes      | Message discriminator                                                                                                                                                                                                                                                                                                                                       |
| agentId         | string           | Yes      | Confirmed agent identifier                                                                                                                                                                                                                                                                                                                                  |
| labels          | string[]         | Yes      | Confirmed capability labels                                                                                                                                                                                                                                                                                                                                 |
| scalerManaged   | boolean          | No       | Whether agent is managed by auto-scaler (default: `false`)                                                                                                                                                                                                                                                                                                  |
| pendingDispatch | boolean          | No       | When set, the orchestrator's scaler bound a specific queued job to this agent at spawn time and the `job.dispatch` message is in flight. Scaler-managed agents that see this flag must not arm the short `KICI_SCALER_IDLE_TIMEOUT` timer on register — the `KICI_SCALER_PENDING_DISPATCH_TIMEOUT` safety net still applies if the dispatch never arrives.  |
| capabilities    | object           | No       | Optional agent-facing capabilities this orchestrator supports (absent on orchestrators that predate capability advertisement). Every flag is optional and absent means unsupported, so a newer agent falls back to the unnegotiated behavior. Today: `artifactCompleteAck` — the orchestrator acks [`artifacts.upload.complete`](#artifactsuploadcomplete). |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `registerAckSchema`

### Agent -> Orchestrator

#### agent.register

Sent immediately after connection as the first message. The orchestrator responds with `register.ack` to confirm registration and provide config. The agent transitions to `registered` state upon receiving the ack. A 10s fallback timer allows backward compatibility with older orchestrators that do not send `register.ack`.

| Field          | Type               | Required | Description                                                |
| -------------- | ------------------ | -------- | ---------------------------------------------------------- |
| type           | `"agent.register"` | Yes      | Message discriminator                                      |
| messageId      | string             | Yes      | Unique message ID                                          |
| agentId        | string             | Yes      | Unique agent identifier                                    |
| labels         | string[]           | Yes      | Capability labels for job routing                          |
| maxConcurrency | number             | No       | Maximum concurrent jobs this agent handles (defaults to 1) |
| platform       | string             | No       | Agent platform (`os.platform()`, e.g., `linux`, `darwin`)  |
| arch           | string             | No       | Agent architecture (`os.arch()`, e.g., `x64`, `arm64`)     |
| version        | string             | No       | Agent version (e.g., `"0.0.1"`)                            |
| inFlightJobs   | InFlightJob[]      | No       | Jobs still running on reconnection (enables job recovery)  |
| hostname       | string             | No       | Machine hostname (`os.hostname()`)                         |
| osRelease      | string             | No       | OS kernel release (`os.release()`)                         |
| osVersion      | string             | No       | OS version string (`os.version()`)                         |
| totalMemoryMb  | number             | No       | Total system memory in MiB                                 |
| cpuCount       | number             | No       | Number of logical CPUs                                     |
| nodeVersion    | string             | No       | Node.js version (`process.versions.node`)                  |
| runningAsUser  | string             | No       | Username of the OS user running the agent process          |
| runningAsUid   | number             | No       | UID of the OS user running the agent process               |

InFlightJob: `{ jobId: string, runId: string }`

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentRegisterSchema`

#### agent.status

Periodic capacity update. Tells the orchestrator how many job slots are available.

| Field             | Type             | Required | Description                                         |
| ----------------- | ---------------- | -------- | --------------------------------------------------- |
| type              | `"agent.status"` | Yes      | Message discriminator                               |
| messageId         | string           | Yes      | Unique message ID                                   |
| agentId           | string           | Yes      | Unique agent identifier                             |
| activeJobs        | number           | Yes      | Number of currently running jobs                    |
| memoryUsedMb      | number           | No       | Used memory in MiB (`os.totalmem() - os.freemem()`) |
| memoryAvailableMb | number           | No       | Available memory in MiB (`os.freemem()`)            |
| uptimeSeconds     | number           | No       | System uptime in seconds (`os.uptime()`)            |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentStatusSchema`

#### job.status

Reports a job execution state transition. Sent at each lifecycle boundary (queued, running, success, failed, etc.).

| Field         | Type                                                          | Required | Description                                                                                                                                                       |
| ------------- | ------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type          | `"job.status"`                                                | Yes      | Message discriminator                                                                                                                                             |
| messageId     | string                                                        | Yes      | Unique message ID                                                                                                                                                 |
| runId         | string                                                        | Yes      | Execution run ID                                                                                                                                                  |
| jobId         | string                                                        | Yes      | Job ID within the run                                                                                                                                             |
| state         | enum                                                          | Yes      | One of: `pending`, `queued`, `running`, `recovering`, `cancelling`, `success`, `failed`, `cancelled`, `skipped`, `timed_out_stale`, `drift_dropped`, `unroutable` |
| timestamp     | number                                                        | Yes      | Unix timestamp (milliseconds)                                                                                                                                     |
| data          | Record<string, unknown>                                       | No       | Optional state-specific data (error messages, timing, etc.)                                                                                                       |
| droppedJobs   | string[]                                                      | No       | Job names dropped by determinism drift (agent re-eval produced fewer jobs than expected)                                                                          |
| secretOutputs | Record<string, { agentPublicKey: string, encrypted: string }> | No       | Encrypted secret outputs from agent (present on job success when secret outputs exist)                                                                            |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobStatusSchema`

`job.status` (and `step.status` below) ride the agent's durable send path: when the
WebSocket is down or the agent has not yet re-registered, the frame is enqueued in
the agent's reconnect buffer and replayed after `register.ack`, in order, ahead of
new frames. A terminal transition (`success`/`failed`/`cancelled`) reported the
instant the connection drops is therefore delivered on reconnect rather than lost —
the same replay guarantee log lines have. The orchestrator treats a re-delivered
terminal frame idempotently (a completed dispatch row is not reopened). Only
connection-liveness frames like `job.heartbeat` remain unbuffered.

The upstream tier closes the complementary gap: if a run's terminal transition is
lost on a still-live connection (never disconnected, so no reconnect replay
fires), a periodic reconciliation sweep re-reads the run's current state from the
owning orchestrator and settles the run. A run therefore reaches its terminal
state even when the deciding frame is dropped mid-flight, not only when the
connection drops and reconnects.

#### job.ack

Positive dispatch acknowledgment. Sent the moment the agent receives a `job.dispatch` and accepts it — after the drain and busy checks pass, before execution begins. It resolves the orchestrator's dispatch-ack deadline (see below) so a dispatch that actually arrived is never mistaken for a lost one.

| Field     | Type        | Required | Description                   |
| --------- | ----------- | -------- | ----------------------------- |
| type      | `"job.ack"` | Yes      | Message discriminator         |
| messageId | string      | Yes      | Unique message ID             |
| runId     | string      | Yes      | Execution run ID              |
| jobId     | string      | Yes      | Job ID within the run         |
| timestamp | number      | Yes      | Unix timestamp (milliseconds) |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobAckSchema`

#### job.reject

Explicit dispatch rejection. Sent when the agent cannot accept a `job.dispatch` — it is already running a job (`busy`) or is draining (`draining`). Every `job.dispatch` is answered: accepted with `job.ack` (a `job.status` with state `running` also resolves the deadline) or refused with this message. On receiving it the orchestrator undoes its dispatch accounting and requeues the job for another agent. An unanswered dispatch is recovered by the dispatch-ack deadline (below) and by disconnect-time triage.

| Field     | Type           | Required | Description                   |
| --------- | -------------- | -------- | ----------------------------- |
| type      | `"job.reject"` | Yes      | Message discriminator         |
| messageId | string         | Yes      | Unique message ID             |
| runId     | string         | Yes      | Execution run ID              |
| jobId     | string         | Yes      | Job ID within the run         |
| reason    | enum           | Yes      | One of: `busy`, `draining`    |
| timestamp | number         | Yes      | Unix timestamp (milliseconds) |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobRejectSchema`

#### Dispatch acknowledgment deadline

A `job.dispatch` message can be lost in transit — most visibly when a scaler-managed agent tears down inside its post-job idle window while a dispatch is in flight. To make "dispatched but never received" detectable, every `job.dispatch` carries a deadline:

- When the orchestrator sends a dispatch it stamps a deadline (`dispatch_queue.ack_deadline`) and arms an in-memory timer. The deadline starts when the message is actually sent, not before the secret-merge and token-mint preparation.
- The deadline is resolved by any answer: `job.ack` (accept), `job.reject` (refuse), or a `job.status` with state `running` (which doubles as an ack in case the ack itself was lost).
- If no answer arrives in time, the dispatch is treated as lost: the orchestrator requeues the job (reusing the same attempt budget and scaler-consult machinery as a rejected dispatch) and disconnects the unresponsive agent with the `4031` close code. A scaler-managed agent is then destroyed by its normal lifecycle; a static agent reconnects and re-syncs.

The deadline survives an orchestrator restart or leader switch: it is persisted in `dispatch_queue`, re-armed from the persisted rows on boot, and any deadline that elapsed while no coordinator was watching is swept on the leader. The default is 10 seconds (`KICI_DISPATCH_ACK_TIMEOUT_MS`), overridable per org via `org_settings.dispatch_ack_timeout_ms` (`kici-admin org-settings dispatch-ack`).

#### step.status

Reports a step-level execution state transition. Sent for each step within a job.

| Field            | Type                    | Required | Description                                                                                                                                                                                                                      |
| ---------------- | ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type             | `"step.status"`         | Yes      | Message discriminator                                                                                                                                                                                                            |
| messageId        | string                  | Yes      | Unique message ID                                                                                                                                                                                                                |
| runId            | string                  | Yes      | Execution run ID                                                                                                                                                                                                                 |
| jobId            | string                  | Yes      | Job ID within the run                                                                                                                                                                                                            |
| stepIndex        | number (int >= 0)       | Yes      | Zero-based step index                                                                                                                                                                                                            |
| stepName         | string                  | Yes      | Human-readable step name                                                                                                                                                                                                         |
| state            | enum                    | Yes      | One of: `running`, `success`, `failed`, `skipped`                                                                                                                                                                                |
| timestamp        | number                  | Yes      | Unix timestamp (milliseconds)                                                                                                                                                                                                    |
| data             | Record<string, unknown> | No       | Optional state-specific data (error, duration, etc.)                                                                                                                                                                             |
| step_type        | enum                    | No       | Distinguishes regular steps from hook executions: `step`, `hook:onCancel`, `hook:cleanup`, `hook:onSuccess`, `hook:onFailure`, `hook:beforeStep`, `hook:afterStep`                                                               |
| secretsAccessed  | string[]                | No       | Secret key names accessed by this step via `ctx.secrets.get()`/`expose()`. Never contains values                                                                                                                                 |
| logBytesStreamed | number (int >= 0)       | No       | Total raw bytes streamed by this step's LogStreamer at terminal time. Set on terminal step states only; reused by the orchestrator to accumulate per-job and per-run totals for the `kici_org_log_bytes` capacity-planning gauge |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentStepStatusSchema`

#### log.chunk (Agent direction)

Streams log output from step execution to the orchestrator. The orchestrator may forward these upstream for dashboard display.

| Field     | Type          | Required | Description                                                                              |
| --------- | ------------- | -------- | ---------------------------------------------------------------------------------------- |
| type      | `"log.chunk"` | Yes      | Message discriminator                                                                    |
| messageId | string        | Yes      | Unique message ID                                                                        |
| runId     | string        | Yes      | Execution run ID                                                                         |
| jobId     | string        | Yes      | Job ID within the run                                                                    |
| stepIndex | number        | Yes      | Zero-based step index                                                                    |
| lines     | string[]      | Yes      | Array of log output lines                                                                |
| timestamp | number        | Yes      | Unix timestamp (milliseconds)                                                            |
| stream    | enum          | No       | Stream these lines came from: `stdout`, `stderr`. Absent (older agent) reads as `stdout` |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentLogChunkSchema`

#### job.heartbeat

Periodic heartbeat sent by agents for each running job. Used by the orchestrator's stale run detector to identify jobs that have stopped progressing. Unlike connection-level heartbeats, this is per-job.

| Field     | Type              | Required | Description                   |
| --------- | ----------------- | -------- | ----------------------------- |
| type      | `"job.heartbeat"` | Yes      | Message discriminator         |
| runId     | string            | Yes      | Execution run ID              |
| jobId     | string            | Yes      | Job ID within the run         |
| timestamp | number            | Yes      | Unix timestamp (milliseconds) |

Note: `job.heartbeat` has no `messageId` field -- it is a lightweight fire-and-forget message.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `jobHeartbeatSchema`

#### agent.log

Operational log lines streamed from stateful/external agents to the orchestrator via WebSocket. Used for agents whose logs cannot be captured by the host (e.g., Firecracker VMs, external agents). Lines are batched (up to 50 lines or 100ms debounce) for efficiency.

| Field     | Type          | Required | Description                   |
| --------- | ------------- | -------- | ----------------------------- |
| type      | `"agent.log"` | Yes      | Message discriminator         |
| messageId | string        | Yes      | Unique message ID             |
| agentId   | string        | Yes      | Agent identifier              |
| lines     | string[]      | Yes      | Array of log output lines     |
| timestamp | number        | Yes      | Unix timestamp (milliseconds) |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentLogSchema`

#### config.ack

Sent by the agent after receiving and applying `register.ack` config. Signals the orchestrator that MMDS data can be cleared for Firecracker agents. In Firecracker/scaler-managed mode, the agent also blocks MMDS access via iptables before sending this acknowledgment.

| Field     | Type           | Required | Description                           |
| --------- | -------------- | -------- | ------------------------------------- |
| type      | `"config.ack"` | Yes      | Message discriminator                 |
| messageId | string         | Yes      | Unique message ID                     |
| agentId   | string         | Yes      | Agent identifier acknowledging config |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `configAckSchema`

## Event emit messages

These messages support custom event emission from running workflow steps. When a step calls `ctx.emit()`, the agent sends an `event.emit` message to the orchestrator, which responds with a delivery receipt.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### event.emit

Emits a custom event from a running workflow step. The orchestrator stores the event, performs fan-out matching against lock file subscriptions, and returns a delivery receipt.

| Field     | Type                    | Required | Description                                   |
| --------- | ----------------------- | -------- | --------------------------------------------- |
| type      | `"event.emit"`          | Yes      | Message discriminator                         |
| jobId     | string                  | Yes      | Job that is emitting the event                |
| requestId | string                  | Yes      | Correlates request to response for routing    |
| eventName | string                  | Yes      | Custom event name (e.g., `"deploy-complete"`) |
| payload   | Record<string, unknown> | Yes      | Event payload data                            |
| target    | object                  | No       | Cross-repo targeting: `{ repos?: string[] }`  |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `eventEmitSchema`

### Orchestrator -> Agent

#### event.emit.response

Response confirming event delivery. Contains either a `deliveryId` on success or an `error` on failure.

| Field      | Type                    | Required | Description                                       |
| ---------- | ----------------------- | -------- | ------------------------------------------------- |
| type       | `"event.emit.response"` | Yes      | Message discriminator                             |
| requestId  | string                  | Yes      | Correlates to the original `event.emit` requestId |
| deliveryId | string                  | No       | Delivery ID assigned by orchestrator (on success) |
| error      | string                  | No       | Error description (on failure)                    |

`error` is either a deliberate author-facing reason — an unknown job context — or a safe fixed string classifying an internal failure. It is never raw exception text.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `eventEmitResponseSchema`

## Cache upload messages

These messages support agent direct-to-S3 cache uploads. The agent requests a pre-signed upload URL from the orchestrator, performs the upload directly to object storage, then confirms completion so the orchestrator can update cache metadata.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### cache.upload.request

Request a pre-signed upload URL for cache storage (source bundle or dependency tarball).

| Field        | Type                     | Required | Description                             |
| ------------ | ------------------------ | -------- | --------------------------------------- |
| type         | `"cache.upload.request"` | Yes      | Message discriminator                   |
| messageId    | string                   | Yes      | Unique message ID                       |
| jobId        | string                   | Yes      | Job that produced the artifact          |
| cacheType    | enum                     | Yes      | One of: `source`, `deps`                |
| contentHash  | string                   | No       | Content hash for cache keying           |
| lockfileHash | string                   | No       | Lockfile hash for cache keying          |
| platform     | string                   | Yes      | OS platform (e.g., `linux`)             |
| arch         | string                   | Yes      | CPU architecture (e.g., `x64`, `arm64`) |

#### cache.upload.complete

Confirm that an upload finished so the orchestrator can update metadata.

| Field        | Type                      | Required | Description                                                    |
| ------------ | ------------------------- | -------- | -------------------------------------------------------------- |
| type         | `"cache.upload.complete"` | Yes      | Message discriminator                                          |
| messageId    | string                    | Yes      | Unique message ID                                              |
| jobId        | string                    | Yes      | Job that produced the artifact                                 |
| cacheType    | enum                      | Yes      | One of: `source`, `deps`                                       |
| contentHash  | string                    | No       | Content hash for cache keying                                  |
| lockfileHash | string                    | No       | Lockfile hash for cache keying                                 |
| platform     | string                    | Yes      | OS platform (e.g., `linux`)                                    |
| arch         | string                    | Yes      | CPU architecture (e.g., `x64`, `arm64`)                        |
| depsHash     | string                    | No       | SHA-256 of the dep tarball (for agent-side integrity checking) |

#### cache.user.restore.request

Request a user-cache restore (declarative or imperative `ctx.cache`) — the orchestrator returns a pre-signed download URL for the matching entry.

| Field       | Type                           | Required | Description                                           |
| ----------- | ------------------------------ | -------- | ----------------------------------------------------- |
| type        | `"cache.user.restore.request"` | Yes      | Message discriminator                                 |
| messageId   | string                         | Yes      | Unique message ID                                     |
| jobId       | string                         | Yes      | Job requesting the restore                            |
| key         | string                         | Yes      | Exact cache key                                       |
| restoreKeys | string[]                       | No       | Ordered prefix fallbacks (newest matching entry wins) |

#### cache.user.save.request

Request a pre-signed upload slot for a user-cache save. Keys are immutable, so the orchestrator may decline when the key already exists.

| Field     | Type                        | Required | Description           |
| --------- | --------------------------- | -------- | --------------------- |
| type      | `"cache.user.save.request"` | Yes      | Message discriminator |
| messageId | string                      | Yes      | Unique message ID     |
| jobId     | string                      | Yes      | Job saving the cache  |
| key       | string                      | Yes      | Exact cache key       |

#### cache.user.save.complete

Confirm a user-cache upload finished so the orchestrator can commit the temp object to its final key and record metadata.

| Field     | Type                         | Required | Description                                     |
| --------- | ---------------------------- | -------- | ----------------------------------------------- |
| type      | `"cache.user.save.complete"` | Yes      | Message discriminator                           |
| messageId | string                       | Yes      | Unique message ID                               |
| jobId     | string                       | Yes      | Job that produced the artifact                  |
| key       | string                       | Yes      | Exact cache key                                 |
| tarHash   | string                       | Yes      | SHA-256 of the tarball bytes                    |
| sizeBytes | number                       | Yes      | Tarball size in bytes (drives quota accounting) |

### Orchestrator -> Agent

#### cache.upload.response

Return the pre-signed upload URL for the agent to upload directly to object storage.

| Field     | Type                      | Required | Description                         |
| --------- | ------------------------- | -------- | ----------------------------------- |
| type      | `"cache.upload.response"` | Yes      | Message discriminator               |
| requestId | string                    | Yes      | Correlates to the original request  |
| uploadUrl | string                    | Yes      | Pre-signed URL for direct S3 upload |

#### cache.user.restore.response

Return the matched user-cache entry's pre-signed download URL, or signal a miss.

| Field       | Type                            | Required | Description                                                      |
| ----------- | ------------------------------- | -------- | ---------------------------------------------------------------- |
| type        | `"cache.user.restore.response"` | Yes      | Message discriminator                                            |
| requestId   | string                          | Yes      | Correlates to the original request                               |
| hit         | boolean                         | Yes      | True when an entry matched (exact or prefix)                     |
| matchedKey  | string                          | No       | Full key that matched (exact or the matched prefix entry)        |
| downloadUrl | string                          | No       | Pre-signed GET URL for the matched tarball (present only on hit) |
| tarHash     | string                          | No       | SHA-256 of the tarball bytes for integrity verification          |

#### cache.user.save.response

Return the pre-signed upload URL, or signal `skip` when the immutable key already exists.

| Field     | Type                         | Required | Description                                                        |
| --------- | ---------------------------- | -------- | ------------------------------------------------------------------ |
| type      | `"cache.user.save.response"` | Yes      | Message discriminator                                              |
| requestId | string                       | Yes      | Correlates to the original request                                 |
| uploadUrl | string                       | No       | Pre-signed PUT URL to the temp object (absent when `skip` is true) |
| skip      | boolean                      | Yes      | True when the exact key already exists (immutable no-op)           |

## Provenance attestation messages

These messages mirror the cache-upload handshake for build provenance bundles: the agent requests a pre-signed PUT URL keyed by the artifact's subject digest, uploads the attestation directly to object storage, then confirms completion so the orchestrator records an attestations row. When the signed statement cannot be minted at build time, the agent instead sends `provenance.upload.defer` carrying the frozen DSSE envelope so the mint can complete later.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### provenance.upload.request

Request a pre-signed PUT URL for a provenance bundle. The orchestrator resolves the run server-side and ownership-checks the job.

| Field         | Type                          | Required | Description                                                       |
| ------------- | ----------------------------- | -------- | ----------------------------------------------------------------- |
| type          | `"provenance.upload.request"` | Yes      | Message discriminator                                             |
| messageId     | string                        | Yes      | Unique message ID                                                 |
| jobId         | string                        | Yes      | Job producing the attestation (ownership-checked)                 |
| subjectDigest | string                        | Yes      | Primary subject digest (lowercase hex); storage-key discriminator |

#### provenance.upload.complete

Confirm a provenance bundle upload so the orchestrator records an attestations row.

| Field         | Type                           | Required | Description                            |
| ------------- | ------------------------------ | -------- | -------------------------------------- |
| type          | `"provenance.upload.complete"` | Yes      | Message discriminator                  |
| messageId     | string                         | Yes      | Unique message ID                      |
| jobId         | string                         | Yes      | Job producing the attestation          |
| subjectName   | string                         | Yes      | Caller-supplied artifact name          |
| subjectDigest | string                         | Yes      | Primary subject digest (lowercase hex) |
| mediaType     | string                         | Yes      | Bundle media type                      |

#### provenance.upload.defer

Hand a frozen, DSSE-signed statement to the orchestrator for a later mint when the attestation cannot be signed at build time. The envelope and its ephemeral public key are carried inline; `statementHash` binds the deferred mint to this exact payload.

| Field         | Type                        | Required | Description                                           |
| ------------- | --------------------------- | -------- | ----------------------------------------------------- |
| type          | `"provenance.upload.defer"` | Yes      | Message discriminator                                 |
| messageId     | string                      | Yes      | Unique message ID                                     |
| jobId         | string                      | Yes      | Job producing the attestation                         |
| subjectName   | string                      | Yes      | Caller-supplied artifact name                         |
| subjectDigest | string                      | Yes      | Primary subject digest (lowercase hex)                |
| audience      | string                      | Yes      | Requested token audience for the later mint           |
| mediaType     | string                      | Yes      | Bundle media type                                     |
| statementHash | string                      | Yes      | SHA-256 of the frozen DSSE statement payload          |
| dsseEnvelope  | object                      | Yes      | The frozen, DSSE-signed statement envelope            |
| publicKey     | object                      | Yes      | Ephemeral public key JWK the envelope was signed with |

### Orchestrator -> Agent

#### provenance.upload.response

Return the pre-signed PUT URL for the agent to upload the bundle directly to object storage.

| Field     | Type                           | Required | Description                                             |
| --------- | ------------------------------ | -------- | ------------------------------------------------------- |
| type      | `"provenance.upload.response"` | Yes      | Message discriminator                                   |
| requestId | string                         | Yes      | Correlates to the original request                      |
| uploadUrl | string                         | Yes      | Pre-signed PUT URL, or `""` when storage is unavailable |

## Artifact messages

These messages carry the run-scoped artifact upload/download handshake. When a step uploads a named artifact, the agent requests a pre-signed PUT URL; the orchestrator validates the artifact name and runs the enforcement gates (duplicate name, per-artifact/per-run size cap, org quota) before minting the URL, so a granted URL is always safe to upload to. Downloads resolve a named artifact within the same run to a pre-signed GET.

The orchestrator checks the artifact name itself rather than trusting the agent's own check, because the name becomes a path segment of the storage key. It must be a short token of letters, digits, `.`, `_`, and `-`, up to 128 characters, and not made only of dots. Under that contract the name maps to its storage segment unchanged, so two distinct names can never produce the same key — a name outside it would be folded onto another name's key, letting a second upload overwrite the first object while both records keep their own hash. The same check runs on the upload request and on the upload completion, since either message can carry a name. The key also carries a hash of the exact name, so two names differing only by case differ by more than case and address distinct objects on a case-insensitive object store as well.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### artifacts.upload.request

Request a pre-signed PUT URL for a named artifact upload.

| Field             | Type                         | Required | Description                                                                    |
| ----------------- | ---------------------------- | -------- | ------------------------------------------------------------------------------ |
| type              | `"artifacts.upload.request"` | Yes      | Message discriminator                                                          |
| messageId         | string                       | Yes      | Unique message ID                                                              |
| jobId             | string                       | Yes      | Job producing the artifact (ownership-checked; run + org resolved server-side) |
| name              | string                       | Yes      | Artifact name (immutability + storage-key discriminator within the run)        |
| declaredSizeBytes | number (int >= 0)            | Yes      | Packed tarball size in bytes; drives the size/run/quota enforcement gates      |

#### artifacts.upload.complete

Confirm an artifact upload finished so the orchestrator records the artifacts row. The orchestrator replies with an [`artifacts.upload.complete.ack`](#artifactsuploadcompleteack) when it advertises the `artifactCompleteAck` capability, and the agent waits for it before the upload step returns.

The orchestrator does not trust the agent's `storageKey` or `sizeBytes`: it derives the storage key from the run and artifact name it resolved server-side, and records the real object size it reads back from storage. Both fields stay on the wire (deprecated, still sent) for compatibility with older orchestrators — see [deprecations](../../user/deprecations.md).

| Field      | Type                          | Required | Description                                                                                      |
| ---------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| type       | `"artifacts.upload.complete"` | Yes      | Message discriminator                                                                            |
| messageId  | string                        | Yes      | Unique message ID                                                                                |
| jobId      | string                        | Yes      | Job producing the artifact                                                                       |
| name       | string                        | Yes      | Artifact name                                                                                    |
| sizeBytes  | number (int >= 0)             | Yes      | Packed tarball size in bytes. Deprecated — advisory; the orchestrator records the verified size  |
| sha256     | string                        | Yes      | SHA-256 (hex) of the tarball bytes                                                               |
| storageKey | string                        | Yes      | Storage key echoed from the grant response. Deprecated — ignored; the key is derived server-side |

#### artifacts.download.request

Request a pre-signed GET URL for a named artifact of this run.

| Field     | Type                           | Required | Description                                                               |
| --------- | ------------------------------ | -------- | ------------------------------------------------------------------------- |
| type      | `"artifacts.download.request"` | Yes      | Message discriminator                                                     |
| messageId | string                         | Yes      | Unique message ID                                                         |
| jobId     | string                         | Yes      | Job requesting the download (ownership-checked; run resolved server-side) |
| name      | string                         | Yes      | Artifact name to resolve within the run                                   |

### Orchestrator -> Agent

#### artifacts.upload.response

Return a pre-signed PUT (`granted`) or a refusal (`rejected`). All enforcement happens before minting, so a `granted` URL is safe to upload to.

A `rejected` carries either `reason` (an enforcement gate was hit) or `error` (the request could not be serviced at all — the name violates the artifact-name contract, artifact storage is not configured, the job's run could not be resolved, the job is not owned by this agent, or the grant failed internally), never both. Keeping the two apart is what stops a bad name or an orchestrator-side problem from reaching the workflow author as a storage-quota rejection. `error` is a safe fixed string, never raw exception text; an agent that predates the field falls back to a generic rejection message.

| Field      | Type                          | Required | Description                                                                                                                  |
| ---------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| type       | `"artifacts.upload.response"` | Yes      | Message discriminator                                                                                                        |
| requestId  | string                        | Yes      | Correlates to the original request                                                                                           |
| outcome    | enum                          | Yes      | One of: `granted`, `rejected`                                                                                                |
| uploadUrl  | string                        | No       | Pre-signed PUT URL (present only on `granted`)                                                                               |
| storageKey | string                        | No       | Final storage key the agent echoes back on complete (present only on `granted`)                                              |
| reason     | enum                          | No       | Enforcement refusal reason (present only on an enforcement `rejected`): `duplicate_name`, `size_cap`, `run_cap`, `org_quota` |
| error      | string                        | No       | Failure detail — invalid name or internal failure (present only on a `rejected` with no `reason`)                            |

#### artifacts.upload.complete.ack

Report the outcome of committing an `artifacts.upload.complete`. The commit is retried a few times before `failed` is reported, because it is idempotent and a momentary storage/database blip should not fail a run. An agent that sees the `artifactCompleteAck` capability on `register.ack` waits for this message and fails the workflow step on `failed` (or on a 25-second timeout, deliberately inside the step's own artifact-request timeout so the specific reason is what surfaces), so a commit that never landed surfaces as a failed step instead of a green run with a missing artifact. An orchestrator that does not advertise the capability sends nothing, and the agent then treats the complete message as fire-and-forget and does not wait.

Losing the connection while an ack is in flight does not fail the step. Because the commit is idempotent, the agent parks the in-flight complete instead of failing it, and re-sends it under a fresh `messageId` after the next `register.ack` — up to twice, and only while the reconnected orchestrator still advertises the capability. The correlation id is re-minted on every resend, so a late ack for the pre-disconnect send is ignored rather than answering for the new one. The original 25-second deadline is never restarted, so an orchestrator that never comes back still fails the step on the same schedule; when the resends run out, when the reconnected orchestrator no longer acks, or when the agent's token is rejected outright so no reconnect will be attempted, the step fails with an error saying the artifact may nevertheless have been committed.

A `failed` ack carries `reason`, a safe fixed string classifying the failure — artifact storage is not configured, the job's run could not be resolved, the job is not owned by this agent, the uploaded object was missing at commit time, the name violates the artifact-name contract, or the commit failed internally. As on the upload and download responses, `reason` is never raw exception text: the exception stays in the orchestrator's own logs, so a database endpoint or a storage key never reaches the workflow author.

| Field     | Type                              | Required | Description                                                  |
| --------- | --------------------------------- | -------- | ------------------------------------------------------------ |
| type      | `"artifacts.upload.complete.ack"` | Yes      | Message discriminator                                        |
| requestId | string                            | Yes      | Echoes the complete message's `messageId`                    |
| outcome   | enum                              | Yes      | One of: `committed`, `failed`                                |
| reason    | string                            | No       | Safe fixed failure classification (present only on `failed`) |

#### artifacts.download.response

Return a pre-signed GET plus size/sha256 for the named artifact, or `not_found` when the run never uploaded an artifact by that name.

`not_found` is also the outcome when the orchestrator could not perform the lookup at all — artifact storage is not configured, the job's run could not be resolved, the job is not owned by this agent, or the lookup failed internally. Those replies carry `error`, which is what separates "this artifact does not exist" from "this orchestrator could not look it up"; a genuine miss carries no `error`. As on the upload response, `error` is a safe fixed string, never raw exception text, and an agent that predates the field renders the plain not-found message.

| Field       | Type                            | Required | Description                                                                               |
| ----------- | ------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| type        | `"artifacts.download.response"` | Yes      | Message discriminator                                                                     |
| requestId   | string                          | Yes      | Correlates to the original request                                                        |
| outcome     | enum                            | Yes      | One of: `found`, `not_found`                                                              |
| downloadUrl | string                          | No       | Pre-signed GET URL (present only on `found`)                                              |
| sizeBytes   | number (int >= 0)               | No       | Artifact size in bytes (present only on `found`)                                          |
| sha256      | string                          | No       | SHA-256 (hex) of the tarball bytes for integrity verification (present only on `found`)   |
| error       | string                          | No       | Internal-failure detail (present only on a `not_found` caused by an orchestrator failure) |

## Fleet log collection messages

These messages support debug-bundle collection across a cluster: the orchestrator asks each agent for a log/diagnostic mini-bundle, and the agent streams the ZIP back in base64 frames (or reports an error).

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Orchestrator -> Agent

#### fleet.logs.request

Ask an agent for its log/diagnostic mini-bundle.

| Field          | Type                   | Required | Description                           |
| -------------- | ---------------------- | -------- | ------------------------------------- |
| type           | `"fleet.logs.request"` | Yes      | Message discriminator                 |
| requestId      | string                 | Yes      | UUID correlating the chunked response |
| logWindowHours | number                 | Yes      | Hours of log history to include       |
| maxBytes       | number                 | Yes      | Per-node cap on raw log bytes         |

### Agent -> Orchestrator

#### fleet.bundle.chunk

One base64 frame of an agent's mini-bundle ZIP.

| Field     | Type                   | Required | Description                           |
| --------- | ---------------------- | -------- | ------------------------------------- |
| type      | `"fleet.bundle.chunk"` | Yes      | Message discriminator                 |
| requestId | string                 | Yes      | Correlates to the originating request |
| seq       | number                 | Yes      | Zero-based frame sequence number      |
| isLast    | boolean                | Yes      | True on the final frame               |
| dataB64   | string                 | Yes      | Base64-encoded ZIP frame              |

#### fleet.bundle.error

Reported when an agent fails to build or stream its mini-bundle.

| Field     | Type                   | Required | Description                           |
| --------- | ---------------------- | -------- | ------------------------------------- |
| type      | `"fleet.bundle.error"` | Yes      | Message discriminator                 |
| requestId | string                 | Yes      | Correlates to the originating request |
| message   | string                 | Yes      | Failure description                   |

## Agent private API messages

These messages carry a generic request/response envelope over the existing agent connection. The orchestrator registers each callable method by name and required role; the agent names a method and passes its parameters, and the orchestrator replies with the method's result or an error. Adding a method is a server-side registration, not a new message type.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### agent.api.request

Calls a registered method on the orchestrator.

| Field     | Type                  | Required | Description                                             |
| --------- | --------------------- | -------- | ------------------------------------------------------- |
| type      | `"agent.api.request"` | Yes      | Message discriminator                                   |
| requestId | string                | Yes      | Correlates the response                                 |
| method    | string                | Yes      | Dot-namespaced method name (e.g. `infrastructure.list`) |
| params    | object                | No       | Method-specific parameters (default: empty object)      |

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentApiRequestSchema`

### Orchestrator -> Agent

#### agent.api.response

Result of one `agent.api.request`.

| Field     | Type                   | Required | Description                                       |
| --------- | ---------------------- | -------- | ------------------------------------------------- |
| type      | `"agent.api.response"` | Yes      | Message discriminator                             |
| requestId | string                 | Yes      | Correlates to the originating `agent.api.request` |
| result    | unknown                | No       | The method's return value (on success)            |
| error     | string                 | No       | Failure description (on failure)                  |

`error` carries the two deliberate rejections verbatim — the method is not registered, or the caller lacks the role the method requires — because both name only the caller's own request. Any other failure is a safe fixed string, never raw exception text.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts` -- `agentApiResponseSchema`

## Step approval messages

These messages carry the step-level approval round-trip. When a step declares `approval`, the agent blocks its step loop and sends a `step.approval-request`; the orchestrator creates a step-scoped held-run from the requirement and replies with `step.approval-resolved` once the hold is approved, rejected, or expired. The agent keeps heartbeats flowing during the wait so it is not reaped as stale.

> Authoritative source: `packages/engine/src/protocol/messages/orchestrator-agent.ts`

### Agent -> Orchestrator

#### step.approval-request

A step carrying `approval` is about to run and the agent is blocking until the orchestrator resolves the approval. For a `when: 'drift'` gate the request carries the computed drift `payload`.

| Field          | Type                         | Required | Description                                                                                                             |
| -------------- | ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| type           | `"step.approval-request"`    | Yes      | Message discriminator                                                                                                   |
| messageId      | string                       | Yes      | Unique message ID (correlated by the resolution's `requestId`)                                                          |
| runId          | string                       | Yes      | Execution run ID                                                                                                        |
| jobId          | string                       | Yes      | Job ID within the run                                                                                                   |
| stepIndex      | number                       | Yes      | Zero-based step index                                                                                                   |
| stepName       | string                       | Yes      | Human-readable step name                                                                                                |
| clauses        | ApproverClause[]             | Yes      | AND-list of approver clauses (empty = any approval-capable member)                                                      |
| reason         | string                       | Yes      | Human label for the gate (from the SDK `approval` reason)                                                               |
| timeoutSeconds | number                       | No       | Per-gate timeout override; absent falls back to the org-default expiry                                                  |
| payload        | `{ summaryMarkdown, drift }` | No       | Computed drift, present only for a `when: 'drift'` gate; persisted on the hold and rendered in the approval queue + CLI |

### Orchestrator -> Agent

#### step.approval-resolved

Resolution of a step-level approval hold. On `approved` the agent runs the step with its live workspace intact; on `rejected`/`expired` it fails the job with a clear reason.

| Field     | Type                       | Required | Description                                                     |
| --------- | -------------------------- | -------- | --------------------------------------------------------------- |
| type      | `"step.approval-resolved"` | Yes      | Message discriminator                                           |
| requestId | string                     | Yes      | Correlates to the originating `step.approval-request` messageId |
| runId     | string                     | Yes      | Execution run ID                                                |
| jobId     | string                     | Yes      | Job ID within the run                                           |
| stepIndex | number                     | Yes      | Zero-based step index                                           |
| outcome   | enum                       | Yes      | One of: `approved`, `rejected`, `expired`                       |
| reason    | string                     | No       | Optional human reason (e.g. the reject reason)                  |

On `rejected`, `reason` is either deliberate rejection wording — an invalid per-gate timeout, or the approver's own decline note — or a safe fixed string classifying an internal failure. It is never raw exception text.

## Execution status messages

These messages flow from the orchestrator upstream to KiCI for execution metadata tracking and real-time dashboard updates.

> Authoritative source: `packages/engine/src/protocol/messages/execution-status.ts`

### execution.status

Structured execution status update sent by the orchestrator when an execution run starts, completes, or changes status. The upstream tier stores this metadata for dashboard queries.

| Field                 | Type                 | Required | Description                                                                                                                                                                                            |
| --------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type                  | `"execution.status"` | Yes      | Message discriminator                                                                                                                                                                                  |
| messageId             | string               | Yes      | Unique message ID                                                                                                                                                                                      |
| runId                 | string               | Yes      | Execution run ID                                                                                                                                                                                       |
| workflowName          | string               | Yes      | Name of the workflow being executed                                                                                                                                                                    |
| status                | enum                 | Yes      | One of: `pending`, `running`, `success`, `failed`, `cancelled`, `cancelling`, `held`                                                                                                                   |
| routingKey            | string               | No       | Routing key of the run's own source, so each run is attributed to its real source when one connection serves multiple sources (absent → the upstream falls back to the connection's first routing key) |
| repoIdentifier        | string               | No       | Repository identifier (e.g., `owner/repo`)                                                                                                                                                             |
| repoProvider          | string               | No       | Run-level repo provider (origin host: `github` / `gitlab` / `bitbucket` / `local`); drives provider-aware repo links in the dashboard                                                                  |
| localWorkingTree      | boolean              | No       | True when the run executed a developer's uploaded local working tree (`kici run remote`)                                                                                                               |
| sha                   | string               | No       | Commit SHA                                                                                                                                                                                             |
| ref                   | string               | No       | Git branch or tag (e.g., `main`, `refs/tags/v1.0`)                                                                                                                                                     |
| triggerEvent          | string               | No       | Trigger event type (e.g., `push`, `pr:open`)                                                                                                                                                           |
| commitMessage         | string               | No       | First line of the commit message                                                                                                                                                                       |
| jobCount              | number               | No       | Total number of jobs in this execution                                                                                                                                                                 |
| startedAt             | number               | Yes      | Unix timestamp when execution started                                                                                                                                                                  |
| completedAt           | number               | No       | Unix timestamp when execution completed                                                                                                                                                                |
| durationMs            | number               | No       | Total execution duration in milliseconds                                                                                                                                                               |
| timestamp             | number               | Yes      | Unix timestamp (milliseconds)                                                                                                                                                                          |
| parentRunId           | string or null       | No       | Parent run ID for re-run lineage (null/undefined for originals)                                                                                                                                        |
| originalRunId         | string or null       | No       | Root ancestor run ID (always points to first run in chain)                                                                                                                                             |
| triggeredBy           | string or null       | No       | User identity that triggered this re-run (null for webhook)                                                                                                                                            |
| triggeredByAgentLabel | string or null       | No       | Agent provenance label when the run was triggered through an agent credential                                                                                                                          |
| triggerActorProvider  | string or null       | No       | Provider of the triggering actor captured from the provider event (the pusher / PR author), distinct from `triggeredBy`                                                                                |
| triggerActorUsername  | string or null       | No       | Provider login of the triggering actor                                                                                                                                                                 |
| triggerActorUserId    | string or null       | No       | Provider user ID of the triggering actor                                                                                                                                                               |
| failureReason         | string               | No       | Human-readable reason why the run failed (only present for failed runs)                                                                                                                                |
| logBytes              | number               | No       | Total raw log bytes accumulated across all jobs of this run; only set on terminal run states                                                                                                           |
| initFailure           | object               | No       | Structured init-failure signal (`scope`, `category`, `message`, optional `jobName`) set when the run never executed a single step; only present when status is `failed`                                |
| failureClass          | enum                 | No       | Why a terminal run failed: `never_started`, `timed_out`, `dead_orchestrator`, `step_failure`, `cancelled` (only present for failed/cancelled runs)                                                     |

> Authoritative source: `packages/engine/src/protocol/messages/execution-status.ts` -- `executionStatusSchema`

### step.status.forward

Per-step status forwarded from agent through the orchestrator upstream in real-time. Enables live step-by-step progress in the dashboard.

| Field           | Type                    | Required | Description                                                                                                       |
| --------------- | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| type            | `"step.status.forward"` | Yes      | Message discriminator                                                                                             |
| messageId       | string                  | Yes      | Unique message ID                                                                                                 |
| runId           | string                  | Yes      | Execution run ID                                                                                                  |
| jobId           | string                  | Yes      | Job ID within the run                                                                                             |
| jobName         | string                  | Yes      | Human-readable job name                                                                                           |
| stepIndex       | number                  | Yes      | Zero-based step index                                                                                             |
| stepName        | string                  | Yes      | Human-readable step name                                                                                          |
| state           | enum                    | Yes      | One of: `running`, `success`, `failed`, `skipped`, `pending`, `cancelled`                                         |
| timestamp       | number                  | Yes      | Unix timestamp (milliseconds)                                                                                     |
| data            | Record<string, unknown> | No       | Optional state-specific data                                                                                      |
| secretsAccessed | string[]                | No       | Secret key names accessed by this step. Forwarded from agent for dashboard display                                |
| concurrencyKind | enum                    | No       | Step concurrency role: `sequential`, `parallel-child`, `parallel-group`; absent means an ordinary sequential step |
| groupId         | string                  | No       | Parallel-group correlation ID shared by a group's children (e.g., `g0`)                                           |

> Authoritative source: `packages/engine/src/protocol/messages/execution-status.ts` -- `stepStatusForwardSchema`

### job.status.forward

Per-job status forwarded from orchestrator upstream in real-time. Enables live job-level progress in the dashboard.

| Field          | Type                    | Required | Description                                                                                                                                                       |
| -------------- | ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type           | `"job.status.forward"`  | Yes      | Message discriminator                                                                                                                                             |
| messageId      | string                  | Yes      | Unique message ID                                                                                                                                                 |
| runId          | string                  | Yes      | Execution run ID                                                                                                                                                  |
| jobId          | string                  | Yes      | Job ID within the run                                                                                                                                             |
| jobName        | string                  | Yes      | Human-readable job name                                                                                                                                           |
| status         | enum                    | Yes      | One of: `pending`, `queued`, `running`, `recovering`, `cancelling`, `success`, `failed`, `cancelled`, `skipped`, `timed_out_stale`, `drift_dropped`, `unroutable` |
| matrixValues   | Record<string, unknown> | No       | Matrix parameter values for this job instance                                                                                                                     |
| startedAt      | number                  | No       | Unix timestamp when job started                                                                                                                                   |
| completedAt    | number                  | No       | Unix timestamp when job completed                                                                                                                                 |
| durationMs     | number                  | No       | Job duration in milliseconds                                                                                                                                      |
| errorMessage   | string or null          | No       | Error message if job failed                                                                                                                                       |
| agentId        | string or null          | No       | Agent ID executing this job                                                                                                                                       |
| orchestratorId | string or null          | No       | Orchestrator ID that dispatched this job                                                                                                                          |
| runsOnLabels   | string[]                | No       | Labels used for agent routing                                                                                                                                     |
| contexts       | string[]                | No       | Ordered bound context names for this job (multi-context jobs)                                                                                                     |
| logBytes       | number                  | No       | Total raw log bytes accumulated across all steps of this job; only set on terminal job states                                                                     |
| timestamp      | number                  | Yes      | Unix timestamp (milliseconds)                                                                                                                                     |
| initFailure    | object                  | No       | Structured init-failure signal (`scope`, `category`, `message`, optional `jobName`) — set for synthetic rejected / init-failed jobs                               |

> Authoritative source: `packages/engine/src/protocol/messages/execution-status.ts` -- `jobStatusForwardSchema`

### state.replay

State replay sent on orchestrator reconnection. Contains a full snapshot of all active runs and their jobs so the upstream tier can reconstruct the current state without requiring the orchestrator to resend individual status messages.

| Field     | Type             | Required | Description                   |
| --------- | ---------------- | -------- | ----------------------------- |
| type      | `"state.replay"` | Yes      | Message discriminator         |
| messageId | string           | Yes      | Unique message ID             |
| runs      | RunSnapshot[]    | Yes      | Array of active run snapshots |
| timestamp | number           | Yes      | Unix timestamp (milliseconds) |

Each RunSnapshot:

| Field          | Type           | Required | Description                                                                  |
| -------------- | -------------- | -------- | ---------------------------------------------------------------------------- |
| runId          | string         | Yes      | Execution run ID                                                             |
| workflowName   | string         | Yes      | Workflow name                                                                |
| status         | enum           | Yes      | One of: `pending`, `running`, `success`, `failed`, `cancelled`, `cancelling` |
| routingKey     | string         | No       | Provider routing key                                                         |
| repoIdentifier | string         | No       | Repository identifier (e.g., `owner/repo`)                                   |
| sha            | string         | No       | Commit SHA                                                                   |
| ref            | string         | No       | Git branch or tag                                                            |
| triggerEvent   | string         | No       | Trigger event type                                                           |
| commitMessage  | string         | No       | First line of the commit message                                             |
| jobCount       | number         | Yes      | Total number of jobs in this run                                             |
| startedAt      | number         | Yes      | Unix timestamp when run started                                              |
| completedAt    | number         | No       | Unix timestamp when run completed                                            |
| durationMs     | number         | No       | Run duration in milliseconds                                                 |
| parentRunId    | string or null | No       | Parent run ID for re-run lineage                                             |
| originalRunId  | string or null | No       | Root ancestor run ID (first run in the chain)                                |
| triggeredBy    | string or null | No       | User identity that triggered this re-run                                     |
| failureReason  | string         | No       | Human-readable reason why the run failed (only present for failed runs)      |
| jobs           | JobSnapshot[]  | Yes      | Array of job snapshots within the run                                        |

Each JobSnapshot:

| Field        | Type           | Required | Description                   |
| ------------ | -------------- | -------- | ----------------------------- |
| jobId        | string         | Yes      | Job ID                        |
| jobName      | string         | Yes      | Human-readable job name       |
| status       | string         | Yes      | Job status                    |
| startedAt    | number         | No       | Unix timestamp job started    |
| completedAt  | number         | No       | Unix timestamp job ended      |
| durationMs   | number         | No       | Job duration (ms)             |
| errorMessage | string or null | No       | Error message if job failed   |
| agentId      | string or null | No       | Agent ID executing this job   |
| runsOnLabels | string[]       | No       | Labels used for agent routing |

> Authoritative source: `packages/engine/src/protocol/messages/execution-status.ts` -- `stateReplaySchema`

## See also

- [Dashboard, metrics & wire format](./dashboard.md) -- concurrency, agent metrics, agent authentication, agent private API, join, peer-to-peer, the test-relay control plane, and wire-format messages
- [Protocol overview](./overview.md) -- message flow diagram, common envelopes (`heartbeat`, `ack`, `nack`, `error`), and authentication messages
