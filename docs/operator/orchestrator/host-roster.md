---
title: Host roster (declared inventory)
description: The durable host roster that turns the orchestrator's observed agents into declared + observed inventory, with derived status and the kici-admin host commands
---

The host roster is the orchestrator's **declared inventory**: a durable, cluster-shared record of every agent the cluster has ever enrolled. Without it, inventory is purely _observed_ — an agent that is offline simply does not exist, so a host mid-reboot is silently absent. The roster adds the _declared_ dimension: a host can be **expected** (and read as unreachable when absent) instead of vanishing.

The roster never replaces the live agent registry. The in-memory registry stays the hot path for dispatch; the roster is a best-effort durable shadow that the registry reconciles into on every agent register and disconnect.

## What a roster row records

One row per agent, keyed by its agent id:

- **Lifecycle class** — `static` or `ephemeral`, snapshotted from the enrolling token's type. `static` = durable / metal (a whole fleet shares one token; absence is an alarm). `ephemeral` = autoscale (a single agent id per token; absence past its TTL is a silent scale-down).
- **Labels** — the post-enrollment validated label set (the same labels the orchestrator routes on).
- **Connected instance** — which orchestrator instance currently holds the agent's live connection, or empty when the agent is disconnected. In a cluster this is the shared liveness signal: every instance agrees on a host's status because it derives from this shared column, not from any one instance's in-memory registry.
- **Last seen** — a coarse heartbeat timestamp (updated on register, on a throttled cadence while connected, and cleared of ownership on disconnect).
- **Hostname / platform / arch** — metadata reported by the agent.

The roster lives in the orchestrator's shared cluster database (one table, all instances read and write it).

## Pattern matching against roster labels

A workflow's [`runsOnAll`](/user/sdk/runs-on-all/) predicate is matched against the
labels recorded on each roster row. Every selector element — on both the include and the
exclude side — can be an exact label, a glob (`kici:host:web-*`), or a regular expression
(`/.*-canary$/`); the orchestrator infers the mode from the value. A host is in the
fan-out when it satisfies any include group and carries none of the exclude matchers.

The matching cost differs by element kind. An exact label uses the in-memory agent
registry's reverse index — a direct lookup that does not grow with fleet size, so the
single-agent `runsOn` hot path stays cheap when every label is exact. A glob or regular
expression cannot be served from that index, so it is evaluated as a scan across the
candidate set (and, for `runsOnAll`, across every roster row). The scan is fine for the
fleet sizes the roster is built for; prefer exact labels where they suffice and reserve
patterns for genuine fan-out targeting.

## Derived status

A host's status is **computed at read time** from the shared `last_seen` + connected-instance columns — never a stored mutable flag:

| Status        | Meaning                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `ready`       | Connected to some instance **and** the heartbeat is fresh (within the grace window).           |
| `unreachable` | A `static` host that is not currently live — declared-but-never-connected, rebooting, or gone. |
| `stale`       | An `ephemeral` host that is not currently live — scaled down, awaiting reap.                   |

`ready` is only ever reported for a genuinely live host: it requires both a live connection **and** a fresh heartbeat. A crashed instance that never cleared its ownership row is caught by the freshness check, so the roster never reports `ready` for a host that cannot actually run work. This honesty is the point — a declared host that is expected but absent is _named_, not silently skipped.

## Reaping

A single leader instance runs a periodic reaper that **deletes `ephemeral` rows past their TTL** (scaled-down autoscale agents — silent GC, no alarm). `static` rows are never deleted; an absent static host stays in the roster and reads `unreachable`.

## Unreachable-host alarm

A declared (`static`) host that goes dark is exactly what the roster exists to surface — a racked box can fail silently, and "absence is an alarm" is the whole reason durable hosts persist in the inventory. The leader instance publishes the count of currently-unreachable declared hosts on each reaper tick as the `kici_orch_declared_hosts_unreachable` metric (a plain count — no per-host labels, so it never grows with fleet size). A monitoring alert, `DeclaredHostUnreachable`, fires when that count is `> 0` for longer than the roster grace window plus a margin (7 minutes against the 5-minute default), routing to the operator's pager.

The metric carries the count, not the identity. When the alert fires:

```bash
# Find which declared hosts are down.
kici-admin host list           # look for status `unreachable`
kici-admin host list --json
```

Then investigate the offending box: power, network reachability, and whether its agent service is running and able to dial the orchestrator. A declared host left unreachable will have its `runsOnAll` workloads skipped or held (depending on the job's `onUnreachable` policy), so resolving it promptly keeps fleet-wide jobs whole.

## Timing knobs

Two cluster-wide defaults govern the timing:

| Setting         | Env var                | Default            | Controls                                                                                  |
| --------------- | ---------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `rosterGraceMs` | `KICI_ROSTER_GRACE_MS` | `300000` (5 min)   | How long a disconnected `static` host is tolerated before its status reads `unreachable`. |
| `rosterTtlMs`   | `KICI_ROSTER_TTL_MS`   | `1800000` (30 min) | How long a disconnected `ephemeral` host survives before the reaper deletes it.           |

The grace window is short — a static reboot is tolerated, then surfaced — because a false alarm is cheap (an operator glances and sees the box rebooting). The TTL is longer because a premature reap of an ephemeral host is expensive (it can orphan in-flight work), so it errs on the side of waiting.

## Inspecting and declaring hosts

The `kici-admin host` commands read and write the roster directly against the orchestrator database (set `KICI_DATABASE_URL` or pass `--database-url`):

```bash
# List every roster host with its derived status.
kici-admin host list
kici-admin host list --json

# Show one host.
kici-admin host get --agent-id web-01
kici-admin host get --agent-id web-01 --json

# Pre-declare a static host before its agent connects. Until the agent
# dials in, the host reads `unreachable` — the "expected but not yet here"
# state for bootstrapping a metal box.
kici-admin host declare --agent-id web-09 --labels role:web --hostname web-09
```

A pre-declared static host is the bootstrap path: you record that a box _should_ exist (with its labels) before it has ever connected, so its absence is visible from the moment it is declared rather than only after it has connected once.
