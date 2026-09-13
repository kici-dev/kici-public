---
title: Operator guide
description: Deploying and operating the KiCI orchestrator and agent
---

Documentation for teams deploying and operating the KiCI orchestrator and agent on their own infrastructure. These are the customer-deployed tiers of the three-tier architecture -- the orchestrator (Tier 2) handles trigger matching and job dispatch, while agents (Tier 3) clone repos and execute workflow steps.

## Quick reference

- [KiCI environment variable reference](env-reference.md) — auto-generated catalog of the env vars shared across the orchestrator, agent, and shared logger; per-service variables are documented in each service's configuration reference. Regenerated from each service's Zod schema by `pnpm docs:env`.

## Orchestrator

The customer-deployable orchestrator is the execution brain. It connects to the KiCI Platform relay via WebSocket, receives forwarded webhooks, fetches lock files, matches triggers, and dispatches jobs to agents. Ships as a Docker image with four operating modes: platform, hybrid, observed, and independent.

- [Orchestrator](orchestrator/README.md) -- architecture overview and deployment planning
- [Deploying the KiCI orchestrator](orchestrator/getting-started.md) -- deployment guide for all four modes
- [Orchestrator setup guide](orchestrator/orchestrator-setup.md) -- setup wizard, migration, source config
- [Config management guide](orchestrator/config-management.md) -- shared config lifecycle, CLI, reload, rollback
- [Configuration reference](orchestrator/configuration.md) -- environment variables, database setup, mode-specific settings
- [Cluster settings](orchestrator/cluster-settings.md) -- fleet-wide runtime tunables versus per-tenant org settings
- [Cluster name](orchestrator/cluster-name.md) -- how an orchestrator picks the identifier shown on Platform and in the dashboard
- [kici-admin CLI reference](orchestrator/kici-admin-cli.md) -- authentication, RBAC, command reference
- [Coordinator/worker deployment](orchestrator/coordinator-worker.md) -- worker mode, P2P setup
- [Multi-orchestrator clustering](orchestrator/clustering.md) -- HA pair, cross-arch pool, dedicated coordinator recipes
- [Host roster](orchestrator/host-roster.md) -- declared plus observed host inventory, derived status, `kici-admin host` commands
- [Auto-scaler](orchestrator/auto-scaler.md) -- Docker, bare-metal, and Firecracker scaler backends, label matching, warm pools
- [Object storage layout](orchestrator/storage-layout.md) -- bucket and prefix map for every subsystem the orchestrator writes to
- [Database backup and restore](orchestrator/db-backup-restore.md) -- back up and restore run history, dispatch queue, and encrypted secrets
- [Signing keys](orchestrator/signing-keys.md) -- provision, rotate, and back up the build-provenance signing key
- [Cluster identity recovery](orchestrator/cluster-identity-recovery.md) -- reconcile the database and the S3 sentinel after an identity mismatch
- [GitHub ingress](orchestrator/github-ingress.md) -- receive GitHub App webhooks directly, bypassing the Platform relay
- [Platform capabilities](orchestrator/platform-capabilities.md) -- what the hosted Platform provides, and what an independent orchestrator does without
- [Platform-down behavior](orchestrator/platform-down-behavior.md) -- what keeps working while the hosted Platform is offline
- [Local development plane](orchestrator/local-dev-plane.md) -- the warm per-user local orchestrator and database that `kici local` manages
- [Agent run-result API](orchestrator/agent-run-result-api.md) -- machine-first, provenance-tagged reads of run state and step logs
- [Firecracker host setup](orchestrator/firecracker/host-setup.md) -- Firecracker microVM host provisioning: packages, users, capabilities, kernel, networking, jailer, IP allocation, troubleshooting
- [Firecracker rootfs build guide](orchestrator/firecracker/rootfs.md) -- build script, kernel config, troubleshooting
- [Firecracker disk recovery](orchestrator/firecracker/disk-recovery.md) -- reclaim disk after leaked jailer chroots fill the host

## Agent

The customer-deployable agent is the execution tier. It connects to the orchestrator via WebSocket, receives job dispatches, clones repositories, and runs workflow steps. Ships as a Docker image with label-based job routing.

- [Getting started](agent/getting-started.md) -- deployment with Docker, Docker Compose, and Kubernetes
- [Configuration reference](agent/configuration.md) -- environment variables, labels, Docker executor setup

## Distribution

How KiCI packages are distributed and deployed. Covers all three distribution channels (npm packages, OCI container images, Firecracker rootfs), orchestrator deployment modes (container, systemd, launchd, Windows service), agent deployment formats, and agent runtime dependencies.

- [Distribution](./distribution/distribution.md) -- channels, deployment modes, runtime dependencies
- [Multi-architecture builds](./distribution/multi-arch-builds.md) -- build script, manifests, cross-arch deployment
- [Service installation guide](./distribution/service-installation.md) -- systemd, launchd, service management
- [KiCI packaging guide](./distribution/sea-binaries.md) -- package types, distribution
- [Release artifacts](./distribution/release-artifacts.md) -- manifest-list digests and npm integrity for the current release

## Operations

- [Event routing & generic webhooks](event-routing.md) -- generic sources, trust, event routing config
- [Source tarball and dependency caching](dependency-caching.md) -- S3/filesystem cache setup, build flow, cache keys
- [Cancel behavior](cancel-behavior.md) -- cancel config, grace periods, monitoring
- [Stale run detection and failure marking](stale-detection.md) -- detection system config, tuning, metrics
- [Contexts](contexts.md) -- DB tables, Vault config, held runs, monitoring, troubleshooting
- [Approvals](approvals.md) -- approvers, expiry, self-approval, and the dashboard approval queue
- [Fleet management](fleet-management.md) -- view and manage the declared host fleet from the dashboard
- [Upgrade and rollback](upgrade-and-rollback.md) -- upgrade order, version-skew behavior, migration semantics, rollback
- [Network requirements](network-requirements.md) -- outbound allowlist and inbound surface per deployment mode
- [Data residency](data-residency.md) -- what reaches the hosted Platform, what only transits it, what never leaves

## Security

- [Secrets management](./security/secrets.md) -- setup, admin API, RBAC, access rules, key rotation
- [Self-hosting security](./security/self-hosting-security.md) -- ephemeral sandboxes, fork-PR holds, egress blocking, environment-free secrets
- [Audit log and data access tracking](./security/audit-log.md) -- three tables, dashboard tabs, CLI queries, retention, support-read flow, troubleshooting
- [Agent execution security](./security/agent-security.md) -- sandbox config, isolation backends
- [CI security](./security/security.md) -- trust policies, identity linking, approvals
- [RBAC in two layers](./security/rbac-two-layers.md) -- how dashboard RBAC and orchestrator-CLI RBAC differ, and how to keep them in sync
- [Dashboard write policy](./security/dashboard-write-policy.md) -- per-operation policy for which writes stay on the dashboard and which become CLI-only
- [Encrypted dashboard writes](./security/encrypted-dashboard-writes.md) -- sealing a value in the browser so the hosted control plane never sees plaintext
- [Peer credential management](./security/psk-rotation.md) -- peer creds, revocation, re-join

## Observability

- [Monitoring & tracing](./observability/monitoring.md) -- trace fields, Loki queries, health endpoints
- [Observability](./observability/observability.md) -- OTel setup, Prometheus metrics, dashboards
- [Monitoring pack](./observability/monitoring-pack.md) -- importable starter dashboard and alert rules for a self-hosted orchestrator

## Troubleshooting

Operator diagnostics for runtime failures that aren't covered elsewhere. Currently documents the SDK bundle drift diagnostic — a 3-way hash compare (agent / orchestrator / host-published SDK) that collapses the `Lock file is out of date` investigation from hours to a single log-grep.

- [Troubleshooting](troubleshooting.md) -- SDK bundle drift, hash diagnostic

The left sidebar is the full index for the operator guide -- every page, including the per-backend auto-scaler pages and the per-area `kici-admin` command references.
