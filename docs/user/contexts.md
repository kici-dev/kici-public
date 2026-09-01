---
title: Contexts
description: Configure deployment contexts with variables, secrets, and protection rules
---



## Overview

A context in KiCI provides:

- **Variables** -- non-secret key-value configuration (e.g., `API_URL`, `CLUSTER_NAME`)
- **Scoped secrets** -- encrypted values bound to the context via scope bindings
- **Protection rules** -- branch restrictions, required reviewers, wait timers, and concurrency limits
- **Per-source overrides** -- repositories can override unlocked variables for their own deployments

## SDK API

### Job-level context property

The `context` property is set on a job, not a workflow or step:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: [push({ branches: ['main'] })],
  jobs: [
    job('deploy-staging', {
      runsOn: 'default',
      context: 'staging',
      steps: [
        step('deploy', async (ctx) => {
          // ctx.context is the resolved context name
          console.log(`Deploying to ${ctx.context}`);
          // ctx.secrets provides async get/expose/has methods for context-bound secrets
          const dbPassword = await ctx.secrets.get('DB_PASSWORD');
          // Environment variables are in ctx.env
          const apiUrl = ctx.env.API_URL;
          await ctx.$`deploy --target ${ctx.context}`;
        }),
      ],
    }),
  ],
});
```

### Dynamic contexts

The context name can be a string or a function (sync or async) for dynamic contexts (e.g., per-PR review contexts). The function receives the normalized event envelope, with the raw provider body nested at `event.payload`:

```typescript
job('deploy-review', {
  runsOn: 'default',
  context: (event) => `review/PR-${event.payload.pull_request.number}`,
  steps: [
    step('deploy', async (ctx) => {
      // ctx.context is 'review/PR-123' (resolved at runtime)
      await ctx.$`deploy-preview --env ${ctx.context}`;
    }),
  ],
});
```

A dynamic context function like the one above (see [Dynamic values](dynamic-values.md)) is resolved on the eval agent's init step before the job runs. Dynamic contexts that match a glob pattern (e.g., `review/*`) inherit the pattern's configuration, variables, and protection rules.

### Multiple contexts per job

A job can bind more than one context with `contexts`, an ordered array. This lets a single job draw secrets and variables from several contexts at once — for example a shared `staging` context plus a `my-testing` context that carries test-only variables:

```typescript
job('deploy', {
  runsOn: 'default',
  contexts: ['staging', 'my-testing'],
  steps: [
    step('deploy', async (ctx) => {
      // ctx.secrets and ctx.env carry the merged set from both contexts
      const dbUrl = await ctx.secrets.get('DB_URL');
    }),
  ],
});
```

- `context` (singular) and `contexts` (array) are mutually exclusive — setting both is a compile error. `context: 'staging'` is exactly equivalent to `contexts: ['staging']`.
- Each array entry is a static name or a function of the event, resolved per element exactly like a single dynamic context.

**Merge order — last wins.** All bound contexts are resolved on every dispatch (webhook, scheduled, and test runs alike) and merged in array order. When the same secret or variable key is defined in more than one context, the later entry in the array wins. With `contexts: ['staging', 'my-testing']`, a key defined in both resolves to `my-testing`'s value; keys defined in only one are preserved. The longest-scope-path-wins rule still applies _within_ each context.

**Protection rules combine all-must-pass.** A job must satisfy **every** bound context's gates — adding a context can never loosen access. Branch restrictions, trigger-type filters, and repo patterns must pass for all contexts. The minimum trust tier is the most restrictive across them, and required reviewers are the union of all contexts' reviewers. The wait timer is the longest, and the hold expiry is the shortest. If a rule rejects a job, that job is not dispatched. It still appears on the run, as a failed job whose reason names the context and the rule that rejected it. Read the reason with `kici runs show <run-id>`, or on the run detail page.

**Skip-on-test (allow-and-warn).** On a test or local run (`kici run remote`, `kici run <event> --local`), a bound context never rejects the run. Any bound context that disallows local execution (`allowLocalExecution: false`) — or that is not configured — is **skipped**: its variables and secrets are omitted from the merge and its gates are not evaluated. The run proceeds, and a user-visible warning naming the skipped context(s) is shown both on the `kici run remote` CLI output and on the dashboard run view. This makes the test-only-variables pattern work: with `contexts: ['staging', 'my-testing']` where only `my-testing` allows local execution, a test run resolves just `my-testing`'s variables and warns that `staging` was skipped. If every bound context is skipped, the job runs with no environment variables. This is intentionally different from a fixture `secrets:` mapping, which is fail-closed — see the [testing guide](./testing-guide.md).

**Unconfigured contexts contribute nothing at dispatch.** At dispatch time a bound context name with no matching configured context (and no matching glob context) simply adds no variables, secrets, or protection rules — the job still runs, exactly as a single dynamic context resolving to an as-yet-unconfigured name does today.

**Registration rejects a provably-unsatisfiable binding.** When a workflow is registered, KiCI statically checks every multi-context binding: a bound context that does not exist, a disabled one, or two contexts with mutually-exclusive fixed branch / trigger-type / repository restrictions (no value can satisfy both) makes the binding provably unsatisfiable, and the registration is rejected with a precise message naming the job, the contexts, and the rule — for example `unsatisfiable context binding: job 'deploy' binds contexts [staging, my-testing] with mutually exclusive branch restrictions (no value satisfies all bound contexts)`. Bindings whose restrictions use globs are undecidable at registration and fall through to the dispatch-time gate check instead.

### Job-level environment variables

The `env` property on a job provides static or dynamic environment variables:

```typescript
job('deploy', {
  runsOn: 'default',
  context: 'production',
  env: { DEPLOY_TARGET: 'us-east-1' },
  // Or dynamic:
  // env: (event) => ({ DEPLOY_SHA: event.payload.after?.slice(0, 7) }),
  steps: [
    step('deploy', async (ctx) => {
      // DEPLOY_TARGET is available in ctx.env
      await ctx.$`deploy --region ${ctx.env.DEPLOY_TARGET}`;
    }),
  ],
});
```

### Concurrency groups

Jobs can define their own concurrency groups to control concurrent execution within a context. For workflow-level concurrency (which applies to all jobs in a workflow), see [Concurrency groups](concurrency.md).

Control concurrent deployments to the same context:

```typescript
job('deploy', {
  runsOn: 'default',
  context: 'production',
  concurrencyGroup: 'production-api',
  // Or dynamic:
  // concurrencyGroup: (event) => `review-${event.payload.pull_request.number}`,
  steps: [/* ... */],
});
```

If no `concurrencyGroup` is specified, the context name is used as the default concurrency group. For a job bound to multiple contexts, the default is the **first** bound context's name.

### Step context

Inside a step, the `ctx` object provides:

| Property      | Type                                  | Description                                                                               |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ctx.context` | `string \| undefined`                 | Resolved context name (undefined for jobs without context)                                |
| `ctx.env`     | `Record<string, string \| undefined>` | Environment variables (merged from system, org, source, and job-level `env`)              |
| `ctx.secrets` | `StepSecretsTyped`                    | Async accessor for bound secrets (get, expose, has, getMeta, list, mountFile, exposeFile) |

| Method                                       | Returns                   | Description                                                                                                                                                        |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `await ctx.secrets.get(key)`                 | `string`                  | Retrieve a secret value. Throws `SecretNotFoundError` if not found.                                                                                                |
| `await ctx.secrets.expose(key)`              | `void`                    | Set the secret as an environment variable for this step — visible via `ctx.env` and to child processes (`process.env`). Throws `SecretNotFoundError` if not found. |
| `ctx.secrets.has(key)`                       | `boolean`                 | Check if a secret key exists. Synchronous, never throws.                                                                                                           |
| `ctx.secrets.getMeta(key)`                   | `SecretMeta \| undefined` | Retrieve metadata (value, backend name, scope path) for a resolved secret. Returns `undefined` if not found.                                                       |
| `ctx.secrets.list()`                         | `string[]`                | Every secret key available to the step, sorted alphabetically. Synchronous, never throws.                                                                          |
| `await ctx.secrets.mountFile(opts)`          | `{ path }`                | Materialise one or more secrets to a per-step tmpfile (auto-removed at step end). See [Secrets → Mounting secrets as files](secrets.md#mounting-secrets-as-files). |
| `await ctx.secrets.exposeFile(envVar, opts)` | `{ path }`                | `mountFile` plus `process.env[envVar] = path`; the env var is unset at step end.                                                                                   |
| `ctx.setSecretOutput(key, val)`              | `void`                    | Publish an encrypted secret output from this job, consumable by downstream jobs via `needs`. Never logged or stored in plaintext.                                  |

The full secrets API — including `SecretFileOptions`, log masking, and the canonical `sops` example — is documented in [Secrets](secrets.md).

## Environment variable merge precedence

When a job targets a context, variables are merged in this order (last wins):

1. **Allowed system vars** -- `PATH`, `HOME`, etc. from the agent process
2. **Sandbox defaults** -- `FORCE_COLOR=1`
3. **KICI\_\* system vars** -- orchestrator-generated metadata
4. **Org-level context vars** -- from the dashboard, managed per-context
5. **Source-level overrides** -- per-repository overrides (skips locked vars)
6. **Job env** -- from the `env` property in the SDK
7. **`setEnv()` calls** -- runtime modifications within steps

> **Note:** Secrets are NOT part of the environment variable merge. They are delivered to the step context via IPC and accessed through `ctx.secrets`, not through `process.env`. See the [step context](#step-context) section above.

## Protection rules

Contexts can have protection rules that gate job execution:

### Branch restrictions

Limit which branches can deploy to a context:

```
Allowed branches: main, release/*
```

Jobs from other branches are rejected immediately with an error message.

**Most internally-triggered runs carry a branch.** KiCI starts these runs for itself: a [schedule](./sdk/triggers.md) fire, a [custom event](./events.md), a completion trigger, a failure batch, or an [invoke gate](./global-workflows.md) summon. None comes from a branch push. A run with one source branch presents it:

- A **schedule** fire executes the default branch's workflow, so it presents the repository's default branch.
- A **`kiciEvent()` subscriber**, a **completion trigger** (`workflowComplete`, `jobComplete`) and an **invoke-gate summon** present the branch of the run behind them. That is the same branch the run behind them presented. For a pull-request run it is the branch the PR targets, not the contributor's own branch — so a subscriber of an event emitted by a PR against `main` presents `main`.

A branch restriction compares that branch against your patterns like any other run. So a nightly deploy bound to a `production` context restricted to `main` runs.

A branch restriction is not a trust control. It checks the branch a run presents, never where the code came from. A pull request against `main` presents `main`, whoever opened it. To gate on that, set a [minimum trust tier](#minimum-trust) on the same context.

A run with no single source branch presents no branch, and a branch restriction then rejects it:

- A **failure batch** (`workflowsFailedBatch`). One accumulation window of failed runs causes it, on as many branches, so no one branch is its own.
- A **scaler event** (`kici.scaler.scale-up`, `kici.scaler.scale-down`). The orchestrator mints these itself, with no run behind them. See [autoscaling workflows](./workflows/autoscaling-workflows.md).
- A **schedule** fire in a repository that has not pushed to its default branch since you upgraded KiCI. The default branch is captured when a push re-registers the workflows, so the first such push after the upgrade fixes it.
- Any event whose emitting run is no longer on record.

The rejection reason says so:

```
Context 'production' restricts branches: this internally-triggered run carries no
branch, so no branch restriction can be satisfied - a scheduled run gains its
branch after the next push to the default branch re-registers the workflow;
alternatively bind a context without a branch restriction, or restrict by trigger
type instead
```

To limit a context by how the run started instead of by branch, use a **trigger-type filter**: the trigger type is a real name (`schedule`, `kici_event`, `workflow_complete`, `job_complete`), so a filter that allows it works on these runs.

### Required reviewers

Require manual approval before a job can proceed:

```
Required reviewers: alice, bob
```

When reviewers are required, the job enters a "held" state. Reviewers can approve or reject via the dashboard, the [`kici approve`](./cli/runs-and-approvals.md#kici-approve) command, or the API. Held runs expire after a configurable timeout.

This operator-set rule is the **mandatory** form of an approval gate. Workflow authors can also declare gates in code with `approval` at step, job, or workflow level — see [Approval gates](approvals.md). Both forms use the same held-element mechanism and the same queue.

### Wait timer

Add a mandatory delay before deployment starts:

```
Wait timer: 300 seconds
```

The job waits for the specified duration before proceeding. Useful for staged rollouts.

### Minimum trust

Hold a job whose run came from a fork:

```
Minimum trust: trusted
```

| Value     | Effect                                                     |
| --------- | ---------------------------------------------------------- |
| `trusted` | Holds a run whose ref came from a fork                     |
| `known`   | Same effect; the value is deprecated and removed at v1.0.0 |
| (unset)   | No trust-based gating                                      |

Both values block the same thing. Trust comes from the git ref, and that judgement has two answers: a ref in your repository is `trusted`, a ref from a fork is `unknown`. The value you declare still decides the wording of the hold reason.

When the gate holds a job, it enters the security approval queue. Someone with `ci_trust:write` or higher must approve it before execution proceeds.

A run that resolved **no** tier passes the gate. A pull request from a source with no fork model resolves none, and so does an internal run whose inheritance lookup failed. See [trust tiers on internal triggers](events.md#trust-tiers-on-internal-triggers) for the full table.

The trust tier also affects which lock file a pull-request run uses: a trusted ref evaluates the head lock file, a fork ref evaluates the base branch's. A fork run additionally carries no install or registry secrets, and its build-cache writes are confined to that run. So a fork pull request cannot change what CI does, and cannot read a private-registry token, whether or not you set this gate.

Set the gate on any context that carries a credential a fork run must not reach. See the [deployment checklist](../operator/security/security.md#deployment-checklist-which-contexts-need-it).

An internally-triggered run carries a tier too. A schedule fire and the orchestrator's own lifecycle events are trusted. A `kiciEvent()` subscriber inherits the tier of the run that emitted the event, so a `minimumTrust` gate on the subscriber's context reads the **emitting** run's tier. See [trust tiers on internal triggers](events.md#trust-tiers-on-internal-triggers).

See the [CI security architecture docs](../architecture/security/ci-security.md) for the full trust resolution flow.

### Security approval queue

A pull request held for security review enters the security approval queue. Two things put it there: the organization's fork switch set to `hold`, and a `minimumTrust` gate blocking a fork run. This is separate from the context approval queue: a security hold asks "is it safe to run this contributor's code at all?", while a context approval hold asks "should this job be promoted?". The two never cross — releasing a security hold needs `ci_trust:write` or higher, releasing a context approval hold needs `contexts:write` plus eligibility for one of the gate's clauses. See [Approval holds vs security holds](../architecture/approvals.md#approval-holds-vs-security-holds) for the full comparison.

Held runs can be approved:

- Via the **dashboard** on the [Approval queue](dashboard/contexts-and-secrets.md#approval-queue) page, which lists security and context holds together
- Via a PR comment: `/kici approve` (commenter must have `ci_trust:write+`)

A hold raised by the fork switch covers the whole pull request and uses the org's approval expiry (default 72 hours). A `minimumTrust` hold is raised by a context, so it uses that context's own hold expiry (default one hour). A job carrying both a reviewer approval hold and a security hold carries both expiries, and whichever comes first cancels the run.

While the fork switch is holding a pull request, your organization's global workflows do not run for it. Approving the hold releases that pull request's own workflows; it does not retroactively run the organization's global workflows for the event.

### Concurrency limits

Control how many jobs can run simultaneously in a context:

```
Concurrency limit: 1
Strategy: queue (or cancel-pending)
```

The concurrency limit is a positive integer; leave it unset for unlimited concurrency.

- **queue** -- new jobs wait in a FIFO queue (with configurable timeout, default 1 hour)
- **cancel-pending** -- pending (queued) jobs are cancelled when the limit is reached

The children of a matrix job count individually against the limit. A three-child
matrix bound to a context with a limit of two dispatches two children and applies
the strategy above to the third.

## Dashboard management

### Creating contexts

Navigate to **Settings > Contexts** in the dashboard. Click **New context** to choose the context name and type (Fixed or Glob).

- **Fixed** -- applies to jobs that declare exactly this context name, like `staging` or `production`
- **Glob** -- applies to any context name a job declares that matches the pattern, e.g. `review/*` matches a job with `context: 'review/PR-123'`

The contexts list shows each context's type, whether test runs may use it (the `allowLocalExecution` flag -- see the [testing guide](./testing-guide.md)), and whether it is enabled.

### Context detail page

Each context has four tabs:

1. **Variables** -- manage key-value pairs with lock toggles. Locked variables cannot be overridden by source-level overrides. Source overrides are managed in a sub-tab.

2. **Secrets** -- view bound secret scopes and their resolved secret count. Add bindings by specifying scope glob patterns (e.g., `aws/prod/**`).

3. **Protection** -- configure branch restrictions, required reviewers, wait timers, and concurrency limits with enable toggles for each section. Turning a section's toggle off and saving clears that rule on the context, so the gate stops applying to new runs. Emptying the hold expiry field clears it too, and held runs fall back to the default one-hour hold window.

4. **History** -- view filtered runs targeting this context.

### Bound contexts on runs

A job's bound deployment contexts are shown as chips on the run detail page (in the job metadata panel) in the order the job declared them, and the distinct set across a run's jobs appears as compact chips on the run list. For a multi-context job the chips read left-to-right in merge order — later contexts override earlier ones on key collisions. A `(dynamic)` chip marks a context whose name is computed at runtime; it resolves to the real name once the run starts. A job that binds a single context shows one chip; a job that binds none shows no chip.

A job a bound context rejects keeps its chips, and shows as failed because it never ran. Its failure reason names the context and the rule that rejected it. `kici runs show <run-id>` prints the same reason.

### Secrets management

Secrets are individual encrypted values organized by scope paths (e.g., `aws/prod`, `databases/postgres`). Scopes are bound to contexts via bindings:

- **Scope-centric view** (Secrets page): tree view of scopes with per-scope context binding checkboxes
- **Context-centric view** (inside context detail): bound scopes, resolved secrets, add binding

When scope paths collide on the same key name, the longer (more specific) path wins.

## Type generation

Running `kici types` generates two augmented interfaces: `KnownSecretKeys` (union of all secret keys across all contexts) and `ContextSecrets` (per-context key unions):

```typescript
interface KnownSecretKeys {
  DB_PASSWORD: string;
  API_KEY: string;
}

interface ContextSecrets {
  production: 'DB_PASSWORD' | 'API_KEY';
  staging: 'DB_PASSWORD';
}
```

`KnownSecretKeys` narrows `ctx.secrets.get()` and `ctx.secrets.expose()` key parameters to valid key names. `ContextSecrets` maps each context to its available secret key names as a string union. Dynamic contexts fall back to the full `KnownSecretKeys` union.
