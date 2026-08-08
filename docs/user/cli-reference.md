---
title: CLI reference
description: 'All CLI commands: compile, preview, local, fixture, types, workflows, hook, docs, run, runs, approve, reject, login, logout, init, org, pat, secrets, admin, orchestrators, endpoints, notifications, verify-attestation, diagnostics, doctor'
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

## Command reference

The full command reference is split by area:

- [Authoring & local dev](./cli/authoring-and-local.md) — `compile`, `preview`, `local`, `fixture`, `types`, `workflows`, `hook`, `docs`
- [Runs & approvals](./cli/runs-and-approvals.md) — `run`, `runs`, `reject`, `approve`
- [Account & org](./cli/account-and-org.md) — `login`, `logout`, `init`, `org`, `pat`, `secrets`, `admin`, `orchestrators`, `endpoints`
- [Notifications & diagnostics](./cli/notifications-and-diagnostics.md) — `notifications`, `verify-attestation`, `diagnostics`, `doctor`

Each area page carries a `## Guide` section (worked examples and command-by-command narrative) and a `## Reference` section (the always-current generated signature list for that area's commands).

## Workflow discovery

The CLI discovers workflows by scanning `.kici/workflows/*.ts` (or `.mjs` in MJS mode). Each file should `export default` a single workflow:

```typescript
// .kici/workflows/ci.ts
import { workflow, job, step, pr } from '@kici-dev/sdk';

export default workflow('ci', {
  on: pr(),
  jobs: [/* ... */],
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

Most commands follow a two-value convention:

| Code | Meaning              |
| ---- | -------------------- |
| 0    | Success              |
| 1    | Failure (see output) |

Two cases add a third code:

- `kici doctor` grades its checks: `0` when every check passes, `1` when any check warns, `2` when any check fails.
- A usage error exits `2` — mutually exclusive flags on `kici run remote` (`--pick` combined with a fixture name, `--all`, or `--workflow`), `--fail-on-drift` without `--check` on the same command, or invoking a retired command such as `kici run local`.

Each area page documents the exit codes of the commands it covers.

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

| Variable     | Description                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `KICI_DEV`   | Set to `true` for development mode                                                                         |
| `KICI_DEBUG` | Set to `true` for verbose internal output                                                                  |
| `CI`         | Disables interactive prompts unless it is set to an opt-out value (`0` or `false`, any case) or left empty |

See [Environment variables](env-vars.md#how-ci-is-interpreted) for the full CI-detection convention, including the `GITHUB_ACTIONS` and `GITLAB_CI` markers.

## See also

- [Getting started](getting-started.md) -- install the SDK and write your first workflow
- [Testing guide](testing-guide.md) -- writing fixtures, remote test runs, secret contexts, and repo state transfer
- [SDK reference](sdk-reference.md) -- complete API for the workflow definitions that the CLI compiles
- [Workflow patterns](workflow-patterns.md) -- example workflows to compile and test with these commands
