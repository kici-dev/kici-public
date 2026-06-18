# KiCI

> TypeScript-native CI/CD workflow engine. Define your CI in TypeScript, test it locally, run it anywhere.

`kici` is the developer CLI for [KiCI](https://kici.dev): scaffold a `.kici/` workflow directory, compile workflows, dry-run them against synthetic or real events, and execute them locally or against a remote orchestrator.

## Quickstart

```bash
npm install -g kici
kici init
kici test pr:open
kici run local push
```

Full quickstart with the hosted dashboard and a customer-deployed orchestrator: <https://docs.kici.dev/user/quickstart/>.

## Packages

| Package                                                                                             | License       | Description                                                          |
| --------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------- |
| [`kici`](https://github.com/kici-dev/kici-public/tree/main/packages/kici)                           | Apache-2.0    | Developer CLI wrapper — author + drive workflows                     |
| [`@kici-dev/sdk`](https://github.com/kici-dev/kici-public/tree/main/packages/sdk)                   | Apache-2.0    | Workflow definition SDK (`workflow`, `job`, `step`, triggers)        |
| [`@kici-dev/compiler`](https://github.com/kici-dev/kici-public/tree/main/packages/compiler)         | Apache-2.0    | CLI tooling: `kici init`, `kici compile`, `kici test`, `kici run`    |
| [`@kici-dev/core`](https://github.com/kici-dev/kici-public/tree/main/packages/core)                 | Apache-2.0    | Light shared utilities (no server-side dependencies)                 |
| [`@kici-dev/shared`](https://github.com/kici-dev/kici-public/tree/main/packages/shared)             | Apache-2.0    | Shared utilities (logging, crypto, telemetry, health routes)         |
| [`@kici-dev/engine`](https://github.com/kici-dev/kici-public/tree/main/packages/engine)             | AGPL-3.0-only | Core business logic (protocol, triggers, state machine)              |
| [`@kici-dev/agent`](https://github.com/kici-dev/kici-public/tree/main/packages/agent)               | AGPL-3.0-only | Customer-deployable agent (clone, execute, stream logs)              |
| [`@kici-dev/orchestrator`](https://github.com/kici-dev/kici-public/tree/main/packages/orchestrator) | AGPL-3.0-only | Customer-deployable orchestrator (triggers, dispatch, queue, scaler) |
| [`kici-admin`](https://github.com/kici-dev/kici-public/tree/main/packages/kici-admin)               | AGPL-3.0-only | Orchestrator admin CLI                                               |

License details: <https://github.com/kici-dev/kici-public/blob/main/LICENSES.md>. Per-package LICENSE files live alongside each package.

## Container images

The two customer-deployable services ship as container images on Quay:

- `quay.io/kici-dev/kici-orchestrator`
- `quay.io/kici-dev/kici-agent`

A reference compose file is at <https://github.com/kici-dev/kici-public/blob/main/examples/quickstart/compose/docker-compose.yaml>.

## Building from source

```bash
pnpm install
pnpm -r run build
pnpm -r run test
```

Requires Node 24, pnpm 11+.

## Where development happens

Day-to-day development happens in a private upstream monorepo. The public repo (`github.com/kici-dev/kici-public`) is a projection of KiCI's open-source packages — 9 packages, the docs, the examples tree, and a few overlay files. Each release lands as a single squash commit on `main`.

Issues and PRs are welcome at <https://github.com/kici-dev/kici-public> — see <https://github.com/kici-dev/kici-public/blob/main/CONTRIBUTING.md> for the back-port flow, the issue triage policy, and how to route security reports.

## Status

KiCI is actively developed and dogfooded in production. It is pre-1.0 — protocols and the CLI surface can change between minor versions, so pin versions for production.
