KiCI is a TypeScript-native CI/CD workflow engine. Define workflows in TypeScript instead of YAML, gaining full language power -- type safety, autocompletion, loops, conditionals, and async/await -- for your build pipelines.

## For users

Workflow authors writing CI/CD in TypeScript.

| Document                                                    | Description                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](user/getting-started.md)                  | Install the SDK, write your first workflow, compile and test locally                                                                               |
| [SDK reference](user/sdk-reference.md)                      | Complete API reference for workflows, jobs, steps, triggers, rules, and matrix                                                                     |
| [Event system](user/events.md)                              | Event model concepts: event types, registration model, circuit breaker                                                                             |
| [CLI reference](user/cli-reference.md)                      | All CLI commands: compile, run (local/remote), test, login, logout, org, status, cancel, secrets, types, fixture, init, hook, endpoints, workflows |
| [Workflow patterns](user/workflow-patterns.md)              | Common patterns: monorepo builds, conditional jobs, dynamic matrices, event-driven workflows                                                       |
| [Dashboard](user/dashboard.md)                              | Web UI: run list, run detail, log viewer, settings, keyboard shortcuts                                                                             |
| [CLI authentication](user/cli-auth.md)                      | Browser OAuth, device flow, API key paste, org management, PATs                                                                                    |
| [Lock file and workflow drift](user/lock-file-and-drift.md) | Why the lock file must stay in sync, pre-commit and CI drift detection                                                                             |
| [Testing guide](user/testing-guide.md)                      | Remote test execution with `kici run remote`, fixture-based testing, overlay mode                                                                  |
| [Environments](user/environments.md)                        | Deployment environments with variables, scoped secrets, and protection rules                                                                       |
| [Environment variables](user/env-vars.md)                   | All `KICI_*` environment variables for the CLI                                                                                                     |
| [Lifecycle hooks](user/hooks.md)                            | Cancel, cleanup, success, failure, and step-level hook callbacks                                                                                   |
| [Concurrency groups](user/concurrency.md)                   | Control parallel execution with auto-cancel and queue modes                                                                                        |
| [Dynamic values](user/dynamic-values.md)                    | Compute environment, env, and concurrency group at runtime from event payload                                                                      |
| [Secrets](user/secrets.md)                                  | Access encrypted secrets in workflow steps via the explicit secrets API                                                                            |
| [GitHub App provider](user/providers/github.md)             | Create and register a GitHub App source, rotate secrets, manage Check runs, route events                                                           |
| [Universal-git provider](user/providers/universal-git.md)   | Connect Forgejo / Gitea / Gogs / GitLab / plain-GitHub via webhook and PAT or SSH deploy key                                                       |
| [Global workflows](user/global-workflows.md)                | Cross-repo workflows that run on events from any repo in the same org                                                                              |
| [Private npm registries](user/private-registries.md)        | Authenticate `npm install` against CodeArtifact, GitHub Packages, Verdaccio, and other private registries from `.kici/package.json`                |

## For operators

Teams deploying the orchestrator and agent in their own infrastructure.

| Document                                                                     | Description                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Orchestrator overview](operator/orchestrator/README.md)                     | Architecture overview and deployment planning                                    |
| [Orchestrator getting started](operator/orchestrator/getting-started.md)     | Deploy the orchestrator with Docker or standalone Node.js                        |
| [Orchestrator configuration](operator/orchestrator/configuration.md)         | YAML config, env var overrides, shared DB config, multi-provider setup           |
| [Config management](operator/orchestrator/config-management.md)              | Shared config lifecycle: seed, CLI, reload, rollback                             |
| [Auto-scaler configuration](operator/orchestrator/auto-scaler.md)            | Docker, bare-metal, and Firecracker scaler backends, label matching, warm pools  |
| [Firecracker setup guide](operator/orchestrator/firecracker-setup.md)        | Firecracker microVM host setup, YAML config, networking, rootfs, troubleshooting |
| [Distribution](./operator/distribution/distribution.md)                      | Distribution channels, deployment modes, runtime dependencies                    |
| [Firecracker rootfs](./operator/orchestrator/firecracker-rootfs.md)          | Build the agent root filesystem image for Firecracker microVM                    |
| [Firecracker host setup](./operator/orchestrator/firecracker-host-setup.md)  | Host prerequisites, capabilities, network setup, jailer, scaler config           |
| [kici-admin CLI reference](operator/orchestrator/kici-admin-cli.md)          | Authentication, RBAC, and complete command reference                             |
| [Agent getting started](operator/agent/getting-started.md)                   | Deploy KiCI agents for job execution                                             |
| [Agent configuration](operator/agent/configuration.md)                       | Environment variables, labels, Docker executor setup                             |
| [Dependency caching](operator/dependency-caching.md)                         | Configure S3/filesystem cache for workflow npm dependencies                      |
| [Stale detection](operator/stale-detection.md)                               | Stale run detection configuration, tuning, and metrics                           |
| [Secrets management](./operator/security/secrets.md)                         | Configure encrypted secrets, admin API, RBAC, key rotation                       |
| [Event routing](operator/event-routing.md)                                   | Internal events, generic webhooks, trust, workflow registrations                 |
| [Multi-architecture builds](./operator/distribution/multi-arch-builds.md)    | Build images for x64 and ARM64, manifests, cross-arch deploy                     |
| [Multi-orchestrator clustering](operator/orchestrator/clustering.md)         | HA pair, cross-arch pool, coordinator topologies                                 |
| [Environments](operator/environments.md)                                     | Deployment environments, secrets integration, protection rules                   |
| [Cancel behavior](operator/cancel-behavior.md)                               | Grace period, hook timeout, force cancel, monitoring                             |
| [Agent execution security](./operator/security/agent-security.md)            | Sandbox backends, isolation model, environment sanitization                      |
| [CI security](./operator/security/security.md)                               | Trust policies, identity linking, approval workflows                             |
| [Coordinator/worker deployment](operator/orchestrator/coordinator-worker.md) | Lightweight edge workers without PostgreSQL or S3                                |
| [Service installation](./operator/distribution/service-installation.md)      | Install as systemd/launchd native services                                       |
| [Observability](./operator/observability/observability.md)                   | OpenTelemetry setup, Prometheus metrics, dashboards                              |
| [Monitoring & tracing](./operator/observability/monitoring.md)               | Distributed tracing, ELK queries, health endpoints                               |
| [Orchestrator setup](operator/orchestrator/orchestrator-setup.md)            | Interactive wizard, database migration, source configuration                     |
| [Peer credential management](./operator/security/psk-rotation.md)            | Peer credentials for cluster auth, revocation, re-join                           |
| [Packaging guide](./operator/distribution/sea-binaries.md)                   | Building and distributing KiCI packages for deployment                           |

## Architecture

Deep-dive into KiCI internals.

Architecture documentation covers the three-tier model, state machine, protocol messages, data flows, and design decisions.

See [Architecture overview](architecture/overview.md) for the starting point, [Configuration architecture](architecture/configuration.md) for the config resolution chain and hot-reload design, [Secrets architecture](./architecture/security/secrets.md) for the encryption model and multi-backend design, [Stale detection architecture](./architecture/execution/stale-detection.md) for the two-tier stale detection system, and [Event system internals](./architecture/webhooks/event-system.md) for the event routing architecture, registration model, and cron scheduler design.
