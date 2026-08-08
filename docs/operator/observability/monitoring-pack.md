---
title: Orchestrator monitoring pack
description: Import a starter Grafana dashboard and Prometheus alert rules for a self-hosted KiCI orchestrator
---

KiCI ships a starter monitoring pack for a self-hosted orchestrator: one importable Grafana dashboard and a set of Prometheus alert rules covering the signals that matter at 2am — dispatch queue depth, stale runs, the event DLQ, scaler spawn failures, and agent-vs-backlog health. Every metric the pack references is one the orchestrator already exports on its `/metrics` endpoint, so there is no extra instrumentation to install.

## What's in the pack

- **[Grafana dashboard](../../../monitoring-pack/kici-orchestrator-dashboard.json)** — a single "KiCI orchestrator health" board: fleet size, dispatch queue by status and runner label, the event DLQ and delivery outcomes, scaler CPU/memory reservation and spawn failures, consecutive job failures, declared-host reachability, database collation drift, inbound webhook rate, and org trust-policy gate decisions.
- **[Alert rules](../../../monitoring-pack/kici-orchestrator-alerts.yaml)** — ten Prometheus alert rules with tuned thresholds and per-rule rationale.

## Import the dashboard

1. In Grafana, go to Dashboards → New → Import.
2. Upload `kici-orchestrator-dashboard.json` (or paste its contents).
3. When prompted, select your Prometheus data source for the `DS_PROMETHEUS` input.
4. Save.

The dashboard prompts for the data source on import rather than hard-coding one, so it drops into any Grafana that scrapes your orchestrator.

## Install the alert rules

Wire `kici-orchestrator-alerts.yaml` into your Prometheus `rule_files:` (or your Grafana / Mimir ruler) and reload. Point the alerts at your notification channel of choice. The file is a standard Prometheus rule-group document — a single `kici-orchestrator` group — so it needs no conversion.

## Threshold rationale

Thresholds are starting points. `QueueDepthSaturated` and `JobConsecutiveFailures` in particular are workload-dependent — tune them to your fleet size and job mix.

| Alert                    | Expression                                                                                            | For | Severity | Why this threshold                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QueueDepthSaturated      | `kici_orch_dispatch_queue_depth{status="pending"} > 50`                                               | 10m | warning  | Pending work should drain as agents pick it up. A sustained backlog means the scaler is starved or stuck. 50 is deployment-size-dependent — tune to your fleet.                                                                                       |
| AgentsAllGoneWithBacklog | `(sum(kici_orch_agents_active) == 0) and (sum(kici_orch_dispatch_queue_depth{status="pending"}) > 0)` | 10m | critical | Zero agents while jobs are queued is a hard stall. It also catches a lost connection to the hosted Platform: if the relay drops and the fleet drains, queued work has nothing to run it.                                                              |
| StaleRunsPresent         | `kici_orch_stale_runs_current > 0`                                                                    | 15m | warning  | Any stale run signals an agent that stopped heartbeating. The 15-minute window avoids flapping on transient detection.                                                                                                                                |
| EventDLQGrowing          | `increase(kici_orch_event_dlq_total[1h]) > 0`                                                         | 0m  | warning  | DLQ rows are never cleaned by TTL, so growth — not standing depth — is the pager. Any new admission means an event exhausted its retries.                                                                                                             |
| EventDLQBacklog          | `kici_orch_event_dlq_depth > 0`                                                                       | 30m | info     | Standing DLQ depth is a todo, not a page. Informational so you triage the backlog without being paged for it.                                                                                                                                         |
| ScalerSpawnFailing       | `increase(kici_orch_scaler_spawn_failures_total[15m]) > 0`                                            | 0m  | warning  | Any spawn failure means some jobs cannot get an agent — worth a look at the backend and resource caps.                                                                                                                                                |
| JobConsecutiveFailures   | `kici_orch_job_consecutive_failures > 3`                                                              | 0m  | warning  | A scheduled job failing three-plus times in a row is stuck, not a blip. Tune the count to your job mix.                                                                                                                                               |
| DeclaredHostUnreachable  | `kici_orch_declared_hosts_unreachable > 0`                                                            | 10m | warning  | A statically-declared roster host that is unreachable cannot take work.                                                                                                                                                                               |
| DbCollationDrift         | `kici_orch_db_collation_drift > 0`                                                                    | 0m  | warning  | Collation drift can silently hide present rows from text-index lookups — reindex after aligning the collation version.                                                                                                                                |
| StateReplayBreakerOpen   | `increase(kici_orch_state_replay_breaker_trips_total[15m]) > 0`                                       | 0m  | warning  | The orchestrator gave up replaying run state to the Platform after repeated rejections and connected without it, so the Platform run mirror is knowingly stale. The 15m `increase` keeps the alert true long enough to survive Alertmanager grouping. |

## Watching Platform connectivity

The orchestrator relays webhooks and dispatch over a connection to the hosted KiCI Platform. Two pack signals reflect its health without a dedicated connectivity metric: the **Webhooks received rate** panel shows inbound flow drying up, and `AgentsAllGoneWithBacklog` fires when the fleet drains while work is still queued — the shape a dropped relay produces once existing agents finish.

## See also

- [Monitoring & tracing](./monitoring.md)
