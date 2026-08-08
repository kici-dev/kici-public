---
title: Scaling ceilings
description: Known cluster-scaling ceilings and the growth conditions that should trigger reworking them.
---

KiCI's clustering is built for the single-Platform, small-peer-fleet regime it runs in today. Two
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

## Platform routing-key lookup assumes a single Platform process

The Platform resolves an inbound event's routing key to the orchestrator connection that owns it with
a scan-style lookup: a `LIKE` text match over the routing-key sets that connected orchestrators have
advertised, scoped by organization to prevent cross-org routing. The routing-key sets are stored as
JSON text rather than an indexed exact-match structure, so the match cannot use an index, and the
lookup assumes a single Platform process owns the connection registry. This is correct and fast enough
for the single-process Platform deployment KiCI runs today.

**Tripwire — act when:** you need to run a **second Platform pod**. This lookup is the specific
blocker for horizontal Platform scaling. Before a multi-pod Platform, rework it to an indexed
exact-match (a normalized `routing_key → owner_instance_id` table with a real index) or a subscription
registry keyed by routing key — otherwise the scan becomes both a per-pod contention point and a
correctness hazard as connections spread across pods.
