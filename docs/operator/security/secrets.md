---
title: Secrets management
description: Configure and manage encrypted secrets for KiCI workflows
---



KiCI provides encrypted secrets management so workflows can access sensitive values (API keys, deploy tokens, credentials) without storing them in code or environment variables. Secrets are organized by org and scope, with access controlled by environment bindings and protection rules.

Key properties:

- **Encrypted at rest** -- AES-256-GCM encryption with additional authenticated data (AAD) to prevent cross-scope swaps
- **Scope-based** -- secrets are organized by org ID and scope (e.g., environment name, repo pattern), bound to environments via scope bindings
- **RBAC-protected** -- role-based access control for admin operations (owner, admin, auditor)
- **Audit-logged** -- all secret operations are recorded with user, action, and outcome
- **Multi-backend** -- PostgreSQL (default) or HashiCorp Vault for secret storage

## Where secret values are entered

Secret values are written into the store either through the dashboard or through `kici-admin`. Which surfaces accept value writes is decided per-orchestrator by the [dashboard-write policy](./dashboard-write-policy.md). The default at first-boot is **permissive**: both surfaces accept writes.

- Customers preparing for SOC2 or running regulated workloads typically flip `secrets.set` (and `variables.set`) to CLI-only, which routes plaintext exclusively through the orchestrator's HTTP admin API. The control plane never receives the plaintext value in that mode.
- The dashboard remains usable for secret-name CRUD, scope CRUD, environment bindings, and read paths regardless of the policy. Only the value-entry path moves to the CLI.

The matching `kici-admin secret set` invocation accepts five input modes (interactive prompt, stdin pipe, file, env var, argv); see [CLI input modes](#cli-input-modes) below.

Authorization for the CLI path is governed by the orchestrator's three-role RBAC (`owner` / `admin` / `auditor`); for the dashboard path it's the control plane's per-user, per-resource, per-verb RBAC. The two surfaces don't enforce each other's constraints — see [Two-layer RBAC](./rbac-two-layers.md) for the recommended operational mitigation.

## Prerequisites

- PostgreSQL database (already required by the orchestrator)
- A 32-byte encryption key for AES-256-GCM

## Configuration

### KICI_SECRET_KEY (required)

The master encryption key. Generate a 64-character hex key:

```bash
openssl rand -hex 32
```

Set it as an environment variable for the orchestrator:

```bash
export KICI_SECRET_KEY=a1b2c3d4e5f6...  # 64 hex characters
```

**Format:** 64-character hex string (representing 32 bytes) or base64-encoded 32 bytes.

**Cluster requirement:** All orchestrators in a cluster MUST share the same `KICI_SECRET_KEY`. Secrets encrypted by one orchestrator must be decryptable by all others.

### KICI_SECRET_KEY_FILE (alternative)

Instead of setting the key directly in the environment, point to a file:

```bash
export KICI_SECRET_KEY_FILE=/etc/kici/secret.key
```

The file should contain the key material (hex or base64) as a single line.

### KICI_BOOTSTRAP_ADMIN_TOKEN (optional)

Override the auto-generated bootstrap admin token. If not set, the orchestrator generates one on first start and prints it to the logs:

```
KICI Admin Token: a1b2c3d4e5f6...
```

To use a fixed token for automation:

```bash
export KICI_BOOTSTRAP_ADMIN_TOKEN=my-fixed-admin-token
```

### Vault backend configuration

For HashiCorp Vault integration, set these additional environment variables:

| Variable                 | Description                                               | Required    |
| ------------------------ | --------------------------------------------------------- | ----------- |
| `KICI_VAULT_URL`         | Vault server URL (e.g., `https://vault.example.com:8200`) | Yes         |
| `KICI_VAULT_AUTH_METHOD` | Authentication method: `token` or `approle`               | Yes         |
| `KICI_VAULT_TOKEN`       | Vault token (when using `token` auth method)              | Conditional |
| `KICI_VAULT_ROLE_ID`     | AppRole role ID (when using `approle` auth method)        | Conditional |
| `KICI_VAULT_SECRET_ID`   | AppRole secret ID (when using `approle` auth method)      | Conditional |
| `KICI_VAULT_NAMESPACE`   | Vault namespace (enterprise feature)                      | No          |
| `KICI_VAULT_MOUNT_PATH`  | KV v2 mount path (default: `secret`)                      | No          |
| `KICI_VAULT_BASE_PATH`   | Base path within the mount (default: `kici/secrets`)      | No          |

## First-time setup

1. **Generate the secret key:**

   ```bash
   openssl rand -hex 32 > /etc/kici/secret.key
   chmod 600 /etc/kici/secret.key
   ```

2. **Start the orchestrator with the key:**

   ```bash
   KICI_SECRET_KEY_FILE=/etc/kici/secret.key node server.js
   ```

3. **Save the bootstrap token** printed to the logs. This token has `owner` role with full permissions.

4. **Create operator tokens** with appropriate roles for team members.

## Admin API

All admin operations require a Bearer token in the `Authorization` header.

### Connection

```bash
# Set defaults for the session
export KICI_ADMIN_URL=http://localhost:4000
export KICI_ADMIN_TOKEN=<your-token>
```

Each operation below is driven by `kici-admin`; the `kici-admin` subcommand wraps the orchestrator's admin HTTP surface, so the equivalent raw `curl` is shown after each CLI command for scripting against the API directly.

### Scoped secret management

Secrets are organized by org ID and scope (e.g., environment name, repo pattern).

**List scopes:**

```bash
kici-admin secret scopes <org-id>
```

```bash
curl "$KICI_ADMIN_URL/api/v1/admin/secrets/scopes?orgId=<org-id>" \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

**List secret keys in a scope** (values are never exposed):

```bash
kici-admin secret list <org-id> production
```

```bash
curl "$KICI_ADMIN_URL/api/v1/admin/secrets/keys?orgId=<org-id>&scope=production" \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

**Set a secret** (creates or updates):

```bash
kici-admin secret set <org-id> production KICI_DATABASE_URL --prompt
```

```bash
curl -X PUT $KICI_ADMIN_URL/api/v1/admin/secrets/<org-id>/production/KICI_DATABASE_URL \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "postgresql://user:pass@host:5432/db"}'
```

**Delete a secret:**

```bash
kici-admin secret delete <org-id> production KICI_DATABASE_URL
```

```bash
curl -X DELETE $KICI_ADMIN_URL/api/v1/admin/secrets/<org-id>/production/KICI_DATABASE_URL \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

### Token management

**Create a token:**

```bash
kici-admin token create ci-operator --role admin
```

```bash
curl -X POST $KICI_ADMIN_URL/api/v1/admin/tokens \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "ci-operator", "role": "admin"}'
```

**List tokens:**

```bash
kici-admin token list
```

```bash
curl $KICI_ADMIN_URL/api/v1/admin/tokens \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

**Revoke a token:**

```bash
kici-admin token revoke <id>
```

```bash
curl -X DELETE $KICI_ADMIN_URL/api/v1/admin/tokens/<id> \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

### Key rotation

Rotate the encryption key and re-encrypt all stored secrets:

```bash
kici-admin rotate-key
```

```bash
curl -X POST $KICI_ADMIN_URL/api/v1/admin/rotate-key \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

### Audit log

Query the audit log:

```bash
kici-admin audit --context production --limit 50
```

```bash
curl "$KICI_ADMIN_URL/api/v1/admin/audit?contextName=production&limit=50" \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

Query parameters: `contextName`, `routingKey`, `action`, `from`, `to`, `limit`, `offset`.

## CLI input modes

`kici-admin secret set` accepts five input modes. Exactly one must be selected per invocation; combining them throws before any I/O happens.

| Flag                  | Source                                                          | Default selection                                      | Security notes                                                                                                                |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `--prompt`            | Interactive no-echo prompt                                      | When stdin is a TTY and no other flag is given         | Best for human ops — no echo, no shell history                                                                                |
| `--from-stdin`        | Read stdin until EOF                                            | When stdin is **not** a TTY and no other flag is given | Pipes from tools like `pass show`, `sops -d --output-type binary`, etc.                                                       |
| `--from-file <path>`  | Read file contents (default-trimmed, override with `--no-trim`) | Never default — must be explicit                       | Works well after `sops` decrypt to a tmpfile; the CLI warns if the result is empty                                            |
| `--from-env <VAR>`    | Read named env variable                                         | Never default — must be explicit                       | CI-friendly; env vars don't enter shell history                                                                               |
| `--value <plaintext>` | Direct argv plaintext                                           | Never default — must be explicit                       | Last-resort; the CLI prints a stderr warning ("value visible in shell history — prefer --prompt / --from-stdin / --from-env") |

Two cross-cutting flags work with every mode:

- `--confirm-fingerprint <hex>` — pre-compute SHA-256 of the value and pass it. The CLI rejects the call if the value's fingerprint doesn't match. Catches paste corruption.
- `--dry-run` — parse and validate the value, print `[dry-run] would set <key> in scope <scope> sha256=<hex>`, exit without writing.

After a successful write, the CLI prints a one-line confirmation with the key, the scope, and the value's length (never the value itself) plus the recorded `updated_at`.

`kici-admin variable set` accepts the same five input modes plus `--locked` to mark the variable as immutable from subsequent dashboard writes. `kici-admin variable list` accepts `--values` to render the values inline (default is keys-only); `kici-admin variable delete` accepts `--yes` to skip the confirmation prompt.

### Examples

```bash
# Interactive prompt
kici-admin secret set --scope production DB_PASSWORD --prompt

# Pipe from another tool
pass show prod/db | kici-admin secret set --scope production DB_PASSWORD --from-stdin

# Read from a temp file (after sops decrypt)
sops -d --output prod-db.txt secrets.enc.yaml
kici-admin secret set --scope production DB_PASSWORD --from-file ./prod-db.txt
rm prod-db.txt

# Read from a CI-provided env var
kici-admin secret set --scope production DB_PASSWORD --from-env CI_DB_PASSWORD

# Dry-run with fingerprint check
kici-admin secret set --scope production DB_PASSWORD --prompt \
  --confirm-fingerprint 7b3d6e... --dry-run
```

## RBAC roles

The orchestrator secrets admin API enforces a fixed three-role model (`owner`, `admin`, `auditor`) defined in `packages/orchestrator/src/secrets/rbac.ts`. There is no `member` role at this layer -- workflow-author secret access happens via the environment/scope binding flow, not via an admin token.

| Role        | Permissions                                                                                                                                                                                                                                           | Use case                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **owner**   | All 19 permissions: context.\*, secret.\* (read/write/delete/reveal), audit.read, token.manage, key.rotate, run.read, run.cancel, event_log.read, event_log.read_payload, access_log.read, scheduled_job.trigger, event_dlq.read, event_dlq.manage    | Bootstrap token, full admin |
| **admin**   | 17 permissions: context.\*, secret.\* (read/write/delete/reveal), audit.read, run.read, run.cancel, event_log.read, event_log.read_payload, access_log.read, scheduled_job.trigger, event_dlq.read, event_dlq.manage (no token.manage, no key.rotate) | Day-to-day operations       |
| **auditor** | 6 permissions: context.read, audit.read, run.read, event_log.read, access_log.read, event_dlq.read (metadata only -- no secret values, no raw payload bodies, no DLQ requeue/discard)                                                                 | Compliance review           |

## Access control

Secret access is controlled by environments, not by the secrets subsystem directly. Each environment defines protection rules (branch restrictions, trigger type filters, repository patterns) that gate job execution. When a job targets an environment, the protection pipeline evaluates these rules before dispatch. Only after the environment gates pass are secrets resolved for that environment's scope bindings.

Configure access restrictions on environments in **Settings > Environments > [env] > Protection**.

### Test-run access (`allowLocalExecution`)

`kici run remote` lets a developer trigger a test run that resolves test-scoped secrets — the developer's own local values (uploaded encrypted) merged with secrets from environments you have explicitly opted into test access. That opt-in is the per-environment `allowLocalExecution` flag (default `false`):

- An environment with the flag off is never resolvable for a test run, and a test run targeting it is rejected before dispatch. A fixture that maps a secret context to a missing or non-test environment also rejects the run (fail-closed).
- On a key collision, the developer's uploaded local value wins over the environment's stored value, so a test run never leaks a production credential through an accidental name match.

Recommended posture: leave **all production environments at `false`**, and create a dedicated test environment with `allowLocalExecution: true` that binds only **test-only** secret scopes (throwaway databases, sandbox API keys). Test runs then reach exactly those credentials and nothing else.

Set the flag with `kici-admin`:

```bash
# Enable test-run access on a dedicated test environment
kici-admin environment set-policy --env test-database --allow-local-execution true

# Keep production locked down (explicit, though false is the default)
kici-admin environment set-policy --env production --allow-local-execution false
```

The same toggle is available on the environment detail page in the dashboard (the "Test runs" switch), gated by the same permission as writing a secret. Whether the dashboard surface accepts the change is decided by the [dashboard-write policy](./dashboard-write-policy.md) operation `environments.test_access.set`.

## Backend configuration

### PostgreSQL backend (default)

No additional configuration needed beyond `KICI_SECRET_KEY`. Secrets are encrypted and stored in the `scoped_secrets` table.

### Vault backend

Vault is configured globally at the orchestrator level using environment variables (see [Vault backend configuration](#vault-backend-configuration) above). Secrets stored with the Vault backend delegate encryption and storage to HashiCorp Vault's KV v2 engine. The `backend_type` field on each secret row determines which backend handles it.

**AppRole setup** (recommended for production):

1. Create an AppRole in Vault with read access to the KV path
2. Generate a role ID and secret ID
3. Set `KICI_VAULT_AUTH_METHOD=approle`, `KICI_VAULT_ROLE_ID`, and `KICI_VAULT_SECRET_ID` environment variables

**Token auth** (suitable for development):

Set `KICI_VAULT_AUTH_METHOD=token` and `KICI_VAULT_TOKEN=hvs.xxxxx` environment variables.

## Key rotation

KiCI supports zero-downtime master key rotation using a dual-key mechanism. During the transition window, both secrets and config values encrypted with either the old or new key are readable. **A single `kici-admin rotate-key` invocation re-encrypts both `scoped_secrets` and `config_versions`** — both stores use the same master key (`KICI_SECRET_KEY`), so rotating them together keeps the two domains in lockstep and avoids a drift window where one has moved on but the other hasn't.

### Cadence

- **Default:** annual rotation. Predictable, low ceremony, fits most compliance regimes without creating rotation fatigue.
- **Quarterly:** reserve for high-compliance environments that mandate it (e.g., FedRAMP-aligned customers). Quarterly cadence multiplies operational risk for limited real-world benefit.
- **Immediate:** on any suspected key compromise — see [Emergency rotation](#emergency-rotation-compromised-key) below. Do not treat a compromise event as a scheduled rotation; the ordering is different.

### Rotation procedure

**Step 1: Generate a new key**

```bash
openssl rand -hex 32
```

**Step 2: Configure both keys**

Set `KICI_SECRET_KEY` to the **new** key and `KICI_SECRET_KEY_OLD` to the **previous** key:

```bash
export KICI_SECRET_KEY=<new-64-hex-chars>
export KICI_SECRET_KEY_OLD=<previous-64-hex-chars>
```

Or using key files:

```bash
export KICI_SECRET_KEY_FILE=/etc/kici/secret.key        # contains new key
export KICI_SECRET_KEY_FILE_OLD=/etc/kici/secret.key.old # contains previous key
```

**Step 3: Rolling restart all orchestrator instances**

Restart orchestrators one at a time. During the restart window, instances with the old config can still read secrets, and newly restarted instances use dual-key fallback to read secrets encrypted with either key.

The orchestrator logs `Old master key configured — dual-key decrypt and true rotation enabled` when it detects the old key.

**Step 4: Re-encrypt all secrets with the new key**

Once all instances are running with both keys configured:

```bash
kici-admin rotate-key
```

Or against the HTTP admin surface directly:

```bash
curl -X POST $KICI_ADMIN_URL/api/v1/admin/rotate-key \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

The command runs two sequential transactions — `scoped_secrets` first, then `config_versions` — and prints `Re-encrypted N secrets, M config versions.` Both operations decrypt with the old key, re-encrypt with the new key, and bump `key_version = max + 1`. Historical rows in `config_versions` are also re-sealed, so subsequent `kici-admin config rollback` calls work after the old key is retired.

**Step 5: Remove the old key**

After re-encryption, remove `KICI_SECRET_KEY_OLD` (or `KICI_SECRET_KEY_FILE_OLD`) from the configuration and do another rolling restart. All secrets and config values are now encrypted with the new key only.

### Same-key re-encryption

When `KICI_SECRET_KEY_OLD` is **not** set, `rotate-key` re-encrypts all secrets and config rows with the same master key at an incremented key version (`keyVersion = max + 1`). This is useful for periodic re-encryption without changing the actual key.

### Emergency rotation (compromised key)

A compromise means the attacker can decrypt every current ciphertext — so the upstream plaintexts (Platform tokens, bootstrap admin token, PG secret values) should be treated as leaked **before** you rotate the master key. Do these steps in order:

1. **Rotate the upstream credentials first.** Invalidate the leaked plaintexts at their source: regenerate the Platform token, rotate the orchestrator bootstrap admin token, and rotate any third-party credentials stored in `scoped_secrets` (database passwords, provider API keys, webhook signing keys, etc.). Update the corresponding `scoped_secrets` rows via `kici-admin` with the new plaintext.
2. **Generate a new `KICI_SECRET_KEY` and set the old one as `KICI_SECRET_KEY_OLD`.** Rolling-restart all orchestrator instances with both keys configured (same as Step 3 of the normal procedure).
3. **Run `kici-admin rotate-key`.** Verify the output reports non-zero counts for both stores and that the counts match your expectation (e.g., `SELECT count(*) FROM scoped_secrets` and `SELECT count(*) FROM config_versions`). A mismatch is a red flag — do not proceed.
4. **Remove the old key.** Unset `KICI_SECRET_KEY_OLD` / `KICI_SECRET_KEY_FILE_OLD` and rolling-restart again. The leaked key is now retired.
5. **Audit.** Query the orchestrator audit log over HTTP for the rotation entry and confirm the metadata shows the expected counts:

   ```bash
   curl "$KICI_ADMIN_URL/api/v1/admin/audit?action=rotateKey&limit=5" \
     -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
   ```

   Each entry carries `metadata.reEncrypted` and `metadata.reEncryptedConfigs`. If a count drops to zero unexpectedly on the second pass (step 4 would surface this), investigate before declaring rotation complete.

The critical difference from a scheduled rotation: you rotate the _upstream_ secrets before the master key, because a compromised master key has already leaked every current plaintext — rotating the master key alone only invalidates the ciphertext, not the secrets the ciphertext protected.

### Notes

- Vault-backed secrets are not affected (Vault manages its own encryption).
- During the transition window (steps 3-5), any secret or config value encrypted with either the old or new key is readable by all orchestrator instances.
- **Cluster requirement:** All orchestrators in a cluster must share the same `KICI_SECRET_KEY` and `KICI_SECRET_KEY_OLD` values during rotation.

## Multi-backend secrets

KiCI supports managing secrets from multiple named backend instances simultaneously. The orchestrator can resolve secrets from both its built-in PostgreSQL backend and external Vault/OpenBao instances, with all scopes uniformly prefixed by backend name.

### Backend registration

Register backends using the `kici-admin backend` CLI commands:

```bash
# Add a Vault/OpenBao backend
kici-admin backend add \
  --name openbao-prod \
  --type vault \
  --url https://vault.example.com:8200 \
  --auth-method approle \
  --role-id "$VAULT_ROLE_ID" \
  --secret-id "$VAULT_SECRET_ID"

# List all registered backends
kici-admin backend list

# Test backend connectivity
kici-admin backend test --name openbao-prod

# Trigger scope discovery sync
kici-admin backend sync --name openbao-prod

# Remove a backend
kici-admin backend remove --name openbao-prod
```

Alternatively, use the admin API directly:

```bash
# Add a backend
curl -X POST $KICI_ADMIN_URL/api/v1/admin/backends \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "openbao-prod", "backendType": "vault", "config": {"url": "https://vault:8200", "authMethod": "approle", "roleId": "...", "secretId": "..."}}'

# List backends
curl $KICI_ADMIN_URL/api/v1/admin/backends \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"

# Sync all backends
curl -X POST $KICI_ADMIN_URL/api/v1/admin/backends/sync \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"

# Test a backend
curl -X POST $KICI_ADMIN_URL/api/v1/admin/backends/test \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "openbao-prod", "backendType": "vault", "config": {"url": "https://vault:8200", ...}}'

# Remove a backend
curl -X DELETE $KICI_ADMIN_URL/api/v1/admin/backends/openbao-prod \
  -H "Authorization: Bearer $KICI_ADMIN_TOKEN"
```

### Scope namespacing

All scopes use a `backend-name:scope/path` format with colon separator:

- `pg:production/db` -- PG-stored secret in `production/db` scope
- `openbao-prod:aws/credentials` -- Vault-stored secret in `aws/credentials` scope

This prevents overlap between backends -- each scope is uniquely identified by its backend prefix. At resolution time, the prefix is stripped and secrets are injected by key name only (e.g., `secrets.get('DB_PASSWORD')` returns the value regardless of which backend provided it).

Use `secrets.getMeta('DB_PASSWORD')` to inspect which backend and scope provided a specific secret:

```typescript
const meta = secrets.getMeta('DB_PASSWORD');
// { value: '...', backend: 'pg', scope: 'pg:production/db' }
```

### PG customer secrets toggle

By default, the PG backend is available for both internal/operational secrets and dashboard-created customer secrets. To restrict the PG backend to internal use only (forcing customer secrets into external backends):

```bash
kici-admin config set pgCustomerSecrets false
```

When disabled:

- Dashboard users cannot create PG-stored secrets
- Internal scopes (`__source__/*`, `__webhook__/*`) continue working normally
- Existing PG secrets remain resolvable (read path unaffected)
- Secret resolution still includes PG secrets for jobs

### Auto-discovery and sync

External backends (Vault/OpenBao) are auto-discovered -- the orchestrator lists all paths under the backend's configured base path. Discovered scopes appear automatically in the dashboard scope tree.

Sync behavior:

- **Periodic sync:** Runs at a configurable interval per backend (default: 5 minutes)
- **Manual sync:** Use `kici-admin backend sync` or the dashboard "Sync now" button
- **Scope filter:** Each backend registration includes optional glob patterns to limit which scopes are imported (default: `**` imports all)

### Health monitoring

Backend health is visible on the dashboard diagnostics page:

- **Green:** Backend reachable, auth valid, last sync successful
- **Yellow:** Backend reachable but last sync had warnings
- **Red:** Backend unreachable or auth failed

Each backend card shows: name, type, health status, masked connection URL, auth method, sync interval, scope count, last sync time, error log, and latency stats.

At startup, the orchestrator validates connectivity to all registered backends -- it warns on unreachable backends but does not block startup. If a backend is unreachable at job dispatch time, the job fails with a clear error message identifying the unavailable backend.

### Troubleshooting: multi-backend

**Backend unreachable at dispatch:**
When an external backend is unreachable at job dispatch time, the job fails with an error identifying the backend. Check:

- Backend container/service is running
- Network connectivity from orchestrator to backend URL
- Auth credentials (AppRole role/secret IDs, tokens) are valid

**Scopes not discovered:**
If expected scopes don't appear after sync:

- Verify the scope filter patterns match the desired paths
- Check that secrets exist at the expected mount/base path
- Run manual sync: `kici-admin backend sync --name <backend>`
- Check orchestrator logs for sync errors

**Data migration:**
When upgrading to multi-backend support, existing PG scopes are automatically prefixed with `pg:` during the database migration. Environment bindings are also updated. No manual intervention required.

## Troubleshooting

### "Secret encryption key not found"

The orchestrator cannot find `KICI_SECRET_KEY` or `KICI_SECRET_KEY_FILE`. Verify:

- The environment variable is set and non-empty
- The key file exists and is readable
- The key is exactly 64 hex characters or valid base64-encoded 32 bytes

### "Invalid or expired token"

The admin API token is not valid. Possible causes:

- Token was revoked
- Token was generated by a different orchestrator (different database)
- Bootstrap token was overridden by `KICI_BOOTSTRAP_ADMIN_TOKEN`

### Vault connection errors

- Verify the Vault URL is reachable from the orchestrator
- Check that the auth method credentials (AppRole or token) are valid
- Ensure the KV v2 engine is enabled at the configured mount path
- For namespaced Vault (enterprise), verify the namespace is correct

### Secrets not appearing in workflows

- Verify the job targets an environment that has secret scope bindings configured
- Check that secrets exist in the expected scope for the org
- Verify the environment protection rules allow the branch, trigger type, and repository
- Check the audit log for denied access entries

## Cross-job secret outputs

KiCI supports passing secret values between jobs in the same workflow run. This is useful for patterns like "generate a short-lived token in one job and use it in downstream jobs."

### How it works

1. **Key pair generation:** When the orchestrator creates a new run, it generates an ephemeral X25519 key pair. The private key is encrypted with `KICI_SECRET_KEY` and stored in `run_ephemeral_keys`. The public key is sent to agents as part of the job dispatch.

2. **Agent-side encryption:** When a workflow step calls `ctx.setSecretOutput(key, value)`, the agent encrypts the value using ECDH (agent ephemeral key x run public key) + HKDF + AES-256-GCM. The encrypted envelope is sent back to the orchestrator over the WebSocket connection.

3. **Orchestrator-side decryption and re-encryption:** The orchestrator decrypts the agent's envelope using the run's private key, then re-encrypts the value with `KICI_SECRET_KEY` and stores it in `run_secret_outputs`.

4. **Downstream injection:** When dispatching a downstream job that depends on the producing job (via `needs`), the orchestrator decrypts the stored secret outputs and injects them into the agent's secrets alongside environment-scoped secrets.

5. **Cleanup:** When the run completes (all jobs finished), the ephemeral private key and all secret output rows are deleted.

### Forward secrecy

The per-run ephemeral key pair provides forward secrecy: even if `KICI_SECRET_KEY` is compromised after a run completes, the secret outputs from that run cannot be decrypted because the private key has been deleted.

### Periodic cleanup

Orphaned data from crashed or abandoned runs is cleaned up automatically:

- **Threshold:** Rows older than 24 hours are deleted from both `run_ephemeral_keys` and `run_secret_outputs`
- **Interval:** Cleanup runs every hour
- No operator action is required -- the cleanup scheduler starts with the orchestrator and stops on shutdown

### Limits

No built-in limits are currently enforced on the number of `setSecretOutput()` calls per job or individual value sizes. Operators should monitor secret output usage and implement application-level validation if needed.

### Security model

- **Agent never sees `KICI_SECRET_KEY`** -- it only receives the run's public key for encryption
- **Orchestrator never sends plaintext over the wire** -- secret values are always encrypted in transit
- **Ephemeral key per run** -- compromising one run's key does not affect other runs
- **No cross-run access** -- a run can only read its own secret outputs

### Secret key rotation

Rotating `KICI_SECRET_KEY` (used for ephemeral key and secret output encryption) is a zero-downtime operation. See the [key rotation section](#key-rotation) above for the procedure.

## See also

- [Dashboard-write policy](./dashboard-write-policy.md) — per-orchestrator, per-operation policy that decides which surface accepts which mutating action.
- [Two-layer RBAC](./rbac-two-layers.md) — how the dashboard and CLI authorize differently, and how to keep them in sync.
- [Audit log](./audit-log.md) — querying every secret write, reveal, and policy flip.
