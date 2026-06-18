---
title: Monitoring & tracing
description: Observability, distributed tracing, and Loki + Grafana log aggregation for KiCI
---







The Raft role badge on each orchestrator row is explained inline (hover the badge). Full design — election parameters, dormant single-orchestrator mode, state persistence — lives in [Multi-orchestrator architecture § Raft consensus](../../architecture/clustering/multi-orchestrator.md#raft-consensus).

KiCI provides distributed tracing across all three tiers (Platform, orchestrator, agent) using structured log fields. Every webhook event is assigned a unique trace ID at ingestion, which propagates through the entire pipeline and appears in all related log lines.

## Distributed tracing

### Trace fields

All KiCI services emit structured JSON logs. Grafana Alloy (running on every host that produces KiCI logs) parses each line and pushes it to Loki with low-cardinality labels (`env`, `host`, `service`, `instance`) plus per-line **structured metadata** carrying the trace fields below. Inside LogQL queries the fields are addressed via `| json | <field>="..."`.

| Loki field   | Raw JSON field | Generated at | Description                                                                                                         |
| ------------ | -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `requestId`  | `requestId`    | Platform     | UUID assigned when a webhook is received. Traces the event through all three tiers.                                 |
| `runId`      | `runId`        | Orchestrator | UUID assigned when a workflow run is dispatched. Groups all jobs in a single run.                                   |
| `routingKey` | `routingKey`   | Platform     | Webhook routing key (e.g., `github:42`). Present on webhook-related log lines.                                      |
| `jobId`      | `jobId`        | Orchestrator | Job identifier. Present during job execution on orchestrator and agent.                                             |
| `traceId`    | `traceId`      | Multiple     | OTel trace ID linking spans across tiers. Always present alongside `spanId`.                                        |
| `spanId`     | `spanId`       | Multiple     | OTel span ID for the current operation.                                                                             |
| `service`    | `service`      | Orchestrator | Originating service for forwarded logs (e.g., `agent`). Only present on logs forwarded through orchestrator stdout. |

These fields are in addition to the standard log fields: `level`, `message`, `error`, `stack`.

> **Tier identification:** The `service` Loki label is the canonical "which tier produced this line?" answer (`platform`, `orchestrator`, `agent`, `postgres-orch`, etc.). For forwarded agent logs that appear inside the orchestrator's stdout, the parsed JSON also carries an inner `service: 'agent'` field — query both with `{service="orchestrator"} | json | service="agent"` if you need to disambiguate.

### Trace lifecycle

1. **Webhook received (Platform):** A `requestId` UUID is generated and associated with all log lines for this webhook. The webhook response body includes `{ "requestId": "..." }` for client-side correlation.

2. **Webhook relayed (Platform -> Orchestrator):** The `requestId` is included in the `webhook.relay` WebSocket message. The orchestrator picks it up and continues the trace.

3. **Triggers matched (Orchestrator):** The orchestrator evaluates triggers against the lock file. All log lines during matching carry the `requestId`.

4. **Job dispatched (Orchestrator):** A `runId` UUID is generated for the workflow run. Both `requestId` and `runId` are included in the `job.dispatch` WebSocket message to agents.

5. **Job executed (Agent):** The agent prints a trace header once at job start: `Run: <runId> | Trace: <requestId>`. All subsequent log lines carry both IDs.

6. **Check run updated (Orchestrator):** GitHub Check Run summaries include both `Trace` and `Run` IDs, allowing operators to copy-paste into the **Logs trace** Grafana dashboard's `requestId` variable.

### Log levels

- **Info:** Milestone events -- webhook received, webhook relayed, triggers matched, job dispatched, job started, job completed
- **Debug:** Internal operations -- trigger matching details, lock file fetch, rule evaluation, matrix expansion, step start/end

## Querying your logs

KiCI services emit structured JSON logs to stdout. The trace fields in those
logs are your join keys for correlating a single webhook or run across the
orchestrator and agent — ship the logs to whatever store you already run
(Loki, Elasticsearch, CloudWatch, …) and query by these fields. The examples
below use LogQL; adapt the label selectors to your own log shipper.

### Tracing a webhook end-to-end

The webhook response includes the `requestId`. Query your log store for every
line carrying it across all tiers:

```logql
{job="kici"} | json | requestId="<requestId>"
```

Sorted ascending, this returns Platform → orchestrator → agent log lines for
the full lifecycle of a webhook event. (The `{job="kici"}` selector is
illustrative — the label set depends on how you ship logs.)

### Filtering by tier

Add the `service` label to scope to one tier:

```logql
{service="orchestrator"} | json | requestId="<requestId>"
```

Labels are filtered before the `| json` parser runs, so this is materially faster than parsing JSON for every line and then dropping the wrong tier.

### Tracing a workflow run

Use the parsed `runId` field to see all jobs in a single workflow run:

```logql
{service="orchestrator"} | json | runId="<runId>"
```

### Finding errors by tier

```logql
{service="agent"} |~ "\"level\":\"error\""
```

The regex match (`|~`) on the raw JSON line is the cheapest way to filter on `level`, because `level` is auto-promoted by Loki 3.x but the line filter runs against the index — no JSON parsing required. Add `| json` afterwards if you need to filter on additional structured-metadata fields.

### Agent log paths

Agent logs reach your log store through two paths:

- **Scaler-managed agents:** The orchestrator captures container stdout/stderr via the scaler's log capture, parses each line, and re-emits it to its own stdout. Your log shipper reads it as part of the orchestrator's journald / file stream and labels it `service=orchestrator`. The parsed JSON then carries an inner `service: 'agent'` field identifying the original source.
- **WS-based agents:** Stateful or external agents send `agent.log` messages over WebSocket. The orchestrator forwards these to stdout with `service: 'agent'` in the parsed JSON, following the same pattern. Native systemd agents (e.g., `kici-stateful-agent.service`) ship via journald directly with the `service=agent` label.

To find every forwarded agent log line regardless of which path it took:

```logql
{service="agent"} | json
```

### Finding jobs by routing key

```logql
{service="orchestrator"} | json | routingKey="github:<app-id>" | jobId!=""
```

The trailing `jobId!=""` filter keeps only the lines emitted during job execution (where the orchestrator and agent both populate `jobId`), dropping the upstream Platform webhook-receipt lines that share the routing key.

## Prometheus metrics

KiCI exposes Prometheus metrics from three services:

| Service      | Mode                                     | Endpoint                                         | Metric prefix |
| ------------ | ---------------------------------------- | ------------------------------------------------ | ------------- |
| Platform     | Scraped by Prometheus                    | `{base-path}/metrics` (port 10142)               | `kici_`       |
| Orchestrator | Scraped by Prometheus                    | `/metrics` (port 10143)                          | `kici_orch_`  |
| Agent        | Scraped directly or pushed via WebSocket | `/metrics` (port 8080) + orchestrator `/metrics` | `kici_agent_` |

### Agent metrics push

Agents expose a local `/metrics` endpoint (default port 8080) for direct Prometheus scraping. In addition, they push metrics every ~30 seconds via the `agent.metrics` WebSocket message to the orchestrator. The orchestrator's agent metrics aggregator collects these and exposes them on its own `/metrics` endpoint with an `agent_id` label distinguishing each agent's contributions.

Metrics are retained for one scrape interval after an agent disconnects, then cleaned up automatically.

### Common issues

| Problem                                            | Cause                                                                                      | Solution                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Prometheus can't reach orchestrator                | Container networking -- `localhost` inside the Prometheus container doesn't reach the host | Use `host.containers.internal:{port}` in your scrape target      |
| Agent metrics missing from orchestrator `/metrics` | Agent not connected or hasn't pushed yet                                                   | Wait ~30s for the next push interval; check WS connection status |
| Prometheus target shows "down"                     | Service not running or wrong port/path                                                     | Verify the scrape target matches the actual service port/path    |

## Health endpoints

All three tiers expose health endpoints for monitoring:

### Orchestrator

| Endpoint          | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `/health`         | Basic liveness check                                      |
| `/ready`          | Readiness check (database connected)                      |
| `/metrics`        | Prometheus metrics (prefix: `kici_orch_`)                 |
| `/cluster/health` | Cluster health: status, role, term, leader, peers, agents |
| `/cluster/peers`  | Per-peer details: instance ID, connection state, agents   |
| `/cluster/runs`   | Active execution runs with job routing summary            |

### Agent

| Endpoint   | Description                                 |
| ---------- | ------------------------------------------- |
| `/health`  | Basic liveness check                        |
| `/ready`   | Readiness check (connected to orchestrator) |
| `/metrics` | Prometheus metrics (prefix: `kici_agent_`)  |

### Platform

| Endpoint   | Description                          |
| ---------- | ------------------------------------ |
| `/health`  | Basic liveness check                 |
| `/ready`   | Readiness check (database connected) |
| `/metrics` | Prometheus metrics (prefix: `kici_`) |

## Event delivery DLQ runbook

The orchestrator's event router is at-least-once: events that fail to dispatch
are retried with exponential backoff (5 attempts by default, exponential with
full jitter, capped at 5 min). When all attempts are exhausted the event lands
in the **DLQ** — `kici_events.dlq_at IS NOT NULL` — and is surfaced via:

- **Prometheus:** `kici_orch_event_dlq_depth` (gauge), `kici_orch_event_dlq_total`
  (counter), `kici_orch_event_lease_expirations_total` (counter — node crash signal).
- **Logs:** `{service="orchestrator"} | json | message="Event moved to DLQ"`
  — every DLQ admission is logged with the event id, name, and last error.
- **CLI:** `kici-admin event-dlq list / count / retry / discard`.

### Triage steps

1. **Confirm the alert.** Check the `kici_orch_event_dlq_depth` gauge (e.g. on a
   Grafana dashboard if you've imported KiCI's, or via your own Prometheus). If
   the ingress rate is 0 and only depth > 0, the events are old — no urgent
   pager-class issue, but still triage them so the depth doesn't accumulate
   forever (DLQ rows are NOT cleaned up by TTL, by design).
2. **Inspect the events.** `kici-admin event-dlq list --limit 20` prints the
   recent DLQ rows with `eventName`, `dlqReason`, `attempts`, `lastError`, and
   the source routing key. The `lastError` is the truncated message from the
   final failing dispatch — usually enough to identify the offending workflow.
3. **Cross-check your logs.** For more context on an offending dispatch:
   `{service="orchestrator"} | json | eventId="<id>"` returns every
   line tagged with the event id, including the retry sequence and the original
   handler exception.
4. **Fix the root cause.** A single event in the DLQ usually means a workflow
   handler is consistently failing — not a transient backend blip (transients
   are absorbed by the retry budget). Find the workflow in the run list, fix
   the handler, redeploy.
5. **Decide retry vs discard.**
   - Retry once a fix is deployed: `kici-admin event-dlq retry <eventId>` —
     clears the DLQ flag, resets attempts, and re-publishes pg_notify so a
     healthy orchestrator picks it up immediately.
   - Discard if the event is no longer relevant (e.g. the workflow that should
     have processed it was deleted): `kici-admin event-dlq discard <eventId>`.
6. **Watch the depth recover.** The `kici_orch_event_dlq_depth` gauge should drop
   to 0 within a minute of the last retry. If new events keep landing in the DLQ
   after the fix, the fix is incomplete — go back to step 4.

### When `kici_orch_event_lease_expirations_total` is climbing

That counter increments every time an orchestrator's dispatch lease ages out
without the holder finalising it — the canonical signal that an orchestrator
process crashed mid-dispatch. Healthy clusters keep this counter flat.

- A small handful per day across a large fleet: probably a node restart for
  routine maintenance (rolling deploy, OOM killer). Note and move on.
- Steady non-zero rate: investigate the orchestrator instance whose
  `claimed_by` value appears in the expired-lease log lines — its process is
  dying or stuck. Check Loki for crash traces, OOM kills, or container restart
  events.

The leader-only retry scanner releases expired leases automatically; events
held by a crashed node are re-dispatched within `leaseDurationMs +
retryScanIntervalMs` (default 60 s + 10 s = 70 s worst case).

## See also

- [Architecture: data flows](../../architecture/data-flows.md) -- trace propagation across tiers
- [Agent configuration](../../architecture/configuration.md) -- agent deployment settings
- [Orchestrator configuration](../../architecture/configuration.md) -- orchestrator deployment settings
