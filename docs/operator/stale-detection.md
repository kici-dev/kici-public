---
title: Stale run detection and failure marking
description: Configuration and tuning guide for KiCI's automatic stale run detection
---

KiCI automatically detects and marks stale CI runs -- jobs that stop responding because an agent died, a network partition occurred, or a container was killed. This prevents runs from remaining stuck in an "in progress" state indefinitely.

Stale detection is **always on by default** with sensible defaults. No opt-in or configuration is required for basic operation.

## How it works

KiCI uses a **two-tier detection model**:

1. **Orchestrator tier** -- Detects stale agents. Agents send periodic heartbeats for each running job. If no heartbeat arrives within the stale threshold, the job is marked as `timed_out_stale`. The detector also catches dispatched jobs that were never acknowledged by an agent (dispatch sent but no heartbeat ever received).

2. **Platform tier** -- Detects stale orchestrators. If an orchestrator disconnects from the Platform relay and does not reconnect within 5 minutes (default), all active runs for that orchestrator's routing keys are marked as `timed_out_stale`. On Platform startup, an immediate orphan scan marks any running runs with no active orchestrator connection as stale without waiting for the threshold.

### Detection flow

```
Agent --heartbeat (60s)--> Orchestrator --scan (60s)--> DB
Platform --WS monitor--> disconnect tracking --scan (60s)--> DB
```

Agents send a `job.heartbeat` message every 60 seconds (configurable) for each running job. The orchestrator persists the heartbeat timestamp in `execution_jobs.last_heartbeat_at`. The stale detector scans the DB periodically and marks jobs whose last heartbeat is older than the stale threshold.

## Configuration

All stale detection parameters are configured via environment variables on the **orchestrator**.

| Variable                                   | Default | Description                                                      |
| ------------------------------------------ | ------- | ---------------------------------------------------------------- |
| `KICI_STALE_DETECTOR_SCAN_INTERVAL_MS`     | `60000` | How often the detector scans for stale runs (milliseconds)       |
| `KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER` | `2`     | Multiplier applied to heartbeat interval for the stale threshold |
| `KICI_JOB_HEARTBEAT_INTERVAL_MS`           | `60000` | How often agents send per-job heartbeats (milliseconds)          |

### Derived stale threshold

The stale threshold is computed as:

```
stale threshold = KICI_JOB_HEARTBEAT_INTERVAL_MS x KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER
```

With defaults: `60,000ms x 2 = 120,000ms (2 minutes)`.

This means a job is considered stale if no heartbeat has been received for 2 minutes.

### Platform tier behaviour (informational)

The Platform tier also performs stale-orchestrator detection: when an orchestrator disconnects from the Platform relay and does not reconnect within ~5 minutes, runs whose routing keys belong to that orchestrator are marked `timed_out_stale`. Operators of self-deployed orchestrators do not configure the Platform tier — its thresholds are managed by the SaaS Platform. If you operate the Platform itself (internal docs only), see internal Platform docs.

## Tuning guidance

### Faster detection

Lower the heartbeat interval for faster stale detection at the cost of more DB writes:

```bash
KICI_JOB_HEARTBEAT_INTERVAL_MS=30000         # 30s heartbeat
KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER=2   # 60s detection
KICI_STALE_DETECTOR_SCAN_INTERVAL_MS=30000   # 30s scan
```

This configuration detects stale jobs within approximately 60 seconds.

### More tolerant detection

Increase the multiplier if you experience false positives due to network blips or high-latency connections:

```bash
KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER=3   # 180s detection with default 60s heartbeat
```

### Default recommendation

The default configuration (2 minutes detection time) is suitable for most CI workloads. It provides a good balance between detection speed and tolerance for temporary network issues.

## Metrics

KiCI exposes the following Prometheus metrics for stale run monitoring:

| Metric                                       | Type      | Description                                               |
| -------------------------------------------- | --------- | --------------------------------------------------------- |
| `kici_orch_stale_runs_detected_total`        | Counter   | Total number of stale runs detected and marked as failed  |
| `kici_orch_stale_detection_duration_seconds` | Histogram | Time between job becoming stale and detection (seconds)   |
| `kici_orch_stale_runs_current`               | Gauge     | Current number of stale runs detected in last scan        |
| `kici_platform_stale_orchestrators_total`    | Counter   | Total orchestrators detected as permanently disconnected  |
| `kici_platform_stale_runs_failed_total`      | Counter   | Total execution runs failed due to orchestrator staleness |

### Example alerts

```yaml
# Alert when stale jobs are detected
- alert: KiCIStaleJobsDetected
  expr: rate(kici_orch_stale_runs_detected_total[5m]) > 0
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: 'KiCI is detecting stale jobs'
    description: 'Stale job detection rate: {{ $value }}/s'
```

## Failure behavior

### GitHub check runs

When a job becomes stale, KiCI updates its GitHub check run with the `timed_out` conclusion. This appears in the GitHub UI as a timeout indicator, distinct from a regular failure.

### Database status

Stale jobs are marked with the `timed_out_stale` status in the `execution_jobs` table. This is a distinct value from `failed`, allowing you to query specifically for stale timeouts:

```sql
SELECT * FROM execution_jobs WHERE status = 'timed_out_stale';
```

When all jobs in a run reach a terminal state (including `timed_out_stale`), the `execution_runs` row is also marked as completed with `status = 'failed'` (since a stale timeout is treated as a failure for overall run status).

### Held run expiry

The stale detector also handles expiring overdue held runs (runs awaiting environment approval that exceed their hold expiry timeout). When a `HeldRunStore` is configured, each scan calls `expireOverdue()` to transition expired pending holds to `expired` status, cancelling the associated jobs. See [Environments](environments.md) for details on hold expiry configuration.

### Orphaned recovery jobs

On startup, the stale detector cleans up jobs stuck in `recovering` state from a previous orchestrator instance. Recovery timers are in-memory and lost on restart, so any jobs still in `recovering` state are immediately failed with a descriptive error message.

### Crash recovery

If the orchestrator itself crashes and restarts, the stale detector runs an **immediate scan on startup** to find any jobs that became stale during the downtime. This ensures no orphaned running jobs survive a restart.

The completion logic includes a **DB-fallback path** that works even when in-memory state is empty (post-restart), so `execution_runs.status` is correctly updated even after a crash.

## Queue timeout expiry

Jobs waiting in the dispatch queue (no matching agent available) are automatically expired after a configurable timeout. When a job expires:

1. The orchestrator marks it as `timed_out_stale` in both the local `execution_jobs` table and the Platform execution projection
2. The run is checked for completion (if all jobs are terminal, the run is marked `failed`)
3. An `orchestrator.job.queue_expired` infrastructure event is emitted for dashboard visibility

### Configuration

The queue timeout is configurable via the admin CLI (persisted in the cluster DB) or environment variable:

```bash
# Via admin CLI (recommended -- persisted, survives restarts, shared across cluster)
kici-admin config set queue.timeoutMs 7200000       # 2 hours
kici-admin config set queue.timeoutMs 0             # indefinite (no expiry)
kici-admin config reload

# Via environment variable (override, takes precedence over DB config)
KICI_QUEUE_TIMEOUT_MS=7200000
```

| Setting           | Default            | Description                                                                      |
| ----------------- | ------------------ | -------------------------------------------------------------------------------- |
| `queue.timeoutMs` | `3600000` (1 hour) | How long a job can wait in the dispatch queue before expiring. `0` = indefinite. |

### Platform safety-net GC

The Platform tier runs a safety-net garbage collector as part of its periodic stale scan (every 60 seconds). This catches jobs that the orchestrator failed to expire -- e.g., if the orchestrator crashed during its cleanup cycle.

The safety net uses **2x the orchestrator's reported queue timeout** as its threshold. The orchestrator reports its `queue.timeoutMs` value to the Platform via the `source.register` protocol message on every connection. For orchestrators that don't report a timeout (older versions), the Platform falls back to a 2-hour threshold.

The 2x margin ensures the orchestrator-side expiry always takes priority. The Platform safety net only fires if the orchestrator genuinely failed to clean up.

Late updates from the orchestrator will overwrite the Platform-side expiry status (the Platform uses an upsert on `job.status.forward` messages), so there is no race condition risk.

## Stale check run cleanup

When an orchestrator dies permanently, the Platform tier marks the associated `execution_runs` as `timed_out_stale` in its database. It also collects cleanup metadata (repository, SHA, workflow name, job names) for each affected run and queues it in memory, keyed by routing key.

When a replacement orchestrator reconnects and sends `source.register` for the same routing keys, the Platform forwards the pending cleanup entries via the `stale.checkrun.cleanup` protocol message. The orchestrator then discovers the stuck GitHub check runs via `checks.listForRef` and updates them to a `timed_out` conclusion, so they no longer appear as "in_progress" on GitHub.

If no replacement orchestrator reconnects (e.g., the customer decommissions the instance), GitHub will eventually mark these check runs as stale on its own (after several hours), or the user can re-push to trigger a fresh CI run.
