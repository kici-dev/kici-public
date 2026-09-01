---
title: kici-admin CLI reference
description: Complete reference for the kici-admin orchestrator administration CLI
---

The `kici-admin` CLI manages the KiCI orchestrator: configuration, secrets, tokens, sources, database migrations, diagnostics, clustering, and service lifecycle. Most commands reach the orchestrator over its admin HTTP API using Bearer token authentication.

Some command groups deliberately bypass that API, because they must work while the orchestrator is down (or before it exists):

- **Direct database** (`--database-url`, or `KICI_DATABASE_URL`): `peer`, `host`, `check-run`, `cluster`, `signing-key`, `dashboard-encryption-key`, `remote-source`. Several API-backed commands also offer a direct-DB mode through the same flag — each one says so in its guide entry.
- **Local host only** (no orchestrator, no database): `firecracker`, `scaler`, `inspect-bundle`, and the `agent` / `orchestrator` service-lifecycle verbs (`install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`, `upgrade`, plus `agent package`; `orchestrator drain` / `resume` are API-backed).
- **Own transport**: `join` connects straight to the Platform relay or a peer orchestrator.

## Installation

The `kici-admin` binary is provided by the `kici-admin` npm package, which re-exports the CLI from `@kici-dev/orchestrator`:

```bash
npm install -g kici-admin
```

The same package also installs a second binary, `kici-agent`, which runs the KiCI agent. That is what puts an agent on `PATH` for a bare-metal scaler's `binaryPath:` — see the [bare-metal quickstart](../../user/quickstart/bare-metal.md).

For standalone (single-executable) deployments, see [Packaging guide](../distribution/sea-binaries.md).

## Authentication

All API-backed commands require a Bearer token. Provide it via:

- **Environment variable** (recommended): `export KICI_ADMIN_TOKEN=<token>`
- **CLI flag**: `--token <token>` or `-t <token>`

The token is validated against the `admin_tokens` table in the orchestrator database. Tokens are stored as SHA-256 hashes and never persisted in plaintext.

### Bootstrap token

On first startup, the orchestrator generates a bootstrap token with `owner` role and prints it to the logs:

```
KICI Admin Token: <token-value>
```

Save this token immediately -- it is only shown once. To use a fixed token for automation, set `KICI_BOOTSTRAP_ADMIN_TOKEN` before starting the orchestrator:

```bash
export KICI_BOOTSTRAP_ADMIN_TOKEN=my-fixed-admin-token
```

The bootstrap token creation is idempotent: if one already exists, it is reused.

### Creating additional tokens

Use `kici-admin token create` to issue tokens with specific roles:

```bash
kici-admin token create ci-operator --role admin
kici-admin token create compliance-bot --role auditor
```

## Global options

These options apply to every command:

| Option                  | Environment variable | Default                 | Description            |
| ----------------------- | -------------------- | ----------------------- | ---------------------- |
| `--url <url>`, `-u`     | `KICI_ADMIN_URL`     | `http://localhost:8080` | Orchestrator HTTP URL  |
| `--token <token>`, `-t` | `KICI_ADMIN_TOKEN`   | (required)              | Admin API Bearer token |
| `-V`, `--cli-version`   |                      |                         | Show CLI version       |

Running `--help` on any command works without a token.

## Output streams

The `kici-admin` binary routes every diagnostic log line to **stderr**. Only command output — a table, or the payload of a `--json` / `--format json` run — goes to **stdout**. So you can pipe stdout straight into a parser:

```bash
kici-admin runs list --json | jq -r '.runs[].runId'
```

The CLI sets `KICI_LOG_STDERR=1` for you when it starts. Set it yourself only if you invoke the orchestrator CLI module through some other entry point and want the same split.

## RBAC roles

Tokens are assigned one of three roles. The role determines which admin API operations are permitted:

| Permission             | owner | admin | auditor |
| ---------------------- | ----- | ----- | ------- |
| context.create         | yes   | yes   |         |
| context.read           | yes   | yes   | yes     |
| context.update         | yes   | yes   |         |
| context.delete         | yes   | yes   |         |
| secret.read            | yes   | yes   |         |
| secret.write           | yes   | yes   |         |
| secret.delete          | yes   | yes   |         |
| secret.reveal          | yes   | yes   |         |
| audit.read             | yes   | yes   | yes     |
| run.read               | yes   | yes   | yes     |
| run.cancel             | yes   | yes   |         |
| event_log.read         | yes   | yes   | yes     |
| event_log.read_payload | yes   | yes   |         |
| access_log.read        | yes   | yes   | yes     |
| scheduled_job.trigger  | yes   | yes   |         |
| event_dlq.read         | yes   | yes   | yes     |
| event_dlq.manage       | yes   | yes   |         |
| attestation.retry      | yes   | yes   |         |
| orchestrator.drain     | yes   | yes   |         |
| ci_trust.read          | yes   | yes   |         |
| ci_trust.admin         | yes   | yes   |         |
| token.manage           | yes   |       |         |
| key.rotate             | yes   |       |         |

`secret.reveal` is the additional gate for `kici-admin runs secret-outputs --reveal`: decrypting stored secret-output values and returning plaintext is strictly narrower than generic "read a secret", so owner + admin roles carry it explicitly and auditor tokens are rejected with 403.

- **owner** -- full access. Use for bootstrap and token management.
- **admin** -- day-to-day operations (secrets, sources, config). Cannot manage tokens or rotate keys.
- **auditor** -- read-only access to contexts, audit logs, run status, the event log (metadata only), the access log, and the event dead-letter queue. Cannot read secret values, event-log payloads, or mutate anything.

> **Note:** These roles govern the orchestrator admin API only. They are entirely separate from the SaaS dashboard RBAC system (org member roles, custom roles, permission matrices) which is managed through the dashboard UI and applies to OIDC-authenticated users.

## Command reference

The full command reference is split by area:

- [Configuration & database](./kici-admin/config-and-db.md) — `config`, `db`
- [Sources](./kici-admin/sources.md) — `source`, `remote-source`
- [Secrets, tokens & context](./kici-admin/secrets-tokens-context.md) — `secret`, `variable`, `backend`, `audit`, `api-key`, `token`, `rotate-key`, `context`
- [Agents, peers & hosts](./kici-admin/agents-peers-hosts.md) — `agent`, `peer`, `join`, `host`
- [Runs, execution & events](./kici-admin/runs-execution-events.md) — `runs`, `execution`, `check-run`, `queue`, `registration`, `workflow`, `event`, `event-dlq`
- [Cluster & infrastructure](./kici-admin/cluster-and-infra.md) — `orchestrator`, `cluster`, `cluster-name`, `cluster-settings`, `scaler`, `firecracker`
- [Org settings](./kici-admin/org-settings.md) — `org-settings`, `trust-policy`, `held-run`
- [Inspection & recovery](./kici-admin/inspection-recovery.md) — `cold-store`, `attestations`, `signing-key`, `dashboard-encryption-key`, `access-log`, `event-log`, `diagnose`, `debug-bundle`, `inspect-bundle`

Each area page carries a `## Guide` section (per-namespace concepts and worked examples) and a `## Reference` section (the always-current generated signature list for that area's commands).

## Environment variables summary

| Variable                     | Scope        | Description                                               |
| ---------------------------- | ------------ | --------------------------------------------------------- |
| `KICI_ADMIN_URL`             | CLI          | Orchestrator URL (default: `http://localhost:8080`)       |
| `KICI_ADMIN_TOKEN`           | CLI          | Admin API Bearer token (required)                         |
| `KICI_DATABASE_URL`          | CLI          | Postgres URL for direct-DB commands (or `--database-url`) |
| `KICI_BOOTSTRAP_ADMIN_TOKEN` | Orchestrator | Fixed bootstrap token (idempotent)                        |
| `KICI_SECRET_KEY`            | Orchestrator | 64-char hex AES-256 master key                            |
| `KICI_SECRET_KEY_FILE`       | Orchestrator | Path to master key file                                   |
| `KICI_SECRET_KEY_OLD`        | Orchestrator | Previous key for dual-key rotation                        |
| `KICI_AUTO_MIGRATE`          | Orchestrator | Set `false` to disable auto-migration                     |
| `KICI_AGENT_TOKEN`           | Agent        | Agent authentication token                                |
| `KICI_BACKEND_VAULT_URL`     | CLI          | Vault/OpenBao URL for backend commands                    |
| `KICI_BACKEND_ROLE_ID`       | CLI          | Vault AppRole role ID for backend commands                |
| `KICI_BACKEND_SECRET_ID`     | CLI          | Vault AppRole secret ID for backend commands              |
| `KICI_BACKEND_TOKEN`         | CLI          | Vault token for backend commands                          |
| `KICI_BACKEND_PG_URL`        | CLI          | PG connection string for backend commands                 |

## See also

- [Orchestrator setup guide](orchestrator-setup.md) -- end-to-end setup walkthrough
- [Service installation guide](../distribution/service-installation.md) -- platform-specific service management
- [Secrets management](../security/secrets.md) -- encryption, RBAC, key rotation, Vault backend
- [Configuration management](config-management.md) -- config layers and precedence
- [Clustering](clustering.md) -- multi-orchestrator cluster setup
