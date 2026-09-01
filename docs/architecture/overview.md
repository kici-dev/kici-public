---
title: Architecture overview
description: Three-tier relay model, package structure, and component responsibilities
---

KiCI uses a three-tier relay model that separates webhook routing from code execution. Customer code never leaves customer infrastructure -- the Platform tier handles only webhook verification and routing, while the orchestrator and agent tiers run on customer-managed servers.

## Three-tier relay model

The system is organized into three deployment tiers connected by WebSocket channels:

```mermaid
flowchart LR
    GH["GitHub"]
    PLATFORM["Platform\nWebhook router"]
    ORCH_A["Orchestrator A\nExecution brain"]
    ORCH_B["Orchestrator B\nExecution brain"]
    AGENT_A["Agent\n(x64)"]
    AGENT_B["Agent\n(arm64)"]

    GH -- "HTTP\n(webhooks)" --> PLATFORM
    GH -. "HTTP direct webhook\n(hybrid / observed / independent)" .-> ORCH_A
    PLATFORM <-- "WebSocket\n(relay + telemetry)" --> ORCH_A
    PLATFORM <-- "WebSocket\n(relay + telemetry)" --> ORCH_B
    ORCH_A <-- "WebSocket P2P\n(reroute + progress\n+ Raft)" --> ORCH_B
    ORCH_A <-- "WebSocket\n(dispatch + status)" --> AGENT_A
    ORCH_B <-- "WebSocket\n(dispatch + status)" --> AGENT_B
    ORCH_A -- "GitHub API\n(lock file, checks)" --> GH
    AGENT_A -- "git clone" --> GH
    AGENT_B -- "git clone" --> GH
```

**Why three tiers?** Trust boundaries. The Platform relay never sees customer code -- it only verifies webhook signatures and forwards payloads. The orchestrator matches triggers against the lock file without cloning repositories. Only the agent, running on customer infrastructure, clones code and executes steps.

This model also supports pointing webhooks **directly** at the orchestrator,
bypassing the Platform relay. In **hybrid** mode the orchestrator keeps its
Platform connection for the dashboard and telemetry while GitHub delivers events
straight to the orchestrator's ingress — so a Platform outage never drops a build
trigger. **Observed** mode drops the relay leg entirely: webhooks reach only the
orchestrator's own ingress (no payload ever transits KiCI) while the Platform
connection stays up for the hosted dashboard, and the orchestrator's sources
register as observe-only — recorded and dashboard-visible, but excluded from
every relay-candidate lookup. In a fully **independent** deployment the
orchestrator and agent run on customer infrastructure with no Platform at all,
receiving webhooks directly. For
exactly which capabilities the hosted Platform provides in each case, see
[What requires the hosted Platform](../operator/orchestrator/platform-capabilities.md).

## Component responsibilities

### Platform

The Platform is KiCI's hosted, multi-tenant control plane. It provides the hosted dashboard (run listing, run detail, live log streaming, settings), identity and authentication (OIDC, personal access tokens, API keys, JWTs), multi-tenant organization / team / role-based access management, billing, and webhook ingestion -- verifying inbound signatures (HMAC-SHA256, timing-safe) and relaying payloads to the correct orchestrator over WebSocket. It aggregates execution telemetry and status forwarded by orchestrators, registers sources, and matchmakes peers for clustering.

The Platform never processes, stores, or executes customer code, and never sees customer secrets. It routes webhook payloads and aggregates execution status; the code itself only ever lives on the customer's orchestrator and agent tiers. In the execution path the Platform is deliberately thin -- it does not run jobs -- but functionally it is a full platform, not merely a relay. The hosted Platform is EU-sovereign.

### Orchestrator (`@kici-dev/orchestrator`)

The orchestrator is the execution brain. It decides what to run and dispatches work to agents.

- **Trigger matching** -- Evaluates lock file triggers against webhook payloads to determine which jobs to run. Uses branch, path, and event matching via picomatch.
- **Lock file caching** -- Fetches `kici.lock.json` via the configured source's fetcher (GitHub API, universal-git clone for generic webhook sources backed by a git URL, or the local filesystem for `file://` sources). An LRU cache wraps the per-provider fetcher, keyed by `{provider}:{repo}:{ref}` so cross-provider fallback resolutions stay isolated.
- **Agent registry** -- Tracks connected agents with label-based routing for job dispatch.
- **Job queue** -- PostgreSQL-backed FIFO queue for reliable dispatch.
- **Webhook pipeline** -- Dedup, event mapping, lock file fetch, trigger matching, and job dispatch in a single pipeline.
- **Multi-orchestrator clustering** -- Optional peer-to-peer coordination via direct WebSocket connections. Enables cross-architecture job routing (e.g., x64 coordinator reroutes arm64 jobs to a peer), high availability, and dedicated coordinator topologies. Uses Raft consensus for leader election (orphan recovery). See [Multi-Orchestrator Architecture](./clustering/multi-orchestrator.md).
- **Auto-scaler** -- Optional pluggable module for ephemeral agent provisioning. Four backends are configurable: containers (Docker/Podman), bare-metal processes, Firecracker microVMs, and the event backend, which performs no local compute -- it emits reserved scale-up / scale-down events that a customer-authored provisioning workflow consumes to boot and tear down a cloud instance. Spawns agents on demand when no matching agent is connected, with label-based routing, two-level capacity limits (global + per-backend), warm pools, YAML configuration (`scalers.d/` directory support), and SIGHUP reload. Disabled by default -- orchestrator works without it.
- **Independent database** -- Has its own PostgreSQL database separate from the Platform. Stores execution runs/jobs/steps, dispatch queue, webhook secrets, dedup cache, and scaler state. The orchestrator's `execution_runs` and `execution_jobs` are the authoritative source of truth. The Platform receives execution status updates via WebSocket messages (`execution.status`, `job.status.forward`).

> Source: `packages/orchestrator/src/pipeline/processor.ts` (webhook pipeline), `packages/orchestrator/src/cluster/` (P2P coordination), `packages/orchestrator/src/scaler/` (auto-scaler module), `packages/orchestrator/src/server.ts` (Platform/hybrid entry point)

### Agent (`@kici-dev/agent`)

The agent is the execution worker. It runs on customer infrastructure and has full access to customer code.

- **Repository cloning** -- Clones the target repo with token-based auth (token in HTTP headers, not URLs, to prevent leakage).
- **Git credential helper** -- Registers a credential helper for the job's git operations. Every network operation asks the orchestrator's broker for a credential, so a token is minted seconds before use rather than held for the life of the job. Write access is opt-in and time-boxed: `ctx.repo.withWrite(...)` adds a repository-scoped grant for the duration of its callback and revokes it afterwards, with a TTL backstop.
- **Step execution** -- Runs steps in declaration order with full `StepContext` (zx shell, logger, environment, workflow/job metadata). Steps wrapped in a `parallel()` group run concurrently behind a `maxParallel` window, and each child reports as its own observable step with its own logs, status, timing, and retry.
- **Execution sandboxes** -- Runs the workflow runner as a separate child process with a sanitized environment, in one of three sandboxes: bare metal (process fork, with optional bubblewrap namespace isolation), a container runtime (the whole job lifecycle runs inside a disposable container), or inside a Firecracker microVM. Agent-internal credentials never reach customer workflow code.
- **Log streaming** -- Chunked log streaming back to the orchestrator with configurable size limits.
- **Dependency caching** -- Packs, uploads, and restores installed workflow dependencies so repeat runs skip the install step.
- **Graceful shutdown** -- SIGTERM with 10s grace period, SIGUSR1 for drain mode.

> Source: `packages/agent/src/execution/job-runner.ts` (job lifecycle), `packages/agent/src/execution/sandbox/` (execution sandboxes and the parallel step scheduler), `packages/agent/src/server.ts` (entry point)

## Supporting packages

### `@kici-dev/engine`

Shared business logic used by all three tiers. Single source of truth for cross-tier concerns. Has no internal `@kici-dev/*` dependencies -- only a handful of third-party libraries.

- Protocol message schemas (Zod-based, direction-specific unions including dashboard REST-over-WS, browser live streaming, the test-relay control plane, log pull, run events, peer-to-peer, cluster join, and source registration)
- Provider interfaces (WebhookNormalizer, LockFileFetcher, ChangedFilesFetcher, FileContentsFetcher, CloneTokenProvider, RepoUrlBuilder, CheckStatusPoster), plus the deprecated `ContributorResolver` the pipeline no longer calls
- Git credential vocabulary (forge names plus the credential reference, grant, request, and result shapes the SDK declares and the orchestrator's broker resolves) and the agent→orchestrator relay protocol its credential helper calls. See [Git credentials](../user/patterns/git-credentials.md)
- Trigger matching engine (branch, path, event evaluation)
- Content-requirement matcher (the declarative `requires` filter -- pure data describing a query over the bytes of one source file at the event's ref, interpreted by the orchestrator via the `FileContentsFetcher` so no author code runs there) and the shared text-match vocabulary (`contains` / `notContains` / `matches` / `notMatches`) it shares with the commit-message trigger filter
- Dispatch inputs (input descriptors, extraction from the trigger event, and coercion to typed values)
- Matrix expansion and fanout (combination expansion with include/exclude, job-name suffix formatting, and materialization of one matrix or multi-host job into N dispatchable children)
- Execution status vocabulary (run/job/step status enums + terminal-state sets; lifecycle owned by the orchestrator's execution tracker) and its presentation layer (the total precedence order that decides which status wins a roll-up, legacy-spelling resolution, and the per-status failure classification every consumer asks about)
- Job-kind discriminator, alongside the status enums. It separates a `standard` job running steps from an invoke `gate` and from the `proxy` job that mirrors a summoned run
- Check mode (the idempotent run modes `apply` / `check` / `check-fail-on-drift` and the per-step outcome vocabulary)
- Webhook signature verification (HMAC-SHA256, timing-safe)
- WebSocket close codes (unified across all tiers)
- WebSocket rate limiting (WsRateLimiter)
- Environment allowlist (safe env var filtering)
- Secrets management (secret context resolution)
- Context model (scoped secrets, ordered context merge, protection gates)
- Approval requirements (normalized approver clauses shared by the orchestrator gate, the resolver, the held-run store, and the agent step round-trip)
- Build provenance (in-toto statement schema, DSSE envelope, attestation bundle, verification)
- Artifact name contract (the shared filesystem/URL-safe name schema the orchestrator, agent, and SDK all validate against)
- Developer MCP tool schemas (argument schemas for the AI-agent tool surface) and the untrusted-content fence that wraps every repository- or contributor-supplied value an agent reads in a per-response random nonce, so log lines and error text cannot be read as instructions
- Developer-operations contract (one row per workflow-developer operation declaring which entrypoints expose it -- the shared REST API behind the web UI and the `kici` CLI, the AI-agent tool surface, and a curated UI flag -- asserted against each real surface by congruence tests)
- Label utilities (platform label derivation, runsOn normalization, `kici:*` set-only reserved namespace, role labels)
- Host inventory (the canonical queryable host-roster schema shared by the orchestrator's roster store, the agent-facing inventory API, and the SDK's `ctx.kici.inventory`)
- Audit policy and retention (per-action access-log sampling, warm-retention windows for cold-store eligibility, federated activity row schema)
- Scaler backend type enum (`container`, `bare-metal`, `firecracker`, `kubernetes`, `event`) and the reserved `kici.` event-name prefix that keeps a user step from forging a system event
- Job resource vocabulary (the requests/limits shape the SDK accepts, the compiler validates and emits, the orchestrator uses for capacity math and kernel-side enforcement, and the dashboard displays)
- Registration trigger type enum (registerable trigger discriminator)
- Sandbox capability set (the Linux capability names a container sandbox may add or drop, shared by the SDK validator, the compiler, and the dispatch resolver)
- Plan tier vocabulary (the hosted plan tiers and the purchasable subset, shared by the Platform and the browser dashboard)
- Infrastructure alert vocabulary (the diagnostics alert types and severities the Platform mints and the dashboard and `kici` CLI render)
- Metric catalog (the generated Prometheus metric inventory, its naming policy, and metric-kind compatibility checks)
- Bundler config (shared bundler configuration consumed by `e2e/helpers/service-deploy.ts`; the agent runtime uses the `@kici-dev/core/ts-loader-hook` to transform TypeScript on import, with no runtime bundler step)

> Source: `packages/engine/src/`

### `@kici-dev/sdk`

User-facing SDK for defining workflows in TypeScript. Provides factory functions (`workflow()`, `job()`, `step()`), trigger builders (`pr()`, `push()`), rules (`rule()`, `skip()`), matrix utilities, and DAG validation.

> Source: `packages/sdk/src/`

### `@kici-dev/compiler`

CLI tooling for workflow authors. Compiles `.kici/workflows/*.ts` to `.kici/kici.lock.json`, provides watch mode, local test execution, project initialization, and pre-commit hook integration.

It also runs the **local dev plane** -- an on-demand, fully local execution stack (embedded PostgreSQL, an orchestrator process, and a bare-metal-scaled agent) that lets an author run a workflow end-to-end on their own machine. That is why the compiler depends on `@kici-dev/orchestrator` and `@kici-dev/agent`: it resolves and spawns their built entry points rather than reimplementing them. See [Local dev plane](../operator/orchestrator/local-dev-plane.md).

> Source: `packages/compiler/src/` (`local-plane/` for the local dev plane)

### `@kici-dev/core`

Light shared utilities with no server-side dependencies. It provides JSON-structured logging, error helpers, async-local-storage request context, and human-readable formatting (`formatBytes`/`formatDuration`/`formatUptime`). It also provides cryptographic helpers (`sha256`/`sha256File`/`deriveSharedSecret` plus symmetric encrypt/decrypt), retry-backoff computation, and the shared diagnostics-result contract. The rest of its surface ships as subpath entry points: the temp-directory allocator and its garbage collector, package-manager detection, CI-environment detection, and the idempotent-step runner (the check / confirm / apply primitive behind idempotent steps). Finally it supplies zx initialization (`initZx()`) and the TypeScript loader hook that transforms TypeScript on import. It is the dependency-light core that the SDK, compiler, and `kici` CLI consume directly so they stay free of heavier server-only dependencies. `@kici-dev/shared` re-exports it, so existing `@kici-dev/shared` import paths keep working.

> Source: `packages/core/src/`

### `@kici-dev/shared`

Shared utilities used across packages, including everything from `@kici-dev/core` (re-exported) plus server-side helpers. Provides `initZx()` for zx initialization, `createLogger()` for JSON-structured logging with TTY-aware formatting, `createPool()`/`createDb()` for typed PostgreSQL connections, `createMetricsRoutes()`/`createHealthRoutes()` for HTTP route factories (Prometheus metrics and health endpoints), `RingBuffer` for bounded collections, `requestContext`/`getRequestContext()`/`enrichRequestContext()` for async local storage request context, `getReconnectDelay()` for exponential backoff, `formatBytes`/`formatDuration`/`formatUptime` for human-readable formatting, `sha256`/`sha256File`/`deriveSharedSecret` for cryptographic utilities, `initTelemetry`/`createMeter` for OpenTelemetry integration, and `setupGracefulShutdown` for coordinated service shutdown with ordered steps.

> Source: `packages/shared/src/`

### Dashboard

Web UI for KiCI. A browser single-page application that provides the operator dashboard with execution run listing, run detail views, real-time log streaming, settings management, and keyboard shortcut support. Authenticates via OIDC against the identity provider and communicates with the Platform REST-over-WebSocket API.

### `kici` (wrapper)

Unscoped wrapper package that provides the `kici` CLI command. Re-exports `@kici-dev/compiler/cli` so users can install `kici` globally or use it via `npx kici`.

> Source: `packages/kici/`

### `kici-admin` (admin CLI wrapper)

Unscoped wrapper package that ships two binaries: `kici-admin`, which re-exports `@kici-dev/orchestrator/cli` for orchestrator administration tasks, and `kici-agent`, which re-exports `@kici-dev/agent/server` to run an agent. It therefore depends on both `@kici-dev/orchestrator` and `@kici-dev/agent` (the `KICIADMIN → AGENT` edge in the graph below).

> Source: `packages/kici-admin/`

## Package dependency graph

The following diagram shows how `@kici` packages depend on each other. Solid arrows are direct dependencies; dashed arrows are peer or dev dependencies (labeled).

```mermaid
flowchart TD
    CORE["@kici-dev/core"]
    SDK["@kici-dev/sdk"]
    COMPILER["@kici-dev/compiler"]
    SHARED["@kici-dev/shared"]
    ENGINE["@kici-dev/engine"]
    PLATFORM["Platform"]
    ORCH["@kici-dev/orchestrator"]
    AGENT["@kici-dev/agent"]
    DASH["Dashboard"]

    DASH --> ENGINE
    DASH -.->|dev| PLATFORM
    SHARED --> CORE
    SHARED --> ENGINE
    SDK --> ENGINE
    SDK --> CORE
    COMPILER --> ENGINE
    COMPILER --> CORE
    COMPILER --> ORCH
    COMPILER --> AGENT
    COMPILER -.->|peer| SDK
    PLATFORM --> ENGINE
    PLATFORM --> SHARED
    ORCH --> ENGINE
    ORCH --> SHARED
    ORCH -.->|dev| AGENT
    AGENT --> ENGINE
    AGENT --> SDK
    AGENT --> SHARED
    AGENT --> CORE
    KICI["kici (wrapper)"]
    KICI --> COMPILER
    KICI --> CORE
    KICIADMIN["kici-admin (admin CLI)"]
    KICIADMIN --> ORCH
    KICIADMIN --> AGENT
```

**Leaf packages** (no `@kici` dependencies): `@kici-dev/core` and `@kici-dev/engine`. These can be tested and built independently. `@kici-dev/shared` builds on `@kici-dev/core` (which it re-exports) and on `@kici-dev/engine` for shared vocabularies. The dashboard depends on `@kici-dev/engine` for shared types (protocol schemas, execution status enums) and imports the Platform's API type definitions as a dev dependency, but communicates with backend services at runtime via HTTP/WebSocket, not at compile time.

**Runtime tiers** (Platform, orchestrator, agent) all depend on `@kici-dev/engine` for shared business logic and `@kici-dev/shared` for utilities. Only the agent depends on `@kici-dev/sdk` (it loads workflow definitions at runtime).

The `COMPILER → ORCH` and `COMPILER → AGENT` edges exist solely for the local dev plane: the compiler spawns a local orchestrator and agent so an author can execute a workflow end-to-end without any deployed infrastructure. Nothing in the compile path itself reaches into either tier.

## Connection overview

KiCI uses three WebSocket layers for real-time communication.

### Platform ↔ Orchestrator

The orchestrator connects outbound to the Platform WebSocket endpoint. After authentication (API key validated via SHA-256 hash lookup), the connection is used for webhook relay, execution telemetry (events, status, logs), source registration, and peer discovery. The Platform can also relay `job.reroute` messages between orchestrators that cannot reach each other directly.

### Orchestrator ↔ Orchestrator (P2P)

When multiple orchestrators are deployed, they establish direct WebSocket connections to each other on the `/ws/peer` endpoint. Peers are discovered via the Platform matchmaker (Platform/hybrid modes) or static configuration (`KICI_CLUSTER_PEERS` env var, independent mode). Connections are authenticated with a mutual pre-shared key (PSK). Traffic includes agent inventory heartbeats, job rerouting, progress reporting, cancel propagation, and Raft leader election. These messages never transit the Platform tier.

> See [Multi-Orchestrator Architecture](./clustering/multi-orchestrator.md) for clustering details and [Protocol Messages](protocol/dashboard.md#orchestrator---orchestrator-messages-peer-to-peer) for message schemas.

### Orchestrator ↔ Agent

The agent connects outbound to the orchestrator WebSocket endpoint. After registration (agent ID, labels, concurrency), the connection is used for job dispatch, status reporting, and log streaming.

> See [Protocol Messages](protocol-messages.md) and [Webhook Delivery](./webhooks/webhook-delivery.md) for detailed message flows and schemas.

## Authentication and multi-tenancy

KiCI uses application-level tenant isolation. The Platform dashboard API accepts three authentication methods (PATs, API keys, JWTs) and enforces org membership on every `/api/v1/orgs/:customerId/*` request.

## See also

- [Multi-Orchestrator Architecture](./clustering/multi-orchestrator.md) -- P2P clustering, Raft consensus, job rerouting
- [Execution status vocabulary](./execution/state-machine.md) -- run, job, and step status vocabularies and the tracker that owns lifecycle state
- [Protocol Messages](protocol-messages.md) -- WebSocket message schemas for all three layers
- [Webhook Delivery](./webhooks/webhook-delivery.md) -- end-to-end trace of a webhook through all three tiers
