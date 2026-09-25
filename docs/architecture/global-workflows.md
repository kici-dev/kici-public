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

## Architecture: one dispatch pipeline

When a webhook event arrives, the orchestrator runs two matching passes. Both
end in the same dispatch pipeline (`dispatchMatchedWorkflow`), so a global
workflow gets every feature a per-repo workflow gets: contexts and secrets,
holds and `approval` gates, containers, job `env` and `timeout`, the build
cache, dynamic fields, and re-runs.

```
Webhook event (push to myorg/backend)
    |
    v
[1] Per-repo pass
    Fetch lock file from myorg/backend
    Match triggers against event
    Dispatch matched workflows (dispatchMatchedWorkflow)
    |
    v
[2] Global pass
    Query RegistrationIndex for global workflows
      matching this trigger type + organization
    For each global registration:
      Skip if same repo as event source (matched in pass 1)
      Check GlobalWorkflowPolicy (author allow-list, source deny-list)
      Match trigger patterns (repos, branches, requires, ...)
    Run the pre-run evaluation round for workflows with a filter
      or a needs-free generator (one round per workflow repo)
    For each surviving workflow:
      dispatchMatchedWorkflow with a GlobalDispatchIdentity
```

Global dispatches are additive: they never replace per-repo dispatches. The
event's trust-policy verdict is evaluated once and applies to both passes.

The global pass decides **which** global workflows run. It owns the steps that
only exist for global workflows: the policy lists, the `requires` filter, and
the evaluation round. Everything after that is the per-repo pipeline, told by a
`GlobalDispatchIdentity` which repository each decision reads.

### Which repository each decision uses

A global run involves the **workflow repo** (A) that defines the workflow and
the **source repo** (B) whose event started the run. For a same-repo run, A and
B are the same repository and every row collapses to the per-repo behaviour.

| Concern                                                 | Repository                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Working copy, step working directory                    | B, at the event's commit                                                                    |
| Workflow code checkout                                  | A, at the registration's commit (`workflowSha`)                                             |
| Commit checks                                           | B. The check names carry A, so they do not collide with B's own workflows                   |
| Trust tier                                              | The event. Recorded on the run, and inherited by runs an invoke gate summons                |
| Context repository patterns                             | A                                                                                           |
| Context branch restrictions                             | A's registered branch (`workflow_registrations.default_branch`)                             |
| Context trigger-type filters, `minimumTrust`            | The event                                                                                   |
| Per-source variable overrides                           | A's webhook source                                                                          |
| Install secrets, registry credentials, `gitCredentials` | A's contexts, under the same rules                                                          |
| Lock entry, `contentHash`                               | A, at `workflowSha`                                                                         |
| Build job and source pack                               | A, at `workflowSha`, with A's credentials                                                   |
| Dependency cache key                                    | A's lock file at `workflowSha` (`lockfileHash`, `siblingsDigest`)                           |
| User cache namespace                                    | The pair (A, B)                                                                             |
| Clone tokens                                            | One for each repository, each minted by that repository's provider                          |
| Run row                                                 | `repo_identifier` = B; `workflow_repo_identifier`, `workflow_sha`, `workflow_branch` name A |
| OIDC ID token                                           | `repository` and `sub` name B; `workflow_repository` names A                                |

The user cache is keyed on the pair because a namespace for A alone would let
B's code write a cache that another source repo's run then reads.

The build job clones A at `workflowSha` and caches the pack of A's `.kici/`
directory under A's `contentHash`, so every source repo's run of one workflow
commit reuses the pack.

Dependencies come from A's `.kici/` too. Each registration stores the
dependency-cache key of the lock file that registered it
(`workflow_registrations.lockfile_hash` and `siblings_digest`), and a global
run probes the dependency cache with that key. On a hit the agent restores the
tarball into A's checkout. On a miss the build job installs A's dependencies and
uploads the tarball under the same key. The key names no repository, so a
per-repo run of A, and every source repo's global run of the same lock file,
share one entry: the same lock file resolves to the same dependencies.

The registration also stores the commit it wrote the key for
(`workflow_registrations.dep_cache_key_sha`). A global run uses the key only
while that commit equals the registration's `commit_sha`. An orchestrator or
`kici-admin` from before these columns updates `commit_sha` and the lock entry
but not the key, so after a rolling upgrade or a downgrade the key can belong to
an older lock file. The run then gets no key and installs A's dependencies on
the agent, until the next default-branch push writes both again.

An evaluation job of a global run is a deferred init job or a generator
evaluation. It checks out both repositories in the
[directory layout](#directory-layout) every other job of the run uses: A at
`workflowSha` under `workflow/`, B under `source/`. The dependency tarball and
A's source pack restore into `workflow/`, and the job loads the workflow module
from there. So it evaluates A's code with or without a source pack, and A's
dependencies never land in B's tree.

The source pack holds A's `.kici/` only, so a job that restores it still clones
both repositories: a dynamic field or a generator reads B from `source/`. A
global evaluation job therefore costs two clones, where a same-repo evaluation
job with a source pack clones nothing.

An agent released before evaluation jobs took this layout clones B into a single
checkout. Given a global evaluation job with no source pack, it restores A's
dependency tarball into that clone of B and loads the workflow module from B's
`.kici/`. When B has no `.kici/`, the module load fails and the job fails
closed. Otherwise the `contentHash` check fails the job. A test run sends no
`contentHash`, so such an agent can evaluate a workflow of the same name from B
instead of A's. Run `kici:role:init-runner` agents from the same release as the
orchestrator, and upgrade them together.

A re-run and a released evaluation round read A's lock entry at a recorded
commit. They use the key of the lock file at that commit, never the
registration's current key.

A registration that recorded no key installs on the agent. This covers a row
written before the key was stored, until A's next default-branch push, and a
lock file that records no `lockfileHash`. A registration that recorded no
commit has nothing to pack, so its runs install on the agent too.

### Filters and generators

A workflow `filter` runs in the pre-run evaluation round: it decides whether a
run exists at all. A `DynamicJobFn` with no `needs` runs in the same round, and
a workflow whose generators all return no jobs, with no static job, gets no run.

A `DynamicJobFn` that declares `needs` reads its upstream jobs' outputs, which
do not exist before the run. It runs on the pipeline's deferred path, after its
upstream jobs complete, as in a per-repo workflow. A workflow whose only
generators declare `needs`, and that has no `filter`, needs no round and
dispatches directly.

A round for a workflow that also declares a `needs` generator must skip that
generator. An agent reports that it can with the self-reported label
`kici:agent-feature:global-eval-skips-result-aware`, which scalers also add to
the agents they spawn. The round job requires the label. The up-front refusal reads
the agent registry instead: the capability flag
`globalEvalSkipsResultAwareGenerators` that an agent reports at registration.
When init-runner agents are registered, every one reports a readable version,
and none has the flag, the candidates that declare a `needs` generator are
refused up front and recorded as a failed evaluation. The other candidates of
the same group still run their round.
An empty or busy fleet is not refused: the round waits for a capable agent up
to the round's wait ceiling.

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

Workflows with `repos` patterns are classified as **global workflows** and stored in the `workflow_registrations` table with `is_global = true`. Each row also records the lock file's `lockfileHash` and `siblingsDigest`, which key the dependency cache for the workflow's global runs, and the commit that key was written for.

## Security model

### Trust-policy precondition

The org's trust policy (`packages/orchestrator/src/security/trust-policy-gate.ts`)
is evaluated once per event, and its verdict applies to global runs the same way
it applies to the source repo's own runs:

- `pass` dispatches the global runs.
- `hold` parks each global run in the security queue next to the pull request's
  own runs, with its own pending checks. Approving the hold dispatches it; the
  run keeps the event's untrusted tier and its reductions. Rejecting the hold
  cancels it; an expired hold fails it with an expiry reason.
- `ignore` creates no global run.

The pre-run evaluation round is not dispatched for a held event, because it
would run A's `filter` and generators next to the pull request's head before
anyone approved it. Instead the pass records **one held run per workflow repo**,
named like the round job (`__globaleval__<owner>/<repo>`) and marked as an
evaluation round on its run row. It covers every candidate of that repo that
needs the round, plus every candidate whose only generators declare `needs`, so
approving that one hold releases them all. The held row records A's commit and
branch and the names of the workflows it covers.

Approving it re-evaluates the round from the stored webhook payload, with A's
lock file read **at the recorded commit** rather than from the current
registrations. If a covered workflow has since been deleted, disabled, or no
longer subscribes to the event, the release fails the held run with a reason
naming it, and dispatches nothing. The release fails the same way when A's lock
file at the recorded commit does not define a covered workflow as an
organization-wide workflow for the event. A workflow that A registers through
several sources is released through each live source, as the pass that held it
evaluated each one. A second release signal for the same held
round does nothing: the release claims the row before it runs. Rejecting the
hold cancels the run.

The trust tier matters beyond the verdict. A fork pull request under `allow`
records an untrusted tier on every global run, so a context with `minimumTrust`
holds the job, and a run an invoke gate summons inherits the tier.

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
  `KiCI: Organization workflow evaluation`. It has its own name because
  `KiCI Security` owns the single security check run per
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

| Column                          | Type                 | Purpose                                                                                                                              |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `customer_id`                   | `text` (PK)          | Organization identifier                                                                                                              |
| `global_workflow_allowed_repos` | `jsonb[]` (nullable) | **Authoring axis.** Entries `{routingKey?, pattern}`; repos allowed to register global workflows (null/empty = any author)           |
| `global_workflow_denied_repos`  | `jsonb[]` (nullable) | **Source axis.** Entries `{routingKey?, pattern}`; source repos whose events must never trigger global workflows (null/empty = none) |

Each list element is an object: `{routingKey?: string, pattern: string}`.
When `routingKey` is absent, the entry applies to events from / workflows
authored on **any** source in the org. When set, the entry only applies
to that one webhook source — a deny pinned to `github:42` does not block
events delivered on a Forgejo `generic:*` source in the same org. This is
how the same `org/repo` identifier can appear under multiple sources
without policy collisions.

The `GlobalWorkflowPolicy` class (`packages/orchestrator/src/security/global-workflow-policy.ts`) encodes two decisions:

1. **`isWorkflowRepoAllowed(workflowRoutingKey, workflowRepo, customerId)`** — consults the allow-list. Each entry matches when `entry.routingKey` is absent OR equals `workflowRoutingKey`, AND the pattern matches the workflow repo. Applied at registration extraction (filters which workflows get stored) and at dispatch time (filters which authored workflows may run).
2. **`isSourceRepoAllowed(eventRoutingKey, sourceRepo, customerId)`** — consults the deny-list. Each entry matches when `entry.routingKey` is absent OR equals the event's routing key, AND the pattern matches the source repo. Applied at dispatch time. Used to block events from untrusted repos (forks, public-contrib repos) before any global workflow is considered.

Allow-list and deny-list are **orthogonal**: the allow-list restricts authors, the deny-list restricts event sources. Both can be active simultaneously — they answer different questions.

#### Stale (orphan) source qualifiers

If an admin deletes a webhook source whose routing key still appears in
some entry's `routingKey`, that entry becomes an **orphan**: its routing
key cannot equal any current event's routing key, so the entry never
matches. This is the safe default — orphans silently stop applying rather
than re-binding to some unrelated source. The dashboard surfaces orphans
inline with an "Unknown source" badge so an operator can rebind them or
delete them.

### Re-running across repositories

A run of an organization-wide workflow that executed against another repository
re-runs through `packages/orchestrator/src/pipeline/rerun-global.ts`. The
per-repo re-run would resolve the workflow out of the source repo's lock file,
which does not define it. The global re-run instead:

1. resolves A's registration of the workflow, and refuses when it is deleted or
   disabled, or when the org's global workflow policy now refuses A or B;
2. reads A's lock entry **at the run's recorded `workflow_sha`**, and refuses
   when the run recorded none, or when the entry at that commit is not
   organization-wide or has no static job;
3. rebuilds the event from the stored webhook payload and re-resolves its trust;
4. dispatches through `dispatchMatchedWorkflow` with a `GlobalDispatchIdentity`
   carrying the recorded commit and branch.

B is checked out at the run's own commit. Contexts, holds, `approval` gates and
A's credentials apply as they did on the first run. Like a per-repo re-run, it
repeats the static jobs and does not replay generated ones. It passes no
trust-policy gate: the caller is authorized to re-run, which is the same
decision an approval makes. A pull-request run's re-run keeps the pull-request
OIDC subject.

**Who may re-run.** Reading and cancelling a global run is allowed to a member
scoped to either repository (see [RBAC](./security/rbac.md)). Re-running is
not: it executes A's code with A's contexts and credentials again, so the
hosted Platform requires the member's repository scope to cover **A**.

**A failed evaluation round** is re-run through its own path. Both tiers
recognise it by a structural marker on the run row (`is_global_eval_round`),
never by the workflow name. The re-run re-evaluates the original event against
A's current registrations, and dispatches what that evaluation admits. It
resolves no workflow out of a lock file, so it stays on the source repo's
scope: a member scoped to B may request it.

### Credential scoping

A global job clones two repositories and carries a credential for each. The source repo's is minted by the inbound event's bundle. The workflow repo's is minted by the bundle of the registration's routing key, with the registration's provider context. When both are present, each clone uses its own.

When only one could be minted, the agent would use it for both clones. So the orchestrator refuses the job when the two repositories are on different git hosts, rather than send one host's credential to another. On one host, or when either repository is a local path, the one credential serves both clones. A job rerouted to a peer carries both clone tokens: `cloneToken` for the source repo and `workflowCloneToken` for the workflow repo.

#### Cross-provider dispatch (universal-git)

When the source bundle and the workflow bundle differ (e.g., a Forgejo universal-git source delivers a push and the authored workflow lives in a GitHub App source, or two distinct universal-git Forgejo sources in the same org), the dispatch carries **two independent auth bundles** on `jobDispatchSchema`:

| Field          | Minted from                                | Used for                  |
| -------------- | ------------------------------------------ | ------------------------- |
| `sourceAuth`   | Inbound bundle's `cloneTokenProvider`      | Cloning the source repo   |
| `workflowAuth` | Registration bundle's `cloneTokenProvider` | Cloning the workflow repo |

For same-bundle globals (both repos under the same GitHub App) both are minted by the same bundle, each for its own repository. A single-`token` field is still emitted alongside the split fields for callers that consume the simpler shape.

The in-memory `RegistrationIndex.globalByOrgAndTriggerType` index (keyed by `${customerId}|${triggerType}`) is what makes this cross-source lookup work — the routing-key-scoped `globalByTriggerType` only surfaces globals on the inbound routing key, which would hide every cross-provider author.

Policy decisions look up a single org row (one per `customer_id`). The
allow axis runs against the **registration's** routing key — the
authoring source is the one whose qualifier governs whether a given
authored workflow may fire. The deny axis runs against the **event's**
routing key — events are filtered by the source they actually arrived on.

### Universal-git sources

Universal-git sources (Forgejo / Gitea / Gogs / GitLab / plain-GitHub webhooks, routing key `generic:<orgId>:<sourceId>`) share the same org-level row as the org's other sources. The policy code is purely string-based with no hardcoded provider checks, so a universal-git routing key works as a per-entry qualifier just like a `github:*` routing key. Enable cluster-wide via `kici-admin cluster-settings set --global-workflows-enabled true`, then tune the per-org lists via `kici-admin org-settings global-workflows {allow-add, deny-add} --customer-id <orgId> [--source generic:<orgId>:<sourceId>]`. See the [user guide](../user/providers/universal-git.md#global-workflows) for the operator surface.

### Contexts and secrets on global runs

A global job binds contexts per job, like any job: only a job that lists
`contexts:` receives them. The contexts are checked as A's: their protection
rules check A (repository patterns) and A's registered branch (branch restrictions).
Trigger-type filters and `minimumTrust` check the event. The git-credential
relay reads the run row's `workflow_repo_identifier` and `workflow_branch` to
apply the same rules to a `gitCredentials` request after dispatch.

The source repo's contexts never reach a global job. A job that must use them
runs in B through an invoke gate (below). Secrets carry no repository dimension,
so a context's repository patterns are the control that keeps it to A's
workflows.

Any secret a global job binds is readable by the source repo's code that the
job runs. So run B's code in jobs that bind no context, and bind contexts
only on jobs that run A's own steps. Set `minimumTrust` on every context a
global workflow binds on a `pr()` trigger.

## Agent behavior

When an agent receives a global workflow dispatch, the `jobConfig` includes:

| Field                    | Value                                   | Purpose                               |
| ------------------------ | --------------------------------------- | ------------------------------------- |
| `isGlobalWorkflow`       | `true`                                  | Signals dual-repo context             |
| `workflowRepoUrl`        | Clone URL for workflow repo             | Agent clones this for workflow source |
| `workflowRef`            | Branch the workflow was registered from | Branch of the pinned workflow         |
| `workflowSha`            | Commit SHA at registration              | For reproducibility                   |
| `workflowRepoIdentifier` | `owner/repo` of workflow repo           | For logging and context               |

### Directory layout

The agent clones both repositories into a workspace directory:

```
/workspace/
  source/        <-- Source repo (where the event happened)
  workflow/      <-- Workflow repo (where the workflow is defined)
```

The execution jobs, the deferred init jobs, the generator evaluations and the
pre-run evaluation round all use this layout, and each loads the workflow module
from `workflow/`. Each clone uses the credential minted for its own repository.
When only one of the two credentials can be minted, both clones use it if the
two repositories are on the same git host; on different hosts the orchestrator
refuses the job. A `file:` URL or a local path reaches no git host, so a job
that clones either repository that way is never refused.

### Environment variables

One writer sets all seven, so the pre-dispatch evaluation round, the run's own
evaluation jobs and the sandbox present the same ambient environment to a job
generator. A generator that saw a key on one call and not the other would be a
determinism failure.

| Variable                  | Value                | Description                                           |
| ------------------------- | -------------------- | ----------------------------------------------------- |
| `KICI_IS_GLOBAL_WORKFLOW` | `true`               | Indicates global workflow execution                   |
| `KICI_WORKFLOW_REPO_PATH` | `<workdir>/workflow` | Path to workflow repo clone                           |
| `KICI_SOURCE_REPO_PATH`   | `<workdir>/source`   | Path to source repo clone                             |
| `KICI_WORKFLOW_REPO`      | `owner/repo`         | Workflow repo identifier                              |
| `KICI_SOURCE_REPO`        | `owner/repo`         | Source repo identifier                                |
| `KICI_SOURCE_BRANCH`      | ref, or `""`         | Source repo ref; empty when the event carries no ref  |
| `KICI_SOURCE_SHA`         | sha, or `""`         | Source repo commit; empty when the event carries none |

`<workdir>` is a per-job temporary directory, not a fixed path — read the
variable rather than reconstructing it.

A missing ref or sha writes an empty string rather than leaving the key unset:
assigning `undefined` to a `process.env` key stringifies to `"undefined"`, which
is worse than either.

## Configuration

### Enabling global workflows

Global workflows are disabled by default. To enable them:

1. Turn the fleet-wide master switch on (operator, once per cluster):

```bash
kici-admin cluster-settings set --global-workflows-enabled true
kici-admin cluster-settings show   # confirm: Global workflows enabled: true
```

2. Optionally restrict which repos can register global workflows. Pass
   `--source` to pin an entry to one webhook source, or omit it for "any
   source in the org":

```bash
kici-admin org-settings global-workflows allow-add 'myorg/ci-*' --org <customerId>
kici-admin org-settings global-workflows allow-add 'myorg/automation' \
  --org <customerId> --source github:42
kici-admin org-settings global-workflows show --org <customerId>
```

Both are also reachable from the dashboard tab below, except the master
switch, which is operator-only by design.

### Dashboard settings

The org settings page exposes these knobs through the **Global workflows** tab (`/orgs/:customerId/settings/global-workflows`), visible to any user with `org_settings:read`. Editing requires `org_settings:write`. The tab surfaces:

- A read-only master-switch badge showing the effective fleet-wide state (`cluster_settings.global_workflows_enabled`). It is set with `kici-admin cluster-settings`, not from the dashboard.
- An **Allowed author repos** section with its own enable toggle and editable list bound to `global_workflow_allowed_repos` (the authoring axis). When the toggle is off, any repo in the org may author global workflows.
- A **Blocked source repos** section with its own enable toggle and editable list bound to `global_workflow_denied_repos` (the source axis). Use this to protect forks and public-contrib repos from silently triggering org-wide automation.

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

## Invoking source-repo workflows

A global workflow can hand control back to the source repo it runs against and
gate on the repo's own work. A job that carries an `invoke:` action — built with
`invokeSource('event.name')` — is a **gate**: it runs no steps on an agent.
Instead, when the gate becomes ready the orchestrator:

1. **Emits** the named kici event at the source repo (`ctx.sourceRepo`).
2. **Matches** the repo's opt-in subscribers — workflows that declare
   `on: [ kiciEvent({ name }) ]` — and **dispatches** each as a normal in-repo
   run, capturing the run ids it created.
3. Creates one **proxy job** per spawned run, tracked in the global run's graph
   as a fan-out child of the gate. A proxy runs no steps; its status **mirrors**
   the spawned run.
4. As each spawned run reaches a terminal state, the orchestrator maps it back to
   its proxy and sets the proxy's status, carrying the run's non-secret outputs.
5. Once every proxy is terminal, the gate aggregates a status and the downstream
   `needs` release.

```
repo-tests ─┬─ repo-tests (myorg/backend:unit)   ← proxy, mirrors the spawned run
            ├─ repo-tests (myorg/backend:lint)   ← proxy
            └─ repo-tests (myorg/backend:e2e)    ← proxy
                     │ (all terminal)
                  deploy
```

**Required by default.** An emit that matches zero subscribers **fails** the
gate, with a message naming the event and repo. A repo that never wired up its
tests must not silently pass the org gate. Pass `invokeSource(event, { optional:
true })` to let a repo opt out: a zero-subscriber gate then succeeds immediately
with no proxies.

**Dynamic invocation.** Because `invoke:` is a job shape, a generator job can
inspect the source repo at runtime and return only the invoke gates that apply —
e.g. a `docker-test` gate when the repo has a `Dockerfile`, a `node-test` gate
when it has a `package.json`. The generator decides _whether to create a gate_;
`optional` decides _what a created gate does when nothing subscribes_.

**Failure, timeout, concurrency — the standard job vocabulary.** The gate is a
standard job. `continueOnError` tolerates a failed invoked run. A downstream
`needs` `when: on-failure` reacts to a failed gate. The job `timeout` bounds the
wait — the orchestrator enforces it, since the gate has no agent. `maxParallel`
and `failFast` bound the fan-out over the proxies.

**Security.** The invoked workflow runs as the repo's own run, with the repo's
own secrets and its own dashboard run — the global never gains the repo's
secrets, only pass/fail plus plain declared outputs. The opt-in is the
subscription: a global cannot invoke a repo that did not subscribe. The invoke
path reuses the same trust-policy and global-workflow-policy gates as the rest of
the global dispatch path, and a bounded chain depth stops an invoke chain from
looping. The summoned run inherits the trust tier of the global run, so a fork
pull request's summoned run is untrusted and a `minimumTrust` context in the
source repo holds it.

## Related files

| Component              | Path                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| Global pass            | `packages/orchestrator/src/pipeline/process-webhook.ts`          |
| Global dispatch        | `packages/orchestrator/src/pipeline/global-dispatch.ts`          |
| Dispatch identity      | `packages/orchestrator/src/pipeline/global-dispatch-identity.ts` |
| Evaluation round       | `packages/orchestrator/src/pipeline/global-eval-round.ts`        |
| Held evaluation round  | `packages/orchestrator/src/pipeline/global-round-hold.ts`        |
| Global re-run          | `packages/orchestrator/src/pipeline/rerun-global.ts`             |
| Invoke-gate executor   | `packages/orchestrator/src/pipeline/invoke-gate.ts`              |
| GlobalWorkflowPolicy   | `packages/orchestrator/src/security/global-workflow-policy.ts`   |
| Registration extractor | `packages/orchestrator/src/registration/extractor.ts`            |
| Registration index     | `packages/orchestrator/src/registration/registration-index.ts`   |
| Processor (dispatch)   | `packages/orchestrator/src/pipeline/processor.ts`                |
| SDK trigger types      | `packages/sdk/src/triggers/`                                     |
| Engine trigger matcher | `packages/engine/src/trigger/matcher.ts`                         |
| Org settings table     | `packages/orchestrator/src/db/types.ts` (OrgSettingsTable)       |
| E2E test               | `e2e/tests/global-workflow.test.ts`                              |
