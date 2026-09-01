---
title: Event system
description: How KiCI's event model works -- event types, the registration model, event matching, and circuit breaker protection
---

KiCI supports two broad categories of workflow triggers: **git-based triggers** that work immediately, and **event-based triggers** that use a registration model. Understanding this distinction is key to working effectively with non-git triggers like schedules, custom events, and generic webhooks.

## Overview

Git-based triggers (`push()`, `pr()`, `tag()`, `comment()`, `review()`, `release()`, etc.) work immediately after you commit your lock file. When a GitHub webhook arrives, the orchestrator fetches your lock file and evaluates triggers on the spot -- no advance setup needed.

Event-based triggers work differently. The orchestrator needs to know about them _before_ the event arrives. This is because event-based triggers are matched against a pre-built registration index rather than being evaluated per-event from a lock file fetch. The six event-based trigger types are:

- `kiciEvent()` -- custom events emitted from workflow steps
- `workflowComplete()` -- fires when a workflow finishes
- `jobComplete()` -- fires when a specific job finishes
- `genericWebhook()` -- HTTP webhooks from external services
- `schedule()` -- cron-based time triggers
- `lifecycle()` -- orchestrator lifecycle events (workflow completion, job failure, registration updates)

All six require the **registration model** to function -- covered in detail below.

## Event types

### Custom events

Custom events are user-defined events emitted from workflow steps using `ctx.emit()`. Use `kiciEvent()` to listen for them.

```typescript
import { kiciEvent } from '@kici-dev/sdk';

// Listen for a custom event by name
kiciEvent({ name: 'deploy-complete' });

// With payload matching (JSONPath)
kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } });

// With negative filter
kiciEvent({ name: 'deploy-complete', not: { '$.env': 'staging' } });

// From a specific repository
kiciEvent({ name: 'deploy-complete', source: 'org/infra-repo' });
```

**Config options:** `name` (required), `match`, `not`, `source`, `description`.

### System events

The orchestrator automatically emits completion events when workflows and jobs finish. No manual emission needed -- these fire automatically.

**Workflow completion:**

```typescript
import { workflowComplete } from '@kici-dev/sdk';

// Any workflow completion
workflowComplete();

// Specific workflow by name
workflowComplete({ name: 'build' });

// Only successful completions
workflowComplete({ name: 'build', status: ['success'] });
```

**Config options:** `name`, `status` (`'success'`, `'failed'`, `'cancelled'`), `source`, `description`.

**Job completion:**

```typescript
import { jobComplete } from '@kici-dev/sdk';

// Any job completion
jobComplete();

// Specific workflow + job
jobComplete({ workflow: 'build', job: 'test' });

// Only failures
jobComplete({ workflow: 'build', job: 'test', status: ['failed'] });
```

**Config options:** `workflow`, `job`, `status` (`'success'`, `'failed'`, `'cancelled'`, `'skipped'`), `source`, `description`.

### External events

Generic webhooks let you trigger workflows from any HTTP service -- Stripe, ArgoCD, Slack, Grafana, or your own internal services.

```typescript
import { genericWebhook } from '@kici-dev/sdk';

// Match any event from a source
genericWebhook({ source: 'stripe' });

// Match specific event types
genericWebhook({ source: 'stripe', events: ['invoice.paid'] });

// With HMAC-SHA256 signature verification
genericWebhook({
  source: 'stripe',
  events: ['invoice.paid'],
  auth: {
    method: 'hmac-sha256',
    secret: 'stripe-signing-key',
    signatureHeader: 'stripe-signature',
  },
});

// With API key auth
genericWebhook({
  source: 'slack',
  auth: { method: 'api-key', secret: 'slack-token' },
});
```

**Config options:** `source` (required), `events`, `match`, `not`, `auth`, `path`, `description`.

The `source` field MUST match the `--name` that an operator passed to `kici-admin source add generic --name <name>` when the source was created — that string is the source's identifier in the orchestrator. Generic webhook sources must be created by an operator before events can be received; see [Operator guide: event routing](../operator/event-routing.md) for setup instructions.

### Schedule events

Cron-based triggers evaluated by the orchestrator on a periodic interval. Only the Raft leader evaluates schedules in a clustered deployment.

```typescript
import { schedule } from '@kici-dev/sdk';

// Run every hour
schedule({ cron: '0 * * * *' });

// Run daily at 2 AM UTC
schedule({ cron: '0 2 * * *' });

// Run weekly on Mondays at 9 AM Eastern
schedule({ cron: '0 9 * * 1', timezone: 'America/New_York' });
```

**Config options:** `cron` (required), `timezone` (defaults to `'UTC'`), `description`.

A cron-fired run records the commit sha of the registered lock file as its `sha`. Its `ref` is the repository's default branch, because that is the branch whose lock file the run executes. A [branch restriction](./contexts.md#branch-restrictions) matches that branch.

### Lifecycle events

Lifecycle triggers listen for orchestrator-level events related to workflow execution and system state changes.

```typescript
import { lifecycle } from '@kici-dev/sdk';

// Trigger when any workflow completes
lifecycle({ events: ['workflow_complete'] });

// Trigger on job failures from a specific repo
lifecycle({ events: ['job_failed'], sources: ['org/deploy-repo'] });

// Trigger when registrations are updated
lifecycle({ events: ['registration_updated'] });
```

**Available events:** `'workflow_complete'`, `'job_complete'`, `'job_failed'`, `'registration_updated'`.

**Config options:** `events` (required), `sources`, `description`.

## The registration model

This is the most important concept for understanding event-based triggers.

### Why registrations exist

When a GitHub webhook arrives (push, PR, etc.), the orchestrator fetches your lock file from the repository and evaluates triggers on the spot. This works because the event itself tells the orchestrator _which repository_ to look at.

Event-based triggers are different. When a cron timer fires or a custom event is emitted, there is no incoming webhook pointing to a specific repository. The orchestrator needs to know _in advance_ which workflows care about which events. That is what the registration model provides: a pre-built index of event-based workflows.

### How registration works

1. You define a workflow with an event-based trigger (e.g., `schedule()`, `kiciEvent()`, `genericWebhook()`)
2. You compile the workflow (`kici compile`), which produces a lock file
3. You push the lock file to your repository's **default branch** (e.g., `main` or `master`)
4. The orchestrator receives the push webhook, detects it targets the default branch, and extracts all workflows with event-based triggers from the lock file
5. Those workflows are stored in the orchestrator's registration database
6. From that point on, matching events will trigger those workflows

### Key implications

- **Event-based workflows do not trigger until you push to the default branch.** If you add a new `schedule()` workflow, it will not start running until you merge to your default branch. This is by design -- the orchestrator cannot match events to workflows it does not know about.

- **Registration is automatic.** There is no manual setup. Push your code, and the orchestrator handles the rest.

- **Registrations refresh on every default-branch push.** If you add, remove, or modify event-based workflows and push to the default branch, the orchestrator updates its registration index automatically. Removed workflows stop triggering. New workflows start triggering.

- **Git-based triggers are unaffected.** Triggers like `push()`, `pr()`, and `tag()` do not use registrations. They work immediately from any branch because the orchestrator evaluates them per-event from the lock file.

### Practical example

You create a nightly build workflow:

```typescript
import { workflow, job, step, schedule } from '@kici-dev/sdk';

export default workflow('nightly-build', {
  on: schedule({ cron: '0 2 * * *' }),
  jobs: [
    job('build', {
      runsOn: 'linux',
      steps: [
        step('build', async ({ $ }) => {
          await $`pnpm build`;
        }),
      ],
    }),
  ],
});
```

You compile it, commit the lock file, and push to a feature branch. **Nothing happens** -- the cron will not fire because the orchestrator has not registered this workflow yet.

You merge the feature branch into `main`. On the merge push, the orchestrator extracts the `nightly-build` workflow (it has a `ScheduleTrigger`) and registers it. Starting at the next 2 AM UTC, the workflow will trigger.

## How events are matched

When an event arrives, the orchestrator follows this flow:

1. **Event received** -- a custom event is emitted by a step, a cron timer fires, or a generic webhook arrives
2. **Registration lookup** -- the orchestrator queries its registration index for workflows matching the event type (e.g., all workflows with `ScheduleTrigger` for a cron fire, or all workflows with `KiciEventTrigger` for a custom event)
3. **Trigger evaluation** -- for each candidate workflow, the orchestrator evaluates the trigger conditions: event name patterns, payload matching, status filters, source filters
4. **Dispatch** -- matched workflows are dispatched to agents for execution, following the same job queue and agent routing as git-triggered workflows

This lookup is fast because the registration index is held in memory and refreshed only when the registry version changes (on default-branch pushes).

### What an event-triggered run resolves

An event-triggered run takes the same dispatch path as a webhook-triggered run. Four things follow from that.

**Bound contexts resolve in full.** The run reads each job's [contexts](./contexts.md): context variables, [scoped secrets](./secrets.md), and every protection rule the context carries. A job that calls `ctx.secrets.get()` must bind the context that holds the secret:

```typescript
job('provision', {
  runsOn: ['default'],
  context: 'hetzner-autoscale',
  run: async (ctx) => {
    const token = await ctx.secrets.get('HETZNER_API_TOKEN');
    // ...
  },
});
```

**Protection rules gate the run.** A branch restriction matches the branch the run presents, an approval gate holds it, and a [concurrency group](./concurrency.md) serializes it — exactly as for a push or a pull request. A `kiciEvent()` subscriber presents the branch of the run that emitted the event. A scaler event and a failure batch present none, so a branch restriction rejects those two: see [branch restrictions](./contexts.md#branch-restrictions). Nothing runs unattended past a gate the operator set. The [approval queue](dashboard/contexts-and-secrets.md#approval-queue) lists each held run, names the context that holds it, and gives the reason. `kici runs show <run-id>` prints the same holds for one run.

**A build job packs the source first.** The run dispatches a `__build__<workflow>` job to an agent labelled `kici:role:builder`, then runs its own jobs against the [cached source and dependency tarballs](../operator/dependency-caching.md). A fleet with no builder-role agent queues that job.

**The run carries a trust tier.** See [trust tiers on internal triggers](#trust-tiers-on-internal-triggers).

### Trust tiers on internal triggers

An internally-triggered run resolves its [trust tier](./contexts.md#minimum-trust) from the trigger. The tier decides the run's cache scope, whether it may run a [Dockerfile build](./container-jobs.md#who-may-build), whether it receives [install secrets](./private-registries.md), and whether a `minimumTrust` context holds it.

Four rules resolve the tier, and KiCI applies them in this order:

| Order | Trigger                                                                                         | Tier                                                        |
| ----- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1     | A run summoned by an [invoke gate](./global-workflows.md#invoking-a-source-repos-own-workflows) | the tier of the summoning run                               |
| 2     | `__schedule_fire`, `kici.scaler.scale-up`, `kici.scaler.scale-down`                             | trusted — no run causes these, the orchestrator mints them  |
| 3     | `__workflows_failed_batch`                                                                      | the most restrictive tier across the failed runs it carries |
| 4     | `__workflow_complete`, `__job_complete`, or a `kiciEvent()` subscriber                          | the tier of the run that emitted the event                  |

Rule 1 runs first on purpose. A workflow author writes the gate's event name, so a gate that named a minted event would otherwise claim rule 2's trusted tier.

Rule 2 lists the three names exactly. A prefix is not enough: the `__` and `kici.` prefixes are both reserved, but only a name on this list is one KiCI mints with no run behind it. Any other reserved name falls through to rule 4, which finds no emitting run and resolves no tier. So an [autoscaling workflow](./workflows/autoscaling-workflows.md) that subscribes to `kici.scaler.scale-up` or `kici.scaler.scale-down` runs trusted, and can build a Dockerfile job.

Rule 3 covers the failure batch, which one whole accumulation window of failed runs causes at once. A batch is only as trusted as its least trusted member, so a notifier fired by a window that included one untrusted failure runs at that failure's tier. A window holding more failed runs than the event carries truncates that list to a sample. The batch then resolves no tier at all: a minimum over a sample is not a minimum over the window.

Rule 4 covers the two lifecycle events a single run causes. A run completing does not raise the privilege of what its completion triggers. A `__workflow_complete` subscriber runs at the tier of the run that completed, exactly as a `kiciEvent()` subscriber runs at the tier of the run that emitted.

KiCI resolves no tier it cannot confirm. A missing emitting run, an unreadable tier, or a failed lookup resolves no tier at all, which isolates the run's caches.

An unresolved tier is not uniform across the controls it reaches. The differences are deliberate, and this table is the whole rule:

| Control                | Unresolved tier | A tier below `trusted` |
| ---------------------- | --------------- | ---------------------- |
| Cache scope            | isolated        | isolated               |
| Dockerfile build       | denied          | denied                 |
| Install secrets        | delivered       | stripped               |
| `minimumTrust` context | passes          | holds an `unknown` run |

The first two treat "no tier" as untrusted. The last two treat it as "no opinion", and pass. More than one kind of run carries no resolved tier, and each behaves this way. Among them: an internally-triggered run whose lookup fails, a pull request from a source other than a GitHub App, a cross-source delivery, and a `kici run` remote test run. Only a tier that RESOLVES below `trusted` strips install secrets, and only a tier that resolves `unknown` trips a `minimumTrust` gate.

A subscriber that inherits a tier below `trusted` loses its install secrets. A job that installs from a private registry then fails at install time.

A `minimumTrust` context holds an `unknown` subscriber for security review, whatever value the context declares. Trust is a ref-based judgement with two answers, so `minimumTrust: 'trusted'` and the deprecated `minimumTrust: 'known'` block the same thing. The declared value still decides the wording of the hold reason. A subscriber that inherited the legacy `known` tier from a run row written by an earlier build passes both.

Both symptoms appear far from their cause. The tier belongs to the **emitting** run, so read that run's tier first.

### Cross-source webhook delivery

The catch-all `webhook()` trigger (see [SDK reference: webhook()](sdk/triggers.md#webhook)) participates in this same registration lookup, but with one twist: it fires for matching events arriving via **any** inbound webhook source in the same org, not just the source the workflow's repo is bound to. The orchestrator maintains a `(customerId, eventName)` index over webhook trigger registrations and consults it on every inbound generic webhook.

The lookup is structurally org-isolated — a generic webhook delivered to org A can never reach a workflow registered against org B, because foreign-org rows live in a different bucket of the index. When a webhook fires across sources, the runtime clone token, repo URL, and check-status posting all come from the **registration's** source bundle, not the inbound source. The inbound source contributes only the event payload.

## Circuit breaker

Events can trigger workflows that emit more events, creating chains. The circuit breaker prevents runaway event storms.

### Chain depth limit

Each event carries a `chainDepth` counter. When a workflow triggered by an event emits a new event, the new event's chain depth increments. The orchestrator rejects events that exceed the maximum chain depth.

- **Default limit:** 10 levels deep
- **What happens when hit:** the emission is rejected with a `Circuit breaker tripped` error. The event is never persisted, so it is not queued for later delivery.

For example: Workflow A emits event X (depth 0) -> Workflow B triggers, emits event Y (depth 1) -> ... -> at depth 10, any further emitted events are dropped.

### Rate limiting

Emitted events are rate-limited using a sliding 60-second window, keyed per **(source routing key + event name)** — so one noisy event name in one repository cannot starve the same event name emitted from another.

- **Default limit:** 100 events per (source routing key + event name) per minute
- **What happens when hit:** the emission is rejected with a `Rate limit exceeded` error naming the retry-after delay.
- **System events are exempt:** orchestrator-emitted events (names prefixed `__` or `kici.`) cannot loop, so they bypass the limiter entirely.

Both defaults are configurable. Your operator can set them at startup with `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH` and `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` (or the equivalent `eventRouter.maxChainDepth` / `eventRouter.rateLimitPerWorkflowPerMinute` config fields). The rate limit is additionally a live fleet-wide [cluster setting](../operator/orchestrator/cluster-settings.md) — `kici-admin cluster-settings set --event-router-rate-limit-per-workflow-per-minute <n>` takes effect without a restart.

## Delivery guarantees

KiCI's event router delivers every accepted event with **at-least-once** semantics:

- An event that passes the circuit breaker (chain depth + rate limit) and commits
  to the `kici_events` table is guaranteed to dispatch to all matching workflows
  at least once.
- Each dispatch attempt acquires a short-lived lease (default 60 s) on the row.
  If the dispatching node crashes or the handler throws, the lease expires (or
  is released on failure) and the event is automatically retried.
- The retry policy is exponential backoff with full jitter: base 5 s, cap 5 min,
  up to 5 attempts before the event lands in the **DLQ** (dead-letter queue).
  Operators triage DLQ entries via `kici-admin event-dlq list / count / retry / discard`.

**What this means for workflow authors:**

- **Make event handlers idempotent.** A retried dispatch may run a handler more
  than once (e.g. if the first attempt threw after a partial side-effect).
  Workflows that mutate external state should use idempotency keys, conditional
  writes, or other deduplication patterns — same advice as for any distributed
  CI system.
- **Schedule fires are at-least-once too.** A cron schedule that fires while a
  leader is being killed will commit (atomically with `cron_last_fired`) or roll
  back together — never half. Recovery on the new leader does not backfill
  multiple missed instants; if your workflow needs at-least-N guarantees across
  outages, drive it from a different mechanism (e.g. a workflow that runs more
  frequently and emits its own custom event).
- **Drops are still possible — and visible.** Events rejected by the circuit
  breaker (chain depth or rate limit exceeded) are dropped and logged, not
  retried. That's a deliberate safety mechanism; the metric to watch is
  `kici_orch_events_dropped_total{reason}`.

## Emitting custom events

Custom events are emitted from workflow steps using `ctx.emit()`. You can optionally define typed event schemas using `defineEvent()`.

### Basic emission

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('build', {
  on: push({ branches: 'main' }),
  jobs: [
    job('build', {
      runsOn: 'linux',
      steps: [
        step('build', async ({ $ }) => {
          await $`pnpm build`;
        }),
        step('notify', async (ctx) => {
          await ctx.emit('build-complete', {
            version: '1.0.0',
            success: true,
          });
        }),
      ],
    }),
  ],
});
```

### Typed event definitions

Use `defineEvent()` with Zod schemas to create a typed contract for event payloads:

```typescript
import { defineEvent, z } from '@kici-dev/sdk';

export const deployComplete = defineEvent(
  'deploy-complete',
  z.object({
    env: z.string(),
    version: z.string(),
    services: z.array(z.string()),
  }),
);
```

Then emit using the definition — the payload is checked against the schema:

```typescript
step('emit', async (ctx) => {
  await ctx.emit(deployComplete, {
    env: 'prod',
    version: '1.2.3',
    services: ['api', 'web'],
  });
});
```

And consume in another workflow:

```typescript
import { workflow, job, step, kiciEvent } from '@kici-dev/sdk';

export default workflow('post-deploy', {
  on: kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } }),
  jobs: [
    job('smoke-test', {
      runsOn: 'linux',
      steps: [
        step('test', async ({ $ }) => {
          await $`./scripts/smoke-test.sh`;
        }),
      ],
    }),
  ],
});
```

Custom events are delivered immediately when emitted (mid-workflow, not queued until workflow completion). See the [SDK reference: emitting events](sdk/validation-events.md#emitting-events) section for the full `ctx.emit()` API.

### Reserved event names

Two name prefixes belong to the orchestrator, and `ctx.emit()` refuses both:

- `__` -- the orchestrator's own lifecycle and schedule events (`__schedule_fire`, `__workflow_complete`, `__job_complete`, `__workflows_failed_batch`).
- `kici.` -- KiCI internal system events.

A step that emits either name fails with `event name prefix "__" is reserved for KiCI internal events and cannot be emitted from a workflow step (got "__foo")`, naming the prefix that matched. A caller that reaches the orchestrator without the SDK gets the shorter `event name prefix "__" is reserved for KiCI internal events`, and no event is written. These events run at a higher trust level and skip the rate limiter, so a workflow must not be able to forge one. Prefix only -- a name that merely contains the text, such as `deploy__done`, is fine.

The same reservation covers an [invoke gate](global-workflows.md#invoking-a-source-repos-own-workflows). `invokeSource()` rejects a reserved name when you compile. A lock file that still carries one fails the gate job at dispatch, with status `failed` rather than skipped.

Subscribing is unaffected: `kiciEvent({ name })` may name a reserved event, and only emission is refused.

## See also

- [SDK reference: event triggers](sdk/triggers.md#event-triggers) -- complete API signatures for all trigger builders
- [SDK reference: emitting events](sdk/validation-events.md#emitting-events) -- `ctx.emit()` and `defineEvent()` API
- [Workflow patterns: workflow chaining](patterns/integrations.md#workflow-chaining) -- examples of event-driven workflow chains
- [Operator guide: event routing](../operator/event-routing.md) -- configuring generic webhook sources, trust relationships, and event routing
- [Architecture: event system](../architecture/webhooks/event-system.md) -- internal event routing design, registration model, cluster synchronization
