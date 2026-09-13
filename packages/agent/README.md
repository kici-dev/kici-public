# @kici-dev/agent

Customer-deployable agent for the KiCI CI/CD stack. Connects to an orchestrator, clones the workflow repository, executes steps, and streams logs back.

You normally don't install this package directly: agents are spawned by the orchestrator's auto-scaler or run from the published container image `quay.io/kici-dev/kici-agent`.

Part of [KiCI](https://kici.dev) — CI/CD workflows as TypeScript code: author them with full language power, dry-run them locally, and run them on your own infrastructure.

## Links

- Documentation: <https://docs.kici.dev/operator/agent/getting-started/>
- Source: <https://github.com/kici-dev/kici-public/tree/main/packages/agent>
- License: AGPL-3.0-only
