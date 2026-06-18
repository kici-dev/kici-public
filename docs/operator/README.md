---
title: Operator guide
description: Deploying and operating the KiCI orchestrator and agent
---

Documentation for teams deploying and operating the KiCI orchestrator and agent on their own infrastructure. These are the customer-deployed tiers of the three-tier architecture -- the orchestrator (Tier 2) handles trigger matching and job dispatch, while agents (Tier 3) clone repos and execute workflow steps.

## Quick reference

- [KiCI environment variable reference](env-reference.md) — auto-generated catalog of the env vars shared across the orchestrator, agent, and shared logger; per-service variables are documented in each service's configuration reference. Regenerated from each service's Zod schema by `pnpm docs:env`.

## Orchestrator

The customer-deployable orchestrator is the execution brain. It connects to the KiCI Platform relay via WebSocket, receives forwarded webhooks, fetches lock files, matches triggers, and dispatches jobs to agents. Ships as a Docker image with three operating modes: platform, hybrid, and independent.

- [Orchestrator](orchestrator/README.md) -- architecture overview and deployment planning
- [Deploying the KiCI orchestrator](orchestrator/getting-started.md) -- deployment guide for all three modes
- [Orchestrator setup guide](orchestrator/orchestrator-setup.md) -- setup wizard, migration, source config
- [Config management guide](orchestrator/config-management.md) -- shared config lifecycle, CLI, reload, rollback
- [Configuration reference](orchestrator/configuration.md) -- environment variables, database setup, mode-specific settings
- [kici-admin CLI reference](orchestrator/kici-admin-cli.md) -- authentication, RBAC, command reference
- [Coordinator/worker deployment](orchestrator/coordinator-worker.md) -- worker mode, P2P setup
- [Multi-orchestrator clustering](orchestrator/clustering.md) -- HA pair, cross-arch pool, dedicated coordinator recipes
- [Auto-scaler](orchestrator/auto-scaler.md) -- Docker, bare-metal, and Firecracker scaler backends, label matching, warm pools
- [Firecracker setup guide](orchestrator/firecracker-setup.md) -- Firecracker microVM host setup, YAML config, networking, rootfs, troubleshooting
- [Firecracker host setup](orchestrator/firecracker-host-setup.md) -- host prerequisites, capabilities, network setup, jailer, scaler config
- [Firecracker rootfs build guide](orchestrator/firecracker-rootfs.md) -- build script, kernel config, troubleshooting

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

## Operations

- [Event routing & generic webhooks](event-routing.md) -- generic sources, trust, event routing config
- [Source tarball and dependency caching](dependency-caching.md) -- S3/filesystem cache setup, build flow, cache keys
- [Cancel behavior](cancel-behavior.md) -- cancel config, grace periods, monitoring
- [Stale run detection and failure marking](stale-detection.md) -- detection system config, tuning, metrics
- [Environments](environments.md) -- DB tables, Vault config, held runs, monitoring, troubleshooting

## Security

- [Secrets management](./security/secrets.md) -- setup, admin API, RBAC, access rules, key rotation
- [Audit log and data access tracking](./security/audit-log.md) -- three tables, dashboard tabs, CLI queries, retention, support-read flow, troubleshooting
- [Agent execution security](./security/agent-security.md) -- sandbox config, isolation backends
- [CI security](./security/security.md) -- trust policies, identity linking, approvals
- [Peer credential management](./security/psk-rotation.md) -- peer creds, revocation, re-join

## Observability

- [Monitoring & tracing](./observability/monitoring.md) -- trace fields, Loki queries, health endpoints
- [Observability](./observability/observability.md) -- OTel setup, Prometheus metrics, dashboards

## Troubleshooting

Operator diagnostics for runtime failures that aren't covered elsewhere. Currently documents the SDK bundle drift diagnostic — a 3-way hash compare (agent / orchestrator / host-published SDK) that collapses the `Lock file is out of date` investigation from hours to a single log-grep.

- [Troubleshooting](troubleshooting.md) -- SDK bundle drift, hash diagnostic
