---
title: 'kici-admin: org settings'
description: 'Org-level security policy: npm, cache, dispatch, approval, CI trust, and dashboard-write policy'
---

## Guide

### org-settings -- org-level security policy

```bash
kici-admin org-settings global-workflows show --customer-id <id> [--format json|table]
kici-admin org-settings global-workflows allow-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows allow-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows deny-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows deny-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows elevate-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows elevate-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings allow-http-npm true|false --customer-id <id> [--format json|table]
kici-admin org-settings user-cache show --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-quota <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-ttl <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack show --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack reset --customer-id <id> [--format json|table]
kici-admin org-settings approval show --customer-id <id> [--format json|table]
kici-admin org-settings approval set-expiry <seconds> --customer-id <id> [--format json|table]
kici-admin org-settings approval set-self-approval true|false --customer-id <id> [--format json|table]
```

Manages per-org global-workflow policy (workflow-author allow-list, source-repo deny-list, and the deprecated elevated-access list). Settings are org-scoped — there is one row per `customer_id` regardless of how many webhook sources the org has. Each list entry can optionally pin to a specific source via `--source <routingKey>`. Calls the orchestrator admin API directly (not the Platform dashboard proxy) so it stays operable even when Platform is unavailable.

- `--customer-id <id>` (alias: `--org <id>`) selects the org row.
- `--source <routingKey>` on `*-add` stores the entry pinned to that single webhook source. Omit for "any source in the org".
- `--source <routingKey>` on `*-remove` matches a source-qualified entry. Omit to remove the unqualified entry.
- `show` prints the current settings row for the given org. Its `Enabled (cluster-wide)` line is informational — it reports the effective fleet-wide master switch (`cluster_settings.global_workflows_enabled`), which you set with [`kici-admin cluster-settings`](./cluster-and-infra.md), not a per-org value.
- `allow-add` / `allow-remove` mutate the workflow-author allow-list.
- `deny-add` / `deny-remove` mutate the source-repo deny-list.
- `elevate-add` / `elevate-remove` mutate the elevated-access list. **Deprecated and not enforced:** an organization-wide workflow's job is dispatched with no secret material, so the list grants nothing. Removed at v1.0.0.

##### Accepted pattern shape

A `<pattern>` is a plain glob over a repository identifier (`owner/name`). An identifier is not a file path, so a leading dot carries no special meaning: `myorg/*` and `**` both cover `myorg/.github`.

Negation forms are refused. Each of these is rejected at write time, on all three lists:

- a leading `!` — `!myorg/x`
- extglob negation — `!(a|b)/x` and `myorg/!(secret)`
- character-class negation — `myorg/[^a]*`
- a negative lookahead or lookbehind — `(?!myorg/legacy)**`, `myorg/(?!secret)*`, `**(?<!secret)`
- an empty or whitespace-only pattern

The list you add to already decides the direction: `allow-add` grants, `deny-add` blocks. A negated pattern inverts that direction inside one entry. On the allow-list it grants almost every repository; on the deny-list it blocks almost every repository. Either way the entry does the opposite of what it reads as. The assertions are the widest of the four forms. One can spell a whole repository identifier rather than a single character, so `(?!myorg/legacy)**` on the allow-list reads as "all but legacy" and allows **every repository in every organization** except that one.

`myorg/[!a]*` is **not** a negation and is accepted. The matcher reads `[!a]` as a literal class holding the two characters `!` and `a`, so the pattern matches only the repositories whose name begins with one of them — a genuine restriction, and the exact inverse of `myorg/[^a]*`.

A pattern of one of these shapes that is already stored is not applied as a negation. The allow-list and elevated-access list grant nothing for it, the deny-list blocks, and the orchestrator logs a warning naming the org and the pattern. Remove such an entry with `allow-remove` / `deny-remove` / `elevate-remove` and write the repositories you mean.

#### `allow-http-npm` — permit non-https private npm registries

```bash
kici-admin org-settings allow-http-npm true --customer-id <id>
kici-admin org-settings allow-http-npm false --customer-id <id>
```

Toggles `org_settings.allow_http_npm_registries`. When `false` (the default), any workflow `registries:` entry whose URL is `http://<non-loopback-host>` is rejected at dispatch time. Loopback (`localhost` / `127.0.0.0/8` / `::1`) and `*.local` hostnames are **always** allowed regardless of this toggle, so a developer iterating against a local Verdaccio container does not need to flip it.

Flip to `true` only when the org genuinely needs auth against a non-loopback `http://` registry — most commonly an internal mirror reachable only inside a VPN where TLS termination happens at the network boundary. Flipping it widens the trust surface: an attacker on the network path between the agent and the registry can observe (and tamper with) both the install request and the auth header, since `http://` carries no integrity protection. Prefer terminating TLS at the registry instead.

The toggle has no effect on the `installEnv:` channel (Option C) — committed `.kici/.npmrc` files are not URL-validated at the orchestrator. If you commit an `http://` registry line in your `.npmrc`, that's between you and npm.

See [Private npm registries](../../../user/private-registries.md) for the workflow-side configuration.

#### `user-cache` — per-org cache quota + entry TTL

```bash
kici-admin org-settings user-cache show --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-quota <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-ttl <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache reset-quota --customer-id <id> [--format json|table]
kici-admin org-settings user-cache reset-ttl --customer-id <id> [--format json|table]
```

Reads and writes the per-org byte quota and per-entry TTL for the user-facing cache (`ctx.cache` / the declarative job-step `cache:`). These map to the NULLABLE columns `org_settings.user_cache_quota_bytes` and `org_settings.user_cache_ttl_ms`. When a column is NULL (the default), the orchestrator uses the cluster-wide default from `KICI_USER_CACHE_QUOTA_BYTES` (5 GiB) / `KICI_USER_CACHE_TTL_MS` (7 days); a positive-integer override takes precedence at cache-operation time.

- `show` prints the effective settings — a per-org override or `(cluster default)` when unset.
- `set-quota <bytes>` / `set-ttl <milliseconds>` set a per-org override (must be a positive integer).
- `reset-quota` / `reset-ttl` clear the override (write NULL) so the org falls back to the cluster default.

This is the cluster-configurable knob for "this one tenant needs a bigger cache budget / longer retention" without editing the orchestrator unit file or redeploying. See [Storage layout: user cache](../storage-layout.md#user-cache) for the eviction + TTL mechanics.

#### `artifacts` — per-org artifact quota, TTL, and size caps

```bash
kici-admin org-settings artifacts show --customer-id <id> [--format json|table]
kici-admin org-settings artifacts set-quota <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings artifacts set-ttl <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings artifacts set-max-bytes <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings artifacts set-max-per-run <count> --customer-id <id> [--format json|table]
kici-admin org-settings artifacts reset-quota --customer-id <id> [--format json|table]
kici-admin org-settings artifacts reset-ttl --customer-id <id> [--format json|table]
kici-admin org-settings artifacts reset-max-bytes --customer-id <id> [--format json|table]
kici-admin org-settings artifacts reset-max-per-run --customer-id <id> [--format json|table]
```

The four budget knobs for user-facing artifacts (`ctx.artifacts.upload` / `download`). Each maps to a NULLABLE `org_settings` column; NULL means the cluster-wide default applies.

| Knob          | Column                 | Cluster default (env var)                      |
| ------------- | ---------------------- | ---------------------------------------------- |
| `quota`       | `artifact_quota_bytes` | 20 GiB (`KICI_ARTIFACT_QUOTA_BYTES`)           |
| `ttl`         | `artifact_ttl_ms`      | 30 days (`KICI_ARTIFACT_TTL_MS`)               |
| `max-bytes`   | `artifact_max_bytes`   | 1 GiB per artifact (`KICI_ARTIFACT_MAX_BYTES`) |
| `max-per-run` | `artifact_max_per_run` | 50 artifacts (`KICI_ARTIFACT_MAX_PER_RUN`)     |

- `show` prints the effective settings — a per-org override or the cluster default when unset.
- Every `set-*` value must be a positive integer; `reset-*` writes NULL so the org falls back to the cluster default.

#### `backup-freshness` — per-org backup staleness WARN threshold

```bash
kici-admin org-settings backup-freshness show --customer-id <id> [--format json|table]
kici-admin org-settings backup-freshness set --hours <n> --customer-id <id> [--format json|table]
kici-admin org-settings backup-freshness reset --customer-id <id> [--format json|table]
```

How old the newest `backup_runs` row may get before the `diagnose` backup check reports WARN. Maps to `org_settings.backup_staleness_warn_hours`; NULL means the cluster default from `KICI_BACKUP_STALENESS_WARN_HOURS` (24 hours) applies.

- `set --hours <n>` takes an integer of at least 1. Raise it for an org backed up weekly; lower it for one where a missed nightly dump matters within hours.
- `reset` clears the override.

#### `ingest-concurrency` — per-org webhook ingest cap

```bash
kici-admin org-settings ingest-concurrency show --customer-id <id> [--format json|table]
kici-admin org-settings ingest-concurrency set <count> --customer-id <id> [--format json|table]
kici-admin org-settings ingest-concurrency reset --customer-id <id> [--format json|table]
```

The maximum number of concurrent webhook-processing pipelines the admission controller admits for this org before shedding with `429` + `Retry-After`. Maps to a NULLABLE `org_settings` column; NULL means the cluster default from `KICI_INGEST_ORG_MAX_CONCURRENCY` (32) applies.

Lower it to rein in a noisy tenant that is crowding out the rest of the cluster; raise it for a high-fan-in org whose bursts are legitimate. `set` takes an integer of at least 1.

#### `queue-timeout` — per-org dispatch-queue job timeout

```bash
kici-admin org-settings queue-timeout show --customer-id <id> [--format json|table]
kici-admin org-settings queue-timeout set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings queue-timeout reset --customer-id <id> [--format json|table]
```

How long a job may sit queued before it expires. The deadline resolves as `job.timeoutMs` → this org override → the cluster default from `KICI_QUEUE_TIMEOUT_MS` (1 hour), so a workflow that sets its own job timeout always wins.

- `set <milliseconds>` takes an integer of at least 0; **`set 0` means indefinite** (a queued job never expires).
- `reset` clears the override (writes NULL) so the org falls back to the cluster default.

#### `reroute` — per-org cross-peer reroute tunables

```bash
kici-admin org-settings reroute show --customer-id <id> [--format json|table]
kici-admin org-settings reroute set --customer-id <id> [--window <ms>] [--ack-timeout <ms>] [--max-hops <n>] [--format json|table]
kici-admin org-settings reroute reset --customer-id <id> [--format json|table]
```

The three knobs governing how a coordinator hands a job to a sibling peer that can actually run it. Each maps to a NULLABLE `org_settings` column; NULL means the cluster default applies.

| Flag            | Column                    | Cluster default (env var)             |
| --------------- | ------------------------- | ------------------------------------- |
| `--window`      | `reroute_spawn_window_ms` | 90 s (`KICI_REROUTE_SPAWN_WINDOW_MS`) |
| `--ack-timeout` | `reroute_ack_timeout_ms`  | 15 s (`KICI_REROUTE_ACK_TIMEOUT_MS`)  |
| `--max-hops`    | `reroute_max_hops`        | 3 hops (`KICI_REROUTE_MAX_HOPS`)      |

- `set` requires at least one of the three flags and accepts several at once. `--window` / `--ack-timeout` take integer milliseconds of at least 1000; `--max-hops` takes an integer of at least 1 and exists for loop prevention.
- `reset` clears **all three** overrides at once.

See [Multi-orchestrator clustering](../../../architecture/clustering/multi-orchestrator.md) for the reroute protocol itself.

#### `sandbox-allowlist` — container-sandbox escape hatches

```bash
kici-admin org-settings sandbox-allowlist show --customer-id <id> [--format json|table]
kici-admin org-settings sandbox-allowlist set-capabilities <capabilities> --customer-id <id> [--format json|table]
kici-admin org-settings sandbox-allowlist allow-host-network true|false --customer-id <id> [--format json|table]
kici-admin org-settings sandbox-allowlist reset --customer-id <id> [--format json|table]
```

Gates the two escape hatches a container job (one with a `container:` image) can request through the SDK `sandbox:` field. **The default is deny-all** — an empty capability list and host networking off — and a non-allow-listed request **fails the run at dispatch**, naming the offending capability or knob, rather than being silently downgraded.

- `set-capabilities <capabilities>` replaces the allowed Linux capability list with a comma-separated set (e.g. `NET_ADMIN,SYS_PTRACE`). Passing an empty value clears the list back to deny-all.
- `allow-host-network true|false` toggles whether a workflow may request `sandbox: { network: 'host' }`.
- `reset` clears both at once — no capabilities, no host networking.

Every entry here widens the isolation boundary for the whole org, so grant the narrowest set that unblocks the workflow. See [Execution isolation](../../../architecture/execution/execution-isolation.md) for what the sandbox otherwise enforces.

#### `scaler-spawn-timeout` — per-org scaler spawn deadline

```bash
kici-admin org-settings scaler-spawn-timeout show --customer-id <id> [--format json|table]
kici-admin org-settings scaler-spawn-timeout set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings scaler-spawn-timeout reset --customer-id <id> [--format json|table]
```

The deadline for a single scaler spawn — image pull plus container create plus start. A hung runtime or registry that blows the deadline is aborted, so it can no longer pin its per-backend spawn-semaphore slot and head-of-line block every other queued spawn.

Maps to a NULLABLE `org_settings` column; NULL means the cluster default from `KICI_SCALER_SPAWN_TIMEOUT_MS` (300 s) applies. `set` takes an integer of at least 1000 milliseconds. Raise it for an org pulling very large images over a slow link; lower it to fail over faster when the registry is flaky.

#### `dispatch-ack` — per-org dispatch acknowledgment deadline

```bash
kici-admin org-settings dispatch-ack show --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack reset --customer-id <id> [--format json|table]
```

Reads and writes the per-org dispatch-acknowledgment deadline: how long the orchestrator waits for the agent to answer a dispatched job (with an accept acknowledgment, a refusal, or a `running` status) before treating the dispatch as lost. On expiry the orchestrator requeues the job and disconnects the unresponsive agent, so a dispatch dropped in an agent's socket teardown no longer strands the run until a timeout.

The value maps to the NULLABLE column `org_settings.dispatch_ack_timeout_ms`. When NULL (the default), the orchestrator uses the cluster-wide default from `KICI_DISPATCH_ACK_TIMEOUT_MS` (10 seconds); a per-org override of at least 1000 ms takes precedence at dispatch time.

- `show` prints the effective deadline — a per-org override or `(cluster default)` when unset.
- `set <milliseconds>` sets a per-org override (integer, minimum 1000).
- `reset` clears the override (writes NULL) so the org falls back to the cluster default.

Raise it for an org whose agents sit behind a high-latency network where the 10-second default is too tight; lower it to reclaim a stuck job faster when agents are local and fast.

#### `approval` — held-approval expiry and self-approval policy

```bash
kici-admin org-settings approval show --customer-id <id> [--format json|table]
kici-admin org-settings approval set-expiry <seconds> --customer-id <id> [--format json|table]
kici-admin org-settings approval set-self-approval true|false --customer-id <id> [--format json|table]
```

Controls how held approval elements (workflow / job / step gates) behave for the org. Both settings have non-null defaults, so there is no "reset to cluster default" — a `set` replaces the current value.

- `set-expiry <seconds>` writes `org_settings.approval_expiry_seconds` (integer, minimum 1; default 86400 — one day). A held element that is not fully approved within this window expires and its run/job/step is rejected. A workflow's own `approval` `timeout` overrides this per element.
- `set-self-approval true|false` writes `org_settings.allow_self_approval` (default `true`). When `false`, the user who triggered a run may not approve its own held elements, enforcing four-eyes review.
- `show` prints the effective expiry (seconds) and self-approval flag.

#### `dashboard-writes` — dashboard write policy matrix

```bash
kici-admin org-settings dashboard-writes show --customer-id <id> [--category <name>] [--sensitivity <name>] [--format json|table]
kici-admin org-settings dashboard-writes set --customer-id <id> --op <name>=<true|false> [--op ...] [--category <name>] [--sensitivity <name>] [--enabled true|false] [--format json|table]
kici-admin org-settings dashboard-writes reset --customer-id <id> [--format json|table]
```

Manages the per-orch dashboard write policy — the matrix of `dashboard.*` write operations the orchestrator will accept when proxied through Platform. Empty policy = all operations enabled (permissive default).

- `show` prints the current policy. Filter to one category (`Secrets`, `Variables`, `Environments`, `Bindings`, `Held runs`, `DLQ`, `Registrations`, `Topology`) or one sensitivity bucket (`plaintext`, `authority`, `dispatch`).
- `set` flips one or more operations. Pass `--op <name>=<bool>` (repeatable) for individual operations, or combine `--category` / `--sensitivity` with `--enabled <bool>` to flip every operation in the matching group at once. The CLI prints the planned change before applying.
- `reset` returns every operation to the permissive default.
- `--customer-id <id>` (alias `--org`) selects the org row.

### trust-policy -- CI trust policy for fork pull requests

```bash
kici-admin trust-policy show --customer-id <id> [--format json|table]
kici-admin trust-policy directory --customer-id <id> [--format json|table]
kici-admin trust-policy set --customer-id <id> [--fork-policy ignore|hold|allow] [--approval-expiry-hours <n>] [--approval-expiry-seconds <n>] [--format json|table]
kici-admin trust-policy directory-set --customer-id <id> --user-id <id> --provider-username <name> --provider-user-id <id> --ci-trust none|read|write|admin [--provider <name>] [--format json|table]
kici-admin trust-policy directory-remove --customer-id <id> --user-id <id> [--format json|table]
```

The org-wide switch deciding what happens to a pull request from a fork. `--fork-policy` takes one of three values:

- `ignore` — the orchestrator drops the event. It creates no run and posts no check status. This is what an org with no stored policy applies.
- `hold` — the run parks behind a security approval.
- `allow` — the pull request runs, with reduced privilege.

`--approval-expiry-hours` and `--approval-expiry-seconds` set how long a security hold waits for an approval before it expires. They are two spellings of one window. Hours is the ergonomic form (integer, at least 1). Seconds is the only form that can express a window shorter than an hour (integer, at least 1, up to one year). Setting either recomputes the other, so they cannot disagree. Pass both and the seconds value wins, because it is the more specific. The CLI then prints a warning naming the value it ignored.

`show` prints a whole-hour window as hours (`72 h`) and anything finer as seconds (`30 s`).

Three inputs are deprecated and are removed at v1.0.0. `--fork-policy reject` behaves as `ignore`; the CLI stores the value as given and prints a warning. `--unknown-contributor-policy` and `--workflow-change-policy` are still accepted, stored, and echoed back, but no dispatch decision reads them, so setting one changes no outcome. The `show` table omits those two values for that reason; `--format json` still prints them.

`directory` prints the stored approval directory — the identity links, member CI trust levels, and teams that `/kici approve` is resolved against. Use it to tell a stale directory from an absent one when an approval comment is refused.

#### Registering approvers on an independent orchestrator

Where a Platform is attached it owns the directory: it pushes the whole thing on every membership change, so link provider accounts and set CI trust levels in the dashboard. An **independent** orchestrator has no Platform and therefore no upstream authority, so the operator registers approvers directly:

```bash
kici-admin trust-policy directory-set \
  --customer-id acme \
  --user-id alice \
  --provider-username alice \
  --provider-user-id 4242 \
  --ci-trust write
```

- `--user-id` is the KiCI user id the approval is attributed to. It is yours to choose on an independent orchestrator — it appears in the access log and on the security check, and it is the id `--ci-trust` is recorded against.
- `--provider-user-id` is the immutable provider-side numeric id (GitHub's `sender.id`). It is **required**, because an approval comment is matched on this alone and never on the username — so renaming a provider account cannot be used to impersonate a registered member. A link with no numeric id could authorize nobody, so the CLI refuses to create one.
- `--provider-username` is display only.
- `--provider` defaults to `github`.
- `--ci-trust` grants the level: `write` or `admin` may release a security hold, `read` and `none` may not.

Re-running `directory-set` for the same `--user-id` replaces that member's link rather than adding a second one, so moving someone to a new provider account also retires their old numeric id. `directory-remove --user-id <id>` revokes a member: every identity link they hold plus their CI trust level. Both verbs leave team memberships untouched.

`set`, `directory-set`, and `directory-remove` work on an **independent** orchestrator only. Wherever a Platform is attached, the Platform owns the trust policy and the approval directory, and the admin route refuses with `409`; the CLI surfaces that message verbatim, so manage both from the dashboard instead. Every verb talks to the orchestrator admin API directly rather than the Platform dashboard proxy, so `show` and `directory` keep working when Platform is unavailable. They require the `ci_trust.read` / `ci_trust.admin` permissions — owner and admin only, never auditor, which sees trust-policy changes through `access_log.read` instead.

See [CI security](../../../architecture/security/ci-security.md) for the threat model behind these knobs.

### held-run -- answer a hold locally

`kici-admin held-run` lists and answers the runs this orchestrator is holding. It is the release surface for an **independent** orchestrator, which has no dashboard approval queue to click and cannot be reached by `kici approve` or the MCP tools — all three go through the Platform.

```bash
# What is this run waiting for, and who may answer it?
kici-admin held-run list --customer-id org-1 --run-id run-abc

# Let it run.
kici-admin held-run approve --customer-id org-1 --run-id run-abc

# Or cancel it.
kici-admin held-run reject --customer-id org-1 --run-id run-abc --reason "wrong branch"
```

`list` prints one entry per pending hold: its id, the element it holds, its type and queue, when it expires, and the approvers its requirement names. Read the approver line first — a hold naming a specific user or team is only answerable by a token that requirement accepts.

A run can carry more than one hold, and each takes its own decision: a job gated by both a reviewer requirement and a security policy writes two rows. `approve` and `reject` take the same four disambiguators `kici approve` takes, and refuse to guess between two candidates:

| Flag                 | Picks                                               |
| -------------------- | --------------------------------------------------- |
| `--job <name>`       | the hold on that job                                |
| `--step <index>`     | a step-scoped hold within `--job`                   |
| `--hold-type <type>` | `reviewer`, `timer`, `concurrency`, or `security`   |
| `--hold <id>`        | one hold by its own id, ignoring every other filter |

Four properties worth knowing:

- **Both verbs refuse with a `409` on a Platform-attached orchestrator.** There the Platform authorizes each decision against the acting member's org RBAC, and an orchestrator admin token carries none of it. The CLI surfaces that refusal verbatim.
- **Approving lets the held work run; it does not make its contributor trusted.** A released fork pull request resumes with the base branch's lock file, no install or registry secrets, and an isolated cache write scope.
- **The decision is attributed to the admin token, not to a person.** There is no flag to claim someone else's identity, because `held_run_approvals` is the record of who approved and a name the operator merely typed would make it false. A `{team}` clause is satisfiable only if that team, in the stored approval directory, contains the token's own subject.
- **Step-scoped holds are refused.** Answering one means notifying the waiting agent, and an independent orchestrator wires no such bridge; flipping the row without it would leave the agent waiting with nothing left to release or expire it.

`list` needs `ci_trust.read`; `approve` and `reject` need `ci_trust.admin` — the same permissions `trust-policy` takes, held by owner and admin only, and by no routing-key-scoped token. Every decision writes a `held_run.approve` or `held_run.reject` row to the access log; read them back with `kici-admin access-log list --action held_run.approve`.

## Reference

<!-- BEGIN GENERATED: kici-admin-org-settings (do not edit; run the doc generator) -->

### `kici-admin held-run`

List and answer the runs this orchestrator is holding (independent orchestrators only — a Platform-attached orchestrator is answered from the dashboard)

Synopsis: `kici-admin held-run`

### `kici-admin held-run approve`

Approve a held run, letting the held work RUN. It does not make the contributor trusted: an untrusted fork PR still resumes with the base-branch lock file, no install or registry secrets, and an isolated cache write scope

Synopsis: `kici-admin held-run approve [options]`

**Options**

| Option               | Default | Description                                                                |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>` |         | Org / customer id                                                          |
| `--run-id <id>`      |         | Run whose hold to approve                                                  |
| `--job <name>`       |         | Match a hold by its job name                                               |
| `--step <index>`     |         | Match a step-scoped hold by its step index                                 |
| `--hold <id>`        |         | Match one hold by its own id (ignores every other filter)                  |
| `--hold-type <type>` |         | Narrow to holds of one type (reviewer \| timer \| concurrency \| security) |

### `kici-admin held-run list`

Print the pending holds for a run, with the approvers each one requires

Synopsis: `kici-admin held-run list [options]`

**Options**

| Option               | Default | Description                |
| -------------------- | ------- | -------------------------- |
| `--customer-id <id>` |         | Org / customer id          |
| `--run-id <id>`      |         | Run whose holds to list    |
| `--format <format>`  | `table` | Output format: json\|table |

### `kici-admin held-run reject`

Reject a held run, cancelling the element it was holding

Synopsis: `kici-admin held-run reject [options]`

**Options**

| Option               | Default | Description                                                                |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>` |         | Org / customer id                                                          |
| `--run-id <id>`      |         | Run whose hold to reject                                                   |
| `--reason <text>`    |         | Why the hold is being rejected                                             |
| `--job <name>`       |         | Match a hold by its job name                                               |
| `--step <index>`     |         | Match a step-scoped hold by its step index                                 |
| `--hold <id>`        |         | Match one hold by its own id (ignores every other filter)                  |
| `--hold-type <type>` |         | Narrow to holds of one type (reviewer \| timer \| concurrency \| security) |

### `kici-admin org-settings`

Manage org-level security settings

Synopsis: `kici-admin org-settings`

### `kici-admin org-settings allow-http-npm`

Permit plain http:// npm registry URLs in workflow registries:. Default false; loopback / *.local are always allowed regardless.

Synopsis: `kici-admin org-settings allow-http-npm <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings allow-untrusted-dockerfile-builds`

Permit an untrusted ref (fork PR) to build a job's container image from a Dockerfile. Default false. The build is NOT sandboxed — it runs arbitrary RUN commands on the agent host's container daemon.

Synopsis: `kici-admin org-settings allow-untrusted-dockerfile-builds <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval`

Manage the per-org held-approval expiry + self-approval policy

Synopsis: `kici-admin org-settings approval`

### `kici-admin org-settings approval set-expiry`

Set the per-org held-approval expiry (integer seconds, >= 1)

Synopsis: `kici-admin org-settings approval set-expiry <seconds> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `seconds` | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval set-self-approval`

Allow or forbid a run triggerer approving its own held elements (true|false)

Synopsis: `kici-admin org-settings approval set-self-approval <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval show`

Print the current per-org approval policy

Synopsis: `kici-admin org-settings approval show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts`

Manage per-org artifact quota / TTL / size cap / per-run cap (null = cluster default)

Synopsis: `kici-admin org-settings artifacts`

### `kici-admin org-settings artifacts reset-max-bytes`

Clear the per-org artifact max-bytes override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-max-bytes [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-max-per-run`

Clear the per-org artifact max-per-run override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-max-per-run [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-quota`

Clear the per-org artifact quota override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-quota [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-ttl`

Clear the per-org artifact ttl override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-ttl [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts set-max-bytes`

Set the per-org artifact max-bytes (positive integer bytes)

Synopsis: `kici-admin org-settings artifacts set-max-bytes <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts set-max-per-run`

Set the per-org artifact max-per-run (positive integer artifacts)

Synopsis: `kici-admin org-settings artifacts set-max-per-run <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts set-quota`

Set the per-org artifact quota (positive integer bytes)

Synopsis: `kici-admin org-settings artifacts set-quota <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts set-ttl`

Set the per-org artifact ttl (positive integer milliseconds)

Synopsis: `kici-admin org-settings artifacts set-ttl <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts show`

Print the current per-org artifact quota + TTL settings

Synopsis: `kici-admin org-settings artifacts show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings backup-freshness`

Manage the per-org DB-backup freshness WARN threshold (null = cluster default)

Synopsis: `kici-admin org-settings backup-freshness`

### `kici-admin org-settings backup-freshness reset`

Clear the per-org override (fall back to the cluster default)

Synopsis: `kici-admin org-settings backup-freshness reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings backup-freshness set`

Set the per-org backup-freshness WARN threshold in hours (>= 1)

Synopsis: `kici-admin org-settings backup-freshness set [options]`

**Options**

| Option               | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `--hours <n>`        |         | Threshold in hours (integer >= 1) |
| `--customer-id <id>` |         | Customer / org id (alias: --org)  |
| `--org <id>`         |         | Alias for --customer-id           |
| `--format <format>`  | `table` | Output format: json\|table        |

### `kici-admin org-settings backup-freshness show`

Print the current per-org backup-freshness threshold

Synopsis: `kici-admin org-settings backup-freshness show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dashboard-writes`

Manage per-orch dashboard write policy (which Platform-routed dashboard.* writes the orch accepts)

Synopsis: `kici-admin org-settings dashboard-writes`

### `kici-admin org-settings dashboard-writes reset`

Reset all operations to enabled (permissive default).

Synopsis: `kici-admin org-settings dashboard-writes reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dashboard-writes set`

Set one or more operations. Use --op <name>=<permissive|encrypted|disabled> per operation (legacy true|false accepted). "encrypted" is valid only for plaintext operations (secrets.set, variables.set). Sugar: --category or --sensitivity + --enabled <bool> expands to the matching operations.

Synopsis: `kici-admin org-settings dashboard-writes set [options]`

**Options**

| Option                 | Default | Description                                                                                        |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`   |         | Customer / org id (alias: --org)                                                                   |
| `--org <id>`           |         | Alias for --customer-id                                                                            |
| `--op <op=state>`      |         | Single operation posture; repeatable (e.g. --op secrets.set=encrypted --op variables.set=disabled) |
| `--category <name>`    |         | Apply --enabled to every operation in this category                                                |
| `--sensitivity <name>` |         | Apply --enabled to every operation in this sensitivity bucket                                      |
| `--enabled <bool>`     |         | Pair with --category or --sensitivity to flip the whole group                                      |
| `--format <format>`    | `table` | Output format: json\|table                                                                         |

### `kici-admin org-settings dashboard-writes show`

Print current dashboard-write policy. Empty = all enabled.

Synopsis: `kici-admin org-settings dashboard-writes show [options]`

**Options**

| Option                 | Default | Description                                                                                                    |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`   |         | Customer / org id (alias: --org)                                                                               |
| `--org <id>`           |         | Alias for --customer-id                                                                                        |
| `--category <name>`    |         | Filter to one category (Secrets\|Variables\|Environments\|Bindings\|"Held runs"\|DLQ\|Registrations\|Topology) |
| `--sensitivity <name>` |         | Filter to one sensitivity bucket (plaintext\|authority\|dispatch)                                              |
| `--format <format>`    | `table` | Output format: json\|table                                                                                     |

### `kici-admin org-settings dispatch-ack`

Manage the per-org dispatch-acknowledgment deadline (null = cluster default)

Synopsis: `kici-admin org-settings dispatch-ack`

### `kici-admin org-settings dispatch-ack reset`

Clear the per-org dispatch-ack deadline override (fall back to the cluster default)

Synopsis: `kici-admin org-settings dispatch-ack reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dispatch-ack set`

Set the per-org dispatch-acknowledgment deadline (integer milliseconds, >= 1000)

Synopsis: `kici-admin org-settings dispatch-ack set <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dispatch-ack show`

Print the current per-org dispatch-acknowledgment deadline

Synopsis: `kici-admin org-settings dispatch-ack show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings global-workflows`

Manage per-org global workflow policy

Synopsis: `kici-admin org-settings global-workflows`

### `kici-admin org-settings global-workflows allow-add`

Add a glob pattern to the workflow-author allow-list. Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows allow-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows allow-remove`

Remove a glob pattern from the workflow-author allow-list. Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows allow-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows deny-add`

Add a glob pattern to the source-repo deny-list. Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows deny-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows deny-remove`

Remove a glob pattern from the source-repo deny-list. Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows deny-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows elevate-add`

Add a glob pattern to the elevated-access list (DEPRECATED: not enforced, removed at v1.0.0). Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows elevate-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows elevate-remove`

Remove a glob pattern from the elevated-access list (DEPRECATED: not enforced, removed at v1.0.0). Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows elevate-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows show`

Print current global workflow settings for an org

Synopsis: `kici-admin org-settings global-workflows show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings ingest-concurrency`

Manage the per-org webhook-ingest concurrency cap (null = cluster default)

Synopsis: `kici-admin org-settings ingest-concurrency`

### `kici-admin org-settings ingest-concurrency reset`

Clear the per-org webhook-ingest concurrency override (fall back to the cluster default)

Synopsis: `kici-admin org-settings ingest-concurrency reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings ingest-concurrency set`

Set the per-org webhook-ingest concurrency cap (integer, >= 1)

Synopsis: `kici-admin org-settings ingest-concurrency set <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings ingest-concurrency show`

Print the current per-org webhook-ingest concurrency cap

Synopsis: `kici-admin org-settings ingest-concurrency show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout`

Manage the per-org dispatch-queue job timeout (null = cluster default)

Synopsis: `kici-admin org-settings queue-timeout`

### `kici-admin org-settings queue-timeout reset`

Clear the per-org queue-timeout override (fall back to the cluster default)

Synopsis: `kici-admin org-settings queue-timeout reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout set`

Set the per-org queue timeout in milliseconds (0 = indefinite)

Synopsis: `kici-admin org-settings queue-timeout set <ms> [options]`

**Arguments**

| Argument | Required | Variadic | Description                                  |
| -------- | -------- | -------- | -------------------------------------------- |
| `ms`     | yes      | no       | Queue timeout in milliseconds (integer >= 0) |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout show`

Print the current per-org queue timeout

Synopsis: `kici-admin org-settings queue-timeout show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings reroute`

Manage the per-org cross-peer reroute tunables (null = cluster default)

Synopsis: `kici-admin org-settings reroute`

### `kici-admin org-settings reroute reset`

Clear all per-org reroute overrides (fall back to the cluster defaults)

Synopsis: `kici-admin org-settings reroute reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings reroute set`

Set one or more reroute tunables. At least one of --window / --ack-timeout / --max-hops.

Synopsis: `kici-admin org-settings reroute set [options]`

**Options**

| Option               | Default | Description                                         |
| -------------------- | ------- | --------------------------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org)                    |
| `--org <id>`         |         | Alias for --customer-id                             |
| `--window <ms>`      |         | Spawn window (integer milliseconds, >= 1000)        |
| `--ack-timeout <ms>` |         | Reroute ACK timeout (integer milliseconds, >= 1000) |
| `--max-hops <n>`     |         | Maximum peer hops (integer >= 1)                    |
| `--format <format>`  | `table` | Output format: json\|table                          |

### `kici-admin org-settings reroute show`

Print the current per-org reroute tunables

Synopsis: `kici-admin org-settings reroute show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist`

Manage the per-org container-sandbox escape-hatch allow-list (empty = deny all)

Synopsis: `kici-admin org-settings sandbox-allowlist`

### `kici-admin org-settings sandbox-allowlist allow-host-network`

Allow (true) or deny (false) workflow-requested host networking

Synopsis: `kici-admin org-settings sandbox-allowlist allow-host-network <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist reset`

Clear the allow-list (deny all capabilities and host networking)

Synopsis: `kici-admin org-settings sandbox-allowlist reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist set-capabilities`

Set the allowed capabilities (comma-separated, e.g. NET_ADMIN,SYS_PTRACE; empty clears)

Synopsis: `kici-admin org-settings sandbox-allowlist set-capabilities <capabilities> [options]`

**Arguments**

| Argument       | Required | Variadic | Description |
| -------------- | -------- | -------- | ----------- |
| `capabilities` | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist show`

Print the current per-org sandbox capability + host-network allow-list

Synopsis: `kici-admin org-settings sandbox-allowlist show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings scaler-spawn-timeout`

Manage the per-org scaler spawn deadline (null = cluster default)

Synopsis: `kici-admin org-settings scaler-spawn-timeout`

### `kici-admin org-settings scaler-spawn-timeout reset`

Clear the per-org scaler spawn deadline override (fall back to the cluster default)

Synopsis: `kici-admin org-settings scaler-spawn-timeout reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings scaler-spawn-timeout set`

Set the per-org scaler spawn deadline (integer milliseconds, >= 1000)

Synopsis: `kici-admin org-settings scaler-spawn-timeout set <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings scaler-spawn-timeout show`

Print the current per-org scaler spawn deadline

Synopsis: `kici-admin org-settings scaler-spawn-timeout show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache`

Manage per-org user-facing cache quota + entry TTL (null = cluster default)

Synopsis: `kici-admin org-settings user-cache`

### `kici-admin org-settings user-cache reset-quota`

Clear the per-org user-cache quota override (fall back to the cluster default)

Synopsis: `kici-admin org-settings user-cache reset-quota [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache reset-ttl`

Clear the per-org user-cache ttl override (fall back to the cluster default)

Synopsis: `kici-admin org-settings user-cache reset-ttl [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache set-quota`

Set the per-org user-cache quota (positive integer bytes)

Synopsis: `kici-admin org-settings user-cache set-quota <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache set-ttl`

Set the per-org user-cache ttl (positive integer milliseconds)

Synopsis: `kici-admin org-settings user-cache set-ttl <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache show`

Print the current per-org user-cache quota + TTL settings

Synopsis: `kici-admin org-settings user-cache show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin trust-policy`

Show or set the org trust policy the orchestrator enforces, and read the cached approval directory it arrives with

Synopsis: `kici-admin trust-policy`

### `kici-admin trust-policy directory`

Print the stored approval directory — identity links, member CI trust levels, and teams

Synopsis: `kici-admin trust-policy directory [options]`

**Options**

| Option               | Default | Description                |
| -------------------- | ------- | -------------------------- |
| `--customer-id <id>` |         | Org / customer id          |
| `--format <format>`  | `table` | Output format: json\|table |

### `kici-admin trust-policy directory-remove`

Revoke a member: remove every identity link they hold and their CI trust level (independent orchestrators only)

Synopsis: `kici-admin trust-policy directory-remove [options]`

**Options**

| Option               | Default | Description                |
| -------------------- | ------- | -------------------------- |
| `--customer-id <id>` |         | Org / customer id          |
| `--user-id <id>`     |         | KiCI user id to revoke     |
| `--format <format>`  | `table` | Output format: json\|table |

### `kici-admin trust-policy directory-set`

Register a member as an approver: link their provider account to a KiCI user id and set their CI trust level (independent orchestrators only — a Platform-attached orchestrator is managed from the dashboard)

Synopsis: `kici-admin trust-policy directory-set [options]`

**Options**

| Option                       | Default  | Description                                                                                                                              |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`         |          | Org / customer id                                                                                                                        |
| `--user-id <id>`             |          | KiCI user id the approval is attributed to                                                                                               |
| `--provider-username <name>` |          | Provider-side username (display only)                                                                                                    |
| `--provider-user-id <id>`    |          | Immutable provider-side numeric id (GitHub's `sender.id`). Required: an approval comment is matched on this alone, never on the username |
| `--ci-trust <level>`         |          | CI trust level to grant (none \| read \| write \| admin); write or admin may approve                                                     |
| `--provider <name>`          | `github` | Provider the link is for                                                                                                                 |
| `--format <format>`          | `table`  | Output format: json\|table                                                                                                               |

### `kici-admin trust-policy set`

Set the trust policy (independent orchestrators only — a Platform-attached orchestrator is managed from the dashboard). At least one flag required.

Synopsis: `kici-admin trust-policy set [options]`

**Options**

| Option                                 | Default | Description                                                                                                      |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`                   |         | Org / customer id                                                                                                |
| `--format <format>`                    | `table` | Output format: json\|table                                                                                       |
| `--fork-policy <value>`                |         | Fork PR policy (ignore \| hold \| reject \| allow)                                                               |
| `--unknown-contributor-policy <value>` |         | Unknown contributor policy (hold \| reject) [deprecated: no longer enforced; removed at v1.0.0]                  |
| `--workflow-change-policy <value>`     |         | Workflow change policy (hold \| reject \| allow) [deprecated: no longer enforced; removed at v1.0.0]             |
| `--approval-expiry-hours <value>`      |         | Security-hold approval expiry, in hours (integer >= 1)                                                           |
| `--approval-expiry-seconds <value>`    |         | Security-hold approval expiry, in seconds (integer >= 1). Wins over --approval-expiry-hours when both are given. |

### `kici-admin trust-policy show`

Print the trust policy currently enforced for an org

Synopsis: `kici-admin trust-policy show [options]`

**Options**

| Option               | Default | Description                |
| -------------------- | ------- | -------------------------- |
| `--customer-id <id>` |         | Org / customer id          |
| `--format <format>`  | `table` | Output format: json\|table |

<!-- END GENERATED: kici-admin-org-settings -->
