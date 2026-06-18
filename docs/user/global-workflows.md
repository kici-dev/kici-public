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
| Authoring axis | Policy that answers "which repos may **author** global workflows?" Controlled by the allow-list in the dashboard's _Workflow authors_ setting.         |
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

Patterns in `repos:` use the same globbing as `branches:` / `paths:` — plain globs (`myorg/*`), a leading `!` for exclusions (`!myorg/fork-*`), and a fully-qualified `owner/repo` identity for exact matches (`myorg/platform`). A bare `**` matches every repo in the org.

### At a dual-repo checkout

The agent receives two sets of context during a global workflow execution:

| `env` var                 | Points to                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_SOURCE_REPO_PATH`   | The **source** repo's working tree (the repo that emitted the event). This is the repo the job's `$` / `git` commands operate on by default. |
| `KICI_WORKFLOW_REPO_PATH` | The **workflow** repo's working tree (the repo that authored the workflow). Useful for reading shared scripts or config from your CI repo.   |

Source repo secrets are **not** available to a global workflow's job by default — see _Elevated access_ below.

## Enabling global workflows

Global workflows are **opt-in per org**. In a fresh org, `repos:`-bearing workflows are registered but never dispatched.

1. Open the dashboard → **Settings → Global workflows**.
2. Turn on **Enable global workflows** (the master toggle). This is the kill-switch — every other toggle below is ignored while this is off.
3. Decide which authoring/source controls you need:

| Setting              | What it controls                                                                                                                                                                                     | Typical use                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Workflow authors     | Restricts which repos can **author** (register) global workflows. Globs matched against the authoring repo identifier. When OFF, any repo in the org may author globals.                             | Lock authoring to `myorg/ci-*` so random product repos can't ship org-wide automation.       |
| Blocked source repos | Blocks dispatch for events emitted from these **source** repos, regardless of authoring. Globs matched against the event source repo identifier. When OFF, events from any repo may trigger globals. | Protect against fork spam — e.g. `!myorg/*` via `myorg/fork-*`.                              |
| Elevated access      | Authoring repos listed here get **read access to source-repo secrets** during execution. Globs matched against the authoring repo identifier.                                                        | A `myorg/ci-deploy` repo that needs to read a source repo's `NPM_TOKEN` to publish releases. |

All three lists accept globs. Leading `!` inside a single pattern is not supported here; negation is via the list-is-implicit-deny semantics, so keep it simple (`myorg/ci-*`, `myorg/platform-*`).

### Saving and reverting

The page is a two-state editor — changes are local until you click **Save changes**, and you can abandon them with **Discard changes**. There is no partial save; the PATCH is all-or-nothing per save click.

## Security model

### Two independent axes

A global workflow fires only if:

1. **The authoring repo is allowed.** If _Workflow authors_ is ON, the workflow's authoring repo must match at least one allow-list glob. If OFF, any repo may author. Enforced at two points:
   - At registration time (extraction from the lock file — non-matching globals are dropped with a warning).
   - At dispatch time (defense-in-depth — policy changes after registration still take effect).
2. **The source repo is not denied.** If the event's source repo matches any glob in _Blocked source repos_, the global workflow is skipped. Enforced at dispatch time.

Both checks are logged to the orchestrator. Grep the logs for `Skipping global workflow` to see enforcement in action.

### Elevated access (source-repo secrets)

By default a global workflow's job runs with credentials scoped to the **workflow** repo — it can clone both repos but cannot read the source repo's scoped secrets. That's the safe default: a random workflow in `myorg/ci-pipelines` does not get read access to secrets in `myorg/backend` just because it runs on a push there.

Adding the authoring repo to the _Elevated access_ list flips that: the job receives the source repo's secret context, so deploy and release flows that need `NPM_TOKEN` / `AWS_ROLE_ARN` / etc. from the source repo can read them. Treat elevated repos as effective owners of every source repo's CI secrets — only add repos you fully trust.

## When does it fire?

Same-repo globals (a workflow in `myorg/app` with `repos: ['myorg/app']`) fire on pushes to `myorg/app`. Cross-repo globals fire on pushes to any source repo whose identifier matches a glob on the authoring workflow's trigger. The orchestrator de-duplicates between the per-repo and cross-repo matching passes, so a single event produces at most one run per (workflow, source-repo, trigger) triple.

Non-push triggers work too — `pr()`, `tag()`, `comment()`, `release()`, `workflowRun()`, etc. all accept `repos:`. `kiciEvent()` / `schedule()` / cron-like triggers have no source repo, so they're always per-org-registered regardless of `repos:`.

## Troubleshooting

| Symptom                                                      | Likely cause                                                                                       | Where to look                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Global workflow registered but never runs                    | Master toggle OFF, or allow-list blocks the authoring repo, or deny-list blocks the source repo    | Orchestrator log: `Skipping global workflow dispatch` / `Skipping global workflow registration: not permitted`     |
| `repos:` has no effect — workflow only fires on its own repo | Master toggle OFF. Without opt-in, the orchestrator treats the workflow as per-repo-only.          | Dashboard → Settings → Global workflows (top toggle)                                                               |
| Source repo secrets unavailable in a global job              | Expected default — elevate the authoring repo to grant access.                                     | Dashboard → Settings → Global workflows → _Elevated access_                                                        |
| Dashboard shows workflow twice after registering             | Both a generic webhook source and a provider source (github, generic) re-registered the same repo. | Check `workflow_registrations` via `kici-admin workflow list` and confirm the right routing key owns the workflow. |

## See also

- [Architecture — global workflows](../architecture/global-workflows.md) — dual-query dispatch flow, cross-provider auth, security model, lock-file schema.
- [Universal-git provider](providers/universal-git.md#global-workflows) — how global workflows interact with `generic:<orgId>:<sourceId>` routing keys.
- [SDK reference](sdk-reference.md) — the full set of triggers that accept `repos:`.
