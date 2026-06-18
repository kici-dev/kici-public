---
title: 'SDK reference: runtime'
description: Types index, StepContext, secrets, fixtures
---

## Types

All types are exported from `@kici-dev/sdk` as type-only imports.

### Core types

| Type              | Description                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow`        | Workflow definition returned by `workflow()`                                                                                                                                                                                                                                       |
| `WorkflowOptions` | Options for `workflow()` factory                                                                                                                                                                                                                                                   |
| `Job`             | Job definition returned by `job()`                                                                                                                                                                                                                                                 |
| `JobOptions`      | Options for `job()` factory                                                                                                                                                                                                                                                        |
| `Step<TOutputs>`  | Step definition returned by `step()`                                                                                                                                                                                                                                               |
| `StepOptions<T>`  | Options for `step()` factory (full form with outputs)                                                                                                                                                                                                                              |
| `StepRunFn`       | Simple step function type: `(ctx) => Promise<void>`                                                                                                                                                                                                                                |
| `BareStepFn`      | Bare step function (no options, just `(ctx) => ...`)                                                                                                                                                                                                                               |
| `StepInput`       | Union of step input forms accepted by `job()`                                                                                                                                                                                                                                      |
| `OutputSchema`    | Record of Zod types for step outputs                                                                                                                                                                                                                                               |
| `InferOutputs<T>` | Infer output type from output schema                                                                                                                                                                                                                                               |
| `ContainerConfig` | Container config for job execution (`image`, `env?`)                                                                                                                                                                                                                               |
| `RunsOn`          | Union of `runsOn` forms: `string \| RegExp \| (string \| RegExp)[] \| RunsOnSelector`. A plain string matches exactly, a string with glob metacharacters (`*?[]{}`) is a glob, and a `RegExp` is a regular expression. See [Targeting by pattern](./core.md#targeting-by-pattern). |
| `RunsOnSelector`  | Object form for `runsOn` with `labels` (required) and `exclude` (optional) properties. Each element accepts the exact / glob / regex forms on both sides.                                                                                                                          |
| `RunsOnAllInput`  | Union of `runsOnAll` host fan-out forms: `string \| RegExp \| (string \| RegExp)[] \| { include: { all: (string \| RegExp)[] }[]; exclude?: (string \| RegExp)[] }`. Same exact / glob / regex semantics per element. See [runsOnAll](./runs-on-all.md#targeting-by-pattern).      |
| `Fixture`         | Test fixture definition returned by `fixture()`                                                                                                                                                                                                                                    |
| `FixtureOptions`  | Options for `fixture()` factory                                                                                                                                                                                                                                                    |
| `Registry`        | Private npm registry declaration used in `WorkflowOptions.registries`                                                                                                                                                                                                              |

### Trigger types

| Type                            | Description                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `Trigger`                       | Trigger definition (trigger config + source location)                 |
| `TriggerConfig`                 | Union of all 22 trigger config types                                  |
| `PrTriggerConfig`               | PR trigger configuration (from `pr()`)                                |
| `PushTriggerConfig`             | Push trigger configuration (from `push()`)                            |
| `TagTriggerConfig`              | Tag trigger configuration (from `tag()`)                              |
| `CommentTriggerConfig`          | Comment trigger configuration (from `comment()`)                      |
| `ReviewTriggerConfig`           | Review trigger configuration (from `review()`)                        |
| `ReviewCommentTriggerConfig`    | Review comment trigger configuration (from `reviewComment()`)         |
| `ReleaseTriggerConfig`          | Release trigger configuration (from `release()`)                      |
| `DispatchTriggerConfig`         | Repository dispatch trigger configuration (from `dispatch()`)         |
| `CreateTriggerConfig`           | Ref creation trigger configuration (from `create()`)                  |
| `DeleteTriggerConfig`           | Ref deletion trigger configuration (from `delete()`)                  |
| `StatusTriggerConfig`           | Commit status trigger configuration (from `status()`)                 |
| `WorkflowRunTriggerConfig`      | Workflow run trigger configuration (from `workflowRun()`)             |
| `ForkTriggerConfig`             | Fork trigger configuration (from `fork()`)                            |
| `StarTriggerConfig`             | Star trigger configuration (from `star()`)                            |
| `WatchTriggerConfig`            | Watch trigger configuration (from `watch()`)                          |
| `WebhookTriggerConfig`          | Catch-all webhook trigger configuration (from `webhook()`)            |
| `KiciEventTriggerConfig`        | Custom event trigger configuration (from `kiciEvent()`)               |
| `WorkflowCompleteTriggerConfig` | Workflow completion trigger configuration (from `workflowComplete()`) |
| `JobCompleteTriggerConfig`      | Job completion trigger configuration (from `jobComplete()`)           |
| `GenericWebhookTriggerConfig`   | Generic webhook trigger configuration (from `genericWebhook()`)       |
| `ScheduleTriggerConfig`         | Schedule trigger configuration (from `schedule()`)                    |
| `LifecycleTriggerConfig`        | Lifecycle trigger configuration (from `lifecycle()`)                  |
| `PrConfigInput`                 | Config object for `pr()` factory                                      |
| `PushConfigInput`               | Config object for `push()` factory                                    |
| `BranchPattern`                 | `{ type: 'glob', pattern } \| { type: 'regex', pattern, flags? }`     |
| `PrEvent`                       | PR event string literal union (17 event types)                        |
| `GenericWebhookConfigInput`     | Config object for `genericWebhook()` factory                          |
| `GenericWebhookAuth`            | Union of generic webhook auth types (HMAC or API key)                 |
| `GenericWebhookHmacAuth`        | HMAC-SHA256 auth configuration for generic webhooks                   |
| `GenericWebhookApiKeyAuth`      | API key auth configuration for generic webhooks                       |
| `GenericWebhookAuthMethod`      | Auth method string literal (`'hmac-sha256' \| 'api-key'`)             |

### Rule types

| Type                   | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `Rule`                 | Rule definition returned by `rule()` / `skip()`                         |
| `RuleCheckFn`          | `(ctx: RuleContext) => Promise<boolean> \| boolean`                     |
| `RuleContext`          | Context passed to rule check functions                                  |
| `RuleResult`           | Result of rule evaluation (label, passed, duration)                     |
| `EventPayload`         | Discriminated union over event type (narrow on `type` for autocomplete) |
| `RuleEvaluationResult` | Result of `evaluateRules()` (allPassed + results)                       |

### Matrix types

| Type                   | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `Matrix`               | Union: `StaticMatrixArray \| StaticMatrixObject \| DynamicMatrixFn` |
| `StaticMatrixArray`    | `string[]`                                                          |
| `StaticMatrixObject`   | `Record<string, string[]>`                                          |
| `DynamicMatrixFn`      | `(ctx) => Promise<StaticMatrixArray \| StaticMatrixObject>`         |
| `DynamicMatrixContext` | Context passed to dynamic matrix functions                          |
| `MatrixValues`         | Values exposed to steps (`value?` + named dimensions)               |
| `MatrixInclude`        | `Record<string, string>` -- additional combinations                 |
| `MatrixExclude`        | `Record<string, string>` -- removed combinations                    |

### Hook types

| Type              | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `HookConfig`      | Hook definition returned by hook factories (`onCancel()`, etc.) |
| `HookFn`          | Hook function type: `(ctx: HookContext) => Promise<void>`       |
| `HookInput`       | Hook input: `HookFn \| { run: HookFn; timeout?: number }`       |
| `HookContext`     | Context passed to hook functions                                |
| `OutcomeMetadata` | Metadata about the outcome that triggered the hook              |

### Dynamic job types

| Type                | Description                        |
| ------------------- | ---------------------------------- |
| `DynamicJobFn`      | `(ctx) => Promise<Job[]>`          |
| `DynamicJobContext` | Context for dynamic job generators |
| `JobOrFactory`      | `Job \| DynamicJobFn`              |

### Context types

| Type                  | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `StepContext<T>`      | Context passed to step run functions                               |
| `Logger`              | Logger interface (info, warn, error, debug)                        |
| `WorkflowInfo`        | Workflow metadata: `{ name: string }`                              |
| `JobInfo`             | Job metadata: `{ name: string, runsOn: string }`                   |
| `RepoInfo`            | Repository metadata available in step context                      |
| `StepSecrets`         | Async accessor interface for step secrets (`get`, `expose`, `has`) |
| `StepSecretsTyped`    | Typed step secrets with known key inference                        |
| `KnownSecretKeys`     | String literal union of declared secret context keys               |
| `SecretNotFoundError` | Thrown when accessing a nonexistent key in secrets                 |

## StepContext

The context object passed to every step's `run` function:

```typescript
interface StepContext<TInputs = Record<string, unknown>> {
  /** zx shell executor for running commands */
  $: typeof Shell;
  /** Structured logger */
  log: Logger;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Set an environment variable visible to this step and all subsequent steps */
  setEnv(key: string, value: string): void;
  /** Prepend a directory to PATH, visible to this step and all subsequent steps */
  addPath(dir: string): void;
  /** Typed inputs from dependency step outputs */
  inputs: TInputs;
  /** Current workflow metadata */
  workflow: WorkflowInfo;
  /** Current job metadata */
  job: JobInfo;
  /** Matrix values for current job instance (undefined without matrix) */
  matrix?: MatrixValues;
  /** Raw webhook payload from the git provider */
  rawPayload?: Record<string, unknown>;
  /** Which git provider triggered this workflow (e.g. 'github', 'gitlab') */
  provider?: string;
  /** Whether this execution was triggered by `kici test` (remote test run) */
  isTestRun: boolean;
  /** The resolved deployment environment name for this job (undefined without environment) */
  environment?: string;
  /** Flat secrets resolved for this job. Throws SecretNotFoundError on missing key. */
  secrets: StepSecrets;
  /** Emit a custom event that can trigger other workflows */
  emit(
    eventName: string,
    payload?: Record<string, unknown>,
    options?: EventEmitOptions,
  ): Promise<{ deliveryId: string }>;
  /** Resolve outputs from a preceding step by reference */
  outputsOf<T>(ref: { _tag: 'Step'; name: string } | ((...args: any[]) => any)): T;
  /** Resolve outputs from a preceding job by reference */
  jobOutputs(ref: { name: string }): Record<string, unknown>;
  /** Publish a secret output value from this job (encrypted before leaving the agent) */
  setSecretOutput(key: string, value: string): void;
}
```

### Logger

```typescript
interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
```

### Usage

```typescript
step('example', async ({ $, log, env, matrix, workflow, job }) => {
  log.info(`Running in workflow: ${workflow.name}`);
  log.info(`Job: ${job.name} on ${job.runsOn}`);

  if (matrix) {
    log.info(`Matrix value: ${matrix.value}`);
  }

  const token = env.GITHUB_TOKEN;
  await $`echo "Building..."`;
});
```

### `rawPayload` and rule-context parity

`ctx.rawPayload` carries the same data that rule contexts access via `ctx.event.payload` — the unmodified webhook body from the git provider. A rule that branches on `ctx.event.payload.client_payload.foo` and a step body that reads `ctx.rawPayload.client_payload.foo` see the same value. Use it inside steps when the operator's dispatch payload (or any other provider-specific field) needs to drive runtime behavior — e.g. a `--dry-run` toggle or a deploy target — without bouncing the data through an env var.

**What's captured in the dashboard log viewer.** KiCI captures user output from every place in a workflow that can run TypeScript:

- **Inside a step body** — the agent merges three streams into the step's log: `ctx.log.*` structured calls, subprocess stdout/stderr from `ctx.$`, and any direct `console.log` / `.error` / `.warn` / `.info` / `.debug` (or other library that writes to `process.stdout` / `process.stderr`).
- **Inside hooks** (`beforeStep`, `afterStep`, `onSuccess`, `onFailure`, `onCancel`, `cleanup`) — the same three streams are captured; per-step hooks share the step's log, post-loop hooks get their own dashboard row.
- **At workflow module top-level, in rule `check` functions, and in the workflow `concurrency.group` function** — captured to the workflow-level `prepare` log bucket for the job, alongside KiCI's own setup narration.
- **Inside a dynamic `environment` / `env` / `concurrencyGroup` function** on a static job — captured to the `__init__` job's synthetic step-0 log, which appears in the timeline as "Init: _jobname_".
- **Inside a `DynamicJobFn` body and the per-generated-job `environment` / `env` / `concurrencyGroup` / `matrix` functions** — captured to the `__dynamic__` job's synthetic step-0 log ("Evaluate: _jobname_" in the timeline). The `$` parameter in that context is a scoped zx shell, so `await $\`...\`` subprocess output is captured too.

Use whichever style is convenient — you don't have to wrap `console.log` in the provided `log` parameter to make it visible. One limitation applies to in-process contexts only (init, build, dynamic-eval): direct `process.stdout.write` / `printf` is not captured there, because the agent's own logger uses that path and we don't want agent-internal output leaking into your step logs. Use `console.*` or the `log` parameter instead. See [Log streaming](../../architecture/execution/job-execution.md#log-streaming) for the full capture surface and limits (default 10 MB per step, backpressure behavior).

### setEnv(key, value)

Export an environment variable to later steps in the same job. This is the canonical way to hand a value computed in one step to the steps that follow — the equivalent of `echo "KEY=VALUE" >> $GITHUB_ENV` in GitHub Actions. The value is visible to the current step and all subsequent steps in the job.

```typescript
step('setup', async (ctx) => {
  // Install a tool and record its version
  await ctx.$`npm install -g some-tool`;
  const version = (await ctx.$`some-tool --version`).stdout.trim();
  ctx.setEnv('TOOL_VERSION', version);
});

step('use', async (ctx) => {
  // TOOL_VERSION is available here
  ctx.log.info(`Using tool version: ${ctx.env.TOOL_VERSION}`);
});
```

**Behavior:**

- Last-write-wins -- if multiple steps set the same key, the last value is used
- Cannot override operator-injected secrets (the operator value takes precedence)
- Changes take effect immediately in the current step and persist for all subsequent steps
- Shell commands export the same way by appending to `$KICI_ENV` (see [Exporting env from shell commands](#exporting-env-from-shell-commands-kici_env--kici_path) below)

### addPath(dir)

Prepend a directory to `PATH` for the current step and all subsequent steps in the same job. Useful for tools installed to non-standard locations.

```typescript
step('install-go', async (ctx) => {
  await ctx.$`curl -L https://go.dev/dl/go1.22.0.linux-amd64.tar.gz | tar -C /tmp -xz`;
  ctx.addPath('/tmp/go/bin');
});

step('build', async (ctx) => {
  // `go` is now on PATH
  await ctx.$`go build ./...`;
});
```

### Exporting env from shell commands ($KICI_ENV / $KICI_PATH)

`setEnv` and `addPath` are the TypeScript form of "export env to later steps". A shell command — including a non-JS toolchain installer — exports env the same way by appending to two files the agent points at before every step:

- **`$KICI_ENV`** — append `KEY=value` lines. Each becomes an environment variable visible to subsequent steps, exactly like `ctx.setEnv('KEY', 'value')`.
- **`$KICI_PATH`** — append one directory per line. Each is prepended to `PATH` for subsequent steps, exactly like `ctx.addPath(dir)`. The first directory appended ends up first on `PATH`.

```typescript
step('install-tool', async (ctx) => {
  await ctx.$`./install-mytool.sh`; // installs to /opt/mytool
  // Export from the shell, no JS round-trip needed:
  await ctx.$`echo "MYTOOL_HOME=/opt/mytool" >> "$KICI_ENV"`;
  await ctx.$`echo "/opt/mytool/bin" >> "$KICI_PATH"`;
});

step('build', async (ctx) => {
  // MYTOOL_HOME is set and /opt/mytool/bin is on PATH here.
  await ctx.$`mytool build`;
});
```

**Format (v1):**

- One `KEY=value` per line in `$KICI_ENV`. The split is on the first `=`, so the value may contain `=`. Blank lines and lines without a `=` are ignored.
- One directory per line in `$KICI_PATH`. Blank lines are ignored.
- Values must be single-line — embedded newlines are not supported in v1.

**Behavior (shared with `setEnv` / `addPath`):**

- Applied after the step completes and visible to every later step in the job.
- Last-write-wins on a repeated key.
- Cannot override an operator-injected secret — a collision is ignored and logged, and the operator value is preserved.
- The files are reset before each step, so each step sees only its own appended lines.

### setSecretOutput(key, value)

Publish an encrypted secret output from this job. Downstream jobs that list this job in their `needs` array receive the value merged into `ctx.secrets`.

```typescript
const generateToken = job('generate-token', {
  steps: [
    step('create', async (ctx) => {
      const token = (await ctx.$`vault write -f auth/token/create`).stdout.trim();
      ctx.setSecretOutput('DEPLOY_TOKEN', token);
    }),
  ],
});

const deploy = job('deploy', {
  needs: [generateToken],
  steps: [
    step('deploy', async (ctx) => {
      // DEPLOY_TOKEN is available as a secret (decrypted by the orchestrator)
      const token = await ctx.secrets.get('DEPLOY_TOKEN');
      await ctx.$`DEPLOY_TOKEN=${token} ./deploy.sh`;
    }),
  ],
});
```

**Security model:**

- The value is encrypted on the agent before leaving the machine (X25519 ECDH + AES-256-GCM)
- The orchestrator decrypts and re-encrypts with its own key before storing
- The ephemeral key pair is deleted when the run completes (forward secrecy)
- Downstream agents never see the plaintext -- they receive it as part of their injected secrets

**Limits:**

- Maximum 20 secret outputs per job
- Maximum 64 KB per value

### ctx.kici.oidc.token({ audience })

Request a short-lived OIDC ID token for the current job, bound to an `audience`. The token is a signed JWT whose identity claims (`repository`, `ref`, `sha`, `kici_run_id`, `kici_job_id`) are derived by the build platform from the run context — a step cannot spoof them. Use it to authenticate the build to an external service that trusts the platform's OIDC issuer (for example, when generating build provenance).

```typescript
const publish = job('publish', {
  steps: [
    step('mint', async (ctx) => {
      const { token, expiresIn } = await ctx.kici.oidc.token({ audience: 'sigstore' });
      ctx.log.info(`Got an ID token valid for ${expiresIn}s`);
      // Hand `token` to a tool that exchanges it with the trusting service.
    }),
  ],
});
```

**Behavior:**

- The token is short-lived (about 10 minutes) and scoped to the current run and job.
- The returned token value is automatically masked in step logs.
- The step never holds platform credentials — the request is relayed through the orchestrator, which mints the token on the step's behalf.
- Only available inside a running job step; calling it outside one (for example, during local execution) rejects with a clear error.

### ctx.attestProvenance({ subject })

Build, sign, and persist a build-provenance attestation for an artifact your step produced. KiCI assembles an in-toto SLSA v1.0 provenance statement whose build identity (`repository`, `ref`, `sha`, run/job ids) comes from the platform — not from the step — so it cannot be spoofed, signs it, and stores a verifiable bundle that the dashboard surfaces and the `kici verify-attestation` CLI checks.

The artifact is **caller-supplied**: give it either a precomputed digest or a path (relative to the step working directory) that KiCI digests with SHA-256. For a container image, pass the manifest digest your build tool emitted.

```typescript
const publish = job('publish', {
  steps: [
    step('build', async (ctx) => {
      await ctx.$`npm pack`;
    }),
    step('attest', async (ctx) => {
      // Digest a file KiCI hashes for you:
      const result = await ctx.attestProvenance({
        subject: { name: 'my-pkg-1.2.3.tgz', path: 'my-pkg-1.2.3.tgz' },
      });
      ctx.log.info(`Attestation stored at ${result.storageKey}`);

      // Or supply a precomputed digest (e.g. a container manifest digest):
      await ctx.attestProvenance({
        subject: { name: 'ghcr.io/acme/app', digest: { sha256: '<manifest-digest>' } },
      });
    }),
  ],
});
```

**Behavior:**

- The attestation is a signed [DSSE](https://github.com/secure-systems-lab/dsse) envelope over an [in-toto](https://in-toto.io) statement carrying the [SLSA v1.0](https://slsa.dev/spec/v1.0/provenance) provenance predicate.
- It is signed with an ephemeral key bound to a platform-minted identity token, so it is **offline-verifiable** against the platform's published signing keys — no online lookup needed at verify time.
- The bundle is persisted to object storage and recorded so the dashboard can show it and `kici verify-attestation` can retrieve it.
- The returned `{ storageKey, subjectDigest, bundleMediaType }` identifies the stored bundle.
- Only available inside a running job step; calling it outside one (for example, during local execution) rejects with a clear error.

See the [build provenance guide](../provenance.md) for the end-to-end attest →
verify → view journey, including how to verify a bundle with `kici verify-attestation`.

## Secrets

Workflows access secrets through `ctx.secrets` on `StepContext`. Use `await ctx.secrets.get('KEY')` to retrieve a value (rejects with `SecretNotFoundError` if the key is missing, fail-fast on typos), `ctx.secrets.has('KEY')` for a synchronous existence check, and `await ctx.secrets.expose('KEY')` when you need the value as a `process.env` entry for a child process.

### Declaring the secret environment

Each job picks its secret environment via the `environment` option on `job()`. The orchestrator resolves the environment's scoped-secret store at dispatch time, evaluates access rules, and sends the decrypted secrets to the agent:

```typescript
const deploy = job('deploy', {
  runsOn: 'linux',
  environment: 'production',
  steps: [
    /* ... */
  ],
});

export default workflow('deploy', {
  on: push({ branches: 'main' }),
  jobs: [deploy],
});
```

`environment` accepts either a static string or an async function `(event) => string | Promise<string>` for dynamic resolution at trigger-evaluation time. The resolved environment's secrets are flattened into `ctx.secrets`.

### Accessing secrets (ctx.secrets)

`ctx.secrets` provides flat access to the secrets resolved for the job's environment.

```typescript
step('deploy', async ({ secrets }) => {
  // get() rejects with SecretNotFoundError if DEPLOY_TOKEN is not found
  const token = await secrets.get('DEPLOY_TOKEN');

  // Safe check before access (no throw, synchronous)
  if (secrets.has('OPTIONAL_KEY')) {
    const optional = await secrets.get('OPTIONAL_KEY');
  }
});
```

**Throw behavior:** `get()` rejects with `SecretNotFoundError` and the message lists all available keys. This catches typos immediately rather than producing silent `undefined` values.

### Complete example

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

const deploy = job('deploy', {
  runsOn: 'linux',
  environment: 'production',
  steps: [
    step('deploy', async (ctx) => {
      const token = await ctx.secrets.get('DEPLOY_TOKEN');

      // Safe check before access
      if (ctx.secrets.has('OPTIONAL_NOTIFICATION_URL')) {
        const url = await ctx.secrets.get('OPTIONAL_NOTIFICATION_URL');
        ctx.log.info('Sending notification...');
      }

      // Pass to subprocess explicitly (secrets are NOT auto-injected as env vars)
      await ctx.$`DEPLOY_TOKEN=${token} ./scripts/deploy.sh`;
    }),
  ],
});

export default workflow('deploy-production', {
  on: push({ branches: 'main' }),
  jobs: [deploy],
});
```

### Security notes

- Secrets are **not** automatically injected as environment variables. You must explicitly pass them to subprocesses.
- All secret values are automatically **masked** in log output. If a step logs a string containing a secret value, the value is replaced with `***`.
- Secrets flow from the orchestrator to the agent via the authenticated WebSocket channel. The Platform tier never handles secret material.

### Enumerating available keys (ctx.secrets.list)

`ctx.secrets.list()` returns every secret key available to the step, sorted alphabetically. Synchronous, never throws, names only — call `getMeta(key)` to inspect backend / scope per key. Useful when the set of provisioned keys isn't known at workflow-author time, for example to pick up every `AGE_KEY_*` the operator has seeded:

```typescript
step('discover', async (ctx) => {
  const ageKeys = ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_'));
  ctx.log.info(`Found ${ageKeys.length} age keys`);
});
```

### File-mounted secrets (ctx.secrets.mountFile / exposeFile)

Tools that require a file path on disk (sops `SOPS_AGE_KEY_FILE`, kubectl `KUBECONFIG`, gcloud `GOOGLE_APPLICATION_CREDENTIALS`) get a typed step-side API: `ctx.secrets.mountFile(opts)` writes the concatenation of one or more existing secrets to a per-step tmpfile and returns the path; `ctx.secrets.exposeFile(envVar, opts)` additionally sets `process.env[envVar] = path`. Files are removed and env vars are unset automatically when the step completes (success, failure, or timeout) — no manual cleanup. See [Mounting secrets as files](../secrets.md#mounting-secrets-as-files) for the full options table, lifecycle details, and the canonical sops example.

### Local test mode secrets

When running `kici test`, you can provide secrets locally without an orchestrator.

#### .kici/.secrets file

Create a `.kici/.secrets` file in your project (auto-gitignored by `kici init`):

```ini
# Flat secrets (before any section)
DEPLOY_TOKEN=my-deploy-token
API_KEY=my-api-key

# Context-scoped secrets
[production]
DB_PASSWORD=prod-secret
API_KEY=prod-key

[npm-publish]
NPM_TOKEN=npm-abc123
```

Lines before any `[section]` header are flat secrets. Lines within a section become context-scoped secrets. Comments start with `#`. Values are everything after the first `=` (so values can contain `=` characters).

#### CLI flags

Override or supplement file-based secrets with CLI flags:

```bash
# Inject flat secrets (repeatable)
kici test push --secret DEPLOY_TOKEN=my-token --secret API_KEY=my-key

# Inject context-scoped secrets (repeatable)
kici test push --context production.DB_PASSWORD=prod-secret --context npm-publish.NPM_TOKEN=abc123
```

**Precedence:** CLI flags override `.kici/.secrets` file values. Context secrets are auto-flattened into `ctx.secrets` using the same merge logic as production (last context wins).

## Fixtures

Test fixtures define event replicas for `kici run remote`. They simulate trigger events without requiring real webhooks.

### fixture(id, options)

```typescript
function fixture(
  id: string,
  options: FixtureOptions | (() => FixtureOptions | Promise<FixtureOptions>),
): Fixture;
```

**Parameters:**

- `id` — unique fixture name (no whitespace). Used in `kici run remote <id>`.
- `options` — a `FixtureOptions` object, or an async factory function returning one.

```typescript
import { fixture, push } from '@kici-dev/sdk';

export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});
```

### FixtureOptions

| Property       | Type                     | Description                                                |
| -------------- | ------------------------ | ---------------------------------------------------------- |
| `event`        | `TriggerConfig`          | The trigger event to simulate (required)                   |
| `branch`       | `string`                 | Override branch name (defaults to git-detected)            |
| `sha`          | `string`                 | Override commit SHA (defaults to HEAD)                     |
| `repo`         | `string`                 | Override repository (defaults to git-detected)             |
| `pr`           | `number`                 | For PR events, override PR number                          |
| `secrets`      | `Record<string, string>` | Secret context mappings: `{ localName: 'remote-context' }` |
| `workflowName` | `string`                 | Bypass trigger matching and run this workflow directly     |

Options can also be provided as an async factory function for dynamic fixture generation.
