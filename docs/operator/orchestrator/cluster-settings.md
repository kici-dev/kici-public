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
row roughly every 10 seconds; tune with `KICI_CLUSTER_SETTINGS_CACHE_TTL_MS`).
If the database is briefly unreachable, the orchestrator keeps using the
built-in defaults rather than blocking, so a settings read never stalls a hot
path.

## Available cluster-wide tunables

| Knob (`--flag`)                                     | Default | Unit         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-github-payload-bytes`                        | 25 MB   | bytes        | Maximum body size accepted on the direct GitHub webhook ingress; larger deliveries are rejected with `413`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--event-log-max-payload-bytes`                     | 5 MB    | bytes        | Soft cap for storing an inbound webhook delivery payload; larger payloads are recorded as metadata only.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--lock-file-max-bytes`                             | 5 MB    | bytes        | Maximum size of a fetched `.kici/kici.lock.json` before the fetch is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--webhook-dedup-ttl-ms`                            | 24 h    | milliseconds | How long a processed webhook delivery id is remembered for duplicate suppression.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--contributor-cache-ttl-ms`                        | 15 min  | milliseconds | How long a resolved contributor-permission lookup is cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--event-router-event-ttl-seconds`                  | 7 days  | seconds      | Retention window for an internal routed event before it expires.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--event-router-max-dispatch-attempts`              | 5       | count        | How many delivery attempts an internal event gets before moving to the dead-letter queue.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--queue-max-depth`                                 | 1000    | count        | Maximum number of pending jobs in the dispatch queue before new enqueues are rejected.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--reroute-flap-grace-ms`                           | 2 min   | milliseconds | Grace window a job rerouted to a worker stays deferred from the recovery sweepers while that worker's connection briefly flaps.                                                                                                                                                                                                                                                                                                                                                                                   |
| `--max-fanout-hosts`                                | 1024    | count        | Cap on the per-host children a `runsOnAll` job fans out to.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--event-router-rate-limit-per-workflow-per-minute` | 100     | count        | Per-(source routing key + event) sliding-window rate limit for internal event routing.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--cache-max-tarball-bytes`                         | 500 MB  | bytes        | Maximum dependency-cache tarball size accepted on store; a larger tarball is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--cache-ttl-days`                                  | 30      | days         | Dependency-cache entry TTL; an entry unread for longer is treated as expired on its next lookup.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--check-run-tracking-ttl-days`                     | 7       | days         | Retention window for check-run tracking rows. The hourly cleanup sweep deletes rows untouched for longer than this; `0` disables the sweep. Rows outlive their run on purpose, so a check-run status update arriving after the run is pruned can still resolve which check run to update. Keep it above your longest approval window — see the note below.                                                                                                                                                        |
| `--concurrency-wait-timeout-ms`                     | 1 h     | milliseconds | How long an agent waits for a busy concurrency slot to free before abandoning the wait. Pushed to the agent on each job dispatch.                                                                                                                                                                                                                                                                                                                                                                                 |
| `--agent-token-ttl-ms`                              | 1 h     | milliseconds | Lifetime of the ephemeral agent token minted when the orchestrator spawns an agent. Honored on both tiers: the leader resolves it live at spawn, and DB-less workers pull the value from the leader over the peer channel.                                                                                                                                                                                                                                                                                        |
| `--ownership-db-check-timeout-ms`                   | 5 s     | milliseconds | Deadline for one database lookup resolving whether an agent owns the job named in the message it just sent. Past the deadline the lookup is undecided: the message is refused, but no ownership violation is counted against the agent, so a slow database cannot disconnect the fleet.                                                                                                                                                                                                                           |
| `--dashboard-verified-issuer`                       | unset   | http(s) URL  | Origin the web UI fetches your orchestrator's encryption key from directly for [encrypted dashboard writes](../security/encrypted-dashboard-writes.md). When it is unset, the Verified tier is not offered. Setting a build-attestation issuer (`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`) does not enable the tier, and the tier does not require one — the encryption key is published either way. `set` probes the origin's JWKS afterwards and warns (without failing) when no encryption key is published there. |

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
