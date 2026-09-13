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
| Held-run approvals (`/kici approve`)         | Works — decided against the approval directory the last push left; see the note below              |
| Hosted dashboard (run/source/settings views) | Unavailable — inspect runs, logs, and sources with the local `kici-admin` CLI instead              |
| Relayed-webhook quota                        | Not consumed — a direct-ingress delivery never reaches the Platform relay that meters it           |

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

**Approvals keep working, against the membership the last push left.** Your
orchestrator decides `/kici approve` comments on held runs against a cached copy
of the approval directory, which the Platform refreshes on every change. The
cache does not expire, so approvals keep working through the outage — but a
CI-trust or membership change you make while the Platform is unreachable does
not reach the orchestrator until the connection returns. To cut a person off
during an outage, revoke their orchestrator token, which the orchestrator
decides on its own. See
[how a CI-trust change reaches the orchestrator](../security/rbac-two-layers.md#how-a-ci-trust-change-reaches-the-orchestrator)
for how to read the current lag.

**With the Platform up, direct ingress changes one meter, not your plan.** The
matrix above describes a full outage. In a Platform-connected mode that serves
its own ingress — `hybrid`, or `observed` with a generic or local source — the
Platform still meters your
organization, and direct ingress bypasses the relayed-webhook quota alone: the
delivery never reaches the relay that counts it. Every other plan dimension
applies as usual, among them runs per month, orchestrators, members, live-log
minutes, and run retention. The billing tab lists your current meters —
see [organization settings](../../user/dashboard/settings.md#billing).

## Why direct ingestion does not change attestation trust

Direct ingestion changes only _where GitHub delivers the event_, not what the
attestation asserts. The organization id is the only un-forgeable anchor in the
trust model, and the `repo` / `ref` / `sha` an attestation records are
organization-asserted in the relayed path too — the orchestrator already
self-reports source identity whether the event arrives via the Platform relay or
directly. So delivering webhooks directly does not weaken the attestation trust
model. For the full provenance and attestation model, see the [provenance
architecture](../../architecture/security/provenance.md).

## Recovering a window of lost deliveries

A relay-only orchestrator that was unreachable through a Platform outage loses
every push in that window: GitHub does not retry a delivery its destination
failed to accept. Direct ingress prevents the loss; `kici-admin source
redeliver` repairs it after the fact.

The orchestrator holds the GitHub App private key, so it is the tier that can
drive GitHub's App-level delivery endpoints. It lists the App's deliveries in
the window you name and asks GitHub to send each one again.

```bash
# See what GitHub still holds for the window, without resending anything.
kici-admin source redeliver github:42 \
  --since 2026-09-01T09:00:00Z --until 2026-09-01T11:30:00Z --dry-run

# Send them.
kici-admin source redeliver github:42 \
  --since 2026-09-01T09:00:00Z --until 2026-09-01T11:30:00Z
```

`--since` is inclusive, `--until` is exclusive, and both are required — a replay
with no upper bound would resend everything GitHub still holds. The command
prints one row per delivery with its original response status and the outcome of
the replay, then a tally. It exits non-zero when GitHub refused any of them.

Before you run it:

- **A redelivery goes to the App's configured webhook URL, not to the
  orchestrator that ran the command.** Repoint the App at this orchestrator
  first (see [direct GitHub webhook ingress](./github-ingress.md)) if the
  deliveries are to land here rather than back at the relay.
- **A replayed delivery carries its original `X-GitHub-Delivery` id**, so an
  orchestrator that already processed it deduplicates it and dispatches nothing
  twice. Replaying a window wider than the one you lost is therefore safe.
- **GitHub keeps deliveries for a limited retention window.** A delivery older
  than that is no longer listed and cannot be replayed.

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
