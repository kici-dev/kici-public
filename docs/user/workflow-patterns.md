---
title: Workflow patterns
description: 'Common patterns: monorepo builds, conditional jobs, dynamic matrices, generic webhooks, scheduling'
---

Practical patterns for building real-world KiCI workflows in TypeScript. The patterns are organised across seven pages -- start with [Basic CI](./patterns/basic.md) if you're new, or jump to [Integrations](./patterns/integrations.md) if you're wiring up a non-GitHub forge or a generic webhook.

| Page                                                       | Covers                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Basic CI](./patterns/basic.md)                            | Single-job CI, PR-only / push-only filters, multiple triggers on one workflow, manual-only workflows.                                              |
| [Conditionals & matrix](./patterns/conditionals-matrix.md) | Conditional execution with rules, matrix builds (static + dynamic), and dynamic job generation.                                                    |
| [Integrations](./patterns/integrations.md)                 | Workflow chaining, generic webhooks, Stripe handlers, self-hosted git forges (Forgejo / Gitea / Gogs), plain GitHub repo webhooks (no GitHub App). |
| [Scheduling & events](./patterns/scheduling-and-events.md) | Nightly cron, workflow-complete-triggered deploys, custom event chaining.                                                                          |
| [Git credentials](./patterns/git-credentials.md)           | Declaring named git credentials from the secrets backend, and pushing from a job (including to the job's own repository).                          |
| [Host restart](./patterns/host-restart.md)                 | `restartHost()` and `waitForHostAlive()` -- reboot the host a workflow runs on and resume in a second job pinned to the same host.                 |
| [Pattern reference](./patterns/reference.md)               | Step context, the examples repository, and GitHub check run output -- cross-cutting reference shared by every pattern above.                       |

## See also

- [Event system](events.md) -- event model concepts, registration model, circuit breaker
- [SDK reference](sdk-reference.md) -- complete API reference for all functions used in these patterns
- [CLI reference](cli-reference.md) -- how to compile and test these workflows locally
- [Getting started](getting-started.md) -- installation and first workflow setup
- [Job execution lifecycle](../architecture/execution/job-execution.md) -- how agents execute the jobs defined in these patterns
- [GitHub checks architecture](../architecture/webhooks/github-checks.md) -- deep dive into the check run system
