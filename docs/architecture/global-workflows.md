---
title: Global workflows
description: Architecture and design of cross-repo global workflows
---

Global workflows allow a single workflow repository to define CI/CD pipelines that trigger on events from any other repository under the same organization (routing key). This enables centralized CI policy enforcement, shared build pipelines, and org-wide automation without duplicating workflow definitions across repositories.

## Overview

In the standard KiCI model, each repository defines its own workflows in `.kici/workflows/`. When a push or PR event arrives, the orchestrator fetches that repository's lock file and matches triggers. Global workflows extend this model: a **workflow repo** defines workflows with `repos` patterns (including `!`-prefixed exclusions), and those workflows fire when events occur in **source repos** that match the patterns.

```
Workflow repo (e.g. myorg/ci-pipelines)
  .kici/workflows/lint-all.ts
    on.push({ repos: ['myorg/*'], branches: ['main'] })

Source repo (e.g. myorg/backend)
  git push to main
  --> triggers lint-all from ci-pipelines
  --> agent clones both repos
  --> executes lint-all with dual-repo context
```

## Architecture: dual-query flow

When a webhook event arrives, the orchestrator runs two independent matching passes:

```
Webhook event (push to myorg/backend)
    |
    v
[1] Per-repo matching (existing path)
    Fetch lock file from myorg/backend
    Match triggers against event
    Dispatch matched jobs (source repo only)
    |
    v
[2] Global matching (new path)
    Query RegistrationIndex for global workflows
      matching this trigger type + routing key
    For each global registration:
      Skip if same repo as event source (dedup)
      Check GlobalWorkflowPolicy
      Match trigger patterns (repos, branches, etc.)
      Dispatch with dual-repo context
```

Both passes run within the same `processWebhook` call. Global dispatches are additive -- they never replace per-repo dispatches.

## SDK usage

### Basic global workflow

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('org-lint', {
  on: [
    push({
      repos: ['myorg/*'],
      branches: ['main', 'develop'],
    }),
  ],
  jobs: [
    job('lint', {
      steps: [
        step('run-lint', async ({ $ }) => {
          await $`npm run lint`;
        }),
      ],
    }),
  ],
});
```

### With exclusions

```typescript
push({
  repos: ['myorg/*', '!myorg/legacy-*', '!myorg/archived-*'],
  branches: ['main'],
});
```

### With path filters

```typescript
push({
  repos: ['myorg/*'],
  branches: ['main'],
  paths: ['src/**', 'package.json'],
});
```

## Lock file format

The lock file carries a `repos` field on a trigger entry to mark it for global workflow matching. A leading `!` on a pattern is a negation:

```json
{
  "workflows": [
    {
      "name": "org-lint",
      "source": ".kici/workflows/org-lint.ts",
      "triggers": [
        {
          "_type": "push",
          "branches": [{ "type": "literal", "pattern": "main" }],
          "repos": [{ "type": "glob", "pattern": "myorg/*" }]
        }
      ],
      "jobs": [...]
    }
  ]
}
```

Workflows with `repos` patterns are classified as **global workflows** and stored in the `workflow_registrations` table with `is_global = true`.

## Security model

### Trust-policy precondition

Before any global-workflow policy decision is consulted, the event must clear the
org's trust policy (`packages/orchestrator/src/security/trust-policy-gate.ts`).
Both org-global dispatch paths — the fallback that runs globals when the source
repo has no lock file, and the pass that dispatches globals authored in other
repos — return without dispatching unless the verdict is `pass`. So a `hold` or
`reject` verdict (a workflow modification, a fork pull request, or an unresolved
contributor) stops the organization's global workflows too, not only the pull
request's own workflows. This matters because globals run with **org**
credentials against the **event's** head SHA: dispatching them for an event the
policy refused would hand an untrusted head SHA the org's credentials.

A skipped global creates no run row, so there is nothing to approve — approving
the event's security hold releases the pull request's own workflows and does not
retroactively run the organization's globals for that event.

The skip is recorded as a **neutral** informational check named
`KiCI: Organization workflows`, posted through the inbound event's own bundle and
credentials (a cross-provider lock-file fallback swaps the dispatch bundle for
another source's, which must not write this check). It is deliberately a
different check from `KiCI Security`: that name owns the single security check
run per commit, which the hold posts as pending and approve / reject later
complete, so writing the notice through it would resolve a still-held run's check
and could unblock a branch-protection rule that requires it. The notice stays
neutral in the `reject` case as well, because the same-source path already posts
the failure for that event and a second failure would double-report one decision.

See [Approvals](./approvals.md) for the trust policy's hold / reject vocabulary.

### When the pre-run evaluation fails

A global workflow that declares a `filter`, or whose jobs come from a generator,
cannot be decided from the lock file alone — only an agent may run that code. So
the orchestrator dispatches one pre-run evaluation job per (event × workflow
repo) and waits for its verdicts before deciding which of those workflows apply.

An evaluation that produces no usable verdicts is retried once. That covers both
shapes it can take: the job failed outright (the agent went away, the job was
rejected, the wait ceiling below was reached), and the job finished but decided
nothing — every workflow came back undecided, which is what an evaluation that
runs out of its own time budget reports. An evaluation that decided even one
workflow is a real result: its decided workflows run, and it is not retried —
retrying it would re-dispatch what it already decided. Its undecided workflows
are still recorded, as a partial failure carrying only their names, so the two
records below are produced for a partial evaluation as well as a total one.

If the second attempt still produces no usable verdicts, none of the workflows it
was deciding on run for that commit, and the outcome is recorded in two places:

- **One errored run**, for the whole evaluation rather than one per workflow —
  the evaluation exists to collapse several candidate workflows into a single
  pre-run job, so fanning its failure back out would undo that. Its failure
  reason names every workflow the failure suppressed.
- **One failing commit check** on the event's commit, named
  `KiCI: Organization workflow evaluation`. Its own name, for the same reason as
  the skip notice above: `KiCI Security` owns the single security check run per
  commit, so writing through it could resolve a still-held run's check.

The orchestrator also applies its own ceiling on how long it waits
(`--global-eval-wait-timeout-ms`, 4 minutes by default). The evaluation's own
budgets are enforced by the agent and only start once the job is running, so
neither covers an evaluation still waiting for a free agent, or an agent that
stops responding — without the ceiling the delivery would wait indefinitely and
never be logged at all. See
[Cluster settings](../operator/orchestrator/cluster-settings.md) for the knob.

### Org-level permissions

Global workflows require explicit opt-in. The **master switch is fleet-wide**:
`cluster_settings.global_workflows_enabled` (a single `id='default'` row,
`BOOLEAN` nullable — `NULL` resolves to the orchestrator's configured default
`KICI_GLOBAL_WORKFLOWS_ENABLED`, off by default). It is held by the operator
through `kici-admin cluster-settings` and gates every org before any per-org
list is consulted; an unreadable row fails closed.

The three per-org **lists** live in the `org_settings` table, which is
**org-scoped** — one row per `customer_id`, regardless of how many webhook
sources the org has registered. A missing `org_settings` row means "no per-org
restrictions" (the repo and source axes pass), not a denial:

| Column                           | Type                 | Purpose                                                                                                                              |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `customer_id`                    | `text` (PK)          | Organization identifier                                                                                                              |
| `global_workflow_allowed_repos`  | `jsonb[]` (nullable) | **Authoring axis.** Entries `{routingKey?, pattern}`; repos allowed to register global workflows (null/empty = any author)           |
| `global_workflow_denied_repos`   | `jsonb[]` (nullable) | **Source axis.** Entries `{routingKey?, pattern}`; source repos whose events must never trigger global workflows (null/empty = none) |
| `global_workflow_elevated_repos` | `jsonb[]` (nullable) | **Deprecated, not enforced.** Entries `{routingKey?, pattern}`; stored and echoed back, read by nothing                              |

Each list element is an object: `{routingKey?: string, pattern: string}`.
When `routingKey` is absent, the entry applies to events from / workflows
authored on **any** source in the org. When set, the entry only applies
to that one webhook source — a deny pinned to `github:42` does not block
events delivered on a Forgejo `generic:*` source in the same org. This is
how the same `org/repo` identifier can appear under multiple sources
without policy collisions.

The `GlobalWorkflowPolicy` class (`packages/orchestrator/src/security/global-workflow-policy.ts`) encodes three decisions:

1. **`isWorkflowRepoAllowed(workflowRoutingKey, workflowRepo, customerId)`** — consults the allow-list. Each entry matches when `entry.routingKey` is absent OR equals `workflowRoutingKey`, AND the pattern matches the workflow repo. Applied at registration extraction (filters which workflows get stored) and at dispatch time (filters which authored workflows may run).
2. **`isSourceRepoAllowed(eventRoutingKey, sourceRepo, customerId)`** — consults the deny-list. Each entry matches when `entry.routingKey` is absent OR equals the event's routing key, AND the pattern matches the source repo. Applied at dispatch time. Used to block events from untrusted repos (forks, public-contrib repos) before any global workflow is considered.
3. **`isElevatedAccessAllowed(workflowRoutingKey, repo, customerId)`** — consults the elevated list, with the same source-qualifier rules. **Deprecated and unused:** no code calls it, and calling it would decide nothing, because the global dispatch path resolves no secrets for it to widen (see _Elevated access_ below).

Allow-list and deny-list are **orthogonal**: the allow-list restricts authors, the deny-list restricts event sources. Both can be active simultaneously — they answer different questions.

#### Stale (orphan) source qualifiers

If an admin deletes a webhook source whose routing key still appears in
some entry's `routingKey`, that entry becomes an **orphan**: its routing
key cannot equal any current event's routing key, so the entry never
matches. This is the safe default — orphans silently stop applying rather
than re-binding to some unrelated source. The dashboard surfaces orphans
inline with an "Unknown source" badge so an operator can rebind them or
delete them.

### Credential scoping

Global workflow jobs use provider credentials from the webhook event (source repo), not from the registration. The workflow repo's secrets are not automatically shared with the source repo's execution context.

#### Cross-provider dispatch (universal-git)

When the source bundle and the workflow bundle differ (e.g., a Forgejo universal-git source delivers a push and the authored workflow lives in a GitHub App source, or two distinct universal-git Forgejo sources in the same org), the dispatch carries **two independent auth bundles** on `jobDispatchSchema`:

| Field          | Minted from                                | Used for                  |
| -------------- | ------------------------------------------ | ------------------------- |
| `sourceAuth`   | Inbound bundle's `cloneTokenProvider`      | Cloning the source repo   |
| `workflowAuth` | Registration bundle's `cloneTokenProvider` | Cloning the workflow repo |

For same-bundle globals (both repos under the same GitHub App) `workflowAuth` mirrors `sourceAuth`. A single-`token` field is still emitted alongside the split fields for callers that consume the simpler shape.

The in-memory `RegistrationIndex.globalByOrgAndTriggerType` index (keyed by `${customerId}|${triggerType}`) is what makes this cross-source lookup work — the routing-key-scoped `globalByTriggerType` only surfaces globals on the inbound routing key, which would hide every cross-provider author.

Policy decisions look up a single org row (one per `customer_id`). The
allow / elevate axes run against the **registration's** routing key — the
authoring source is the one whose qualifier governs whether a given
authored workflow may fire. The deny axis runs against the **event's**
routing key — events are filtered by the source they actually arrived on.

### Universal-git sources

Universal-git sources (Forgejo / Gitea / Gogs / GitLab / plain-GitHub webhooks, routing key `generic:<orgId>:<sourceId>`) share the same org-level row as the org's other sources. The policy code is purely string-based with no hardcoded provider checks, so a universal-git routing key works as a per-entry qualifier just like a `github:*` routing key. Enable cluster-wide via `kici-admin cluster-settings set --global-workflows-enabled true`, then tune the per-org lists via `kici-admin org-settings global-workflows {allow-add, deny-add} --customer-id <orgId> [--source generic:<orgId>:<sourceId>]`. See the [user guide](../user/providers/universal-git.md#global-workflows) for the operator surface.

### Elevated access — deprecated, never enforced

The global dispatch path resolves **no secrets at all**: it binds no secret contexts and writes no secret material into a job config, so a global workflow's job runs with neither the source repo's secrets nor the workflow repo's own. `global_workflow_elevated_repos` was meant to widen that, and nothing reads it.

Enforcing it is not a matter of calling `isElevatedAccessAllowed` from the dispatch path. Secrets are stored `(org_id, scope, key)` with no repository dimension, so "the source repo's secrets" is not a set the orchestrator can currently name — a grant would first need a repository-to-secret-context model that does not exist. The list, its admin route, its CLI mutators and its wire field are deprecated pending removal at v1.0.0.

## Agent behavior

When an agent receives a global workflow dispatch, the `jobConfig` includes:

| Field                    | Value                         | Purpose                               |
| ------------------------ | ----------------------------- | ------------------------------------- |
| `isGlobalWorkflow`       | `true`                        | Signals dual-repo context             |
| `workflowRepoUrl`        | Clone URL for workflow repo   | Agent clones this for workflow source |
| `workflowRef`            | Git ref at registration time  | Pinned version of the workflow        |
| `workflowSha`            | Commit SHA at registration    | For reproducibility                   |
| `workflowRepoIdentifier` | `owner/repo` of workflow repo | For logging and context               |

### Directory layout

The agent clones both repositories into a workspace directory:

```
/workspace/
  source/        <-- Source repo (where the event happened)
  workflow/      <-- Workflow repo (where the workflow is defined)
```

### Environment variables

| Variable                  | Value                 | Description                         |
| ------------------------- | --------------------- | ----------------------------------- |
| `KICI_IS_GLOBAL_WORKFLOW` | `true`                | Indicates global workflow execution |
| `KICI_WORKFLOW_REPO_PATH` | `/workspace/workflow` | Path to workflow repo clone         |
| `KICI_SOURCE_REPO_PATH`   | `/workspace/source`   | Path to source repo clone           |
| `KICI_WORKFLOW_REPO`      | `owner/repo`          | Workflow repo identifier            |
| `KICI_SOURCE_REPO`        | `owner/repo`          | Source repo identifier              |

## Configuration

### Enabling global workflows

Global workflows are disabled by default. To enable them:

1. Turn the fleet-wide master switch on (operator, once per cluster):

```sql
INSERT INTO cluster_settings (id, global_workflows_enabled)
VALUES ('default', true)
ON CONFLICT (id) DO UPDATE SET global_workflows_enabled = EXCLUDED.global_workflows_enabled;
```

2. Optionally restrict which repos can register global workflows. The
   list elements are jsonb objects — pass `routingKey` to pin an entry to
   one source, or omit it for "any source in the org":

```sql
UPDATE org_settings
SET global_workflow_allowed_repos = ARRAY[
  '{"pattern":"myorg/ci-*"}'::jsonb,
  '{"routingKey":"github:42","pattern":"myorg/automation"}'::jsonb
]
WHERE customer_id = 'kiciStg00001';
```

### Dashboard settings

The org settings page exposes these knobs through the **Global workflows** tab (`/orgs/:customerId/settings/global-workflows`), visible to any user with `org_settings:read`. Editing requires `org_settings:write`. The tab surfaces:

- A read-only master-switch badge showing the effective fleet-wide state (`cluster_settings.global_workflows_enabled`). It is set with `kici-admin cluster-settings`, not from the dashboard.
- An **Allowed author repos** section with its own enable toggle and editable list bound to `global_workflow_allowed_repos` (the authoring axis). When the toggle is off, any repo in the org may author global workflows.
- A **Blocked source repos** section with its own enable toggle and editable list bound to `global_workflow_denied_repos` (the source axis). Use this to protect forks and public-contrib repos from silently triggering org-wide automation.
- An **Elevated access** list bound to `global_workflow_elevated_repos`, marked not enforced and deprecated.

Every list row pairs a **source picker** with the existing **pattern**
input. The source picker defaults to "Any source" — leaving it as such
stores an unqualified entry. Selecting a specific source pins the entry's
`routingKey` so it only applies to events / workflows on that source.
Stored entries whose source has since been deleted render with an
"Unknown source" badge.

The Platform proxies reads and writes to the orchestrator via the existing dashboard WS channel (`dashboard.global-workflows.get/update`).

### CLI management

Operators enable the fleet-wide switch with `kici-admin cluster-settings`, then manage the per-org lists with `kici-admin org-settings global-workflows`:

```bash
# Fleet-wide master switch (once per cluster):
kici-admin cluster-settings set --global-workflows-enabled true

kici-admin org-settings global-workflows show --customer-id kiciStg00001
kici-admin org-settings global-workflows allow-add 'myorg/ci-*' --customer-id kiciStg00001
kici-admin org-settings global-workflows deny-add 'myorg/fork-*' --customer-id kiciStg00001

# Pin an entry to one webhook source (qualified by routingKey):
kici-admin org-settings global-workflows allow-add 'myorg/deploy' \
  --customer-id kiciStg00001 --source github:42
kici-admin org-settings global-workflows deny-add 'myorg/main' \
  --customer-id kiciStg00001 --source generic:kiciStg00001:src-b
```

`--org` is accepted as an alias for `--customer-id`. Omitting `--source`
on `*-add` stores an unqualified entry that applies to any source in the
org; omitting it on `*-remove` targets the unqualified entry. To remove
a source-qualified entry, pass the same `--source` value used when it
was added.

The CLI talks directly to the orchestrator admin API (`/api/v1/admin/org-settings/global-workflows`) so policy management remains available even when the Platform relay is unreachable.

## Related files

| Component              | Path                                                           |
| ---------------------- | -------------------------------------------------------------- |
| GlobalWorkflowPolicy   | `packages/orchestrator/src/security/global-workflow-policy.ts` |
| Registration extractor | `packages/orchestrator/src/registration/extractor.ts`          |
| Registration index     | `packages/orchestrator/src/registration/registration-index.ts` |
| Processor (dispatch)   | `packages/orchestrator/src/pipeline/processor.ts`              |
| SDK trigger types      | `packages/sdk/src/triggers/`                                   |
| Engine trigger matcher | `packages/engine/src/trigger/matcher.ts`                       |
| Org settings table     | `packages/orchestrator/src/db/types.ts` (OrgSettingsTable)     |
| E2E test               | `e2e/tests/global-workflow.test.ts`                            |
