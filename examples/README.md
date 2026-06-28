# KiCI examples

Runnable templates and example workflows. Two subdirectories today:

| Subdirectory                   | Purpose                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [`workflows/`](./workflows/)   | Standalone `.ts` workflow definitions you can run via `pnpm kici preview`.                                          |
| [`quickstart/`](./quickstart/) | Deployment templates for the 5-minute quickstart — `compose/` (Docker / Podman) and `bare-metal/` (native systemd). |

## Workflows

This folder contains example workflows demonstrating KiCI SDK features.

## Running Examples

The examples folder is part of the pnpm workspace, so `@kici-dev/sdk` imports work immediately after `pnpm install`.

Test any example locally:

```bash
# From repo root
pnpm kici preview push --config examples/workflows/hello-world.ts

# Or from examples directory
cd examples
pnpm kici preview push --config workflows/hello-world.ts
```

## Available Examples

### Workflows (`workflows/`)

Single-file workflows, runnable with `pnpm kici preview <event> --config <path>`:

| Example                                                              | Description                                                             | Triggers     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| [hello-world.ts](./workflows/hello-world.ts)                         | Minimal workflow that echoes "Hello, World!"                            | `push`       |
| [ci-monorepo.ts](./workflows/ci-monorepo.ts)                         | Dynamic matrix discovered at runtime, a shared step, conditional deploy | `pr`, `push` |
| [mise-init.ts](./workflows/mise-init.ts)                             | Generic init phase provisions jq via mise (`mise.toml`)                 | `push`       |
| [mise-preset.ts](./workflows/mise-preset.ts)                         | Zero-config `init: 'mise'` preset (sugar over the generic mise init)    | `push`       |
| [wait-for-marker.ts](./workflows/wait-for-marker.ts)                 | `waitForStep` polls until a producer job writes a marker file           | `push`       |
| [parallel-lint-typecheck.ts](./workflows/parallel-lint-typecheck.ts) | `parallel([...])` runs independent checks concurrently within a job     | `push`       |

### Project layout (`dynamic-environment/`)

A repo-shaped example showing the real `.kici/workflows/` directory layout rather than a single file:

| Example                                                                      | Description                                               | Triggers |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| [dynamic-deploy.ts](./dynamic-environment/.kici/workflows/dynamic-deploy.ts) | Per-event `environment` and `env` callbacks select target | `push`   |

## Adding Examples

When adding new examples:

1. Create file in appropriate subfolder (`workflows/`, etc.)
2. Include JSDoc comment explaining what it demonstrates
3. Update this README with entry in the table
4. Test with `pnpm kici preview <event> --config <path>`

## Maintenance

This folder is maintained through development. Examples should be updated when:

- SDK API changes break existing examples
- New features warrant demonstration
- README main examples reference these files
