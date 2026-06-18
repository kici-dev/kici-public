---
title: Architecture
description: Deep-dive documentation for KiCI internals
---

Deep-dive documentation for KiCI internals. These docs explain how the three-tier relay model works, how data flows between tiers, and the design decisions behind the architecture. Useful for anyone who wants to understand KiCI beyond the user-facing API -- whether you are contributing code, debugging production issues, or evaluating KiCI for your organization.

## Pages

### [Architecture overview](overview.md)

The three-tier relay model (Platform, orchestrator, agent) with a Mermaid flowchart showing all tier connections and a package dependency graph showing how the 11 packages (9 scoped `@kici-dev/*` plus the unscoped `kici` wrapper and `kici-admin` admin CLI) relate to each other. Start here for the big picture of how KiCI is structured and why each tier exists.

### [Execution state machine](./execution/state-machine.md)

The execution state machine tracks every workflow run, job, and step through 11 states (pending, queued, running, recovering, cancelling, held, waiting, success, failed, cancelled, skipped) using 16 events. This page covers the full transition table, Mermaid stateDiagram-v2 visualization, API reference for the 2 public functions, and how each tier uses the state machine.

### [Protocol messages](protocol-messages.md)

KiCI uses multiple WebSocket layers: Platform-to-orchestrator, orchestrator-to-agent, peer-to-peer, and dashboard. Each has its own set of Zod-validated message schemas. This page documents the core message types with field-level reference tables, a sequence diagram showing the authentication handshake, and the WebSocket close codes.

### [Webhook delivery flow](./webhooks/webhook-delivery.md)

End-to-end trace of a webhook from the moment GitHub sends it to the point where an agent starts executing. Includes a Mermaid sequence diagram for visual overview and a 12-step numbered walkthrough with source file references. Also documents 10 failure paths with their triggers, outcomes, and recovery mechanisms.

### [Job execution lifecycle](./execution/job-execution.md)

The agent job lifecycle from dispatch to cleanup, covering all 8 phases: receive, clone, load, rules, matrix, steps, report, cleanup. Includes a Mermaid flowchart showing branching for rule evaluation, step failures, cancellation, and Docker mode. Covers concurrency control and the sendDirect vs send buffer bypass distinction.

### [Reconnection and event buffering](./clustering/reconnection.md)

WebSocket reconnection behavior for both the Platform-orchestrator and orchestrator-agent connections. Covers exponential backoff with a progression table, event buffering during disconnection, heartbeat monitoring, and 5 failure scenarios with table-format behavior descriptions for quick operator reference.

### [Agent reconnection and job recovery](./clustering/agent-reconnection.md)

How agents survive orchestrator restarts without losing running jobs. Covers the recovery protocol (grace periods, per-job timers, inFlightJobs reporting), the `recovering` execution state, log continuity with gap markers, startup recovery, and failure modes.

### [Multi-orchestrator architecture](./clustering/multi-orchestrator.md)

Multi-orchestrator clustering architecture. Covers the coordinator/worker model, peer-to-peer communication via direct WebSocket, Raft leader election for orphan recovery, claim-based job rerouting with parallel fan-out and loop prevention, webhook secret management via PostgreSQL LISTEN/NOTIFY, and failure modes. Includes data flow diagrams for the full webhook-to-check-run update path across clustered orchestrators.

### [Secrets architecture](./security/secrets.md)

Deep-dive into the secrets management subsystem. Covers the AES-256-GCM encryption model (wire format, AAD binding, key versioning), multi-backend architecture (PgSecretStore, VaultSecretStore), access rule evaluation, secret resolution flow at dispatch time, RBAC model with permission matrix, audit logging schema, and security considerations (Platform isolation, log masking, AAD swap prevention).

### [Environments architecture](environments.md)

Data model, protection rule pipeline, scope resolution algorithm, and state machine extensions for deployment environments. Covers the orchestrator DB schema (environments, variables, overrides, held_runs), the sequential protection gate pipeline (branch -> concurrency -> reviewer -> timer), the longest-path-wins scope resolution algorithm, the 8-layer environment variable merge, held/waiting state machine extensions, the WS proxy pattern for dashboard CRUD, and lock file v6 schema changes.

### [Test run architecture](./execution/test-runs.md)

End-to-end data flow for remote test runs triggered by `kici test`. Covers the upload encryption scheme (X25519 ECDH + AES-256-GCM), overlay application on the agent, observer WebSocket streaming, and how test runs integrate with the existing production pipeline. Includes comparison table of test vs production runs.

### [Data flows](data-flows.md)

End-to-end data flows through the three-tier architecture. Covers webhook delivery, job execution, dependency caching (build-then-execute, cache miss/hit/partial flows, build deduplication), cache storage architecture (S3-only backend, platform-aware keys, pre-signed URL upload/download), internal event routing (pg_notify fan-out, circuit breaker, trust store), generic webhook ingestion, execution reporting, trace ID propagation (requestId + runId via AsyncLocalStorage), and output chaining (step/job output proxies, IPC transport).

### [Execution isolation architecture](./execution/execution-isolation.md)

Deep-dive on the agent-code isolation model. Covers how KiCI separates customer workflow code from agent-internal resources using the sandbox architecture (bare-metal bwrap, container, Firecracker backends), IPC protocol between agent and workflow runner, and environment sanitization.

### [Configuration architecture](configuration.md)

Internal design of the orchestrator's configuration management system. Covers the config resolution chain (YAML file, DB overrides, env vars), DB schema, AES-256-GCM encryption for sensitive fields, hot-reload via SIGHUP, and cluster synchronization via pg_notify.

### [Stale run detection architecture](./execution/stale-detection.md)

Architecture of KiCI's two-tier stale detection system. Covers how the orchestrator detects jobs that have stopped responding using agent heartbeats and orchestrator-level timers, and how stale runs are marked as failed with appropriate check run updates.

### [GitHub checks architecture](./webhooks/github-checks.md)

Enriched GitHub Check run system with real-time step progress, failure details with log context, and source location annotations. Covers the two-level check run model (per-workflow and per-job), live progress updates, debouncing, and the annotation generation pipeline.

### [Event system internals](./webhooks/event-system.md)

Internal architecture of the event system for non-Git workflow triggers (custom events, system events, cron schedules, lifecycle events). Covers the event router, event store, circuit breaker, trust store, registration model, cron scheduler, and the run infrastructure events subsystem for observability timeline tracking.

### [Execution lifecycle](./execution/execution-lifecycle.md)

Cancel flow, hook execution order, and concurrency group protocol. Covers the detailed lifecycle of job and step execution beyond the state machine transitions.

### [Role-based access control (RBAC)](./security/rbac.md)

Permission model, custom roles, enforcement, and invitation flow. Covers the in-house RBAC system where the OIDC identity provider handles authentication only and all permission data lives in the KiCI database.

### [CI security architecture](./security/ci-security.md)

Trust model, trust resolution, lock file pinning, security approval queue, and workflow modification detection. Covers the 3-tier trust model for CI/CD pipeline security where every PR-triggered run evaluates the contributor's trust level.

### [Global workflows](global-workflows.md)

Architecture and design of cross-repo global workflows. A single workflow repository defines CI/CD pipelines that trigger on events from any other repository under the same organization (routing key). Enables centralized CI policy enforcement, shared build pipelines, and org-wide automation.

### [Coordinator/worker topology](./clustering/coordinator-worker.md)

Architecture of the coordinator/worker orchestrator topology for lightweight edge deployments. Workers are orchestrator instances running in a different mode, connected to a coordinator via P2P WebSocket, with zero infrastructure dependencies (no PostgreSQL, no S3).

### [Dynamic job generation](./execution/dynamic-jobs.md)

How DynamicJobFn enables workflows to generate jobs at runtime based on external state. Covers the SDK API, lock file representation, agent-side evaluation, and how dynamic jobs integrate with the existing static job pipeline.

### [Needs-aware dispatch scheduler](./execution/needs-scheduler.md)

DB-backed module that gates job dispatch on upstream completion. Covers the `needs` hard dispatch gate for static-to-static, static-to-dynamic-group, and other edge types, replacing the previous concurrent dispatch model.

### [Webhook pipeline](./webhooks/webhook-pipeline.md)

The orchestrator's webhook processing pipeline that turns inbound provider webhooks into dispatched workflow runs. Covers the provider-agnostic pipeline, `processWebhook()` entry point, normalization, lock-file fetch, and credential minting through the `ProviderRegistry`.
