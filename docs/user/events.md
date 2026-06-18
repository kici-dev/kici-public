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

### Cross-source webhook delivery

The catch-all `webhook()` trigger (see [SDK reference: webhook()](sdk/triggers.md#webhook)) participates in this same registration lookup, but with one twist: it fires for matching events arriving via **any** inbound webhook source in the same org, not just the source the workflow's repo is bound to. The orchestrator maintains a `(customerId, eventName)` index over webhook trigger registrations and consults it on every inbound generic webhook.

The lookup is structurally org-isolated — a generic webhook delivered to org A can never reach a workflow registered against org B, because foreign-org rows live in a different bucket of the index. When a webhook fires across sources, the runtime clone token, repo URL, and check-status posting all come from the **registration's** source bundle, not the inbound source. The inbound source contributes only the event payload.

## Circuit breaker

Events can trigger workflows that emit more events, creating chains. The circuit breaker prevents runaway event storms.

### Chain depth limit

Each event carries a `chainDepth` counter. When a workflow triggered by an event emits a new event, the new event's chain depth increments. The orchestrator rejects events that exceed the maximum chain depth.

- **Default limit:** 10 levels deep
- **What happens when hit:** the event is dropped and logged. It is not queued for later delivery.

For example: Workflow A emits event X (depth 0) -> Workflow B triggers, emits event Y (depth 1) -> ... -> at depth 10, any further emitted events are dropped.

### Rate limiting

Each workflow is rate-limited on how many events it can process per minute, using a sliding window.

- **Default limit:** 100 events per workflow per minute
- **What happens when hit:** additional events for that workflow are dropped and logged until the window clears.

These defaults are hardcoded in the orchestrator and are not currently configurable via environment variables.

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

Then emit using the definition's name:

```typescript
step('emit', async (ctx) => {
  await ctx.emit(deployComplete.name, {
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

## See also

- [SDK reference: event triggers](sdk/triggers.md#event-triggers) -- complete API signatures for all trigger builders
- [SDK reference: emitting events](sdk/validation-events.md#emitting-events) -- `ctx.emit()` and `defineEvent()` API
- [Workflow patterns: workflow chaining](patterns/integrations.md#workflow-chaining) -- examples of event-driven workflow chains
- [Operator guide: event routing](../operator/event-routing.md) -- configuring generic webhook sources, trust relationships, and event routing
- [Architecture: event system](../architecture/webhooks/event-system.md) -- internal event routing design, registration model, cluster synchronization
