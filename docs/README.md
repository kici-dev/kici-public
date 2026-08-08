KiCI runs your CI/CD on infrastructure you control. The hosted platform relays webhooks and renders the dashboard without ever seeing your source or secrets -- your own orchestrator and agents clone the code, run the jobs, and hold the logs. Workflows are typed TypeScript you can run locally before you push, so the pipeline you test on your laptop is the pipeline that runs in production.

## Start here

New to KiCI? Follow these in order:

1. **[Green run in ~5 minutes](user/quickstart.md)** -- stand up an orchestrator and agent (Docker / Podman or bare metal) and watch your first workflow go green.
2. **[Getting started](user/getting-started.md)** -- install the SDK, write your first workflow, compile it, and test it locally.
3. **[Why KiCI](user/why-kici.md)** -- the case for running CI on your own infrastructure with typed TypeScript workflows.
4. **[GitHub App provider](user/providers/github.md)** -- connect your first source and route real events.

## Documentation sections

- **[User guide](user/README.md)** -- write, test, and ship CI/CD workflows in TypeScript: the SDK, workflow patterns, providers, the dashboard, secrets, and contexts.
- **[Operator guide](operator/README.md)** -- deploy and run the orchestrator and agents on your own infrastructure: configuration, the auto-scaler, Firecracker, clustering, security, and observability.
- **[Architecture](architecture/overview.md)** -- the three-tier relay model, execution lifecycle, protocol messages, webhook pipeline, and design decisions.

The left sidebar is the full index -- every page, grouped by audience.
