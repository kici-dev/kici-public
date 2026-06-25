---
title: SDK reference
description: Complete API reference for @kici-dev/sdk -- workflows, jobs, steps, triggers, rules, matrix, validation, runtime
---

Reference documentation for `@kici-dev/sdk`. The reference is split across five pages by topic.

| Page                                                         | Covers                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Core](./sdk/core.md)                                        | `workflow()`, `job()`, `step()` factory functions and step / job authoring patterns (bare functions, output chaining, `needs`, dynamic groups).                                                                             |
| [Triggers](./sdk/triggers.md)                                | All 22 trigger factories -- GitHub events (`pr`, `push`, `tag`, `comment`, ...), event triggers (`kiciEvent`, `workflowComplete`, `jobComplete`), `genericWebhook`, `schedule`, `lifecycle`, plus branch-pattern semantics. |
| [Rules, matrix, dynamic jobs](./sdk/rules-matrix-dynamic.md) | `rule()`, `skip()`, matrix builds (static + dynamic), and `dynamicJob()` / `dynamicGroup()`.                                                                                                                                |
| [Caching](./sdk/caching.md)                                  | `CacheSpec`, declarative `cache` on jobs/steps, imperative `ctx.cache.restore()` / `ctx.cache.save()`, immutable keys, `restoreKeys` prefix fallback, per-org + per-ref isolation.                                          |
| [Validation & events](./sdk/validation-events.md)            | `validateDag()`, `defineEvent()`, event emission patterns.                                                                                                                                                                  |
| [Runtime](./sdk/runtime.md)                                  | Types index, `StepContext`, secrets, and fixtures.                                                                                                                                                                          |
| [Idempotent helpers](./sdk/idempotent.md)                    | `idempotent()`, `idempotentStep()`, and the check-mode-aware `checkStep()` — check / apply pattern with typed results on both the skipped and applied branches.                                                             |
| [Wait-for helpers](./sdk/wait-for.md)                        | `waitFor()` and `waitForStep()` — poll a condition on an interval, run an optional success action, recover gracefully on timeout.                                                                                           |

The `@kici-dev/sdk` package re-exports the entire surface from a single entry point. Pick what you need:

```typescript
import { workflow, job, step, pr, push, rule, defineEvent } from '@kici-dev/sdk';
```

For the complete list of every named export (factory functions, triggers, rules, validation, hook factories, types), see the per-topic pages above.

## See also

- [Getting started](getting-started.md) -- install the SDK, write your first workflow, test locally
- [CLI reference](cli-reference.md) -- compile, test, and manage workflows from the command line
- [Workflow patterns](workflow-patterns.md) -- common patterns using the SDK features documented above
- [Secrets management (operator)](../operator/security/secrets.md) -- configure encrypted secret storage and admin API
- [Secrets architecture](../architecture/security/secrets.md) -- encryption model, multi-backend, and data flow
- [State machine](../architecture/execution/state-machine.md) -- how execution states map to the lifecycle of jobs and steps
