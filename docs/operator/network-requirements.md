---
title: Network requirements
description: 'Outbound allowlist and inbound surface for every KiCI deployment mode: what the orchestrator and agents connect to, and what must reach them'
---

One-page reference for firewall and egress-proxy review. It covers all four
orchestrator modes (`platform`, `hybrid`, `observed`, `independent` — set via
`KICI_MODE`) plus clustering. For the symptom-driven runbook ("agent won't connect",
"webhook never arrives"), see [Troubleshooting](./troubleshooting.md).

## Outbound connections

| Destination                                            | Port | Protocol        | Purpose                                                                                                                                                                                                                                                                     | Applies to                                                                |
| ------------------------------------------------------ | ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `api.kici.dev`                                         | 443  | WebSocket (TLS) | Platform connection: relayed webhooks (`platform` / `hybrid` only), dashboard, run metadata (`KICI_PLATFORM_URL=wss://api.kici.dev/ws`)                                                                                                                                     | `platform` / `hybrid` / `observed` modes only                             |
| `quay.io` (+ its CDN endpoints)                        | 443  | HTTPS           | Pulling `quay.io/kici-dev/kici-orchestrator` and `kici-agent` images — at install, and by the container/Firecracker scaler on agent spawn when the image is not already cached (`imagePullPolicy` defaults to `IfNotPresent`; set it to `Always` to re-pull on every spawn) | container deployments + container/Firecracker scaler                      |
| `registry.npmjs.org` (or your private registry)        | 443  | HTTPS           | Per-job dependency installs by the agent; also native bundler bindings fetched on demand                                                                                                                                                                                    | agents (all modes)                                                        |
| `github.com` / `api.github.com` (or your own git host) | 443  | HTTPS           | Repository clones, raw file fetches, GitHub App API (commit statuses, installations)                                                                                                                                                                                        | all modes using the GitHub provider; universal-git uses your host instead |
| `github.com` (releases)                                | 443  | HTTPS           | `shawl` service wrapper download                                                                                                                                                                                                                                            | Windows service installs only                                             |

PostgreSQL and S3-compatible storage are infrastructure you provide; they are
internal dependencies, not internet egress.

In `independent` mode the Platform row disappears entirely: the orchestrator
holds no connection to any KiCI-operated endpoint. The remaining rows still
apply — images, dependencies, and your git host — because those are how the
orchestrator and agents run jobs, not how they reach KiCI.

## Inbound surface

The orchestrator serves everything on a single HTTP port, default **4000**
(`KICI_PORT`). The agent does not accept work over the network: it dials the
orchestrator outbound and listens only for health checks, default port **8080**.

| Endpoint                                                         | Who connects                                                                                           | Exposure needed                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ws`                                                        | Agents (`KICI_ORCHESTRATOR_URL`)                                                                       | Reachable from every agent host/sandbox; not public                                                                                                                                                                                                                           |
| `GET /ws/peer`                                                   | Cluster peers / workers                                                                                | Reachable between orchestrators (`KICI_CLUSTER_ADDRESS`); not public                                                                                                                                                                                                          |
| `POST /webhook/:orgId/github/:sourceId`, `.../generic/:sourceId` | Your git host / webhook senders                                                                        | Public (or host-reachable) in `independent`, `hybrid`, and `observed` direct-ingress setups (`KICI_WEBHOOK_PUBLIC_URL` is this base); NOT needed in `platform` mode — webhooks arrive over the relay                                                                          |
| `GET /.well-known/openid-configuration`                          | Attestation verifiers                                                                                  | Public HTTPS at the `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` base when orchestrator-owned provenance signing is configured. Unauthenticated by design                                                                                                                            |
| `GET /.well-known/jwks.json`                                     | Attestation verifiers; dashboard users' browsers (verification badges, encrypted-write encryption key) | Public HTTPS. Served whenever the orchestrator has a key to publish, so the [Verified encrypted-write tier](./security/encrypted-dashboard-writes.md) needs it reachable even with no attestation issuer configured. Unauthenticated by design; serves public key halves only |
| `POST /v1/verify-attestation`                                    | Verification clients (optional online verify)                                                          | Same base as the issuer endpoints; optional                                                                                                                                                                                                                                   |
| `/api/v1/*`                                                      | `kici`, `kici-admin`, dashboard                                                                        | Operator network only                                                                                                                                                                                                                                                         |
| `GET /health`, `GET /ready`, `GET /metrics`                      | Load balancers, monitoring                                                                             | Internal                                                                                                                                                                                                                                                                      |

When orchestrator-owned provenance signing is configured
(`KICI_ORCHESTRATOR_PROVENANCE_ISSUER` — see
[signing keys](./orchestrator/signing-keys.md)), the issuer's discovery + JWKS
endpoints are the one inbound surface that should be **publicly** reachable over
HTTPS regardless of mode: `kici verify-attestation` resolves them by default,
and the hosted dashboard's attestation verification badges fetch the JWKS
directly from the viewer's browser — a private-only issuer makes those badges
show **keys unavailable** for anyone outside your network. The JWKS also carries
the dashboard-encryption key, so it needs the same public exposure whenever you
opt into the Verified encrypted-write tier, whether or not attestations are
configured. A reverse proxy that exposes only `/webhook/*` and
`/.well-known/*` (plus `/v1/verify-attestation` if you want online
verification) and keeps everything else internal is the typical shape.

## Per-mode summary

- **`platform`** — outbound only to `api.kici.dev`; webhooks and dashboard
  traffic arrive over the relay, so zero public inbound is required.
- **`hybrid`** — same outbound as `platform`, **plus** the direct webhook
  endpoint (`KICI_WEBHOOK_PUBLIC_URL`) must be reachable by your git host —
  webhooks arrive over both paths and are deduplicated, so runs still trigger
  when either the relay or the direct path is down.
- **`observed`** — same outbound as `platform` (the Platform connection carries
  dashboard and run metadata only), **plus** the direct webhook endpoint
  (`KICI_WEBHOOK_PUBLIC_URL`, mandatory in this mode) must be reachable by your
  git host. No webhook ever transits KiCI: the relay path is off on both sides.
- **`independent`** — no KiCI egress at all, but the direct webhook endpoint
  (`KICI_WEBHOOK_PUBLIC_URL`) must be reachable by your git host so pushes and
  pull requests can trigger runs.
- **Clustering (any mode)** — peers must reach each other's `/ws/peer` over the
  address set in `KICI_CLUSTER_ADDRESS`; in the Platform-connected modes, peers that
  cannot reach each other directly fall back to relaying through the Platform.
  Workers dial `KICI_CLUSTER_COORDINATOR_URL` outbound only.

## Job egress is filtered by default

Container and Firecracker jobs run behind default-on egress filtering that
blocks the private ranges `10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16`
along with the cloud metadata range `169.254.0.0/16`; the bare-metal namespace
sandbox is loopback-only. This governs what a running **job** may reach and is
distinct from the orchestrator and agent traffic in the tables above. See
[Is self-hosting the agents a security risk?](./security/self-hosting-security.md)
and [Agent execution security](./security/agent-security.md).

## See also

- [Multi-orchestrator clustering](./orchestrator/clustering.md) — peer connectivity detail.
- [Data residency](./data-residency.md) — what data flows over the Platform connection.
- [Troubleshooting](./troubleshooting.md) — connectivity symptom runbook.
