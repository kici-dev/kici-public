---
title: 'kici: authoring & local dev'
description: 'Compile, preview, local execution, fixtures, types, workflows, hooks, and docs'
---

## Guide

### kici compile

Compile workflows from `.kici/workflows/` to `kici.lock.json`.

```bash
kici compile [options]
```

**Examples:**

```bash
# Compile all workflows
kici compile

# Validate and type-check (CI-friendly, no file writes)
kici compile --check

# Watch mode for development
kici compile --watch

# Custom .kici directory location
kici compile --kici-dir packages/app/.kici

# Verbose output for debugging
kici compile --verbose
```

**Exit codes:**

| Code | Meaning                     |
| ---- | --------------------------- |
| 0    | Compilation successful      |
| 1    | Compilation failed (errors) |

The `--check` flag is useful in CI pipelines and pre-commit hooks. It validates that workflows are syntactically and semantically correct **and** runs a `tsc --noEmit` type-check over `.kici/workflows/**`, so type-broken workflows are caught at compile time instead of shipping silently. No lock file or other files are written.

The type-check requires `.kici/tsconfig.json` and a `typescript` dependency — both are scaffolded by `kici init`. In a JavaScript-only workspace (`kici init --mjs`, which has no `tsconfig.json`), the type-check is skipped with a notice and validation still runs. When the type-check finds errors, `kici compile --check` prints each one in `file:line:column error [E120]: message` form and exits non-zero.

Compile and validation errors carry the real `file:line:column` of the offending job or step (anchored to the job's first step location), so you can jump straight to the source instead of a generic line 1.

**Auto-type regeneration:** When authenticated (via `kici login`), `kici compile` automatically refreshes `.kici/types/secrets.d.ts` after each successful compilation. This keeps type declarations in sync with your orchestrator's secret contexts. The type regeneration is non-blocking -- if the orchestrator is unreachable, compilation still succeeds with a warning. The `--check` flag skips type regeneration since no files are written.

### kici preview

Preview which workflows match a trigger event (dry-run, no execution). Useful for verifying trigger configurations during development.

```bash
kici preview [event] [options]
```

**Examples:**

```bash
# Preview which workflows match a push event
kici preview push

# Preview PR trigger matching
kici preview pr:open

# Preview with branch override
kici preview push --branch develop

# Filter to specific workflow
kici preview push --workflow ci

# Simulate changed files for path-filtered triggers
kici preview push --files src/index.ts --files README.md
```

**Exit codes:**

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | Preview completed (including zero matches) |
| 1    | Error                                      |

**Migration from the old `test` command:** The dry-run preview command was renamed from `test` to `preview`. If you were using the old `test` command with a fixture name for remote fixture execution, use `kici run remote <fixture-name>` instead. For local workflow execution, use `kici run <event> --local`.

### kici local

Manage the **local dev plane** — the warm, per-user orchestrator (plus its own local PostgreSQL) that [`kici run <event> --local`](./runs-and-approvals.md#kici-run-event---local) dispatches through. You rarely need these commands directly: a local run boots the plane on demand and reuses it afterwards. Reach for them to inspect the plane, stop it, read its log, or switch it between offline and Platform-connected mode.

```bash
kici local up [--offline | --connected]   # Start, or reuse an already-running plane
kici local status [--json]                 # Port, pid, PostgreSQL backend, attachment mode, readiness
kici local down                            # Stop the orchestrator and its PostgreSQL, verifying the port is freed
kici local logs                            # Print the orchestrator log file path
kici local attach                          # Attach to the Platform (hybrid mode)
kici local detach                          # Return the plane to offline (independent) mode
kici local trust-root <file>               # Export the dev-signed trust root for offline verification
```

The plane runs in one of two modes:

- **Independent (offline)** — the default for a plane that has never been attached. Identity tokens and attestations are signed by a local dev key under the clearly non-production issuer `kici-local`.
- **Hybrid (attached)** — `kici local attach` mints an org-scoped key with your logged-in credentials and reboots the plane connected to the Platform, so local runs get real Platform-minted identity and attestation. `kici local up` honors a durable attachment record: an attached plane comes back up hybrid, and falls back to offline with a warning when the Platform is unreachable.

`--offline` forces an independent boot without clearing the attachment record (only `detach` clears it); `--connected` requires an attached, reachable Platform and fails otherwise.

`kici local down` reports success only once the plane port is verified free. If a process still holds it — including a plane left behind by an interrupted boot — the command exits non-zero and names the holder, so a failed teardown is never mistaken for a clean one. A holder that does not identify as a KiCI plane orchestrator is reported and left alone, never stopped.

`kici local status` reports a plane whose process is alive but whose readiness probe fails — for example when its PostgreSQL has stopped — as running but not ready, together with its readiness checks, rather than as not running. When the holder is a KiCI plane orchestrator that this config directory did not start — a plane belonging to another `KICI_CONFIG_DIR`, or one whose record here was lost — status names it as such rather than as not ready, since its readiness is never probed, and points at `kici local down`, which does reclaim it. When the port is held by a process that is not a KiCI plane orchestrator, `kici local status` names that holder instead and points at `KICI_LOCAL_ORCH_PORT`, because `kici local down` will not stop it.

Pass `--json` for machine-readable output. It prints one object and exits 0 for
every state, including when the plane is stopped — the state is in the payload,
not the exit code:

```bash
$ kici local status --json
{"state":"ready","running":true,"pid":3768093,"port":4319,
 "url":"http://127.0.0.1:4319","pgKind":"embedded","stampVersion":3,
 "mode":"independent"}
```

`state` is one of `stopped`, `ready`, `unready`, `foreign-kici`,
`foreign-unknown`. The key set is fixed: the plane's admin token is never part
of it, so the output is safe to log. Every key is always present, but only
`state`, `running` and `mode` always carry a value — the rest are `null`
whenever the plane cannot supply them (for `stopped` that is all of them, and
`stampVersion` is populated only for `ready`), so read them defensively
(`jq -r '.pid // empty'`).

A local run also fails fast when no agent claims it: if no scaler label set matches the job's `runsOn`, or the agent cannot start, the run gives up within a short acceptance window (2 minutes by default, overridable with `KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS`) and names the plane log instead of waiting out the full no-progress timeout.

**Verifying an offline-signed bundle:** export the plane's trust root, then pass it to the verifier:

```bash
kici local trust-root ./local-trust-root.json
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root ./local-trust-root.json
```

For the plane's on-disk layout, port selection, PostgreSQL backends, and reset behavior, see [Local dev plane](../../operator/orchestrator/local-dev-plane.md).

### kici fixture

Generate a fixture template for an event type. Useful for creating custom test payloads.

```bash
kici fixture <event> [options]
```

**Valid events:** `pr:open`, `pr:sync`, `pr:close`, `pr:reopen`, `push`, `tag`, `comment`, `review`, `review_comment`, `release`, `dispatch`, `create`, `delete`, `status`, `workflow_run`, `fork`, `star`, `watch`, `kici_event`, `workflow_complete`, `workflows_failed_batch`, `job_complete`, `generic_webhook`, `schedule`, `lifecycle` (many support `:action` suffixes, e.g. `comment:edited`, `release:published`, `lifecycle:workflow_complete`). `webhook:<source>` is a shorthand alias for `generic_webhook:<source>`.

**Examples:**

```bash
# Print fixture to stdout
kici fixture pr:open

# Write fixture to file
kici fixture pr:open --output fixtures/pr-open.json

# Generate push fixture
kici fixture push --output fixtures/push.json
```

Use generated fixtures as reference when writing test fixture files in `.kici/tests/`:

```bash
kici fixture pr:open --output fixtures/pr-open-reference.json
# Use the generated JSON as reference when writing .kici/tests/pr-open.ts
```

### kici types

Generate TypeScript declaration files from orchestrator environment metadata. The generated `.d.ts` file augments the SDK's `KnownSecretKeys` and `ContextSecrets` interfaces, providing compile-time autocomplete and type checking for secret key names.

```bash
kici types [options]
```

**Prerequisites:** Authenticate via `kici login` to fetch the real key set. Without it, `kici types` writes an empty stub (see "Offline behavior" below).

**Output:** `.kici/types/secrets.d.ts`

**Examples:**

```bash
# Generate types from orchestrator
kici types

# Use custom .kici directory
kici types --kici-dir packages/app/.kici
```

**How it works:**

1. Fetches all environment metadata (environment names and secret key names) from the orchestrator
2. Generates a `.d.ts` file that augments `@kici-dev/sdk`'s `KnownSecretKeys` and `ContextSecrets` interfaces
3. Writes the file to `.kici/types/secrets.d.ts`

After generating types, `ctx.secrets.get('MY_KEY')` and `ctx.secrets.expose('DB_HOST')` gain autocomplete and type checking in your IDE.

**Git workflow:** `.kici/types/secrets.d.ts` is a local development aid, not source — its content is a snapshot of one org's secret keys fetched from the Platform. `kici init` gitignores `.kici/types/`, so the file stays out of version control. Each team member runs `kici types` (or an authenticated `kici compile`) to generate their own copy. Do not commit it: a stale committed copy would type-check against secret keys that no longer exist.

**Offline behavior:** When the Platform cannot be reached — not logged in, no active org, or offline — `kici types` never fails. If a `secrets.d.ts` already exists, `kici types` keeps it untouched, so a transient outage does not wipe your real key set. If the file is absent (a fresh clone or unauthenticated CI), `kici types` writes a valid empty stub. Type checking then degrades to "no known keys" (any key name is accepted) rather than breaking with "module has no exported member". Run `kici types` again once authenticated to refresh it.

**Auto-regeneration:** `kici compile` automatically runs `kici types` after successful compilation when authenticated. See the [kici compile](#kici-compile) section for details.

**Escape hatch:** For dynamic keys not in the generated types, use a cast: `(ctx.secrets as any).DYNAMIC_KEY`.

### kici workflows list

List permanently registered workflows on the orchestrator.

```bash
kici workflows list [options]
```

**Examples:**

```bash
# List all registered workflows
kici workflows list

# JSON output for scripting
kici workflows list --json

# Show workflows not updated in 30 days
kici workflows list --stale 30d

# Filter by trigger type
kici workflows list --trigger-type push

# Filter by repository
kici workflows list --repo my-org/my-repo
```

### kici hook install

Install a pre-commit hook that runs `kici compile` before each commit.

```bash
kici hook install [options]
```

**Examples:**

```bash
# Auto-detect hook tool (husky, lint-staged, etc.)
kici hook install

# Force raw git hook
kici hook install --git
```

The command auto-detects existing hook tools in your project:

- **Husky**: Adds to `.husky/pre-commit`
- **lint-staged**: Adds to lint-staged configuration
- **Raw git**: Writes `.git/hooks/pre-commit`

If multiple tools are detected, you are prompted to choose.

### kici docs

Open the KiCI documentation site in the default browser. With the `llm` subcommand, print the LLM-friendly documentation bundle that ships with `@kici-dev/compiler` — pipe it into a coding agent's context buffer to brief the agent on authoring conventions without an internet round-trip.

```bash
kici docs               # open https://kici.dev/docs/
kici docs --no-open     # print the URL instead of opening a browser
kici docs llm           # print the llms.txt index (a router over the task bundles)
kici docs llm sdk       # print the SDK task bundle
kici docs llm full      # print llms-full.txt (every page in one file)
kici docs llm sdk --out sdk-context.md   # write a bundle to a file
```

**Examples:**

```bash
# Open the docs site in your browser
kici docs

# Pipe just the SDK bundle into a coding agent (small, task-scoped context)
kici docs llm sdk | claude -- "Read this and help me author a deploy workflow"

# Save the router index for offline reference
kici docs llm --out kici-llms-index.txt
```

Bundles are regenerated from `docs/` every time `@kici-dev/compiler` is built, so they always match your installed CLI version. The index lists each task bundle — `getting-started`, `sdk`, `sdk-runtime`, `cli`, `cli-remote`, `patterns`, `features`, `features-execution`, `providers`, `architecture` — with its size and a one-line purpose; pass the bundle id as the topic. Every cross-reference link inside a bundle is an absolute `docs.kici.dev` URL. The same files are published online following the [llms.txt convention](https://llmstxt.org/).

## Reference

<!-- BEGIN GENERATED: kici-authoring-and-local (do not edit; run the doc generator) -->

### `kici compile`

Compile workflows from .kici/workflows/ to kici.lock.json

Synopsis: `kici compile [options]`

**Options**

| Option              | Default | Description                                                                        |
| ------------------- | ------- | ---------------------------------------------------------------------------------- |
| `--check`           | `false` | Validate workflows and type-check sources (tsc --noEmit) without writing lock file |
| `--kici-dir <path>` | `.kici` | Path to .kici directory                                                            |
| `--verbose`         | `false` | Detailed output                                                                    |
| `--watch`           | `false` | Watch for changes and recompile                                                    |

### `kici docs`

Open the KiCI documentation site in the default browser

Synopsis: `kici docs [options]`

**Options**

| Option      | Default | Description                                     |
| ----------- | ------- | ----------------------------------------------- |
| `--no-open` |         | Print the docs URL instead of opening a browser |

### `kici docs llm`

Print KiCI LLM docs bundles. No topic prints the llms.txt index; <topic> prints a task bundle (e.g. sdk, cli, cli-remote, patterns, features, providers, architecture, getting-started); "full" prints the complete bundle.

Synopsis: `kici docs llm [topic] [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `topic`  | no       | no       |             |

**Options**

| Option         | Default | Description                                  |
| -------------- | ------- | -------------------------------------------- |
| `--out <path>` |         | Write the bundle to a file instead of stdout |

### `kici fixture`

Generate fixture template for event type

Synopsis: `kici fixture <event> [options]`

**Arguments**

| Argument | Required | Variadic | Description                                                                                |
| -------- | -------- | -------- | ------------------------------------------------------------------------------------------ |
| `event`  | yes      | no       | Event to generate fixture for (e.g., pr:open, push, schedule, lifecycle:workflow_complete) |

**Options**

| Option            | Default | Description                     |
| ----------------- | ------- | ------------------------------- |
| `--output <path>` |         | Write to file instead of stdout |

### `kici hook`

Manage pre-commit hooks

Synopsis: `kici hook`

### `kici hook install`

Install kici compile pre-commit hook

Synopsis: `kici hook install [options]`

**Options**

| Option  | Default | Description                              |
| ------- | ------- | ---------------------------------------- |
| `--git` | `false` | Use raw git hook (.git/hooks/pre-commit) |

### `kici local`

Manage the local dev orchestrator plane

Synopsis: `kici local`

### `kici local attach`

Attach the local dev plane to the Platform (hybrid)

Synopsis: `kici local attach`

### `kici local detach`

Detach the local dev plane from the Platform (offline)

Synopsis: `kici local detach`

### `kici local down`

Stop the local dev plane

Synopsis: `kici local down`

### `kici local logs`

Print the local dev plane orchestrator log path

Synopsis: `kici local logs`

### `kici local status`

Show local dev plane status and control commands

Synopsis: `kici local status [options]`

**Options**

| Option   | Default | Description                                          |
| -------- | ------- | ---------------------------------------------------- |
| `--json` | `false` | Emit machine-readable JSON (exits 0 for every state) |

### `kici local trust-root`

Export the offline dev-signed identity trust root ({ issuer, jwks }) to a file

Synopsis: `kici local trust-root <file>`

**Arguments**

| Argument | Required | Variadic | Description                                          |
| -------- | -------- | -------- | ---------------------------------------------------- |
| `file`   | yes      | no       | Output path for the { issuer, jwks } trust-root JSON |

### `kici local up`

Start (or reuse) the local dev plane

Synopsis: `kici local up [options]`

**Options**

| Option        | Default | Description                                                                  |
| ------------- | ------- | ---------------------------------------------------------------------------- |
| `--offline`   | `false` | Force the independent (offline) plane (does not clear the attachment record) |
| `--connected` | `false` | Force the connected/hybrid plane (requires an attached, reachable Platform)  |

### `kici preview`

Preview which workflows match a trigger event (no execution)

Synopsis: `kici preview [event] [options]`

**Arguments**

| Argument | Required | Variadic | Description                                           |
| -------- | -------- | -------- | ----------------------------------------------------- |
| `event`  | no       | no       | Event type to preview (e.g., push, pr:open, schedule) |

**Options**

| Option                      | Default | Description                                                  |
| --------------------------- | ------- | ------------------------------------------------------------ |
| `--branch <name>`           |         | Override target branch for trigger matching (default: main)  |
| `--sha <hash>`              |         | Override commit SHA                                          |
| `--workflow <name>`         |         | Filter to specific workflow in display                       |
| `--job <name>`              |         | Filter to specific job in display                            |
| `--debug`                   | `false` | Verbose internals                                            |
| `--kici-dir <path>`         | `.kici` | Path to .kici directory                                      |
| `--files <path>`            |         | Simulate changed file path for trigger matching (repeatable) |
| `--secret <key=value>`      |         | Inject flat secret (repeatable)                              |
| `--context <ctx.key=value>` |         | Inject context secret (repeatable)                           |

### `kici types`

Generate TypeScript declarations for secret contexts

Synopsis: `kici types [options]`

**Options**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

### `kici workflows`

Manage workflow registrations

Synopsis: `kici workflows`

### `kici workflows list`

List permanently registered workflows

Synopsis: `kici workflows list [options]`

**Options**

| Option                  | Default | Description                                |
| ----------------------- | ------- | ------------------------------------------ |
| `--json`                | `false` | Output as JSON                             |
| `--stale <duration>`    |         | Filter stale registrations (e.g., 30d, 7d) |
| `--trigger-type <type>` |         | Filter by trigger type                     |
| `--repo <repo>`         |         | Filter by repository                       |

<!-- END GENERATED: kici-authoring-and-local -->
