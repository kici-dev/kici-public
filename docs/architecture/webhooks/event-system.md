---
title: Event system internals
---

The event system enables non-Git workflow triggers: custom events, system events, external webhooks, cron schedules, and lifecycle events. It consists of six components that work together to deliver events to matching workflows across an orchestrator cluster.

## Component architecture

```
                          +------------------+
                          |   Event Router   |
                          |  (fan-out core)  |
                          +--------+---------+
                                   |
              +--------------------+--------------------+
              |                    |                    |
     +--------v---------+  +------v-------+  +--------v---------+
     |   Event Store    |  | Circuit      |  |   Trust Store    |
     | (PostgreSQL      |  | Breaker      |  | (cross-repo      |
     |  persistence)    |  | (depth+rate) |  |  authorization)  |
     +------------------+  +--------------+  +------------------+

              +--------------------+--------------------+
              |                                         |
     +--------v---------+                     +--------v---------+
     | Registration     |                     | Registration     |
     | Store            |                     | Index            |
     | (DB CRUD +       |                     | (in-memory dual  |
     |  version bump)   |                     |  index + reload) |
     +------------------+                     +------------------+
```

- **Event router** -- Receives events and fans them out to matching workflows. Uses PG LISTEN/NOTIFY for cluster-wide delivery.
- **Event store** -- Persists events in PostgreSQL with TTL-based cleanup.
- **Circuit breaker** -- Checks chain depth and rate limits to prevent event loops.
- **Trust store** -- Validates cross-repo event delivery against explicit trust relationships.
- **Registration store** -- Manages workflow registrations in the database with atomic replace-all and version tracking.
- **Registration index** -- Fast in-memory lookup by trigger type and customer/repo, refreshed via version-based reload.

## Event router

The event router (`packages/orchestrator/src/events/event-router.ts`) is the central component that receives, persists, and delivers events.

### PG LISTEN/NOTIFY

All orchestrators in a cluster listen on the `kici_event_channel` PostgreSQL notification channel. When an event is emitted:

1. The event is persisted via the event store (INSERT into `kici_events`)
2. A `pg_notify('kici_event_channel', eventId)` is issued
3. All listening orchestrators receive the notification and process the event independently

This provides cluster-wide event delivery without additional infrastructure.

### Catch-up on startup

When the event router starts, it queries for unprocessed events via `getUnprocessedSince()`. This handles events that were emitted while this orchestrator was down. Each missed event is processed through the normal matching pipeline and marked as processed.

### Registration index matching

The event router matches events against persistent DB-backed registrations via the `RegistrationIndex`. On each event, the router looks up registrations by trigger type, builds a synthetic `LockFile` per registration, and runs `matchAllWorkflows()` against it. This approach is durable and cluster-aware — all orchestrator nodes share the same registration state via the database.

### System event mapping

System events use `__` prefixed names internally:

| Internal event name   | Mapped trigger type |
| --------------------- | ------------------- |
| `__workflow_complete` | `workflow_complete` |
| `__job_complete`      | `job_complete`      |
| `__schedule_fire`     | `schedule`          |

When building a `SimulatedEvent` for trigger matching, the `__` prefix is stripped to produce the trigger type. System event payloads are passed through directly to the matcher (which checks fields like `workflowName`, `status`, etc.).

### Custom event wrapping

Custom events (from `ctx.emit()`) use trigger type `kici_event`. The stored event's metadata is wrapped into the structure the trigger matcher expects:

```
SimulatedEvent {
  type: 'kici_event',
  payload: {
    eventName: <user-defined event name>,
    payload: <user-emitted data>,
    sourceRepo: <emitting repo>,
    sourceRoutingKey: <emitting routing key>
  }
}
```

## Event store

The event store (`packages/orchestrator/src/events/event-store.ts`) persists events in the `kici_events` PostgreSQL table.

### Operations

- **write()** -- INSERT a new event with computed `expires_at`
- **getById()** -- Read a single event by ID
- **getUnprocessedSince()** -- Query unprocessed events after a reference point (for catch-up)
- **markProcessed()** -- SET `processed = true` for delivery tracking
- **cleanup()** -- DELETE events where `expires_at < NOW()`

### TTL-based cleanup

A periodic cleanup timer runs every hour (configurable via `cleanupIntervalMs`, default: 3,600,000ms). It deletes events older than 7 days (configurable via `eventTtlSeconds`, default: 604,800 seconds). The timer uses `.unref()` so it does not prevent process exit.

## Circuit breaker

The circuit breaker (`packages/orchestrator/src/events/circuit-breaker.ts`) prevents event loops with two independent checks.

### Chain depth tracking

Events carry a `chainDepth` counter that is incremented on each re-emission. When a workflow triggered by an event emits another event, the new event's chain depth is the parent's depth + 1. If the depth reaches the configured maximum (default: 10), the circuit breaker rejects the event.

```
Workflow A emits event X (chainDepth: 0)
  -> Workflow B triggers, emits event Y (chainDepth: 1)
    -> Workflow C triggers, emits event Z (chainDepth: 2)
      -> ... up to maxChainDepth (10)
        -> Circuit breaker trips, event dropped
```

### Rate limiting

A sliding-window rate limiter tracks events per event name per minute. The window is 60 seconds. When the count for an event name exceeds the configured limit (default: 100/min), excess events are rejected with a `retryAfterMs` hint.

**Note:** Despite the config field being named `rateLimitPerWorkflowPerMinute`, the rate limiter is keyed by **event name**, not workflow name. This is a naming inconsistency in the config interface.

## Trust store

The trust store (`packages/orchestrator/src/events/trust-store.ts`) controls cross-repo event delivery.

### Same-routing-key bypass

Events where the source routing key matches the target routing key are always trusted without a database lookup. This is the common case for same-repo events.

### Cross-repo trust

Cross-repo events require an explicit enabled row in the `cross_repo_trust` table. The trust store queries for a matching row based on source repo, source routing key, target repo, and target routing key.

### Glob-based event filtering

The `allowed_events` column in the trust table supports glob patterns via the `picomatch` library. For example, `["deploy-*", "release-*"]` allows only events matching those patterns to cross the repo boundary. A `null` `allowed_events` value means all events are allowed.

## Registration model

The registration model enables the orchestrator to know about event-triggered workflows before events arrive. It consists of three components.

### Registration store

The registration store (`packages/orchestrator/src/registration/registration-store.ts`) manages workflow registrations in PostgreSQL.

**Atomic replace-all:** When a push to the default branch is processed, all registrations for that customer+repo are replaced atomically (DELETE + INSERT in a single transaction). This prevents race conditions on concurrent pushes.

**Registry version:** The `registry_versions` table tracks a monotonically increasing version number. Every registration change calls `bumpVersion()`, which increments the counter. Cluster peers detect version changes via heartbeat messages and reload their in-memory indexes.

### Registration index

The registration index (`packages/orchestrator/src/registration/registration-index.ts`) provides fast in-memory lookup with two indexes:

- **Primary index** -- Keyed by `{customerId}:{repoIdentifier}`, used for customer/repo-scoped queries
- **Secondary index** -- Keyed by trigger type (e.g., `kici_event`, `schedule`), used for event routing

**Version-based reload:** The `refreshIfNeeded(remoteVersion)` method compares the local version against the remote version reported in heartbeat messages. If the remote version is newer, the index reloads all registrations from the database and rebuilds both indexes atomically.

**Event type mapping:** The `getByEventType()` method maps event types to trigger types. For `workflow_complete` and `job_complete` events, it also includes workflows with `lifecycle` triggers (which listen for both event types).

### Extractor

The extractor (`packages/orchestrator/src/registration/extractor.ts`) identifies which workflows in a lock file have registerable triggers. It checks each workflow's triggers against the `RegisterableTriggerType` enum (defined in `packages/engine/src/registration/registerable-trigger-type.ts`), which covers two families:

- **Non-Git-provider triggers** -- `kici_event`, `workflow_complete`, `job_complete`, `generic_webhook`, `schedule`, `lifecycle`, `webhook`. These have no per-repo lock file pipeline to fall back to, so the registration index is the authoritative source for matching.
- **Git-provider triggers** -- `push`, `pr`, `tag`, `comment`, `review`, `review_comment`, `release`, `dispatch`, `create`, `delete`, `status`, `workflow_run`, `fork`, `star`, `watch`. These continue to be matched via the per-event lock file pipeline on the same-source path (e.g. a real GitHub push webhook). Registering them is additive — it enables cross-source dispatch from generic webhooks that target externally-hosted repos.

### Registration extraction flow

```
Git Push to Default Branch
==========================

GitHub Webhook -> Platform Relay -> Orchestrator Processor

  Processor (on default-branch push):
    |-- compileLockFile() or fetchLockFile()
    |-- extractRegisterableWorkflows(lockFile)
    |       |-- For each workflow entry in lock file:
    |       |     Check if any trigger type is in RegisterableTriggerType
    |       |     (non-Git: kici_event, workflow_complete, job_complete,
    |       |       generic_webhook, schedule, lifecycle, webhook;
    |       |      Git: push, pr, tag, comment, review, review_comment,
    |       |       release, dispatch, create, delete, status,
    |       |       workflow_run, fork, star, watch)
    |       |-- Return array of registerable workflows
    |
    |-- registrationStore.replaceAll(customerId, repo, workflows)
    |       |-- BEGIN TRANSACTION
    |       |-- DELETE FROM workflow_registrations WHERE customer_id AND repo
    |       |-- INSERT new registrations
    |       |-- COMMIT
    |
    |-- registrationStore.bumpVersion()
    |       |-- UPDATE registry_versions SET version = version + 1
    |
    |-- registrationIndex.refreshIfNeeded(newVersion)
            |-- If local version != remote version:
            |     Load all registrations from DB
            |     Rebuild primary index (by customer:repo)
            |     Rebuild secondary index (by trigger type)
            |     Update local version
```

## Event emitter

The event emitter (`packages/orchestrator/src/events/event-emitter.ts`) automatically generates system events when workflows and jobs complete.

### Automatic system events

The event emitter is wired into the `ExecutionTracker`'s `onWorkflowComplete` and `onJobComplete` callbacks. It emits:

- **`__workflow_complete`** -- Rich metadata: workflowName, runId, status, conclusion, duration, jobResults (array of `{ name, status }`)
- **`__job_complete`** -- Rich metadata: workflowName, jobName, runId, jobId, status, duration, stepResults (array of `{ name, status }`)

### Root-level events

All system events are emitted with `chainDepth: 0`. They originate from the orchestrator itself (not from an event chain), so they do not increment the chain depth counter. This means a workflow triggered by `workflow_complete` starts its own chain at depth 0.

## Cron scheduler

The cron scheduler (`packages/orchestrator/src/cron/cron-scheduler.ts`) evaluates cron-triggered workflows periodically.

### Raft-leader-only evaluation

Only the current Raft leader evaluates cron schedules. This prevents duplicate firings in multi-orchestrator clusters. When an orchestrator loses leadership, evaluation stops immediately.

### Evaluation cycle

Every 30 seconds (configurable via `evaluationIntervalMs`, default: 30,000ms), the leader:

1. Queries the registration index for workflows with `schedule` triggers via `getCronSchedules()`
2. For each schedule, parses the cron expression with `croner`
3. Computes the most recent past scheduled time via `cron.previousRuns(1)`
4. Compares against the last-fired cache (backed by `cron_last_fired` table)
5. If the schedule is due and has not been recently fired, emits a `__schedule_fire` event through the event router

### Recovery on leader election

When a new leader is elected:

1. The `cron_last_fired` table is loaded into memory as the last-fired cache
2. Each registered schedule is evaluated once for recovery
3. Missed schedules fire once (not once per missed interval) to avoid burst behavior
4. Normal periodic evaluation then starts

### Firing mechanism

Schedule firing emits a `__schedule_fire` internal event through the event router with metadata:

- `cronExpression` and `timezone` from the trigger definition
- `registrationId`, `workflowName`, `customerId`, `repoIdentifier` from the registration
- `scheduledAt` (ISO timestamp of the computed scheduled time)

After firing, the `cron_last_fired` table is updated via upsert (INSERT ON CONFLICT UPDATE).

## Run infrastructure events

Separate from the workflow event system above, KiCI tracks infrastructure-level events for each execution run. These events provide an observability timeline of the full run lifecycle, from webhook receipt through teardown.

### Storage

Infrastructure events are stored upstream so the dashboard can render the run timeline.

### Event types

The following event types are emitted during a run's lifecycle:

| Event type                        | Source       | Description                            |
| --------------------------------- | ------------ | -------------------------------------- |
| orchestrator.dispatch             | orchestrator | Run dispatched to agent(s)             |
| orchestrator.agent.assigned       | orchestrator | Agent assigned to a job                |
| orchestrator.job.started          | orchestrator | Job execution started                  |
| orchestrator.job.completed        | orchestrator | Job execution completed                |
| orchestrator.job.stale_detected   | orchestrator | Job marked stale by stale run detector |
| orchestrator.job.orphan_recovered | orchestrator | Orphaned job recovered by Raft leader  |
| orchestrator.run.orphan_finalized | orchestrator | Orphaned run finalized by Raft leader  |
| agent.clone.start                 | agent        | Repository clone started (build jobs)  |
| agent.clone.end                   | agent        | Repository clone completed             |
| agent.execution.start             | agent        | Workflow execution started             |
| agent.execution.end               | agent        | Workflow execution completed           |
| agent.teardown                    | agent        | Agent teardown/cleanup                 |

### Event flow

`run.event` messages originate at the agent or orchestrator and travel upstream so the dashboard can render the run timeline. `job.context` messages provide runtime execution context (env vars, sandbox info, runtime version) for the dashboard's Summary tab and are ephemeral. Orchestration logs (dispatch, agent setup, teardown) are stored as JSONL files in the orchestrator's log storage and surfaced via the dashboard.

## See also

- [Event System Concepts](../../user/events.md) -- event types, registration model, circuit breaker, emitting custom events
- [Operator: Event Routing](../../operator/event-routing.md) -- configuration, registration admin API, generic webhooks
- [Architecture: Data Flows](../data-flows.md#internal-event-routing-flow) -- event routing flow diagrams
- [Architecture: Protocol Messages](../protocol/orchestrator-agent.md#event-emit-messages) -- WS protocol schemas
