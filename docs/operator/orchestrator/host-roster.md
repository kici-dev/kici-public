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
- **Properties** — a typed host-vars bag (`string | number | boolean` values), the place for facts like `region`, `cores`, or `gpu`. Distinct from labels: labels are the flat-string grouping/targeting dimension, properties are typed key/value host-vars. Reported by the agent (`KICI_PROPERTIES`) and/or pre-declared by the operator (`host declare --prop`), shallow-merged on each registration so agent-reported keys win and operator-set keys the agent does not report are preserved.

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

# Pre-declare with typed properties (repeatable --prop key=value).
kici-admin host declare --agent-id db-01 --labels role:db \
  --prop region=eu --prop cores=8 --prop gpu=true
```

A pre-declared static host is the bootstrap path: you record that a box _should_ exist (with its labels) before it has ever connected, so its absence is visible from the moment it is declared rather than only after it has connected once.

Re-declaring the same agent id converges the operator-owned fields — labels, hostname, properties, and SSH reach — to the values you pass, while preserving the agent-reported liveness/identity columns (connection state, platform, architecture). Operator fields you omit keep their stored value (reach metadata set earlier is never wiped by a labels-only re-declare), and properties shallow-merge the same way an agent registration does.

### Host properties

`--prop key=value` is repeatable and the value is **typed**: `true` / `false` become booleans, an integer or decimal literal becomes a number, and everything else stays a string. The declared properties seed the roster row's property bag; when the agent later connects and reports its own `KICI_PROPERTIES`, the two are shallow-merged (agent-reported keys win, operator-set keys the agent does not report are preserved). Properties are queryable from workflows via `ctx.kici.inventory` — see the [SDK runtime reference](../../user/sdk/runtime.md) for the inventory query API and the dynamic-job fan-out pattern.

## Fresh-box bootstrap (the init-runner seam)

A declared host that has **never run an agent** — a freshly-provisioned box reachable over SSH in its rescue/fresh-OS state — can be bootstrapped into the fleet. The minimal, irreducible use of SSH is **not** "run every bootstrap command remotely"; it is **"bring up a temporary privileged init-runner on the target."** Once that init-runner connects, every later bootstrap phase runs as an ordinary KiCI job on it.

### Declared-host reach metadata

To bootstrap a host, the roster needs to know how to reach it before it has an agent. `host declare` accepts four optional reach fields:

```bash
kici-admin host declare --agent-id box-00007 \
  --labels role:fresh \
  --address 10.0.0.7 \
  --ssh-user root \
  --ssh-port 22 \
  --ssh-key-secret prod/bootstrap/ssh
```

| Flag               | Meaning                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--address`        | IP / hostname to SSH to before the host has an agent.                                                           |
| `--ssh-user`       | SSH login user for the bring-up (defaults to `root`).                                                           |
| `--ssh-port`       | SSH port for the bring-up (defaults to `22`).                                                                   |
| `--ssh-key-secret` | A [scoped-secret](../../operator/security/secrets.md) reference (`scope/key`) holding the bring-up private key. |

All four are nullable: a host declared without reach metadata simply cannot be bootstrapped and behaves exactly as before. The private key is **never** stored in the roster — only the reference is. The orchestrator resolves it server-side at bring-up time and hands it to the ops agent that performs the SSH, mirroring how every other [scoped secret](../../operator/security/secrets.md) reaches an agent.

### Bringing up an init-runner

The bring-up is driven from a workflow by `ctx.kici.bootstrap.ensureInitRunner(targetAgentId)`. It runs only on an agent that holds the **`kici:capability:ssh-transport`** capability — the orchestrator refuses to dispatch the bring-up anywhere else — so the SSH-to-fresh-boxes power is held by exactly one designated ops pool:

```ts
job({
  runsOn: 'kici:capability:ssh-transport',
  run: async (ctx) => {
    await ctx.kici.bootstrap.ensureInitRunner('box-00007');
  },
});
// A following job pinned to the now-connected init-runner
// (runsOn: ['kici:host:box-00007', 'kici:init']) runs the bootstrap
// phases (partition / format / install) locally on the fresh box.
```

`ensureInitRunner` is a **no-op** when the target already has a live agent — re-running a bootstrap workflow against an initialized box does nothing. When the target is fresh, it mints a **single-use, short-TTL bootstrap token** (≈10 min, labels `kici:init` + `kici:privileged:root` + `kici:host:<id>`), drops + starts the agent binary on the target over SSH (ephemeral SSH agent, key never written to disk), and the existing auto-register flow enrolls it as a temporary `kici:init`-labeled ephemeral host. The init-runner dies on reboot and the reaper GCs its ephemeral roster row.

Every bring-up writes an [access-log](../../operator/security/audit-log.md) row (actor = the ops agent, target = the fresh host), and a bring-up attempt by an agent lacking the capability is logged as `denied`.

### Fleet convergence — one workflow, init-or-not

Instead of hand-wiring a bring-up job and a follow-on pinned job, a `runsOnAll` fan-out can converge the **whole declared fleet** — live hosts and fresh boxes alike — in a single workflow. Set `includeUninitialized: true` on the job:

```ts
job({
  runsOnAll: 'kici:group:prod',
  includeUninitialized: true,
  // The same bootstrap phases run on every host. On a live host they run on
  // its own agent; on a fresh box they run on a just-brought-up init-runner.
  steps: [partitionDisk, formatLuks, debootstrap, installAgent],
});
```

The fan-out then targets every declared host matching the selector **regardless of connection**:

- A host with a **live agent** runs the steps on its own agent — exactly as a normal `runsOnAll` fan-out child does today.
- A **declared-but-un-agented** host (a fresh box with reach metadata) triggers an init-runner bring-up automatically. The orchestrator dispatches the bring-up to an `kici:capability:ssh-transport` ops agent, holds that host's fan-out child until the init-runner connects, then runs the same steps on it. Authors write **one** set of steps; KiCI picks where each runs.

For this to be safe on already-initialized hosts, the bootstrap phases must be **idempotent [check-steps](../../user/sdk/core.md)**: each step's `check()` reports in-sync on a live, already-built box, so the partition / format / install steps **skip** there and only run on fresh boxes. "Runs on all, init-or-not" therefore means: fresh boxes get built, live boxes report in-sync and no-op. Re-running the workflow is a no-op everywhere — the now-initialized fresh box has a live agent (so its bring-up is skipped by the handoff guard) and its check-steps report in-sync.

`includeUninitialized` is only meaningful alongside `runsOnAll`; it is ignored (with a warning) on a single-agent `runsOn` job. When the flag is absent, an un-agented declared host is governed by the job's [`onUnreachable`](/user/sdk/runs-on-all/) policy as before, with no bring-up attempt.

### Pre-boot unlock (`preBootSend`)

A box rebooting into a LUKS-encrypted root sits at its initramfs unlock prompt — reachable over a separate pre-boot SSH channel (commonly port 2222) with no agent yet (the disk is locked). `ctx.kici.bootstrap.preBootSend` ships an input to that prompt over the same capability-gated, access-logged seam:

```ts
job({
  runsOn: 'kici:capability:ssh-transport',
  run: async (ctx) => {
    // Resolve a per-host passphrase from a scoped secret and pipe it to the
    // initramfs unlock prompt; then wait for the box to finish booting.
    await ctx.kici.bootstrap.preBootSend('box-00007', {
      inputSecret: 'prod/luks/box-00007',
    });
  },
});
```

`inputSecret` is a scoped-secret reference the orchestrator resolves server-side; the passphrase never passes through workflow code. `port` defaults to `2222` and `command` defaults to the initramfs `cryptroot-unlock` forced command. Success is the send completing — the unlock drops the SSH session as the box boots — so compose a host-alive wait (or the next phase pinned to the host) to confirm the boot. Wrapped in a fleet fan-out, this unlocks a whole fleet from per-host passphrases.

This is a **generic "ship an input to a pre-boot SSH prompt"** primitive; the LUKS-unlock recipe is the headline use. Network-bound automatic unlock (where no input is shipped — the box unlocks itself against a network key server) stays entirely in your own bootstrap step code; KiCI ships nothing for it.

### Security model

The ops agent that holds `kici:capability:ssh-transport` and the bring-up SSH key is **prod-critical** — it can SSH into fresh boxes. The surface is bounded by three controls: capability-gated dispatch (only the designated pool runs a bring-up), a per-bring-up access-log row, and single-use short-TTL bootstrap tokens (a leaked token is inert after the init-runner enrolls and after its short TTL elapses). Treat the bring-up SSH key as you would any other production credential — scope it per-host where possible.
