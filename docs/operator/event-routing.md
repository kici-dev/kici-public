---
title: Event routing & generic webhooks
description: Configure internal event routing, generic webhook sources, and cross-repo trust
---



KiCI supports two categories of non-GitHub event processing: **internal event routing** (workflow chaining via custom and system events) and **generic webhook ingestion** (accepting HTTP webhooks from external services). Both integrate into the standard trigger matching pipeline -- workflows declare triggers in TypeScript, and the orchestrator matches incoming events against lock file entries.

## Internal event routing

### How it works

Internal events flow through the orchestrator's event router:

1. **Emission** -- A running step calls `ctx.emit('event-name', payload)`, which sends an `event.emit` WS message to the orchestrator
2. **Persistence** -- The orchestrator stores the event in the `kici_events` PostgreSQL table and issues a `NOTIFY` on the `kici_event_channel` channel
3. **Fan-out** -- All orchestrators in the cluster `LISTEN` on `kici_event_channel` and evaluate the event against cached lock file triggers
4. **Dispatch** -- Matched workflows are dispatched to agents via the normal job queue

System events (`workflow_complete`, `job_complete`) are emitted automatically by the orchestrator when executions finish. No opt-in is required.

### Circuit breaker

The event router includes a circuit breaker to prevent event loops (e.g., Workflow A emits event X, Workflow B triggers on X and emits event Y, Workflow A triggers on Y):

- **Chain depth limit** -- Events carry a `chain_depth` counter incremented on each re-emission. Events exceeding the max depth (default: 10) are dropped.
- **Rate limiting** -- In-memory sliding window limits events per routing key per minute. Excess events are logged and dropped.
- **TTL cleanup** -- Events older than the configured TTL (default: 7 days) are periodically deleted.

### Configuration

Event routing defaults can be overridden via `KICI_`-prefixed environment variables, YAML config (`eventRouter:` section), or the shared DB config store. The 4-layer resolution chain applies: env var > YAML > DB > defaults.

| Setting                         | Env var                                                | YAML path                                   | Default   | Description                                                                                                            |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `maxChainDepth`                 | `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH`                    | `eventRouter.maxChainDepth`                 | `10`      | Maximum event chain depth before circuit breaker trips                                                                 |
| `rateLimitPerWorkflowPerMinute` | `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` | `eventRouter.rateLimitPerWorkflowPerMinute` | `100`     | Maximum events per event name per minute (note: keyed by event name, not workflow name, despite the config field name) |
| `eventTtlSeconds`               | `KICI_EVENT_ROUTER_EVENT_TTL_SECONDS`                  | `eventRouter.eventTtlSeconds`               | `604800`  | Event retention in seconds (7 days)                                                                                    |
| `cleanupIntervalMs`             | `KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS`                | `eventRouter.cleanupIntervalMs`             | `3600000` | Cleanup interval for expired events (1 hour)                                                                           |

## Workflow registration

Workflows with non-Git triggers (custom events, system events, cron schedules, generic webhooks, lifecycle hooks) must be **registered** in the orchestrator's database before events arrive. Unlike Git-based triggers (push, PR) where the orchestrator fetches the lock file per-event using repo/ref from the webhook, internal events carry no repo/ref information. The orchestrator needs to know which workflows to evaluate before the event arrives.

### Automatic registration flow

Registration happens automatically when code is pushed to the default branch:

1. A git push to the default branch arrives via webhook
2. The orchestrator processes the push and fetches (or compiles) the lock file
3. `extractRegisterableWorkflows()` identifies workflows with registerable trigger types
4. The registration store atomically replaces all registrations for that customer+repo (DELETE + INSERT in a single transaction)
5. The registry version is bumped, notifying cluster peers to reload their in-memory index
6. All orchestrators in the cluster refresh their registration index if the version is newer

### Registerable trigger types

The following trigger types cause a workflow to be registered:

| Trigger type        | Example                                        |
| ------------------- | ---------------------------------------------- |
| `kici_event`        | Custom events via `ctx.emit()`                 |
| `workflow_complete` | Triggered when another workflow finishes       |
| `job_complete`      | Triggered when a specific job finishes         |
| `generic_webhook`   | External HTTP webhooks (ArgoCD, Jenkins, etc.) |
| `schedule`          | Cron-based schedules                           |
| `lifecycle`         | Lifecycle events (startup, shutdown, etc.)     |

Workflows with only Git-provider triggers (push, PR, tag, etc.) are not registered -- they use the standard per-event lock file pipeline.

### Registration admin

`kici-admin registration` is the operator-facing way to inspect registrations; it wraps the orchestrator's `/api/v1/admin/registrations` admin endpoints, so the equivalent raw `curl` is shown after each CLI command for scripting against the API directly. All endpoints require Bearer token authentication with the appropriate permission.

**List registrations**

```bash
# List all registrations
kici-admin registration list

# Filter by customer, repo, or trigger type
kici-admin registration list --org my-org
kici-admin registration list --org my-org --repo org/my-repo
kici-admin registration list --trigger-type schedule
```

```bash
# List all registrations
curl https://<orchestrator>/api/v1/admin/registrations \
  -H "Authorization: Bearer <admin-token>"

# Filter by customer
curl https://<orchestrator>/api/v1/admin/registrations?customerId=my-org \
  -H "Authorization: Bearer <admin-token>"

# Filter by customer and repo
curl "https://<orchestrator>/api/v1/admin/registrations?customerId=my-org&repoIdentifier=org/my-repo" \
  -H "Authorization: Bearer <admin-token>"

# Filter by trigger type
curl https://<orchestrator>/api/v1/admin/registrations?triggerType=schedule \
  -H "Authorization: Bearer <admin-token>"
```

**Get single registration**

```bash
kici-admin registration show <id>
```

```bash
curl https://<orchestrator>/api/v1/admin/registrations/<id> \
  -H "Authorization: Bearer <admin-token>"
```

**Force registry refresh**

Bumps the registry version, triggering all cluster peers to reload registrations from the database. Useful after manual database changes or to force re-synchronization.

```bash
curl -X POST https://<orchestrator>/api/v1/admin/registrations/refresh \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "my-org",
    "repoIdentifier": "org/my-repo"
  }'
```

**Delete a registration**

Deletes a single registration and bumps the registry version to notify peers.

```bash
curl -X DELETE https://<orchestrator>/api/v1/admin/registrations/<id> \
  -H "Authorization: Bearer <admin-token>"
```

### Permissions

| Endpoint                                   | Required permission |
| ------------------------------------------ | ------------------- |
| `GET /api/v1/admin/registrations`          | `context.read`      |
| `GET /api/v1/admin/registrations/:id`      | `context.read`      |
| `POST /api/v1/admin/registrations/refresh` | `context.update`    |
| `DELETE /api/v1/admin/registrations/:id`   | `context.delete`    |

## Cron scheduler

Cron-triggered workflows are evaluated periodically by the orchestrator's cron scheduler. Only the **Raft leader** evaluates schedules to prevent duplicate firings in multi-orchestrator clusters.

### How it works

1. Every **30 seconds** (hardcoded), the leader queries the registration index for workflows with `schedule` triggers
2. For each schedule, the `croner` library parses the cron expression and computes the most recent past scheduled time
3. If that time is after the last-fired time (tracked in the `cron_last_fired` table), the schedule fires
4. Firing emits a `__schedule_fire` internal event through the event router, which matches against registered workflows

### Recovery after leader election

When a new orchestrator becomes the Raft leader:

1. The last-fired cache is loaded from the `cron_last_fired` database table
2. Each registered schedule is evaluated once for recovery
3. Missed schedules fire once (not once per missed interval)
4. Normal periodic evaluation then starts

### Configuration

The cron scheduler has no operator-configurable environment variables. All defaults are hardcoded:

| Setting             | Value      | Description                              |
| ------------------- | ---------- | ---------------------------------------- |
| Evaluation interval | 30 seconds | How often the leader checks schedules    |
| Recovery behavior   | Fire once  | One fire per missed schedule on recovery |
| Cron parser         | `croner`   | Library for cron expression parsing      |
| Last-fired tracking | PostgreSQL | `cron_last_fired` table                  |

## Generic webhook sources

Generic webhook sources allow the orchestrator to accept HTTP webhooks from non-GitHub services (ArgoCD, Jenkins, Grafana, Slack, or any HTTP-capable source).

### Webhook URL

External services send webhooks to:

- **Direct to orchestrator:** `POST https://<orchestrator>/webhook/<orgId>/generic/<sourceId>`
- **Via Platform relay:** `POST https://<platform>/webhook/<orgId>/generic/<sourceId>`

The `orgId` and `sourceId` are assigned when creating the source via the admin API.

### Creating a source

Create a generic webhook source via the CLI or admin API:

**CLI (recommended):**

```bash
kici-admin source add generic \
  --org my-org \
  --name argocd-prod \
  --verification hmac_sha256 \
  --secret @/path/to/webhook-secret.txt \
  --event-type-header X-ArgoCD-Event \
  --rate-limit 60 \
  --max-payload 1048576
```

**REST API:**

```bash
curl -X POST https://<orchestrator>/api/v1/admin/generic-sources \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "my-org",
    "name": "argocd-prod",
    "verificationMethod": "hmac_sha256",
    "verificationConfig": { "secret": "whsec_..." },
    "eventTypeHeader": "X-ArgoCD-Event",
    "rateLimitRpm": 60,
    "maxPayloadBytes": 1048576
  }'
```

### Configuration options

| Field                  | Type     | Required | Description                                                                |
| ---------------------- | -------- | -------- | -------------------------------------------------------------------------- |
| `customerId`           | string   | yes      | Customer or organization identifier                                        |
| `name`                 | string   | yes      | Human-readable source name (unique per customer)                           |
| `verificationMethod`   | enum     | no       | `hmac_sha256`, `bearer_token`, `ip_allowlist`, or `none` (default: `none`) |
| `verificationConfig`   | object   | no       | Method-specific config (see below)                                         |
| `eventTypeHeader`      | string   | no       | HTTP header for event type extraction (default: `X-Event-Type`)            |
| `eventTypePath`        | string   | no       | JSONPath in payload for event type extraction                              |
| `idempotencyKeyHeader` | string   | no       | HTTP header for idempotency key                                            |
| `idempotencyKeyPath`   | string   | no       | JSONPath in payload for idempotency key                                    |
| `dedupWindowSeconds`   | integer  | no       | Deduplication window in seconds                                            |
| `maxPayloadBytes`      | integer  | no       | Maximum payload size in bytes                                              |
| `allowedEvents`        | string[] | no       | Allowlist of accepted event types                                          |
| `stripHeaders`         | string[] | no       | Headers to strip before passing to workflows                               |
| `rateLimitRpm`         | integer  | no       | Rate limit: requests per minute                                            |

### Verification methods

**HMAC-SHA256** -- The source signs payloads with a shared secret. The orchestrator verifies the signature in the header configured via `verificationConfig.headerName` (default: `x-signature-256`). Both `sha256=` prefixed and raw hex formats are accepted.

```json
{
  "verificationMethod": "hmac_sha256",
  "verificationConfig": { "secret": "whsec_your_shared_secret" }
}
```

To accept signatures from providers that use a different header name (for example GitHub's `X-Hub-Signature-256`, Forgejo/Gitea's `X-Gitea-Signature`, or Gogs's `X-Gogs-Signature`), set `headerName` explicitly:

```json
{
  "verificationMethod": "hmac_sha256",
  "verificationConfig": {
    "secret": "whsec_your_shared_secret",
    "headerName": "x-hub-signature-256"
  }
}
```

The CLI (`kici-admin source add generic`) currently does not expose `--signature-header`; to customise the header name use the REST API form above (or `kici-admin source update --verification hmac_sha256 --config '{...}'` if you already created the source).

**Bearer token** -- The source sends a static token in the `Authorization: Bearer <token>` header. Verification uses constant-time comparison.

```json
{
  "verificationMethod": "bearer_token",
  "verificationConfig": { "token": "your_bearer_token" }
}
```

**IP allowlist** -- Only requests from listed IP addresses are accepted.

```json
{
  "verificationMethod": "ip_allowlist",
  "verificationConfig": { "allowedIps": ["10.0.0.1", "10.0.0.2"] }
}
```

**None** -- No verification. Use only for trusted internal networks.

### Managing sources

**CLI:**

```bash
# List sources (use --org to include generic sources)
kici-admin source list --org my-org

# Get details of a generic source
kici-admin source get <source-id>

# Update source config
kici-admin source update-generic <source-id> --rate-limit 120

# Disable source (stops accepting webhooks)
kici-admin source disable <source-id>

# Enable source
kici-admin source enable <source-id>

# Soft delete
kici-admin source remove <source-id> --generic --yes

# Hard delete (permanent)
kici-admin source remove <source-id> --generic --hard --yes
```

**REST API:**

```bash
# List sources for a customer
curl https://<orchestrator>/api/v1/admin/generic-sources?orgId=my-org \
  -H "Authorization: Bearer <token>"

# Get source details
curl https://<orchestrator>/api/v1/admin/generic-sources/<id> \
  -H "Authorization: Bearer <token>"

# Update source config
curl -X PATCH https://<orchestrator>/api/v1/admin/generic-sources/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "rateLimitRpm": 120 }'

# Disable source (stops accepting webhooks)
curl -X POST https://<orchestrator>/api/v1/admin/generic-sources/<id>/disable \
  -H "Authorization: Bearer <token>"

# Enable source
curl -X POST https://<orchestrator>/api/v1/admin/generic-sources/<id>/enable \
  -H "Authorization: Bearer <token>"

# Soft delete (can be restored)
curl -X DELETE https://<orchestrator>/api/v1/admin/generic-sources/<id> \
  -H "Authorization: Bearer <token>"

# Hard delete (permanent)
curl -X DELETE https://<orchestrator>/api/v1/admin/generic-sources/<id>?hard=true \
  -H "Authorization: Bearer <token>"
```

### Universal-git sources (Forgejo, Gitea, Gogs, GitLab, plain GitHub)

A generic source can be promoted to a **universal-git source** by passing `--preset`, `--git-url-template`, and credential flags to `source add generic`. This unlocks the full trigger pipeline for non-GitHub-App forges — push / pull_request matching, lock-file shallow-clone via PAT or SSH, and participation in the two-axis global-workflow policy. See the [user guide](../user/providers/universal-git.md) for the full setup recipe.

Key differences from a plain generic source:

- **Webhook event header defaults from the preset.** `--preset forgejo` auto-sets `event_type_header = X-Gitea-Event`, same for gitea / gogs / gitlab-repo / github-repo. Only `--preset custom` requires explicit `--event-type-header`.
- **Routing key stays `generic:<orgId>:<sourceId>`.** Global workflow policy (`kici-admin org-settings global-workflows ...`) keys off this routing key exactly like any other source.
- **Cross-provider dispatch works out of the box.** A global workflow authored in one universal-git source can fan out against pushes from a different source in the same org (including from a GitHub App source). The agent receives split `sourceAuth` + `workflowAuth`, each minted from the respective bundle.

### Platform relay for generic webhooks

When using the Platform relay, generic webhooks follow the same path as GitHub webhooks:

1. External service POSTs to `https://<platform>/webhook/<orgId>/generic/<sourceId>`
2. Platform verifies the signature (for HMAC sources) or passes through (for `skip_verification` sources)
3. Platform relays via WebSocket to the orchestrator using routing key `generic:<orgId>:<sourceId>`
4. Orchestrator processes the webhook through the normal pipeline

Sources using bearer token, IP allowlist, or no verification are automatically flagged as `skip_verification` in the Platform -- the orchestrator handles verification instead.

## Cross-repo trust

By default, events emitted from one repository can only trigger workflows in the same repository. Cross-repo event delivery requires explicit trust relationships.

### Creating trust relationships

Trust relationships are always bidirectional -- both repos must trust each other. Create a trust entry via the admin API:

```bash
curl -X POST https://<orchestrator>/api/v1/admin/trust \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceRepo": "org/infra-repo",
    "sourceRoutingKey": "github:42",
    "targetRepo": "org/app-repo",
    "targetRoutingKey": "github:42",
    "allowedEvents": ["deploy-*", "release-*"]
  }'
```

### Trust configuration

| Field              | Type     | Required | Description                                          |
| ------------------ | -------- | -------- | ---------------------------------------------------- |
| `sourceRepo`       | string   | yes      | Repository emitting events (e.g., `org/infra-repo`)  |
| `sourceRoutingKey` | string   | yes      | Routing key of the source repo                       |
| `targetRepo`       | string   | yes      | Repository receiving events (e.g., `org/app-repo`)   |
| `targetRoutingKey` | string   | yes      | Routing key of the target repo                       |
| `allowedEvents`    | string[] | no       | Glob patterns for allowed event names (default: all) |

The `allowedEvents` field supports glob patterns (via picomatch) to restrict which events can cross repo boundaries. For example, `["deploy-*"]` allows only events matching the `deploy-*` pattern.

### Managing trust

```bash
# List trust entries for a routing key
curl https://<orchestrator>/api/v1/admin/trust?routingKey=github:42 \
  -H "Authorization: Bearer <token>"

# Remove a trust relationship
curl -X DELETE https://<orchestrator>/api/v1/admin/trust/<id> \
  -H "Authorization: Bearer <token>"
```

## See also

- [Event system concepts](../user/events.md) -- event types, registration model, circuit breaker, emitting custom events
- [SDK reference: event triggers](../user/sdk/triggers.md#event-triggers) -- trigger factories and configuration
- [SDK reference: emitting events](../user/sdk/validation-events.md#emitting-events) -- `ctx.emit()` API
- [Workflow patterns: workflow chaining](../user/patterns/integrations.md#workflow-chaining) -- usage examples
- [Architecture: event system internals](../architecture/webhooks/event-system.md) -- component architecture, registration model, cron scheduler internals
- [Architecture: data flows](../architecture/data-flows.md#internal-event-routing-flow) -- event routing internals
- [Architecture: protocol messages](../architecture/protocol/orchestrator-agent.md#event-emit-messages) -- WS protocol schemas
