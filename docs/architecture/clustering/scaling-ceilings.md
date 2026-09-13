---
title: Scaling ceilings
description: Known cluster-scaling ceilings and the growth conditions that should trigger reworking them.
---

KiCI's clustering is built for the small-peer-fleet regime it runs in today. Two
mechanisms are known to have super-linear cost and are documented here as tripwires: they are correct
now, and each names the growth condition that should trigger a rework. Neither needs action today —
the point of writing them down is so the deferral is deliberate and the "act when growth demands"
signal is explicit.

## Peer heartbeat is O(peers × agents)

Every orchestrator peer broadcasts its full local agent inventory to every other peer on a fixed
interval. The inventory is assembled by `getLocalInventory()` in `cluster/peer-client.ts` and sent as
the `PeerHeartbeat` payload every `heartbeatIntervalMs` (default 30 seconds). With N peers each
advertising M agents, a single heartbeat round is O(N²) messages across the mesh and O(N × M) payload
per broadcast.

**Tripwire — act when:** the peer count times agents-per-peer grows large enough that 30-second
heartbeat traffic (message count or payload size) becomes material — for example, tens of peers each
carrying hundreds of agents. **Rework options:** delta-encode the inventory so a heartbeat sends only
what changed since the last one, move from all-to-all broadcast to a gossip fan-out, or split a cheap
liveness ping from a less-frequent full-inventory sync.

## Platform routing-key lookup cannot use an index

The Platform resolves an inbound event's routing key to the orchestrator connection that owns it with
a scan-style lookup: a `LIKE` text match over the routing-key sets that connected orchestrators have
advertised, scoped by organization to prevent cross-org routing. The routing-key sets are stored as a
JSON text column rather than an indexed exact-match structure, so the match itself cannot use an
index. Only the surrounding filters can: the organization scope is indexed, so a lookup scans one
organization's connected rows rather than the whole connection table.

This is **not** a horizontal-scaling blocker. The connection registry is Postgres-backed, and each row
records the Platform instance that owns it. So the lookup is already how one Platform instance
discovers that another instance holds the connection — it is what makes cross-instance relay (over
Valkey pub/sub) and the cross-instance dashboard proxy work. The Platform runs several server
instances per compute-origin box today, and this lookup serves them.

**Tripwire — act when:** a single organization's connected-orchestrator count grows large enough that
the per-lookup scan over its rows becomes material. That means a large fleet of orchestrators under
one org, each advertising many routing keys, on a hot webhook path. **Rework options:** normalize the
routing keys into their own indexed `routing_key → connection` table, or keep a subscription registry
keyed by routing key, so the match becomes an exact indexed lookup instead of a text scan.
