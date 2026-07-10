---
title: Contexts
description: Configure deployment contexts with variables, secrets, and protection rules
---



Contexts represent deployment targets like `staging`, `production`, or `review/PR-*`. Each context can have its own variables, bound secrets, and protection rules that control when and how jobs targeting that context can execute.

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

A pure function like the one above (see [Dynamic values](dynamic-values.md)) is evaluated inline at dispatch with no init-job overhead. Dynamic contexts that match a glob pattern (e.g., `review/*`) inherit the pattern's configuration, variables, and protection rules.

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

**Protection rules combine all-must-pass.** A job must satisfy **every** bound context's gates — adding a context can never loosen access. Branch restrictions, trigger-type filters, and repo patterns must pass for all contexts; the minimum trust tier is the most restrictive across them; required reviewers are the union of all contexts' reviewers; the wait timer is the longest; and the hold expiry is the shortest. If a run is gated out, the rejection names which context and which rule rejected it (visible via `kici runs show <run-id>` and the run's rejection reason), so a mutually-exclusive set of rules surfaces as a clear failure rather than a silent perpetual rejection.

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
  steps: [
    /* ... */
  ],
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

### Required reviewers

Require manual approval before a job can proceed:

```
Required reviewers: alice, bob
```

When reviewers are required, the job enters a "held" state. Reviewers can approve or reject via the dashboard, the [`kici approve`](cli-reference.md#kici-approve) command, or the API. Held runs expire after a configurable timeout.

This operator-set rule is the **mandatory** form of an approval gate. Workflow authors can also declare gates in code with `approval` at step, job, or workflow level — see [Approval gates](approvals.md). Both forms use the same held-element mechanism and the same queue.

### Wait timer

Add a mandatory delay before deployment starts:

```
Wait timer: 300 seconds
```

The job waits for the specified duration before proceeding. Useful for staged rollouts.

### Minimum trust

Gate job execution based on the contributor's trust tier for PR-triggered runs:

```
Minimum trust: known
```

| Value     | Effect                                              |
| --------- | --------------------------------------------------- |
| `known`   | Blocks unknown contributors; allows known + trusted |
| `trusted` | Blocks unknown + known; allows only trusted         |

When a contributor does not meet the minimum trust level, the job is held in the security approval queue. Someone with `ci_trust:write` or higher must approve it before execution proceeds.

Trust tier is determined by the contributor's identity link and CI trust RBAC level:

- **Trusted** -- identity-linked org member with `ci_trust:write+` AND provider write access
- **Known** -- identity-linked member or verified collaborator via provider API
- **Unknown** -- no identity link and no provider access, fork PRs

The trust tier also affects which lock file is used for PR-triggered runs: trusted contributors use the PR head lock file, while known and unknown contributors use the base branch lock file. This prevents untrusted workflow modifications from affecting execution.

See the [CI security architecture docs](../architecture/security/ci-security.md) for the full trust resolution flow.

### Security approval queue

When a PR is held for security review (unknown contributor, workflow modification, or trust policy violation), it enters the security approval queue. This is separate from context-level approval queues.

Held runs can be approved:

- Via the **dashboard** in Settings > CI trust > Approval queue
- Via a PR comment: `/kici approve` (commenter must have `ci_trust:write+`)

Security holds expire after a configurable timeout (default 1 hour).

### Concurrency limits

Control how many jobs can run simultaneously in a context:

```
Concurrency limit: 1
Strategy: queue (or cancel-pending)
```

- **queue** -- new jobs wait in a FIFO queue (with configurable timeout, default 1 hour)
- **cancel-pending** -- pending (queued) jobs are cancelled when the limit is reached

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

3. **Protection** -- configure branch restrictions, required reviewers, wait timers, and concurrency limits with enable toggles for each section.

4. **History** -- view filtered runs targeting this context.

### Bound contexts on runs

A job's bound deployment contexts are shown as chips on the run detail page (in the job metadata panel) in the order the job declared them, and the distinct set across a run's jobs appears as compact chips on the run list. For a multi-context job the chips read left-to-right in merge order — later contexts override earlier ones on key collisions. A `(dynamic)` chip marks a context whose name is computed at runtime; it resolves to the real name once the run starts. A job that binds a single context shows one chip; a job that binds none shows no chip.

If a multi-context binding is gated out, the run's failure banner names which context and which rule rejected it (the same all-must-pass detail surfaced by `kici runs show <run-id>`).

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
