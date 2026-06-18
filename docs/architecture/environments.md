---
title: Environments architecture
description: Data model, protection pipeline, scope resolution, and state machine for deployment environments
---

This document describes the internal architecture of KiCI's deployment environment system, including the data model, protection rule pipeline, scope resolution algorithm, and state machine extensions.

## Data model

### Core tables (orchestrator DB)

```
environments
  id             UUID PK
  org_id         TEXT NOT NULL
  name           TEXT NOT NULL
  type           TEXT NOT NULL ('fixed' | 'glob')
  glob_pattern   TEXT
  enabled        BOOLEAN DEFAULT true
  branch_restrictions    JSONB DEFAULT '[]'
  trigger_type_filters   JSONB DEFAULT '[]'
  repo_patterns          JSONB DEFAULT '[]'
  concurrency_limit      INTEGER
  concurrency_strategy   TEXT DEFAULT 'queue'
  concurrency_timeout_ms INTEGER DEFAULT 1800000
  required_reviewers     JSONB
  wait_timer_seconds     INTEGER
  hold_expiry_seconds    INTEGER DEFAULT 3600
  allow_local_execution  BOOLEAN DEFAULT false
  created_by     TEXT
  created_at     TIMESTAMPTZ
  updated_at     TIMESTAMPTZ
  UNIQUE(org_id, name)

environment_variables
  id              UUID PK
  org_id          TEXT NOT NULL
  environment_id  UUID FK -> environments
  key             TEXT NOT NULL
  value           TEXT NOT NULL
  locked          BOOLEAN DEFAULT false
  UNIQUE(environment_id, key)

environment_source_overrides
  id              UUID PK
  org_id          TEXT NOT NULL
  environment_id  UUID FK -> environments
  routing_key     TEXT NOT NULL
  key             TEXT NOT NULL
  value           TEXT NOT NULL
  UNIQUE(environment_id, routing_key, key)

held_runs
  id              UUID PK
  org_id          TEXT NOT NULL
  run_id          TEXT NOT NULL
  job_id          TEXT NOT NULL
  environment_id  UUID FK -> environments
  hold_type       TEXT NOT NULL
  reason          TEXT NOT NULL
  status          TEXT DEFAULT 'pending'
  approved_by     TEXT
  resolved_at     TIMESTAMPTZ
  expires_at      TIMESTAMPTZ NOT NULL
  created_at      TIMESTAMPTZ
```

### Scoped secrets (orchestrator DB)

Secrets use a scope-based organization model:

```
scoped_secrets
  id       UUID PK
  org_id   TEXT NOT NULL
  scope    TEXT NOT NULL       -- e.g., 'aws/prod', 'databases/postgres'
  key      TEXT NOT NULL       -- e.g., 'DB_PASSWORD'
  ...encryption fields...
  UNIQUE(org_id, scope, key)

environment_bindings
  id              UUID PK
  org_id          TEXT NOT NULL
  environment_id  UUID FK -> environments
  scope_pattern   TEXT NOT NULL  -- glob pattern, e.g., 'aws/prod/**'
```

## Dispatch flow

The environment evaluation is integrated into the orchestrator's webhook processing pipeline:

```
Webhook arrives
  |
  v
1. Dedup check
2. Provider normalize
3. Lock file fetch
4. Changed files check
5. Trigger matching (workflows)
6. Secret resolution (workflow-level, legacy)
7. Per-job environment evaluation:
   |
   v
   7a. Resolve environment name (static from lock file, or via init phase for dynamic)
   7b. Look up environment in DB (EnvironmentStore.matchEnvironment)
       - Fixed: exact name match
       - Glob: picomatch pattern match
   7c. Evaluate protection rules (sequential pipeline)
       - Branch gate -> Trust gate -> Concurrency gate -> Reviewer gate -> Timer gate
   7d. On reject: mark job as rejected, set error_message
   7e. On hold/wait/queue: create held_run, skip dispatch
   7f. On pass: resolve environment variables (VariableStore)
   7g. Resolve per-environment secrets (SecretResolver)
8. Build job config with environment data
9. Dispatch to agent (or queue)
```

### Dynamic field resolution

When a lock file job has dynamic fields (`dynamicEnvironment`, `dynamicEnv`, or `dynamicConcurrencyGroup` set to `true`), the orchestrator resolves them before dispatch. There are two resolution paths:

#### Inline evaluation (schema v11+, `LockInlineValue`)

When a dynamic field's value is a `LockInlineValue` (a pure function serialized as an inline expression), the orchestrator evaluates it directly without dispatching a separate init job. The processor checks `isLockInlineValue()` on `environment`, `env`, and `concurrencyGroup` fields and evaluates the inline expression at the orchestrator. This is the preferred path for simple pure functions.

#### Two-phase init model (complex dynamic functions)

When a dynamic field is `true` but its value is not a `LockInlineValue`, the orchestrator uses a two-phase init model:

**Phase 1 -- Init:**

1. Orchestrator dispatches a lightweight `__init__<workflow>__<job>` job to a builder agent
2. Agent loads the compiled bundle and extracts the workflow/job
3. Agent calls the dynamic function(s) with the normalized webhook event
4. Agent reports resolved values via `job.status` with `data.initResult`
5. Orchestrator receives: `{ environmentName?, env?, concurrencyGroup? }`

**Phase 2 -- Resolution + execution:** 6. Orchestrator treats resolved values as static -- full environment lookup, protection rules, secret resolution, variable merge all proceed normally 7. A fresh execution job is dispatched with everything resolved

**Key properties (both paths):**

- All dynamic fields resolved before dispatch
- Mixed static/dynamic fields are supported (e.g., static `environment` + dynamic `env`)
- Hold/wait/queue behavior is identical to static environments (orchestrator handles after resolution)

**Key properties (two-phase init only):**

- All dynamic fields resolved in a single init call (no separate callbacks per field)
- Init runner runs in its own agent process -- user code never executes in the orchestrator
- Dynamic function evaluation has a 60-second timeout (configurable per-job)
- If a dynamic function throws, the job fails immediately
- If a dynamic function returns undefined, the job proceeds without that field
- Init results are NOT cacheable (functions may be non-deterministic)

## Protection rule pipeline

Gates are evaluated sequentially. The first non-pass result stops evaluation:

```
evaluateProtectionRules(env, ctx, runningCount, concurrencyGroup, trustTier?)
  |
  1. Environment disabled? -> reject
  2. Branch gate:
     - env.branchRestrictions is empty -> pass
     - ctx.branch matches any restriction -> pass
     - else -> reject("Branch 'X' not allowed")
  3. Trust gate:
     - env has no trust requirements -> pass
     - trustTier meets minimum requirement -> pass
     - else -> reject or hold(holdType: 'trust')
  4. Concurrency gate:
     - env.concurrencyLimit is null -> pass
     - runningCount < limit -> pass
     - strategy = 'cancel-pending' -> queue (reason: 'cancel-pending', caller handles cancellation)
     - strategy = 'queue' -> queue
  5. Reviewer gate:
     - env.requiredReviewers is null/empty -> pass
     - else -> hold(holdType: 'reviewer')
  6. Wait timer gate:
     - env.waitTimerSeconds is null -> pass
     - else -> wait(holdUntil: now + timer)
  |
  v
  ProtectionGateResult { action, reason, holdType?, holdUntil? }
```

### Gate result types

| Action   | Meaning                 | Effect                                 |
| -------- | ----------------------- | -------------------------------------- |
| `pass`   | Gate satisfied          | Continue to next gate                  |
| `reject` | Gate failed permanently | Job rejected, error_message set        |
| `hold`   | Awaiting human action   | held_run created, job pending          |
| `wait`   | Time-based delay        | held_run created with expiry           |
| `queue`  | Concurrency full        | Job queued, dispatched when slot opens |

## Scope resolution algorithm

When resolving secrets for an environment, the scope resolver uses a longest-path-wins strategy:

```
Given environment bindings:
  aws/**           -> binds scope 'aws' and all sub-scopes
  aws/prod/**      -> binds scope 'aws/prod' and sub-scopes

Secrets in DB:
  aws/shared       : AWS_REGION = us-east-1
  aws/prod         : AWS_REGION = eu-west-1
  aws/prod         : DB_PASSWORD = secret123

Resolution for environment 'production' (bound to both patterns):
  AWS_REGION = eu-west-1    (aws/prod wins over aws/shared, longer path)
  DB_PASSWORD = secret123   (only in aws/prod)
```

The algorithm:

1. Collect all scope patterns bound to the environment
2. For each pattern, find matching secrets using picomatch glob matching
3. Sort matched secrets by scope path length (descending)
4. Build flat map: last-write-wins on key collisions (longest path = highest priority)

## Test-run access (`allow_local_execution`)

Each environment carries an `allow_local_execution` flag (default `false`) that gates whether a remote test run (`kici run remote`) may target the environment and resolve its secrets.

When the orchestrator resolves secrets for a test run, it combines the developer's CLI-uploaded local secrets (sent encrypted with the run) with test-environment secrets resolved from `scoped_secrets`. The test-environment side is filtered by `allow_local_execution`:

- The job's own declared `environment` and each fixture `secrets: { ctx: envName }` mapping resolve secrets **only** when the target environment has `allow_local_execution = true`. Static strings and pure inline `environment` expressions both participate — the inline expression is evaluated against the fixture's simulated event and the resolved name goes through the same gate. Impure dynamic environments (init-job marker) are not evaluated for test runs and contribute no environment-resolved secrets.
- The gate applies to **all** remote test runs: a run whose matched workflow targets an environment with the flag off is rejected before dispatch.
- A fixture mapping that points a context at a missing environment, or at one whose flag is off, **rejects the run** (fail-closed).
- On a key collision, the CLI-uploaded local value wins over the test-environment value, giving a per-run override.

Production environments left at the default `false` are therefore never reachable by a test run. Operators set the flag with `kici-admin environment set-policy --allow-local-execution true|false` or through the dashboard's per-environment test-runs toggle.

## 7-layer environment variable merge

The agent's `buildSanitizedEnv` function merges variables in this precedence order (last wins):

```
Layer 1: Allowed system vars       -- PATH, HOME, USER (from agent process)
Layer 2: Sandbox defaults           -- FORCE_COLOR=1
Layer 3: KICI_* system vars         -- KICI_RUN_ID, KICI_JOB_NAME, etc.
Layer 4: Org-level environment vars -- from environments DB table
Layer 5: Source-level overrides     -- from environment_source_overrides (skips locked vars)
Layer 6: Job env                    -- from SDK env property (static or evaluated)
Layer 7: setEnv() calls             -- runtime modifications within steps
```

Layers 4-5 are resolved at the orchestrator and passed in `job.dispatch`. Layer 6 comes from the lock file (static) or from the init phase result (dynamic -- resolved before dispatch via the two-phase init model). Layer 7 is agent-side only. Dynamic env vars land at layer 6 with the same precedence as static env vars.

Secrets are NOT injected as environment variables. They flow through IPC and are accessed via `ctx.secrets.get()` and `ctx.secrets.has()`. Users can explicitly inject a secret into `process.env` by calling `ctx.secrets.expose('KEY')`, but this is opt-in and happens at step execution time.

## State machine extensions

The existing run/job state machine is extended with held states:

```
                    held
                   /    \
                  v      v
pending -> queued -> running -> success
                          \-> failed
                          \-> cancelled

held states:
  pending (awaiting approval/timer)
    -> approved (reviewer approves) -> queued -> running
    -> rejected (reviewer rejects) -> cancelled
    -> expired (hold_expiry_seconds exceeded) -> cancelled
```

The `held` and `waiting` states are non-terminal. They resolve to `queued` on success (APPROVE, TIMER_DONE).

## Dashboard CRUD

Environment management in the dashboard goes through the same REST-over-WS proxy pattern KiCI uses for the rest of the dashboard surface.

## Lock file schema

The lock file (v6+) includes per-job environment fields. Schema v11 added `LockInlineValue` as an alternative to the two-phase init model for pure function evaluation:

```json
{
  "jobs": [
    {
      "name": "deploy",
      "environment": "production",
      "dynamicEnvironment": false,
      "env": { "DEPLOY_TARGET": "us-east-1" },
      "dynamicEnv": false,
      "concurrencyGroup": "production-api",
      "dynamicConcurrencyGroup": false
    }
  ]
}
```

- `environment` -- static environment name (`string`) or inline expression (`LockInlineValue`, schema v11+)
- `dynamicEnvironment` -- `true` when environment is a function (resolved via inline evaluation or two-phase init)
- `env` -- static environment variables (`Record<string, string>`) or inline expression (`LockInlineValue`, schema v11+)
- `dynamicEnv` -- `true` when env is a function
- `concurrencyGroup` -- static concurrency group name (`string`) or inline expression (`LockInlineValue`, schema v11+)
- `dynamicConcurrencyGroup` -- `true` when concurrencyGroup is a function
