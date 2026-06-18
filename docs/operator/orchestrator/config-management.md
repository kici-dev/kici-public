---
title: Config management guide
description: Shared config lifecycle, CLI commands, REST API, hot-reload, cluster sync
---

This guide covers the shared configuration lifecycle: seeding config to the database, viewing and modifying config via CLI and REST API, hot-reloading, rollback, and cluster config synchronization.

For the config file format and env var reference, see [Configuration reference](configuration.md). For the architecture deep-dive, see [Configuration architecture](../../architecture/configuration.md).

## Shared config overview

### What is shared config?

Shared config is the subset of orchestrator configuration stored in the PostgreSQL `config_versions` table. It includes provider credentials, Platform connection settings, storage config, agent auth, queue tuning, and other settings that should be consistent across all orchestrator instances in a cluster.

### Why shared config?

When running multiple orchestrator instances, you need a single source of truth. Without shared config, every instance needs the same env vars or YAML files, and changes must be coordinated manually across all machines. With shared config:

- Seed once, all instances read from the same DB
- Changes propagate automatically via config reload
- Full version history with rollback capability
- Sensitive values encrypted at rest

### How it works

1. **Seed:** Use `kici-admin config seed --file shared.yaml` to import config to the database
2. **Encrypt:** Sensitive fields (private keys, tokens) are encrypted with the master key before storage
3. **Version:** Each save creates a new immutable version with audit trail
4. **Resolve:** On startup (and reload), each orchestrator merges: env var > YAML > DB > defaults
5. **Sync:** In clustered deployments, orchestrators detect stale config via heartbeat metadata

## Seeding config

### Basic seed

Create a YAML file with your shared settings and seed it:

```yaml
# shared-config.yaml
providers:
  github:
    - name: 'main-org'
      appId: '12345'

platform:
  url: 'wss://relay.kici.dev'

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
export KICI_PROVIDERS_GITHUB_MAIN_ORG_PRIVATE_KEY="$(cat main-org.pem)"
export KICI_PROVIDERS_GITHUB_MAIN_ORG_WEBHOOK_SECRET="whsec_abc123"
export KICI_PLATFORM_TOKEN="kici_api_key_here"
export KICI_SECRET_KEY="<64-char-hex-master-key>"
export KICI_BOOTSTRAP_ADMIN_TOKEN="<admin-token>"
export KICI_CLUSTER_JOIN_TOKEN="<join-token>"  # Only needed when seeding for peer nodes

# Seed the config (config commands authenticate with the master secret key)
kici-admin --url http://localhost:4000 --token $KICI_SECRET_KEY \
  config seed --file shared-config.yaml --description "Initial production config"
```

The CLI automatically injects env vars for known sensitive fields:

| Env Var                                      | Injected Into                          |
| -------------------------------------------- | -------------------------------------- |
| `KICI_PROVIDERS_GITHUB_<APP>_PRIVATE_KEY`    | `providers.github[name].privateKey`    |
| `KICI_PROVIDERS_GITHUB_<APP>_WEBHOOK_SECRET` | `providers.github[name].webhookSecret` |
| `KICI_PLATFORM_TOKEN`                        | `platform.token`                       |
| `KICI_SECRET_KEY`                            | `secrets.key`                          |
| `KICI_BOOTSTRAP_ADMIN_TOKEN`                 | `secrets.bootstrapAdminToken`          |
| `KICI_CLUSTER_JOIN_TOKEN`                    | `cluster.joinToken`                    |

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

### Get current effective config

View the merged config (env > YAML > DB > defaults) with sensitive values redacted:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config get
```

Filter to a specific path:

```bash
kici-admin --url http://localhost:4000 --token $TOKEN config get providers
kici-admin --url http://localhost:4000 --token $TOKEN config get storage.bucket
```

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
  config set agentAuth none

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

Each `config set` creates a new config version in the database.

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

### Hot-reload vs restart-required

Most config fields are hot-reloadable -- they take effect immediately without restarting the process. The following fields require a full restart:

| Field         | Reason                            |
| ------------- | --------------------------------- |
| `databaseUrl` | Cannot rebind DB connection pool  |
| `port`        | Cannot rebind listening socket    |
| `instanceId`  | Identity used in cluster protocol |

When a reload detects changes to restart-required fields, the old values are preserved and a warning is logged:

```
Config fields changed but require restart to apply: ["databaseUrl"]
```

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
- **Prometheus metrics:** `kici_orch_config_reload_total` (counter with `result` and `source` labels), `kici_orch_config_version` (gauge).

## Cluster config sync

### How it works

In clustered deployments, orchestrators broadcast their config version in Raft heartbeat metadata. When an orchestrator detects that a peer is running a newer config version:

1. The stale orchestrator automatically triggers a config reload from the database
2. The reload picks up the latest config version
3. Prometheus metrics update to reflect the new version

This auto-remediation ensures all orchestrators converge to the same config version without manual intervention.

### Requirements

- All orchestrators must share the same PostgreSQL database
- All orchestrators must have the same master key (`KICI_SECRET_KEY`)
- Config version comparison only triggers when both local and peer versions are > 0 (avoids false triggers from newly started orchestrators)

## CLI reference

All commands require `--url` (orchestrator URL) and `--token` (master secret key, i.e. `KICI_SECRET_KEY`) unless noted.

| Command                         | Description                                     | Example                                     |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `config seed --file <path>`     | Bulk import shared config (injects env secrets) | `config seed --file shared.yaml`            |
| `config get [path]`             | Get effective config (merged, redacted)         | `config get storage.bucket`                 |
| `config set <path> <value>`     | Set single field in shared config               | `config set agentAuth none`                 |
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
| `GET`    | `/admin/config/`         | (query: `path`)                 | `{ config, version, source }`    | Get effective config            |
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

**Cause:** The new config (after merging all layers) fails schema validation.

**Fix:** Check the error messages. Common issues:

- Missing required provider config after removing an app
- `platformUrl` required but not set when mode is `platform`
- GitHub app missing `privateKey`

The orchestrator keeps running with the old config when reload validation fails. No data is lost.

### Config version mismatch in cluster

**Symptom:** Logs show "Config version behind peer" repeatedly.

**Cause:** One orchestrator cannot read the latest config version from the DB (permissions, connectivity).

**Fix:** Check DB connectivity on the stale orchestrator. Verify the orchestrator's DB user has read access to the `config_versions` table.

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
