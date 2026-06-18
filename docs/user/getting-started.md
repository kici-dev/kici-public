---
title: Getting started with workflows
description: Install the SDK, write your first workflow, compile and test locally
---

KiCI lets you define CI/CD workflows in TypeScript instead of YAML. You get full language power -- type safety, autocompletion, loops, conditionals, and async/await -- for your build pipelines.

## Prerequisites

- **Node.js 24+** (LTS recommended)
- **pnpm** (or npm/yarn -- examples use pnpm)
- Familiarity with TypeScript

## Quick start with kici init

The recommended way to start a new project is `kici init`. It scaffolds the directory structure, lets you pick a starter template, and installs dependencies for you:

```bash
npx kici init
```

This will:

1. Create `.kici/` directory with `workflows/`, `tests/`, `types/`, `package.json`, and `tsconfig.json`
2. Create a `.kiciignore` file with sensible defaults
3. Let you choose from starter workflow templates (hello-world, pr-checks)
4. Install dependencies using the package manager detected for your repo (npm, pnpm, or yarn)
5. Update `.gitignore` to exclude `.kici/node_modules/`
6. Optionally install a pre-commit hook to auto-compile workflows

The package manager is detected from your repo's `packageManager` field, lockfile, or the manager that invoked `kici`, defaulting to npm. Pass `--package-manager <npm|pnpm|yarn>` to override it.

### Options

| Flag                                  | Description                                                  |
| ------------------------------------- | ------------------------------------------------------------ |
| `--force`                             | Overwrite existing `.kici/` directory                        |
| `--skip-install`                      | Create files without installing dependencies                 |
| `--package-manager <npm\|pnpm\|yarn>` | Force a package manager for the install step (default: auto) |
| `--mjs`                               | JavaScript-only mode (no TypeScript, no deps)                |

### MJS mode

If you prefer plain JavaScript without TypeScript compilation:

```bash
npx kici init --mjs
```

This creates `.mjs` workflow files that run directly without a build step.

After running `kici init`, jump straight to [Compile the workflow](#compile-the-workflow) below to compile and preview the scaffolded workflow.

## Manual setup

If you'd rather wire things up by hand instead of using `kici init`, install the SDK (runtime definitions) and the compiler (CLI tooling) yourself, then create your first workflow.

### Install the SDK and compiler

```bash
pnpm add @kici-dev/sdk
pnpm add -D @kici-dev/compiler
```

The examples use pnpm, but npm and yarn work too. With npm:

```bash
npm install @kici-dev/sdk
npm install -D @kici-dev/compiler
```

With yarn:

```bash
yarn add @kici-dev/sdk
yarn add -D @kici-dev/compiler
```

### Create the workflow directory

KiCI looks for workflows in `.kici/workflows/`:

```bash
mkdir -p .kici/workflows
```

### Write a workflow

Create `.kici/workflows/ci.ts`:

```typescript
import { workflow, job, step, pr } from '@kici-dev/sdk';

const lint = job('lint', {
  runsOn: 'linux',
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('lint', async ({ $ }) => {
      await $`pnpm lint`;
    }),
  ],
});

const test = job('test', {
  runsOn: 'linux',
  needs: [lint],
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('run-tests', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});

export default workflow('ci', {
  on: pr({ target: 'main' }),
  jobs: [lint, test],
});
```

This workflow:

- Triggers on pull requests targeting `main`
- Runs a `lint` job first
- Runs a `test` job after lint succeeds (`needs: [lint]`)

`runsOn` selects which agents may run a job. Every agent self-reports `kici:os:<platform>`, `kici:arch:<cpu>`, and `kici:host:<hostname>`, so `runsOn: 'kici:os:linux'` targets any connected Linux agent with zero configuration — `kici init` scaffolds workflows with exactly that. Use a custom label such as `'linux'` or `'gpu'` (defined in your scaler's `labelSet`) to target a specific pool instead. See the [runsOn forms](./sdk/core.md#runson-forms) reference for the full label model.

**Single-step shortcut.** If a job only has one step, pass `run` directly to `job()` instead of building a `steps: [step(...)]` array:

```typescript
const deploy = job('deploy', {
  runsOn: 'default',
  run: async ({ $, log }) => {
    await $`./scripts/deploy.sh`;
    log.info('Deployed');
  },
});
```

`run` and `steps` are mutually exclusive. The shorthand is ideal for deploy/notify/smoke-test jobs. See [Single-step job shorthand](sdk/core.md#single-step-job-shorthand) in the SDK reference for details (output access on the resulting `job.result` is flat -- no step-name nesting).

## Compile the workflow

The compiler validates your workflow and generates a lock file:

```bash
npx kici compile
```

Expected output:

```
✓ Compiled workflows → .kici/kici.lock.json (1 workflow)
```

The lock file (`kici.lock.json`) is a JSON representation of your workflow that the KiCI agent uses for execution. Commit this file alongside your workflow source. See [Lock file and workflow drift](lock-file-and-drift.md) for why and how to keep them in sync.

## Preview trigger matching

Use `kici test` to preview which workflows match a trigger event (dry-run, no execution):

```bash
npx kici test pr:open
```

Expected output (simplified):

```
🔍 DRY RUN - No commands will be executed

Workflow: ci
  Triggers:
    - pr
  ✓ Matched trigger 1
  Jobs (2):
    lint
      runs-on: linux
    test
      runs-on: linux

Decision Summary:

  ci: ✓ matched

✓ Dry run complete
```

## Run locally

Execute matched workflows locally with `kici run local`:

```bash
npx kici run local pr:open
```

This compiles, matches triggers, and runs all matched jobs with DAG-based parallel scheduling.

If you do not want to remember the event arg, pass `--pick` (or `-p`) and pick from a list of workflows instead:

```bash
npx kici run local --pick
```

The picker lists each workflow with a summary of its declared triggers, derives the event arg for the one you choose, and runs it through the same pipeline.

## Workflow dependencies

KiCI workflows can use any npm package. Dependencies are declared in `.kici/package.json`, which `kici init` generates automatically.

### Adding dependencies

To add a package to your workflows:

```bash
cd .kici
npm install lodash
```

This updates `.kici/package.json` and generates (or updates) `package-lock.json`.

### Dependency resolution contract

Every `.kici/` dependency must be resolvable from the **single cloned repository**. When a job runs, the agent clones only this repository and installs `.kici/` dependencies with your repo's package manager — npm, pnpm, yarn classic (v1), and yarn berry (v2+). A dependency that points outside the cloned repo cannot be resolved.

In practice:

- **From a registry** — the common case. Pin a published version (a private registry works — see [Private registries](./private-registries.md)). Available for any package manager.
- **From an in-repo workspace sibling** — if your `.kici/` is a member of a **pnpm workspace** or a **yarn berry workspace** (a `workspaces` array in the repo-root `package.json`), it can depend on a sibling package in the same repo via `workspace:*` (yarn berry also accepts `portal:`). The whole repo is cloned, so the sibling is present and resolves; the agent also builds your `.kici/` dependency closure after install, so a sibling's build output exists before the workflow that imports it loads. A `file:`/`link:`/`portal:` path is allowed only when it stays inside the repository.

What fails fast (with an actionable error naming the dependency, not a raw package-manager error): a `workspace:` dependency in an **npm** project (npm has no workspace protocol — pin a published version or switch to pnpm), a `workspace:`/`portal:` dependency in a **yarn classic** project (v1 has neither — use a version range, pnpm, or yarn berry), a `workspace:` dependency in a **yarn berry** project whose repo-root `package.json` has no `workspaces` array, and any `file:`/`link:`/`portal:` path that points outside the cloned repo.

Then use the package in your workflow:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';
import _ from 'lodash';

export default workflow('deploy', {
  on: push({ branches: 'main' }),
  jobs: [
    job('process', {
      runsOn: 'default',
      steps: [
        step('transform', async ({ log }) => {
          const data = _.merge({ a: 1 }, { b: 2 });
          log.info(`Merged: ${JSON.stringify(data)}`);
        }),
      ],
    }),
  ],
});
```

### How dependencies are cached

When the KiCI agent runs your workflow, dependencies are handled automatically:

1. **First run (cache miss):** A build agent installs dependencies from `.kici/package.json`, packs the resolved dependency tree into a tarball, and uploads it to cache storage. For a pnpm workspace this closure includes the shared store and any in-repo workspace siblings `.kici` resolves.
2. **Subsequent runs (cache hit):** The execution agent downloads the cached tarball and extracts it -- no install needed.
3. **Lockfile changes:** When your lockfile changes (`.kici/package-lock.json` for npm, or the repo-root `pnpm-lock.yaml` for a pnpm workspace), the cache is invalidated and a fresh build runs.

This means the first run after a dependency change is slower (build + execution), but all subsequent runs are fast.

### The .kici/package.json file

Every KiCI project needs a `.kici/package.json`. This file:

- Declares workflow dependencies (including `@kici-dev/sdk`)
- Signals the agent to run the dependency cache step
- Is generated automatically by `kici init`

If you are setting up a project manually (without `kici init`), create a minimal `.kici/package.json`:

```json
{
  "name": "@kici-dev/workflows",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@kici-dev/sdk": "^0.0.1"
  }
}
```

Then run `npm install` in `.kici/` to generate the lockfile. Commit both `package.json` and `package-lock.json` to your repository.

## Development mode

When developing the KiCI SDK itself (or testing against a local fork), enable development mode.

### sdkPath in .kici/package.json

Point to a local SDK checkout for IDE autocompletion:

```json
{
  "name": "my-project-kici",
  "devDependencies": {
    "@kici-dev/sdk": ">=0.0.1-0"
  },
  "kici": {
    "sdkPath": "../../packages/sdk"
  }
}
```

The `sdkPath` field tells the compiler where to resolve TypeScript path mappings for `@kici-dev/sdk`.

### KICI_DEV environment variable

Set `KICI_DEV=true` to use a prerelease-compatible version range (`>=0.0.1-0`) in generated files, which resolves prerelease builds from a local Verdaccio registry:

```bash
KICI_DEV=true npx kici init
```

Or add the flag to your root `package.json`:

```json
{
  "kici": {
    "development": true
  }
}
```

## Authoring KiCI workflows with LLM coding agents

KiCI is LLM-ready by design. Because workflows are real, typed TypeScript, coding agents reason over the SDK's `.d.ts` signatures instead of guessing a bespoke YAML DSL — and they verify their own pipelines with the same `kici test` and `kici run local` loop you use, so there's no push-to-find-out round-trip. First-class agent context ships in the box, so an agent is briefed the moment it opens the project.

KiCI ships first-class context for LLM coding agents (Claude Code, Cursor, Aider, etc.). When you scaffold a project with `kici init`, the CLI writes `.kici/AGENTS.md`, a one-page briefing that tells the agent:

- where the SDK type declarations live (`node_modules/@kici-dev/sdk/dist/index.d.ts`)
- the five canonical authoring patterns with runnable examples
- the anti-patterns that catch agents off-guard (no YAML, no `/dist/...` imports, no top-level `await`)
- the local commands the agent should drive (`kici compile --check`, `kici test`, `kici run local`, `kici docs llm`)

If you don't want the file, pass `--no-agents-md` to `kici init`, or delete the file afterwards — KiCI never reads it at runtime.

For coding agents that want the entire documentation set up front, KiCI follows the [llms.txt convention](https://llmstxt.org/):

- `https://kici.dev/llms.txt` — curated link index grouped by SDK / patterns / CLI / architecture.
- `https://kici.dev/llms-full.txt` — concatenated markdown of every page indexed above.
- `kici docs llm` — print the same `llms-full.txt` bundle to stdout, offline, straight from the installed `@kici-dev/compiler` package. Add `--index` to print the curated `llms.txt` index instead. The agent can pipe the output into its own context buffer with no network call.
- `kici docs` — open the docs site in your browser.

The offline bundle is regenerated from `docs/` every time the package is built, so it always matches the version of KiCI you've installed.

## Watch mode

During development, run the compiler in watch mode to recompile automatically when workflows change:

```bash
npx kici compile --watch
```

The compiler watches `.kici/workflows/*.ts` and recompiles on every save.

## Next steps

- **[5-minute quickstart](quickstart.md)** -- ready to run your workflow on real infrastructure? Stand up an orchestrator + agent (Docker / Podman or bare metal)
- **[SDK reference](sdk-reference.md)** -- complete API for workflows, jobs, steps, triggers, rules, and matrix
- **[CLI reference](cli-reference.md)** -- all CLI commands with options and examples
- **[Workflow patterns](workflow-patterns.md)** -- common patterns for real-world CI/CD workflows

## How KiCI works

KiCI uses a three-layer architecture:

```
SDK (define) -> Compiler (validate) -> Lock file -> Agent (execute)
```

1. **SDK**: You write workflows in TypeScript using factory functions (`workflow()`, `job()`, `step()`). The SDK provides type-safe definitions with full IDE support.

2. **Compiler**: The `kici compile` command loads your TypeScript workflows, validates the dependency graph (no cycles, no missing references), and generates `kici.lock.json`.

3. **Lock file**: A portable JSON file containing all workflow metadata. The lock file enables the orchestrator to evaluate triggers without cloning your repository.

4. **Agent**: The agent receives dispatch instructions, clones your repository, and executes the steps defined in your workflows. Agents are self-hosted and label-routed.

The lock file approach means the orchestrator stays git-agnostic -- it only needs the lock file to decide which jobs to run. The agent handles the actual code checkout and step execution.

## See also

- [SDK reference](sdk-reference.md) -- complete API for workflows, jobs, steps, triggers, rules, and matrix
- [CLI reference](cli-reference.md) -- all CLI commands with options and examples
- [Workflow patterns](workflow-patterns.md) -- common patterns for real-world CI/CD workflows
- [Architecture overview](../architecture/overview.md) -- how the three-tier runtime executes your workflows
