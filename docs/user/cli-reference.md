---
title: CLI reference
description: 'All CLI commands: compile, run (local/remote), orchestrators, preview, login, logout, org, diagnostics, runs (list/show/logs/rerun/cancel), secrets, types, fixture, init, hook, endpoints, workflows, docs, admin'
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
    "kici:preview": "kici preview"
  }
}
```

## Commands

### kici compile

Compile workflows from `.kici/workflows/` to `kici.lock.json`.

```bash
kici compile [options]
```

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

Execute workflows locally or remotely. A bare `kici run [event]` performs a real routed run with this machine as the ephemeral agent; the `remote` subcommand runs fixtures through an orchestrator.

#### kici run <event> --local

Run a workflow on this machine as a real routed dispatch. `kici run <event> --local` compiles your workflows, matches triggers against the specified event, expands matrices, and executes the matched jobs — this machine joins as an ephemeral agent through the warm local dev plane. No orchestrator deployment is required.

`kici run local` (the old direct-execution subcommand) is retired: every run is now a real routed dispatch. Invoking `kici run local <event>` prints a hint pointing at `kici run <event> --local` and exits without running.

```bash
kici run [event] --local [options]
```

**Concurrency enforcement:**

When the workflow declares a `concurrency` block, `kici run <event> --local` enforces it across concurrent local invocations on the same machine and user account. The behavior mirrors the orchestrator:

- The `group` callback is evaluated against the simulated event (same `{ branch, event }` context that the agent sees), and the resulting key is used as the lock identity. Throwing from `group` aborts the workflow run with a clear error — there is no fallback to the workflow name.
- `cancelInProgress: true` interrupts the holder via `SIGTERM`, then escalates to `SIGKILL` after a grace window if the holder does not exit, and proceeds with the new run.
- Otherwise the new invocation waits in FIFO order. A status line is printed when the wait starts and roughly every five seconds thereafter.
- Locks live under `$XDG_RUNTIME_DIR/kici-local-locks/` on Linux, falling back to `os.tmpdir()/kici-local-locks-<uid>/` on platforms without a per-user runtime dir. Each lock file records the holder PID, hostname, workflow name, group key, and start timestamp so concurrent invocations can describe what they are waiting for.
- Stale locks (the recorded holder PID is gone, per `process.kill(pid, 0)`) are reclaimed automatically.

Coordination is local only — running the same workflow on two different machines does not serialize across them. That requires the orchestrator.

The `SIGTERM`-to-`SIGKILL` grace window defaults to 30 000 ms. Override it with the `KICI_LOCAL_LOCK_KILL_GRACE_MS` environment variable (positive integer, milliseconds) when iterating on workflows that need longer to clean up on cancellation.

**Execution isolation:**

By default, `kici run <event> --local` executes steps inside an **isolated tmp checkout** rather than against your real working directory. Any file a step writes, builds, or deletes — and any `git` mutation a step performs — lands in that throwaway copy, so casual local runs never touch your tree.

What gets materialized into the isolated checkout has full parity with what `kici run remote` reconstructs: your current working tree minus gitignored files, with `.kiciignore` applied to local changes, over a real `.git` directory. Concretely, the checkout is built from a clone pinned to your current `HEAD`, with your local overlay (modified, staged, and untracked-but-not-ignored files) copied on top and locally-deleted files removed. Workflows that read git metadata work because the `.git` directory is present and pinned to your `HEAD`.

The path is logged at run start (for example, `running in /tmp/kici-run-ab12cd`) so you can inspect it.

Cleanup policy:

- On a fully successful run, the isolated checkout is removed.
- On failure, it is retained and its path is logged so you can inspect the failed state.
- Retained checkouts are garbage-collected after 72 hours by the next `kici run <event> --local` invocation — copy a checkout elsewhere if you need it longer.

Set the `KICI_RUN_DIR` environment variable to place the isolated checkout under a base directory other than the system temp directory.

Secrets are always sourced from your real `.kici/` directory, not from the isolated checkout. Gitignored secret files (such as `.kici/.env.local` and `.kici/secrets.yaml`) are never copied into the checkout, so a step that reads a secret still gets it from the original location.

Pass `--in-place` to run against the real working directory instead — useful when you explicitly want in-tree execution. `--in-place` requires no git repository; the default isolated mode does, and fails with an actionable error pointing at `--in-place` when the directory is not a git repository.

**Examples:**

```bash
# Run workflows matching a push event on this machine
kici run push --local

# Run a pull-request-open workflow locally
kici run pr:open --local

# Reuse the working tree instead of an isolated clone
kici run push --local --in-place

# Force the throwaway/offline plane
kici run push --local --offline

# Environment variable overrides
kici run push --local --env NODE_ENV=test --env CI=true

# Quiet mode (summary only, no streaming)
kici run push --local --quiet
```

**Exit codes:**

| Code | Meaning                 |
| ---- | ----------------------- |
| 0    | All workflows succeeded |
| 1    | One or more jobs failed |

#### kici run remote

Execute fixtures remotely through the full CI pipeline. Fixtures are defined in `.kici/tests/*.ts` using the `fixture()` factory function. Without arguments, lists available fixtures.

Remote runs route through the Platform. Authenticate with a personal access token (`kici login`), then target an organization with `kici org use <org>` or the `--org` flag. The Platform relays the run to the org's orchestrator, while your working-tree overlay uploads directly to object storage — see [How the run is routed](#how-the-run-is-routed) and [The two planes](#the-two-planes) below.

Like `kici run <event> --local`, `kici run remote` recompiles your workflows (`.kici/workflows` → `kici.lock.json`) before dispatching, so the orchestrator matches and dispatches against your current workflow definitions — a brand-new or edited workflow takes effect without a separate `kici compile`. A compile or validation error aborts the run before anything is uploaded.

The orchestrator must have **cache storage configured** (`KICI_STORAGE_TYPE` = `s3` or `filesystem`) with a dev-reachable upload endpoint so the CLI's direct upload succeeds; see the [testing guide](testing-guide.md) and [Storage layout](../operator/orchestrator/storage-layout.md) for setup.

```bash
kici run remote [fixture] [options]
```

`--approve-all` works in `--json` / `--quiet` mode: the run still auto-approves each gate it holds on, and the auto-approve diagnostics are written to stderr so stdout stays a pure JSON (or summary-only) payload. Without `--approve-all`, a `--json` / `--quiet` run that hits a gate stays held and prints a one-line "run held; approve via the dashboard or `kici approve <run-id>`" notice to stderr per hold.

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

# Interactively pick which fixtures to run (multi-select)
kici run remote --pick

# Narrow runsOnAll jobs to a subset of the host roster
kici run remote deploy --target role:web

# AND-combine repeated --target values (hosts must match every selector)
kici run remote deploy --target role:web --target dc:eu

# Skip a runsOnAll job instead of failing it when the target matches no host
kici run remote deploy --target role:gpu --target-allow-empty
```

**Interactive fixture selection (`--pick` / `-p`):**

Pass `--pick` (or `-p`) to open an interactive checkbox menu of the available
fixtures. Toggle one or more with space, confirm with enter, and the selected
fixtures run through the normal remote pipeline (honoring `--parallel`,
`--no-wait`, and the other run flags). Notes:

- `--pick` is mutually exclusive with a fixture argument, `--all`, and
  `--workflow`. Passing any together exits with code 2.
- When `stdin` is not a TTY, `--pick` prints the available fixtures and exits
  without running anything — pass a fixture name (or `--all`) in scripts.

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

An orchestrator with no Platform connection cannot serve remote runs — the Platform is the service that offers them. For executing workflow steps on your own machine without an orchestrator (no scaler, agents, or environments), use [`kici run <event> --local`](#kici-run-event---local).

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

### kici login

Authenticate with KiCI via browser-based OAuth (default) or API key (`--token`).

By default, `kici login` opens your browser for OIDC authentication using PKCE. In headless environments (SSH, CI, containers), it automatically switches to the RFC 8628 device authorization flow where you visit a URL and enter a code.

After OAuth, the CLI exchanges the OIDC token for a personal access token (PAT) stored in the config directory (`~/.kici/config` by default, overridable with `KICI_CONFIG_DIR`).

`kici login` targets the hosted KiCI Platform by default. To authenticate against another KiCI environment (staging, or a testing OIDC provider, for example), pass `--platform-endpoint` / `--oidc-issuer` or set `KICI_PLATFORM_URL` / `KICI_OIDC_ISSUER`. Login persists the platform endpoint and OIDC issuer it authenticated against alongside the PAT, so a saved PAT always matches its endpoint. Because the config describes one environment at a time, **switching the endpoint resets the active organization and default clusters** — re-run `kici org use <name>` after switching environments.

```bash
kici login [options]
```

**Environment variables:**

| Variable              | Default                                      | Description                                                            |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `KICI_PLATFORM_URL`   | `https://api.kici.dev`                       | Platform API base URL (override to target another KiCI environment)    |
| `KICI_OIDC_ISSUER`    | `https://auth.kici.dev/realms/kici-internal` | OIDC issuer URL (override to target another KiCI environment)          |
| `KICI_OIDC_CLIENT_ID` | `kici-cli`                                   | OIDC client ID (override to target another KiCI environment)           |
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

# Log in against another KiCI environment (e.g. a testing instance)
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
terminal equivalent of the dashboard Infrastructure page. Reads the same
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

```bash
kici runs list
kici runs list --status running
kici runs list --workflow ci --branch main
kici runs list --json | jq '.runs[].runId'
```

#### kici runs show

Show a run's summary header plus its jobs-and-steps tree (name, status,
duration, exit code). If the run id is not on the Platform but exists in your
local run history (from `kici run <event> --local`), the local record is shown instead.

```bash
kici runs show <run-id> [options]
```

```bash
kici runs show abc123
kici runs show abc123 --json
```

#### kici runs logs

Print each job/step's log lines in order, with headers.

```bash
kici runs logs <run-id> [options]
```

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

```bash
kici runs rerun abc123
```

#### kici runs cancel

Cancel a single run, or all in-progress runs on a branch.

```bash
kici runs cancel [run-id] [options]
```

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

**Examples:**

```bash
# Approve a workflow-level hold
kici approve abc123

# Approve a held job
kici approve abc123 --job deploy-production

# Approve a held step (steps are addressed by index)
kici approve abc123 --job migrate-and-deploy --step 1
```

You must be eligible for at least one unsatisfied clause (a member of a named team, or a named user) and hold the `contexts:write` or `ci_trust:write` permission. The command reports whether the element was released, how many clauses remain, or that it was rejected.

### kici reject

Reject a held [approval gate](approvals.md). A rejection fails the held element and the run. A reason is required.

```bash
kici reject <run-id> --reason <text> [options]
```

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

Each context corresponds to a context configured on the orchestrator. The output lists every context whose `allowLocalExecution` flag is `true` (the gate that lets CLI-initiated test runs resolve secrets through that context), along with the secret key names reachable from the context's bound scopes.

Only key names are shown — secret values are never returned over this endpoint.

**Prerequisites:** authenticate via `kici login` and select an active organization with `kici org use <name>`.

### kici pat create

Mint a personal access token under your own identity. Pass `--agent` to mint an
**agent-kind** PAT — the credential a coding agent points the KiCI MCP server at.

```bash
kici pat create --agent --name "claude-code"
```

- `--agent` marks the token as agent-kind. An agent PAT inherits your
  permissions unchanged (it carries provenance, not extra authority) and is the
  **only** credential the MCP server accepts.
- `--name <label>` sets the token name. For an agent PAT this is the **agent
  label** recorded on every action the agent takes — required with `--agent`.
- `--expires-in-days <n>` overrides the default expiry.

The token is printed once — save it immediately; it cannot be retrieved later.
See [Drive KiCI from your coding agent](./ai-agents.md) for the full setup.

**Prerequisites:** authenticate via `kici login` first.

### kici types

Generate TypeScript declaration files from orchestrator environment metadata. The generated `.d.ts` file augments the SDK's `KnownSecretKeys` and `ContextSecrets` interfaces, providing compile-time autocomplete and type checking for secret key names.

```bash
kici types [options]
```

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
2. Generates a `.d.ts` file that augments `@kici-dev/sdk`'s `KnownSecretKeys` and `ContextSecrets` interfaces
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

**Valid events:** `pr:open`, `pr:sync`, `pr:close`, `pr:reopen`, `push`, `tag`, `comment`, `review`, `review_comment`, `release`, `dispatch`, `create`, `delete`, `status`, `workflow_run`, `fork`, `star`, `watch`, `kici_event`, `workflow_complete`, `job_complete`, `generic_webhook`, `schedule`, `lifecycle` (many support `:action` suffixes, e.g. `comment:edited`, `release:published`, `lifecycle:workflow_complete`). `webhook:<source>` is a shorthand alias for `generic_webhook:<source>`.

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

Bundles are regenerated from `docs/` every time `@kici-dev/compiler` is built, so they always match your installed CLI version. The index lists each task bundle — `getting-started`, `sdk`, `cli`, `patterns`, `features`, `providers`, `architecture` — with its size and a one-line purpose; pass the bundle id as the topic. Every cross-reference link inside a bundle is an absolute `docs.kici.dev` URL. The same files are published online following the [llms.txt convention](https://llmstxt.org/).

### kici admin

Operator-facing commands for running instances.

#### kici admin drain-worker

Trigger graceful drain on a worker instance. Sends a POST request to the worker's `/drain` endpoint.

```bash
kici admin drain-worker [options]
```

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

On success the output prints the **origin org** (the customer's public org id — the authoritative "who built this" the platform vouches for) and a **source marker**. A `kici run remote` attestation is flagged unmistakably: its `repository`/`ref`/`sha` are caller-supplied from a local working-tree overlay, not a triggered VCS commit, so a verifier must treat those coordinates as org-asserted rather than VCS-verified. A normal triggered run carries the ordinary `triggered` source marker. See the [build provenance guide](./provenance.md) for the full trust model.

```bash
kici verify-attestation [artifact] --bundle <path-or-url> [--trust-root <url-or-file>] [options]
```

**Trust root:** `--trust-root` defaults to the hosted KiCI platform's provenance issuer — the same platform you `kici login` against (see [Which trust root do I use?](./provenance.md#which-trust-root-do-i-use)), so the common case needs no flag. The verifier never trusts the issuer named inside the token; supplying it out-of-band is what prevents a forged bundle from self-attesting. To override the default, pass `--trust-root` in one of two forms:

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
# Default: verify against the hosted KiCI platform (no --trust-root needed)
kici verify-attestation ./dist/app.tgz --bundle ./app.tgz.kici.json

# Override: verify a bundle against a specific issuer, digest-checking the artifact
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

**Attestation origin marker.** On a PASS, the command surfaces when the identity
token was minted relative to the build. A normal attestation prints no marker
(the token was minted live). A **deferred** attestation prints an `ATTESTATION:
deferred` line — the build facts were sealed at build time and the token was
minted later, after a transient platform outage, bound to the frozen statement
by its hash. An **offline-backfill** attestation prints an `ATTESTATION:
offline-backfill` line — the run was ingested while the platform was down, so its
run/job rows were backfilled before the token was minted. Both still verify
(PASS); the marker discloses the temporal gap, and the organization id remains
the authoritative anchor.

**Exit codes:**

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | Verified — signature, identity, build context (and digest, if checked) all pass           |
| 1    | Not verified, or an error (missing `--bundle`, unreadable bundle, unreachable trust root) |

## Command reference

The exhaustive, always-current list of every `kici` command with its arguments and options, generated from the CLI's command tree so it never drifts from the shipped binary. The sections above add concepts and worked examples; the reference below is the authoritative signature list.

<!-- BEGIN GENERATED: kici-commands (do not edit; run the doc generator) -->

### `kici admin`

Operator-facing commands for running instances

Synopsis: `kici admin`

### `kici admin drain-worker`

Trigger graceful drain on a worker instance

Synopsis: `kici admin drain-worker [options]`

**Options**

| Option        | Default | Description                                  |
| ------------- | ------- | -------------------------------------------- |
| `--url <url>` |         | Worker URL (e.g., http://worker-host:<port>) |

### `kici approve`

Approve a held approval gate for a run

Synopsis: `kici approve <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description                           |
| -------- | -------- | -------- | ------------------------------------- |
| `run-id` | yes      | no       | Run ID whose approval gate to approve |

**Options**

| Option           | Default | Description                                 |
| ---------------- | ------- | ------------------------------------------- |
| `--job <name>`   |         | Approve the hold for a specific job         |
| `--step <index>` |         | Approve a step-scoped hold (requires --job) |

### `kici compile`

Compile workflows from .kici/workflows/ to kici.lock.json

Synopsis: `kici compile [options]`

**Options**

| Option              | Default | Description                                  |
| ------------------- | ------- | -------------------------------------------- |
| `--check`           | `false` | Validate workflows without writing lock file |
| `--kici-dir <path>` | `.kici` | Path to .kici directory                      |
| `--verbose`         | `false` | Detailed output                              |
| `--watch`           | `false` | Watch for changes and recompile              |

### `kici diagnostics`

Show orchestrators, scalers, and agents (mirrors the dashboard Diagnostics page)

Synopsis: `kici diagnostics [options]`

**Options**

| Option                | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `--json`              | `false` | Output raw JSON                     |
| `--verbose`           | `false` | Show extended per-agent fields      |
| `--orchestrator <id>` |         | Scope the tree to one connection id |

### `kici docs`

Open the KiCI documentation site in the default browser

Synopsis: `kici docs [options]`

**Options**

| Option      | Default | Description                                     |
| ----------- | ------- | ----------------------------------------------- |
| `--no-open` |         | Print the docs URL instead of opening a browser |

### `kici docs llm`

Print KiCI LLM docs bundles. No topic prints the llms.txt index; <topic> prints a task bundle (e.g. sdk, cli, patterns, features, providers, architecture, getting-started); "full" prints the complete bundle.

Synopsis: `kici docs llm [topic] [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `topic`  | no       | no       |             |

**Options**

| Option         | Default | Description                                  |
| -------------- | ------- | -------------------------------------------- |
| `--out <path>` |         | Write the bundle to a file instead of stdout |

### `kici endpoints`

List all webhook entrypoints for the current project

Synopsis: `kici endpoints [options]`

**Options**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

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

### `kici init`

Initialize .kici/ directory with default workflows

Synopsis: `kici init [options]`

**Options**

| Option                             | Default                | Description                                                                 |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------- | --- | ------------------------------------------------------------------- |
| `--force`                          | `false`                | Overwrite existing .kici/ directory                                         |
| `--skip-install`                   | `false`                | Create files without installing dependencies                                |
| `--package-manager <npm            | pnpm                   | yarn>`                                                                      |     | Force a package manager for the install step (default: auto-detect) |
| `--mjs`                            | `false`                | JavaScript-only mode (no TypeScript, no dependencies)                       |
| `--no-agents-md`                   |                        | Skip writing .kici/AGENTS.md (LLM authoring context)                        |
| `--private-registry <url>`         |                        | Scaffold a workflow registries: entry pointing at <url>                     |
| `--private-registry-scope <scope>` |                        | Optional npm package scope (e.g. @my-org) for the private registry          |
| `--private-registry-secret <ref>`  | `production:NPM_TOKEN` | Qualified secret reference (env:NAME) the private registry token comes from |
| `--use-verdaccio-local`            | `false`                |                                                                             |

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

Synopsis: `kici local status`

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

### `kici login`

Authenticate with KiCI via browser OAuth (default) or API key (--token)

Synopsis: `kici login [options]`

**Options**

| Option                      | Default | Description                                                                         |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `--token <key>`             |         | API key for direct authentication (legacy)                                          |
| `--device`                  |         | Force device authorization flow (for headless/SSH environments)                     |
| `--platform-endpoint <url>` |         | Platform relay URL                                                                  |
| `--oidc-issuer <url>`       |         | OIDC issuer URL (defaults to the hosted KiCI IdP unless a flag/env selects another) |
| `--routing-key <key>`       |         | Routing key for webhook source identification                                       |
| `--no-attach`               |         | Skip the post-login prompt to attach the local dev plane                            |

### `kici logout`

Revoke PAT and clear local credentials

Synopsis: `kici logout`

### `kici orchestrators`

Inspect the org's orchestrator clusters and pick a default for run remote

Synopsis: `kici orchestrators`

### `kici orchestrators list`

List the connected orchestrator clusters for the active org

Synopsis: `kici orchestrators list [options]`

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici orchestrators use`

Set the per-org default orchestrator cluster for run remote

Synopsis: `kici orchestrators use <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description               |
| -------- | -------- | -------- | ------------------------- |
| `name`   | yes      | no       | Orchestrator cluster name |

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici org`

Manage organizations

Synopsis: `kici org`

### `kici org current`

Show current active organization

Synopsis: `kici org current`

### `kici org list`

List organizations you belong to

Synopsis: `kici org list`

### `kici org use`

Switch active organization

Synopsis: `kici org use <name>`

**Arguments**

| Argument | Required | Variadic | Description             |
| -------- | -------- | -------- | ----------------------- |
| `name`   | yes      | no       | Organization name or ID |

### `kici pat`

Manage personal access tokens

Synopsis: `kici pat`

### `kici pat create`

Mint a personal access token (use --agent for a coding-agent token)

Synopsis: `kici pat create [options]`

**Options**

| Option                  | Default | Description                                    |
| ----------------------- | ------- | ---------------------------------------------- |
| `--name <name>`         |         | Token name (defaults to the agent label)       |
| `--agent`               | `false` | Mint an agent-kind PAT for the KiCI MCP server |
| `--expires-in-days <n>` |         | Custom expiry in days                          |

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

### `kici reject`

Reject a held approval gate for a run

Synopsis: `kici reject <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description                          |
| -------- | -------- | -------- | ------------------------------------ |
| `run-id` | yes      | no       | Run ID whose approval gate to reject |

**Options**

| Option            | Default | Description                                |
| ----------------- | ------- | ------------------------------------------ |
| `--job <name>`    |         | Reject the hold for a specific job         |
| `--step <index>`  |         | Reject a step-scoped hold (requires --job) |
| `--reason <text>` |         | Reason for the rejection                   |

### `kici run`

Execute workflows locally or remotely

Synopsis: `kici run [event] [options]`

**Arguments**

| Argument | Required | Variadic | Description                                            |
| -------- | -------- | -------- | ------------------------------------------------------ |
| `event`  | no       | no       | Event type for a routed local run (e.g. push, pr:open) |

**Options**

| Option              | Default | Description                                                                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--local`           | `false` | Route the run with this machine as the ephemeral agent                                                                   |
| `--offline`         | `false` | Force the throwaway/independent plane (offline)                                                                          |
| `--connected`       | `false` | Force the connected/hybrid plane (requires attachment)                                                                   |
| `--in-place`        | `false` | Reuse the working tree directly instead of an isolated clone                                                             |
| `--trusted`         | `false` | Route to the trusted fleet agent profile: steps see the ambient host env (minus the agent identity). Alias: --no-sandbox |
| `--no-sandbox`      |         | Alias for --trusted (the bwrap sandbox is already off by default)                                                        |
| `--env <KEY=VALUE>` |         | Per-run secret (repeatable)                                                                                              |
| `--payload <path>`  |         | Dispatch payload JSON { action?, client_payload? } for a routed dispatch run                                             |
| `--kici-dir <path>` | `.kici` | Path to .kici directory                                                                                                  |
| `--quiet`           | `false` | Suppress the banner + streaming output                                                                                   |
| `--debug`           | `false` | Verbose internals                                                                                                        |

### `kici run remote`

Execute fixtures remotely via orchestrator

Synopsis: `kici run remote [fixture] [options]`

**Arguments**

| Argument  | Required | Variadic | Description                                           |
| --------- | -------- | -------- | ----------------------------------------------------- |
| `fixture` | no       | no       | Fixture name or glob pattern (omit to list available) |

**Options**

| Option                      | Default | Description                                                                                 |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `--workflow <name>`         |         | Run a specific workflow directly (bypass triggers)                                          |
| `--all`                     | `false` | Run all available fixtures                                                                  |
| `-p, --pick`                | `false` | Interactively pick fixtures to run                                                          |
| `--parallel`                | `false` | Run matching fixtures concurrently                                                          |
| `--no-wait`                 |         | Fire and forget (print runIds, don't stream)                                                |
| `--quiet`                   | `false` | Suppress output except final result                                                         |
| `--json`                    | `false` | Output structured JSON result                                                               |
| `--junit <path>`            |         | Output JUnit XML result                                                                     |
| `--history`                 | `false` | Show recent run history                                                                     |
| `--routing-key <key>`       |         | Override routing key for this run                                                           |
| `--org <id>`                |         | Target organization (overrides the active org)                                              |
| `--orchestrator <name>`     |         | Target orchestrator cluster (overrides the per-org default)                                 |
| `--debug`                   | `false` | Verbose internals                                                                           |
| `--kici-dir <path>`         | `.kici` | Path to .kici directory                                                                     |
| `--context <ctx.key=value>` |         | Inject a namespaced context secret, uploaded encrypted to the orchestrator (repeatable)     |
| `--env <KEY=VALUE>`         |         | Provide a per-run secret (repeatable); uploaded encrypted to the orchestrator               |
| `--check`                   | `false` | Run in check mode: report drift, change nothing                                             |
| `--fail-on-drift`           | `false` | In check mode, exit non-zero if any step reports drift                                      |
| `--target <selector>`       |         | Narrow runsOnAll jobs to hosts matching this label selector (repeatable, AND-combined)      |
| `--target-allow-empty`      | `false` | A --target that narrows a runsOnAll job to zero hosts skips it instead of failing           |
| `--input <KEY=VALUE>`       |         | Typed workflow-dispatch input (repeatable)                                                  |
| `--yes, --approve-all`      | `false` | Auto-approve every approval gate this run holds on (run-scoped; eligibility still enforced) |

### `kici runs`

Inspect and manage execution runs

Synopsis: `kici runs`

### `kici runs cancel`

Cancel a run, or all in-progress runs on a branch

Synopsis: `kici runs cancel [run-id] [options]`

**Arguments**

| Argument | Required | Variadic | Description      |
| -------- | -------- | -------- | ---------------- |
| `run-id` | no       | no       | Run ID to cancel |

**Options**

| Option            | Default | Description                                 |
| ----------------- | ------- | ------------------------------------------- |
| `--force`         | `false` | Force cancel (kill immediately, skip hooks) |
| `--branch <name>` |         | Cancel all in-progress runs on this branch  |

### `kici runs list`

List execution runs (mirrors the dashboard Runs page)

Synopsis: `kici runs list [options]`

**Options**

| Option                  | Default | Description                            |
| ----------------------- | ------- | -------------------------------------- |
| `--status <s>`          |         | Filter by status                       |
| `--workflow <w>`        |         | Filter by workflow name                |
| `--branch <b>`          |         | Filter by branch/ref                   |
| `--repo <r>`            |         | Filter by repository                   |
| `--trigger <t>`         |         | Filter by trigger type                 |
| `--source <routingKey>` |         | Filter by source routing key           |
| `--since <ts>`          |         | Only runs since (ISO-8601 or epoch ms) |
| `--page <n>`            |         | Page number                            |
| `--json`                | `false` | Output raw JSON                        |

### `kici runs logs`

Print step logs for a run

Synopsis: `kici runs logs <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `run-id` | yes      | no       | Run ID      |

**Options**

| Option         | Default | Description              |
| -------------- | ------- | ------------------------ |
| `--job <name>` |         | Only logs for this job   |
| `-f, --follow` | `false` | Tail logs for a live run |
| `--json`       | `false` | Output raw JSON          |

### `kici runs rerun`

Re-trigger a run

Synopsis: `kici runs rerun <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description     |
| -------- | -------- | -------- | --------------- |
| `run-id` | yes      | no       | Run ID to rerun |

**Options**

| Option   | Default | Description     |
| -------- | ------- | --------------- |
| `--json` | `false` | Output raw JSON |

### `kici runs show`

Show a run summary with its jobs and steps

Synopsis: `kici runs show <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description       |
| -------- | -------- | -------- | ----------------- |
| `run-id` | yes      | no       | Run ID to inspect |

**Options**

| Option   | Default | Description     |
| -------- | ------- | --------------- |
| `--json` | `false` | Output raw JSON |

### `kici secrets`

Manage secrets

Synopsis: `kici secrets`

### `kici secrets list`

List test-available secret contexts

Synopsis: `kici secrets list`

### `kici types`

Generate TypeScript declarations for secret contexts

Synopsis: `kici types [options]`

**Options**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

### `kici verify-attestation`

Verify a KiCI provenance attestation bundle offline

Synopsis: `kici verify-attestation [artifact] [options]`

**Arguments**

| Argument   | Required | Variadic | Description                                                              |
| ---------- | -------- | -------- | ------------------------------------------------------------------------ |
| `artifact` | no       | no       | Artifact path to digest-check against the attestation subject (optional) |

**Options**

| Option                       | Default | Description                                                                                   |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--bundle <path>`            |         | Path or URL to the attestation bundle JSON                                                    |
| `--trust-root <url-or-file>` |         | Trusted issuer URL, or a self-contained { issuer, jwks } file (default: hosted KiCI platform) |
| `--audience <aud>`           |         | Expected token audience                                                                       |
| `--json`                     | `false` | Output structured JSON result                                                                 |

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

<!-- END GENERATED: kici-commands -->

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

Use `--debug` (on `kici run <event> --local`, `kici run remote`, `kici preview`) or `--verbose` (on `kici compile`) for detailed output:

```bash
# Shows trigger matching, rule evaluation, decision traces
kici run push --local --debug

# Shows detailed compilation steps
kici compile --verbose

# Shows trigger matching preview
kici preview pr:open --debug
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
