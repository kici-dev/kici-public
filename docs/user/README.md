---
title: User guide
description: Writing and testing CI/CD workflows in TypeScript
---

Documentation for workflow authors -- people writing CI/CD pipelines in TypeScript using the KiCI SDK and compiler. If you are defining workflows, running local tests, or learning the SDK API, start here.

## Pages

### [Getting started with KiCI](getting-started.md)

Install the SDK and compiler, write your first workflow, compile it to a lock file, and test it locally with simulated events. Covers prerequisites (Node.js 24+, pnpm), the `kici init` command for scaffolding, and the relationship between workflows, the lock file, and the three-tier runtime.

### [SDK reference](sdk-reference.md)

Complete API reference for `@kici-dev/sdk`. Covers all factory functions (`workflow()`, `job()`, `step()`), trigger builders (`pr()`, `push()`), rule functions (`rule()`, `skip()`), matrix configuration (static arrays, static objects, dynamic functions, include/exclude), and the `StepContext` interface that steps receive at runtime.

### [Lock file and workflow drift](lock-file-and-drift.md)

Why the lock file must stay in sync with workflow source, how to commit both together, using pre-commit and CI to catch drift early, and the agent-side hash verification when compiling from source.

### [CLI reference](cli-reference.md)

All CLI commands provided by `@kici-dev/compiler`: `kici compile` (with watch mode and check mode), `kici run` (local and remote execution), `kici preview` (event simulation with dry-run, filtering, debug output, and custom payloads), `kici login`/`logout`/`org` (authentication and org management), `kici diagnostics` (infrastructure tree) and `kici runs` (`list`/`show`/`logs`/`rerun`/`cancel` — run management), `kici secrets` (secret listing), `kici types` (type generation), `kici fixture` (generate test payloads), `kici init` (interactive project scaffolding), `kici hook` (pre-commit hook installation), `kici endpoints` (webhook entrypoints), and `kici workflows` (workflow listing). Includes environment variables and exit codes.

### [Workflow patterns](workflow-patterns.md)

Common patterns for building real-world CI/CD workflows. Includes examples for basic CI pipelines with job dependencies, monorepo path-based triggering, conditional jobs with rules, matrix builds across Node versions, dynamic jobs generated at runtime, Docker-based step execution, and parallel test splitting.

### [Dashboard](dashboard.md)

Guide to the KiCI web dashboard. Covers navigation (sidebar, org switcher, mobile bottom tabs), run list (table columns, filters, pagination, empty states), run detail (resizable two-panel layout, job tree, step selection, metadata tabs), log viewer (ANSI color rendering, search, permalink, copy), settings page (tabbed layout), theme toggle, keyboard shortcuts, and error pages.

### [Testing guide](testing-guide.md)

How to run and write tests for KiCI workflows, including remote test execution with `kici run remote`, fixture-based testing, and overlay mode for uncommitted changes.

### [Environments](environments.md)

Configure deployment environments (staging, production, review/\*) with variables, scoped secrets, and protection rules. Covers the SDK API (`environment`, `env`, `concurrencyGroup` on jobs), the 8-layer variable merge precedence, protection rules (branch restrictions, required reviewers, wait timers, concurrency), dashboard management, type generation, and migration from the legacy contexts system.

### [Environment variables](env-vars.md)

Reference for all `KICI_*` environment variables supported by the CLI. Covers authentication overrides (OIDC issuer, client ID, project ID), browser behavior (custom browser command, fixed callback port), development mode, and usage examples for CI/CD, self-hosted, and headless environments.

### [CLI authentication](cli-auth.md)

Authenticate the KiCI CLI with browser-based OAuth (default), device authorization flow (for headless environments), or API key paste (for CI/CD pipelines). Covers org management and PATs.

### [Event system](events.md)

Event model concepts: event types, the registration model, event matching, and circuit breaker protection. Understanding this distinction is key to working with non-git triggers like schedules, custom events, and generic webhooks.

### [Lifecycle hooks](hooks.md)

SDK hook API for cancel, cleanup, success, failure, and step-level callbacks. Hooks run at specific points in the execution lifecycle to react to outcomes and perform cleanup.

### [Concurrency groups](concurrency.md)

Control parallel execution with auto-cancel and queue modes. Prevent multiple workflow runs from executing in parallel when they target the same resource.

### [Dynamic values](dynamic-values.md)

Compute `environment`, `env`, and `concurrencyGroup` at runtime based on the incoming event payload. Instead of hardcoding static strings, pass a function that receives the webhook event and returns the resolved value.

### [Secrets](secrets.md)

Access encrypted secrets in workflow steps via the explicit secrets API. Secrets are never auto-injected into `process.env` -- you must explicitly request each secret by name.

### [GitHub App provider](providers/github.md)

The flagship source. Covers creating the GitHub App on GitHub's side (permissions, webhook URL, private key), registering it with the orchestrator via `kici-admin source add github`, routing keys (`github:<appId>`), global-workflow policy, enriched Check runs on pull requests, private-key and webhook-secret rotation, and troubleshooting.

### [Universal-git provider](providers/universal-git.md)

Connect a non-GitHub-App forge (Forgejo, Gitea, Gogs, GitLab, plain GitHub) to KiCI via its webhook. Covers preset selection, PAT and SSH credential wiring, credential rotation, global workflow policy against `generic:<orgId>:<sourceId>` routing keys, and troubleshooting.

### [Global workflows](global-workflows.md)

Cross-repo workflows that let a single workflow repo define jobs which run on events from many source repos in the same org. Covers the mental model (workflow repo vs. source repo, authoring axis vs. source axis), SDK syntax for declaring globals via `repos:` patterns, the dashboard opt-in flow and per-setting semantics (master toggle, author allow-list, source deny-list, elevated-access list), the security model, and troubleshooting skipped dispatches.
