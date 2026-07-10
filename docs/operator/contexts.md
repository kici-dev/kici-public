---
title: Contexts
description: Operator guide for managing deployment contexts, secrets, and protection rules
---

This guide covers the operational aspects of KiCI's deployment context system: database tables, API management, Vault integration, held run lifecycle, monitoring, and troubleshooting.

## Database tables

Contexts are stored in the **orchestrator database**. The squashed baseline migration `001_initial.ts` creates the following tables:

| Table                          | Purpose                                          |
| ------------------------------ | ------------------------------------------------ |
| `contexts`                 | Context definitions with protection rules    |
| `context_variables`        | Key-value pairs per context (with lock flag) |
| `context_source_overrides` | Per-source variable overrides                    |
| `context_bindings`         | Scope-to-context secret bindings             |
| `held_runs`                    | Runs held by protection gates (pending approval) |

The `execution_runs` table also gains an `context` column (TEXT, nullable) to track which context each run targeted.

### Key constraints

- `contexts(org_id, name)` -- unique context name per org
- `context_variables(context_id, key)` -- unique variable key per context
- `context_source_overrides(context_id, routing_key, key)` -- unique override per source+key
- `held_runs(run_id, job_id)` -- one held entry per job

## Context management via API

Contexts are managed through the dashboard proxy API. All CRUD operations route through Platform -> WebSocket -> Orchestrator.

### Creating contexts

Contexts can be created via the dashboard or seeded directly in the orchestrator database:

```sql
INSERT INTO contexts (org_id, name, type, enabled)
VALUES ('my-org', 'production', 'fixed', true);
```

For glob-pattern contexts:

```sql
INSERT INTO contexts (org_id, name, type, glob_pattern, enabled)
VALUES ('my-org', 'review/*', 'glob', 'review/*', true);
```

### Setting variables

```sql
INSERT INTO context_variables (org_id, context_id, key, value, locked)
VALUES ('my-org', '<env-id>', 'API_URL', 'https://api.example.com', false);
```

The `locked` flag prevents source-level overrides from changing this variable. Locked variables can only be modified by context admins.

### Configuring protection rules

Protection rules are columns on the `contexts` table:

```sql
UPDATE contexts SET
  branch_restrictions = '["main", "release/*"]',
  required_reviewers = '["user-id-1", "user-id-2"]',
  wait_timer_seconds = 300,
  concurrency_limit = 1,
  concurrency_strategy = 'queue',
  hold_expiry_seconds = 86400
WHERE org_id = 'my-org' AND name = 'production';
```

## Vault integration for secrets

Secrets can be stored in PostgreSQL (default) or HashiCorp Vault. Backends are managed through the `kici-admin backend` CLI commands, which store configuration (encrypted) in the `secret_backends` database table — not through environment variables or YAML config.

```bash
# Register a Vault backend
kici-admin backend add my-vault \
  --type vault \
  --vault-url https://vault.example.com \
  --vault-auth-method token \
  --vault-token hvs.xxx \
  --vault-mount-path secret \
  --vault-base-path kici/secrets

# List registered backends
kici-admin backend list

# Remove a backend
kici-admin backend remove my-vault
```

See `docs/operator/orchestrator/kici-admin-cli.md` for the full `backend` subcommand reference.

When using Vault:

- Scope paths map directly to Vault KV v2 paths under `{mountPath}/data/{basePath}/`
- The orchestrator reads secrets at dispatch time (not cached)
- Vault connection is operator-managed, not configurable per-scope in the dashboard
- PG-stored secrets and Vault-stored secrets can coexist (backend is per-scope)

## Held run lifecycle

### States

| State      | Description                                   |
| ---------- | --------------------------------------------- |
| `pending`  | Awaiting reviewer approval or timer expiry    |
| `approved` | Reviewer approved; job proceeds to dispatch   |
| `rejected` | Reviewer rejected; job is cancelled           |
| `expired`  | Hold expiry timeout reached; job is cancelled |

### Expiry and cleanup

- Default hold expiry: 3600 seconds (1 hour), configurable per-context via `hold_expiry_seconds`
- The stale run detector (Sub-scan E) periodically calls `heldRunStore.expireOverdue()` to transition expired pending holds to `expired` status
- Expired held runs result in the associated job being cancelled

### Approval flow

1. Job targets an context with `required_reviewers`
2. Orchestrator creates a `held_runs` entry with status `pending`
3. Reviewer approves via dashboard or API (`POST /runs/:id/approve`)
4. Held run transitions to `approved`
5. Job is re-queued for dispatch

## Monitoring

### Key metrics to watch

| Metric                          | Description                                   | Alert threshold                     |
| ------------------------------- | --------------------------------------------- | ----------------------------------- |
| Held runs pending               | Count of `held_runs WHERE status = 'pending'` | > 10 (may indicate stale approvals) |
| Held runs expired               | Rate of `status = 'expired'` transitions      | Increasing trend                    |
| Context var resolution time | Time to resolve vars in processor             | > 100ms                             |
| Protection pipeline rejections  | Rate of branch/concurrency rejections         | Depends on workflow                 |

### Useful queries

Count pending held runs per context:

```sql
SELECT e.name, COUNT(*) as pending_count
FROM held_runs hr
JOIN contexts e ON e.id = hr.context_id
WHERE hr.status = 'pending'
GROUP BY e.name;
```

Recent protection rule rejections:

```sql
SELECT j.job_name, j.error_message, r.created_at
FROM execution_jobs j
JOIN execution_runs r ON r.run_id = j.run_id
WHERE j.error_message LIKE '%branch%' OR j.error_message LIKE '%protection%'
ORDER BY r.created_at DESC
LIMIT 20;
```

Runs per context:

```sql
SELECT context, status, COUNT(*) as count
FROM execution_runs
WHERE context IS NOT NULL
GROUP BY context, status
ORDER BY context, status;
```

## Troubleshooting

### Job rejected unexpectedly

**Symptom:** Job fails with "Branch 'X' not allowed for context 'Y'"

**Diagnosis:** Check the context's `branch_restrictions` column:

```sql
SELECT name, branch_restrictions FROM contexts WHERE org_id = 'your-org';
```

**Fix:** Update branch restrictions to include the required branch pattern, or remove restrictions entirely by setting `branch_restrictions = '[]'`.

For a job bound to multiple contexts (`contexts: ['staging', 'my-testing']`), protection rules combine all-must-pass: the run is rejected if **any** configured bound context rejects it, and the rejection reason names the offending context and rule (e.g. `multi-context gate: 'my-testing' rejected (branch_restricted: branch 'main' not allowed)`). A bound name with no configured context contributes no rules (it is skipped, not rejected). Check the branch restrictions of every configured context in the array, not just the first.

### Job held indefinitely

**Symptom:** Job stays in `pending` held state beyond the expected hold expiry.

**Diagnosis:** Check if the stale detector is running and if the hold has expired:

```sql
SELECT id, status, expires_at, created_at
FROM held_runs
WHERE status = 'pending' AND expires_at < NOW();
```

**Fix:** Either approve/reject manually via the API, or verify the stale detector sub-scan E is operational. The stale detector runs `heldRunStore.expireOverdue()` on each scan cycle.

### Environment variables not reaching agent

**Symptom:** Step does not see expected environment variables.

**Diagnosis:**

1. Verify the variable exists in `context_variables` for the correct context
2. Check if the variable is being overridden by a higher-precedence layer (job `env`, secrets)
3. For source overrides, verify the `routing_key` matches the source triggering the job
4. Check if the variable is `locked` and a source override exists (locked vars skip source overrides)

```sql
SELECT ev.key, ev.value, ev.locked
FROM context_variables ev
JOIN contexts e ON e.id = ev.context_id
WHERE e.org_id = 'your-org' AND e.name = 'your-env';
```

### Dynamic context not matching

**Symptom:** Dynamic context name (e.g., `review/PR-123`) doesn't inherit glob pattern config.

**Diagnosis:** Check that a glob context exists with a matching pattern:

```sql
SELECT name, glob_pattern FROM contexts
WHERE org_id = 'your-org' AND type = 'glob';
```

The glob matching uses picomatch. Verify the pattern matches the dynamic name:

- `review/*` matches `review/PR-123` (single segment)
- `review/**` matches `review/PR-123` and `review/deep/path`

### Concurrency queue stuck

**Symptom:** Jobs queue but never dispatch even when the context has capacity.

**Diagnosis:** Check running job count for the concurrency group:

```sql
SELECT COUNT(*) as running
FROM execution_jobs j
JOIN execution_runs r ON r.run_id = j.run_id
WHERE j.status = 'running' AND r.context = 'your-env';
```

If the count is below the concurrency limit but jobs are still queued, check for stale `running` jobs that may have lost their agent connection. The stale detector should catch these, but verify it's operational.
