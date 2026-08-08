---
title: Migrating from GitHub Actions
description: Map GitHub Actions concepts to KiCI, translate a real workflow side-by-side, and see what has no equivalent yet
---

## Before you start

KiCI workflows are real, typed TypeScript in `.kici/workflows/*.ts` instead of YAML in `.github/workflows/*.yml`. The compiler validates them ahead of time, and at run time the agent clones your repository and executes them on your own infrastructure. This guide maps the GitHub Actions concepts you already know to their KiCI equivalents, translates one realistic workflow side-by-side, and lists honestly what has no equivalent yet.

Follow [getting started](./getting-started.md) for the full setup. The mapping below assumes you have `@kici-dev/sdk` installed.

## Concept mapping

| GitHub Actions                                               | KiCI                                                                                                                     | Notes                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow file `.github/workflows/ci.yml`                     | TypeScript module `.kici/workflows/ci.ts` that default-exports `workflow('ci', {...})`                                   | Workflows are modules built from `workflow()`, `job()`, and `step()` factories.                                                                                    |
| `on: pull_request:`                                          | `on: pr({ target: 'main' })`                                                                                             | `pr()` is a trigger factory; `on` takes one trigger or an array of triggers.                                                                                       |
| `on: push: branches: [main]`                                 | `on: push({ branches: ['main'] })`                                                                                       | `push()` matches by branch pattern.                                                                                                                                |
| `on: schedule: - cron:`                                      | `on: schedule({ cron: '0 2 * * *', timezone: 'UTC' })`                                                                   | `cron` is required; `timezone` defaults to `UTC`. In a cluster only the leader evaluates schedules.                                                                |
| `on: workflow_dispatch: inputs:`                             | `on: dispatch({ inputs: defineDispatchInputs({...}) })`, read typed via `inputs.from(ctx)`                               | Dispatch inputs are declared with Zod schemas and read back fully typed.                                                                                           |
| `jobs:` map keyed by name                                    | `jobs: [job('lint', {...}), job('test', {...})]`                                                                         | Jobs are an array of `job()` results.                                                                                                                              |
| `needs: [build]` (string references)                         | `needs: [buildJob]` (object references)                                                                                  | You reference the `job()` value directly; the compiler validates the dependency graph for cycles and missing references.                                           |
| `runs-on: <hosted runner>`                                   | `runsOn: 'kici:os:linux'` or a custom scaler label                                                                       | Every agent self-reports labels such as `kici:os:linux`, `kici:arch:x64`, and `kici:host:<hostname>`. A GitHub-hosted runner label matches no KiCI agent.          |
| `steps: - run: npm test`                                     | `steps: [step('test', async ({ $ }) => { await $\`npm test\` })]`                                                        | The `$` in a step body is a zx shell; a single-step job can use the `run:` function shorthand instead of `steps:`.                                                 |
| `steps: - uses: actions/checkout@v4`                         | (nothing)                                                                                                                | The agent clones the repository automatically before steps run, so there is no explicit checkout step.                                                             |
| `steps: - uses: actions/setup-node@v4`                       | Provision the toolchain in a step or from the agent image                                                                | KiCI has no `uses:`-style setup actions; the toolchain comes from the agent environment or an explicit step.                                                       |
| `${{ secrets.NPM_TOKEN }}`                                   | `await ctx.secrets.get('NPM_TOKEN')`, or `ctx.secrets.expose('NPM_TOKEN')` to place it in the environment                | Secrets are never auto-injected into `process.env`; access is always explicit.                                                                                     |
| `environment: production` (+ protection rules)               | `context: 'production'` (or `contexts: ['staging', 'prod']`)                                                             | A context carries variables, bound secrets, and protection rules (branch restrictions, required reviewers, wait timers, concurrency limits, minimum trust).        |
| `env:` (job or step level)                                   | `env: { KEY: 'val' }` on a job                                                                                           | Job-level `env` accepts a static object or a `(event) => ({...})` function for dynamic values.                                                                     |
| `strategy: matrix: node: [18, 20, 22]`                       | `matrix: ['18', '20', '22']` or `{ node: [...], os: [...] }`                                                             | A single-dimension array exposes `matrix.value`; an object expands all combinations and exposes each dimension by name. A dynamic function form is also supported. |
| `if: github.ref == 'refs/heads/main'`                        | Native TypeScript conditionals plus `rule()` / `skip()` and dynamic values                                               | Conditions are real TypeScript branching; dynamic values are pure functions of the normalized event.                                                               |
| `concurrency: group: ...`                                    | `concurrencyGroup: 'production-api'` (static) or a dynamic function                                                      | Set at the job level; a workflow-level concurrency group also exists.                                                                                              |
| `jobs.<id>.outputs`                                          | Structured job and step outputs consumed downstream via `needs`; `ctx.setSecretOutput(key, value)` for encrypted outputs | Outputs pass values between jobs; secret outputs are encrypted.                                                                                                    |
| `- uses: actions/cache@v4`                                   | `cache` field on a job or step (declarative) or `ctx.cache.restore` / `ctx.cache.save` (imperative)                      | A keyed cache, immutable once written, org- and ref-scoped, backed by the orchestrator's object storage.                                                           |
| Reusable workflows / composite actions / marketplace `uses:` | `@kici-dev/action-*` building blocks or any npm package you `import`                                                     | Reusable logic is imported as functions, not referenced by `uses:`.                                                                                                |

### Secrets are explicit

KiCI never copies secrets into `process.env` for you. A step reads a value with `ctx.secrets.get('KEY')` or injects it into the environment with `ctx.secrets.expose('KEY')`, and can mount a secret as a file with `ctx.secrets.mountFile(...)`. Every access is tracked. See [secrets](./secrets.md).

### Environments become contexts

A GitHub environment maps to a KiCI context bound at the job level with `context:` (or `contexts:` for several). A context carries variables, bound secrets, and protection rules — branch restrictions, required reviewers, wait timers, concurrency limits, and a minimum-trust gate. See [contexts](./contexts.md).

### `if:` becomes real TypeScript

There is no expression mini-language. Conditions are ordinary TypeScript, and values that depend on the event are pure functions of the normalized event object. See [dynamic values](./dynamic-values.md).

### Matrix

A single-dimension matrix is an array (`matrix: ['18', '20', '22']`) and exposes the current value as `matrix.value` in the step context. A multi-dimension matrix is an object and exposes each dimension by name. See [conditionals and matrix patterns](./patterns/conditionals-matrix.md).

### Caching

Declare a `cache` on a job or step, or drive it imperatively with `ctx.cache.restore(spec)` and `ctx.cache.save(spec)`. Cache entries are keyed and immutable once written. See [caching](./sdk/caching.md).

## A real workflow, translated

Here is a pull-request CI workflow that runs tests across a Node version matrix and uploads coverage using a secret.

The GitHub Actions version:

```yaml
name: ci
on:
  pull_request:
    branches: [main]
jobs:
  test:
    # kici-lint-allow-github-runner: GitHub-hosted runner shown for contrast
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['18', '20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
      - run: npx codecov
        env:
          CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

The KiCI translation:

```typescript
import { workflow, job, step, pr } from '@kici-dev/sdk';

const test = job('test', {
  runsOn: 'kici:os:linux',
  matrix: ['18', '20', '22'],
  context: 'ci',
  steps: [
    step('install', async ({ $ }) => {
      // The agent already cloned the repo — no checkout step needed.
      await $`npm ci`;
    }),
    step('test', async ({ $, matrix }) => {
      // matrix.value is the Node version for this cell ('18' | '20' | '22').
      // Select it however your agent provisions toolchains, e.g. a version manager.
      await $`nvm use ${matrix!.value}`;
      await $`npm test`;
    }),
    step('coverage', async (ctx) => {
      await ctx.secrets.expose('CODECOV_TOKEN');
      await ctx.$`npx codecov`;
    }),
  ],
});

export default workflow('ci', {
  on: pr({ target: 'main' }),
  jobs: [test],
});
```

What changed and why:

- `on: pull_request` → `on: pr({ target: 'main' })`.

<!-- kici-lint-allow-github-runner: contrasts GitHub's ubuntu-latest with the KiCI auto-label -->

- `runs-on: ubuntu-latest` → `runsOn: 'kici:os:linux'`, an auto-label every Linux agent reports; a GitHub hosted-runner label would match no agent. See [runsOn forms](./sdk/core.md#runson-forms).
- `actions/checkout` → removed; the agent clones the repository before steps run.
- `actions/setup-node` with `matrix.node` → `matrix: ['18', '20', '22']`, with the current value available as `matrix.value` in the step context. KiCI has no built-in setup-node, so toolchain selection is a step or agent-image concern. See [conditionals and matrix patterns](./patterns/conditionals-matrix.md).
- `${{ secrets.CODECOV_TOKEN }}` → `ctx.secrets.expose('CODECOV_TOKEN')`, explicit and never auto-injected. See [secrets](./secrets.md).
- `environment` → `context: 'ci'`. See [contexts](./contexts.md).

The `nvm use` line is illustrative — KiCI does not install a Node version for you; use whatever your agent image or step provides.

## What has no equivalent yet

**File artifacts between jobs.** KiCI has no first-class store for uploading a build directory as a named artifact and downloading it in a later job or from the run UI. It does have structured job and step outputs (and secret outputs) for passing _values_, and a keyed [cache](./sdk/caching.md) for reusing files across runs. For build outputs you need to hand between jobs, use the cache or an external object store.

**A community action marketplace.** GitHub Actions has thousands of third-party marketplace actions addressable by `uses: owner/repo@ref`. KiCI's reusable blocks are the published `@kici-dev/action-*` packages plus any npm package you import — there is no marketplace of community-contributed actions.

**`uses:`-style step references.** KiCI steps are TypeScript functions, so you call reusable logic as imported library functions rather than referencing a composite or container action. This is a model shift rather than a missing feature, but a drop-in `uses:` translation does not exist.

**Provider breadth.** KiCI is GitHub-first. Other git hosts are reachable through the universal-git and local-file providers, but the richest event coverage is for GitHub. See [the GitHub provider](./providers/github.md).

## Next steps

- [Getting started](./getting-started.md)
- [SDK reference — runsOn forms](./sdk/core.md#runson-forms)
- [Conditionals and matrix patterns](./patterns/conditionals-matrix.md)
- [Secrets](./secrets.md) and [contexts](./contexts.md)
- [CLI reference](./cli-reference.md)
