---
title: Observability
description: Monitoring, logging, and diagnostic tooling for a self-hosted KiCI deployment
---

This guide covers monitoring, logging, and diagnostic tooling for self-hosted KiCI deployments.

## OpenTelemetry setup

KiCI uses OpenTelemetry (OTel) for metrics and traces across all tiers you operate (orchestrator and agent), plus the upstream tier the customer-facing dashboard runs on.

### Metrics (Prometheus)

All services expose a Prometheus-compatible `/metrics` endpoint by default. No additional configuration is needed for basic metrics collection.

**Scrape configuration example (prometheus.yml):**

```yaml
scrape_configs:
  - job_name: kici-orchestrator
    static_configs:
      - targets: ['orchestrator-host:4000']
    metrics_path: /metrics
    scrape_interval: 15s

  - job_name: kici-agent
    static_configs:
      - targets: ['agent-host:8080']
    metrics_path: /metrics
    scrape_interval: 15s
```

### Trace export (OTLP)

To export traces to a backend (Jaeger, Grafana Tempo, Datadog, etc.), set the OTLP endpoint:

```bash
# Export traces via OTLP HTTP
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

When no OTLP endpoint is configured, traces are not exported (metrics still available via `/metrics`).

### Structured logging

All services emit structured JSON to stdout by default when not attached to a TTY. Each log line includes:

- `service` -- service name (platform, orchestrator, agent)
- `requestId` -- per-request correlation ID
- `runId` -- execution run ID (when in run context)
- `jobId` -- job ID (when in job context)
- `routingKey` -- webhook routing key
- `traceId` / `spanId` -- OTel trace context (when tracing is enabled)

**Example log line:**

```json
{
  "level": "info",
  "message": "Job dispatched",
  "service": "orchestrator",
  "runId": "run-abc123",
  "jobId": "job-def456",
  "routingKey": "github:12345",
  "timestamp": "2026-03-12T10:30:00.000Z"
}
```

## Log rotation

For bare-metal deployments, KiCI supports file-based log rotation via environment variables.

### Configuration

| Environment variable      | Default               | Description                                                             |
| ------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `KICI_LOG_DIR`            | (none -- stdout only) | Directory for log files. When set, enables file logging.                |
| `KICI_LOG_RETENTION_DAYS` | `7`                   | Number of days to retain log files before deletion.                     |
| `KICI_LOG_MAX_SIZE`       | `500m`                | Maximum size of a single log file before rotation (e.g., `500m`, `1g`). |

### Example

```bash
# Enable file-based logging with 14-day retention
KICI_LOG_DIR=/var/log/kici
KICI_LOG_RETENTION_DAYS=14
KICI_LOG_MAX_SIZE=1g
```

Log files are rotated daily. The base pattern is `{service}-YYYY-MM-DD.log` (e.g., `orchestrator-2026-03-28.log`). When a stable instance ID is available via env, it is appended so multiple processes can safely share one `KICI_LOG_DIR` without racing on the same file:

```
{service}-{instanceId}-YYYY-MM-DD.log
```

Instance IDs are resolved in this order (first match wins):

| Env var                     | Tier         | Set by                                                                |
| --------------------------- | ------------ | --------------------------------------------------------------------- |
| `KICI_CLUSTER_INSTANCE_ID`  | orchestrator | cluster config (already used for coordinator / worker identification) |
| `KICI_AGENT_ID`             | agent        | agent config (already used in agent registration)                     |
| `KICI_PLATFORM_INSTANCE_ID` | platform     | env var; falls back to `hostname-<uuid>` if unset                     |

Values are sanitized to filesystem-safe characters. If none of these env vars is set, filenames fall back to the unsuffixed pattern.

Rotated files are compressed (gzip). Old files are automatically deleted when they exceed the retention period.

**Example — a typical staging stack:** every process writes to `${KICI_LOG_DIR}/` with a per-instance filename, e.g. `orchestrator-<host>-stg-YYYY-MM-DD.log`, `orchestrator-worker-orch-stg-YYYY-MM-DD.log`, `agent-stg-stateful-agent-YYYY-MM-DD.log`. The reference dogfooding setup wires these env vars in two places: the native orchestrator's own service environment, and the Platform's compose environment.

## Diagnostic tools

### `kici-admin diagnose`

Runs health checks against all components and reports pass/warn/fail status.

```bash
kici-admin diagnose
```

**Checks performed:**

| Check        | Description                                       |
| ------------ | ------------------------------------------------- |
| Database     | Connectivity and basic query execution            |
| WebSocket    | Connection to Platform relay endpoint             |
| Agents       | Active agent count (warns if zero)                |
| Disk         | Available disk space (warns < 1GB, fails < 100MB) |
| Config       | Required configuration fields present             |
| Certificates | TLS certificate validity and expiration           |

**Example output:**

```
Orchestrator diagnostics
========================
  [PASS] Database connectivity          1ms
  [PASS] WebSocket to Platform            12ms
  [WARN] Agent connectivity            0 agents connected
  [PASS] Disk space                   45.2 GB available
  [PASS] Configuration valid
  [PASS] TLS certificates             expires in 89 days

Result: 5 passed, 1 warning, 0 failed
```

**HTTP endpoint:** The same checks are available via `GET /admin/diagnose` for monitoring system integration.

### `kici-admin debug-bundle`

Generates a sanitized diagnostic ZIP file for sharing with support.

```bash
kici-admin debug-bundle [--output /path/to/bundle.zip] [--log-dir /var/log/kici] [--log-window 4]
```

`--log-dir` defaults to `$KICI_LOG_DIR`, so running the command from the same environment as the orchestrator picks up the right directory automatically. `--log-window` controls how many hours of rotated files to include (default 4).

**Bundle contents:**

- `manifest.json` -- bundle version, timestamp, orchestrator ID
- `config.json` -- configuration with secrets redacted
- `system-info.json` -- OS, Node.js version, memory, CPU
- `metrics.txt` -- current Prometheus metrics snapshot
- `logs/` -- recent log files (up to 50MB)
- `cluster-state.json` -- cluster membership and peer status
- `execution-state.json` -- recent run and job statuses

**Security:** All secrets, tokens, and credentials are automatically redacted using an allowlist approach. Only known-safe configuration fields are included.

**Fleet-wide collection:** Add `--fleet` to collect from every node in the cluster at once — the orchestrator, its coordinator-mesh peers, every worker, and every connected agent — over the existing authenticated WebSocket channels. The result is one nested ZIP (`local/`, `agents/<id>.zip`, `workers/<id>.zip`, `peers/<id>.zip`) plus a `fleet-manifest.json` recording each node's status, with each node redacting its own config at source. Use `--list` to enumerate the fleet and `--pick` to collect a subset. See the [debug-bundle reference](../orchestrator/kici-admin/inspection-recovery.md#fleet-wide-collection) for the full flag set.

### `kici-admin inspect-bundle`

Parses and displays a structured summary of a debug bundle.

```bash
kici-admin inspect-bundle /path/to/bundle.zip
```

**Example output:**

```
Debug bundle: kici-debug-2026-03-12T10-30-00.zip
================================================
  Generated:       2026-03-12T10:30:00Z
  Orchestrator:    orch-abc123
  Node.js:         v24.0.0
  OS:              Linux 6.12.63
  Uptime:          3d 14h 22m

  Recent runs:     42 (last 24h)
  Failed runs:     2
  Active agents:   3
  Cluster peers:   1

  Log size:        12.4 MB (last 7 days)
```

## Grafana dashboards

KiCI ships five Grafana dashboard templates that operators can import into their own Grafana instance.

### Available dashboards

| Dashboard          | Description                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| System overview    | WS connections, webhook throughput, relay latency, error rates, stale detection                                                   |
| Execution pipeline | Job dispatch rates, build vs execution split, cache hit/miss ratios, dispatch queue depth overall + per label                     |
| Org / tenant view  | Per-org connection counts, execution totals, plan distribution, registrations (24h count + hourly signup rate)                    |
| Scheduled jobs     | Per-job last success age, run rate, duration histograms, consecutive failures, orphan sweep count                                 |
| Orchestrator fleet | Orchestrator agents, trigger latency, build duration, dedup, stale runs, execution events, log volume, log-streaming backpressure |

### Queue depth and backpressure

When the execution pipeline feels slow but the orchestrator isn't reporting
errors, check the "Execution pipeline" dashboard panels for
`kici_orch_dispatch_queue_depth`. A rising or sustained pending depth means
one of:

- **Agents are starved** — no agent with matching labels is available for the
  queued jobs. Inspect the "Dispatch queue depth by label" panel to see which
  label pool is blocked, then scale the matching scaler pool (container,
  bare-metal, or Firecracker).
- **`runs_on` labels are mismatched** — the workflow requests labels that
  don't match any registered agent. Use `kici-admin agent list` to see
  advertised labels, compare against the workflow's `runs_on`, and either fix
  the workflow or register an agent with the missing labels.
- **All agents are busy** — queue depth and agent-active counts are both
  high; add capacity via the scaler or reduce the workflow fan-out.

The orchestrator also emits a `queue.backpressure.sustained` structured warn
log (via the `queueBackpressureThreshold` config, default 100, env
`KICI_QUEUE_BACKPRESSURE_THRESHOLD`) when the pending depth stays at or above
the threshold for two consecutive refresher ticks (~10s). Set to `0` to
silence the warn log while keeping the Prometheus gauge and the Grafana
panel alert active.

For agent log-streaming pressure, the "Orchestrator fleet" dashboard's
**Log-streaming backpressure** row exposes `kici_agent_log_backpressure_events_total`
(rising-edge pause/drop events) and `kici_agent_log_lines_dropped_total` (lines
lost under drop mode). A non-zero rate of the latter means operators are
losing real log content — increase the streamer's buffer (raise
`BACKPRESSURE_THRESHOLD`) or reduce the producer's output rate.

### Import instructions

1. Download the dashboard JSON files from `infra/terraform/modules/grafana/dashboards/`
2. In Grafana, go to **Dashboards > New > Import**
3. Upload or paste the JSON file
4. Select your Prometheus datasource when prompted
5. Click **Import**

The dashboards use the standard `${DS_PROMETHEUS}` template variable, so they work with any Prometheus-compatible datasource.

### Required Prometheus configuration

The dashboards expect metrics from both the Platform relay and orchestrator services. Ensure your Prometheus instance scrapes both `/metrics` endpoints (see the scrape configuration above).

Key metric prefixes:

- `kici_` -- Platform relay metrics (webhooks, connections, relay)
- `kici_orch_` -- Orchestrator metrics (dispatch, execution, agents)
- `kici_agent_` -- Agent metrics (jobs, steps, clone duration)

## In-app diagnostics

The KiCI dashboard includes a built-in infrastructure page at `/orgs/:orgId/infrastructure`.

### Features

- **Execution metrics** -- 24-hour summary including total runs, success rate, average duration, and active job counts (queued and running)
- **Infrastructure tree** -- hierarchical view of orchestrators, scaler pools, and connected agents with OS metadata, connection status, and scaler configuration details
- **Per-orchestrator command helper** -- a command-line icon next to each orchestrator opens a popover showing the correct, copy-ready `kici-admin` invocation for that orchestrator's deployment shape: `<runtime> exec <container> kici-admin …` for a container (compose) deployment, a `<node> <kici-admin> …` pair pinned to the unit's own runtime for a systemd / launchd install, with either half shell-quoted when its path contains whitespace (falling back to a bare `kici-admin …` whenever no pinned command is reported — the orchestrator is offline, or it could not locate its own `kici-admin` on disk), `kici-admin.cmd …` for a Windows service (npm installs the launcher as a `.cmd` shim), and a `kici-admin …` plus `KICI_ADMIN_URL` note for a hand-run orchestrator. The snippet never embeds a token — it reminds you to set `KICI_ADMIN_TOKEN` (create one with `kici-admin token create <label> --role owner`).
- **Secret backends** -- health status of registered secret backends (PostgreSQL and Vault) with sync and connectivity controls
- **Running user** -- OS user identity of the orchestrator process, with color-coded warnings for root with bare-metal scalers

The infrastructure section auto-refreshes every 10 seconds; execution metrics refresh every 30 seconds. All data is scoped to the current organization (multi-tenant isolation).

## Inbound webhook delivery visibility

The primary surface for inbound webhook delivery visibility is the dashboard **Settings → Event log** tab. It joins the Platform-side `event_log` (event metadata + SHA-256 hash, no body — trust boundary) with the orchestrator-side `event_log` (event metadata + payload + processing outcome) on `(org_id, delivery_id)` and renders one row per delivery with click-to-open detail panels showing both tiers' projections plus the payload viewer.

### Dashboard UI

- **Settings → Event log tab** (`/orgs/:customerId/settings/event-log`) — primary surface. Filter by routing key, event, status, time range, free-text delivery ID. Click a row for the merged detail panel with both Platform + orchestrator records, run links, and the payload (when your role grants `event_log:read_payload`). See [the dashboard docs](../../user/dashboard/settings.md#event-log).
- **Run detail → Payload tab** (`/orgs/:customerId/runs/:runId`) — per-run payload that triggered that specific run. Useful when you start from a known run and want to see what woke it up.
- **Run detail → Timeline / Summary panels** — routing key, trigger event, and decision trace for the run.
- **Settings → Sources tab** (`/orgs/:customerId/settings/sources`) — read-only list of routing keys registered by connected orchestrators, with the webhook URL to configure in the provider UI. Does not include delivery history.
- **Settings → Webhooks tab** (`/orgs/:customerId/settings/webhooks`) — **outbound** delivery log (KiCI → your endpoints). Not the same thing as inbound GitHub webhooks; the delivery log here is for webhook endpoints you configured to receive KiCI event notifications.

The structured-log debugging path described below remains a useful escape hatch for forensic investigation — the dashboard surfaces the rich common case, the logs let you reconstruct history when the orchestrator was offline or the row was already cleaned up.

### Orchestrator `event_log` table

Schema (orchestrator DB, populated by every inbound webhook): `org_id`, `delivery_id`, `routing_key`, `event`, `action`, `source` (`relay` / `direct`), `provider`, `repo_identifier`, `ref`, `payload_key` (object-storage path), `payload_omitted` + `payload_omitted_reason`, `payload_size_bytes`, `payload_hash`, `matched_count`, `status` (`received` / `processed` / `duplicate` / `lockfile_missing` / `failed`), `run_id`, `error_message`, `received_at`, `expires_at`. Unique index on `(org_id, delivery_id)`; per-org received-time index for the list view; expires-at index for the cleanup job.

Retention: 30-day warm window, matched to the Platform `event_log`. Rows past 30 days are archived to S3 by the cold-store adapter at `packages/orchestrator/src/cold-store/tables/event-log.ts` (default `warmTtlDays: 30`) instead of being hard-deleted. The orchestrator-side cold-store packages each row's metadata — including `payload_key` — but does NOT touch the gzipped body that key points to: webhook-body blobs in object storage are retained indefinitely so the dashboard delivery-detail page resolves payload reads identically for hot and cold rows.

Soft cap: payloads larger than `eventLog.maxPayloadBytes` (default 5 MB) are NOT 413'd — the row is recorded with `payload_omitted=true`, reason `'size_exceeded'`, and the actual size + hash. Operators see the delivery in the dashboard; if they need the body they can look it up via `KICI_WEBHOOK_PAYLOAD_DIR` (the opt-in disk archive described below) or raw logs by hash.

### Orchestrator side

The orchestrator is the richest source of per-delivery data.

**Structured JSON logs** — one file per service instance under `KICI_LOG_DIR` (see [Log rotation](#log-rotation)). Grep these:

```bash
grep -E '"Org-scoped webhook received"|"Webhook relay received"|"Generic webhook accepted"|"Webhook accepted"|"Webhook processed"|"Duplicate webhook"' \
  $KICI_LOG_DIR/orchestrator-*.log
```

Key log markers and what they mean:

| Message                                                         | Where emitted                                  | When                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Webhook relay received`                                        | `ws/platform-client.ts`                        | Platform forwarded a webhook via WS (platform/hybrid modes)                                                                |
| `Generic webhook accepted`                                      | `routes/webhooks.ts` (generic handler)         | Provider posted to `POST /webhook/:orgId/generic/:sourceId`                                                                |
| `Webhook accepted`                                              | `routes/webhooks.ts` (after signature check)   | Signature + dedup passed, handed to the pipeline                                                                           |
| `Duplicate webhook`                                             | `routes/webhooks.ts` / `pipeline/processor.ts` | Delivery ID already in `dedup_cache` (in-memory fast path or DB)                                                           |
| `Webhook processed`                                             | `pipeline/processor.ts`                        | Final line: includes `deliveryId`, `event`, `matchedWorkflows`                                                             |
| `Cross-source webhook processed`                                | `pipeline/processor.ts`                        | Generic webhook fanned out to same-org webhook-trigger registrations                                                       |
| `webhook pipeline failed after the delivery was acknowledged`   | `webhook/ingest-accept.ts`                     | The pipeline threw for a delivery already answered `202`. Carries the error and a remedy; the delivery is queued for retry |
| `reclaimed a stale ingest-queue claim`                          | `webhook/ingest-overflow-replayer.ts`          | A worker died mid-pipeline and the drain pass freed its delivery for retry                                                 |
| `ingest-queue delivery abandoned past max attempts`             | `webhook/ingest-overflow-replayer.ts`          | A delivery exhausted its retries. It was already acknowledged, so this is the only place the abandonment is announced      |
| `ingest queue at capacity — shedding rather than acknowledging` | `webhook/ingest-accept.ts`                     | The queue hit its row cap; the delivery was refused with `429` rather than acknowledged unstored                           |

Each line includes `deliveryId`, `routingKey`, and usually `event` — correlate by `deliveryId` to reconstruct the full pipeline for a given webhook.

A direct-ingress `202` means the delivery is durably queued, not that its pipeline finished — so `Webhook processed` (or one of the failure lines above) is what tells you the pipeline actually ran. See `docs/operator/orchestrator/configuration.md` → "Webhook ingest acknowledgement".

**On-disk payload archive (opt-in)** — set `KICI_WEBHOOK_PAYLOAD_DIR` to have the orchestrator fire-and-forget every processed payload to `<dir>/<repoIdentifier>/<deliveryId>/payload.json`. Nothing reads this directory automatically; it's for offline inspection (`find $KICI_WEBHOOK_PAYLOAD_DIR -name payload.json -newer ...`). Leave unset to skip the write.

**Per-run payload in log storage** — for every webhook that produced a run, the orchestrator writes `executions/<runId>/webhook-payload.json` to its configured `logStorage` (S3/MinIO). This is what the dashboard Payload tab reads via `dashboard.payload` WS request. It's also what `rerun` uses to replay a run.

**Database tables on the orchestrator:**

- `dedup_cache` — `delivery_id` + `expires_at` only, no payload. Useful to confirm "did this delivery arrive at least once in the last 24h".
- `execution_runs.webhook_delivery_id` / `routing_key` — every run carries the delivery that spawned it.

**Prometheus metrics** (scrape `http://orchestrator:4000/metrics`):

- `kici_orch_webhooks_received_total{source="direct"|"relay", event}` — count of deliveries entering the orchestrator
- `kici_orch_webhooks_processed_total{result="matched"|"skipped"|"error"}` — pipeline outcome
- `kici_orch_dedup_hits_total` — suppressed duplicates
- `kici_orch_trigger_match_duration_seconds` — matcher latency

**Debug bundle** — `kici-admin debug-bundle --log-window 4` packages the above logs, metrics snapshot, and redacted config for offline analysis or support. See [Debug bundles](#debug-bundles) above.

### Upstream side

KiCI exposes its own delivery log to the dashboard's **Settings → Event log** tab via a merge endpoint that joins the upstream side with the orchestrator's `event_log`.

## Organization-workflow evaluation visibility

An organization-wide workflow that declares a `filter` predicate or generates
its jobs at runtime is decided by a pre-run evaluation job on an agent, before
any run exists. When that evaluation excludes a workflow, nothing is created —
no run, no check, no logs from the workflow itself — so these signals are the
only account of what happened.

**Decision trace.** An organization workflow the orchestrator declines to run
because of its `requires` content filter or its `filter` predicate logs a
`Global workflow decision trace` line carrying the workflow name, the verdict,
and every check that was evaluated — including the trigger checks that passed.
Search your log backend for that message with the workflow name to answer "why
did nothing run?".

**Repos-filter drops.** A workflow the event's repository does not match is
reported on a different message, once per delivery rather than once per
workflow: `Global workflows dropped by their repos filter`, carrying
`deliveryId`, `sourceRepo`, `droppedCount`, and a `dropped[]` array of
`{ workflow, workflowRepo, repos }`. This is the aggregated form deliberately —
an org whose organization workflows declare `repos: ['myorg/service-*']` drops
all of them on every delivery from every other repo, which is the steady state
rather than an anomaly. Search for this message when a workflow is registered
and enabled but has never run for one particular repository; the per-workflow
decision-trace line above will not carry that case.

**Prometheus metrics** (scrape `http://orchestrator:4000/metrics`):

- `kici_orch_global_eval_candidates_total` — organization workflows handed to an
  evaluation round, including those the orchestrator suppressed without running
  one. Equal to the sum of the verdict counter below by construction, so read it
  as the top-line rate and the denominator that breakdown divides — not as a
  second signal to compare against it.
- `kici_orch_global_eval_verdicts_total{outcome="run"|"filtered"|"indeterminate"}`
  — what the round decided per workflow. `filtered` is a predicate that ran and
  said no; `indeterminate` is a question nobody answered (a failed round, a
  budget breach, or an orchestrator that could not run a round at all). A rising
  `indeterminate` rate is an incident; a rising `filtered` rate is authors
  filtering.
- `kici_orch_global_eval_round_duration_seconds{result="success"|"error"}` — how
  long one dispatched round took, from dispatch to settled verdicts
- `kici_orch_global_eval_jobs_generated` — jobs the round's generators produced,
  recorded once per settled round
- `kici_orch_global_eval_cache_lookups_total{result="hit"|"miss"|"unkeyable"}` —
  the redelivery cache. **A hit rate near zero is the expected reading**: the
  cache key covers the whole event, so every genuinely new push is a miss by
  construction. The cache exists to make a provider redelivery cheap, not to
  reduce steady-state evaluation. `unkeyable` counts an input that could not be
  serialized and therefore never reached the cache at all — it is kept apart
  from `miss` so the hit rate is measured against every lookup.
