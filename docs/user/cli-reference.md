---
title: CLI reference
description: 'All CLI commands: compile, run (local/remote), orchestrators, test, login, logout, org, diagnostics, runs (list/show/logs/rerun/cancel), secrets, types, fixture, init, hook, endpoints, workflows, docs, admin'
---

The `@kici-dev/compiler` package provides the `kici` CLI for compiling, testing, and managing workflows.

## Installation

```bash
pnpm add -D @kici-dev/compiler
```

The examples use pnpm, but npm and yarn work too — `npm install -D @kici-dev/compiler` or `yarn add -D @kici-dev/compiler`.

Run commands with `npx kici` or add scripts to your `package.json`:

```json
{
  "scripts": {
    "kici:compile": "kici compile",
    "kici:test": "kici test"
  }
}
```

## Commands

### kici compile

Compile workflows from `.kici/workflows/` to `kici.lock.json`.

```bash
kici compile [options]
```

**Options:**

| Option              | Default | Description                                  |
| ------------------- | ------- | -------------------------------------------- |
| `--check`           | `false` | Validate workflows without writing lock file |
| `--watch`           | `false` | Watch for changes and recompile              |
| `--kici-dir <path>` | `.kici` | Path to .kici directory                      |
| `--verbose`         | `false` | Detailed output                              |

**Examples:**

```bash
# Compile all workflows
kici compile

# Validate only (CI-friendly, no file writes)
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

The `--check` flag is useful in CI pipelines and pre-commit hooks. It validates that workflows are syntactically and semantically correct without writing the lock file or any other files.

**Auto-type regeneration:** When authenticated (via `kici login`), `kici compile` automatically refreshes `.kici/types/secrets.d.ts` after each successful compilation. This keeps type declarations in sync with your orchestrator's secret contexts. The type regeneration is non-blocking -- if the orchestrator is unreachable, compilation still succeeds with a warning. The `--check` flag skips type regeneration since no files are written.

### kici run

Execute workflows locally or remotely. The `run` command has two subcommands: `local` for direct execution without infrastructure, and `remote` for fixture-based execution through an orchestrator.

#### kici run local

Execute workflows locally without orchestrator infrastructure. Compiles workflows, matches triggers against the specified event, expands matrices, and runs jobs with DAG-based parallel scheduling.

```bash
kici run local [event] [options]
```

**Arguments:**

| Argument | Required               | Description                                      |
| -------- | ---------------------- | ------------------------------------------------ |
| `event`  | when `--pick` is unset | Event type (e.g., `push`, `pr:open`, `schedule`) |

**Options:**

| Option              | Default   | Description                                                                                                                                                                                                       |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --pick`        | `false`   | Interactively pick a workflow + trigger (see below)                                                                                                                                                               |
| `--workflow <name>` | none      | Run only the specified workflow (mutex with `--pick`)                                                                                                                                                             |
| `--job <name>`      | none      | Run only the specified job (and its dependencies)                                                                                                                                                                 |
| `--branch <name>`   | detected  | Override detected git branch                                                                                                                                                                                      |
| `--sha <hash>`      | detected  | Override detected git SHA                                                                                                                                                                                         |
| `--payload <path>`  | none      | Path to explicit event payload JSON file                                                                                                                                                                          |
| `--concurrency <n>` | CPU cores | Max parallel jobs **within one run** (job-level only). Cross-run [concurrency groups](concurrency.md) declared in `workflow({ concurrency: ... })` are enforced separately — see "Concurrency enforcement" below. |
| `--keep-going`      | `false`   | Continue after job failure                                                                                                                                                                                        |
| `--container`       | `false`   | Use Podman container isolation                                                                                                                                                                                    |
| `--env <KEY=VALUE>` | none      | Environment variable override (repeatable)                                                                                                                                                                        |
| `--files <path>`    | git diff  | Override changed file paths (repeatable, default: git diff)                                                                                                                                                       |
| `--quiet`           | `false`   | Suppress streaming output (summary only)                                                                                                                                                                          |
| `--json`            | `false`   | Output structured JSON result                                                                                                                                                                                     |
| `--junit <path>`    | none      | Output JUnit XML result to file                                                                                                                                                                                   |
| `--debug`           | `false`   | Verbose internals                                                                                                                                                                                                 |
| `--kici-dir <path>` | `.kici`   | Path to .kici directory                                                                                                                                                                                           |
| `--in-place`        | `false`   | Run against the real working directory instead of an isolated tmp checkout (see "Execution isolation" below)                                                                                                      |
| `--keep`            | `false`   | Always retain the isolated tmp checkout (default: keep only on failure)                                                                                                                                           |

**Interactive workflow selection (`--pick` / `-p`):**

When you do not remember the event arg for a workflow, pass `--pick` (or `-p`) to open an interactive picker. It lists every workflow with a compact summary of its triggers, lets you choose one, and (for multi-trigger workflows) prompts again for which trigger to simulate. The selected trigger is converted back into an event arg and fed through the normal pipeline.

```bash
# Open the picker across all triggerable workflows
kici run local --pick

# Scope the picker to a trigger family (e.g. only workflows that react to pr:*)
kici run local pr:open --pick
```

Rules:

- `--pick` is mutually exclusive with `--workflow`. Passing both exits with code 2.
- When `stdin` is not a TTY, `--pick` prints the available workflows and exits without running anything — fall back to `kici run local <event> --workflow <name>` in scripts.
- Passing an event arg together with `--pick` narrows the picker to workflows that declare at least one trigger in that event family (e.g. `schedule --pick` shows only scheduled workflows).

**Concurrency enforcement:**

When the workflow declares a `concurrency` block, `kici run local` enforces it across concurrent local invocations on the same machine and user account. The behavior mirrors the orchestrator:

- The `group` callback is evaluated against the simulated event (same `{ branch, event }` context that the agent sees), and the resulting key is used as the lock identity. Throwing from `group` aborts the workflow run with a clear error — there is no fallback to the workflow name.
- `cancelInProgress: true` interrupts the holder via `SIGTERM`, then escalates to `SIGKILL` after a grace window if the holder does not exit, and proceeds with the new run.
- Otherwise the new invocation waits in FIFO order. A status line is printed when the wait starts and roughly every five seconds thereafter.
- Locks live under `$XDG_RUNTIME_DIR/kici-local-locks/` on Linux, falling back to `os.tmpdir()/kici-local-locks-<uid>/` on platforms without a per-user runtime dir. Each lock file records the holder PID, hostname, workflow name, group key, and start timestamp so concurrent invocations can describe what they are waiting for.
- Stale locks (the recorded holder PID is gone, per `process.kill(pid, 0)`) are reclaimed automatically.

Coordination is local only — running the same workflow on two different machines does not serialize across them. That requires the orchestrator.

The `SIGTERM`-to-`SIGKILL` grace window defaults to 30 000 ms. Override it with the `KICI_LOCAL_LOCK_KILL_GRACE_MS` environment variable (positive integer, milliseconds) when iterating on workflows that need longer to clean up on cancellation.

**Execution isolation:**

By default, `kici run local` executes steps inside an **isolated tmp checkout** rather than against your real working directory. Any file a step writes, builds, or deletes — and any `git` mutation a step performs — lands in that throwaway copy, so casual local runs never touch your tree.

What gets materialized into the isolated checkout has full parity with what `kici run remote` reconstructs: your current working tree minus gitignored files, with `.kiciignore` applied to local changes, over a real `.git` directory. Concretely, the checkout is built from a clone pinned to your current `HEAD`, with your local overlay (modified, staged, and untracked-but-not-ignored files) copied on top and locally-deleted files removed. Workflows that read git metadata work because the `.git` directory is present and pinned to your `HEAD`.

The path is logged at run start (for example, `running in /tmp/kici-run-ab12cd`) so you can inspect it.

Cleanup policy:

- On a fully successful run, the isolated checkout is removed.
- On failure, it is retained and its path is logged so you can inspect the failed state.
- `--keep` always retains it, even on success.
- Retained checkouts are garbage-collected after 72 hours by the next `kici run local` invocation — copy a checkout elsewhere if you need it longer.

Set the `KICI_RUN_DIR` environment variable to place the isolated checkout under a base directory other than the system temp directory.

Secrets are always sourced from your real `.kici/` directory, not from the isolated checkout. Gitignored secret files (such as `.kici/.env.local` and `.kici/secrets.yaml`) are never copied into the checkout, so a step that reads a secret still gets it from the original location.

Pass `--in-place` to run against the real working directory instead — useful when you explicitly want in-tree execution. `--in-place` requires no git repository; the default isolated mode does, and fails with an actionable error pointing at `--in-place` when the directory is not a git repository.

**Examples:**

```bash
# Run workflows matching a push event
kici run local push

# Run only a specific workflow
kici run local push --workflow ci

# Run only a specific job (and its dependencies)
kici run local push --job test

# JSON output for CI scripting
kici run local push --json

# JUnit XML for CI integration
kici run local push --junit results.xml

# Quiet mode (summary only, no streaming)
kici run local push --quiet

# Override branch and SHA
kici run local push --branch main --sha abc1234

# Environment variable overrides
kici run local push --env NODE_ENV=test --env CI=true

# Continue running other jobs after one fails
kici run local push --keep-going
```

**Exit codes:**

| Code | Meaning                 |
| ---- | ----------------------- |
| 0    | All workflows succeeded |
| 1    | One or more jobs failed |

**Output formats:**

- **Default:** Streaming job output during execution, followed by a tree-format summary with per-step timing
- **`--json`:** Structured JSON with workflows, jobs, steps, timing, and matrix values
- **`--junit <path>`:** Standard JUnit XML for CI integration (Jenkins, GitLab, etc.)
- **`--quiet`:** Summary only, no streaming output during execution

#### kici run remote

Execute fixtures remotely through the full CI pipeline. Fixtures are defined in `.kici/tests/*.ts` using the `fixture()` factory function. Without arguments, lists available fixtures.

Remote runs route through the Platform. Authenticate with a personal access token (`kici login`), then target an organization with `kici org use <org>` or the `--org` flag. The Platform relays the run to the org's orchestrator, while your working-tree overlay uploads directly to object storage — see [How the run is routed](#how-the-run-is-routed) and [The two planes](#the-two-planes) below.

The orchestrator must have **cache storage configured** (`KICI_STORAGE_TYPE` = `s3` or `filesystem`) with a dev-reachable upload endpoint so the CLI's direct upload succeeds; see the [testing guide](testing-guide.md) and [Storage layout](../operator/orchestrator/storage-layout.md) for setup.

```bash
kici run remote [fixture] [options]
```

**Arguments:**

| Argument  | Required | Description                                     |
| --------- | -------- | ----------------------------------------------- |
| `fixture` | no       | Fixture name or glob pattern (omit to list all) |

**Options:**

| Option                      | Default | Description                                                                                       |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `--org <id>`                | active  | Target organization for this run (overrides `kici org use`)                                       |
| `--orchestrator <name>`     | default | Target orchestrator cluster within the org (overrides the per-org default)                        |
| `--all`                     | `false` | Run all fixtures                                                                                  |
| `--workflow <name>`         | none    | Run a specific workflow directly (bypass triggers)                                                |
| `--parallel`                | `false` | Run multiple fixtures concurrently                                                                |
| `--no-wait`                 | -       | Fire and forget (print runIds, don't stream)                                                      |
| `--quiet`                   | `false` | Minimal output (only final result)                                                                |
| `--json`                    | `false` | Machine-readable JSON output                                                                      |
| `--junit <path>`            | none    | JUnit XML output to file for CI integration                                                       |
| `--history`                 | `false` | Show table of recent test runs                                                                    |
| `--context <ctx.key=value>` | none    | Inject a namespaced context secret, uploaded encrypted (repeatable)                               |
| `--env <KEY=VALUE>`         | none    | Provide a per-run secret, uploaded encrypted (repeatable) — see [testing guide](testing-guide.md) |
| `--target <selector>`       | none    | Narrow `runsOnAll` jobs to hosts matching this label selector (repeatable, AND-combined)          |
| `--target-allow-empty`      | `false` | A `--target` that narrows a `runsOnAll` job to zero hosts skips it instead of failing             |
| `--debug`                   | `false` | Verbose internals                                                                                 |
| `--kici-dir <path>`         | `.kici` | Path to .kici directory                                                                           |

**Examples:**

```bash
# List available fixtures
kici run remote

# Run a single fixture against the active org
kici run remote push-main

# Target a specific org for this run
kici run remote push-main --org xyz789ghi012

# Target a specific orchestrator cluster within the org
kici run remote push-main --orchestrator us-east

# Run all push-related fixtures
kici run remote 'push-*'

# Run everything
kici run remote --all

# Run a specific workflow directly (bypass trigger matching)
kici run remote --workflow ci

# Quiet mode -- just pass/fail
kici run remote push-main --quiet

# JSON output for scripting
kici run remote push-main --json

# Fire and forget
kici run remote push-main --no-wait

# View recent test run history
kici run remote --history

# Narrow runsOnAll jobs to a subset of the host roster
kici run remote deploy --target role:web

# AND-combine repeated --target values (hosts must match every selector)
kici run remote deploy --target role:web --target dc:eu

# Skip a runsOnAll job instead of failing it when the target matches no host
kici run remote deploy --target role:gpu --target-allow-empty
```

#### Host narrowing with `--target`

`--target <selector>` is a runtime narrowing for `runsOnAll` jobs, analogous to
Ansible's `--limit`. A `runsOnAll` job normally fans out to **every** roster host
matching its predicate, one pinned execution per host. `--target` intersects that
matched roster with a label selector, so the effective host set is
`runsOnAll ∩ target`:

- **Narrow-only.** `--target` can only _remove_ hosts from the matched set, never
  add them. The widening dimension (OR across host groups) lives in the workflow's
  `runsOnAll`; `--target` only subtracts.
- **Run-global, `runsOnAll`-only.** A single `--target` applies to every
  `runsOnAll` job in the run. Jobs pinned to a single host with `runsOn` are
  untouched.
- **Repeatable and AND-combined.** Each `--target` value is its own selector; a
  host must satisfy **all** of them to survive the narrowing. Use a single value
  for an OR-style match within one selector and repeated values for AND.
- **Selector syntax** matches `runsOn`: an exact label (`role:web`), a glob
  (`role:*`), or a regex (`/^box-0[1-3]$/`).

When `--target` narrows a `runsOnAll` job to zero hosts, the default is to **fail**
the run (fail-loud — a typo in the selector shouldn't silently skip work). Pass
`--target-allow-empty` to **skip** the zeroed job instead; the job records a
`skipped` status, and any downstream job that needs it with `when: 'on-skip'` (or
`when: 'always'`) still runs. See [Job dependencies](./sdk/core.md#job-dependencies-needs)
for the `when` gating model.

**Exit codes:**

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | All matched workflows passed |
| 1    | One or more workflows failed |

#### How the run is routed

A remote run is dispatched to your **active organization** — the one set with `kici org use <org>`, or overridden per-run with `--org <id>`. The org is resolved in this order:

1. The `--org <id>` flag, if provided.
2. Otherwise the active org saved in your global config by `kici org use <org>`.
3. If neither is set, the command errors and asks you to select an org with `kici org use` or pass `--org`.

The orchestrator anchors the org without any manual webhook source: it auto-provisions a system-managed **remote source** (routing key `remote:<orgId>`) that maps to its bound organization, so even a zero-source org is immediately routable for remote runs. You never set a routing key for a remote run — selecting the org is enough.

When an org has more than one connected orchestrator cluster, the CLI picks the target cluster in this order:

1. The `--orchestrator <name>` flag, if provided.
2. Otherwise the per-org default cluster, set with `kici orchestrators use <name>`.
3. If the org has exactly **one** connected orchestrator, it is auto-selected.
4. Otherwise the run errors with the list of connected clusters, and you pass `--orchestrator <name>` to choose one. Run `kici orchestrators list` to see the available cluster names.

#### The two planes

`kici run remote` uses two independent paths:

- **Control plane** — run initiation, trigger, status, log retrieval, and cancellation flow from your machine through the Platform, which relays them over a WebSocket connection to the org's orchestrator. Logs are delivered by the CLI polling the Platform for log chunks (tracked by a monotonic line cursor) and run status until the run reaches a terminal state; there is no direct streaming socket to the orchestrator.
- **Data plane** — your working-tree overlay tarball uploads **directly** from your machine to the orchestrator's object store via a presigned PUT URL. The overlay never passes through the Platform. This is why the orchestrator's object-store upload endpoint must be reachable from your machine; see [Storage layout](../operator/orchestrator/storage-layout.md).

An orchestrator with no Platform connection cannot serve remote runs — the Platform is the service that offers them. For executing workflow steps on your own machine without an orchestrator (no scaler, agents, or environments), use [`kici run local`](#kici-run-local).

#### Fresh repos (no GitHub remote)

`kici run remote` works even if the repo has never been pushed to GitHub. When no remote is detected:

- The entire repo content is uploaded (not just a diff overlay)
- The lock file is sent inline (no GitHub API fetch)
- Steps that use git commands will fail (no `.git` directory in the remote workspace)
- Build cache (`__build__` jobs) is skipped for local repos
- Environments must have `allowLocalExecution: true` to be accessible from local runs (default is `false`)

Destination routing is unchanged for fresh repos: the run still goes to your active org through the Platform.

For a detailed guide on writing fixtures, configuring secrets, and understanding the upload flow, see [Testing guide](testing-guide.md).

#### kici orchestrators

List the orchestrator clusters connected to an organization, and set the per-org default cluster used by `kici run remote`. Requires `kici login` and an active org (or pass `--org`).

```bash
kici orchestrators list [--org <id>]
kici orchestrators use <clusterName> [--org <id>]
```

**`kici orchestrators list`** prints the org's connected orchestrator clusters, so you know what to pass to `--orchestrator` (or to `kici orchestrators use`).

**`kici orchestrators use <clusterName>`** sets the default orchestrator cluster for the org, stored per-org in your global config. Subsequent `kici run remote` invocations target that cluster unless overridden with `--orchestrator`.

**Examples:**

```bash
# List the active org's connected clusters
kici orchestrators list

# List a specific org's clusters
kici orchestrators list --org xyz789ghi012

# Set the default cluster for the active org
kici orchestrators use us-east

# Set the default cluster for a specific org
kici orchestrators use us-east --org xyz789ghi012
```

### kici test

Preview which workflows match a trigger event (dry-run, no execution). Useful for verifying trigger configurations during development.

```bash
kici test [event] [options]
```

**Arguments:**

| Argument | Required | Description                                                 |
| -------- | -------- | ----------------------------------------------------------- |
| `event`  | no       | Event type to preview (e.g., `push`, `pr:open`, `schedule`) |

**Options:**

| Option                      | Default | Description                                                  |
| --------------------------- | ------- | ------------------------------------------------------------ |
| `--workflow <name>`         | none    | Filter to specific workflow                                  |
| `--job <name>`              | none    | Filter to specific job                                       |
| `--branch <name>`           | `main`  | Override target branch for trigger matching                  |
| `--sha <hash>`              | none    | Override commit SHA                                          |
| `--files <path>`            | none    | Simulate changed file path for trigger matching (repeatable) |
| `--secret <key=value>`      | none    | Inject flat secret (repeatable)                              |
| `--context <ctx.key=value>` | none    | Inject context secret (repeatable)                           |
| `--debug`                   | `false` | Verbose internals                                            |
| `--kici-dir <path>`         | `.kici` | Path to .kici directory                                      |

**Examples:**

```bash
# Preview which workflows match a push event
kici test push

# Preview PR trigger matching
kici test pr:open

# Preview with branch override
kici test push --branch develop

# Filter to specific workflow
kici test push --workflow ci

# Simulate changed files for path-filtered triggers
kici test push --files src/index.ts --files README.md
```

**Exit codes:**

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | Preview completed (including zero matches) |
| 1    | Error                                      |

**Migration from old `kici test <fixture>`:** If you were using `kici test <fixture-name>` for remote fixture execution, use `kici run remote <fixture-name>` instead. For local workflow execution, use `kici run local <event>`.

### kici login

Authenticate with KiCI via browser-based OAuth (default) or API key (`--token`).

By default, `kici login` opens your browser for OIDC authentication using PKCE. In headless environments (SSH, CI, containers), it automatically switches to the RFC 8628 device authorization flow where you visit a URL and enter a code.

After OAuth, the CLI exchanges the OIDC token for a personal access token (PAT) stored in the config directory (`~/.kici/config` by default, overridable with `KICI_CONFIG_DIR`).

`kici login` targets the hosted KiCI Platform by default. To authenticate against another environment (a self-hosted Platform, for example), pass `--platform-endpoint` / `--oidc-issuer` or set `KICI_PLATFORM_URL` / `KICI_OIDC_ISSUER`. Login persists the platform endpoint and OIDC issuer it authenticated against alongside the PAT, so a saved PAT always matches its endpoint. Because the config describes one environment at a time, **switching the endpoint resets the active organization and default clusters** — re-run `kici org use <name>` after switching environments.

```bash
kici login [options]
```

**Options:**

| Option                      | Default | Description                                         |
| --------------------------- | ------- | --------------------------------------------------- |
| `--token <key>`             | none    | API key for direct authentication (legacy)          |
| `--device`                  | false   | Force device authorization flow (headless/SSH)      |
| `--platform-endpoint <url>` | none    | Platform relay URL                                  |
| `--oidc-issuer <url>`       | none    | OIDC issuer URL (selects a non-default environment) |
| `--routing-key <key>`       | none    | Routing key for webhook source identification       |

**Environment variables:**

| Variable              | Default                                      | Description                                                            |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `KICI_PLATFORM_URL`   | `https://api.kici.dev`                       | Platform API base URL (override for a self-hosted Platform)            |
| `KICI_OIDC_ISSUER`    | `https://auth.kici.dev/realms/kici-internal` | OIDC issuer URL (override for a self-hosted Platform)                  |
| `KICI_OIDC_CLIENT_ID` | `kici-cli`                                   | OIDC client ID (override for a self-hosted Platform)                   |
| `KICI_BROWSER_CMD`    | uses `open` package                          | Custom browser command with `{url}` placeholder, or `none` to suppress |
| `KICI_CALLBACK_PORT`  | random                                       | Fixed port for OAuth PKCE callback server                              |
| `KICI_CONFIG_DIR`     | `~/.kici`                                    | Override config directory                                              |

**Examples:**

```bash
# Browser-based OAuth login (default)
kici login

# Force device flow (for SSH/headless)
kici login --device

# Legacy API key login
kici login --token kici_sk_abc123...

# Log in against a self-hosted Platform
kici login --platform-endpoint https://platform.example.com \
  --oidc-issuer https://auth.example.com/realms/kici-internal

# Suppress browser opening (print authorize URL to stdout)
KICI_BROWSER_CMD=none kici login

# Use custom browser command
KICI_BROWSER_CMD='firefox {url}' kici login

# Fixed callback port and custom config directory
KICI_CALLBACK_PORT=19876 KICI_CONFIG_DIR=/tmp/kici-test kici login
```

**Headless detection:** The CLI automatically detects headless environments by checking for `SSH_CLIENT`, `SSH_TTY`, `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `container`, or `DOCKER_CONTAINER` env vars, and on Linux, the absence of `DISPLAY` and `WAYLAND_DISPLAY`.

### kici logout

Revoke your personal access token on the server and clear local credentials.

If the server is unreachable, local credentials are still cleared (the PAT will expire automatically). Non-auth config fields (active org, default clusters, etc.) are preserved.

```bash
kici logout
```

**Examples:**

```bash
# Log out and revoke PAT
kici logout
```

### kici org

Manage organization context. Requires a PAT (run `kici login` first).

#### kici org list

List organizations you belong to. The active org is marked with a star (`*`).

```bash
kici org list
```

**Example output:**

```
Organizations:

  * Personal          (owner)  abc123def456
    My team           (admin)  xyz789ghi012
```

#### kici org use

Switch the active organization by name (case-insensitive) or ID.

```bash
kici org use <name>
```

**Arguments:**

| Argument | Required | Description             |
| -------- | -------- | ----------------------- |
| `name`   | yes      | Organization name or ID |

**Examples:**

```bash
# Switch by name
kici org use "My team"

# Switch by ID
kici org use xyz789ghi012
```

#### kici org current

Show the current active organization.

```bash
kici org current
```

### kici diagnostics

Show the orchestrators, scalers, and agents serving your organization — the
terminal equivalent of the dashboard Diagnostics page. Reads the same
org-scoped data the dashboard does, so it needs `kici login` and an active org
(`kici org use <name>`).

The output has three parts: a one-line header (runs in the last 24h, success
rate, average duration, queued/running job counts), any infrastructure alerts
(only shown when present), and a tree of each orchestrator with its scalers and
agents. Each agent line shows its labels, platform/architecture, active/maximum
concurrency, and heartbeat age.

```bash
kici diagnostics [options]
```

**Options:**

| Option                | Default | Description                                         |
| --------------------- | ------- | --------------------------------------------------- |
| `--json`              | `false` | Machine-readable JSON output                        |
| `--verbose`           | `false` | Show extended per-agent fields (host, node, memory) |
| `--orchestrator <id>` | all     | Scope the tree to one orchestrator connection id    |

**Examples:**

```bash
# Show the full infrastructure tree
kici diagnostics

# Extended per-agent detail
kici diagnostics --verbose

# Only one orchestrator's scalers and agents
kici diagnostics --orchestrator conn-abc123

# Machine-readable output
kici diagnostics --json
```

### kici runs

Inspect and manage execution runs from the terminal — the equivalent of the
dashboard Runs page. All `kici runs` subcommands read/write the same org-scoped
data as the dashboard, so they require `kici login` and an active org
(`kici org use <name>`).

#### kici runs list

List runs with optional filters. Output is a table (run id, workflow, status,
branch, trigger, started, duration); pagination is reported at the bottom.

```bash
kici runs list [options]
```

**Options:**

| Option                  | Default | Description                                   |
| ----------------------- | ------- | --------------------------------------------- |
| `--status <s>`          | all     | Filter by run status                          |
| `--workflow <w>`        | all     | Filter by workflow name                       |
| `--branch <b>`          | all     | Filter by branch/ref                          |
| `--repo <r>`            | all     | Filter by repository                          |
| `--trigger <t>`         | all     | Filter by trigger type                        |
| `--source <routingKey>` | all     | Filter by source routing key                  |
| `--since <ts>`          | none    | Only runs since this ISO-8601 or epoch ms     |
| `--page <n>`            | `1`     | Page number (server page size is fixed at 20) |
| `--json`                | `false` | Machine-readable JSON output                  |

```bash
kici runs list
kici runs list --status running
kici runs list --workflow ci --branch main
kici runs list --json | jq '.runs[].runId'
```

#### kici runs show

Show a run's summary header plus its jobs-and-steps tree (name, status,
duration, exit code). If the run id is not on the Platform but exists in your
local run history (from `kici run local`), the local record is shown instead.

```bash
kici runs show <run-id> [options]
```

| Option   | Default | Description                  |
| -------- | ------- | ---------------------------- |
| `--json` | `false` | Machine-readable JSON output |

```bash
kici runs show abc123
kici runs show abc123 --json
```

#### kici runs logs

Print each job/step's log lines in order, with headers.

```bash
kici runs logs <run-id> [options]
```

| Option         | Default | Description                            |
| -------------- | ------- | -------------------------------------- |
| `--job <name>` | all     | Only print logs for this job           |
| `-f, --follow` | `false` | Tail logs for a live run until it ends |
| `--json`       | `false` | Machine-readable JSON output           |

```bash
kici runs logs abc123
kici runs logs abc123 --job build
kici runs logs abc123 --follow
```

#### kici runs rerun

Re-trigger a completed run. Prints the new run id. The server enforces a short
cooldown between reruns of the same run.

```bash
kici runs rerun <run-id> [options]
```

| Option   | Default | Description                  |
| -------- | ------- | ---------------------------- |
| `--json` | `false` | Machine-readable JSON output |

```bash
kici runs rerun abc123
```

#### kici runs cancel

Cancel a single run, or all in-progress runs on a branch.

```bash
kici runs cancel [run-id] [options]
```

| Argument | Required | Description      |
| -------- | -------- | ---------------- |
| `run-id` | no       | Run ID to cancel |

| Option            | Default | Description                                 |
| ----------------- | ------- | ------------------------------------------- |
| `--force`         | `false` | Force cancel (kill immediately, skip hooks) |
| `--branch <name>` | none    | Cancel all in-progress runs on this branch  |

```bash
kici runs cancel abc123
kici runs cancel abc123 --force
kici runs cancel --branch feature/wip
```

When `--json` is set on any of these commands, `kici` emits only the JSON
document on stdout — the `kici v<version>` banner is suppressed — so the output
is safe to pipe into `jq` or `JSON.parse`. The same holds for the other
`--json` commands (`kici run remote --json`, `kici workflows list --json`) and
for `--quiet`.

### kici approve

Approve a held [approval gate](approvals.md) so the run resumes. Identify the held element by run ID, optionally narrowed to a job and step.

```bash
kici approve <run-id> [options]
```

**Arguments:**

| Argument | Required | Description                        |
| -------- | -------- | ---------------------------------- |
| `run-id` | yes      | Run ID holding the gate to approve |

**Options:**

| Option           | Default | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `--job <name>`   | none    | Approve a held job (omit for a workflow-level hold)  |
| `--step <index>` | none    | Approve a held step by its index (used with `--job`) |

**Examples:**

```bash
# Approve a workflow-level hold
kici approve abc123

# Approve a held job
kici approve abc123 --job deploy-production

# Approve a held step (steps are addressed by index)
kici approve abc123 --job migrate-and-deploy --step 1
```

You must be eligible for at least one unsatisfied clause (a member of a named team, or a named user) and hold the `environments:write` or `ci_trust:write` permission. The command reports whether the element was released, how many clauses remain, or that it was rejected.

### kici reject

Reject a held [approval gate](approvals.md). A rejection fails the held element and the run. A reason is required.

```bash
kici reject <run-id> --reason <text> [options]
```

**Arguments:**

| Argument | Required | Description                       |
| -------- | -------- | --------------------------------- |
| `run-id` | yes      | Run ID holding the gate to reject |

**Options:**

| Option            | Default | Description                                         |
| ----------------- | ------- | --------------------------------------------------- |
| `--reason <text>` | none    | Required. Reason recorded with the rejection        |
| `--job <name>`    | none    | Reject a held job (omit for a workflow-level hold)  |
| `--step <index>`  | none    | Reject a held step by its index (used with `--job`) |

**Examples:**

```bash
# Reject a held job with a reason
kici reject abc123 --job deploy-production --reason "Wrong release branch"
```

### kici secrets list

List secret contexts available for test runs. Shows context names and key names (not values).

```bash
kici secrets list
```

Each "context" corresponds to an environment configured on the orchestrator. The output lists every environment whose `allowLocalExecution` flag is `true` (the gate that lets CLI-initiated test runs resolve secrets through that environment), along with the secret key names reachable from the environment's bound scopes.

Only key names are shown — secret values are never returned over this endpoint.

**Prerequisites:** authenticate via `kici login` and select an active organization with `kici org use <name>`.

### kici types

Generate TypeScript declaration files from orchestrator environment metadata. The generated `.d.ts` file augments the SDK's `KnownSecretKeys` and `EnvironmentSecrets` interfaces, providing compile-time autocomplete and type checking for secret key names.

```bash
kici types [options]
```

**Options:**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

**Prerequisites:** Must be authenticated via `kici login`.

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
2. Generates a `.d.ts` file that augments `@kici-dev/sdk`'s `KnownSecretKeys` and `EnvironmentSecrets` interfaces
3. Writes the file to `.kici/types/secrets.d.ts`

After generating types, `ctx.secrets.get('MY_KEY')` and `ctx.secrets.expose('DB_HOST')` gain autocomplete and type checking in your IDE.

**Git workflow:** Commit the generated `.kici/types/secrets.d.ts` so team members get type checking without needing orchestrator access. Run `kici types` to refresh when environments change.

**Auto-regeneration:** `kici compile` automatically runs `kici types` after successful compilation when authenticated. See the [kici compile](#kici-compile) section for details.

**Escape hatch:** For dynamic keys not in the generated types, use a cast: `(ctx.secrets as any).DYNAMIC_KEY`.

### kici fixture

Generate a fixture template for an event type. Useful for creating custom test payloads.

```bash
kici fixture <event> [options]
```

**Arguments:**

| Argument | Required | Description                   |
| -------- | -------- | ----------------------------- |
| `event`  | yes      | Event to generate fixture for |

**Valid events:** `pr:open`, `pr:sync`, `pr:close`, `pr:reopen`, `push`, `tag`, `comment`, `review`, `review_comment`, `release`, `dispatch`, `create`, `delete`, `status`, `workflow_run`, `fork`, `star`, `watch`, `kici_event`, `workflow_complete`, `job_complete`, `generic_webhook`, `schedule`, `lifecycle` (many support `:action` suffixes, e.g. `comment:edited`, `release:published`, `lifecycle:workflow_complete`). `webhook:<source>` is a shorthand alias for `generic_webhook:<source>`.

**Options:**

| Option            | Default | Description                     |
| ----------------- | ------- | ------------------------------- |
| `--output <path>` | stdout  | Write to file instead of stdout |

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

### kici init

Initialize a `.kici/` directory with default workflow templates.

```bash
kici init [options]
```

**Options:**

| Option                                | Default                | Description                                                                                             |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `--force`                             | `false`                | Overwrite existing `.kici/` directory                                                                   |
| `--skip-install`                      | `false`                | Create files without installing dependencies                                                            |
| `--package-manager <npm\|pnpm\|yarn>` | auto-detect            | Force a package manager for the install step (default: detect from your repo)                           |
| `--mjs`                               | `false`                | JavaScript-only mode (no TypeScript, no deps)                                                           |
| `--no-agents-md`                      | writes `AGENTS.md`     | Skip writing `.kici/AGENTS.md` (the LLM authoring context file)                                         |
| `--private-registry <url>`            | none                   | Scaffold a workflow `registries:` entry pointing at `<url>` (e.g. CodeArtifact, GH Packages, Verdaccio) |
| `--private-registry-scope <scope>`    | none                   | Optional npm package scope (e.g. `@my-org`) for the private registry                                    |
| `--private-registry-secret <ref>`     | `production:NPM_TOKEN` | Qualified secret reference (`env:NAME`) the private registry token comes from                           |

**Examples:**

```bash
# Interactive initialization
kici init

# Overwrite existing setup
kici init --force

# Skip dependency install (faster, install manually later)
kici init --skip-install

# Force a specific package manager (default: detect from your repo)
kici init --package-manager pnpm

# JavaScript mode (no TypeScript)
kici init --mjs

# Skip writing the AGENTS.md LLM authoring context file
kici init --no-agents-md

# Scaffold a workflow registries entry for a private npm registry
kici init --private-registry https://npm.pkg.github.com/ \
          --private-registry-scope @my-org \
          --private-registry-secret production:GITHUB_PACKAGES_TOKEN
```

**What it creates:**

```
.kici/
  workflows/
    hello-world.ts    # Minimal push workflow
    pr-checks.ts      # Comprehensive PR workflow
  tests/
    push-test.ts      # Sample test fixture
  types/              # Directory for generated type declarations (kici types)
  package.json        # Dependencies (@kici-dev/sdk)
  tsconfig.json       # TypeScript configuration (includes types/**/*.d.ts)
.kiciignore           # Default exclusion patterns for test uploads
```

In interactive mode (TTY), `kici init` prompts you to:

1. Select which workflow templates to include
2. Optionally install a pre-commit hook

**Package manager:** the dependency install step uses the package manager detected for your repo — the `packageManager` field in the nearest `package.json` (Corepack convention), then a lockfile in the project root (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), then the package manager that invoked `kici` (`pnpm dlx` / `yarn dlx` / `npx`), defaulting to npm. Pass `--package-manager <npm|pnpm|yarn>` to override detection, or `--skip-install` to set up the files and install later yourself.

**Development mode:** When `KICI_DEV=true` or `package.json` has `"kici": { "development": true }`, the generated `package.json` uses prerelease-compatible version ranges (`>=0.0.1-0`) so npm resolves Verdaccio's prerelease builds.

### kici hook install

Install a pre-commit hook that runs `kici compile` before each commit.

```bash
kici hook install [options]
```

**Options:**

| Option  | Default | Description                                |
| ------- | ------- | ------------------------------------------ |
| `--git` | `false` | Use raw git hook (`.git/hooks/pre-commit`) |

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

### kici endpoints

List all webhook entrypoints for the current project. Reads the compiled lock file and displays webhook URLs grouped by type (git provider, generic webhooks, scheduled, event-driven).

```bash
kici endpoints [options]
```

**Options:**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

**Prerequisites:** Run `kici compile` first to generate the lock file.

**Examples:**

```bash
# List all webhook entrypoints
kici endpoints

# Custom .kici directory
kici endpoints --kici-dir packages/app/.kici
```

### kici workflows list

List permanently registered workflows on the orchestrator.

```bash
kici workflows list [options]
```

**Options:**

| Option                  | Default | Description                                    |
| ----------------------- | ------- | ---------------------------------------------- |
| `--json`                | `false` | Output as JSON                                 |
| `--stale <duration>`    | none    | Filter stale registrations (e.g., `30d`, `7d`) |
| `--trigger-type <type>` | none    | Filter by trigger type                         |
| `--repo <repo>`         | none    | Filter by repository                           |

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

### kici docs

Open the KiCI documentation site in the default browser. With the `llm` subcommand, print the LLM-friendly documentation bundle that ships with `@kici-dev/compiler` — pipe it into a coding agent's context buffer to brief the agent on authoring conventions without an internet round-trip.

```bash
kici docs               # open https://kici.dev/docs/
kici docs --no-open     # print the URL instead of opening a browser
kici docs llm           # print llms-full.txt (the full bundle) to stdout
kici docs llm --index   # print llms.txt (the curated link index) to stdout
kici docs llm --out path/to/file.md   # write the bundle to a file
```

**Examples:**

```bash
# Open the docs site in your browser
kici docs

# Pipe the full LLM bundle into a coding agent
kici docs llm | claude -- "Read this and help me author a deploy workflow"

# Save the curated index for offline reference
kici docs llm --index --out kici-llms.txt
```

The bundle is regenerated from `docs/` every time `@kici-dev/compiler` is built, so it always matches your installed CLI version. The same content is available online at <https://kici.dev/llms.txt> and <https://kici.dev/llms-full.txt> following the [llms.txt convention](https://llmstxt.org/).

### kici admin

Operator-facing commands for running instances.

#### kici admin drain-worker

Trigger graceful drain on a worker instance. Sends a POST request to the worker's `/drain` endpoint.

```bash
kici admin drain-worker [options]
```

**Options:**

| Option        | Required | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `--url <url>` | yes      | Worker URL (e.g., `http://worker-host:10143`) |

**Examples:**

```bash
# Drain a local worker
kici admin drain-worker --url http://localhost:10143

# Drain a remote worker
kici admin drain-worker --url http://worker-2.internal:10143
```

**Exit codes:**

| Code | Meaning                             |
| ---- | ----------------------------------- |
| 0    | Drain request accepted              |
| 1    | Error (unreachable or request fail) |

### kici verify-attestation

Verify a KiCI build-provenance attestation bundle offline. A bundle is the signed package a workflow step produces via `ctx.attestProvenance(...)`: a DSSE-wrapped SLSA in-toto statement, the ephemeral public key that signed it, and the KiCI identity token that anchors the build context. For the end-to-end attest → verify → view journey, see the [build provenance guide](./provenance.md). Verification establishes the full chain — the identity token verifies against the trusted issuer's JWKS, the DSSE signature verifies against the bundled key, and the statement's build context must match the token's claims (a mismatch is a hard failure). When an `[artifact]` is given, its SHA-256 digest is also matched against the attestation subject.

```bash
kici verify-attestation [artifact] --bundle <path-or-url> --trust-root <url-or-file> [options]
```

**Arguments:**

| Argument     | Required | Description                                                           |
| ------------ | -------- | --------------------------------------------------------------------- |
| `[artifact]` | no       | Artifact path to digest-check against the attestation subject digest. |

**Options:**

| Option                       | Required | Description                                                                               |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `--bundle <path-or-url>`     | yes      | Path or `http(s)` URL to the attestation bundle JSON.                                     |
| `--trust-root <url-or-file>` | yes      | Trusted issuer (see below). The token issuer is pinned to it, never taken from the token. |
| `--audience <aud>`           | no       | Expected token audience (defaults to the KiCI provenance audience).                       |
| `--json`                     | no       | Print the structured verification result as JSON instead of human-readable output.        |

**Trust root:** the verifier never trusts the issuer named inside the token — you supply the trusted issuer out-of-band via `--trust-root`, in one of two forms:

- **Online — an HTTPS issuer URL.** The verifier fetches `<url>/.well-known/openid-configuration`, reads its `issuer` and `jwks_uri`, and fetches the JWKS. The token's `iss` is pinned to the discovery document's `issuer`.
- **Offline — a self-contained trust-root file.** A local JSON file with the issuer and JWKS inlined, so no network access is needed (air-gapped verification):

  ```json
  {
    "issuer": "https://platform.example/issuer",
    "jwks": {
      "keys": [
        { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "alg": "ES256", "kid": "..." }
      ]
    }
  }
  ```

**Examples:**

```bash
# Online: verify a bundle against a deployed issuer, digest-checking the artifact
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root https://platform.example/issuer

# Offline / air-gapped: verify against a self-contained trust-root file
kici verify-attestation ./dist/app.tgz \
  --bundle ./app.tgz.kici.json \
  --trust-root ./kici-trust-root.json

# Machine-readable result for scripting
kici verify-attestation --bundle ./app.tgz.kici.json \
  --trust-root https://platform.example/issuer --json
```

**Exit codes:**

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Verified — signature, identity, build context (and digest, if checked) all pass     |
| 1    | Not verified, or an error (missing flag, unreadable bundle, unreachable trust root) |

## Workflow discovery

The CLI discovers workflows by scanning `.kici/workflows/*.ts` (or `.mjs` in MJS mode). Each file should `export default` a single workflow:

```typescript
// .kici/workflows/ci.ts
import { workflow, job, step, pr } from '@kici-dev/sdk';

export default workflow('ci', {
  on: pr(),
  jobs: [
    /* ... */
  ],
});
```

Multiple workflow files are supported -- each becomes a separate workflow in `kici.lock.json`.

## Lock file

The `kici compile` command produces `.kici/kici.lock.json` inside the `.kici` directory. This file:

- Contains all workflow definitions in a portable JSON format
- Is used by the orchestrator to evaluate triggers without code checkout
- Should be committed to version control
- Is regenerated on every `kici compile` run

Use `kici compile --check` in CI to validate that workflows are correct without writing files. For the full story on drift, pre-commit/CI, and agent-side verification, see [Lock file and workflow drift](lock-file-and-drift.md).

## Exit codes

All commands follow a consistent exit code convention:

| Code | Meaning              |
| ---- | -------------------- |
| 0    | Success              |
| 1    | Failure (see output) |

## Debug output

Use `--debug` (on `kici run local`, `kici run remote`, `kici test`) or `--verbose` (on `kici compile`) for detailed output:

```bash
# Shows trigger matching, rule evaluation, decision traces
kici run local push --debug

# Shows detailed compilation steps
kici compile --verbose

# Shows trigger matching preview
kici test pr:open --debug
```

Set `KICI_DEBUG=true` for additional internal debug output across all commands.

## Environment variables

| Variable     | Description                               |
| ------------ | ----------------------------------------- |
| `KICI_DEV`   | Set to `true` for development mode        |
| `KICI_DEBUG` | Set to `true` for verbose internal output |
| `CI`         | When `true`, disables interactive prompts |

## See also

- [Getting started](getting-started.md) -- install the SDK and write your first workflow
- [Testing guide](testing-guide.md) -- writing fixtures, remote test runs, secret contexts, and repo state transfer
- [SDK reference](sdk-reference.md) -- complete API for the workflow definitions that the CLI compiles
- [Workflow patterns](workflow-patterns.md) -- example workflows to compile and test with these commands
