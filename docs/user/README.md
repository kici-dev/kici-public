---
title: User guide
description: Writing and testing CI/CD workflows in TypeScript, running on infrastructure you control
---

KiCI runs your CI/CD on infrastructure you control -- your own orchestrator and agents clone the code and run every job, while the hosted platform relays webhooks and renders the dashboard without ever seeing your source or secrets. You author workflows in real, typed TypeScript and run them locally before you push, so the pipeline you test on your laptop is the pipeline that runs in production. This section is for the people writing those workflows.

## Start here

1. **[Green run in ~5 minutes](quickstart.md)** -- stand up an orchestrator and agent (Docker / Podman or bare metal) and watch your first workflow go green.
2. **[Getting started](getting-started.md)** -- install the SDK and compiler, write your first workflow, compile it to a lock file, and test it locally with simulated events.
3. **[Why KiCI](why-kici.md)** -- the case for running CI on your own infrastructure with typed TypeScript workflows.
4. **[GitHub App provider](providers/github.md)** -- connect your first source and route real pull-request and push events.

## What's in the user guide

- **Authoring** -- the [SDK reference](sdk-reference.md) covers every factory function, trigger, rule, and matrix option; [workflow patterns](workflow-patterns.md) show monorepo builds, conditional jobs, dynamic matrices, and scheduling; [how your workflow code executes](execution-model.md) maps compile, orchestrator, and agent time.
- **Running and testing** -- the [CLI reference](cli-reference.md) documents every command; the [testing guide](testing-guide.md) covers `kici run remote`, fixtures, and overlay mode; the [dashboard](dashboard.md) is the web UI for watching runs.
- **Wiring sources** -- the [GitHub App](providers/github.md) and [universal-git](providers/universal-git.md) providers connect your forge; [global workflows](global-workflows.md) run cross-repo.
- **Configuration and secrets** -- [contexts](contexts.md), [secrets](secrets.md), [dynamic values](dynamic-values.md), [concurrency groups](concurrency.md), [lifecycle hooks](hooks.md), and [environment variables](env-vars.md).

The left sidebar is the full index for the user guide -- every page in curated reading order.
