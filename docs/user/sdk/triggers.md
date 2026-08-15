---
title: 'SDK reference: triggers'
description: GitHub event triggers, kiciEvent, workflowComplete, workflowsFailedBatch, jobComplete, genericWebhook, schedule, lifecycle
---

## Triggers

Triggers define when a workflow runs. KiCI provides 23 trigger types: 16 GitHub webhook triggers and 7 internal/generic triggers for event routing, scheduling, and non-GitHub sources. Each trigger returns a frozen config object with a unique `_tag` discriminator.

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

### Path filter behavior

A `pr()` or `push()` trigger with `paths` matches the event's changed files
against your patterns. An available list is matched exactly (an event with no
matching change — including a diff-less branch create or delete — does not run).
When the diff is **unavailable** (chiefly a universal-git pull-request event,
whose webhook carries no diff), path filters match **conservatively** so the
workflow runs rather than being silently dropped, and the delivery is recorded
as degraded. GitHub always provides an exact list; a transient API error fails
loudly, not as empty.

### Content requirements (`requires`)

Where `paths` filters on **which files changed**, `requires` filters on **what
those files contain**. It is a declarative filter on the `pr()`, `push()`, and
`tag()` triggers: a list of queries over the bytes of named source files, read
at the event's commit. The orchestrator evaluates it as pure data before
dispatching — it reads only the referenced files, never clones the whole
repository, and never runs any of your workflow code. A workflow whose `requires`
does not pass is simply not dispatched.

Each entry is a `ContentRequirement`:

```typescript
interface ContentRequirement {
  file: string; // repo-relative path to query
  format?: 'auto' | 'json' | 'yaml' | 'text'; // how to parse the file (default: 'auto')
  exists?: string[]; // JSONPath expressions that must each resolve to ≥1 node (json/yaml)
  match?: Record<string, unknown>; // JSONPath → expected value; every one must match (json/yaml)
  not?: Record<string, unknown>; // JSONPath → value; passes only when NONE match (json/yaml)
  contains?: string | string[]; // literal substrings, all of which must appear (text only)
  notContains?: string | string[]; // literal substrings, none of which may appear (text only)
  matches?: string | RegExp | (string | RegExp)[]; // regexes, all of which must match (text only)
  notMatches?: string | RegExp | (string | RegExp)[]; // regexes, none of which may match (text only)
  ignoreCase?: boolean; // applies to contains/notContains only (default: false)
  absent?: boolean; // passes only when the file does NOT exist
}
```

**Format.** `format: 'auto'` (the default) picks the parser by extension:
`.json` → JSON, `.yaml` / `.yml` → YAML, everything else → text. Set `format`
explicitly to override — e.g. treat an extensionless file as JSON, or read a
`.json` file as raw text. JSON and YAML both parse to an object, so the JSONPath
keys (`exists` / `match` / `not`) work identically over either; `text` files are
queried by `contains`, `notContains`, `matches`, and `notMatches` over the raw
bytes.

**Query keys.**

- **`exists`** — an array of JSONPath expressions; each must resolve to at least
  one node in the parsed document.
- **`match`** — a JSONPath → expected-value map; every expression must match. An
  expected value is an exact value, a regex string in `/pattern/flags` form
  (against a string node), or an array of acceptable values (any one matches).
- **`not`** — the same map shape, inverted: the entry passes only when **none** of
  the expressions match.
- **`contains` / `notContains`** — literal substrings tested against the raw file
  text. Every entry must be present (`contains`) or absent (`notContains`). No
  escaping needed (text format only).
- **`matches`** — one or several regexes (a `RegExp` or `/pattern/flags` string),
  each of which must match the raw file text (text format only).
- **`notMatches`** — the inverse of `matches`: the entry passes only when none of
  the regexes match (text format only).
- **`ignoreCase`** — case-insensitive `contains` / `notContains` only; a regex
  carries its own flags. Default false.
- **`absent: true`** — passes only when the file does **not** exist at the event's
  commit. It is mutually exclusive with the query keys above.
- A bare `{ file }` with no query key requires the file to **exist**.

The keys inside one entry are AND-ed, and the entries in a `requires` list are
AND-ed with each other. An empty or absent `requires` matches everything, exactly
like `paths`.

**Examples:**

```typescript
// Only run CI when package.json declares a `ci` script.
push({ branches: 'main', requires: [{ file: 'package.json', exists: ['$.scripts.ci'] }] });

// Deploy only when the service config enables it (YAML, matched by value).
push({
  branches: 'main',
  requires: [{ file: 'service.yaml', match: { '$.deploy.enabled': true } }],
});

// Only run when the Dockerfile builds from a Node base image (raw-text regex).
pr({ requires: [{ file: 'Dockerfile', format: 'text', matches: '/^FROM node:/m' }] });

// Skip the workflow whenever a repo carries an opt-out marker file.
push({ requires: [{ file: '.skip-ci', absent: true }] });

// Combine filters: a tag build that requires a version file AND forbids a draft flag.
tag({
  patterns: ['v*'],
  requires: [
    { file: 'VERSION', matches: '/^\\d+\\.\\d+\\.\\d+$/' },
    { file: 'release.json', not: { '$.draft': true } },
  ],
});
```

**Fail-visible evaluation.** Files are read at the event's commit. If a
referenced file is larger than **1 MiB**, or fails to parse for its format, the
requirement is **indeterminate** — the candidate workflow is dropped and does
**not** run. A `requires` that cannot be evaluated never silently passes.

**Compile-time validation.** `kici compile` rejects a malformed requirement before
it ever reaches the orchestrator: a raw-text key that is invalid or catastrophic
(ReDoS-prone) is rejected by a safe-regex check; a text file cannot carry a
JSON/YAML query key (`exists` / `match` / `not`) and a JSON/YAML file cannot carry a
raw-text key; `absent` cannot be combined with a query key; and an explicit
`format` with no query key is rejected as having nothing to check.

### Commit-message filters (`commitMessage`)

Where `requires` filters on what the repository's **files** contain,
`commitMessage` filters on what the **event** says. It is a declarative filter on
the `pr()`, `push()`, and `tag()` triggers. The orchestrator evaluates it
directly from the webhook payload: no file is fetched, and no repository is
cloned. For an organization-wide workflow it dispatches no evaluation job. It is
the cheapest gate available.

The text it tests is the **full head-commit message** — subject and body — for
`push` and `tag`, and the **title plus body** for pull-request events.

```typescript
interface TextMatch {
  contains?: string | string[]; // every needle must be present
  notContains?: string | string[]; // no needle may be present
  matches?: string | RegExp | (string | RegExp)[]; // every regex must match
  notMatches?: string | RegExp | (string | RegExp)[]; // no regex may match
  ignoreCase?: boolean; // applies to contains/notContains only (default: false)
}
```

**Every entry in a list is a conjunct.** `contains: ['a', 'b']` passes only when
the text contains both, and the keys AND together. To express OR, declare two
triggers — a workflow's trigger list already matches on the first one that fits:

```typescript
// AND — one trigger.
push({ commitMessage: { contains: ['release:', 'approved'] } });

// OR — two triggers.
on: [
  push({ branches: 'main', commitMessage: { contains: 'deploy:' } }),
  push({ branches: 'main', commitMessage: { contains: 'release:' } }),
];
```

Needles are **literal substrings** — no glob, no regex, no escaping, so a needle
containing `.*` matches only the literal `.*`. Use `matches` / `notMatches` for a
pattern; both accept a `RegExp` literal, and the `m` flag reaches the body:

```typescript
// The single most common use: skip marker commits.
push({ branches: 'main', commitMessage: { notContains: ['[skip ci]', '[ci skip]'] } });

// Ignore dependency-bump noise across an organization.
push({ commitMessage: { notMatches: /^chore\(deps\):/ } });

// Require a conventional-commit prefix and forbid a WIP marker.
pr({ target: 'main', commitMessage: { matches: /^(feat|fix)\(/, notContains: 'WIP' } });

// Match a trailer in the commit body.
push({ commitMessage: { matches: /^Fixes: #\d+$/m } });
```

`ignoreCase` affects `contains` and `notContains` only — a regex already carries
its own flags, so write `/^feat:/i` rather than expecting `ignoreCase` to reach
it.

**Fail-visible evaluation.** Some events carry no message at all. A
branch-deletion push has no head commit, and a self-hosted forge may publish
none. The trigger then does **not** match, and the decision trace records it as
`indeterminate` rather than as an exclusion. A `commitMessage` filter that cannot
be evaluated never silently passes.

**Compile-time validation.** `kici compile` rejects a malformed matcher. It
refuses:

- a matcher with no query key;
- an `ignoreCase` that would affect nothing;
- an empty needle list;
- an empty-string needle (it would match every text);
- a regex that is invalid or catastrophic (ReDoS-prone).

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

**Config options:** `types` (string[]), `description`, `inputs` (typed dispatch inputs map)

```typescript
dispatch(); // Any dispatch
dispatch({ types: ['deploy', 'rollback'] }); // Specific event types
```

#### Typed dispatch inputs

A `dispatch()` trigger can declare a typed `inputs` schema. Operators supply
values with `kici run --input key=value`; KiCI validates, coerces, defaults, and
exposes them to steps and rules as `ctx.dispatchInputs`. The values are validated
on the orchestrator from the compiled lock file — a missing required input or a
bad value is rejected before any agent runs, without cloning the repository.

```typescript
import { workflow, job, step, dispatch, defineDispatchInputs, z } from '@kici-dev/sdk';

const inputs = defineDispatchInputs({
  target: z.string().optional(),
  skipCveScan: z.boolean().default(false),
  skipCveScanReason: z.string().min(1).optional(),
  mode: z.enum(['full', 'edge-only']).default('full'),
  retries: z.number().int().min(0).max(10).default(3),
});

export default workflow('deploy-prod', {
  on: dispatch({ types: ['deploy-prod'], inputs }),
  jobs: [
    job('gates', {
      runsOn: 'kici:group:ops',
      steps: [
        step('cve-gate', async (ctx) => {
          const i = inputs.from(ctx); // fully typed per declared key
          if (i.skipCveScan) {
            ctx.log.warn(`CVE gate skipped: ${i.skipCveScanReason ?? '(no reason)'}`);
            return;
          }
          await ctx.$`pnpm scan:cve:gate`;
        }),
      ],
    }),
  ],
});
```

- **`defineDispatchInputs(map)`** is the single declaration site. It returns a
  handle that `dispatch({ inputs })` accepts and exposes `inputs.from(ctx)` — a
  typed reader over `ctx.dispatchInputs`, typed per declared key. `dispatch({ inputs })`
  also accepts a bare `{ name: schema }` map directly when you don't need the reader.
- **`ctx.dispatchInputs`** is always present (a validated map of
  `string | number | boolean | null`), distinct from `ctx.inputs` (typed outputs
  from `needs` dependencies). Rules see the same values via `ctx.dispatchInputs`,
  so `skipUnless(ctx => !ctx.dispatchInputs.skipCveScan)` works.
- **Defaults are applied once**, on the orchestrator (the authoritative side); the
  CLI pre-validates `--input` for fast feedback and forwards the raw operator pairs.

**Allowed input types (closed subset):** `z.string()`, `z.number()`,
`z.boolean()`, `z.enum([...])`, `z.literal(v)`, with the modifiers `.optional()`,
`.nullable()`, `.default(v)`, `.min(n)`, `.max(n)`, `.regex(re)`, `.int()`.
Anything outside this set (`.refine()`, `.transform()`, `.pipe()`, `z.object()`,
`z.array()`, `z.union()`, `z.record()`, `z.coerce.*`) is a **compile error** —
the closed set is what guarantees the schema survives the trip to the
orchestrator's lock file without silently dropping any validation. CLI strings
are coerced for you (`--input retries=3` becomes the number `3`; booleans accept
`true`/`false`/`1`/`0`/`yes`/`no`), so author your schema with clean types.

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

The following 7 trigger types support internal event routing, scheduling, lifecycle orchestration, and non-GitHub webhook sources.

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

### workflowsFailedBatch()

Create a batched failure trigger. Instead of firing once per failed workflow, it accumulates every failed workflow completion over a time window and fires the subscribing workflow **once** with the whole list — so a mass incident (a bad deploy failing hundreds of runs at once) notifies a single time, not once per failure. Returns a frozen `WorkflowsFailedBatchTriggerConfig`.

```typescript
function workflowsFailedBatch(
  config: WorkflowsFailedBatchConfigInput,
): WorkflowsFailedBatchTriggerConfig;
```

**Config options:**

```typescript
interface WorkflowsFailedBatchConfigInput {
  accumulateFor: number; // Accumulation window in milliseconds (opens on the first failure)
  name?: string; // Filter by failed workflow name
  source?: string; // Cross-repo source filter
  description?: string;
}
```

The first failure inside the window opens it; when the window closes, the subscribing workflow is dispatched once. The batch is delivered on `ctx.event.payload`:

```typescript
// ctx.event.payload for a workflowsFailedBatch dispatch:
// {
//   total: number,               // total failures in the window
//   runs: Array<{                // the failed runs (bounded — the first 200)
//     runId: string;
//     repo: string;
//     workflowName: string;
//     failureClass?: string;     // why the run failed
//     senderUsername?: string;   // triggering actor, when known
//   }>,
// }
```

```typescript
workflowsFailedBatch({ accumulateFor: 10000 }); // One notification per 10s burst of failures
workflowsFailedBatch({ accumulateFor: 30000, name: 'CI' }); // Only CI failures
workflowsFailedBatch({ accumulateFor: 30000, source: 'org/repo' }); // Cross-repo source filter
```

A workflow dispatched by a failure trigger (`workflowsFailedBatch`, or `workflowComplete({ status: ['failed'] })`) never re-triggers the same batch on its own failure — a notifier that itself fails cannot loop.

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
  inputs?: DispatchInputsMap; // Optional: defaults-only typed inputs (see below)
}
```

```typescript
schedule({ cron: '0 * * * *' }); // Every hour
schedule({ cron: '0 0 * * *' }); // Daily at midnight UTC
schedule({ cron: '0 9 * * 1', timezone: 'America/New_York' }); // Monday 9am ET
schedule({ cron: '*/15 * * * *', description: 'health check every 15 min' });
```

A workflow may declare **multiple** `schedule()` triggers. Each schedule is
evaluated and fired independently — a `Monday 9am` schedule and a `Friday 6pm`
schedule on the same workflow both run at their own times:

```typescript
on: [schedule({ cron: '0 9 * * 1' }), schedule({ cron: '0 18 * * 5' })];
```

#### Schedule inputs (defaults-only)

A `schedule()` trigger may declare typed `inputs`. A cron or dashboard
"run now" fire carries **no operator-supplied values**, so each input resolves
from its declared **default** and is exposed to steps and rules as
`ctx.dispatchInputs` — the same surface as [typed dispatch inputs](#typed-dispatch-inputs).

Because there is no operator to supply a value, every schedule input must
declare a `.default()` **or** be `.optional()`. An input that is neither is
rejected at `kici compile` time.

```typescript
import { workflow, job, schedule, z } from '@kici-dev/sdk';

export default workflow('nightly', {
  on: schedule({
    cron: '0 3 * * *',
    inputs: { mode: z.enum(['full', 'quick']).default('full') },
  }),
  jobs: [
    job('build', {
      runsOn: 'default',
      run: async (ctx) => {
        ctx.log(`mode = ${ctx.dispatchInputs.mode}`); // "full" on every fire
      },
    }),
  ],
});
```

You can also share a typed handle via `defineDispatchInputs(...)` and read it
back with `.from(ctx)`, exactly as with `dispatch()`. The allowed input types
are the same closed subset documented under
[typed dispatch inputs](#typed-dispatch-inputs).

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
