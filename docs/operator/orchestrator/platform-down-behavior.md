---
title: Platform-down behavior
description: What keeps working when the hosted KiCI Platform is offline, and the one capability that depends on it.
---

With [direct GitHub webhook ingress](./github-ingress.md) enabled, webhook
ingestion and full job processing are independent of the hosted KiCI Platform.
A push triggers a build, the build runs, and logs stream back — all without the
Platform in the path. This page states exactly which capabilities keep working
when the Platform is offline, and names the one capability that does not.

## What keeps working when the hosted Platform is offline

The orchestrator already does the real work locally: it verifies webhook
signatures, deduplicates deliveries, matches triggers against its compiled lock
file, dispatches jobs, and streams agent logs — none of which needs the
Platform. Direct ingress removes the last dependency, the delivery hop, by
letting GitHub deliver straight to the orchestrator.

## Capability matrix

The outcomes below are for "the hosted Platform is fully offline, direct GitHub
ingress enabled":

| Capability                                              | Platform-down with direct ingress                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Webhook ingestion (GitHub direct)                       | Works — GitHub delivers straight to the orchestrator                                                                     |
| Signature verification                                  | Works — verified locally against the orchestrator's secret store                                                         |
| Deduplication                                           | Works — atomic claim on the orchestrator's shared database                                                               |
| Trigger matching / lock file                            | Works — evaluated locally against the compiled lock file                                                                 |
| Job dispatch                                            | Works — the shared dispatch queue                                                                                        |
| Agent execution + log streaming                         | Works — agent-to-orchestrator, no Platform hop                                                                           |
| Cross-instance fan-out (clustered)                      | Works — shared queue + peer mesh; needs every instance to serve the ingress behind a load balancer                       |
| Provenance / attestation minting                        | Deferred — the job completes green; the attestation is captured to a durable outbox and minted when the Platform returns |
| Hosted dashboard / source registration via the Platform | Unavailable — use the local `kici-admin` CLI instead                                                                     |
| Billing / quota                                         | Not applicable — direct-ingress events are quota-free                                                                    |

## The independence boundary

The boundary is a single capability: **provenance attestation minting**.

- A workflow that does **not** mint provenance attestations runs fully
  end-to-end with the Platform offline. Ingest, dispatch, execution, and log
  streaming all complete locally.
- A workflow that **does** mint attestations runs to completion — the job
  executes and produces its outputs — and the attestation is **deferred**, not
  lost. The one Platform-specific part of an attestation is the identity token
  the hosted Platform's provenance issuer signs; everything the attestation
  asserts is sealed on the agent at build time. When the mint fails because the
  Platform is unreachable, the agent freezes and signs the statement, the
  orchestrator captures it into a durable outbox, and the job stays green.

The deferred attestation is minted automatically when the Platform returns — on
the orchestrator's next retry sweep and immediately when its Platform connection
re-authenticates — with no operator action. The later token binds to the frozen
statement by its hash, so the identity cannot be re-bound to a different
artifact, and the bundle is marked `deferred` so the temporal gap is disclosed.
An operator can also drain the outbox on demand with
`kici-admin attestations retry` (optionally scoped with `--run-id`). A run that
was ingested while the Platform was fully down has its run and job records
backfilled to the Platform before the mint, and its attestation is marked
`offline-backfill`. Both markers still verify — `kici verify-attestation`
surfaces them on a PASS. See the [provenance
architecture](../../architecture/security/provenance.md) for the full lifecycle.

### When a deferred attestation can never be minted

A deferred mint fails **transiently** while the hosted Platform is unreachable —
the row stays in the outbox with a bumped attempt count and its last error, and
the next sweep retries it. But the Platform can also return a **definitive**
rejection: it processed the mint request and found the run or job genuinely
absent (for example, a run that was pruned before its attestation was ever
minted). That is not a blip that a later retry will fix, so the row is marked
**terminally rejected** — it stops being retried, drops out of the
`kici_orch_pending_attestations_current` gauge, and keeps its row (with the
rejection reason recorded as its last error) for audit.

Terminally-rejected rows are counted by a separate gauge,
`kici_orch_rejected_attestations_current`. A sustained non-zero value means one
or more runs/jobs the hosted Platform can no longer find — investigate the
Platform-side cause, and once it is fixed, re-arm the affected rows.

To re-arm, pass `--include-rejected` to the drain command:

```bash
kici-admin attestations retry --include-rejected
```

This clears the terminal marker on previously-rejected rows and re-attempts them
in the same drain (combine with `--run-id` to scope the re-arm to a single run).
The command's summary line reports all three outcomes:

```
Minted 2 deferred attestation(s); 1 still pending; 0 rejected.
```

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
