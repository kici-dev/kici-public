# @kici-dev/orchestrator

Customer-deployable orchestrator for the KiCI CI/CD stack. Receives webhook events (directly or via the hosted relay), matches triggers against the lock file, and dispatches jobs to connected agents — including auto-scaled ephemeral agents (containers, bare-metal, micro-VMs).

You normally don't install this package directly: deploy the orchestrator with the [`kici-admin`](https://www.npmjs.com/package/kici-admin) CLI (`kici-admin orchestrator install`) or run the published container image `quay.io/kici-dev/kici-orchestrator`.

Part of [KiCI](https://kici.dev) — CI/CD workflows as TypeScript code: author them with full language power, dry-run them locally, and run them on your own infrastructure.

## Links

- Documentation: <https://docs.kici.dev/operator/orchestrator/getting-started/>
- Source: <https://github.com/kici-dev/kici-public/tree/main/packages/orchestrator>
- License: AGPL-3.0-only
