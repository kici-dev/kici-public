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

| `env` var                 | Carries                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_SOURCE_REPO_PATH`   | The **source** repo's working tree (the repo that emitted the event). This is the repo the job's `$` / `git` commands operate on by default. |
| `KICI_WORKFLOW_REPO_PATH` | The **workflow** repo's working tree (the repo that authored the workflow). Useful for reading shared scripts or config from your CI repo.   |
| `KICI_SOURCE_REPO`        | The source repo's `owner/repo` identifier — the same value as `ctx.event.sourceRepo`.                                                        |
| `KICI_WORKFLOW_REPO`      | The workflow repo's `owner/repo` identifier.                                                                                                 |
| `KICI_SOURCE_BRANCH`      | The source repo's checked-out ref. **Empty string** when the event carries no single ref.                                                    |
| `KICI_SOURCE_SHA`         | The source repo's checked-out commit. **Empty string** when the event carries no single sha.                                                 |
| `KICI_IS_GLOBAL_WORKFLOW` | `"true"`. Never set on the same-repo path, so it is the cheapest test for which path you are on.                                             |

All seven are set **only when there are two repos to point at**. An event from the workflow's own repo is matched from that repo's lock file, not as a global candidate. The workflow then runs as an ordinary single-repo workflow: one checkout, and none of the seven set. Read them with a fallback, as the example above does.

Guard those two on emptiness rather than absence: `??` does not catch `""`, but `||` does.

These are real process environment variables for the whole job, so a subprocess a step spawns inherits them: `` await $`echo $KICI_SOURCE_REPO` `` works. What does **not** see them is anything resolved outside that process — a job-level `env:` block or a container image's entrypoint, both of which are settled before the job starts. Outside a step body, use the `sourceRepo` / `workflowRepo` pair on the filter, generator, and rule contexts described below.

A dynamic `env`, `matrix`, `contexts` or `concurrencyGroup` function is different. An evaluation job runs it before the job starts, on its own checkout of both repos, and sets the seven for it. Those paths belong to the evaluation job: read files through them, but never copy a path into the value the function returns.

The workflow's own dependencies, the packages the workflow repo's `.kici/` declares, go into the workflow repo's working tree. They come from the [dependency cache](lock-file-and-drift.md#lock-file-structure) when the workflow repo's lock file records a `lockfileHash`, as for that repo's own workflows. Every source repo's run of one workflow version restores the same cached install.

A global workflow's job binds contexts one job at a time, as a job of any other workflow does, and their rules are checked as the **workflow** repo's. The source repo's contexts never reach it. See [Secrets come from the workflow repository](#secrets-come-from-the-workflow-repository) below.

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

A global workflow's needs-free job generators run in the same pre-run evaluation as the filter, with both repos on disk. `sourceRepo` and `workflowRepo` are on the generator context, so one workflow repo can produce a different job set per source repo:

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

A needs-free generator is decided before any run exists. When it returns no jobs and the workflow has no other job, no run is created.

A generator that declares `needs` reads its upstream jobs' outputs, and those outputs exist only after the upstream jobs finish. So the pre-run evaluation does not run it. It runs inside the run, after its upstream jobs complete, with their outputs — as it does in a per-repository workflow. It sees both repos on disk and the same `sourceRepo` / `workflowRepo` pair as the pre-run evaluation. The run exists because its upstream jobs exist.

A workflow that has both kinds of generator, or a `filter` and a generator that declares `needs`, needs a pre-run evaluation that runs only the needs-free generators. The orchestrator sends that evaluation only to an agent that reports the `kici:agent-feature:global-eval-skips-result-aware` label. An agent without the label runs every generator in the evaluation, so it would produce the wrong jobs. Run `kici:role:init-runner` agents from the same release as your orchestrator, or a newer one. Each such agent also reports the `globalEvalSkipsResultAwareGenerators` capability when it registers. If every registered init-runner agent reports a version and none reports that capability, the orchestrator does not evaluate these workflows: each one fails at once, and the [evaluation check](#when-does-it-fire) names the cause. The workflows of the same repo that declare no `needs` generator are still evaluated. Otherwise the evaluation waits for an agent that has the label, and fails at the wait ceiling if none arrives.

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

Both lists accept globs. Leading `!` inside a single pattern is not supported here; negation is via the list-is-implicit-deny semantics, so keep it simple (`myorg/ci-*`, `myorg/platform-*`).

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

Both checks read the settings of the organization the **event's source** resolves to. If no webhook source maps the event's routing key to an organization, the orchestrator resolves the built-in `__default__` organization anchor instead. That anchor is an ordinary organization for policy purposes: it carries no per-org lists, so by the empty-list rule above it restricts nothing, and the fleet-wide master switch alone governs it. A deployment whose sources are unmapped — the state a fresh install starts in, since the quickstart configures no sources — runs global workflows normally once that switch is on.

Map a source to a real organization when you want per-org policy to be **expressible**: `kici-admin source update <routingKey> --customer-id <org>`. Allow- and deny-lists are stored per organization, so every unmapped source shares the one policy surface on the `__default__` anchor. That is a reason to map, not a precondition for dispatch.

The registration log line names the organization it decided against, so a refusal is always attributable to a specific policy rather than to the anchor itself. See the troubleshooting table below.

### Secrets come from the workflow repository

A global workflow's job binds contexts the way any job does: only a job that lists `contexts:` receives their variables and secrets. Their rules are checked as the **workflow** repo's. The source repo's contexts never reach a global job.

A context's protection rules read the workflow's side of the run:

| Rule                            | Checked against                                           |
| ------------------------------- | --------------------------------------------------------- |
| Repository patterns             | The workflow repo                                         |
| Branch restrictions             | The branch the workflow repo registered the workflow from |
| Trigger-type filters            | The event that started the run                            |
| Minimum trust                   | The trust tier of that event                              |
| Required reviewers, wait timers | Hold the job, as for any other run                        |

The source repo's branch does not enter the branch check. A push to `main` in a source repo cannot satisfy a rule that guards the workflow repo's `main`. To limit the source branches a global workflow runs on, use `branches:` on its trigger.

To keep a context for your organization-wide workflows only, set its [repository patterns](contexts.md#repository-patterns) to the workflow repo. A source repo that names the context in its own workflow is then rejected. The same rules decide the job's install secrets, its container registry credentials, and its [`gitCredentials`](patterns/git-credentials.md#what-a-job-may-ask-for).

The job is also handed a short-lived clone token for each repo it checks out, which is how the dual checkout works. Each token is minted by the provider of the repo it clones.

#### Keep source-repo code away from bound secrets

A job that binds a context exposes its secrets to every command the job runs. A global job runs the **source** repo's code: `npm install` lifecycle scripts, `npm test`, `make`, a Dockerfile build. So treat a bound context as readable by every source repo the workflow matches:

- Run source-repo code in jobs that bind no context. You can also run it in the source repo itself with [`invokeSource`](#invoking-a-source-repos-own-workflows), where it uses the source repo's own contexts.
- Bind contexts only on jobs that run the workflow repo's own steps: publish, notify, or deploy from artifacts that the unbound jobs built.
- Set a [minimum trust tier](contexts.md#minimum-trust) on every context that a global workflow with a `pr()` trigger binds. A fork pull request's event is untrusted, so its job is held for security review instead of running next to the fork's code with the secrets.

## When does it fire?

Same-repo globals (a workflow in `myorg/app` with `repos: ['myorg/app']`) fire on pushes to `myorg/app`. Cross-repo globals fire on pushes to any source repo whose identifier matches a glob on the authoring workflow's trigger. The orchestrator de-duplicates between the per-repo and cross-repo matching passes, so a single event produces at most one run per (workflow, source-repo, trigger) triple.

Non-push triggers work too — `pr()`, `tag()`, `comment()`, `release()`, `workflowRun()`, etc. all accept `repos:`. `kiciEvent()` / `schedule()` / cron-like triggers have no source repo, so they're always per-org-registered regardless of `repos:`.

A global workflow that declares a `filter` or a needs-free job generator is decided by one **evaluation job per (event × workflow repo)**, dispatched before any run exists. That job checks out both repos once and evaluates every candidate workflow from that repo, so ten global workflows in one CI repo cost one evaluation, not ten.

When that evaluation cannot reach a verdict — it fails, breaches its budget, or never reports — the workflows it was deciding on **do not run**. On a provider that supports commit checks, that posts a `failure` check named **`KiCI: Organization workflow evaluation`** on the source commit, so the outcome is visible instead of silent. Three things to know about it:

- The check is posted whether the evaluation failed **outright** or only **partly**. A per-workflow budget breach, or a `filter` that throws, leaves that one workflow undecided while its neighbours from the same repo are decided and run normally; the check then names only the undecided ones. So a broken `filter` is reported the same way whether or not other global workflows happen to share its repo.
- Branch protection that lists required checks by name is unaffected, because the check is not on that list. Merge automation that requires _every_ check to be green will block on it.
- **Re-run the failed evaluation to clear the check.** A failed evaluation is recorded as one errored run named `__globaleval__<owner>/<workflow-repo>`. Fix the cause, then re-run that run — `kici runs rerun <run-id>`, or the **Re-run** button on the run in the dashboard. The re-run re-evaluates the original event against the workflow repo's current state, dispatches whatever it now admits, and posts a `success` check under the same name on the same commit. The request is **accepted immediately**; the evaluation itself is a job on an agent and runs after the answer, exactly as it does for the push that first triggered it. So watch the run and the check for the outcome, not the response. The check clears only when the re-evaluation reaches a verdict: if it fails again, or the orchestrator cannot run it, the `failure` check stands. A provider redelivery of the same webhook will not do this: it is dropped as a duplicate. Pushing a new commit also works, and is what you need when the payload of the original delivery is no longer stored.
- **Two failed evaluations on one commit share the check.** The check name carries no repo, so if two workflow repos both fail on the same push, re-running one of them posts `success` over the other's `failure`. The success summary names the workflow repo it re-evaluated; re-run the other round too.

## Holds, approvals and pull requests from forks

A global run is held and released like a run of any other workflow.

- **The trust policy applies to global runs.** When the organization's fork switch holds a pull request, it holds the pull request's global runs too, each in the security queue next to the pull request's own runs. Approving the hold dispatches them, still untrusted. Rejecting it cancels them. A hold that expires fails its runs with an expiry reason. On `ignore`, no global run is created either.
- **A held evaluation.** A global workflow that needs a pre-run evaluation does not get one while its event is held, because the evaluation runs the workflow repo's code next to the pull request's code. Instead, the pull request gets one held run per workflow repo, named `__globaleval__<owner>/<workflow-repo>`. It covers every workflow of that repo that needs the evaluation, and every workflow whose only generators declare `needs`. Approving it runs the evaluation at the workflow repo commit recorded when the event was held, then dispatches what the evaluation admits. If a workflow it covers was deleted, disabled, or stopped subscribing to the event in the meantime, the release fails the held run with a reason that names the workflow, and runs nothing.
- **Context rules and `approval` gates hold global jobs.** Required reviewers, wait timers and `minimumTrust` on a bound context hold the job. An `approval` gate holds as it does in a per-repository workflow. See [Approvals](approvals.md). A lock with such a gate needs orchestrator schema v42 or newer; an older orchestrator rejects the lock rather than run the job ungated.

Releasing a hold on a global run needs a member scoped to the **source** repo, because the approval lets code run against that repo. See [Who can see it](#who-can-see-it).

## Re-running an organization-wide run

You can re-run a global run from the dashboard's **Re-run** button or with `kici runs rerun <run-id>`. The re-run checks out the source repo at the run's commit and the workflow repo at the workflow commit the run recorded. It then dispatches through the same path as the first run, so contexts, holds, `approval` gates and the workflow repo's credentials apply again. Like a per-repository re-run, it repeats the workflow's declared jobs. It does not replay jobs that a generator produced.

The re-run is refused, with a reason that names the workflow and the cause, when:

- the workflow repo no longer registers the workflow, or has disabled it;
- the organization's global workflow policy now refuses the workflow repo or the source repo;
- the workflow was not organization-wide at the recorded commit, or declares no static job there;
- the run recorded no workflow commit, so the version it ran cannot be resolved;
- the webhook payload of the original event was not stored.

To re-run a run of an organization-wide workflow, a member needs a role scoped to the **workflow** repo. The re-run executes that repo's code with its contexts and credentials again. A member scoped only to the source repo can read and cancel the run, but not re-run it.

A failed organization-workflow **evaluation** is the exception. Its re-run re-evaluates the original event against the workflow repo's current registrations, and a member scoped to the source repo can request it. See [When does it fire?](#when-does-it-fire).

## Notifications

An organization-wide run belongs to two repositories: the one it executed against, and the one that defines the workflow. A notification subscription's repository filter matches on either. So a subscription scoped to the defining repo hears about every organization-wide run of its own workflows, even though those runs execute against other repositories.

This is the same either-repo rule the run history uses, so the runs a team sees in the dashboard are the runs it is notified about.

## Requirements a filter places on the run

A `filter` reads the source tree, so the evaluation must be able to obtain one. A job that restores its workflow source from the cache and has no source repository to clone from fails with an explicit error rather than evaluating the filter against an empty tree. This applies to dispatch paths that run without a source repository configured — a filter and such a path are mutually exclusive; drop one or the other.

## Troubleshooting

| Symptom                                                                                                       | Likely cause                                                                                                                                                                                                                  | Where to look                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global workflow registered but never runs                                                                     | Master toggle OFF, or allow-list blocks the authoring repo, or deny-list blocks the source repo                                                                                                                               | Orchestrator log: `Skipping global workflow dispatch` (dispatch time) / `Global workflows excluded from registration` (registration time)                                                                                                                                                                                                    |
| A global workflow is never registered at all — it is absent from `kici-admin registration list`               | The fleet-wide master switch is off, or the authoring repo does not match a populated _Allowed author repos_ list.                                                                                                            | Orchestrator log: `Global workflows excluded from registration`, naming the organization it decided against. Check the switch first (`kici-admin cluster-settings show`), then that org's allow-list in the dashboard. An `"orgId": "__default__"` in the line is not itself the fault — that anchor carries no lists and restricts nothing. |
| `repos:` has no effect — workflow only fires on its own repo                                                  | The fleet-wide master switch is off. Without it, the orchestrator treats the workflow as per-repo-only.                                                                                                                       | Check the fleet-wide switch with `kici-admin cluster-settings show`. The dashboard → Settings → Global workflows tab shows it as a read-only badge.                                                                                                                                                                                          |
| A secret is missing in a global job                                                                           | The job does not list the context in `contexts:`, or one of the context's protection rules rejected the job. The rules check the workflow repo and the branch its workflow was registered from, not the source repo.          | The job's failure reason names the context and the rule: `kici runs show <run-id>`. See [Secrets come from the workflow repository](#secrets-come-from-the-workflow-repository).                                                                                                                                                             |
| Dashboard shows workflow twice after registering                                                              | Both a generic webhook source and a provider source (github, generic) re-registered the same repo.                                                                                                                            | Check `workflow_registrations` via `kici-admin workflow list` and confirm the right routing key owns the workflow.                                                                                                                                                                                                                           |
| Global workflow registered, enabled, allowed — and still no run appears                                       | Its `filter` returned `false`. A global filter runs before the run is created, so a suppressed workflow leaves nothing behind at all.                                                                                         | [Reading a global workflow's filter output](#reading-a-global-workflows-filter-output) — the evaluation round's own log. The orchestrator also logs `Global workflow skipped by eval round`, naming the workflow and the reason.                                                                                                             |
| Global workflow never fires for one particular source repo                                                    | Its `repos:` patterns do not match that repo's identifier.                                                                                                                                                                    | Orchestrator log: `Global workflows dropped by their repos filter` — one line per delivery, naming each dropped workflow, its repo and its patterns.                                                                                                                                                                                         |
| A `failure` check named `KiCI: Organization workflow evaluation` on a commit                                  | The pre-run evaluation failed or timed out, so the global workflows from that repo were not run.                                                                                                                              | Orchestrator log for the evaluation job. Fix the cause, then re-run the errored `__globaleval__…` run (`kici runs rerun <run-id>`) to re-evaluate and clear the check; a redelivery is dropped as a duplicate.                                                                                                                               |
| Same-repo workflow shows a `success` run with no jobs in it                                                   | Its `filter` returned `false`. A same-repo filter runs after the run exists, so the run remains, carrying only the evaluation jobs.                                                                                           | The run detail page — the evaluation job's log records the filter verdict.                                                                                                                                                                                                                                                                   |
| A re-run of a global run is refused with "Cannot re-run organization-wide workflow"                           | The workflow repo no longer registers or enables the workflow, the global workflow policy refuses it, or the run recorded no workflow commit.                                                                                 | The refusal names the workflow and the cause. See [Re-running an organization-wide run](#re-running-an-organization-wide-run).                                                                                                                                                                                                               |
| The dashboard refuses to re-run a global run                                                                  | Your role is not scoped to the workflow repo. Re-running a global run needs that scope, because it runs the workflow repo's code with its contexts again.                                                                     | Ask a member scoped to the workflow repo to re-run it.                                                                                                                                                                                                                                                                                       |
| Every global workflow stopped running right after an orchestrator upgrade                                     | The agents were not upgraded first. An agent older than v0.5.0 cannot evaluate a global workflow, and one containing a needs-free `dynamicJob` needs an evaluation even without a `filter` — so its **static** jobs stop too. | The `KiCI: Organization workflow evaluation` check names the agent versions it found. Upgrade every `kici:role:init-runner` agent to v0.5.0 or newer.                                                                                                                                                                                        |
| The evaluation check says every init-runner agent lacks the `globalEvalSkipsResultAwareGenerators` capability | The workflow mixes a `filter` or a needs-free generator with a generator that declares `needs`, and no registered init-runner agent can run that evaluation.                                                                  | Upgrade the `kici:role:init-runner` agents to the release of your orchestrator. See [Generating jobs per source repo](#generating-jobs-per-source-repo).                                                                                                                                                                                     |

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
a commit: the run's own commit belongs to the source repo, and the link does not
follow the workflow repo commit the run used. So the link always shows the file
as it stands now, which may have changed since the run.

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

Re-running follows the other direction: it needs a member scoped to the workflow
repo, because a re-run executes that repo's code with its contexts again. A
failed evaluation round is re-run from the source repo's scope.

Releasing a **held** run is narrowed to the source repo instead: approving a hold
permits code to run against the source repo, so it stays with a member scoped to that repo. A
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

- [Architecture — global workflows](../architecture/global-workflows.md) — dispatch pipeline, which repo each decision uses, cross-provider auth, security model, lock-file schema.
- [Universal-git provider](providers/universal-git.md#global-workflows) — how global workflows interact with `generic:<orgId>:<sourceId>` routing keys.
- [SDK reference](sdk-reference.md) — the full set of triggers that accept `repos:`.
