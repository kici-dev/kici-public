---
title: Secrets
description: How to access secrets in KiCI workflow steps
---

KiCI provides an explicit secrets API that gives workflow steps controlled access to secrets stored in the orchestrator's secret store. Secrets are never auto-injected into `process.env` -- you must explicitly request each secret by name.

## Overview

Secrets are managed per-environment in the orchestrator (see [operator docs](/operator/orchestrator/configuration) for setup). When a job runs with an `environment` binding, the agent receives the secret keys available for that environment but does **not** inject their values into the step's process environment. Instead, steps access secrets through the `ctx.secrets` API.

This design prevents accidental secret leakage through child processes, log output, or error messages. Only secrets you explicitly request are loaded into memory.

## Where secret values come from

Secret values are written either through the dashboard or through `kici-admin` running against the orchestrator. The orchestrator operator decides — per organization — which surface accepts secret writes. From the workflow author's perspective, the resolution path at run time is identical either way; the difference is where you (or your ops team) **enter** the value.

### Default — dashboard or CLI

A fresh orchestrator starts in **permissive** mode: both surfaces are available.

- **Dashboard:** Settings → Secrets → pick a scope → enter the secret name and value.
- **CLI:** `kici-admin secret set --scope <scope> <KEY>` against the orchestrator's HTTP admin API.

Use whichever fits the workflow — most small teams stay on the dashboard; ops engineers and CI scripts use the CLI.

### When the operator has disabled dashboard writes

The orchestrator operator can flip `secrets.set` (and `variables.set`) to **CLI-only** as part of the [dashboard-write policy](/operator/security/dashboard-write-policy). When that flip is on:

- The dashboard's "Add secret" / "Edit value" controls render with a lock icon. Clicking them shows a tooltip with the exact `kici-admin secret set` invocation needed.
- The dashboard's secrets page still lists secret **names**, scopes, and bindings — only the value-entry path moves to the CLI.
- `kici-admin secret set` becomes the single entry point for new and updated secret values.

This configuration is common for SOC2-prep and regulated workloads, where the customer requirement is "the SaaS control plane process never receives plaintext customer secret values." The dashboard remains usable for everything else (read paths, name CRUD, environment bindings).

### CLI input modes

`kici-admin secret set` accepts five input modes — pick the one that fits your workflow:

```bash
# Interactive prompt (default when stdin is a TTY). No echo, no shell history.
kici-admin secret set --scope production DB_PASSWORD --prompt

# Pipe from another tool (default when stdin is not a TTY).
pass show prod/db | kici-admin secret set --scope production DB_PASSWORD --from-stdin

# Read from a file (handy after `sops -d` to a tmpfile).
kici-admin secret set --scope production DB_PASSWORD --from-file ./db.pass

# Read from a named environment variable (CI-friendly).
KICI_SECRET_VALUE=$(my-secrets-fetcher prod db) \
  kici-admin secret set --scope production DB_PASSWORD --from-env KICI_SECRET_VALUE

# Direct argv — discouraged. Prints a stderr warning ("visible in shell history").
kici-admin secret set --scope production DB_PASSWORD --value "<plaintext>"
```

Two cross-cutting flags help every mode:

- `--confirm-fingerprint <hex>` — pre-compute SHA-256 of the value and pass it. The CLI rejects the call if the value's fingerprint doesn't match. Catches paste corruption.
- `--dry-run` — parse and validate the value, print `[dry-run] would set <key> in scope <scope> sha256=<hex>`, exit without writing.

`kici-admin variable set` uses the same flags for non-encrypted variables, plus `--locked` to mark a variable as immutable from subsequent dashboard writes.

A full reference of input modes — including the default-mode resolution rules and the security trade-offs of each — lives in [Dashboard-write policy → CLI input modes](/operator/security/dashboard-write-policy#cli-input-modes-for-the-plaintext-path).

## Accessing secrets

Use `ctx.secrets.get(key)` to retrieve a secret value. The method is async to support process-level step isolation in future versions.

```typescript
import { workflow, job, step } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: [push({ branches: ['main'] })],
  jobs: [
    job('deploy', {
      runsOn: 'default',
      environment: 'production',
      steps: [
        step('deploy', async (ctx) => {
          const token = await ctx.secrets.get('DEPLOY_TOKEN');
          await ctx.$`deploy --token ${token}`;
        }),
      ],
    }),
  ],
});
```

If the secret does not exist, `get()` throws a `SecretNotFoundError` with a descriptive message.

## Exposing secrets to shell commands

When you need a secret available as an environment variable for shell commands (e.g., tools that read `$API_KEY` from the environment), use `ctx.secrets.expose(key)`:

```typescript
step('run-tool', async (ctx) => {
  // Injects MY_API_KEY into process.env for this step only
  await ctx.secrets.expose('MY_API_KEY');

  // Now child processes can read it from the environment
  await ctx.$`some-tool --use-env-auth`;
});
```

`expose()` sets `process.env[key]` to the secret value. This is scoped to the step's child process -- it does not leak to other steps or jobs.

## Checking secret existence

Use `ctx.secrets.has(key)` to check whether a secret is available without retrieving its value:

```typescript
step('conditional-notify', async (ctx) => {
  if (ctx.secrets.has('SLACK_WEBHOOK')) {
    const webhook = await ctx.secrets.get('SLACK_WEBHOOK');
    await ctx.$`curl -X POST ${webhook} -d '{"text": "Deploy complete"}'`;
  } else {
    console.log('Slack webhook not configured, skipping notification');
  }
});
```

`has()` is synchronous and does not load the secret value.

## Mounting secrets as files

Some tools refuse to read credentials from environment variables and require a file path on disk (for example, `sops` reads `SOPS_AGE_KEY_FILE`, `kubectl` reads `KUBECONFIG`, and `gcloud` reads `GOOGLE_APPLICATION_CREDENTIALS`). The secrets API materialises one or more existing string secrets to a tmpfile for the lifetime of the step.

### list()

`ctx.secrets.list()` returns every secret key available to the step, sorted alphabetically. It is synchronous, never throws, and returns names only — call `getMeta(key)` to inspect the backend and scope for a specific key.

```typescript
step('discover-keys', async (ctx) => {
  // Pick up every age key the operator has provisioned.
  const ageKeys = ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_'));
  ctx.log.info(`Found ${ageKeys.length} age keys`);
});
```

### mountFile(opts)

`ctx.secrets.mountFile(opts)` writes the concatenation of one or more existing secrets to a tmpfile inside a per-step tmpdir and returns the absolute path. The file is removed automatically when the step completes (success, failure, or timeout).

Options:

- `sources: string[]` — secret keys to concatenate (in order). Required.
- `divider?: string` — separator written between concatenated values. Default: no divider.
- `mode?: number` — permission bits to chmod the file to. Default: `0o600` (owner read/write only).
- `name?: string` — filename inside the per-step tmpdir. Default: auto-generated.

If any source key is missing, `mountFile` rejects with `SecretNotFoundError` listing every missing key.

```typescript
step('decrypt', async (ctx) => {
  const ageKeys = ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_'));
  const keyFile = await ctx.secrets.mountFile({
    sources: ageKeys,
    divider: '\n',
  });
  await ctx.$`sops --age-key-file ${keyFile.path} -d secrets.enc.yaml`;
});
```

### exposeFile(envVar, opts)

`ctx.secrets.exposeFile(envVar, opts)` is `mountFile` plus `process.env[envVar] = path`. The env var is unset and the file is removed when the step completes. The customer controls every env var name — there is no implicit `KICI_SECRET_FILE_*` naming.

```typescript
step('deploy', async (ctx) => {
  await ctx.secrets.exposeFile('SOPS_AGE_KEY_FILE', {
    sources: ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_')),
    divider: '\n',
  });

  // sops reads SOPS_AGE_KEY_FILE from the environment.
  await ctx.$`sops -d secret.enc.yaml`;
});
```

### Lifecycle and cleanup

- **Lazy allocation:** no tmpdir is created until the first `mountFile` / `exposeFile` call. Steps that never mount pay nothing.
- **Per-step tmpdir:** allocated under the OS temp directory and bound to a single step. Two mounts in the same step share the same tmpdir; the runtime auto-suffixes filenames when no `name` is supplied.
- **Automatic cleanup:** when the step returns (success), throws (failure), or times out, the runtime removes the tmpdir and unsets any env var set via `exposeFile`. There is nothing to clean up by hand.
- **Sandbox container:** when the agent runs the step inside a container or microVM, the tmpdir lives on the sandbox's `/tmp` (a fresh tmpfs in the production sandbox profile). The file is gone when the sandbox is torn down.

### Log masking

Mounted file contents are registered with the log masker, so a subprocess that echoes the credential (e.g. a tool that prints its loaded credential on `--debug`) sees `***` in the streamed log instead of the raw value. This covers the case where `mountFile` joins two source secrets into a brand-new byte sequence neither original value would mask on its own.

### Canonical sops example

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('decrypt-and-deploy', {
      runsOn: 'default',
      environment: 'production',
      steps: [
        step('decrypt', async (ctx) => {
          const ageKeys = ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_'));
          await ctx.secrets.exposeFile('SOPS_AGE_KEY_FILE', {
            sources: ageKeys,
            divider: '\n',
          });
          await ctx.$`sops -d secret.enc.yaml > config.yaml`;
          // No cleanup -- the tmpdir + the SOPS_AGE_KEY_FILE env var
          // are removed automatically when this step returns.
        }),
      ],
    }),
  ],
});
```

### Injecting decrypted sops values into the environment

KiCI does **not** scan your repository for `*.enc.yaml` files and auto-decrypt them into the environment at job init — nothing in a job runs `sops` on your behalf, and resolved secrets are never auto-injected as environment variables (see [Security notes](./sdk/runtime.md#security-notes)). Decryption is always something your workflow does explicitly: provision the age (or other) decryption key as a KiCI secret, expose it for the step, run `sops -d`, and decide what to do with the output.

When you want the decrypted values available as environment variables — not just written to a file — decrypt early and export the values through `$KICI_ENV` (or `ctx.setEnv`). Anything appended to `$KICI_ENV` becomes an environment variable for every later step in the same job, so a single decrypt step can populate the environment for the whole job:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('decrypt-and-deploy', {
      runsOn: 'default',
      environment: 'production',
      steps: [
        step('decrypt-to-env', async (ctx) => {
          await ctx.secrets.exposeFile('SOPS_AGE_KEY_FILE', {
            sources: ctx.secrets.list().filter((k) => k.startsWith('AGE_KEY_')),
            divider: '\n',
          });
          // Decrypt to dotenv format, then append every KEY=value line to
          // $KICI_ENV so subsequent steps see them as environment variables.
          await ctx.$`sops -d --output-type dotenv secrets.enc.yaml >> "$KICI_ENV"`;
        }),
        step('deploy', async (ctx) => {
          // Values decrypted above are now ordinary env vars here.
          await ctx.$`./deploy.sh`;
        }),
      ],
    }),
  ],
});
```

Decrypted values exported this way follow the same rules as any other `$KICI_ENV` / `ctx.setEnv` export: last-write-wins on a repeated key, and a key that collides with an operator-injected secret is ignored (the operator value wins). See [Exporting env from shell commands](./sdk/runtime.md#exporting-env-from-shell-commands-kici_env--kici_path) for the full `$KICI_ENV` contract.

If you only need the decrypted material as a file on disk (the common `kubectl` / `gcloud` case), skip the env hop and redirect to a file instead — see the [canonical sops example](#canonical-sops-example) above.

## API reference

| Method       | Signature                                                                | Description                                                                        |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `get`        | `get(key: string): Promise<string>`                                      | Retrieve a secret value. Throws `SecretNotFoundError` if not found.                |
| `expose`     | `expose(key: string): Promise<void>`                                     | Set `process.env[key]` to the secret value for child process access.               |
| `has`        | `has(key: string): boolean`                                              | Check if a secret key is available (synchronous).                                  |
| `getMeta`    | `getMeta(key: string): SecretMeta \| undefined`                          | Get metadata (backend name, scope) for a secret. Returns `undefined` if not found. |
| `list`       | `list(): string[]`                                                       | Sorted array of every secret key available to the step. Synchronous, never throws. |
| `mountFile`  | `mountFile(opts: SecretFileOptions): Promise<{ path: string }>`          | Materialise one or more secrets as a tmpfile. Auto-cleanup at step end.            |
| `exposeFile` | `exposeFile(envVar: string, opts: SecretFileOptions): Promise<{ path }>` | `mountFile` plus `process.env[envVar] = path`. Env var unset at step end.          |

## Migration from property access

If upgrading from a previous version that used property access (`ctx.secrets.KEY`), update your workflow code:

```typescript
// Before (old API)
const token = ctx.secrets.DEPLOY_TOKEN;

// After (new API)
const token = await ctx.secrets.get('DEPLOY_TOKEN');
```

For conditional access:

```typescript
// Before (old API)
if (ctx.secrets.DEPLOY_TOKEN) { ... }

// After (new API)
if (ctx.secrets.has('DEPLOY_TOKEN')) { ... }
```

Note that `get()` is async -- you must `await` the result.

## Typed secrets

When you run `kici types`, the compiler generates a `.kici/secrets.d.ts` file that provides type-safe autocompletion for your secret keys. The generated types augment the `StepSecrets` interface so that `ctx.secrets.get('...')` and `ctx.secrets.has('...')` offer suggestions for known keys.

See [CLI reference](/user/cli) for the `kici types` command.
