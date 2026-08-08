---
title: Orchestrator setup guide
description: ''
---

This guide covers the end-to-end setup of a KiCI orchestrator, including database migration, source configuration, and operational management.

For deployment modes and container setup, see [Getting started](getting-started.md).

## Quick start

Install the `kici-admin` CLI first — it drives orchestrator install and lifecycle:

```bash
npm install -g kici-admin
```

Then install and start the orchestrator. On an interactive terminal, `install` runs
the setup wizard by default:

```bash
# 1. Install (runs the interactive wizard on a TTY; collects mode, DB, Platform
#    credentials + optional source). Pass --wizard to force it, or --no-wizard to
#    skip it and write a stub env file you edit by hand.
kici-admin orchestrator install

# 2. Start the orchestrator
kici-admin orchestrator start
```

The wizard handles everything: database connection, encryption key generation, Platform credentials, and optionally collecting your first GitHub App source. Sources are added at runtime against a running orchestrator, so if you configure one, the wizard prints a ready-to-run `kici-admin source add github ...` command in its "Next steps" to run once the orchestrator is started -- it does not write the source into the env file.

In a non-interactive shell (CI, a provisioning script), `install` writes a stub env
file enumerating the required keys with generation commands, then you edit it and run
`start`. Pass `--env-file <path>` to install from an existing config file.

## Manual setup

### Database

The orchestrator auto-migrates its PostgreSQL database on startup by default.

```bash
# Check migration status without applying
kici-admin db migrate --status

# Run migrations manually
kici-admin db migrate

# Opt out of auto-migration
export KICI_AUTO_MIGRATE=false
```

When `KICI_AUTO_MIGRATE=false` is set, the orchestrator will not run migrations on startup. You must run `kici-admin db migrate` manually before starting the orchestrator.

### Object storage (S3 buckets)

S3-compatible object storage is used **only by the orchestrator**. Platform, agent, and dashboard do **not** need buckets of their own — agents receive pre-signed URLs from the orchestrator, and Platform/dashboard don't touch object storage.

Per orchestrator, you need either one or two buckets:

| Bucket             | Purpose                                                                              | Required?                           | Config                                          |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------- |
| Cache bucket       | Compiled workflow bundles, dependency caches, test tarballs (`test-uploads/` prefix) | **Required** when `storage.type=s3` | `KICI_STORAGE_BUCKET` / `storage.bucket`        |
| Log bucket (split) | Execution logs                                                                       | Optional — defaults to cache bucket | `KICI_STORAGE_LOG_BUCKET` / `storage.logBucket` |

The single-bucket setup (cache + logs share one bucket) is the default and works fine for most deployments. Split into two buckets only when you want different lifecycle rules or access policies for logs vs caches.

**Lifecycle recommendations:**

- **Production**: lifecycle TTL ≥ `KICI_CACHE_TTL_DAYS` (default 30 days, enforced minimum 30). The orchestrator relies on cache freshness; aggressive bucket-level expiration will cause cache misses.
- **Staging**: 10-day TTL is reasonable.
- **Dev / E2E**: 2-day TTL is reasonable — artifacts are disposable.

Also configure `abort_incomplete_multipart_upload` after 1 day so failed uploads don't accumulate.

**S3-compatible backends:** AWS S3, SeaweedFS, MinIO, and Cloudflare R2 are all supported. For non-AWS backends set `KICI_STORAGE_ENDPOINT`, `KICI_STORAGE_FORCE_PATH_STYLE=true`, and `KICI_STORAGE_REGION` (any value, e.g. `us-east-1` — a region is required even though non-AWS stores ignore it). Use `KICI_STORAGE_EXTERNAL_ENDPOINT` when agents must reach the bucket via a different URL than the orchestrator does (e.g. in-cluster vs public DNS), and `KICI_STORAGE_UPLOAD_ENDPOINT` when the developer machine running `kici run remote` reaches it at yet another address.

For the full list of storage env vars see [Orchestrator configuration](configuration.md).

### Adding a GitHub App source

Sources define which GitHub Apps the orchestrator manages. Each source requires an App ID, private key, and webhook secret.

```bash
# Add a source with a private key from a file
kici-admin source add github \
  --name main-org \
  --app-id 12345 \
  --private-key @/path/to/app.pem \
  --webhook-secret your-webhook-secret

# List configured sources
kici-admin source list

# Update a source (rotate webhook secret)
kici-admin source update github:12345 --webhook-secret new-secret

# Update a source (rotate private key)
kici-admin source update github:12345 --private-key @/path/to/new-key.pem

# Remove a source
kici-admin source remove github:12345
```

### Secret input modes

All secret parameters support multiple input methods:

| Mode                 | Syntax                  | Example                                                   |
| -------------------- | ----------------------- | --------------------------------------------------------- |
| Direct value         | `--private-key <value>` | `--webhook-secret mysecret`                               |
| File (`@` prefix)    | `--private-key @<path>` | `--private-key @/path/to/key.pem`                         |
| Environment variable | `--from-env <VAR>`      | `--from-env GITHUB_PRIVATE_KEY`                           |
| Standard input       | `--stdin`               | `cat key.pem \| kici-admin source add github --stdin ...` |

The `@file` syntax reads the file contents at the given path. This is the recommended approach for private keys.

The webhook secret has its own stdin form: pass `--webhook-secret -` to read it from standard input, keeping it out of shell history:

```bash
printf %s "$WEBHOOK_SECRET" | kici-admin source add github \
  --name main-org --app-id 12345 --private-key @/path/to/app.pem --webhook-secret -
```

`--webhook-secret -` cannot be combined with `--stdin` (which reads the private key from stdin) -- only one value can come from standard input. Use `@file` or `--from-env` for the other.

### Adding a generic webhook source

Generic sources accept HTTP webhooks from any external service. They support multiple verification methods and configurable event extraction.

```bash
# Add a generic source with HMAC verification
kici-admin source add generic \
  --org my-org \
  --name stripe-webhooks \
  --verification hmac_sha256 \
  --secret @/path/to/webhook-secret.txt \
  --event-type-header X-Event-Type \
  --rate-limit 120

# Add a generic source with bearer token verification
kici-admin source add generic \
  --org my-org \
  --name custom-service \
  --verification bearer_token \
  --secret my-bearer-token \
  --event-type-path '$.event.type'

# Add a source with no verification (not recommended for production)
kici-admin source add generic \
  --org my-org \
  --name internal-service \
  --verification none

# Get details of a generic source
kici-admin source get <source-id>

# List all sources including generic (requires --org for generic)
kici-admin source list --org my-org

# Update a generic source
kici-admin source update-generic <source-id> --rate-limit 300 --name new-name

# Enable/disable a generic source
kici-admin source disable <source-id>
kici-admin source enable <source-id>

# Soft-delete a generic source
kici-admin source remove <source-id> --generic --yes

# Permanently delete a generic source
kici-admin source remove <source-id> --generic --hard --yes
```

Generic source secret parameters support the same input modes as GitHub sources (`--secret <value>`, `--secret @<path>`, `--from-env <VAR>`, `--stdin`).

### Starting with zero sources

The orchestrator can start with no sources configured. It will connect to Platform, sit idle, and wait for sources to be added via the CLI or admin API. Sources take effect immediately via hot reload (no restart required).

## High availability

### Migration locking

When multiple orchestrator instances start simultaneously, only one acquires the migration lock (`pg_advisory_lock`). Others block until migration completes, then proceed normally. This ensures migrations are never run concurrently.

### Source hot reload

Adding, updating, or removing a source via `kici-admin source` triggers a PostgreSQL `NOTIFY` on the `sources_change` channel. All running orchestrator instances receive the notification and reload their provider registry without restart.

## Environment variables

| Variable                     | Description                                                        | Default                      |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| `KICI_MODE`                  | Operating mode: `platform`, `hybrid`, `observed`, `independent`    | `platform`                   |
| `KICI_DATABASE_URL`          | PostgreSQL connection string                                       | Required                     |
| `KICI_SECRET_KEY`            | 32-byte encryption key for secrets (64-char hex or base64-encoded) | Required                     |
| `KICI_AUTO_MIGRATE`          | Auto-run DB migrations on startup                                  | `true`                       |
| `KICI_BOOTSTRAP_ADMIN_TOKEN` | Initial admin API token                                            | Optional                     |
| `KICI_PLATFORM_URL`          | Platform relay WebSocket URL                                       | Required for platform/hybrid |
| `KICI_PLATFORM_TOKEN`        | Platform authentication token (API key)                            | Required for platform/hybrid |
| `KICI_PORT`                  | HTTP listen port                                                   | `4000`                       |

### Provenance ID-token minting

When a workflow step requests a build-provenance ID token (`ctx.kici.oidc.token()`), the agent relays the request to the orchestrator, which mints the token for it. The orchestrator only mints a token for a job the requesting agent is actually running, derives every identity claim from its own run records (a step cannot forge them), and the agent never holds signing credentials. Which minter serves the request:

- **Orchestrator-owned signing (recommended, all modes including `independent`):** with `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` and a provisioned signing key (see [signing keys](signing-keys.md)), the orchestrator mints and signs the token locally under its own issuer — no Platform involvement. This always wins when configured, even in `platform`/`hybrid` modes.
- **Platform relay (deprecated fallback, `platform`/`hybrid` only):** with no signing key configured, the orchestrator relays the mint to the hosted Platform using its `KICI_PLATFORM_TOKEN`. Existing Platform-signed bundles keep verifying forever.
- **No minter:** an `independent` orchestrator with no signing key configured returns an error for token requests (outside the [local dev plane](local-dev-plane.md), which dev-signs under the `kici-local` issuer).
