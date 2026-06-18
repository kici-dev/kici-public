---
title: Cluster name
description: How each orchestrator picks the human-friendly identifier that surfaces on Platform and in the dashboard.
---

Every orchestrator carries a **cluster name** — a human-friendly identifier
that Platform uses to address this orch on the wire and that the
dashboard uses as the URL segment for per-orch surfaces (security
policy, environments, secrets, DLQ, registrations, global workflows).

The cluster name is the answer to "which of my orchestrators is
this?" when an org runs more than one. Different clusters in the same
org can hold legitimately different state — different
`dashboard_write_policy`, different environments, different secrets —
and the dashboard scopes its panels to a single cluster at a time so
nothing silently collapses to "the first orch connected".

## Format

A cluster name matches the regex
`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`:

- Lowercase ASCII letters, digits, and dashes only.
- 1 to 63 characters total.
- Must start and end with a letter or digit (no leading or trailing
  dashes).

Examples: `production-arm`, `staging-x86`, `eu-west-1`,
`cluster-a3f81c`.

## First boot — auto-generation

On the orch's first boot, if no operator has supplied a cluster name,
the orchestrator picks `cluster-<6hex>` — six lowercase hex
characters derived from the host's randomness. That value is written
to `cluster_meta.cluster_name` in the orchestrator's local Postgres
and survives restarts.

A different environment-variable value on a later boot is **ignored**
once a persisted name exists — the persisted value is the source of
truth so an accidental env-var change can't silently rename the orch
out from under Platform.

## Renaming with `kici-admin cluster-name`

The canonical way to change the cluster name after the orch is
already running is the `kici-admin cluster-name` subcommand. It talks
to the orchestrator's admin API directly, so the CLI stays operable
even when Platform is unreachable.

### Show the current name

```bash
kici-admin cluster-name get
# Cluster name:        production-arm
# Looks auto-generated: no
```

The `Looks auto-generated` field is `yes` when the persisted name
still matches the `cluster-<6hex>` pattern — useful for spotting orchs
that never got a human-friendly name.

### Set a new name

```bash
kici-admin cluster-name set production-arm
# Renamed: cluster-a3f81c -> production-arm
# Reconnect to Platform to publish the new name. Restart the
# orchestrator or run `kici-admin orchestrator-service restart`.
```

The orchestrator persists the new name immediately but keeps using
the old one on its current Platform WebSocket connection. **Restart
the orchestrator** (`kici-admin orchestrator-service restart`, or
your service manager's equivalent) so the next `source.register`
publishes the new name. After Platform acknowledges, the dashboard's
per-orch URL segment updates and the orchestrator picker shows the
new identifier.

Sending the same name as the current one is a no-op:

```bash
kici-admin cluster-name set production-arm
# Cluster name is already production-arm (no change).
```

## Multiple connections with the same cluster name

Platform accepts any number of connected orchestrators in one org
that share a `cluster_name`. The intended use case is high-availability
cluster topologies — every coordinator participating in one logical
orchestrator shares the same orchestrator database, resolves the same
`cluster_meta.cluster_name` on boot, and opens its own Platform
WebSocket. All of those connections register cleanly.

The dashboard's `/orgs/:customerId/orchestrators` listing dedupes
server-side by `cluster_name`, so even with N sibling connections
the operator sees **one card per logical cluster identity**. Per-orch
panels addressed by URL segment
(`/orgs/:customerId/orchestrators/:clusterName/...`) resolve to any
connected sibling — every sibling shares the same orchestrator state
and answers identically.

If two genuinely different clusters in one org happen to share a
`cluster_name` (distinct orchestrator databases, same chosen name),
they coexist silently and the per-orch URL round-robins between
them. To keep them addressable separately:

1. Decide which cluster should keep the contested name.
2. Rename the other one with `kici-admin cluster-name set <new>`.
3. Restart it. Both clusters now coexist under their distinct names.

Every orchestrator also carries an internal cluster identifier (the
stable UUID minted by the orch's database on first boot, distinct from
the human-friendly cluster name). HA siblings share the orchestrator
database and therefore share this identifier; two unrelated clusters
carry distinct identifiers. When a new orchestrator connects with the
same `cluster_name` as a connected sibling but a different internal
identifier, the relay logs a warning describing the collision while
accepting both connections. Operators can search the structured logs
for `cluster_name shared by two different orchestrator clusters` to
find collisions that would otherwise stay invisible.

## Where the cluster name shows up

The same identifier surfaces in three places:

- **Platform wire protocol.** Every `source.register` message
  carries `clusterName`. Platform persists it on
  `platform_connections.cluster_name`.
- **Dashboard URL.** Per-orch panels live under
  `/orgs/:customerId/orchestrators/:clusterName/...` — for example
  `/orgs/acme/orchestrators/production-arm/settings/security/dashboard-policy`.
- **Run metadata.** The run-detail page on the dashboard renders the
  executing orchestrator's cluster name as a link back to that orch's
  pages.

## Picking a name

Most orgs run a **single cluster** — see
[How many clusters?](clustering.md#how-many-clusters) for why one cluster
with several scalers usually beats several clusters. You only need to name
_multiple_ clusters once you've deliberately split along an isolation
boundary. When you do, name each cluster after the boundary that
distinguishes it:

- **By team:** when one org runs separate clusters for distinct teams (the
  usual reason to run more than one), prefix with the team —
  `payments-prod`, `analytics-staging`.
- **By environment:** when production and staging are genuinely separate
  deployments — `production`, `staging`, `dev`.
- **By region:** when data residency or latency forces a regional split —
  `eu-west-1`, `apac`, `home-lab`.

The cluster name is a label, not a hostname — choose whatever helps your team
tell clusters apart at a glance. Don't reach for a new cluster just to run a
different architecture or hardware shape: a single cluster routes x64, ARM64,
and GPU work to the right agents through separate scalers (see
[How many clusters?](clustering.md#how-many-clusters)).

Avoid embedding secrets, customer names, or anything else that would leak
through the dashboard URL — the cluster name is visible to every user of the
org with `dashboard:read` permissions.
