# @kici-dev/compiler

Compiler and CLI for KiCI workflows. Compiles `.kici/workflows/*.ts` to a `kici.lock.json` file consumed by the orchestrator and agents, and runs workflows locally or against a remote orchestrator.

Part of [KiCI](https://kici.dev) — CI/CD workflows as TypeScript code: author them with full language power, dry-run them locally, and run them on your own infrastructure.

## Install

Usually consumed through the [`kici`](https://www.npmjs.com/package/kici) wrapper CLI:

```bash
npm install -g kici
```

Direct install (`npm install --save-dev @kici-dev/compiler`) works too when you want the library API.

## Links

- Documentation: <https://docs.kici.dev/user/cli-reference/>
- Source: <https://github.com/kici-dev/kici-public/tree/main/packages/compiler>
- License: Apache-2.0
