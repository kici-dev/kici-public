---
title: Testing guide
description: Running remote test fixtures with kici run remote
---

Test your workflows remotely against the full CI pipeline from your local machine. `kici run remote` uploads your current repo state (including uncommitted changes), triggers the pipeline, and streams execution logs back in real time.

## Overview

`kici run remote` connects your local development environment to the remote orchestrator/agent pipeline. Instead of pushing a commit and waiting for CI, you can:

- Run any workflow against your current working tree (including unstaged changes)
- Get real-time log output streamed back to your terminal
- Give test runs test-scoped secrets — your local secret files and `--env` values (uploaded encrypted) plus any environment flagged `allowLocalExecution: true` — while production environments stay unreachable
- Detect test mode in workflow code via `ctx.isTestRun`

The command is remote-only -- all execution happens on the orchestrator and agent. For local-only trigger matching previews, use `kici preview <event>`.

:::note[Orchestrator prerequisite: cache storage]
`kici run remote` uploads your working-tree overlay to the orchestrator's **cache storage** via a pre-signed URL, and the agent fetches it from there (see [Repo state transfer](#repo-state-transfer)). The target orchestrator must therefore have cache storage enabled (`KICI_STORAGE_TYPE` = `s3` or `filesystem`).

- **Both quickstarts wire this up for you** — the [Docker / Podman quickstart](quickstart/compose.md) and the [bare-metal quickstart](quickstart/bare-metal.md) each ship a SeaweedFS object store and pre-fill the orchestrator's `KICI_STORAGE_*` block, so `kici run remote` works out of the box (see each guide's "run a workflow without pushing" step).
- **A hand-rolled orchestrator deploy does not configure storage by default** — enable a backend before using `kici run remote`:
  - **`filesystem`** — simplest for a single-host orchestrator: set `KICI_STORAGE_TYPE=filesystem` and `KICI_STORAGE_FS_PATH=/var/lib/kici/cache`. No external service needed; blobs are served through the orchestrator's own HMAC-signed HTTP route.
  - **`s3`** — any S3-compatible bucket. **A non-public / self-hosted endpoint works**: set `KICI_STORAGE_TYPE=s3`, `KICI_STORAGE_BUCKET`, `KICI_STORAGE_ENDPOINT=https://your-endpoint` and (for most self-hosted services) `KICI_STORAGE_FORCE_PATH_STYLE=true`. If the developer machine running `kici run remote` reaches the bucket at a different address than the orchestrator, set `KICI_STORAGE_UPLOAD_ENDPOINT` to the developer-reachable address; if agents reach it at yet another address (e.g. agents in containers), set `KICI_STORAGE_EXTERNAL_ENDPOINT` to the agent-routable URL.

See [Storage layout](../operator/orchestrator/storage-layout.md) for the full env-var reference.
:::

## Getting started

### 1. Authenticate

```bash
kici login
```

This opens your browser for OAuth authentication and stores a personal access token in `~/.kici/config`. For CI/CD pipelines or headless environments, use `kici login --token <your-api-key>` or `kici login --device` instead. See [CLI authentication](cli-auth.md) for details.

### 2. Write a test fixture

Fixtures define the events you want to simulate. They live in `.kici/tests/*.ts` and use the same SDK trigger functions as workflows.

```typescript
// .kici/tests/push-tests.ts
import { fixture, push } from '@kici-dev/sdk';

export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});

export const pushDevelop = fixture('push-develop', {
  event: push({ branches: ['develop'] }),
});
```

Each file can export multiple fixtures. The `fixture()` factory takes an ID (used on the command line) and options including the event to simulate.

### 3. Run a fixture

```bash
# List available fixtures
kici run remote

# Run a specific fixture
kici run remote push-main

# Run all fixtures matching a glob
kici run remote 'push-*'

# Run everything
kici run remote --all
```

The single quotes keep your shell from expanding `push-*` against local files, so the pattern reaches KiCI intact for its own fixture-glob matching.

## Fixture reference

### Event types

Fixtures accept any SDK trigger function as their event:

```typescript
import { fixture, push, pr, comment, tag, release } from '@kici-dev/sdk';

// Push event
export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});

// PR event
export const prOpen = fixture('pr-open', {
  event: pr({ branches: ['main'], actions: ['opened'] }),
});

// Comment event
export const prComment = fixture('pr-comment', {
  event: comment({ actions: ['created'] }),
});

// Tag event
export const tagRelease = fixture('tag-release', {
  event: tag({ tags: ['v*'] }),
});

// Release event
export const published = fixture('release-published', {
  event: release({ actions: ['published'] }),
});
```

### Overrides

Override default payload values per fixture:

```typescript
export const pushFeature = fixture('push-feature', {
  event: push({ branches: ['feature/*'] }),
  branch: 'feature/auth', // Override branch name
  sha: 'abc123def456', // Override commit SHA
  repo: 'myorg/myrepo', // Override repository
  pr: 42, // Override PR number (for PR events)
});
```

When not specified, these default to values detected from your local git repo (current branch, HEAD SHA, remote URL).

### Secret context mappings

Map secret contexts to your fixture:

```typescript
export const pushWithSecrets = fixture('push-with-secrets', {
  event: push({ branches: ['main'] }),
  secrets: {
    db: 'test-database',
    api: 'test-api-keys',
  },
});
```

This maps the `db` secret context to the `test-database` context, and `api` to `test-api-keys`.

This mapping is honored by **both** `kici run local` and `kici run remote`:

- For **`kici run local`** (see [`kici run local`](cli-reference.md#kici-run-local)), each named context is resolved from your local secret files (`.kici/.secrets`, `.env.local`, `secrets.yaml`, and `--env` flags).
- For **`kici run remote`**, each named context maps to an orchestrator **environment**, and the orchestrator resolves that environment's secrets for the run. The target environment must be flagged `allowLocalExecution: true` — mapping a context to a missing or non-test environment rejects the run (see [Secret contexts for testing](#secret-contexts-for-testing) below).

### Async fixtures

For dynamic fixture configuration, export an async function:

```typescript
export const dynamicFixture = fixture('dynamic', async () => ({
  event: push({ branches: ['main'] }),
  sha: await getCurrentSha(),
}));
```

## Running tests

### Basic commands

```bash
# List all available fixtures (discovers .kici/tests/*.ts)
kici run remote

# Run a single fixture by ID
kici run remote push-main

# Glob matching -- run all push-related fixtures
kici run remote 'push-*'

# Run all fixtures sequentially
kici run remote --all

# Run all fixtures in parallel
kici run remote --all --parallel
```

### Direct workflow run

Bypass trigger matching and run a specific workflow directly:

```bash
kici run remote --workflow ci
```

This skips the trigger evaluation step and runs all jobs in the named workflow.

### Output modes

```bash
# Default: full log streaming with colored job prefixes
kici run remote push-main

# Quiet: minimal output (just pass/fail result)
kici run remote push-main --quiet

# JSON: machine-readable structured output
kici run remote push-main --json

# JUnit XML: for CI integration
kici run remote push-main --junit results.xml
```

### Non-blocking execution

```bash
# Fire and forget -- returns immediately with run ID
kici run remote push-main --no-wait

# Check status later
kici runs show <run-id>
```

### Cancellation

Press Ctrl+C during a running test to send a cancel signal to the orchestrator. The agent job will be terminated gracefully.

## Repo state transfer

When you run `kici run remote`, the CLI:

1. Detects all files differing from HEAD (staged, unstaged, and untracked)
2. Creates a compressed tarball of changed files
3. Encrypts the tarball using X25519 ECDH key exchange
4. Uploads the encrypted tarball to storage via a signed URL
5. Triggers the pipeline with a reference to the upload

The agent clones your repo at HEAD, then applies the overlay tarball on top -- giving you the exact same file state as your local working tree.

### What gets included

- Modified tracked files (staged and unstaged)
- New untracked files (not in `.gitignore`)
- File deletions (tracked files you deleted locally)

### What gets excluded

- Files matching `.gitignore` patterns
- Files matching `.kiciignore` patterns (additional exclusions)
- The `.git` directory itself

### `.kiciignore`

Create a `.kiciignore` file in your repo root to exclude additional files from the upload:

```
# Large binaries
*.bin
*.iso
data/fixtures/large-dataset.csv

# Local-only configs
.env.local
docker-compose.override.yml
```

The format is the same as `.gitignore` -- one glob pattern per line, `#` for comments.

### Size limits

| Threshold | Behavior                                                                          |
| --------- | --------------------------------------------------------------------------------- |
| < 50 MB   | Normal upload                                                                     |
| 50-500 MB | Warning displayed, upload proceeds                                                |
| > 500 MB  | Error -- reduce bundle size via `.kiciignore` or check for unintended large files |

The CLI always shows a pre-upload summary before transferring:

```
12 files changed, 3 new, 1 deleted (2.3 MB compressed)
```

## Secret contexts for testing

The goal of the test-secret model is to let test runs reach **test-only credentials** while keeping production credentials out of reach. `kici run remote` combines two sources of secrets for a test run, then merges them with a clear precedence and a fail-closed gate.

### CLI-uploaded local secrets

`kici run remote` collects the same local secret values that `kici run local` reads — `.kici/.secrets`, `.kici/.env.local`, `.kici/secrets.yaml`, and any `--env KEY=VALUE` flags — and uploads them **encrypted** to the orchestrator alongside the run. The orchestrator decrypts them only to inject them into the agent for that run; the control plane never sees the values.

```bash
# Provide an ad-hoc test value for a single remote run
kici run remote push-main --env KICI_DATABASE_URL=postgresql://localhost/test
```

`--env` provides a **flat** per-run override; `--context <ctx>.<KEY>=<value>` is its sibling for a **namespaced** per-run override, placing the value under the named context `ctx`. Both are uploaded **encrypted** and follow the same precedence rule below — a CLI-supplied value wins over the orchestrator test-environment secret on a key collision.

```bash
# Provide a namespaced per-run value under the 'db' context
kici run remote push-db --context db.KICI_DATABASE_URL=postgresql://localhost/test
```

Because these values originate on your machine, they are the natural place to put throwaway test credentials without touching any orchestrator-stored secret.

### Orchestrator test-environment secrets

In addition to your uploaded values, the orchestrator resolves test-scoped secrets from its own store for a remote test run:

- The job's own declared `environment` contributes its resolved secrets (flat). Static strings and **pure dynamic functions** both participate: a pure `environment:` function (see [Dynamic values](dynamic-values.md)) is evaluated against the fixture's simulated event, and the resolved name is gated and resolved like a static one. Impure dynamic functions (those requiring an init job) are not evaluated for test runs — use a fixture `secrets:` mapping (or `--context`) to supply such a job's secrets.
- Each fixture `secrets: { ctx: envName }` mapping resolves the named environment's secrets under the namespaced context `ctx`.

Both paths are restricted to environments flagged `allowLocalExecution: true`. A production environment left at the default `false` is never resolvable for a test run.

```typescript
export const pushWithDb = fixture('push-db', {
  event: push({ branches: ['main'] }),
  secrets: { db: 'test-database' }, // 'test-database' must be allowLocalExecution: true
});
```

```typescript
step('migrate', async (ctx) => {
  const dbUrl = await ctx.secrets.get('KICI_DATABASE_URL');
  await ctx.$`npx prisma migrate deploy`;
});
```

### Precedence: CLI values win

When a key exists in both sources, the **CLI-uploaded local value wins** over the orchestrator test-environment value. This makes a local override a per-run knob: set `--env KICI_DATABASE_URL=...` (or put it in `.kici/.secrets`) to shadow the test environment's value for just that run, without changing anything on the orchestrator.

### Fail-closed on non-test environments

Test-run secret resolution is fail-closed:

- If a fixture maps a context to an environment that does not exist, the run is **rejected**.
- If a fixture maps a context to an environment whose `allowLocalExecution` is `false`, the run is **rejected**.
- The `allowLocalExecution` gate applies to **all** remote test runs: a run whose matched workflow targets an environment with the flag off is rejected, so a test run can never resolve production secrets.

### The `allowLocalExecution` environment flag

Each environment carries an `allowLocalExecution` flag (default `false`) that controls test-run access to that environment and to its secrets. Production environments should leave it at `false`; create a dedicated test environment with `allowLocalExecution: true` that binds only test-only secret scopes for the contexts you want test runs to use.

The flag is set by the orchestrator operator, either via the CLI:

```bash
kici-admin environment set-policy --env test-database --allow-local-execution true
```

or via the dashboard's "Test runs" toggle on the environment detail page. `kici secrets list` only surfaces contexts whose owning environment has `allowLocalExecution: true`, so production environments are never advertised as test-accessible.

### Local execution as an alternative

`kici run local` resolves the same local secret files entirely on your machine and honors the fixture `secrets: { ... }` mapping to pick which local context backs each name (see [`kici run local`](cli-reference.md#kici-run-local)). Because the values never leave your machine, it's a good fit when you want to exercise secret-dependent steps without involving the orchestrator at all.

### Discovering available contexts

```bash
# List test-accessible secret contexts and their key names (not values)
kici secrets list
```

## Detecting test mode in workflows

Use `ctx.isTestRun` to conditionally skip destructive operations:

```typescript
step('deploy', async (ctx) => {
  if (ctx.isTestRun) {
    ctx.log.info('Skipping deployment in test mode');
    return;
  }
  await ctx.$`kubectl apply -f k8s/`;
});
```

## Run history

### Viewing history

```bash
# Show recent test runs (from local history)
kici run remote --history
```

### Run details

```bash
# Show run summary (reads the Platform, falls back to local history)
kici runs show <run-id>

# Show full logs
kici runs logs <run-id>

# Show logs for a specific job
kici runs logs <run-id> --job build

# Machine-readable output
kici runs show <run-id> --json
```

## Scaffolding with kici init

Running `kici init` in a new project scaffolds a sample test fixture alongside the workflow templates:

```
.kici/
  workflows/
    hello-world.ts     # Sample workflow
    pr-checks.ts       # Sample PR workflow
  tests/
    push-test.ts       # Sample push fixture
  package.json
  tsconfig.json
.kiciignore            # Default exclusion patterns
```

The generated fixture uses the detected default branch:

```typescript
// .kici/tests/push-test.ts
import { fixture, push } from '@kici-dev/sdk';

export const pushMain = fixture('push-main', {
  event: push({ branches: ['main'] }),
});
```

## See also

- [CLI reference](cli-reference.md) -- complete command reference for all `kici` commands
- [SDK reference](sdk-reference.md) -- trigger functions, step context, and workflow API
- [Workflow patterns](workflow-patterns.md) -- example workflows to test against
