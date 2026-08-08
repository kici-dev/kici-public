---
title: What requires the hosted Platform
description: The authoritative list of capabilities the hosted KiCI Platform provides, and what a fully self-hosted independent orchestrator does without.
---

The orchestrator and agent do all of KiCI's execution work and can run fully
self-hosted, in `independent` mode, with the hosted Platform out of the loop
entirely — webhooks arrive directly, jobs dispatch and run, and logs stream back,
none of it touching KiCI's servers. The hosted Platform is the **control plane**
layered on top of that execution core. This page is the authoritative list of
what the Platform provides — and therefore what a bare independent orchestrator
does not have.

For the mechanics of running without the Platform, see
[Platform-down behavior](./platform-down-behavior.md) and
[Direct GitHub webhook ingress](./github-ingress.md). For how to choose a mode,
see [Configuration](./configuration.md).

## What requires the hosted Platform

Each item lists the local substitute where one exists.

- **Hosted dashboard.** The web UI — run history, run detail, the live-log
  viewer, and every settings/management screen — is served by the Platform.
  Viewing your webhook sources and their ingress URLs is part of this dashboard
  (read-only). Substitute when self-hosted: the `kici-admin` CLI, which reads the
  same run, log, and source data directly from your orchestrator.
- **One-click GitHub App install and webhook relay.** The GitHub-App manifest
  install flow resolves the App's webhook URL from the orchestrator's Platform
  connection, so it needs a Platform-connected (platform or hybrid) orchestrator,
  and the Platform's webhook relay forwards App events to you. Self-hosted
  substitute: register a source with `kici-admin source add` (this is always how
  sources are registered — see the note below) and expose
  [direct webhook ingress](./github-ingress.md) so events arrive without the relay.
- **User identity and login.** Signing in (OIDC), personal access tokens, and the
  `kici login` developer flow authenticate against the hosted Platform. A
  self-hosted orchestrator authenticates callers with local bearer tokens and
  orchestrator API keys instead.
- **Organizations, teams, and member roles.** The multi-tenant control plane —
  inviting users, organizing teams, and assigning per-user roles — lives on the
  Platform. (Your orchestrator still enforces its own admin-action permissions.)
- **Billing, quotas, and usage metering.** Plan limits and metering are a
  Platform concept. They do not apply to a self-hosted orchestrator, and
  direct-ingress webhooks are never metered.
- **Webhook relay and relayed-delivery records.** Forwarding a signature-verified
  webhook from the Platform to your orchestrator (and recording that delivery) is
  Platform-side. Self-hosted, events arrive by direct ingress instead.
- **Dynamic peer matchmaking.** Platform-connected clusters discover peers through
  the Platform. Independent clusters configure their peers statically.
- **Platform-side developer CLI commands.** `kici login`, `kici org`, `kici runs`,
  `kici secrets-list`, `kici pat`, and connected/routed runs talk to the Platform.
  Compiling workflows, running locally (`kici run --local`), and verifying
  attestations offline do not.
- **Platform-side scheduled jobs and dashboard notifications.**

## Source registration is always `kici-admin`

There is no "register a source through the Platform" action. Sources are always
created with `kici-admin source add …`, which writes to your orchestrator. The
hosted dashboard only _displays_ your registered sources and their ingress URLs;
a Platform-connected orchestrator additionally announces its routing keys to the
Platform so the relay knows where to forward events, but that announcement is an
internal handshake, not source registration.

## What still works fully self-hosted

With no Platform at all (`independent` mode), the whole execution path works:

- Webhook ingestion (direct), local signature verification, delivery
  deduplication, trigger matching against the compiled lock file, job dispatch,
  agent execution, and log streaming.
- Local inspection and administration through `kici-admin` — runs, event log,
  access log, audit, secrets, variables, agents, and join tokens.
- Clustering across instances that share a database, with statically configured
  peers.
- `kici run --local` and offline `kici verify-attestation`.
- **Build provenance and attestations.** Your orchestrator owns the provenance
  root of trust: it holds its own ES256 signing key, mints and signs identity
  tokens locally, and publishes its own OIDC discovery + JWKS, so builds produce
  verifiable provenance with no hosted-Platform dependency. See
  [signing keys](./signing-keys.md).

The boundary is simple: the **execution core** — including build provenance
signing — is fully self-hostable; the **control plane** — dashboard, identity,
organizations, billing, and relay — is what the hosted Platform adds.

## Keeping the dashboard without the relay: `observed` mode

`observed` mode splits that boundary one step finer. It keeps everything in the
list above **except** the webhook relay: providers deliver straight to your
orchestrator's own ingress (no payload transits KiCI) while the Platform
connection stays up, so the hosted dashboard, identity, organizations, and
billing all keep working. The trade-off is the relay-dependent items: the
one-click GitHub-App install flow and GitHub-App sources in general are
unsupported in this mode — use a generic or local source, or pick `hybrid` if you
want the relay. See [Configuration](./configuration.md) and
[Data residency](../data-residency.md).

## Related

- [Platform-down behavior](./platform-down-behavior.md)
- [Direct GitHub webhook ingress](./github-ingress.md)
- [Configuration](./configuration.md)
