---
title: 'kici: runs & approvals'
description: 'Run push and inspection plus approval / rejection of held runs'
---

## Guide

### kici run

Execute workflows locally or remotely. A bare `kici run [event]` performs a real routed run with this machine as the ephemeral agent; the `remote` subcommand runs fixtures through an orchestrator.

#### kici run <event> --local

Run a workflow on this machine as a real routed dispatch. `kici run <event> --local` compiles your workflows, matches triggers against the specified event, expands matrices, and executes the matched jobs — this machine joins as an ephemeral agent through the warm local dev plane. No orchestrator deployment is required.

`kici run local` (the old direct-execution subcommand) is retired: every run is now a real routed dispatch. Invoking `kici run local <event>` prints a hint pointing at `kici run <event> --local` and exits without running.

```bash
kici run [event] --local [options]
```

**Concurrency enforcement:**

A local run is a real routed dispatch, so a workflow's `concurrency` block is enforced by the local dev plane's own orchestrator — the same machinery a deployed orchestrator uses:

- The `group` callback is evaluated agent-side against the simulated event (the same `{ branch, event }` context the agent sees), and the resulting key is reported back to the plane's orchestrator before steps execute.
- `cancelInProgress: true` supersedes the older run in the group; `false` queues the newer run behind it.

Coordination is scoped to that plane, whose state lives under `~/.kici/local/` — so enforcement is per-machine and per-user, and running the same workflow on two different machines does not serialize across them. That requires a deployed orchestrator.

**Execution isolation:**

By default, `kici run <event> --local` executes steps inside an **isolated tmp checkout** rather than against your real working directory. Any file a step writes, builds, or deletes — and any `git` mutation a step performs — lands in that throwaway copy, so casual local runs never touch your tree.

What gets materialized into the isolated checkout has full parity with what `kici run remote` reconstructs: your current working tree minus gitignored files, with `.kiciignore` applied to local changes, over a real `.git` directory. Concretely, the checkout is built from a clone pinned to your current `HEAD`, with your local overlay (modified, staged, and untracked-but-not-ignored files) copied on top and locally-deleted files removed. Workflows that read git metadata work because the `.git` directory is present and pinned to your `HEAD`.

The checkout is a fresh temp directory named `kici-local-run-<random>` under the system temp directory (for example, `/tmp/kici-local-run-ab12cd`).

Cleanup policy:

- The isolated checkout is removed when the run finishes, whether it succeeded or failed.
- A hard process death (SIGKILL, OOM kill) skips that cleanup. Leftovers older than a day are swept by the agent's own startup garbage collection, which every `kici run <event> --local` invocation triggers.

Set the `KICI_TMPDIR` environment variable to place the isolated checkout (and every other KiCI-created temp directory) under a base directory other than the system temp directory.

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

The orchestrator must have **cache storage configured** (`KICI_STORAGE_TYPE` = `s3` or `filesystem`) with a dev-reachable upload endpoint so the CLI's direct upload succeeds; see the [testing guide](../testing-guide.md) and [Storage layout](../../operator/orchestrator/storage-layout.md) for setup.

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
`when: 'always'`) still runs. See [Job dependencies](../sdk/core.md#job-dependencies-needs)
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
- **Data plane** — your working-tree overlay tarball uploads **directly** from your machine to the orchestrator's object store via a presigned PUT URL. The overlay never passes through the Platform. This is why the orchestrator's object-store upload endpoint must be reachable from your machine; see [Storage layout](../../operator/orchestrator/storage-layout.md).

An orchestrator with no Platform connection cannot serve remote runs — the Platform is the service that offers them. For executing workflow steps on your own machine without an orchestrator (no scaler, agents, or environments), use [`kici run <event> --local`](#kici-run-event---local).

#### Fresh repos (no GitHub remote)

`kici run remote` works even if the repo has never been pushed to GitHub. When no remote is detected:

- The entire repo content is uploaded (not just a diff overlay)
- The lock file is sent inline (no GitHub API fetch)
- Steps that use git commands will fail (no `.git` directory in the remote workspace)
- Build cache (`__build__` jobs) is skipped for local repos
- Environments must have `allowLocalExecution: true` to be accessible from local runs (default is `false`)

Destination routing is unchanged for fresh repos: the run still goes to your active org through the Platform.

For a detailed guide on writing fixtures, configuring secrets, and understanding the upload flow, see [Testing guide](../testing-guide.md).

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

### kici runs

Inspect and manage execution runs from the terminal — the equivalent of the
dashboard Runs page. All `kici runs` subcommands read/write the same org-scoped
data as the dashboard, so they require `kici login` and an active org
(`kici org use <name>`).

#### kici runs list

List runs with optional filters. Output is a table (run id, workflow, status,
branch, trigger, started, duration); pagination is reported at the bottom.

When no runs match, `kici runs list` checks whether any webhooks arrived
recently. If deliveries came in but nothing produced a run, it prints a
one-line summary ("3 webhooks received in the last hour, 0 matched") and
suggests `kici preview push` to test your triggers locally — the fast way to
find a misconfigured trigger. When nothing arrived it prints "No runs found."
as before.

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

#### kici runs artifacts list

List the [artifacts](../sdk/artifacts.md) a run uploaded — name, producing job,
size, content hash, and creation time. An artifact whose stored object can no
longer be reached is flagged `unavailable`.

```bash
kici runs artifacts list <run-id> [options]
```

```bash
kici runs artifacts list abc123
kici runs artifacts list abc123 --json
```

#### kici runs artifacts download

Download a run's artifacts. Name one to fetch just that artifact; omit the name
to download every artifact of the run. Each artifact extracts into its own
`<name>/` directory by default.

```bash
kici runs artifacts download <run-id> [name] [options]
```

- `--archive` — save the raw `.tar.gz` as `<name>.tar.gz` instead of extracting.
- `-o, --output <dir>` — write into `<dir>` instead of the current directory.

```bash
kici runs artifacts download abc123 bundle
kici runs artifacts download abc123 bundle -o ./out
kici runs artifacts download abc123 --archive
kici runs artifacts download abc123
```

The download streams directly from object storage over a short-lived signed URL
— the artifact bytes never pass through the KiCI Platform — and the content hash
is verified end to end, so a corrupted or truncated transfer fails loudly rather
than leaving a bad file on disk.

Artifacts expire after the orchestrator's configured retention. When you name a
single artifact whose stored object is already gone, the command fails. When you
download the whole run, such an artifact is reported as a warning and skipped so
the remaining artifacts still land — the command fails only if every artifact of
the run was unreachable. Any other failure (a rejected signed URL, a content-hash
mismatch) stops the command immediately rather than continuing with the rest.

Artifact names are case-sensitive, so a single run can hold both `bundle` and
`Bundle`. On a filesystem that ignores case in path lookups — macOS and Windows
default to this, Linux does not — both would land on the same path, so
downloading the whole run refuses before writing anything and names the pair.
Fetch them one at a time into separate directories instead:

```bash
kici runs artifacts download abc123 bundle -o ./bundle-lower
kici runs artifacts download abc123 Bundle -o ./bundle-upper
```

Naming a single artifact is never affected, and on a case-sensitive filesystem
downloading the whole run still writes both.

Artifacts are packed relative to two roots: paths inside your repository and
paths under the home directory. Repository-relative files land directly under
`<name>/`; home-relative files land under `<name>/~home/`, so the two can never
overwrite each other and nothing is ever written outside the output directory.

When `--json` is set on any of these commands, `kici` emits only the JSON
document on stdout — the `kici v<version>` banner is suppressed — so the output
is safe to pipe into `jq` or `JSON.parse`. The same holds for the other
`--json` commands (`kici run remote --json`, `kici workflows list --json`) and
for `--quiet`.

### kici reject

Reject a held [approval gate](../approvals.md). A rejection fails the held element and the run. A reason is required.

```bash
kici reject <run-id> --reason <text> [options]
```

**Examples:**

```bash
# Reject a held job with a reason
kici reject abc123 --job deploy-production --reason "Wrong release branch"
```

### kici approve

Approve a held [approval gate](../approvals.md) so the run resumes. Identify the held element by run ID, optionally narrowed to a job and step.

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

You must be eligible for at least one unsatisfied clause (a member of a named team, or a named user) and hold the permission that matches the hold's type — `ci_trust:write` for a **security** hold, `contexts:admin` for a **wait-timer** hold, `contexts:write` for every other hold. The server enforces this, so the same rule applies to the dashboard and to an AI agent's tools. The command reports whether the element was released, how many clauses remain, or that it was rejected.

## Reference

<!-- BEGIN GENERATED: kici-runs-and-approvals (do not edit; run the doc generator) -->

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

### `kici runs artifacts`

List and download a run's artifacts

Synopsis: `kici runs artifacts`

### `kici runs artifacts download`

Download one artifact, or all of them — extracts by default

Synopsis: `kici runs artifacts download <run-id> [name] [options]`

**Arguments**

| Argument | Required | Variadic | Description                                                |
| -------- | -------- | -------- | ---------------------------------------------------------- |
| `run-id` | yes      | no       | Run ID whose artifacts to download                         |
| `name`   | no       | no       | Artifact name (omit to download every artifact of the run) |

**Options**

| Option               | Default | Description                                   |
| -------------------- | ------- | --------------------------------------------- |
| `--archive`          | `false` | Save the raw .tar.gz instead of extracting    |
| `-o, --output <dir>` |         | Output directory (default: current directory) |

### `kici runs artifacts list`

List the artifacts a run uploaded

Synopsis: `kici runs artifacts list <run-id> [options]`

**Arguments**

| Argument | Required | Variadic | Description                    |
| -------- | -------- | -------- | ------------------------------ |
| `run-id` | yes      | no       | Run ID whose artifacts to list |

**Options**

| Option   | Default | Description     |
| -------- | ------- | --------------- |
| `--json` | `false` | Output raw JSON |

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

| Option                  | Default | Description                                               |
| ----------------------- | ------- | --------------------------------------------------------- |
| `--status <s>`          |         | Filter by status                                          |
| `--workflow <w>`        |         | Filter by workflow name                                   |
| `--branch <b>`          |         | Filter by branch/ref                                      |
| `--repo <r>`            |         | Filter by repository                                      |
| `--trigger <t>`         |         | Filter by trigger type                                    |
| `--source <routingKey>` |         | Filter by source routing key                              |
| `--since <ts>`          |         | Only runs since (ISO-8601 or epoch ms)                    |
| `--cursor <cursor>`     |         | Keyset cursor for the next page (from a prior nextCursor) |
| `--json`                | `false` | Output raw JSON                                           |

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

<!-- END GENERATED: kici-runs-and-approvals -->
