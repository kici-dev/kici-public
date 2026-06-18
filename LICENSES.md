# Licenses

KiCI is a multi-package project with a deliberate two-tier licensing split. The
summary below is informational — the authoritative terms live in the
`LICENSE` file at the repo root (Apache-2.0, covers anything not listed below)
and in each package's own `LICENSE` file (overrides root for that package).

Copyright 2026 Alberto Marchetti.

## Per-package license matrix

| Package                   | npm published | License       | Why                                                                                                                                        |
| ------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kici-dev/sdk`           | yes           | Apache-2.0    | Developer-facing workflow DSL. Maximum adoption, zero copyleft friction.                                                                   |
| `@kici-dev/compiler`      | yes           | Apache-2.0    | CLI tooling for authoring workflows. Developer-facing.                                                                                     |
| `@kici-dev/core`          | yes           | Apache-2.0    | Lowest-level utilities (no server deps), re-exported by `@kici-dev/shared`. Consumed by both tiers, so it must stay permissive.            |
| `@kici-dev/shared`        | yes           | Apache-2.0    | Utilities consumed by both permissive and copyleft packages.                                                                               |
| `kici` (unscoped wrapper) | yes           | Apache-2.0    | Developer CLI entry point. Wraps `@kici-dev/compiler`.                                                                                     |
| `@kici-dev/engine`        | yes           | AGPL-3.0-only | Core business logic (protocol, state machine, trigger matching). Copyleft prevents a fork from re-hosting a proprietary KiCI-as-a-service. |
| `@kici-dev/agent`         | yes           | AGPL-3.0-only | Customer-deployable execution tier. Copyleft on the same grounds as orchestrator.                                                          |
| `@kici-dev/orchestrator`  | yes           | AGPL-3.0-only | Customer-deployable server tier. Copyleft prevents verbatim SaaS rehost.                                                                   |
| `kici-admin` (unscoped)   | yes           | AGPL-3.0-only | Orchestrator administration CLI. Same plane as orchestrator.                                                                               |

## What each tier means in practice

**Apache-2.0 tier — permissive, no copyleft.** Use these packages anywhere:
import them into proprietary products, vendor them into a closed-source
platform, bundle them with a commercial SaaS. The only requirements are the
usual Apache ones: keep the copyright notice, state significant changes,
retain the license text.

**AGPL-3.0-only tier — network copyleft.** You can:

- Read the source, fork it, run it internally (including modified) for your own
  operations — this is the main self-host path, and no source disclosure is
  required.
- Distribute binaries or modified source under the same AGPL-3.0 terms.

You **cannot**:

- Offer a modified version as a hosted service to third parties without
  publishing your modifications under AGPL-3.0 (§13 network-interaction
  clause).
- Re-license it, or combine it with incompatible proprietary code, without a
  commercial license.

If the network-copyleft constraint doesn't work for your business model, email
`licensing@kici.dev` to discuss a commercial license. No price list exists yet
— we'll negotiate case-by-case.

## Plain-English FAQ

A longer "what you can and can't do" write-up for workflow authors,
self-hosters, and would-be resellers lives at
[`docs/developer/licensing.md`](docs/developer/licensing.md).

## Third-party licenses

Runtime and build-time dependencies retain their upstream licenses. Inspect the
dependency tree with `pnpm licenses list` from the repo root.

## Why the split, in one paragraph

The SDK, compiler, and `kici` CLI are tools you pair with KiCI from outside —
they should be as frictionless as any other npm package, hence Apache-2.0.
The orchestrator, agent, engine, and admin CLI are the KiCI product itself —
copyleft here prevents someone from rehosting a verbatim "KiCI-as-a-service"
competitor without contributing their modifications back.
