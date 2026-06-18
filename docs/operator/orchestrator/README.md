---
title: Orchestrator
description: Deploy and operate the KiCI orchestrator
---

The KiCI orchestrator is the execution brain (Tier 2) of the three-tier architecture. It connects to the KiCI Platform relay via WebSocket, receives forwarded webhooks, fetches lock files from repositories, matches triggers against workflow configurations, and dispatches jobs to connected agents. It runs entirely in customer infrastructure with three operating modes: platform, hybrid, and independent.

## Pages

### [Deploying the KiCI orchestrator](getting-started.md)

Deploy the orchestrator using Docker or Docker Compose. Covers all three operating modes (platform for Platform-connected, hybrid for dual webhook sources, independent for fully self-hosted), PostgreSQL database setup, GitHub App configuration, API key provisioning, and health check verification.

### [Configuration reference](configuration.md)

Complete environment variable reference for the orchestrator. Covers core settings (mode, port, database URL), GitHub App credentials (app ID, private key), Platform connection settings (URL, token), lock file caching (size, TTL), agent management, and mode-specific validation rules. Includes minimal and full `.env` examples for each mode.

### [Auto-scaler](auto-scaler.md)

Configure ephemeral agent provisioning with Docker, bare-metal, and Firecracker backends. Covers YAML configuration schema, label-set matching semantics, Docker socket security warnings, warm pool management, `scalers.d/` multi-file config, SIGHUP reload, Prometheus metrics, troubleshooting, and complete example configurations for simple, mixed, and production deployments.

### [Config management guide](config-management.md)

Shared config lifecycle: seeding config to the database, viewing and modifying config via CLI and REST API, hot-reloading, rollback, and cluster config synchronization.

### [Firecracker setup guide](firecracker-setup.md)

Set up Firecracker microVMs for hardware-isolated ephemeral CI agents. Covers host prerequisites (KVM, binaries, architecture notes), helper scripts for network setup, jailer setup, and rootfs building, complete YAML configuration with dual-architecture examples, DB-backed IP allocation, MMDS-based agent bootstrap, security hardening, and troubleshooting common issues.

## Test run support

The orchestrator provides endpoints for remote test runs triggered by `kici run remote` from developer workstations.

### Endpoints

| Method | Path                               | Description                                                        |
| ------ | ---------------------------------- | ------------------------------------------------------------------ |
| `POST` | `/api/v1/test/trigger`             | Trigger a test run with a fixture payload                          |
| `POST` | `/api/v1/test/cancel`              | Cancel a running test                                              |
| `GET`  | `/api/v1/test/runs/:runId`         | Get status of a test run                                           |
| `GET`  | `/api/v1/test/runs/:runId/logs`    | Get logs for a test run                                            |
| `POST` | `/api/v1/uploads/init`             | Initialize a tarball upload (returns signed URL + encryption keys) |
| `GET`  | `/api/v1/uploads/:uploadId/status` | Check upload status                                                |
| `WS`   | `/api/v1/observe/:runId`           | Real-time observer channel (read-only log streaming)               |

### Upload storage

Test tarballs are stored alongside dependency caches in the configured S3-compatible storage:

- **Bucket:** Same as `KICI_STORAGE_BUCKET`
- **Prefix:** `test-uploads/`
- **Path:** `test-uploads/{sanitized-routing-key}/{sha or "unknown"}/{uploadId}.tar.gz.enc`
- **Retention:** 24 hours -- configure an S3 lifecycle rule on the `test-uploads/` prefix
- **Encryption:** Client-side ECDH + AES-256-GCM (orchestrator generates ephemeral keypairs); the `.enc` suffix marks the encrypted tarball

No additional bucket or storage configuration is required beyond the existing cache storage setup.

### Secret context access

Test runs access secrets through the same secret resolution flow as production runs. Secret contexts are managed via `kici-admin secret` commands -- see [Secrets management](../security/secrets.md) for details.

### Observer channel

The observer WebSocket endpoint (`/api/v1/observe/:runId`) streams real-time execution updates to CLI clients:

- Authenticated via API key token in the subscribe message
- Multiple clients can observe the same run simultaneously
- Supports reconnection with backfill of missed messages via `lastSeenTimestamp`
- Zero overhead for production (non-test) runs -- observer broadcasting is gated on an in-memory set

For the full architecture, see [Test run architecture](../../architecture/execution/test-runs.md).

## Job recovery

When the orchestrator restarts (planned upgrade, crash, or resource pressure), running jobs are not immediately lost. The recovery protocol gives agents a grace period to reconnect and resume in-flight jobs.

### Default behavior

- **Grace period:** 120 seconds (auto-derived as 2x the max reconnection delay of 60s)
- **No configuration required:** The grace period scales proportionally with the reconnection settings
- **Per-job timers:** Each in-flight job gets its own recovery deadline from when its agent disconnected

### What happens during recovery

1. Agent loses WebSocket connection, starts exponential backoff reconnection
2. Orchestrator marks in-flight jobs as `recovering` in the database
3. Per-job timers begin counting down the grace period
4. Agent reconnects and reports its in-flight jobs
5. Orchestrator reconciles: cancels timers, restores job tracking
6. Agent flushes buffered logs with a gap marker showing outage duration
7. Job completes normally

### Monitoring recovery

Query the `dispatch_queue` table to check for jobs in recovery:

```sql
-- Jobs currently in recovery
SELECT count(*) FROM dispatch_queue WHERE status = 'recovering';

-- Recent recovery timeout failures
SELECT id, run_id, error_message, updated_at
FROM dispatch_queue
WHERE status = 'failed'
  AND error_message LIKE '%recovery timeout%'
ORDER BY updated_at DESC;
```

**Structured log fields** for Loki alerting:

| Field                     | Description                                   |
| ------------------------- | --------------------------------------------- |
| `recovery_duration`       | Milliseconds between disconnect and reconnect |
| `agent_id`                | Agent that reconnected                        |
| `job_id`                  | Job that was recovered                        |
| `buffered_messages_count` | Messages buffered during outage               |

### Non-recoverable jobs

When the grace period expires and the agent has not reconnected:

- Job is permanently failed with: "Job failed: agent lost during orchestrator restart (recovery timeout exceeded)"
- Partial logs (received before the outage) are preserved in the execution report
- The scaler is notified to avoid spinning up replacement agents for dead jobs
- The stale run detector handles any remaining cleanup

### Gap markers in logs

After recovery, a gap marker appears in the log stream:

```
--- Orchestrator offline for 45s. Replaying 12 buffered events and 238 buffered log lines. ---
```

If buffer overflow occurred, the marker includes the count of dropped lines:

```
--- Orchestrator offline for 120s. Replaying 0 buffered events and 5000 buffered log lines. 2847 log lines dropped due to buffer overflow. ---
```

### Interaction with scaler

- When a recovery timer expires, the `onRecoveryTimeout` callback notifies the scaler
- The scaler avoids spinning up replacement agents for jobs that are in recovery or have timed out
- On orchestrator startup, orphaned `recovering` jobs are cleaned up before the scaler begins normal operation

For the full technical protocol, see the [Agent reconnection and job recovery](../../architecture/clustering/agent-reconnection.md) architecture document.
