---
title: Config management guide
description: Shared config lifecycle, CLI commands, REST API, hot-reload, cluster sync
---

This guide covers the shared configuration lifecycle: seeding config to the database, viewing and modifying config via CLI and REST API, versioning and rollback. It also names the mechanisms that change what a running orchestrator does, which are not the same thing — see [Changing a running orchestrator](#changing-a-running-orchestrator).

For the config file format and env var reference, see [Configuration reference](configuration.md). For the architecture deep-dive, see [Configuration architecture](../../architecture/configuration.md).

## Shared config overview

### What is shared config?

Shared config is a versioned document stored in the PostgreSQL `config_versions` table. It holds Platform connection settings, storage config, agent auth, queue tuning, and other tuning fields, each encrypted at rest when it is sensitive.

### What reads it

**A running orchestrator does not.** It starts from `KICI_*` environment variables, and a reload re-reads the environment and the local YAML file. Neither path consults `config_versions`.

Three surfaces read the document. The `kici-admin config` commands on this page, except `get`, which reports the running config. `kici-admin rotate-key`. And `kici-admin join`, which copies `storage` and `secrets.key` into the env file the joining orchestrator boots from (`KICI_STORAGE_*` and `KICI_SECRET_KEY`; `kici-admin orchestrator install --env-file` consumes it).

So this page is about the lifecycle of that stored document: seeding it, inspecting it, versioning it, and rolling it back. To change what a running orchestrator does, see [Changing a running orchestrator](#changing-a-running-orchestrator) below.

### How it works

1. **Seed:** Use `kici-admin config seed --file shared.yaml` to import config to the database
2. **Encrypt:** Sensitive fields (tokens, keys) are encrypted with the master key before storage
3. **Version:** Each save creates a new immutable version with audit trail
4. **Inspect:** `kici-admin config export` reads the stored document back, with sensitive values redacted

## Seeding config

### Basic seed

Create a YAML file with your shared settings and seed it:

```yaml
# shared-config.yaml
platform:
  url: 'wss://api.kici.dev/ws'

storage:
  type: 's3'
  bucket: 'kici-cache'
  endpoint: 'http://seaweedfs:3900'
  forcePathStyle: true

agentAuth: 'token'
```

Seed with env var secret injection:

```bash
# Set sensitive values as env vars (never put them in the YAML file)
export KICI_PLATFORM_TOKEN="kici_api_key_here"
export KICI_SECRET_KEY="<64-char-hex-master-key>"
export KICI_BOOTSTRAP_ADMIN_TOKEN="<admin-token>"
export KICI_CLUSTER_JOIN_TOKEN="<join-token>"  # Only needed when seeding for peer nodes

# Seed the config (config commands authenticate with the master secret key)
kici-admin --url http://localhost:4000 --token $KICI_SECRET_KEY \
  config seed --file shared-config.yaml --description "Initial production config"
```

The CLI automatically injects env vars for four sensitive fields:

| Env Var                      | Injected Into                 |
| ---------------------------- | ----------------------------- |
| `KICI_PLATFORM_TOKEN`        | `platform.token`              |
| `KICI_SECRET_KEY`            | `secrets.key`                 |
| `KICI_BOOTSTRAP_ADMIN_TOKEN` | `secrets.bootstrapAdminToken` |
| `KICI_CLUSTER_JOIN_TOKEN`    | `cluster.joinToken`           |

GitHub App credentials are not shared-config fields. The shared schema declares no `providers` section — manage sources with `kici-admin source add github` instead.

### Validation before seed

Validate your config file offline (no orchestrator needed):

```bash
kici-admin config validate --file shared-config.yaml --type shared --offline
```

Or validate via the orchestrator API:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN \
  config validate --file shared-config.yaml --type shared
```

## Viewing config

### Get the running config

`config get` reports what the orchestrator is running with, sensitive values redacted. That is the startup config, or the result of the most recent reload:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config get
```

Filter to a specific path:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config get storage.bucket
```

`config get` and `config export` answer different questions, and they disagree whenever the running config and the stored document differ.

### Export shared config

Export the shared DB config (redacted) as YAML:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config export --format yaml
```

Or as JSON:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config export --format json
```

## Modifying config

### Set a single field

```bash
# Set a string value
kici-admin --url http://localhost:4000 --token $TOKEN \
  config set agentAuth token

# Set a numeric value (auto-parsed as JSON)
kici-admin --url http://localhost:4000 --token $TOKEN \
  config set queue.maxDepth 2000

# Set a boolean value
kici-admin --url http://localhost:4000 --token $TOKEN \
  config set storage.forcePathStyle true

# Set with a description
kici-admin --url http://localhost:4000 --token $TOKEN \
  config set cacheTtlDays 7 --description "Reduce cache TTL for testing"
```

Each `config set` creates a new config version in the database. It changes the stored document only — no running orchestrator reads it. To change what an orchestrator does, see [Changing a running orchestrator](#changing-a-running-orchestrator).

`config set` says so on stderr for every path nothing reads back, and names the command that does change a running cluster. It stays silent for `storage.*` and `secrets.key`: those two are read out of the stored document by `kici-admin join`, so setting them changes what a joining orchestrator boots with. The write, the exit code, and stdout are the same either way — the warning is a note, not a refusal.

### Delete a field

```bash
kici-admin --url http://localhost:4000 --token $TOKEN \
  config delete webhookPayloadDir
```

### Compare local vs shared

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config diff
```

Output shows fields that differ between the local YAML and shared DB config.

## Changing a running orchestrator

The shared config document on this page does not reach a running orchestrator. Three mechanisms do, and which one you need depends on the setting:

| Mechanism                                 | Store              | Takes effect                                        |
| ----------------------------------------- | ------------------ | --------------------------------------------------- |
| `kici-admin cluster-settings set`         | `cluster_settings` | live for some knobs, at the next restart for others |
| `kici-admin org-settings`                 | `org_settings`     | live, for the org you name                          |
| Edit the env file and restart the service | environment        | at the restart                                      |

`kici-admin cluster-settings show` lists every fleet-wide tunable it manages. `kici-admin org-settings` covers the per-org overrides: the user-facing cache, artifacts, and ingest concurrency.

## Tuning cache limits

The orchestrator maintains several caches, and their limits live on three planes:

- **Fleet-wide tunables** — set with `kici-admin cluster-settings set`, stored in `cluster_settings`. The cache retention and tarball cap are re-read on every lookup, so a change applies immediately. The lock-file cache sizes are structural to the in-memory index, so a change there applies at the next orchestrator restart.
- **Startup values** — read from the environment at startup. Change the env var and restart the service.
- **Per-org overrides** — only the user-facing cache (`ctx.cache`) supports per-tenant overrides, stored in `org_settings` and set with `kici-admin org-settings user-cache ...`. When an override is unset (NULL), the fleet-wide default applies.

### Cache-limit fields

| Field                  | Default            | Change it with                                                                  | Controls                                                                     |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `cacheMaxTarballBytes` | 524288000 (500 MB) | `cluster-settings set --cache-max-tarball-bytes` (live)                         | Max size of a source / dependency tarball the blob-storage backend accepts   |
| `cacheTtlDays`         | 30                 | `cluster-settings set --cache-ttl-days` (live)                                  | Retention (days) for the compiled-source, dependency, and attestation caches |
| `cacheBuildTimeoutMs`  | 600000 (10 min)    | `KICI_CACHE_BUILD_TIMEOUT_MS` + restart                                         | Deadline for a single dependency-cache build operation                       |
| `lockfileCache.max`    | 500                | `cluster-settings set --lockfile-cache-max` + restart                           | Max entries in the in-memory lock-file LRU cache                             |
| `lockfileCache.ttlMs`  | 3600000 (1 h)      | `cluster-settings set --lockfile-cache-ttl-ms` + restart                        | Per-entry TTL for the lock-file LRU cache                                    |
| `userCacheQuotaBytes`  | 5368709120 (5 GiB) | `org-settings user-cache set-quota`, or `KICI_USER_CACHE_QUOTA_BYTES` + restart | Byte quota for the user-facing cache (`ctx.cache`)                           |
| `userCacheTtlMs`       | 604800000 (7 d)    | `org-settings user-cache set-ttl`, or `KICI_USER_CACHE_TTL_MS` + restart        | Per-entry TTL for the user-facing cache                                      |

### List and set the fleet-wide defaults

```bash
# Inspect the current fleet-wide tunables
kici-admin --url http://localhost:4000 --token $TOKEN cluster-settings show

# Raise the source/dependency tarball cap to 1 GiB
kici-admin --url http://localhost:4000 --token $TOKEN \
  cluster-settings set --cache-max-tarball-bytes 1073741824

# Shorten the dependency-cache retention to 7 days
kici-admin --url http://localhost:4000 --token $TOKEN \
  cluster-settings set --cache-ttl-days 7

# Grow the lock-file LRU cache, then restart the service to apply it
kici-admin --url http://localhost:4000 --token $TOKEN \
  cluster-settings set --lockfile-cache-max 1000
```

To read what the orchestrator is running with, use `config get` with no path. To read the stored shared document, use `config export`:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config get            # running config
kici-admin --url http://localhost:4000 --token $TOKEN config export --format yaml  # stored document
```

For the complete field list with types and defaults, see the
[Configuration reference](configuration.md).

### Override the user cache per org

The user-facing cache (`ctx.cache`, and the declarative job/step `cache:` field)
is the only cache with a per-tenant override. Use `org-settings user-cache` to
raise one org's budget or retention without touching the cluster default:

```bash
# Give one org a 20 GiB quota and 30-day retention
kici-admin --url http://localhost:4000 --token $TOKEN \
  org-settings user-cache set-quota 21474836480 --customer-id <org>
kici-admin --url http://localhost:4000 --token $TOKEN \
  org-settings user-cache set-ttl 2592000000 --customer-id <org>

# Show the effective per-org values (null = cluster default applies)
kici-admin --url http://localhost:4000 --token $TOKEN \
  org-settings user-cache show --customer-id <org>

# Drop an override and fall back to the cluster default
kici-admin --url http://localhost:4000 --token $TOKEN \
  org-settings user-cache reset-quota --customer-id <org>
kici-admin --url http://localhost:4000 --token $TOKEN \
  org-settings user-cache reset-ttl --customer-id <org>
```

See the [kici-admin CLI reference](kici-admin-cli.md) for the full
`org-settings user-cache` surface and [Storage layout: user cache](storage-layout.md#user-cache)
for the eviction and TTL mechanics.

## Config history and rollback

### View version history

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config history

# Limit results
kici-admin --url http://localhost:4000 --token $TOKEN config history --limit 5
```

Output:

```
Version | Created At | Created By | Description
--------------------------------------------------------------------------------
3 | 2026-02-22T12:00:00Z | api:set | Set cacheTtlDays
2 | 2026-02-22T11:00:00Z | cli:seed | Added partner app
1 | 2026-02-22T10:00:00Z | cli:seed | Initial production config
```

### Rollback to a previous version

Rollback creates a new version that is a copy of the target version (preserving the full audit trail):

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config rollback --to 1
```

This creates version 4 (a copy of version 1). Encrypted fields are preserved as-is (no re-encryption needed since the same master key applies).

## Config reload

### Reload triggers

The orchestrator supports three reload mechanisms:

| Trigger | Command                     | Use Case             |
| ------- | --------------------------- | -------------------- |
| SIGHUP  | `kill -HUP <pid>`           | Standard Unix signal |
| HTTP    | `POST /admin/config/reload` | Programmatic/CLI     |
| CLI     | `kici-admin config reload`  | Operator command     |

All triggers reload both the orchestrator config AND the scaler config together.

### CLI reload

```bash
# Simple reload
kici-admin --url http://localhost:4000 --token $TOKEN config reload

# Drain in-flight work before reloading
kici-admin --url http://localhost:4000 --token $TOKEN config reload --drain
```

### What a reload changes

A reload re-reads the environment and the local YAML file, validates the merge, and swaps the result into the running config. It does not restart the process, so it reaches only what the orchestrator re-reads afterwards:

- `queue.backpressureThreshold` — the queue-depth warning threshold, re-read on every measurement tick.
- The response of `kici-admin config get`.
- The config version each instance advertises to its cluster peers.
- The scaler configuration, re-read from the path the process started with.

Four fields are held at their startup values, and the reload logs a warning naming them:

| Field         | Reason                            |
| ------------- | --------------------------------- |
| `databaseUrl` | Cannot rebind DB connection pool  |
| `port`        | Cannot rebind listening socket    |
| `instanceId`  | Identity used in cluster protocol |
| `storage`     | Backend is constructed at startup |

```
Config fields changed but require restart to apply: ["databaseUrl"]
```

Every other setting keeps the value the process started with until you restart it.

### Drain mode

Use `--drain` for zero-disruption config changes on critical credential updates:

1. Orchestrator stops accepting new work
2. Waits for all in-flight jobs to complete
3. Applies the new config
4. Resumes accepting work

### Reload safety

- **Validation before swap:** New config is validated against the full schema before applying. If validation fails, the old config is preserved.
- **Mutex serialization:** Concurrent reload requests are rejected (not queued).
- **Debounce:** Rapid SIGHUP signals are collapsed into a single reload (500ms debounce).
- **Prometheus metrics:** `kici_orch_config_reload_total` (counter with `result` and `source` labels).

## Cluster config sync

### How it works

In clustered deployments, orchestrators broadcast a config version in Raft heartbeat metadata. **That number counts how many times the instance has reloaded** — it is not the version of the stored shared document. When an orchestrator sees a higher count on a peer, it triggers its own reload, which re-reads its environment and its local YAML file.

So the mechanism keeps reload counts converging. It does not distribute config: each instance reads its own inputs, and the two agree on content only when those inputs agree. Keep the env files consistent across the cluster, with a configuration-management tool or the installer.

### Requirements

- All orchestrators must share the same PostgreSQL database
- All orchestrators must have the same master key (`KICI_SECRET_KEY`)
- Config version comparison only triggers when both local and peer versions are > 0 (avoids false triggers from newly started orchestrators)

## CLI reference

All commands require `--url` (orchestrator URL) and `--token` (master secret key, i.e. `KICI_SECRET_KEY`) unless noted.

| Command                         | Description                                     | Example                                     |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `config seed --file <path>`     | Bulk import shared config (injects env secrets) | `config seed --file shared.yaml`            |
| `config get [path]`             | Get the running config (redacted)               | `config get storage.bucket`                 |
| `config set <path> <value>`     | Set single field in shared config               | `config set agentAuth token`                |
| `config delete <path>`          | Remove field from shared config                 | `config delete webhookPayloadDir`           |
| `config export`                 | Export shared config (redacted)                 | `config export --format yaml`               |
| `config validate --file <path>` | Validate config file                            | `config validate --file cfg.yaml --offline` |
| `config diff`                   | Compare local YAML vs shared DB                 | `config diff`                               |
| `config history`                | Show version history                            | `config history --limit 10`                 |
| `config rollback --to <N>`      | Rollback to version N                           | `config rollback --to 1`                    |
| `config reload`                 | Trigger config reload                           | `config reload --drain`                     |
| `config init`                   | Generate starter orchestrator.yaml              | `config init --output ./orch.yaml`          |

All commands support `--format json|yaml|table` for output formatting.

### Special commands

- **`config validate --offline`**: Imports schemas directly and validates locally without contacting the orchestrator. Useful in CI/CD pipelines.
- **`config init`**: Generates a well-commented starter `orchestrator.yaml` template without any API call. Runs locally.

## REST API reference

All endpoints are under `/admin/config/*` and require Bearer token authentication with the master secret key (`KICI_SECRET_KEY`).

| Method   | Endpoint                 | Request Body                    | Response                         | Description                     |
| -------- | ------------------------ | ------------------------------- | -------------------------------- | ------------------------------- |
| `POST`   | `/admin/config/seed`     | `{ config, description? }`      | `{ version }`                    | Bulk import shared config       |
| `GET`    | `/admin/config/`         | (query: `path`)                 | `{ config, version, source }`    | Get the running config          |
| `PUT`    | `/admin/config/`         | `{ path, value, description? }` | `{ version }`                    | Set single field                |
| `DELETE` | `/admin/config/`         | `{ path, description? }`        | `{ version }`                    | Remove field                    |
| `GET`    | `/admin/config/export`   | --                              | `{ config, version }`            | Export shared config (redacted) |
| `POST`   | `/admin/config/validate` | `{ config, type? }`             | `{ valid, errors? }`             | Validate config                 |
| `GET`    | `/admin/config/diff`     | --                              | `{ local, shared, differences }` | Local vs shared diff            |
| `GET`    | `/admin/config/history`  | (query: `limit`)                | `{ versions }`                   | Version history                 |
| `POST`   | `/admin/config/rollback` | `{ version }`                   | `{ newVersion }`                 | Rollback to version             |
| `POST`   | `/admin/config/reload`   | `{ drain?, target? }`           | `{ success, ... }`               | Trigger reload                  |

### Authentication

```
Authorization: Bearer <KICI_SECRET_KEY>
```

Verification uses constant-time comparison.

If no secret key is configured, all `/admin/config/*` endpoints return 503.

### Validate types

The `POST /admin/config/validate` endpoint accepts a `type` parameter:

- `local` -- validate against `localConfigSchema`
- `shared` (default) -- validate against `sharedConfigSchema`
- `full` -- validate against `appConfigSchema` (requires all cross-field conditions)

## Troubleshooting

### Master key mismatch

**Symptom:** Decryption errors when reading config from DB after changing orchestrators.

**Cause:** The master key (`KICI_SECRET_KEY`) differs between orchestrator instances.

**Fix:** Ensure all orchestrators use the exact same master key. If the key was changed, you must re-seed the shared config with the new key.

### DB connectivity during seed

**Symptom:** `config seed` fails with connection error.

**Cause:** The orchestrator is not running or not reachable.

**Fix:** Ensure the orchestrator is running and the `--url` flag points to the correct address. The `config seed` command sends the config to the orchestrator's REST API, which handles DB writes.

### Reload failures

**Symptom:** `config reload` reports `success: false` with validation errors.

**Cause:** The merge of the local YAML file and the environment fails schema validation.

**Fix:** Check the error messages. Common issues:

- `platformUrl` required but not set when mode is `platform`
- `storage.bucket` missing when `storage.type` is `s3`
- A `cluster.role` of `worker` with no `cluster.coordinatorUrl`

The orchestrator keeps running with the old config when reload validation fails. No data is lost.

### Config version mismatch in cluster

**Symptom:** Logs show "Peer has newer config version, triggering reload" repeatedly.

**Cause:** One orchestrator has reloaded fewer times than its peer, and each reload it runs raises its own count by one. The counts converge once it catches up. Repeated messages mean its reloads are failing, so the count never advances.

**Fix:** Read the reload result on the lagging orchestrator. A failed reload logs its validation errors and keeps the old config, so the cause is in that instance's own environment or local YAML file.

### Targeting specific instances

`POST /admin/config/reload` accepts an optional `target` body field to forward
the reload request to a specific peer in the cluster. The orchestrator that
receives the request looks the target up in its peer registry, sends a
`peer.config.reload` message via the cluster peer connection (outgoing
PeerClient first, falling back to the incoming peer-handler), and waits up
to 15 seconds for the target peer's `peer.config.reload.response` before
returning the result to the caller.

Response semantics:

- `200 OK` — target peer reloaded successfully; the body is the target's
  `ReloadResult` (`success: true`, `version`, `fieldsChanged`, etc.).
- `500 Internal Server Error` — target peer ran the reload but it failed
  (validation error or runtime error). The body contains the failing
  `ReloadResult` from the target.
- `404 Not Found` — the orchestrator is not connected to a peer with the
  given `target` instance ID.
- `501 Not Implemented` — only returned in single-orchestrator deployments
  where no cluster peer forwarder is configured.

Example targeted reload:

```bash
kici-admin --url http://orch-a:4000 --token $TOKEN config reload --target orch-b --drain
```

The CLI wraps the same `POST /admin/config/reload` endpoint; to call it directly:

```bash
curl -X POST http://orch-a:4000/admin/config/reload \
  -H "Authorization: Bearer $KICI_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target": "orch-b", "drain": true}'
```
