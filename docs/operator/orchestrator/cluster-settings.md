---
title: Cluster settings
description: Fleet-wide orchestrator tunables you can change at runtime with kici-admin cluster-settings, versus per-tenant org settings
---

The orchestrator has two runtime-editable settings stores. Both let you change a
limit, TTL, or threshold on a **live** orchestrator without editing a unit file
and redeploying — the difference is the scope:

- **Cluster settings** are **fleet-wide**: one value for the whole orchestrator.
  You edit them with `kici-admin cluster-settings`.
- **Org settings** are **per-tenant**: a different value per customer/org. You
  edit them with `kici-admin org-settings` (see the
  [`kici-admin` org-settings reference](./kici-admin/org-settings.md)).

Each knob has a built-in default (also overridable at boot with a `KICI_*`
environment variable — see the
[configuration reference](./configuration.md)). Setting a value in the store
overrides that default at runtime; clearing it (`reset`) falls back to the
default.

One group is the exception to "on a live orchestrator": the six cache-sizing
knobs (`--lockfile-cache-*` and `--content-cache-*`) are read once at boot and
[apply at the next orchestrator restart](#cache-knobs-apply-at-the-next-restart).
Every other knob takes effect on the running process.

## Managing cluster settings

```bash
# Show every fleet-wide tunable (a null value means "use the built-in default").
kici-admin cluster-settings show

# Set one or more knobs.
kici-admin cluster-settings set --queue-max-depth 500 --webhook-dedup-ttl-ms 3600000

# Clear a single override (back to the default), or all of them.
kici-admin cluster-settings reset --queue-max-depth
kici-admin cluster-settings reset
```

Changes take effect within a short cache window (the orchestrator re-reads the
row roughly every 10 seconds; tune with `KICI_CLUSTER_SETTINGS_CACHE_TTL_MS`) —
except for the six cache-sizing knobs, which
[apply at the next orchestrator restart](#cache-knobs-apply-at-the-next-restart).
If the database is briefly unreachable, the orchestrator keeps using the
built-in defaults rather than blocking, so a settings read never stalls a hot
path.

## Available cluster-wide tunables

| Knob (`--flag`)                                     | Default | Unit         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-github-payload-bytes`                        | 25 MB   | bytes        | Maximum body size accepted on the direct GitHub webhook ingress; larger deliveries are rejected with `413`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--event-log-max-payload-bytes`                     | 5 MB    | bytes        | Soft cap for storing an inbound webhook delivery payload; larger payloads are recorded as metadata only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--lock-file-max-bytes`                             | 5 MB    | bytes        | Maximum size of a fetched `.kici/kici.lock.json` before the fetch is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--webhook-dedup-ttl-ms`                            | 24 h    | milliseconds | How long a processed webhook delivery id is remembered for duplicate suppression.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--contributor-cache-ttl-ms`                        | 15 min  | milliseconds | How long a resolved contributor-permission lookup is cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--event-router-event-ttl-seconds`                  | 7 days  | seconds      | Retention window for an internal routed event before it expires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--event-router-max-dispatch-attempts`              | 5       | count        | How many delivery attempts an internal event gets before moving to the dead-letter queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--queue-max-depth`                                 | 1000    | count        | Maximum number of pending jobs in the dispatch queue before new enqueues are rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--reroute-flap-grace-ms`                           | 2 min   | milliseconds | Grace window a job rerouted to a worker stays deferred from the recovery sweepers while that worker's connection briefly flaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--max-fanout-hosts`                                | 1024    | count        | Cap on the per-host children a `runsOnAll` job fans out to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--event-router-rate-limit-per-workflow-per-minute` | 100     | count        | Per-(source routing key + event) sliding-window rate limit for internal event routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--cache-max-tarball-bytes`                         | 500 MB  | bytes        | Maximum dependency-cache tarball size accepted on store; a larger tarball is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--cache-ttl-days`                                  | 30      | days         | Dependency-cache entry TTL; an entry unread for longer is treated as expired on its next lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--check-run-tracking-ttl-days`                     | 7       | days         | Retention window for check-run tracking rows. The hourly cleanup sweep deletes rows untouched for longer than this; `0` disables the sweep. Rows outlive their run on purpose, so a check-run status update arriving after the run is pruned can still resolve which check run to update. Keep it above your longest approval window — see the note below.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--concurrency-wait-timeout-ms`                     | 1 h     | milliseconds | How long an agent waits for a busy concurrency slot to free before abandoning the wait. Pushed to the agent on each job dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--agent-token-ttl-ms`                              | 1 h     | milliseconds | Lifetime of the ephemeral agent token minted when the orchestrator spawns an agent. Honored on both tiers: the leader resolves it live at spawn, and DB-less workers pull the value from the leader over the peer channel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--ownership-db-check-timeout-ms`                   | 5 s     | milliseconds | Deadline for one database lookup resolving whether an agent owns the job named in the message it just sent. Past the deadline the lookup is undecided: the message is refused, but no ownership violation is counted against the agent, so a slow database cannot disconnect the fleet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--dashboard-verified-issuer`                       | unset   | http(s) URL  | Origin the web UI fetches your orchestrator's encryption key from directly for [encrypted dashboard writes](../security/encrypted-dashboard-writes.md). When it is unset, the Verified tier is not offered. Setting a build-attestation issuer (`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`) does not enable the tier, and the tier does not require one — the encryption key is published either way. `set` probes the origin's JWKS afterwards and warns (without failing) when no encryption key is published there.                                                                                                                                                                                                                                                                                              |
| `--unroutable-grace-ms`                             | 2 min   | milliseconds | How long a job whose `runsOn` matches nothing in the fleet may keep waiting before it is failed as `unroutable`. The reason appears on the queued job immediately; only a job that stays unmatched for this whole window is failed, so a scaler reload or an agent reconnect costs it nothing. `0` disables fast-fail, leaving the queue timeout as the only backstop — see below.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--ingest-overflow-claim-timeout-ms`                | 15 min  | milliseconds | How long a claim on a queued webhook delivery may stand before the drain pass reclaims it and retries the delivery. Covers a worker killed mid-pipeline, which releases nothing on its way out. Must stay comfortably above the longest a single delivery's pipeline can legitimately run — a build phase alone is capped at `KICI_CACHE_BUILD_TIMEOUT_MS` — or a reclaim would re-run work still in flight. Floor: 60 s.                                                                                                                                                                                                                                                                                                                                                                                      |
| `--lockfile-cache-max`                              | 500     | count        | Maximum number of lock files held in the lock-file cache. **Applies at the next orchestrator restart** — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--lockfile-cache-max-bytes`                        | 64 MiB  | bytes        | Total byte ceiling for the lock-file cache; the oldest entries are evicted once it is reached. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--lockfile-cache-ttl-ms`                           | 1 h     | milliseconds | How long a cached lock file stays valid before it is re-fetched. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--content-cache-max`                               | 500     | count        | Maximum number of source files held in the content cache, which serves the `requires` content filter before dispatch. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--content-cache-max-bytes`                         | 64 MiB  | bytes        | Total byte ceiling for the content cache. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--content-cache-ttl-ms`                            | 1 h     | milliseconds | How long a cached source file stays valid before it is re-fetched. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--global-eval-round-timeout-ms`                    | 2 min   | milliseconds | Wall-clock budget for one global eval round — the pre-run job that decides which organization-wide workflows apply to a push and generates their jobs. Read fresh on every round, so a change lands on the next push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--global-eval-candidate-timeout-ms`                | 20 s    | milliseconds | Wall-clock budget for one workflow inside a round (its filter plus its job generators). A workflow that blows it is reported as undecided; its siblings in the same round still get real verdicts. Keep it **below** `--global-eval-round-timeout-ms` — a per-workflow budget that can consume the whole round leaves every sibling in that round undecided. Values from half the round budget upward are lowered to half, with an error logged. Read fresh on every round.                                                                                                                                                                                                                                                                                                                                    |
| `--global-eval-cache-max`                           | 500     | count        | Maximum number of round results held for repeated deliveries of the same commit. Every real push carries a new commit, so this only serves webhook redelivery. **Applies at the next orchestrator restart.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--global-eval-wait-timeout-ms`                     | 4 min   | milliseconds | How long the orchestrator itself waits for a round to finish. The two budgets above are enforced by the agent and only start once the round job is running, so neither covers a round that is still waiting for a free agent, or an agent that stops responding. When this ceiling is reached the round's workflows are recorded as undecided, none of them run, and the delivery is still logged. Keep it at least 25% above `--global-eval-round-timeout-ms`, so it covers the budget plus the time the job spent queued; a thinner pairing is raised to twice the round budget, with an error logged. A round budget past 4 min leaves no room under the relay's 5-min window, so the ceiling is left as configured and every round fails fast — lower the round budget instead. Read fresh on every round. |

### Cache knobs apply at the next restart

The six `--lockfile-cache-*` / `--content-cache-*` knobs, plus
`--global-eval-cache-max`, are the one group that does **not** take effect
within the usual cache window. All three caches are fixed-capacity LRUs built
once while the orchestrator boots, so their entry count, byte ceiling, and TTL
are structural: the orchestrator reads the stored values at startup and each
cache keeps those bounds for its whole lifetime.

The two `--global-eval-*-timeout-ms` budgets are **not** in this group. They are
read fresh on every round and travel to the agent with the round job, so raising
one takes effect on the next push with no restart.

Set them like any other knob, then **restart the orchestrator** for the change
to land. `kici-admin cluster-settings show` reports the stored value
immediately, which is the value the next boot will pick up — not necessarily
the one the running process is using.

The three entry-count knobs (`--lockfile-cache-max`, `--content-cache-max`,
`--global-eval-cache-max`) are
capped at **100,000** for the same structural reason: each cache reserves its
index storage up front from that number, so an extreme value would exhaust
memory while the orchestrator is still starting. A value above the cap is
rejected when you set it, and a stored value above it is reduced to the cap at
boot rather than being allowed to prevent startup. The cap is 200x the default
of 500, so a realistic setting never reaches it.

### Jobs nothing in the fleet can run

When a job's `runsOn` matches no connected agent **and** no scaler backend that
could spawn one, nothing will ever pick it up. Rather than let it sit until the
queue timeout, the orchestrator checks pending jobs on a short interval and:

1. records the reason on the job straight away — visible on the run in the web
   UI, in `kici runs show`, and in `kici-admin runs show`, naming the exact
   selectors that went unmatched; then
2. fails the job as `unroutable` once it has stayed unmatched for the whole
   `--unroutable-grace-ms` window.

The two halves are deliberate. A pool scaled to zero has no agent connected but
can still spawn one, so it is never treated as unroutable; and a job that
becomes routable inside the window — an operator adds the missing pool, an agent
reconnects — has its reason cleared and its clock reset. Only a _continuously_
unmatched job is failed.

A job whose scaler tried to start an agent and failed is **not** unroutable:
its labels did route, so it keeps the provisioning error as its cause and the
queue timeout as its deadline.

Setting `--unroutable-grace-ms` takes effect within the usual cache window in
both directions, including turning fast-fail back on for an orchestrator that
started with it disabled. The _check interval_ is derived once at startup, so a
cluster that starts disabled checks on the interval of the shipped default
(2 minutes) once you enable it — the grace you set is still honoured, it is just
measured on that cadence. Restart the orchestrator if you want the interval to
track a much smaller grace.

**Known limitation:** a `runsOn` written purely as patterns, with no exact
labels, is always treated as routable when a scaler is configured, because
scaler label sets are matched exactly. Such a job is never failed early — it
falls back to the queue timeout. This errs toward waiting, never toward failing
a job that would have run.

### Check-run tracking retention and long approval holds

The check-run tracking sweep measures age from the last **check-run** write, not
from whether the run is still going. A run parked on a manual approval gate
posts its hold status through a different path that does not touch these rows,
so a hold that lasts longer than the retention window ages the run's rows out
while the run is still live. If that happens and the orchestrator restarts
before the approval lands, the terminal check-run update can no longer resolve
which check run to update, and the check stays unresolved on the commit.

The defaults do not collide — job approvals expire after 1 day and security
holds after 3, against a 7-day retention window — but all of them are
independently configurable and nothing cross-validates them. **If you raise an
approval expiry, raise `--check-run-tracking-ttl-days` past it.**

## Per-tenant tunables (org settings)

Some tunables are genuinely per-customer and live in org settings instead — most
notably the dispatch-queue **job timeout**, which a queued job resolves from its
own org:

```bash
kici-admin org-settings queue-timeout set --timeout 120000 --org <orgId>
kici-admin org-settings queue-timeout reset --org <orgId>
```

The full per-org surface (cache quotas, dispatch-ack timeout, reroute tunables,
approval policy, and more) is documented in the
[`kici-admin` org-settings reference](./kici-admin/org-settings.md).
