---
title: 'SDK reference: core'
description: 'Factory functions (workflow, job, step) and authoring patterns: needs, output chaining, dynamic groups'
---

## Factory functions

### workflow(name, options)

Create a workflow containing jobs.

```typescript
function workflow(name: string, options: WorkflowOptions): Workflow;
```

**Parameters:**

| Parameter             | Type                                                                   | Required | Description                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | `string`                                                               | yes      | Unique workflow name                                                                                                                                        |
| `options.jobs`        | `JobOrFactory[]`                                                       | yes      | Static jobs and/or dynamic job generators                                                                                                                   |
| `options.on`          | `Trigger \| Trigger[]`                                                 | no       | When the workflow should trigger                                                                                                                            |
| `options.rules`       | `Rule[]`                                                               | no       | Conditions that must pass for execution                                                                                                                     |
| `options.description` | `string`                                                               | no       | Human-readable description                                                                                                                                  |
| `options.hashFiles`   | `string[]`                                                             | no       | Extra repo-relative paths or globs mixed into the workflow content hash. Changes invalidate the source cache.                                               |
| `options.registries`  | `Registry[]`                                                           | no       | Private npm registries the agent authenticates against before `npm install`. Each `tokenSecret` uses qualified `<environment>:<secret>` syntax.             |
| `options.installEnv`  | `string[]`                                                             | no       | Qualified `<environment>:<secret>` refs projected as env vars onto the install subprocess (used with a customer-committed `.kici/.npmrc`).                  |
| `options.onCancel`    | `HookInput`                                                            | no       | Runs when the workflow is cancelled                                                                                                                         |
| `options.cleanup`     | `HookInput`                                                            | no       | Always runs after the workflow (success, failure, or cancel)                                                                                                |
| `options.onSuccess`   | `HookInput`                                                            | no       | Runs on workflow success                                                                                                                                    |
| `options.onFailure`   | `HookInput`                                                            | no       | Runs on workflow failure                                                                                                                                    |
| `options.concurrency` | `{ group: (ctx) => string; cancelInProgress?: boolean; max?: number }` | no       | Workflow-scoped concurrency. See [Concurrency](../concurrency.md).                                                                                          |
| `options.timeout`     | `number`                                                               | no       | Whole-run wall-clock timeout in milliseconds across all jobs. On breach the orchestrator cancels the run and marks it timed out. See [Timeouts](#timeouts). |

**Returns:** `Workflow` -- an immutable workflow definition.

```typescript
export default workflow('ci', {
  on: [pr({ target: 'main' }), push({ branches: 'main' })],
  rules: [rule('has source changes')],
  jobs: [lint, test, deploy],
  description: 'Main CI pipeline',
});
```

Secret scoping happens at the job level via `environment` (see [job options](#jobname-options--joboptions) and [Secrets](../secrets.md)) — the workflow itself does not declare which secret environments it can read.

### job(name, options) / job(options)

Create a job with an explicit name or auto-generated ID.

```typescript
function job(name: string, options: JobOptions): Job;
function job(options: JobOptions): Job;
```

**Parameters:**

| Parameter                  | Type                                                            | Required             | Description                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | `string`                                                        | no                   | Job name (auto-generated UUID if omitted)                                                                                                                                                                |
| `options.runsOn`           | `RunsOn`                                                        | yes                  | Runner label(s) and optional exclusions (see below)                                                                                                                                                      |
| `options.steps`            | `StepInput[]`                                                   | yes (or use `run`)   | Steps to execute in order. Mutually exclusive with `run`.                                                                                                                                                |
| `options.run`              | `(ctx) => Promise<unknown>`                                     | yes (or use `steps`) | Single-step shorthand -- see [Single-step job shorthand](#single-step-job-shorthand). Mutually exclusive with `steps`.                                                                                   |
| `options.needs`            | `NeedsEntry[]`                                                  | no                   | Job dependencies (must complete first) -- see [Job dependencies (`needs`)](#job-dependencies-needs)                                                                                                      |
| `options.rules`            | `Rule[]`                                                        | no                   | Conditions for conditional execution                                                                                                                                                                     |
| `options.description`      | `string`                                                        | no                   | Human-readable description                                                                                                                                                                               |
| `options.matrix`           | `Matrix`                                                        | no                   | Matrix configuration for job expansion                                                                                                                                                                   |
| `options.include`          | `MatrixInclude[]`                                               | no                   | Additional matrix combinations                                                                                                                                                                           |
| `options.exclude`          | `MatrixExclude[]`                                               | no                   | Matrix combinations to remove                                                                                                                                                                            |
| `options.checkout`         | `boolean`                                                       | no (default: `true`) | When `false`, agent skips git clone. Useful for deploy/notify jobs.                                                                                                                                      |
| `options.container`        | `string \| ContainerConfig`                                     | no                   | Docker image for job execution. String form is the image name; object form adds `env`. All steps run inside the container.                                                                               |
| `options.environment`      | `string \| ((event) => string \| Promise<string>)`              | no                   | Deployment environment for this job. Static string or async/dynamic function -- see [Dynamic values](../dynamic-values.md).                                                                              |
| `options.env`              | `Record<string, string> \| ((event) => Record<string, string>)` | no                   | Environment variables. Static object or async/dynamic function -- see [Dynamic values](../dynamic-values.md).                                                                                            |
| `options.concurrencyGroup` | `string \| ((event) => string \| Promise<string>)`              | no                   | Concurrency group name (defaults to environment name) -- see [Concurrency](../concurrency.md).                                                                                                           |
| `options.onCancel`         | `HookInput`                                                     | no                   | Hook that runs when the job is cancelled                                                                                                                                                                 |
| `options.cleanup`          | `HookInput`                                                     | no                   | Hook that always runs after completion                                                                                                                                                                   |
| `options.onSuccess`        | `HookInput`                                                     | no                   | Hook that runs when the job succeeds                                                                                                                                                                     |
| `options.onFailure`        | `HookInput`                                                     | no                   | Hook that runs when the job fails                                                                                                                                                                        |
| `options.beforeStep`       | `HookInput`                                                     | no                   | Hook that runs before each step                                                                                                                                                                          |
| `options.afterStep`        | `HookInput`                                                     | no                   | Hook that runs after each step                                                                                                                                                                           |
| `options.gracePeriod`      | `number`                                                        | no                   | Seconds before SIGKILL after SIGTERM during cancellation -- see [Hooks](../hooks.md#hook-timeout).                                                                                                       |
| `options.timeout`          | `number`                                                        | no                   | Total job wall-clock timeout in milliseconds (init + all steps + hooks). On breach the job is aborted and reported timed out. See [Timeouts](#timeouts).                                                 |
| `options.resources`        | `ResourceRequest`                                               | no                   | Per-job CPU / memory request and limit. See [Per-job resources](#per-job-resources) below.                                                                                                               |
| `options.init`             | `InitConfig`                                                    | no                   | Per-job initialization run after clone, before steps -- provisions a toolchain. A generic config, a typed preset (`'mise'` / `{ mise }`), `'auto'`, or `false`. See [Per-job init](#per-job-init) below. |

**Returns:** `Job` -- an immutable job definition.

```typescript
// Named job
const build = job('build', {
  runsOn: 'linux',
  steps: [checkout, install, compile],
  needs: [lint],
});

// Anonymous job (auto-generated UUID name)
const build = job({
  runsOn: 'linux',
  steps: [checkout, install],
});
```

#### runsOn forms

A job's `runsOn` selects which agents may run it. Every label listed must be present on the agent (a subset match). It accepts three forms, and each label can be an exact string, a glob, or a regular expression (see [Targeting by pattern](#targeting-by-pattern) below):

```typescript
// 1. Simple string -- agent must have this label
runsOn: 'kici:os:linux'

// 2. Array of required labels -- agent must have ALL labels
runsOn: ['kici:os:linux', 'gpu']

// 3. Object form with exclusions -- agent must have ALL required labels
//    and NONE of the excluded labels
runsOn: { labels: ['kici:os:linux'], exclude: ['kici:host:box-01'] }
```

**The label model:**

- Every agent automatically reports `kici:os:<platform>`, `kici:arch:<cpu>`, and `kici:host:<hostname>`, so `runsOn: 'kici:os:linux'` targets any connected Linux agent without configuring labels — a fresh `kici init` matches out of the box.
- Use **custom labels** (e.g. `'gpu'`, `'prod-pool'`) — defined in your scaler's `labelSet` — to target a specific agent pool.
- You can also target scaler-assigned labels (`kici:agent:<backend>`, `kici:scaler:<name>`), but those names are deployment-specific, so custom labels are more portable.
- `runsOn` is a _requirement_ on candidate agents, never a _grant_: targeting a label only narrows the candidate set. Users cannot _set_ `kici:` labels on agents — that namespace is reserved for the scaler and the agent's self-reported platform facts — but they may freely _target_ any label in `runsOn`.

**Semantics:**

- **Required labels:** The agent must have every label in the `labels` array (or the string/array form).
- **Excluded labels:** The agent must NOT have any label in the `exclude` array. This includes auto-derived labels like `kici:arch:arm64`, `kici:os:linux`, etc.
- **Compile-time validation:** The compiler will error if any label appears in both `labels` and `exclude` (overlap detection).
- **Operator-declared mandatory labels:** Operators may mark a scaler with `mandatoryLabels` (Kubernetes-taint-style opt-in). When a scaler declares a mandatory label, a job is only allowed to land on it if `runsOn.labels` includes that label. A workflow targeting such a scaler must explicitly list the mandatory label in `runsOn`. See the [auto-scaler mandatory labels](../../operator/orchestrator/auto-scaler/common-config.md#mandatory--exclude-labels) for details.

```typescript
// Route to any Linux agent that does NOT have the 'gpu' label
const build = job('build', {
  runsOn: { labels: ['linux'], exclude: ['gpu'] },
  steps: [checkout, compile],
});

// Route to arm64 Linux agents, excluding those with 'staging' label
const deploy = job('deploy', {
  runsOn: { labels: ['linux', 'arch:arm64'], exclude: ['staging'] },
  steps: [deployStep],
});
```

#### Targeting by pattern

Every selector element — in `runsOn`, in `runsOnAll`, on both the include and the exclude side — can be a plain string, a glob pattern, or a regular expression. KiCI picks the matching mode from the value itself:

- **Plain string → exact match.** `'kici:os:linux'` matches the label `kici:os:linux` and nothing else.
- **String with glob metacharacters (`*`, `?`, `[]`, `{}`) → glob.** `'kici:host:web-*'` matches every host label starting with `kici:host:web-`. `'kici:host:box-0[1-3]'` matches `box-01`, `box-02`, `box-03`.
- **`RegExp` literal → regular expression.** `/kici:host:box-0[1-3]/` matches any label the expression matches.

Both the required (include) side and the excluded side accept all three forms:

```typescript
// Glob include + regex exclude, single-agent targeting.
const build = job('build', {
  runsOn: { labels: ['kici:os:linux', 'kici:host:web-*'], exclude: [/.*-canary$/] },
  steps: [compile],
});

// A bare regex picks any agent whose label the expression matches.
const probe = job('probe', {
  runsOn: /kici:host:box-0[1-3]/,
  steps: [smoke],
});
```

In the `runsOnAll` array form, a leading `!` still routes an entry to the exclude side. The `!` is stripped **before** the matching mode is decided, so `'!kici:host:box-*'` is an exclude **glob** and `'!box-01'` an exclude **exact** match. Regular-expression exclusions use the structured `exclude: [/…/]` form (a `RegExp` cannot carry a `!` prefix). The structured `runsOnAll` form below targets every Linux host in the `db` or `replica` role except those whose hostname ends in `-canary`:

```typescript
const fanout = job('deploy', {
  runsOnAll: {
    include: [{ all: ['kici:os:linux', 'kici:host:web-*'] }],
    exclude: [/.*-canary$/],
  },
  run: async (ctx) => {
    /* runs once per matched host */
  },
});
```

**Edge case — custom labels that contain glob metacharacters.** Because the matching mode is inferred from the value, a custom label that literally contains `*`, `?`, `[]`, or `{}` is always treated as a glob and can no longer be matched exactly. Avoid glob metacharacters in label names you intend to target by exact string.

**ReDoS protection.** Glob patterns are linear by construction. A regular expression you supply is validated for catastrophic-backtracking (ReDoS) when you run `kici compile` — a pattern that could hang on a crafted input is rejected with an error, so it never reaches the orchestrator. The orchestrator re-validates every pattern when it loads the lock file.

### step(name, run) / step(name, options)

Create a step with a run function or with typed outputs.

```typescript
// Simple form (no outputs)
function step(name: string, run: StepRunFn): Step;

// Full form (with outputs)
function step<TOutputs extends OutputSchema>(
  name: string,
  options: StepOptions<TOutputs>,
): Step<TOutputs>;
```

**Simple form:**

```typescript
const checkout = step('checkout', async ({ $ }) => {
  await $`git checkout`;
});
```

**With typed outputs:**

```typescript
import { z } from 'zod';

const build = step('build', {
  outputs: {
    version: z.string(),
    artifacts: z.array(z.string()),
  },
  run: async ({ $ }) => {
    await $`pnpm build`;
    return { version: '1.0.0', artifacts: ['dist/main.js'] };
  },
});
```

**StepRunFn type:** `(ctx: StepContext) => Promise<void>`

**With a check facet (idempotent step):**

Add a `check` function to describe _desired state_ instead of a fixed action. When
`check` is present, `run` becomes the _apply_ function and receives the drift value
`check` returned; `summarize` (required) renders that drift for logs and the
dashboard; `whenInSync` optionally produces the step's outputs when already in sync.

```typescript
const configureNginx = step('configure-nginx', {
  check: async (ctx) => ((await inSync(ctx)) ? null : { want: DESIRED }),
  summarize: (drift) => `would rewrite nginx.conf (${drift.want.length} bytes)`,
  run: async (ctx, drift) => {
    await writeConfig(drift.want);
    return { reloaded: true };
  },
  whenInSync: async () => ({ reloaded: false }),
});
```

A checked step can run in apply mode (converge) or `--check` preview mode (report
drift, change nothing). See [Idempotent steps and check mode](../idempotent-steps.md).

### Per-job resources

`options.resources` declares the CPU and memory the job needs. The orchestrator's auto-scaler uses these numbers to:

1. **Bill against capacity caps** (`request`). Decides whether the job can be admitted under the per-scaler `maxAgents`, per-scaler `resourceCap`, orchestrator-wide `globalResourceCap`, and machine-pool caps.
2. **Enforce kernel limits** (`limit`). Sets the cgroup `memory.max` and CPU quota on the running container / VM / scope.

The shape mirrors Kubernetes:

```typescript
const heavy = job('build', {
  runsOn: 'linux',
  resources: {
    requests: { memory: '2g', cpus: 1 },
    limits: { memory: '4g', cpus: 2 },
  },
  steps: [...],
});
```

Three input shapes are accepted; all normalise to the same `{ requests, limits }` pair:

| Shape          | Example                                                    | Effective behavior                               |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Both           | `{ requests: { memory: '2g' }, limits: { memory: '4g' } }` | Used as-is                                       |
| Request only   | `{ requests: { memory: '2g' } }`                           | `limits` mirrors the request                     |
| Limit only     | `{ limits: { memory: '4g' } }`                             | `requests` mirrors the limit                     |
| Flat shorthand | `{ memory: '2g', cpus: 1 }`                                | Both `requests` and `limits` set to these values |

Memory accepts container-style suffixes: `512m`, `4g`, `2048k`. CPUs are fractional cores (`0.5`, `2`).

If `resources` is omitted, the job inherits the matched scaler's label-set or default resources (configured by the operator in `scalers.yaml`). This keeps existing workflows behaving as they did before per-job resources existed.

Per-backend kernel enforcement of `limits`:

- **Container backend** (Docker / Podman): always enforced via cgroup.
- **Firecracker backend:** always enforced. Fractional CPU rounds up to the nearest integer vCPU.
- **Bare-metal backend:** advisory by default — the scaler caps still apply, but no cgroup is created. Operators can opt in to kernel enforcement via `enforceCgroups: true` on the scaler entry.

### Per-job init

`options.init` declares a hand-written command that runs **after the repo is cloned and before the job's steps execute**. Its purpose is to provision a repo-declared toolchain (a `mise` toolchain, a custom setup script, a language runtime) and put it on the environment every subsequent step sees.

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export const build = workflow('build', {
  on: [push()],
  jobs: [
    job('build', {
      runsOn: 'linux',
      init: {
        run: `
          set -euo pipefail
          command -v mise >/dev/null || curl -fsSL https://mise.run | sh
          export PATH="$HOME/.local/bin:$PATH"
          mise install
          mise env -s bash | sed -n 's/^export //p' >> "$KICI_ENV"
          echo "$HOME/.local/share/mise/shims" >> "$KICI_PATH"
        `,
        cache: { key: 'mise-jq-1.7.1', paths: ['~/.local/share/mise'] },
        timeout: 600_000,
      },
      steps: [
        step('show-jq-version', async (ctx) => {
          // jq is on PATH because the init phase appended the mise shims dir to $KICI_PATH.
          const { stdout } = await ctx.$`jq --version`;
          ctx.log.info(`jq version: ${stdout.trim()}`);
        }),
      ],
    }),
  ],
});
```

**`GenericInitConfig` shape:**

| Field     | Type                    | Required | Description                                                                                                                                    |
| --------- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | `string`                | yes      | Command run after clone, before steps. Runs in the job's sandbox at the clone root. Must be a non-empty command.                               |
| `shell`   | `string`                | no       | Shell used to run `run`. Defaults to `bash`.                                                                                                   |
| `cache`   | `CacheSpec`             | no       | Cache spec for binaries the command installs -- restored before the command, saved after on a key miss. See [Caching](./caching.md).           |
| `timeout` | `number`                | no       | Max wall-clock for this init command in milliseconds. Defaults to 10 minutes. On breach the init is aborted and the job is reported timed out. |
| `env`     | `Record<string,string>` | no       | Static environment variables available to the command.                                                                                         |

**The `$KICI_ENV` / `$KICI_PATH` handoff.** The init command does not mutate the step environment directly. Instead it writes what it wants visible to later steps to two files the agent allocates and exposes as environment variables:

- **`$KICI_ENV`** -- append one `KEY=value` line per environment variable. The agent reads the file after the command and makes each variable available to every subsequent step.
- **`$KICI_PATH`** -- append one directory per line. The agent prepends each directory to `PATH` for every subsequent step.

The agent reads both files after the command succeeds, applies the delta, and the resulting environment is visible to all steps that follow (and to any later init command).

**Failure before steps.** If the init command exits non-zero or exceeds its `timeout`, the job **fails before any step runs** -- the init surfaces as a failed `init:<n>` pseudo-step in the run timeline (alongside the step list), its logs are attached, and the step loop never executes. This makes a broken toolchain a clear, early failure rather than a confusing mid-run error.

**Arrays run in order.** Passing `GenericInitConfig[]` runs the inits sequentially; each one's `$KICI_ENV` / `$KICI_PATH` delta is applied before the next runs, so a later init sees an earlier init's tools on `PATH`. The first init to fail stops the sequence and fails the job.

**`init: false`** is an explicit opt-out; it behaves the same as omitting `init`.

#### Toolchain presets

For the common case, a typed preset removes the hand-written `run` block entirely. The agent expands the preset to the same generic init it would otherwise run.

- **`init: 'mise'`** -- zero-config. Installs mise, trusts and runs `mise install` against the committed mise config (`mise.toml` / `.mise.toml` / `.tool-versions`), hands mise's env + shims dir to subsequent steps, and caches mise's data dir under a key derived from the committed config (so a config change rotates the cache). The committed config is trusted automatically — committing it to your repo is the trust signal.
- **`init: { mise: { cache, timeout, env, shell } }`** -- the same preset with overrides. These tune the generic fields a hand-written init exposes (minus `run`): `cache: false` disables caching, a `CacheSpec` replaces the default key/paths, and `timeout` / `env` / `shell` map straight through. `init: 'mise'` is exactly `init: { mise: {} }`.

```typescript
const build = job('build', {
  runsOn: 'linux',
  init: 'mise', // committed mise.toml pins the toolchain; jq, node, etc. land on PATH
  steps: [
    step('show-jq-version', async (ctx) => {
      const { stdout } = await ctx.$`jq --version`;
      ctx.log.info(`jq version: ${stdout.trim()}`);
    }),
  ],
});
```

#### Auto-detect (`init: 'auto'`)

**`init: 'auto'`** detects the toolchain from committed files instead of naming a preset. The agent scans the clone root and selects a preset when a marker is present: `mise.toml` / `.mise.toml` / `.tool-versions` -> the mise preset. With no markers found, `'auto'` is a logged no-op.

`'auto'` is opt-in: an **unset** `init` does nothing even when the repo carries a `mise.toml` for local development. Use `'auto'` to enable detection and `false` to keep the explicit opt-out.

#### Cross-platform

The mise preset works on Linux, macOS, and Windows. On Linux and macOS mise is installed via its standalone install script; on Windows it is installed from its standalone GitHub release. The resulting toolchain reaches every step the same way on all three. On Windows the standalone mise binary requires the Microsoft Visual C++ runtime (`vc_redist.x64`) to be present on the agent host — install it once when provisioning a Windows agent that uses the mise preset.

## Step & job authoring patterns

KiCI supports several authoring patterns for steps and jobs to reduce boilerplate and improve developer experience.

### Bare function steps

Async functions are accepted directly in a job's `steps` array without wrapping in `step()`. They receive auto-generated counter names (`step-1`, `step-2`) at compile time. Return values are captured at runtime.

```typescript
const myJob = job('example', {
  runsOn: 'default',
  steps: [
    async (ctx) => {
      ctx.log.info('hello from bare function');
    },
    step('named', async (ctx) => {
      // Named steps keep their explicit name
    }),
    async (ctx) => {
      // This becomes step-2 (counter skips named steps)
      return { value: 42 };
    },
  ],
});
```

### Id-less steps and jobs

Steps and jobs can be created without a name. The compiler assigns counter-based IDs at compile time.

**Id-less steps:**

```typescript
// Id-less step with just a function
const s = step(async (ctx) => {
  await ctx.$`echo hello`;
});

// Id-less step with full options
const s = step({
  run: async (ctx) => {
    return { version: '1.0.0' };
  },
  timeout: 60000,
});
```

**Id-less jobs:**

```typescript
const deploy = job({
  runsOn: 'default',
  steps: [step('deploy', async (ctx) => { ... })],
});
// deploy.name is a UUID at definition time, replaced with job-1 at compile time
```

### Step output types

Steps have three output tiers:

| Tier | Syntax                         | Naming           | TypeScript Type       | Zod Validation |
| ---- | ------------------------------ | ---------------- | --------------------- | -------------- |
| 1    | Bare function                  | Auto (`step-N`)  | Inferred return type  | No             |
| 2    | `step(name, fn)` or `step(fn)` | Explicit or auto | Inferred return type  | No             |
| 3    | `step(name, { outputs, run })` | Explicit or auto | Inferred + Zod schema | Yes (runtime)  |

```typescript
import { z } from '@kici-dev/sdk';

// Tier 3: step with Zod outputs (validated at runtime)
const build = step('build', {
  outputs: {
    version: z.string(),
    artifact: z.string(),
  },
  run: async (ctx) => {
    return { version: '2.0.0', artifact: 'dist/main.js' };
  },
});
```

### Single-step job shorthand

Use the `run` property as an alternative to `steps` for jobs with a single step:

```typescript
const deploy = job('deploy', {
  runsOn: 'default',
  run: async (ctx) => {
    ctx.log.info('Deploying...');
    return { url: 'https://app.example.com' };
  },
});
```

The `run` function is stored as the job's only step with an auto-generated name (`step-1`). `run` and `steps` are mutually exclusive -- providing both throws an error.

### Timeouts

`timeout` (milliseconds) can be set at three levels. Each level caps **its own scope** independently — a workflow or job timeout is a separate wall-clock cap, **not** a default that flows down to steps.

| Level        | Field                        | Caps                                                   | Enforced by      | On breach                                                         |
| ------------ | ---------------------------- | ------------------------------------------------------ | ---------------- | ----------------------------------------------------------------- |
| **step**     | `step(..., { timeout })`     | A single step's wall-clock.                            | the agent        | The step fails; falls back to the 30-minute default when unset.   |
| **job**      | `job(..., { timeout })`      | The job's total wall-clock (init + all steps + hooks). | the agent        | The job is aborted and reported failed with a "timed out" reason. |
| **workflow** | `workflow(..., { timeout })` | The whole run's wall-clock across all jobs.            | the orchestrator | The run is cancelled with a "timed out" reason.                   |

```typescript
export default workflow('ci', {
  timeout: 1_800_000, // whole run must finish within 30 minutes
  jobs: [
    job('build', {
      runsOn: 'linux',
      timeout: 600_000, // this job (init + steps + hooks) within 10 minutes
      steps: [
        step('compile', {
          timeout: 120_000, // this single step within 2 minutes
          run: async (ctx) => {
            await ctx.$`make build`;
          },
        }),
      ],
    }),
  ],
});
```

**Precedence — each scope caps its own scope.** The three timeouts are independent caps, not a fallback chain:

- A **step** with no `timeout` falls back to the 30-minute agent default, regardless of the job or workflow timeout. A job timeout never becomes a step's default.
- A **job** `timeout` bounds the job's total wall-clock (its init, every step including their own per-step timeouts, and its hooks). It does not change any step's individual cap.
- A **workflow** `timeout` is a run-level deadline. The orchestrator records it when the run starts and cancels the run if its wall-clock exceeds the timeout, even when individual jobs and steps are still within their own caps.

Workflow and job timeouts surface with a distinct "timed out" reason so the dashboard labels the run or job as timed out rather than a generic failure or cancel.

### Output chaining

Steps and jobs can access outputs from preceding steps/jobs using two patterns.

**Within-job output chaining:**

```typescript
const buildStep = step('build', async (ctx) => {
  return { version: '2.0.0' };
});

const lint = async (ctx) => {
  return { warnings: 0 };
};

const pipeline = job('pipeline', {
  runsOn: 'default',
  steps: [
    buildStep,
    lint,
    step(async (ctx) => {
      // Pattern 1: .result proxy on Step objects
      const version = buildStep.result.version;

      // Pattern 2: ctx.outputsOf() for Step or bare function references
      const lintOutputs = ctx.outputsOf(lint);
      console.log(lintOutputs.warnings); // 0
    }),
  ],
});
```

**Cross-job output chaining:**

```typescript
const setup = job('setup', {
  runsOn: 'default',
  run: async (ctx) => {
    return { env: 'production' };
  },
});

const build = job('build', {
  runsOn: 'default',
  needs: [setup],
  steps: [
    step('compile', async (ctx) => {
      return { version: '2.0.0' };
    }),
  ],
});

const deploy = job('deploy', {
  runsOn: 'default',
  needs: [build],
  steps: [
    step(async (ctx) => {
      // Multi-step job: jobRef.result.stepName.field
      const version = build.result.compile.version;

      // Single-step job (run shorthand): jobRef.result.field
      const env = setup.result.env;

      // Explicit context method
      const buildOutputs = ctx.jobOutputs(build);
    }),
  ],
});
```

**Access patterns summary:**

| Pattern                        | Scope                     | Notes                         |
| ------------------------------ | ------------------------- | ----------------------------- |
| `stepRef.result.field`         | Within-job                | Proxy on Step object          |
| `ctx.outputsOf(stepRef)`       | Within-job                | Works with bare function refs |
| `jobRef.result.stepName.field` | Cross-job (multi-step)    | Proxy on Job object           |
| `jobRef.result.field`          | Cross-job (run shorthand) | Flat for single-step jobs     |
| `ctx.jobOutputs(jobRef)`       | Cross-job                 | Explicit context method       |

**Important:** `needs` must be declared explicitly. Output chaining does not auto-infer dependencies -- you must list job dependencies in `needs` even if you access their outputs via `.result`.

Cross-job output chaining works in both local test mode (`kici test`) and remote pipeline execution. The orchestrator's needs-aware dispatch scheduler guarantees upstream jobs reach a terminal state before downstream jobs dispatch, and upstream outputs are transported to the downstream agent sandbox via the `upstreamJobOutputs` field on `job.dispatch`. See [needs-scheduler](../../architecture/execution/needs-scheduler.md) for the full dispatch semantics.

### Job dependencies (`needs`)

The `needs` array accepts four entry forms. Mix freely within the same array.

```typescript
// 1. Reference by Job object (type-safe, preferred)
const test = job('test', { needs: [lint], ... });

// 2. Reference by string name
const test = job('test', { needs: ['lint'], ... });

// 3. Object form with a per-edge run condition (`when`)
const cleanup = job('cleanup', {
  needs: [{ name: 'build', when: 'always' }],
  ...
});

// 4. Dynamic group reference (for static jobs that depend on a dynamicJob group)
const deploy = job('deploy', {
  needs: [dynamicGroup('test-shards')],
  ...
});
```

**Run condition (`when`):** controls when a downstream edge is satisfied, based on the upstream's terminal status. `when` is keyword sugar (or a raw status-set) that resolves at compile time to the set of upstream terminal statuses that satisfy the edge. The downstream edge is satisfied when the upstream's terminal status is a member of that set.

| Keyword                  | Satisfied when the upstream is… | Use for                                     |
| ------------------------ | ------------------------------- | ------------------------------------------- |
| `'on-success'` (default) | `success`                       | normal dependencies                         |
| `'always'`               | any terminal status             | cleanup / notification / teardown jobs      |
| `'on-skip'`              | `success` or `skipped`          | continue when an upstream was narrowed out  |
| `'on-failure'`           | `failed` or `timed_out_stale`   | error-handler jobs that run only on failure |

For full control, pass a raw status-set instead of a keyword: `when: ['skipped', 'failed', 'timed_out_stale']`. The valid members are the terminal job statuses: `success`, `failed`, `cancelled`, `skipped`, `timed_out_stale`, `drift_dropped`.

String and `Job`-reference entries default to `when: 'on-success'`. To override, use the object form (`{ name, when }` for static upstreams, `{ group, when }` for dynamic groups -- `dynamicGroup(name, { when: 'always' })` produces the latter).

When an upstream's terminal status is **not** in the edge's set, the downstream transitions directly to `skipped`. Because a skipped job is itself terminal, this propagates transitively: each downstream's `when` set governs whether the skip cascades further.

**Dispatch gate:** `needs` is a hard dispatch gate. A job dispatches only after every upstream in its `needs` array reaches a terminal status that satisfies that edge's `when` set. Root jobs (empty `needs`, no dynamic group refs) dispatch immediately. The scheduler is DB-backed and fully recovers across orchestrator restarts.

**Reading an upstream's status in a step:** inside a running job, `ctx.needs.<job>.status` exposes each upstream's terminal status (`success`, `failed`, `skipped`, …) and `ctx.needs.<job>.result` its outputs. A group / matrix / `runsOnAll` fan-out upstream is an ordered array of `{ name, result, status }`, one per child. Use this to branch in TypeScript:

```typescript
job('report', {
  needs: [{ name: 'probe', when: 'always' }],
  run: async (ctx) => {
    if (ctx.needs.probe.status === 'failed') await fileIncident(ctx.needs.probe.result);
    else await publish(ctx.needs.probe.result);
  },
});
```

For an arbitrary outcome-based gate that prevents a job from dispatching at all, use a result-aware `dynamicJob` that returns `[]` or `[job]` based on `ctx.needs.<job>.status` — see [Dynamic jobs](../../architecture/execution/dynamic-jobs.md).

**DAG validation:** three-layer cycle detection.

1. Compile time: `validateDag` (see below) catches static-to-static cycles.
2. Eval time: after dynamic jobs are generated, a full topological sort runs on the resolved graph. Cycles reject the run with a clear error.
3. Runtime: a defensive invariant check flags stuck jobs as an internal-bug backstop.

### dynamicGroup(name, options?)

Create a reference to a dynamic job group, for use inside a static job's `needs` array.

```typescript
function dynamicGroup(
  name: string,
  options?: { when?: 'on-success' | 'always' | 'on-skip' | 'on-failure' | string[] },
): DynamicGroupRef;
```

Use when a static downstream must wait for every generated job tagged with a given group name to complete. If the dynamic group produces zero jobs, the downstream dispatches immediately (empty group satisfies all upstreams).

```typescript
const shardedTests = dynamicJob('test-shards', async (ctx) => {
  return ctx.shardIndices.map((i) =>
    job(`test-shard-${i}`, { runsOn: 'linux', run: async () => {} }),
  );
});

const deploy = job('deploy', {
  runsOn: 'linux',
  needs: [dynamicGroup('test-shards')],
  run: async () => {
    // Runs after ALL test-shards jobs have reached a terminal state
  },
});
```

### dynamicJob(groupName, fn)

Tag a dynamic job generator function with a group name so other jobs can reference it via `dynamicGroup()`.

```typescript
function dynamicJob(groupName: string, fn: DynamicJobFn): DynamicJobFn;
```

The generator runs twice: once in the init phase (to register expected job names) and once inside the executing agent (to produce the actual jobs). Mismatches between the two evaluations are detected as determinism drift -- see [dynamic-jobs](../../architecture/execution/dynamic-jobs.md).

### Auto-generated IDs

Unnamed steps and jobs receive counter-based IDs at compile time:

- **Steps:** `step-1`, `step-2`, etc. Counter is scoped per job and only increments for unnamed entries. Named steps do not consume counter values.
- **Jobs:** `job-1`, `job-2`, etc. Counter is scoped per workflow and only increments for unnamed entries.

These IDs are stable as long as the order of unnamed entries does not change. Adding or removing unnamed entries shifts subsequent IDs.
