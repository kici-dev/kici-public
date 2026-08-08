---
title: Platform-down behavior
description: What keeps working when the hosted KiCI Platform is offline, and the one capability that depends on it.
---

With [direct GitHub webhook ingress](./github-ingress.md) enabled, webhook
ingestion and full job processing are independent of the hosted KiCI Platform.
A push triggers a build, the build runs, and logs stream back — all without the
Platform in the path. This page states exactly which capabilities keep working
when the Platform is offline, and names the one capability that does not. That is
the reliability reason to enable direct ingress even when you run the hosted
Platform (hybrid mode): a Platform outage cannot stop a push from triggering a
build. For the complementary view — everything the hosted Platform provides — see
[What requires the hosted Platform](./platform-capabilities.md).

## What keeps working when the hosted Platform is offline

The orchestrator already does the real work locally: it verifies webhook
signatures, deduplicates deliveries, matches triggers against its compiled lock
file, dispatches jobs, and streams agent logs — none of which needs the
Platform. Direct ingress removes the last dependency, the delivery hop, by
letting GitHub deliver straight to the orchestrator.

## Capability matrix

The outcomes below are for "the hosted Platform is fully offline, direct GitHub
ingress enabled":

| Capability                                   | Platform-down with direct ingress                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Webhook ingestion (GitHub direct)            | Works — GitHub delivers straight to the orchestrator                                               |
| Signature verification                       | Works — verified locally against the orchestrator's secret store                                   |
| Deduplication                                | Works — atomic claim on the orchestrator's shared database                                         |
| Trigger matching / lock file                 | Works — evaluated locally against the compiled lock file                                           |
| Job dispatch                                 | Works — the shared dispatch queue                                                                  |
| Agent execution + log streaming              | Works — agent-to-orchestrator, no Platform hop                                                     |
| Cross-instance fan-out (clustered)           | Works — shared queue + peer mesh; needs every instance to serve the ingress behind a load balancer |
| Provenance / attestation signing             | Works — the orchestrator mints + signs attestations with its own key (no Platform hop)             |
| Hosted dashboard (run/source/settings views) | Unavailable — inspect runs, logs, and sources with the local `kici-admin` CLI instead              |
| Billing / quota                              | Not applicable — direct-ingress events are quota-free                                              |

## The independence boundary

**Build provenance is not part of the boundary — it works with the Platform
offline.** The orchestrator owns the provenance signing key: it mints and signs
each attestation's identity token locally from its own run records, so a workflow
that attests artifacts runs fully end-to-end — ingest, dispatch, execution, log
streaming, and attestation signing — with the hosted Platform unreachable. There
is no Platform hop in the build hot path. See [signing keys](./signing-keys.md)
for how the orchestrator provisions and rotates its key, and the
[provenance architecture](../../architecture/security/provenance.md) for the full
lifecycle.

The remaining boundary is the **control plane**: the hosted dashboard, user
identity and login, organizations / teams / roles, billing and quotas, and the
webhook relay. Those are unavailable when the Platform is down; the execution
core (including provenance signing) is not affected.

## Why direct ingestion does not change attestation trust

Direct ingestion changes only _where GitHub delivers the event_, not what the
attestation asserts. The organization id is the only un-forgeable anchor in the
trust model, and the `repo` / `ref` / `sha` an attestation records are
organization-asserted in the relayed path too — the orchestrator already
self-reports source identity whether the event arrives via the Platform relay or
directly. So delivering webhooks directly does not weaken the attestation trust
model. For the full provenance and attestation model, see the [provenance
architecture](../../architecture/security/provenance.md).

## Cross-instance fan-out

For a clustered orchestrator the independence extends across instances. All
instances share one PostgreSQL database: a delivery landing on any instance
enqueues jobs in the shared dispatch queue, any agent on any instance claims
them, and the orchestrator-to-orchestrator peer mesh reroutes for capacity. Put
an external load balancer or DNS record in front of the cluster and have every
instance serve the ingress route, and a delivery can arrive on any healthy
instance and still be executed cluster-wide — with the Platform offline the
whole time. The atomic dedup claim on the shared database guarantees that a
delivery retried onto two instances is dispatched exactly once.
