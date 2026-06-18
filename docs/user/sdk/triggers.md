---
title: 'SDK reference: triggers'
description: GitHub event triggers, kiciEvent, workflowComplete, jobComplete, genericWebhook, schedule, lifecycle
---

## Triggers

Triggers define when a workflow runs. KiCI provides 22 trigger types: 16 GitHub webhook triggers and 6 internal/generic triggers for event routing, scheduling, and non-GitHub sources. Each trigger returns a frozen config object with a unique `_tag` discriminator.

All triggers use a config object form -- pass an options object to configure the trigger.

### pr()

Create a pull request trigger. Returns a frozen `PrTriggerConfig` directly.

```typescript
function pr(config?: PrConfigInput): PrTriggerConfig;
```

**Config options:**

```typescript
interface PrConfigInput {
  events?: PrEvent[];
  target?: string | RegExp | (string | RegExp)[];
  source?: string | RegExp | (string | RegExp)[];
  paths?: string[]; // Use '!' prefix for exclusions (e.g., '!docs/**')
  repos?: string | RegExp | (string | RegExp)[]; // Cross-repo source patterns -- see global-workflows.md
  description?: string;
}
```

**PrEvent values:** `'opened'`, `'synchronize'`, `'reopened'`, `'closed'`, `'assigned'`, `'unassigned'`, `'labeled'`, `'unlabeled'`, `'edited'`, `'converted_to_draft'`, `'ready_for_review'`, `'locked'`, `'unlocked'`, `'review_requested'`, `'review_request_removed'`, `'auto_merge_enabled'`, `'auto_merge_disabled'`

**Default events** (when `events` is not specified): `opened`, `synchronize`, `reopened`, `closed`

**Examples:**

```typescript
// All PRs with default events
pr();

// PRs targeting main with path filter
pr({ target: 'main', events: ['opened', 'synchronize'], paths: ['src/**'] });

// Regex branch pattern
pr({ target: /^release\/v\d+$/ });
```

### push()

Create a push trigger. Returns a frozen `PushTriggerConfig` directly.

```typescript
function push(config?: PushConfigInput): PushTriggerConfig;
```

**Config options:**

```typescript
interface PushConfigInput {
  branches?: string | RegExp | (string | RegExp)[];
  tags?: string | RegExp | (string | RegExp)[];
  paths?: string[]; // Use '!' prefix for exclusions (e.g., '!docs/**')
  repos?: string | RegExp | (string | RegExp)[]; // Cross-repo source patterns -- see global-workflows.md
  description?: string;
}
```

**Examples:**

```typescript
// Any push
push();

// Push to main only
push({ branches: 'main' });

// Push with branch and path filters
push({ branches: ['main', 'develop'], paths: ['src/**'] });

// Tag pushes
push({ tags: ['v*'] });
```

### tag()

Create a tag trigger. Returns a frozen `TagTriggerConfig`.

```typescript
function tag(config?: TagConfigInput): TagTriggerConfig;
```

**Config options:** `patterns` (string/RegExp/array), `description`

```typescript
tag(); // Any tag
tag({ patterns: ['v*'] }); // Semver tags
tag({ patterns: /^v\d+\.\d+$/ }); // Regex match
```

### comment()

Create an issue/PR comment trigger. Returns a frozen `CommentTriggerConfig`.

```typescript
function comment(config?: CommentConfigInput): CommentTriggerConfig;
```

**Config options:** `actions` (created/edited/deleted), `source` (issue/pr), `bodyMatch` (string or RegExp), `description`

```typescript
comment(); // Any comment
comment({ bodyMatch: '/deploy' }); // Glob match on body
comment({ bodyMatch: /^\/deploy/i }); // Regex match on body
comment({ source: 'pr', actions: ['created'] }); // PR comments only
```

### review()

Create a pull request review trigger. Returns a frozen `ReviewTriggerConfig`.

```typescript
function review(config?: ReviewConfigInput): ReviewTriggerConfig;
```

**Config options:** `actions` (submitted/edited/dismissed), `states` (approved/changes_requested/commented/dismissed), `description`

```typescript
review(); // Any review
review({ states: ['approved'] }); // Approvals only
review({ actions: ['submitted'], states: ['approved'] }); // Submitted approvals
```

### reviewComment()

Create a PR review comment trigger. Returns a frozen `ReviewCommentTriggerConfig`.

```typescript
function reviewComment(config?: ReviewCommentConfigInput): ReviewCommentTriggerConfig;
```

**Config options:** `actions` (created/edited/deleted), `description`

```typescript
reviewComment(); // Any review comment
reviewComment({ actions: ['created'] }); // New review comments only
```

### release()

Create a release trigger. Returns a frozen `ReleaseTriggerConfig`.

```typescript
function release(config?: ReleaseConfigInput): ReleaseTriggerConfig;
```

**Config options:** `actions` (published/unpublished/created/edited/deleted/prereleased/released), `description`

```typescript
release(); // Any release event
release({ actions: ['published'] }); // Published releases only
```

### dispatch()

Create a repository_dispatch trigger. Returns a frozen `DispatchTriggerConfig`.

```typescript
function dispatch(config?: DispatchConfigInput): DispatchTriggerConfig;
```

**Config options:** `types` (string[]), `description`

```typescript
dispatch(); // Any dispatch
dispatch({ types: ['deploy', 'rollback'] }); // Specific event types
```

### create()

Create a ref creation trigger (branches/tags). Returns a frozen `CreateTriggerConfig`.

```typescript
function create(config?: CreateConfigInput): CreateTriggerConfig;
```

**Config options:** `refTypes` (branch/tag), `patterns` (string/RegExp/array), `description`

```typescript
create(); // Any ref creation
create({ refTypes: ['tag'], patterns: ['v*'] }); // Tag creation only
```

### delete()

Create a ref deletion trigger (branches/tags). Returns a frozen `DeleteTriggerConfig`.

Note: Since `delete` is a JavaScript reserved word, import as `del`: `import { delete as del } from '@kici-dev/sdk'`

```typescript
function del(config?: DeleteConfigInput): DeleteTriggerConfig;
```

**Config options:** `refTypes` (branch/tag), `patterns` (string/RegExp/array), `description`

```typescript
del(); // Any ref deletion
del({ refTypes: ['branch'], patterns: ['temp/*'] }); // Temp branch cleanup
```

### status()

Create a commit status trigger. Returns a frozen `StatusTriggerConfig`.

```typescript
function status(config?: StatusConfigInput): StatusTriggerConfig;
```

**Config options:** `contexts` (picomatch strings like 'ci/\*'), `states` (error/failure/pending/success), `description`

```typescript
status(); // Any status
status({ contexts: ['ci/*'], states: ['success'] }); // CI success
```

### workflowRun()

Create a workflow_run trigger. Returns a frozen `WorkflowRunTriggerConfig`.

```typescript
function workflowRun(config?: WorkflowRunConfigInput): WorkflowRunTriggerConfig;
```

**Config options:** `actions` (requested/completed/in_progress), `workflows` (name filters), `conclusions` (success/failure/cancelled), `description`

```typescript
workflowRun(); // Any workflow run
workflowRun({ workflows: ['CI'], actions: ['completed'], conclusions: ['success'] });
```

### fork()

Create a fork trigger. No filter fields. Returns a frozen `ForkTriggerConfig`.

```typescript
function fork(config?: ForkConfigInput): ForkTriggerConfig;
```

```typescript
fork(); // Any fork event
fork({ description: 'Track forks' }); // With description
```

### star()

Create a star trigger. Returns a frozen `StarTriggerConfig`.

```typescript
function star(config?: StarConfigInput): StarTriggerConfig;
```

**Config options:** `actions` (created/deleted), `description`

```typescript
star(); // Any star event
star({ actions: ['created'] }); // New stars only
```

### watch()

Create a watch trigger. Returns a frozen `WatchTriggerConfig`.

```typescript
function watch(config?: WatchConfigInput): WatchTriggerConfig;
```

**Config options:** `actions` (started), `description`

```typescript
watch(); // Any watch event
watch({ actions: ['started'] }); // Watch started only
```

### webhook()

Create a catch-all webhook trigger for any GitHub event. Returns a frozen `WebhookTriggerConfig`. Unlike other triggers, `events` is **required** -- catch-all must specify what to catch.

```typescript
function webhook(config: WebhookConfigInput): WebhookTriggerConfig;
```

**Config options:** `events` (required string[]), `actions` (optional string[]), `repos` (optional cross-repo source patterns -- see [global workflows](../global-workflows.md)), `description`

```typescript
webhook({ events: ['deployment'] }); // Deployment events
webhook({ events: ['deployment', 'deployment_status'] }); // Multiple events
webhook({ events: ['deployment'], actions: ['created'] }); // With action filter
```

#### Cross-source delivery

A `webhook()` trigger fires whenever a matching event arrives via **any inbound webhook source within the same org**, not just the source the workflow's repository is bound to. If your repo is registered through a github source and a separate generic source in the same org POSTs an event with a matching name, the workflow still runs.

Two important rules govern the cross-source path:

1. **The registration's source owns dispatch credentials.** The runtime clone, auth, and check-status posting come from the source the workflow was registered with (via its default-branch push), never from the inbound source. A generic webhook fanning out to a github-registered workflow uses the github bundle's clone token provider — the generic source contributes only the event payload.
2. **Org isolation is structural.** A webhook delivered to org A can never trigger a workflow registered against org B. The lookup index is keyed on `(customerId, eventName)` so cross-org leakage is impossible.

The orchestrator emits `kici_cross_source_fanout_size` (histogram) per inbound webhook so operators can observe how many workflows each event reaches.

### Event triggers

The following 6 trigger types support internal event routing, scheduling, lifecycle orchestration, and non-GitHub webhook sources.

### kiciEvent()

Create a custom event trigger. Fires when a named internal event is emitted from a workflow step via `ctx.emit()`. Returns a frozen `KiciEventTriggerConfig`.

```typescript
function kiciEvent(config: KiciEventConfigInput): KiciEventTriggerConfig;
```

**Config options:**

```typescript
interface KiciEventConfigInput {
  name: string; // Required: event name to listen for
  match?: Record<string, unknown>; // JSONPath payload matching (e.g., { '$.env': 'prod' })
  not?: Record<string, unknown>; // Negative JSONPath filter
  source?: string; // Cross-repo source filter (e.g., 'org/infra-repo')
  description?: string;
}
```

```typescript
kiciEvent({ name: 'deploy-complete' }); // Match by name
kiciEvent({ name: 'deploy-complete', match: { '$.env': 'prod' } }); // With payload filter
kiciEvent({ name: 'deploy-complete', not: { '$.env': 'staging' } }); // Negative filter
kiciEvent({ name: 'deploy-complete', source: 'org/infra-repo' }); // Cross-repo
```

### workflowComplete()

Create a workflow completion trigger. Fires automatically when another workflow finishes execution. Returns a frozen `WorkflowCompleteTriggerConfig`.

```typescript
function workflowComplete(config?: WorkflowCompleteConfigInput): WorkflowCompleteTriggerConfig;
```

**Config options:**

```typescript
interface WorkflowCompleteConfigInput {
  name?: string; // Filter by workflow name
  status?: WorkflowCompleteStatus[]; // Filter by completion status
  source?: string; // Cross-repo source filter
  description?: string;
}
type WorkflowCompleteStatus = 'success' | 'failed' | 'cancelled';
```

```typescript
workflowComplete(); // Any workflow completion
workflowComplete({ name: 'CI' }); // Specific workflow
workflowComplete({ name: 'CI', status: ['success'] }); // Success only
workflowComplete({ name: 'CI', status: ['success'], source: 'org/repo' }); // Cross-repo
```

### jobComplete()

Create a job completion trigger. Fires automatically when a specific job within a workflow finishes. Returns a frozen `JobCompleteTriggerConfig`.

```typescript
function jobComplete(config?: JobCompleteConfigInput): JobCompleteTriggerConfig;
```

**Config options:**

```typescript
interface JobCompleteConfigInput {
  workflow?: string; // Filter by workflow name
  job?: string; // Filter by job name
  status?: JobCompleteStatus[]; // Filter by completion status
  source?: string; // Cross-repo source filter
  description?: string;
}
type JobCompleteStatus = 'success' | 'failed' | 'cancelled' | 'skipped';
```

```typescript
jobComplete(); // Any job completion
jobComplete({ workflow: 'CI', job: 'build' }); // Specific workflow + job
jobComplete({ workflow: 'CI', job: 'build', status: ['success'] }); // Success only
jobComplete({ workflow: 'CI', job: 'build', source: 'org/repo' }); // Cross-repo
```

`jobComplete()` starts a **new** workflow run that reacts to another job finishing (gated on the prior job's status). For same-run fan-out — generating follow-up jobs from a prior job's _outputs_ within the same run — use a result-aware [`dynamicJob(group, { needs, generate })`](./rules-matrix-dynamic.md#dynamicjob--result-aware-generation) instead.

### genericWebhook()

Create a generic webhook trigger. Fires when a non-GitHub webhook is received from an external source configured via the admin API. Returns a frozen `GenericWebhookTriggerConfig`.

```typescript
function genericWebhook(config: GenericWebhookConfigInput): GenericWebhookTriggerConfig;
```

**Config options:**

```typescript
interface GenericWebhookConfigInput {
  source: string; // Required: must match `--name` from `kici-admin source add generic`
  events?: string[]; // Filter by event types
  match?: Record<string, unknown>; // JSONPath payload matching
  not?: Record<string, unknown>; // Negative JSONPath filter
  auth?: GenericWebhookAuth; // HMAC or API key authentication
  path?: string; // URL path pattern (replaces source for URL matching)
  description?: string;
}
```

```typescript
genericWebhook({ source: 'argocd' }); // Any event from ArgoCD
genericWebhook({ source: 'argocd', events: ['deploy.success'] }); // Specific events
genericWebhook({ source: 'argocd', match: { '$.env': 'prod' } }); // With payload filter
genericWebhook({ source: 'argocd', not: { '$.dry_run': true } }); // Negative filter
genericWebhook({
  source: 'stripe',
  auth: { method: 'hmac-sha256', secret: 'stripe-key', signatureHeader: 'stripe-signature' },
}); // HMAC auth
genericWebhook({ source: 'slack', auth: { method: 'api-key', secret: 'slack-token' } }); // API key auth
genericWebhook({ source: 'stripe', path: 'stripe/payments' }); // URL path pattern
```

### schedule()

Create a cron-based schedule trigger. Returns a frozen `ScheduleTriggerConfig`.

```typescript
function schedule(config: ScheduleConfigInput): ScheduleTriggerConfig;
```

**Config options:**

```typescript
interface ScheduleConfigInput {
  cron: string; // Required: cron expression (5-field)
  timezone?: string; // Timezone for cron evaluation (default: 'UTC')
  description?: string; // Human-readable description of the schedule
}
```

```typescript
schedule({ cron: '0 * * * *' }); // Every hour
schedule({ cron: '0 0 * * *' }); // Daily at midnight UTC
schedule({ cron: '0 9 * * 1', timezone: 'America/New_York' }); // Monday 9am ET
schedule({ cron: '*/15 * * * *', description: 'health check every 15 min' });
```

### lifecycle()

Create a lifecycle trigger for cross-workflow orchestration events. Returns a frozen `LifecycleTriggerConfig`.

```typescript
function lifecycle(config: LifecycleConfigInput): LifecycleTriggerConfig;
```

**Config options:**

```typescript
interface LifecycleConfigInput {
  events: LifecycleEvent[]; // Required: lifecycle events to listen for
  sources?: string[]; // Optional: filter by source repo (e.g., 'org/repo')
  description?: string; // Human-readable description
}

type LifecycleEvent = 'workflow_complete' | 'job_complete' | 'job_failed' | 'registration_updated';
```

```typescript
lifecycle({ events: ['workflow_complete'] }); // Any workflow completion
lifecycle({ events: ['job_failed'], sources: ['org/deploy-repo'] }); // Job failures from specific repo
lifecycle({ events: ['registration_updated'] }); // Workflow registration changes
```

### Branch patterns

Both `pr()` and `push()` (as well as `tag()`, `create()`, and `delete()`) accept glob strings and RegExp literals for pattern matching:

```typescript
// Glob patterns (micromatch syntax)
pr({ target: ['main', 'release/*', 'feature/**'] });

// Regex patterns
pr({ target: /^release\/v\d+\.\d+$/ });

// Mixed
push({ branches: ['main', /^hotfix\//] });
```

Glob patterns use micromatch syntax. Regex patterns use standard JavaScript `RegExp`.
