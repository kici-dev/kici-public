---
title: Global workflows
description: Cross-repo workflows that run on events from any repo in the same org
---

Global workflows let one **workflow repo** define jobs that run on events from many **source repos** in the same org. They're the answer to "I want one CI policy / release pipeline / security scan to fire on every repo without copy-pasting `.kici/` folders everywhere."

If you've only ever used per-repo workflows so far, start with the mental model section — global workflows add two new concepts (workflow repo vs. source repo, and authoring vs. source axes) that show up everywhere from SDK syntax to dashboard settings.

## Mental model

| Term           | Meaning                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow repo  | The repo whose `.kici/workflows/*.ts` file **declares** the global workflow. Holds the steps. Also known as the _authoring_ repo.                      |
| Source repo    | The repo that **emits** the event (push / PR / tag / ...) that causes the global workflow to fire. The agent checks out this repo as the working copy. |
| Global         | A workflow whose trigger carries one or more `repos:` glob patterns. The presence of `repos:` is what classifies a workflow as global.                 |
| Authoring axis | Policy that answers "which repos may **author** global workflows?" Controlled by the allow-list in the dashboard's _Allowed author repos_ setting.     |
| Source axis    | Policy that answers "which **source** repos' events are allowed to trigger global workflows?" Controlled by the deny-list in _Blocked source repos_.   |

The two axes are independent. A global workflow fires only if it passes **both** — its authoring repo is allowed AND the source repo is not denied.

## Declaring a global workflow

Add `repos:` to any trigger. Any workflow with at least one `repos:`-bearing trigger becomes global automatically; no separate flag is required.

```ts
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('org-lint', {
  on: [
    push({
      repos: ['myorg/*', '!myorg/archived-*'],
      branches: ['main'],
    }),
  ],
  jobs: [
    job('lint', {
      steps: [
        step('lint-all', async ({ $, env }) => {
          await $`echo source=${env.KICI_SOURCE_REPO_PATH ?? 'unknown'}`;
          await $`npm run lint`;
        }),
      ],
    }),
  ],
});
```

Patterns in `repos:` use the same globbing as `branches:` / `paths:` — plain globs (`myorg/*`), a leading `!` for exclusions (`!myorg/fork-*`), and a fully-qualified `owner/repo` identity for exact matches (`myorg/platform`). A bare `**` matches every repo in the org, including one whose identifier starts with a dot (`.github/workflows-config`) — a repo identifier is an owner/name pair, not a file path, so a leading dot carries no meaning of its own. Path globs in `paths:` keep the usual convention and do not match dot-prefixed files unless the pattern spells the dot out.

### At a dual-repo checkout

The agent checks out both repos. **Inside a step body**, `env` carries a pointer to each working tree:

| `env` var                 | Points to                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_SOURCE_REPO_PATH`   | The **source** repo's working tree (the repo that emitted the event). This is the repo the job's `$` / `git` commands operate on by default. |
| `KICI_WORKFLOW_REPO_PATH` | The **workflow** repo's working tree (the repo that authored the workflow). Useful for reading shared scripts or config from your CI repo.   |

Both variables are step-body context. They are **not** projected into the job's process environment, so a job-level `env:` block, a container image's entrypoint, or a shell command outside a step body will not see them. Outside a step body, use the `sourceRepo` / `workflowRepo` pair on the filter, generator, and rule contexts described below.

They are also set **only when there are two repos to point at**. An event from the workflow's own repo is matched from that repo's lock file rather than as a global candidate, so the workflow runs as an ordinary single-repo workflow: one checkout, and neither variable set. Read them with a fallback, as the example above does.

A global workflow's job runs with **no secrets at all** — neither the source repo's nor its own. See _Secrets are not available_ below.

### The triggering event

`ctx.event` inside a global workflow's job is the **source** repo's normalized event — the push or PR that fired the workflow, from a repo the workflow's own author may not own. `ctx.event.sourceRepo` names that repo.

That field is what makes a per-source-repo concurrency group expressible — and you have to write it. A global workflow runs on events from many repos, and their default branches share a name, so a group keyed on the branch alone puts every repo in one group, and with `cancelInProgress` (the default) one repo's push cancels another repo's in-flight run. That is still the behaviour of a branch-only group; naming the source repo in the key is what separates them:

```ts
concurrency: {
  group: ({ branch, event }) => `${event.sourceRepo}:${branch}`,
  cancelInProgress: true,
},
```

### Narrowing to the repos that need it

A global workflow that matches `myorg/*` will, by default, run on every repo in the org. Three mechanisms narrow it to the repos it actually applies to, in increasing order of power:

1. **A `requires` content filter on the trigger** — the cheapest gate. The orchestrator checks a file's contents (a JSON-path probe over `package.json`, for example) and drops the workflow **before any agent is dispatched** when the condition is not met. See [`requires` on triggers](sdk/triggers.md#content-requirements-requires). This is provider-dependent — it needs a file-contents fetcher, which the GitHub provider supplies.
2. **A workflow-level `filter` predicate** — arbitrary TypeScript over the checked-out source tree (below). Works with any provider that clones.
3. **A `DynamicJobFn`** — generate the exact job set from the source repo's state ([Generating jobs per source repo](#generating-jobs-per-source-repo) below).

### Narrowing with a filter

Before reaching for a `filter`, check whether a declarative filter answers the question. `commitMessage` (on the trigger) and `requires` (over source files) are evaluated by the orchestrator from data it already has, so they cost no evaluation job at all — while a `filter` predicate dispatches one per (event × workflow repo). Gating on a `[skip ci]` marker, a conventional-commit prefix, or the contents of a named config file needs no predicate.

A workflow can declare a `filter`: a predicate that decides whether the workflow applies to this event at all.

```ts
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('org-container-lint', {
  on: [push({ repos: ['myorg/*'] })],
  filter: async ({ sourceRepo, changedFilesStatus, $ }) => {
    // `changedFiles` throws when the diff is unavailable, so guard first.
    if (changedFilesStatus !== 'fetched') return true;
    const found = await $`ls ${sourceRepo.path}`;
    return found.stdout.includes('Dockerfile');
  },
  jobs: [
    job('lint-dockerfile', {
      runsOn: ['kici:os:linux'],
      steps: [
        step('lint', async ({ $, env }) => $`hadolint ${env.KICI_SOURCE_REPO_PATH}/Dockerfile`),
      ],
    }),
  ],
});
```

The filter receives a `FilterContext`:

| Property             | Type                                      | Description                                                                                |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sourceRepo`         | `RepoInfo`                                | The repo whose event triggered this evaluation, checked out on the evaluating agent.       |
| `workflowRepo`       | `RepoInfo`                                | The repo that registered the workflow. Identical to `sourceRepo` for a same-repo workflow. |
| `event`              | `EventPayload`                            | The normalized event envelope.                                                             |
| `changedFiles`       | `string[]`                                | Files changed in this event. Throws when unavailable — guard with `changedFilesStatus`.    |
| `changedFilesStatus` | `'fetched' \| 'unavailable' \| 'skipped'` | Whether `changedFiles` can be read.                                                        |
| `env`                | `Record<string, string\|undefined>`       | Environment variables.                                                                     |
| `$`                  | zx shell                                  | Shell executor.                                                                            |

`RepoInfo` carries `path` (an absolute path to the checkout on the evaluating agent) plus optional `ref` and `sha`. **Both are optional** — an event that carries no single ref leaves them undefined, so guard before reading them.

**`sourceRepo.path` is not stable across evaluations.** Its _contents_ are: the evaluating agent and the later run see the same tree at the same commit. The path itself is not — a different working directory, and possibly a different machine. Read _through_ it; never embed it in a job name, an output, or anything compared across calls.

**A `filter` must be pure and deterministic.** Decide from the context alone — the event, the changed files, and the checked-out tree — so the same event always yields the same verdict.

### Global and same-repo filters differ

The same `filter` keyword means two different things depending on whether the workflow is global:

|                                | Global workflow (`repos:` on a trigger)          | Same-repo workflow                                                        |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Evaluated                      | once per (event × workflow repo)                 | once per job that reaches dispatch, and once per job generator            |
| Evaluated relative to the run  | **before** any run row exists                    | **after** the run row exists                                              |
| A `false` verdict leaves       | no run at all — nothing appears in the dashboard | a run whose only entries are the evaluation jobs, rolling up to `success` |
| `sourceRepo` vs `workflowRepo` | two different repos                              | the same repo                                                             |

Two consequences of the same-repo shape are worth designing for. A workflow with ten jobs calls its filter ten times for one event — each on its own agent with its own checkout and its own `$` — so anything the predicate does happens that many times: keep it cheap and side-effect free. And if the predicate can answer differently for the same event, the workflow will _partially_ dispatch, running some jobs and not others.

**A held or rejected job is not filtered at all.** A job held for approval, or rejected by a context rule, already has a gate — the hold or the rule — so it never takes a filter verdict, and an approved job dispatches without one. Concretely: a path filter cannot stop an approval request for a job the change does not concern.

### Generating jobs per source repo

A global workflow's job generators run in the same pre-run evaluation as the filter, with both repos on disk. `sourceRepo` and `workflowRepo` are on the generator context, so one workflow repo can produce a different job set per source repo:

```ts
import { job, step, workflow, push, type DynamicJobFn } from '@kici-dev/sdk';
import { readFile } from 'node:fs/promises';

const perRepoJobs: DynamicJobFn = async ({ sourceRepo }) => {
  if (!sourceRepo) return [];
  const pkg = JSON.parse(await readFile(`${sourceRepo.path}/package.json`, 'utf8'));
  return Object.keys(pkg.scripts ?? {})
    .filter((s) => s.startsWith('ci:'))
    .map((s) =>
      job(s.replace(':', '-'), {
        runsOn: ['kici:os:linux'],
        steps: [step('run', async ({ $ }) => $`pnpm ${s}`)],
      }),
    );
};

export default workflow('org-ci', {
  on: [push({ repos: ['myorg/*'] })],
  jobs: [perRepoJobs],
});
```

The same `sourceRepo.path` caution applies: read the tree through it, and derive job names from the repo's _contents_, never from the path.

## Invoking a source repo's own workflows

A global workflow can run the source repo's **own** workflows and gate on them. Use the `invoke:` job option, built with `invokeSource()`:

```ts
import { job, workflow, push, kiciEvent, invokeSource } from '@kici-dev/sdk';

// Source repo (myorg/backend/.kici/workflows/tests.ts) — opts in by subscribing.
export const repoTests = workflow('repo-tests', {
  on: [kiciEvent({ name: 'myorg.repo-tests' })],
  jobs: [
    job('unit', {
      runsOn: ['kici:os:linux'],
      run: async ({ $ }) => {
        await $`npm test`;
      },
    }),
  ],
});

// Global workflow (myorg/ci-pipelines/.kici/workflows/org-pipeline.ts).
export default workflow('org-pipeline', {
  on: [push({ repos: ['myorg/*'], branches: ['main'] })],
  jobs: [
    // The invoke gate: emits `myorg.repo-tests` at the source repo and waits for
    // every run it triggers. It runs no steps of its own.
    job('repo-tests', { invoke: invokeSource('myorg.repo-tests') }),

    // Gated on the invoked runs through the standard needs vocabulary.
    job('deploy', {
      needs: ['repo-tests'],
      runsOn: ['kici:os:linux'],
      run: async (ctx) => {
        for (const r of ctx.needs['repo-tests'].result) {
          // r = { repo, workflow, runId, status, outputs }
          if (r.status === 'success') ctx.log.info(`coverage=${r.outputs.coverage}`);
        }
      },
    }),
  ],
});
```

An invoke gate never runs steps, so it is mutually exclusive with `steps` / `run`. A repo opts in by subscribing to the event with `kiciEvent({ name })` — a global cannot invoke a repo that did not subscribe.

The gate's event name follows the same rule as `ctx.emit`: the prefixes `__` and `kici.` are reserved for KiCI, and `invokeSource()` rejects them when you compile. A lock file that still carries a reserved gate fails that gate job at dispatch with `invoke gate cannot summon '…': the event-name prefix "…" is reserved for KiCI internal events. Choose a name a workflow may emit.` The job's status is `failed`, not skipped, so `optional` does not turn the refusal green. Nothing is summoned and no proxy job is created. See [reserved event names](events.md#reserved-event-names).

A summoned run inherits the [trust tier](events.md#trust-tiers-on-internal-triggers) of the run that holds the gate.

### Required by default

An emit that matches **zero** subscribers **fails** the gate. A repo that forgot to wire up its tests must not silently pass the org gate. To let a repo opt out, pass `optional`:

```ts
job('repo-tests', { invoke: invokeSource('myorg.repo-tests', { optional: true }) });
```

A zero-subscriber gate with `optional: true` succeeds immediately with no proxies. `optional` is separate from `continueOnError`: `optional` governs whether there was anything to invoke, `continueOnError` governs whether an invoked run passed.

### Reading invoked-run results

Each invoked run appears as a **proxy node** under the gate in the run graph, and its result is available to downstream jobs on `ctx.needs['<gate>'].result` — an array of `{ repo, workflow, runId, status, outputs }`, one entry per invoked run. `outputs` carries the run's non-secret declared outputs; a repo's secret outputs never cross into the global run.

### Standard job options apply

The gate is a standard job. Tolerate a failed invoked run with `continueOnError`, react to a failed gate with a downstream `needs` `when: 'on-failure'`, bound the wait with the job `timeout`, and bound the fan-out with `maxParallel` / `failFast`:

```ts
job('repo-tests', {
  invoke: invokeSource('myorg.repo-tests'),
  continueOnError: true,
  timeout: '1h',
  maxParallel: 10,
  failFast: true,
});
```

### Generating invoke gates

Because `invoke:` is a job shape, a generator can inspect the source repo and return only the gates that apply:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const perRepoGates: DynamicJobFn = async ({ sourceRepo }) => {
  if (!sourceRepo) return [];
  const jobs = [];
  if (existsSync(join(sourceRepo.path, 'Dockerfile')))
    jobs.push(job('docker', { invoke: invokeSource('myorg.docker-test', { optional: true }) }));
  if (existsSync(join(sourceRepo.path, 'package.json')))
    jobs.push(job('node', { invoke: invokeSource('myorg.node-test') }));
  return jobs;
};
```

The generator decides whether to create a gate at all; `optional` decides what a created gate does when nothing subscribes.

**Set a `timeout` when a summoned run can be held.** A gate waits for every run it summoned. An invoked run binds its own [contexts](contexts.md), so a [protection rule](contexts.md#protection-rules) can hold it for reviewer approval or a wait timer. A gate with no `timeout` then waits for as long as the hold lasts, which is until a human acts on it. Give such a gate a `timeout` so the wait is bounded.

## Enabling global workflows

Global workflows are gated by a **fleet-wide master switch** held by the orchestrator operator, off by default. Until it is on, `repos:`-bearing workflows are registered but never dispatched.

1. **The operator enables it cluster-wide** with `kici-admin cluster-settings set --global-workflows-enabled true`. This is the kill-switch — every per-org control below is ignored while it is off, and it cannot be flipped from the dashboard. The dashboard's **Settings → Global workflows** tab shows its current state as a read-only badge.
2. In the dashboard → **Settings → Global workflows**, decide which authoring/source controls you need. These per-org lists stay dashboard-editable; an org that has set none means "no per-org restrictions", not a denial.

| Setting              | What it controls                                                                                                                                                                                     | Typical use                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Allowed author repos | Restricts which repos can **author** (register) global workflows. Globs matched against the authoring repo identifier. When OFF, any repo in the org may author globals.                             | Lock authoring to `myorg/ci-*` so random product repos can't ship org-wide automation. |
| Blocked source repos | Blocks dispatch for events emitted from these **source** repos, regardless of authoring. Globs matched against the event source repo identifier. When OFF, events from any repo may trigger globals. | Protect against fork spam — e.g. `!myorg/*` via `myorg/fork-*`.                        |
| Elevated access      | **Deprecated and not enforced.** Stored and echoed back, but nothing reads it — a global workflow's job receives no secrets, so there is no access for it to grant. See _Secrets are not available_. | None. Clear the list so it does not imply a grant that is not in force.                |

All three lists accept globs. Leading `!` inside a single pattern is not supported here; negation is via the list-is-implicit-deny semantics, so keep it simple (`myorg/ci-*`, `myorg/platform-*`).

Patterns match repo identifiers by the same rule as `repos:` on a trigger: an identifier is an owner/name pair, not a file path, so a leading dot carries no meaning of its own and a wildcard segment matches one. `myorg/*` covers `myorg/.github`, and `**` covers every repo in the org. Review any existing entry that relies on a wildcard to reach — or to spare — a dot-prefixed repo name.

### Saving and reverting

The page is a two-state editor — changes are local until you click **Save changes**, and you can abandon them with **Discard changes**. There is no partial save; the PATCH is all-or-nothing per save click.

## Security model

### Two independent axes

A global workflow fires only if:

1. **The authoring repo is allowed.** If _Allowed author repos_ is ON, the workflow's authoring repo must match at least one allow-list glob. If OFF, any repo may author. Enforced at two points:
   - At registration time (extraction from the lock file — non-matching globals are dropped, and the orchestrator logs `Global workflows excluded from registration` naming each one).
   - At dispatch time (defense-in-depth — policy changes after registration still take effect).
2. **The source repo is not denied.** If the event's source repo matches any glob in _Blocked source repos_, the global workflow is skipped. Enforced at dispatch time.

Both checks are logged to the orchestrator. Grep for `Global workflows excluded from registration` (registration time) and `Skipping global workflow dispatch` (dispatch time) to see enforcement in action.

Both checks read the settings of the organization the **event's source** resolves to. If no webhook source maps the event's routing key to an organization, the orchestrator resolves the built-in `__default__` organization anchor instead — and since nobody has enabled global workflows for that anchor, every global workflow is refused. The registration log line carries the organization it decided against plus the remedy, so this case is distinguishable from a real opt-in that is simply switched off. See the troubleshooting table below.

### Secrets are not available

A global workflow's job is dispatched with **no secret material** — not the source repo's, and not the workflow repo's own. The organization-wide dispatch path binds no secret contexts, so a `contexts:` declaration on a global workflow resolves to nothing and any secret the steps expect is simply absent. Plan for it: a global workflow is for checks, policy and reporting that need only the two checkouts, not for deploys that need credentials.

This is about your **stored secrets**, not about repository access: the job is still handed a short-lived clone token for each repo it checks out, which is how the dual checkout works at all. What it does not get is anything from a secret context.

To run something that needs secrets on a source repo's event, put those jobs in a per-repository workflow in that repo, where the workflow's `contexts:` resolve normally.

The **Elevated access** setting reads as the way to lift this, and it is not: it is **deprecated and never consulted**. Nothing in the dispatch path reads the list, and adding a repo to it does not make any secret readable. It is kept only so an existing value stays visible and clearable, and is removed at the next major version — see [Deprecations](./deprecations.md).

## When does it fire?

Same-repo globals (a workflow in `myorg/app` with `repos: ['myorg/app']`) fire on pushes to `myorg/app`. Cross-repo globals fire on pushes to any source repo whose identifier matches a glob on the authoring workflow's trigger. The orchestrator de-duplicates between the per-repo and cross-repo matching passes, so a single event produces at most one run per (workflow, source-repo, trigger) triple.

Non-push triggers work too — `pr()`, `tag()`, `comment()`, `release()`, `workflowRun()`, etc. all accept `repos:`. `kiciEvent()` / `schedule()` / cron-like triggers have no source repo, so they're always per-org-registered regardless of `repos:`.

A global workflow that declares a `filter` or a job generator is decided by one **evaluation job per (event × workflow repo)**, dispatched before any run exists. That job checks out both repos once and evaluates every candidate workflow from that repo, so ten global workflows in one CI repo cost one evaluation, not ten.

When that evaluation cannot reach a verdict — it fails, breaches its budget, or never reports — the workflows it was deciding on **do not run**. On a provider that supports commit checks, that posts a `failure` check named **`KiCI: Organization workflow evaluation`** on the source commit, so the outcome is visible instead of silent. Three things to know about it:

- The check is posted whether the evaluation failed **outright** or only **partly**. A per-workflow budget breach, or a `filter` that throws, leaves that one workflow undecided while its neighbours from the same repo are decided and run normally; the check then names only the undecided ones. So a broken `filter` is reported the same way whether or not other global workflows happen to share its repo.
- Branch protection that lists required checks by name is unaffected, because the check is not on that list. Merge automation that requires _every_ check to be green will block on it.
- **Re-run the failed evaluation to clear the check.** A failed evaluation is recorded as one errored run named `__globaleval__<owner>/<workflow-repo>`. Fix the cause, then re-run that run — `kici runs rerun <run-id>`, or the **Re-run** button on the run in the dashboard. The re-run re-evaluates the original event against the workflow repo's current state, dispatches whatever it now admits, and posts a `success` check under the same name on the same commit. The request is **accepted immediately**; the evaluation itself is a job on an agent and runs after the answer, exactly as it does for the push that first triggered it. So watch the run and the check for the outcome, not the response. The check clears only when the re-evaluation reaches a verdict: if it fails again, or the orchestrator cannot run it, the `failure` check stands. A provider redelivery of the same webhook will not do this: it is dropped as a duplicate. Pushing a new commit also works, and is what you need when the payload of the original delivery is no longer stored.
- **Two failed evaluations on one commit share the check.** The check name carries no repo, so if two workflow repos both fail on the same push, re-running one of them posts `success` over the other's `failure`. The success summary names the workflow repo it re-evaluated; re-run the other round too.

## Approval gates are not supported

A global workflow cannot carry an `approval` gate, at the workflow level or on a job. Approval holds are applied by the per-repository dispatch path; the global path dispatches its jobs without consulting one, so a gate declared here would never be enforced. `kici compile` refuses it with `error [E124]` rather than accepting a security control the workflow does not actually have. A job produced by a `dynamicJob` generator never passes through the compiler, so that case is caught at dispatch instead — the orchestrator logs an error naming the workflow and job, and runs it ungated.

To gate a deployment behind a human, put the gated jobs in a workflow whose triggers carry no `repos:`.

## Re-running an organization-wide run

An organization-wide run that executed against another repository cannot be re-run from that repository. This is a permanent authorization boundary, not a limitation.

The re-run path resolves a workflow out of the repo the run acted on. For an organization-wide run that is the **source** repo, not the workflow repo that declares it. So a re-run from the source repo would re-execute the defining repo's code without the defining repo's policy pass. If the source repo carries a workflow of the same name, the re-run would run that workflow instead — with the source repo's credentials and none of the organization-wide job configuration.

Two tiers refuse it: your orchestrator, and the hosted Platform on every path that exposes re-run. Each refusal names both repos.

That refusal is what makes the run visible to both teams. A member scoped to **either** repo reads and cancels the run. Neither team can re-execute the other's code.

To run it again, trigger it from the repo that defines the workflow. You can also push a new commit to the source repo; a provider redelivery of the same event is dropped as a duplicate.

A failed organization-workflow **evaluation** is the exception. Re-running one re-evaluates the original event instead of resolving a workflow, so the substitution above cannot happen. See [When does it fire?](#when-does-it-fire).

## Notifications

An organization-wide run belongs to two repositories: the one it executed against, and the one that defines the workflow. A notification subscription's repository filter matches on either. So a subscription scoped to the defining repo hears about every organization-wide run of its own workflows, even though those runs execute against other repositories.

This is the same either-repo rule the run history uses, so the runs a team sees in the dashboard are the runs it is notified about.

## Requirements a filter places on the run

A `filter` reads the source tree, so the evaluation must be able to obtain one. A job that restores its workflow source from the cache and has no source repository to clone from fails with an explicit error rather than evaluating the filter against an empty tree. This applies to dispatch paths that run without a source repository configured — a filter and such a path are mutually exclusive; drop one or the other.

## Troubleshooting

| Symptom                                                                                         | Likely cause                                                                                                                                                                                                           | Where to look                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global workflow registered but never runs                                                       | Master toggle OFF, or allow-list blocks the authoring repo, or deny-list blocks the source repo                                                                                                                        | Orchestrator log: `Skipping global workflow dispatch` (dispatch time) / `Global workflows excluded from registration` (registration time)                                                                                                                                                                                                            |
| A global workflow is never registered at all — it is absent from `kici-admin registration list` | The push that should have registered it resolved to the `__default__` organization anchor, because no webhook source maps its routing key to an organization, or the fleet-wide master switch is off.                  | Orchestrator log: `Global workflows excluded from registration` with `"orgId": "__default__"`. Its `remedy` field names both fixes — map the source (`kici-admin source update <routingKey> --customer-id <org>`) and enable global workflows cluster-wide if it is not already (`kici-admin cluster-settings set --global-workflows-enabled true`). |
| `repos:` has no effect — workflow only fires on its own repo                                    | The fleet-wide master switch is off. Without it, the orchestrator treats the workflow as per-repo-only.                                                                                                                | Check the fleet-wide switch with `kici-admin cluster-settings show`. The dashboard → Settings → Global workflows tab shows it as a read-only badge.                                                                                                                                                                                                  |
| Secrets unavailable in a global job                                                             | Expected — a global workflow's job receives no secrets at all, and the _Elevated access_ list is not enforced.                                                                                                         | Move the jobs that need credentials into a per-repository workflow in the repo that owns the secrets                                                                                                                                                                                                                                                 |
| Dashboard shows workflow twice after registering                                                | Both a generic webhook source and a provider source (github, generic) re-registered the same repo.                                                                                                                     | Check `workflow_registrations` via `kici-admin workflow list` and confirm the right routing key owns the workflow.                                                                                                                                                                                                                                   |
| Global workflow registered, enabled, allowed — and still no run appears                         | Its `filter` returned `false`. A global filter runs before the run is created, so a suppressed workflow leaves nothing behind at all.                                                                                  | [Reading a global workflow's filter output](#reading-a-global-workflows-filter-output) — the evaluation round's own log. The orchestrator also logs `Global workflow skipped by eval round`, naming the workflow and the reason.                                                                                                                     |
| Global workflow never fires for one particular source repo                                      | Its `repos:` patterns do not match that repo's identifier.                                                                                                                                                             | Orchestrator log: `Global workflows dropped by their repos filter` — one line per delivery, naming each dropped workflow, its repo and its patterns.                                                                                                                                                                                                 |
| A `failure` check named `KiCI: Organization workflow evaluation` on a commit                    | The pre-run evaluation failed or timed out, so the global workflows from that repo were not run.                                                                                                                       | Orchestrator log for the evaluation job. Fix the cause, then re-run the errored `__globaleval__…` run (`kici runs rerun <run-id>`) to re-evaluate and clear the check; a redelivery is dropped as a duplicate.                                                                                                                                       |
| Same-repo workflow shows a `success` run with no jobs in it                                     | Its `filter` returned `false`. A same-repo filter runs after the run exists, so the run remains, carrying only the evaluation jobs.                                                                                    | The run detail page — the evaluation job's log records the filter verdict.                                                                                                                                                                                                                                                                           |
| Re-run is refused with "Cannot re-run an organization-wide workflow"                            | Expected — the run executed against a source repo that does not declare the workflow.                                                                                                                                  | [Re-running an organization-wide run](#re-running-an-organization-wide-run) — trigger it from the repo that defines the workflow instead.                                                                                                                                                                                                            |
| Every global workflow stopped running right after an orchestrator upgrade                       | The agents were not upgraded first. An agent older than v0.5.0 cannot evaluate a global workflow, and one containing a `dynamicJob` now needs an evaluation even without a `filter` — so its **static** jobs stop too. | The `KiCI: Organization workflow evaluation` check names the agent versions it found. Upgrade every `kici:role:init-runner` agent to v0.5.0 or newer.                                                                                                                                                                                                |

### Reading the decision trace for a delivery

The dashboard records why each workflow did or did not fire. Open
**Settings → Event log**, select the delivery, and read the **Workflow
decisions** section. It lists every workflow the delivery was evaluated
against — per-repository and organization-wide alike.

Each entry expands to the individual checks the trigger evaluation performed:
the check, the pattern, the value tested against it, and whether it passed. An
organization-wide workflow is named with the repository that defines it, so you
can find your own workflow even though it is absent from the source
repository's lock file.

This is the first place to look when a workflow does not fire. A failed `repo`
check means the `repos:` patterns do not match the source repository. A failed
`filter` check means the evaluation round excluded the workflow.

The value a check tested and the reason it gives quote the webhook body, so
those two fields need the `event_log:read_payload` permission. Without it the
row still names the check, the pattern, and whether it passed.

The orchestrator records the trace when trigger matching runs. A delivery the
Platform rejected at the relay therefore has none.

### Reading a global run in the dashboard

A global run is attributed to the **source** repo — the repo whose event
triggered it, and whose code the jobs check out. Its run detail page names both
repos, so you can tell it apart from an ordinary per-repo run:

| Row          | Shows                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| `Repository` | the source repo — the one the run acted on                               |
| `Defined in` | the workflow repo, tagged `Organization-wide`. Absent on an ordinary run |
| `Workflow`   | links into the **workflow** repo, on its default branch                  |

The `Workflow` link points at the workflow repo's default branch rather than at
a commit: the run's own commit belongs to the source repo, and nothing records
which commit of the workflow repo a given run used. So the link always shows the
file as it stands now, which may have changed since the run.

The `Payload` tab shows the source repo's event — the webhook delivery the
workflow reacted to, which for a global workflow comes from a repo you may not
own. A global run dispatched before your orchestrator stored payloads for this
path has none, and its tab reports that it could not load one.

#### Who can see it

A global run belongs to **both** repos, so a member whose role is scoped to
either one reaches it — the team whose push triggered it, and the team that
authored the workflow. Both see it in the run list, in the repository filter
(which offers both names), and on the run detail page. Cancelling follows the
same rule, so the team whose workflow is running can always stop it.

Releasing a **held** run is the one exception: approving a hold permits code to
run against the source repo, so it stays with a member scoped to that repo. A
member scoped only to the workflow repo sees the run but not its hold.

This applies only where the two repos genuinely differ. An ordinary per-repo run
records no separate workflow repo and is scoped to its own repo exactly as
before, and a member scoped to neither repo sees nothing in either case.

### Reading a global workflow's filter output

A global workflow's `filter` runs in a pre-run evaluation round, and that round
decides whether a run exists at all — so on the path where it suppresses a
workflow there is no run, and nothing appears in the dashboard. The round's own
log is still recorded. Read it with the orchestrator admin CLI, in two steps:

```bash
# 1. Find the round. Its workflow name is __globaleval__<owner>/<repo> of the
#    WORKFLOW repo. In the JSON rows, `id` is the job id and `run_id` is the
#    run id.
kici-admin queue list --workflow-name '__globaleval__myorg/ci-pipelines' --limit 5 --json

# 2. Print the round's log (step 0 is the evaluation itself).
kici-admin runs logs <run_id> --job <id>
```

Use `--json` on the first command: the plain table abbreviates both ids to their
first eight characters, and the second command needs them in full.

The two steps need different permissions, so run both with an **owner or admin**
token. Step 1 reads the dispatch queue, which requires `secret.read` — an auditor
token is refused with a 403 and never reaches step 2. Step 2 requires only
`run.read`, which every role carries.

Anything your `filter` writes with `console.log` appears there, alongside the
per-candidate verdicts the round recorded.

## See also

- [Architecture — global workflows](../architecture/global-workflows.md) — dual-query dispatch flow, cross-provider auth, security model, lock-file schema.
- [Universal-git provider](providers/universal-git.md#global-workflows) — how global workflows interact with `generic:<orgId>:<sourceId>` routing keys.
- [SDK reference](sdk-reference.md) — the full set of triggers that accept `repos:`.
